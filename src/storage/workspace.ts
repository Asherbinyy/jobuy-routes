import type { DeliveryState } from '../domain/deliveries'
import { seed } from '../data/seed'
import { newDraft, type Approval, type Draft } from '../domain/pickups'
import { buildIndex, parsePostcode, validRouteId, type Dataset } from '../domain/routes'
import { emptyTeam, validateCompany, validateDriver, type Team } from '../domain/team'
import { spreadsheetDate } from '../domain/spreadsheets'
import { uid } from '../domain/util'

export type TeamChange = { before: Team; after: Team; at: string; label: string; undoOf?: string }
export type Workspace = {
  schema: 1; revision: number; datasets: Dataset[]; activations: string[]; team: Team
  teamChanges: TeamChange[]; teamUndo: number[]; draft: Draft; approvals: Approval[]; referencePrefix: string; deliveries?: DeliveryState
}

export const initialWorkspace = (): Workspace => ({
  schema: 1, revision: 0, datasets: [seed], activations: [seed.id], team: emptyTeam,
  teamChanges: [], teamUndo: [], draft: newDraft(), approvals: [], referencePrefix: 'JDW',
})
export const activeDataset = (state: Workspace) => state.datasets.find(item => item.id === state.activations.at(-1)) ?? seed

export function replaceRoutes(state: Workspace, dataset: Dataset, previewVersion: string): Workspace {
  if (activeDataset(state).id !== previewVersion) throw new Error('Active routes changed. Review the updated preview and try again.')
  if (!dataset.rows.length || dataset.rows.some(row => !validRouteId(row.route) || !parsePostcode(row.postcode))) {
    throw new Error('This dataset has missing or invalid routes.')
  }
  return { ...state, datasets: [...state.datasets, dataset], activations: [...state.activations, dataset.id] }
}

export function restoreRoutes(state: Workspace, id?: string): Workspace {
  if (!id) return state.activations.length > 1 ? { ...state, activations: state.activations.slice(0, -1) } : state
  if (!state.datasets.some(dataset => dataset.id === id)) throw new Error('Route version is unavailable.')
  return id === activeDataset(state).id ? state : { ...state, activations: [...state.activations, id] }
}

export function recordTeam(state: Workspace, team: Team, label: string): Workspace {
  const change = { before: state.team, after: team, at: new Date().toISOString(), label }
  return { ...state, team, teamChanges: [...state.teamChanges, change], teamUndo: [...state.teamUndo, state.teamChanges.length] }
}

export function undoTeam(state: Workspace): Workspace {
  const index = state.teamUndo.at(-1)
  if (index === undefined) return state
  const change = state.teamChanges[index]
  const audit = { before: state.team, after: change.before, at: new Date().toISOString(), label: `Undo ${change.label}`, undoOf: change.at }
  return { ...state, team: change.before, teamChanges: [...state.teamChanges, audit], teamUndo: state.teamUndo.slice(0, -1) }
}

export function undoApproval(state: Workspace): Workspace {
  const latest = state.approvals.at(-1)
  if (!latest || latest.undoOf) return state
  const previous = state.approvals.find(item => item.id === latest.previousId)
  const audit = { id: uid(), at: new Date().toISOString(), jobs: previous?.jobs ?? [], undoOf: latest.id, previousId: latest.id }
  return { ...state, approvals: [...state.approvals, audit] }
}

export function backup(state: Workspace) {
  return { version: 1, datasets: state.datasets, activeId: activeDataset(state).id, team: state.team }
}
type Backup = ReturnType<typeof backup>
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
const text = (value: Record<string, unknown>, keys: string[]) => keys.every(key => typeof value[key] === 'string')
const flags = (value: Record<string, unknown>, keys: string[]) => keys.every(key => typeof value[key] === 'boolean')
const uniqueIds = (items: { id: string }[]) => new Set(items.map(item => item.id)).size === items.length

export function parseBackup(input: string): Backup {
  let value: unknown
  try { value = JSON.parse(input) } catch { throw new Error('Choose a valid JSON backup exported by this app.') }
  const invalid = new Error('The backup contains invalid routes, team records or references.')
  if (!isObject(value) || value.version !== 1 || typeof value.activeId !== 'string' || !Array.isArray(value.datasets) || !isObject(value.team)) throw invalid
  const { companies, drivers, coverage } = value.team
  if (!Array.isArray(companies) || !Array.isArray(drivers) || !Array.isArray(coverage)) throw invalid
  if (!value.datasets.every(dataset => isObject(dataset) && text(dataset, ['id', 'name', 'createdAt']) && dataset.id
    && (!dataset.createdAt || Number.isFinite(Date.parse(dataset.createdAt as string)))
    && Array.isArray(dataset.rows) && dataset.rows.length && dataset.rows.every(row => isObject(row)
      && text(row, ['route', 'postcode', 'sheet', 'originalRoute']) && typeof row.row === 'number'
      && (row.originalPostcode === undefined || typeof row.originalPostcode === 'string')
      && Number.isSafeInteger(row.row) && row.row > 0 && validRouteId(row.route as string) && parsePostcode(row.postcode as string)))) throw invalid
  if (!companies.every(item => isObject(item) && item.id && text(item, ['id', 'name', 'notes']) && flags(item, ['active']) && strings(item.aliases))
    || !drivers.every(item => isObject(item) && item.id && text(item, ['id', 'name', 'notes', 'companyId']) && flags(item, ['active']))
    || !coverage.every(item => isObject(item) && item.id && text(item, ['id', 'companyId', 'driverId', 'date', 'shift', 'notes', 'source'])
      && flags(item, ['active', 'approved']) && strings(item.routes) && strings(item.sectors)
      && (item.routes.length || item.sectors.length) && item.routes.every(validRouteId)
      && item.sectors.every(sector => parsePostcode(sector)?.kind === 'sector') && spreadsheetDate(item.date as string) !== undefined)) throw invalid
  const parsed = value as unknown as Backup
  const { team, datasets, activeId } = parsed
  if (![datasets, team.companies, team.drivers, team.coverage].every(uniqueIds) || !datasets.some(item => item.id === activeId)
    || team.companies.some(company => validateCompany(team, company))
    || team.drivers.some(driver => validateDriver(team, { ...driver, active: false }))
    || team.coverage.some(item => !team.companies.some(company => company.id === item.companyId)
      || (item.driverId && (!item.date || !team.drivers.some(driver => driver.id === item.driverId))) || (item.shift && !item.date))) throw invalid
  return parsed
}

export function restoreBackup(state: Workspace, data: Backup, previewRevision: number): Workspace {
  if (state.revision !== previewRevision) throw new Error('Local data changed. Reopen the backup to review it again.')
  const imported = data.datasets.map(dataset => ({ ...dataset, id: uid() }))
  const activeId = imported[data.datasets.findIndex(dataset => dataset.id === data.activeId)].id
  return {
    ...recordTeam(state, data.team, 'Restore backup'),
    datasets: [...state.datasets, ...imported], activations: [...state.activations, activeId],
  }
}

export function datasetFromBackup(data: Backup) {
  return buildIndex(data.datasets.find(item => item.id === data.activeId)!)
}

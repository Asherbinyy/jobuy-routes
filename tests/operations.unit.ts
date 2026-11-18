import assert from 'node:assert/strict'
import test from 'node:test'
import { seed } from '../src/data/seed'
import { approveDraft, groupedPickups, newDraft, newJob, parsePickupText, pickupFields, previewPickups } from '../src/domain/pickups'
import { buildIndex } from '../src/domain/routes'
import { detectMapping, mapRows, spreadsheetDate } from '../src/domain/spreadsheets'
import { coverageReferences, emptyTeam, overlaps, prepareTeamImport, suggestCoverage, teamFields, type Coverage, type Team } from '../src/domain/team'
import { csv } from '../src/domain/util'
import { initialWorkspace, recordTeam, undoApproval, undoTeam } from '../src/storage/workspace'

const date = '2026-11-18'
const index = buildIndex(seed)
const coverage: Coverage = {
  id: 'allocation', companyId: 'company', driverId: 'driver', date, shift: '', routes: ['16'], sectors: [],
  active: true, approved: true, notes: '', source: 'Manual',
}
const team: Team = {
  companies: [{ id: 'company', name: 'Test Carrier', active: true, aliases: [], notes: '' }],
  drivers: [{ id: 'driver', name: 'Test Driver', companyId: 'company', active: true, notes: '' },
    { id: 'second', name: 'Other Test Driver', companyId: 'company', active: true, notes: '' }],
  coverage: [coverage],
}

function map(kind: keyof typeof teamFields, columns: string[], rows: string[][]) {
  const sheet = { name: 'Imported records', rows: [columns, ...rows] }
  const fields = teamFields[kind]
  const result = mapRows([sheet], [detectMapping(sheet, fields)], fields)
  assert.deepEqual(result.errors, [])
  return result.rows
}

test('imports company, driver and coverage with flexible headers and no silent overwrite', () => {
  const companies = prepareTeamImport('companies', map('companies', ['Remarks', 'Carrier'], [['New', 'Test Carrier']]), emptyTeam, index, 'companies.csv')
  assert.equal(companies.next.companies[0].name, 'Test Carrier')
  const drivers = prepareTeamImport('drivers', map('drivers', ['Employer', 'Courier'], [['Test Carrier', 'Test Driver']]), companies.next, index, 'drivers.xlsx')
  assert.equal(drivers.next.drivers[0].companyId, companies.next.companies[0].id)
  const coverage = prepareTeamImport('coverage', map('coverage', ['Date', 'Route no', 'DSP', 'Courier'], [['18/11/2026', '16', 'Test Carrier', 'Test Driver']]), drivers.next, index, 'allocations.xls')
  assert.equal(coverage.next.coverage[0].date, date)
  assert.equal(coverage.next.coverage[0].approved, false)
  const repeated = prepareTeamImport('companies', map('companies', ['Name', 'Notes'], [['Test Carrier', 'Overwrite?']]), coverage.next, index, 'companies.csv')
  assert.equal(repeated.skipped.length, 1)
  assert.equal(repeated.next.companies[0].notes, 'New')
  assert.equal(spreadsheetDate('2026-02-30'), undefined)
})

test('retired routes flag assignments and approval only uses active dated coverage', () => {
  let state = recordTeam(initialWorkspace(), team, 'Add team')
  assert.deepEqual(coverageReferences(coverage, buildIndex({ ...seed, rows: seed.rows.filter(row => row.route !== '16') }), team), ['Route 16 retired'])
  assert.equal(suggestCoverage(team, '16', 'M6 5', date, 'AM').driverId, 'driver')
  assert.equal(suggestCoverage({ ...team, coverage: [{ ...coverage, date: '' }] }, '16', 'M6 5', date, 'AM').driverId, '')
  assert.equal(suggestCoverage({ ...team, coverage: [{ ...coverage, approved: false }] }, '16', 'M6 5', date, 'AM').driverId, '')
  const second = { ...coverage, id: 'second', driverId: 'second', routes: [], sectors: ['M6 5'], shift: 'AM' }
  assert.equal(overlaps(coverage, second, index), true)
  assert.equal(suggestCoverage({ ...team, coverage: [coverage, second] }, '16', 'M6 5', date, 'AM').conflict, true)
  assert.equal(suggestCoverage({ ...team, coverage: [coverage, second] }, '16', 'M6 5', date, 'PM').driverId, 'driver')
  state = undoTeam(state)
  assert.deepEqual(state.team, emptyTeam)
  assert.equal(state.teamChanges.length, 2)
})

test('pickup import retains text, recognises partial lines and maps spreadsheet columns', () => {
  const jobs = parsePickupText('Order reference    Postcode\nJDW100 M6 5AB\nM32 9AA\nJDW102 unreadable', 'image', 'JDW', 77)
  assert.deepEqual(jobs.map(job => [job.orderRef, job.postcode]), [['JDW100', 'M6 5AB'], ['', 'M32 9AA'], ['JDW102', '']])
  assert.equal(jobs[0].sourceText, 'JDW100 M6 5AB')
  assert.equal(jobs[0].sourceId, 'image')
  assert.equal(jobs[0].confidence, 77)
  assert.equal(jobs[0].checked, false)
  const sheet = { name: 'Jobs', rows: [['Postal code', 'Tracking ID'], ['M6 5AB', 'JDW100']] }
  const mapping = detectMapping(sheet, pickupFields)
  assert.equal(mapRows([sheet], [mapping], pickupFields).rows[0].values.reference, 'JDW100')
})

test('pickup review flags conflicts, requires duplicate reasons and restores the previous snapshot', () => {
  const draft = { ...newDraft(), date, jobs: [newJob({ orderRef: 'JDW100', postcode: 'M6 5AB' })] }
  const approved = approveDraft(draft, undefined, index, team, seed.id, false)
  assert.equal(approved.jobs[0].driver, 'Test Driver')
  assert.equal([...groupedPickups(approved.jobs).keys()][0], 'Test Carrier › Test Driver › Route 16')
  const conflicting = newJob({ orderRef: 'JDW200', postcode: 'M32 9AA' })
  const duplicate = newJob({ orderRef: 'jdw100', postcode: 'M6 5AB' })
  const second = { ...draft, jobs: [conflicting, duplicate] }
  const reviewed = previewPickups(second, approved.jobs, index, team)
  assert.deepEqual(reviewed[0].routes, ['22', '37'])
  assert.ok(reviewed[0].issues.includes('Route conflict'))
  assert.equal(reviewed[1].duplicate, true)
  assert.equal(reviewed[1].previous[0].id, draft.jobs[0].id)
  assert.throws(() => approveDraft(second, approved, index, team, seed.id, true), /reasons/)
  const final = approveDraft({ ...second, jobs: [conflicting, { ...duplicate, duplicateReason: 'Different parcel' }] },
    approved, index, team, seed.id, true)
  assert.equal(final.jobs.length, 3)
  const state = { ...initialWorkspace(), approvals: [approved, final] }
  assert.deepEqual(undoApproval(state).approvals.at(-1)?.jobs, approved.jobs)
  assert.equal(undoApproval(state).approvals.length, 3)
})

test('CSV export escapes quoted fields and neutralises spreadsheet formulas', () => {
  assert.equal(csv([['quoted "x"', '=1+1']]), '"quoted ""x""","\'=1+1"')
})

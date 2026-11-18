import { lookup, parsePostcode, compare, type RouteIndex } from './routes'
import { aliases, spreadsheetDate, type Field } from './spreadsheets'
import { companyName, driverName, suggestCoverage, type Team } from './team'
import { csv, today, uid } from './util'

export type PickupSource = { id: string; name: string; kind: 'image' | 'sheet' | 'text'; status: 'ready' | 'reading' | 'failed'; error?: string; attempt?: string }
export type PickupJob = {
  id: string; orderRef: string; postcode: string; notes: string; sourceId: string; sourceText: string
  confidence?: number; checked: boolean; route: string; companyId: string; driverId: string; reason: string; duplicateReason: string
}
export type Draft = { id: string; date: string; shift: string; jobs: PickupJob[]; sources: PickupSource[] }
export type ApprovedJob = PickupJob & {
  date: string; shift: string; sector: string; company: string; driver: string; datasetId: string; approvedAt: string; batchId: string
  source?: PickupSource
}
export type Approval = { id: string; at: string; jobs: ApprovedJob[]; undoOf?: string; previousId?: string }

export const newDraft = (): Draft => ({ id: uid(), date: today(), shift: '', jobs: [], sources: [] })
export const newJob = (values: Partial<PickupJob> = {}): PickupJob => ({
  id: uid(), orderRef: '', postcode: '', notes: '', sourceId: '', sourceText: '', checked: true,
  route: '', companyId: '', driverId: '', reason: '', duplicateReason: '', ...values,
})

export const pickupFields: Field[] = [
  { key: 'reference', label: 'Order reference', required: true, aliases: aliases.reference },
  { key: 'postcode', label: 'Postcode', required: true, aliases: [...aliases.postcode, 'full postcode'] },
  { key: 'notes', label: 'Notes', aliases: aliases.notes },
]

const postcodeScan = /\b(?:GIR|[A-Z]{1,2}\d[A-Z\d]?)\s*-?\s*\d\s*[A-Z]{2}\b/gi
const regexQuote = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function parsePickupText(text: string, sourceId: string, prefix: string, confidence?: number) {
  const refScan = prefix ? new RegExp(`\\b${regexQuote(prefix)}[A-Z0-9_-]*[0-9][A-Z0-9_-]*\\b`, 'gi') : undefined
  const referenceMatches = (line: string) => refScan ? [...line.matchAll(refScan)] : []
  const jobs: PickupJob[] = []
  for (const line of text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    if (/^[\s|,;\t]*(?:order|pickup|reference|postcode|notes|date)(?:[\s|,;\t]+(?:order|pickup|ref(?:erence)?|post\s?code|notes|date|driver|route))*[\s|,;\t]*$/i.test(line)) continue
    const postcodes = [...line.matchAll(postcodeScan)].map(match => ({ postcode: parsePostcode(match[0]), index: match.index! }))
      .filter(item => item.postcode?.kind === 'full')
    const refs = referenceMatches(line)
    const count = Math.max(1, refs.length, postcodes.length)
    const ordered = count < 2 || refs.length === postcodes.length && refs.every((ref, index) => {
      const startsBefore = refs[0].index! < postcodes[0].index
      return startsBefore
        ? ref.index! < postcodes[index].index && (index === 0 || postcodes[index - 1].index < ref.index!)
        : postcodes[index].index < ref.index! && (index === 0 || refs[index - 1].index! < postcodes[index].index)
    })
    if (!ordered && refs.length && postcodes.length) {
      for (const ref of refs) jobs.push(newJob({ orderRef: ref[0], sourceId, sourceText: line, checked: false, confidence }))
      for (const item of postcodes) jobs.push(newJob({ postcode: item.postcode!.key, sourceId, sourceText: line, checked: false, confidence }))
      continue
    }
    for (let index = 0; index < count; index++) {
      jobs.push(newJob({
        orderRef: refs[index]?.[0] ?? '', postcode: postcodes[index]?.postcode?.key ?? '', sourceId, sourceText: line,
        checked: false, confidence,
      }))
    }
  }
  return jobs
}

export function pickupMatch(job: PickupJob, draft: Draft, index: RouteIndex, team: Team) {
  const postcode = parsePostcode(job.postcode)
  const sector = postcode?.sector ?? ''
  const lookedUp = postcode?.kind === 'full' ? lookup(index, job.postcode, true) : null
  const routes = lookedUp?.type === 'match' || lookedUp?.type === 'conflict' ? lookedUp.entry.routes : []
  const manual = Boolean(job.route || job.companyId || job.driverId)
  const route = job.route ? (index.routes.has(job.route) ? job.route : '') : routes.length === 1 ? routes[0] : ''
  const suggestions = route && postcode?.kind === 'full'
    ? suggestCoverage(team, route, sector, draft.date, draft.shift)
    : { companyId: '', driverId: '', conflict: false, matches: [] }
  const company = job.companyId ? team.companies.find(item => item.id === job.companyId && item.active)?.id ?? '' : suggestions.companyId
  const coverDriver = company === suggestions.companyId ? suggestions.driverId : ''
  const driver = job.driverId
    ? team.drivers.find(item => item.id === job.driverId && item.companyId === company && item.active)?.id ?? ''
    : coverDriver
  const issues: string[] = []
  if (!job.orderRef.trim()) issues.push('Missing order reference')
  if (postcode?.kind !== 'full') issues.push('Check full postcode')
  else if (!routes.length && !job.route) issues.push('No route found')
  else if (routes.length > 1 && !job.route) issues.push('Route conflict')
  if (manual && !job.reason.trim()) issues.push('Enter an override reason')
  if (job.route && !route) issues.push('Selected route retired')
  if (job.companyId && !company) issues.push('Selected company inactive')
  if (job.driverId && !driver) issues.push('Selected driver unavailable')
  if (suggestions.conflict && (!job.companyId || !job.driverId)) issues.push('Coverage conflict')
  if (!job.checked) issues.push('Needs review')

  return { postcode, sector, route, routes, company, driver, issues, suggestions, manual }
}

const duplicateKey = (reference: string, date: string, shift: string) => reference.trim()
  ? [reference.trim().toUpperCase(), date, shift.trim().toUpperCase()].join('\0') : ''

export function previewPickups(draft: Draft, approved: ApprovedJob[], index: RouteIndex, team: Team) {
  const counts = new Map<string, number>()
  for (const job of [...approved, ...draft.jobs.map(job => ({ ...job, date: draft.date, shift: draft.shift }))]) {
    const key = duplicateKey(job.orderRef, job.date, job.shift)
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return draft.jobs.map(job => {
    const key = duplicateKey(job.orderRef, draft.date, draft.shift)
    const duplicate = (counts.get(key) ?? 0) > 1
    return {
      ...pickupMatch(job, draft, index, team), job, duplicate,
      previous: duplicate && key ? approved.filter(item => duplicateKey(item.orderRef, item.date, item.shift) === key) : [],
    }
  })
}

export function approveDraft(
  draft: Draft, previous: Approval | undefined, index: RouteIndex, team: Team, datasetId: string, acceptUnassigned: boolean,
): Approval {
  if (!spreadsheetDate(draft.date) || !draft.jobs.length) throw new Error('Enter a date and add at least one pickup.')
  if (draft.sources.some(source => source.status === 'reading')) throw new Error('Wait for image reading to finish.')
  const preview = previewPickups(draft, previous?.jobs ?? [], index, team)
  const invalid = preview.some(item => !item.job.checked || !item.job.orderRef.trim() || item.postcode?.kind !== 'full'
    || (item.manual && !item.job.reason.trim()) || (item.job.route && !item.route) || (item.job.companyId && !item.company)
    || (item.job.driverId && !item.driver) || (item.duplicate && !item.job.duplicateReason.trim()))
  if (invalid) throw new Error('Review every order reference and full postcode, and give reasons for overrides and duplicates.')
  if (!acceptUnassigned && preview.some(item => !item.route || !item.driver || item.issues.length)) {
    throw new Error('Confirm that unresolved and unassigned jobs can be saved.')
  }
  const at = new Date().toISOString()
  const jobs = preview.map(({ job, route, company, driver, sector, postcode }) => ({
    ...job, postcode: postcode!.key, date: draft.date, shift: draft.shift, route, sector, datasetId,
    companyId: company, driverId: driver, company: companyName(team, company), driver: driverName(team, driver),
    approvedAt: at, batchId: draft.id, source: draft.sources.find(source => source.id === job.sourceId),
  }))
  return { id: uid(), at, previousId: previous?.id, jobs: [...(previous?.jobs ?? []), ...jobs] }
}

function sortedJobs(jobs: ApprovedJob[]) {
  return [...jobs].sort((a, b) => compare(a.company || 'Unassigned company', b.company || 'Unassigned company')
    || compare(a.driver || 'Unassigned driver', b.driver || 'Unassigned driver') || compare(a.route, b.route)
    || compare(a.orderRef, b.orderRef))
}

export function groupedPickups(jobs: ApprovedJob[]) {
  const groups = new Map<string, ApprovedJob[]>()
  for (const job of sortedJobs(jobs)) {
    const key = [job.company || 'Unassigned company', job.driver || 'Unassigned driver', job.route ? `Route ${job.route}` : 'No route'].join(' › ')
    const group = groups.get(key) ?? []
    group.push(job)
    groups.set(key, group)
  }
  return groups
}

export function pickupCsv(jobs: ApprovedJob[]) {
  return csv([['Company', 'Driver', 'Route', 'Order reference', 'Postcode', 'Sector', 'Date', 'Shift', 'Notes', 'Override reason', 'Duplicate reason', 'Source version'],
    ...sortedJobs(jobs).map(job => [job.company, job.driver, job.route, job.orderRef, job.postcode, job.sector, job.date, job.shift,
      job.notes, job.reason, job.duplicateReason, job.datasetId])])
}

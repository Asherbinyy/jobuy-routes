import { parsePickupText } from './pickups'
import type { DispatchPlan } from './dispatch'
import { compare, lookup, parsePostcode, routeId, validRouteId, type RouteIndex } from './routes'
import { spreadsheetDate } from './spreadsheets'
import { type Team } from './team'
import { uid } from './util'

export type DeliveryKind = 'delivery' | 'pickup' | 'unclear' | 'exclude'
export type DeliveryReviewRow = {
  id: string; orderRef: string; postcode: string; kind: DeliveryKind; raw: string; route?: string; company?: string
  postcodeChoices?: string[]; postcodeCorrections?: string[]
}
export type CompanyRule = { route: string; company: string; date?: string }
export type DeliveryInput = { id: string; orderRef: string; postcode: string; route: string; company: string }
export type DeliveryJob = DeliveryInput & { date: string; assigned: boolean }
export type DeliveryUpload = { id: string; date: string; rows: DeliveryInput[] }
export type SavedDeliveryUpload = { id: string; date: string; uploadedAt: string; added: number; duplicates: number }
export type DeliveryState = { jobs: DeliveryJob[]; uploads: SavedDeliveryUpload[] }
export const emptyDeliveries: DeliveryState = { jobs: [], uploads: [] }
const isId = (value: string) => /^[a-f0-9]{32}$|^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
const deliveryPattern = /\bdeliver(?:y|ies)\b/i
const pickupPattern = /\b(?:pick[-\s]*ups?|collection)\b/i

function readWaybill(text: string, prefix: string, corrections: string[]): DeliveryReviewRow | undefined {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const mainWaybill = /\bmain\s+(?:w\s*\.?\s*b|waybill)\b/i
  const subWaybill = /\bsub\s+(?:w\s*\.?\s*b|waybill)\b/i
  const markers = lines.flatMap((line, index) => mainWaybill.test(line) ? [index] : [])
  if (!markers.length) return
  const references = new Set(markers.flatMap(index => {
    const text = subWaybill.test(lines[index + 1] ?? '') ? lines[index] : `${lines[index]}\n${lines[index + 1] ?? ''}`
    return parsePickupText(text, '', prefix).map(row => row.orderRef).filter(Boolean)
  }))
  if (references.size > 1) return
  const postcodeChoices = labelPostcodes(text, prefix, corrections)
  const typeLines = lines.filter(line => /\b(?:job type|shipment type)\b|^type\s*[:=]/i.test(line)
    || /^(?:pick[-\s]*up|collection|delivery)(?:\s+(?:example|label))?$/i.test(line))
  const delivery = typeLines.some(line => deliveryPattern.test(line))
  const pickup = typeLines.some(line => pickupPattern.test(line))
  return {
    id: uid(), orderRef: [...references][0] ?? '', postcode: '',
    kind: delivery === pickup ? 'unclear' : delivery ? 'delivery' : 'pickup', postcodeChoices, postcodeCorrections: corrections,
    raw: [...markers.map(index => lines[index]), ...typeLines, ...postcodeChoices].join('\n'),
  }
}

function labelPostcodes(text: string, prefix: string, corrections: string[]) {
  return [...new Set([...parsePickupText(text, '', prefix).map(row => row.postcode).filter(Boolean), ...corrections])]
}

const digitLookalikes: Record<string, string> = { O: '0', I: '1', L: '1', Z: '2', S: '5', G: '6', B: '8' }

function labelCorrections(text: string) {
  return [...text.toUpperCase().matchAll(/\b([A-Z]{1,2}\d[A-Z\d]?)\s+([OILZSGB])\s*([A-Z]{2})\b/g)].flatMap(match => {
    const candidate = parsePostcode(`${match[1]} ${digitLookalikes[match[2]]}${match[3]}`)
    return candidate?.kind === 'full' ? [candidate.key] : []
  })
}

export function deliveryRows(text: string, prefix: string, detail: string[] = []): DeliveryReviewRow[] {
  const allText = [text, ...detail].join('\n')
  const corrections = labelCorrections(detail.join('\n'))
  const waybill = readWaybill(allText, prefix, corrections)
  if (waybill) return [waybill]
  const rows = text.split(/\r?\n/).flatMap(line => {
    const jobs = parsePickupText(line, '', prefix).filter(job => job.orderRef || job.postcode)
    const delivery = deliveryPattern.test(line)
    const pickup = pickupPattern.test(line)
    const kind: DeliveryKind = jobs.length === 1 && delivery !== pickup ? (delivery ? 'delivery' : 'pickup') : 'unclear'
    return jobs.map(({ id, orderRef, postcode }) => ({ id, orderRef, postcode, kind, raw: line.trim() }))
  })
  if (!detail.length || rows.some(row => row.orderRef && row.postcode)) return rows
  const references = [...new Set(parsePickupText(allText, '', prefix).map(row => row.orderRef).filter(Boolean))]
  const postcodeChoices = labelPostcodes(allText, prefix, corrections)
  if (!postcodeChoices.length || (references.length !== 1 && rows.length > 1)) return rows
  const orderRef = references.length === 1 ? references[0].toUpperCase() : ''
  return [{
    id: uid(), orderRef, postcode: '', kind: 'unclear', postcodeChoices, postcodeCorrections: corrections,
    raw: [...references, ...postcodeChoices].join('\n'),
  }]
}

export const blankDeliveryRow = (): DeliveryReviewRow => ({ id: uid(), orderRef: '', postcode: '', kind: 'unclear', raw: '' })

export function resolveDelivery(row: DeliveryReviewRow, date: string, index: RouteIndex, team: Team, rules: CompanyRule[], dispatch?: DispatchPlan) {
  const postcode = parsePostcode(row.postcode)
  const matched = postcode?.kind === 'full' ? lookup(index, postcode.key, true) : null
  const routes = matched?.type === 'match' || matched?.type === 'conflict' ? matched.entry.routes : []
  const route = row.route !== undefined ? (index.routes.has(row.route) ? row.route : '') : routes.length === 1 ? routes[0] : ''
  const eligible = team.coverage.filter(item => item.active && item.approved && (!item.date || item.date === date)
    && !item.shift && (item.routes.includes(route) || item.sectors.includes(postcode?.sector ?? '')))
  const localRules = eligible.flatMap(item => {
    const company = team.companies.find(company => company.active && company.id === item.companyId)
    return company ? [{ company: company.name, date: item.date }] : []
  })
  const matches = route ? [...localRules, ...rules.filter(rule => rule.route === route && (!rule.date || rule.date === date))] : []
  const hints = matches.some(item => item.date === date) ? matches.filter(item => item.date === date) : matches
  const companies = [...new Set(hints.map(item => item.company))].sort(compare)
  const reference = dispatch?.get(route)
  const suggested = companies.length === 1 ? companies[0] : companies.length === 0 ? reference?.company ?? '' : ''
  const company = route ? row.company ?? suggested : ''
  return { postcode, route, routes, companies, company, dispatch: company && reference?.company === company ? reference : undefined }
}

export function readDeliveryUpload(value: unknown): DeliveryUpload {
  if (!value || typeof value !== 'object') throw new Error('Choose a valid date and add at least one delivery.')
  const { id, date, rows } = value as Partial<DeliveryUpload>
  if (typeof id !== 'string' || !isId(id) || typeof date !== 'string' || !date || spreadsheetDate(date) !== date
    || !Array.isArray(rows) || !rows.length || rows.length > 1000) {
    throw new Error('Choose a valid date and add between 1 and 1,000 deliveries.')
  }
  const ids = new Set<string>()
  const valid = rows.map(row => {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !isId(row.id) || ids.has(row.id)
      || typeof row.orderRef !== 'string' || typeof row.postcode !== 'string' || typeof row.route !== 'string' || typeof row.company !== 'string') {
      throw new Error('Review the delivery details before saving.')
    }
    const orderRef = row.orderRef.trim().toUpperCase()
    const company = row.company.trim()
    const route = routeId(row.route)
    const postcode = parsePostcode(row.postcode)
    if (!orderRef || orderRef.length > 80 || /[\s\p{C}]/u.test(orderRef) || (route && !validRouteId(route)) || company.length > 120
      || /\p{C}/u.test(company) || postcode?.kind !== 'full') {
      throw new Error('Each delivery needs an order reference and a valid full postcode.')
    }
    ids.add(row.id)
    return { id: row.id, orderRef, postcode: postcode.key, route, company }
  })
  return { id, date, rows: valid }
}

export function saveDeliveryUpload(before: DeliveryState, upload: DeliveryUpload, stamp = new Date().toISOString()) {
  const existing = before.uploads.find(item => item.id === upload.id)
  if (existing) return { state: before, saved: existing }
  const references = new Set(before.jobs.filter(job => job.date === upload.date).map(job => job.orderRef))
  const jobs: DeliveryJob[] = []
  for (const row of upload.rows) {
    if (references.has(row.orderRef)) continue
    references.add(row.orderRef)
    jobs.push({ ...row, date: upload.date, assigned: false })
  }
  const saved = { id: upload.id, date: upload.date, uploadedAt: stamp, added: jobs.length, duplicates: upload.rows.length - jobs.length }
  return { state: { jobs: [...before.jobs, ...jobs], uploads: [...before.uploads, saved] }, saved }
}

export function setDeliveryAssigned(state: DeliveryState, id: string, assigned: boolean): DeliveryState {
  const job = state.jobs.find(job => job.id === id)
  if (!job) throw new Error('This delivery is no longer in the checklist.')
  if (job.assigned === assigned) return state
  return { ...state, jobs: state.jobs.map(item => item.id === id ? { ...item, assigned } : item) }
}

export function deliveriesForDate(state: DeliveryState, date: string) {
  return {
    jobs: state.jobs.filter(job => job.date === date),
    latestUpload: state.uploads.reduce<SavedDeliveryUpload | undefined>((latest, item) =>
      !latest || latest.uploadedAt <= item.uploadedAt ? item : latest, undefined),
  }
}

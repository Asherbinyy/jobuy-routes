export type PostcodeKind = 'district' | 'sector' | 'full'
export type Postcode = { key: string; kind: PostcodeKind; district: string; sector?: string }

const outward = '(?:GIR|[A-PR-UWYZ][0-9](?:[0-9]|[A-HJKPSTUW])?|[A-PR-UWYZ][A-HK-Y][0-9](?:[0-9]|[ABEHMNPRVWXY])?)'
const inward = '[ABD-HJLNP-UW-Z]{2}'
const fullPattern = new RegExp(`^(${outward})([0-9])(${inward})$`)
const fullShape = new RegExp(`^(${outward})([0-9][A-Z]{2})$`)
const sectorPattern = new RegExp(`^(${outward})[ -]+([0-9])$`)
const compactSectorPattern = new RegExp(`^(${outward})([0-9])$`)
const districtPattern = new RegExp(`^${outward}$`)

export const compare = new Intl.Collator('en-GB', { numeric: true, sensitivity: 'base' }).compare
export const compact = (value: string) => value.toUpperCase().replace(/[\s\p{Pd}]/gu, '')
export const routeId = (value: string) => value.trim().replace(/^route\s+/i, '').toUpperCase()
export const validRouteId = (value: string) => /^[A-Z0-9][A-Z0-9 ._/#-]{0,47}$/.test(value) && /[A-Z0-9]$/.test(value)

export function parsePostcode(value: string, assumeSector = false): Postcode | undefined {
  const input = value.trim().toUpperCase().replace(/\p{Pd}/gu, '-')
  const condensed = compact(input)
  const full = fullPattern.exec(condensed)
  if (full && (full[1] !== 'GIR' || condensed === 'GIR0AA')) {
    const [, district, digit, letters] = full
    return { key: `${district} ${digit}${letters}`, kind: 'full', district, sector: `${district} ${digit}` }
  }
  const sector = sectorPattern.exec(input.replace(/\s+/g, ' ')) ??
    (assumeSector || !districtPattern.test(condensed) ? compactSectorPattern.exec(condensed) : null)
  if (sector && (sector[1] !== 'GIR' || sector[2] === '0')) {
    const [, district, digit] = sector
    return { key: `${district} ${digit}`, kind: 'sector', district, sector: `${district} ${digit}` }
  }
  if (districtPattern.test(condensed) && condensed !== 'GIR') return { key: condensed, kind: 'district', district: condensed }
}

export type SourceRow = { route: string; postcode: string; sheet: string; row: number; originalRoute: string; originalPostcode?: string }
export type Dataset = { id: string; name: string; createdAt: string; rows: SourceRow[] }
export type Entry = Postcode & { routes: string[]; sources: SourceRow[]; frequency: number }
export type Route = { id: string; entries: Entry[] }
export type RouteIndex = {
  entries: Map<string, Entry>
  routes: Map<string, Route>
  districts: Map<string, Entry[]>
  prefixes: Map<string, Entry[]>
  duplicates: { postcode: string; route: string; count: number }[]
  conflicts: { postcode: string; routes: string[] }[]
}

export function buildIndex(dataset: Dataset): RouteIndex {
  const rowsByKey = new Map<string, { postcode: Postcode; sources: SourceRow[] }>()
  for (const row of dataset.rows) {
    const postcode = parsePostcode(row.postcode)
    if (!postcode) continue
    const existing = rowsByKey.get(postcode.key)
    if (existing) existing.sources.push(row)
    else rowsByKey.set(postcode.key, { postcode, sources: [row] })
  }
  const entries = new Map<string, Entry>()
  const routes = new Map<string, Route>()
  const districts = new Map<string, Entry[]>()
  const prefixes = new Map<string, Entry[]>()
  const duplicates: RouteIndex['duplicates'] = []
  const conflicts: RouteIndex['conflicts'] = []
  for (const { postcode, sources } of [...rowsByKey.values()].sort((a, b) => compare(a.postcode.key, b.postcode.key))) {
    const counts = new Map<string, number>()
    for (const { route } of sources) counts.set(route, (counts.get(route) ?? 0) + 1)
    const entry = { ...postcode, routes: [...counts.keys()].sort(compare), sources, frequency: sources.length }
    entries.set(entry.key, entry)
    for (const id of entry.routes) {
      const route = routes.get(id) ?? { id, entries: [] }
      route.entries.push(entry)
      routes.set(id, route)
      const count = counts.get(id)!
      if (count > 1) duplicates.push({ postcode: entry.key, route: id, count })
    }
    const districtEntries = districts.get(entry.district) ?? []
    districtEntries.push(entry)
    districts.set(entry.district, districtEntries)
    if (entry.routes.length > 1) conflicts.push({ postcode: entry.key, routes: entry.routes })
  }
  for (const [district, children] of districts) {
    const entry = entries.get(district) ?? {
      key: district, district, kind: 'district' as const, sources: [],
      routes: [...new Set(children.flatMap(child => child.routes))].sort(compare),
      frequency: children.reduce((total, child) => total + child.frequency, 0),
    }
    const suggestions = [entry, ...children.filter(child => child.kind !== 'district')]
    for (const suggestion of suggestions) {
      const key = compact(suggestion.key)
      for (let length = 1; length <= key.length; length++) {
        const prefix = key.slice(0, length)
        const group = prefixes.get(prefix) ?? []
        group.push(suggestion)
        prefixes.set(prefix, group)
      }
    }
  }
  return { entries, routes: new Map([...routes.entries()].sort(([a], [b]) => compare(a, b))), districts, prefixes, duplicates, conflicts }
}

export type Lookup =
  | { type: 'route'; route: Route }
  | { type: 'match' | 'conflict'; postcode: Postcode; entry: Entry }
  | { type: 'district'; postcode: Postcode; entries: Entry[] }
  | { type: 'missing'; postcode: Postcode }
  | { type: 'invalid'; query: string }
  | { type: 'partial' }

export function lookup(index: RouteIndex, query: string, onlyPostcode = false): Lookup {
  const text = query.trim()
  const id = onlyPostcode ? undefined : sameRoute(index, text)
  const route = id ? index.routes.get(id) : undefined
  if (!onlyPostcode && route && (/^route\s/i.test(text) || !parsePostcode(text))) return { type: 'route', route }
  const postcode = parsePostcode(text)
  if (!postcode) {
    const shape = fullShape.exec(compact(text))
    return shape ? { type: 'invalid', query: `${shape[1]} ${shape[2]}` } : { type: 'partial' }
  }
  if (postcode.kind === 'district') {
    const entries = index.districts.get(postcode.district)
    return entries ? { type: 'district', postcode, entries } : { type: 'missing', postcode }
  }
  const entry = index.entries.get(postcode.key) ?? (postcode.sector ? index.entries.get(postcode.sector) : undefined)
  if (!entry) return { type: 'missing', postcode }
  return { type: entry.routes.length > 1 ? 'conflict' : 'match', postcode, entry }
}

export type SearchHistory = Record<string, { count: number; last: number }>
export const historyKey = (query: string, result: Lookup) => result.type === 'route'
  ? `Route ${result.route.id}`
  : result.type === 'partial' || result.type === 'invalid' ? query.trim().toUpperCase() : result.postcode.key

export function autocomplete(index: RouteIndex, history: SearchHistory, query: string) {
  const prefix = compact(query.trim())
  if (!prefix || !/^[A-Z0-9]+$/.test(prefix)) return []
  const typed = parsePostcode(query)
  const explicitDistrict = typed?.district ?? query.trim().toUpperCase().match(/^([A-Z]+[0-9]+[A-Z]?)[\s\p{Pd}]+/u)?.[1]
  const matches = (index.prefixes.get(prefix) ?? []).filter(entry => !explicitDistrict || entry.district === explicitDistrict)
  const quality = (entry: Entry) => {
    if (typed && entry.key === typed.key) return 2
    return entry.district === prefix || entry.district.startsWith(prefix) || entry.key.startsWith(query.trim().toUpperCase()) ? 1 : 0
  }
  return matches.sort((a, b) => quality(b) - quality(a)
    || (history[b.key]?.count ?? 0) - (history[a.key]?.count ?? 0)
    || (history[b.key]?.last ?? 0) - (history[a.key]?.last ?? 0)
    || b.frequency - a.frequency || compare(a.key, b.key))
}

export type AllocationChange = { postcode: string; before: string[]; after: string[] }
export function diffRoutes(before: RouteIndex, after: RouteIndex) {
  const keys = new Set([...before.entries.keys(), ...after.entries.keys()])
  const changes: AllocationChange[] = []
  for (const postcode of [...keys].sort(compare)) {
    const previous = before.entries.get(postcode)?.routes ?? []
    const next = after.entries.get(postcode)?.routes ?? []
    if (previous.join('\0') !== next.join('\0')) changes.push({ postcode, before: previous, after: next })
  }
  return {
    added: changes.filter(change => !change.before.length),
    removed: changes.filter(change => !change.after.length),
    changed: changes.filter(change => change.before.length && change.after.length),
    newRoutes: [...after.routes.keys()].filter(id => !before.routes.has(id)),
    retiredRoutes: [...before.routes.keys()].filter(id => !after.routes.has(id)),
  }
}

export function sameRoute(index: RouteIndex, value: string) {
  const id = routeId(value)
  if (index.routes.has(id)) return id
  if (!/^\d+$/.test(id)) return undefined
  const numeric = [...index.routes.keys()].filter(key => /^\d+$/.test(key) && key.replace(/^0+(?=\d)/, '') === id.replace(/^0+(?=\d)/, ''))
  return numeric.length === 1 ? numeric[0] : undefined
}

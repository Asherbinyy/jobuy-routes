import { parsePostcode, routeId, validRouteId, type Dataset, type SourceRow } from './routes'
import { uid } from './util'

export type Sheet = { name: string; rows: string[][] }
export type Field = { key: string; label: string; aliases: string[]; required?: boolean }
export type Mapping = { enabled: boolean; header: number; columns: Record<string, number>; fillRoute?: boolean }
export type MappedRow = { sheet: string; row: number; values: Record<string, string> }

export const aliases = {
  route: ['route', 'route id', 'route number', 'route no', 'routing', 'route zones', 'route zone', 'route code', 'route allocation', 'route identifier', 'route ref', '路区'],
  postcode: ['postcode', 'postcodes', 'post code', 'postal code', 'postcode sector', 'sector', 'sectors', 'zip', 'zip code', 'outward code', 'district', '邮编'],
  company: ['company', 'company name', 'carrier', 'provider', 'dsp', 'organisation', 'employer'],
  driver: ['driver', 'driver name', 'courier', 'employee', 'display name'],
  date: ['date', 'shift date', 'allocation date', 'pickup date'],
  shift: ['shift', 'shift name'],
  notes: ['notes', 'note', 'comment', 'comments', 'remarks'],
  reference: ['reference', 'order', 'order ref', 'order number', 'order reference', 'pickup order reference', 'pickup ref', 'job reference', 'tracking number', 'tracking id'],
}
export const routeFields: Field[] = [
  { key: 'route', label: 'Route', required: true, aliases: aliases.route },
  { key: 'postcode', label: 'Postcode', required: true, aliases: aliases.postcode },
]
const normal = (value: string) => value.trim().toLowerCase().replace(/([a-z])([0-9])/g, '$1 $2').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
function headerScore(value: string, alias: string) {
  if (value === alias) return 10
  if (` ${value} `.includes(` ${alias} `)) return alias.includes(' ') ? 7 : 4
  return 0
}
export function detectMapping(sheet: Sheet, fields: Field[], inferRoutes = false): Mapping {
  const candidates = sheet.rows.slice(0, 35).map((row, index) => {
    const columns: Mapping['columns'] = {}
    const claimed = new Set<number>()
    let score = 0
    for (const field of fields) {
      const options = row.map((value, column) => ({
        score: Math.max(...field.aliases.map(alias => headerScore(normal(value), normal(alias)))),
        column,
      })).filter(item => item.score && !claimed.has(item.column)).sort((a, b) => b.score - a.score)
      if (options[0] && options[0].score !== options[1]?.score) {
        columns[field.key] = options[0].column
        claimed.add(options[0].column)
        score += options[0].score + (field.required ? 20 : 0)
      }
    }
    return { header: index + 1, columns, score }
  })
  const best = candidates.sort((a, b) => b.score - a.score)[0]
  if (best?.score && fields.filter(field => field.required).every(field => best.columns[field.key] !== undefined)) {
    return { enabled: true, header: best.header, columns: best.columns }
  }
  if (inferRoutes) {
    const first = sheet.rows.findIndex(row => row.some(value => value.trim()))
    const sample = first < 0 ? [] : sheet.rows.slice(first, first + 30).filter(row => row.some(value => value.trim()))
    const width = Math.max(0, ...sample.map(row => row.length))
    const scores = Array.from({ length: width }, (_, column) => {
      const values = sample.map(row => (row[column] ?? '').trim()).filter(Boolean)
      return {
        column, values,
        postcode: values.filter(value => Boolean(parsePostcode(value))).length,
        route: values.filter(value => validRouteId(routeId(value)) && /\d/.test(value) && !parsePostcode(value)).length,
      }
    })
    const postcodes = scores.filter(item => item.postcode > 0 && item.postcode >= sample.length * 0.8)
    const routes = scores.filter(item => item.route > 0 && item.route >= sample.length * 0.8)
    if (postcodes.length === 1 && routes.length === 1 && postcodes[0].column !== routes[0].column) {
      const header = parsePostcode(sample[0][postcodes[0].column] ?? '') ? first : first + 1
      return { enabled: true, header, columns: { route: routes[0].column, postcode: postcodes[0].column } }
    }
  }
  return { enabled: false, header: best?.score ? best.header : 1, columns: best?.columns ?? {} }
}

export async function readSpreadsheet(file: File): Promise<Sheet[]> {
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error('Choose an Excel (.xlsx or .xls) or CSV file.')
  if (!file.size || file.size > 25 * 1024 * 1024) throw new Error('Choose a non-empty spreadsheet up to 25 MB.')
  const xlsx = await import('xlsx')
  const workbook = xlsx.read(await file.arrayBuffer(), { type: 'array', raw: true, dense: true, cellDates: true, cellText: false, cellNF: true })
  return workbook.SheetNames.map(name => {
    const worksheet = workbook.Sheets[name]
    const reference = worksheet['!ref']
    if (!reference) return { name, rows: [] }
    const range = xlsx.utils.decode_range(reference)
    if (range.e.r > 100000 || range.e.c > 999) throw new Error(`${name} exceeds the supported spreadsheet dimensions.`)
    // Starting at A1 preserves worksheet row numbers and column letters.
    const cells = xlsx.utils.sheet_to_json<(string | number | boolean | Date)[]>(worksheet, { header: 1, range: 0, defval: '', blankrows: true })
    const rows = cells.map((row, rowIndex) => Array.from(row, (cell, column) => {
      if (cell instanceof Date) return cell.toISOString().slice(0, 10)
      if (typeof cell === 'number') {
        const format = worksheet['!data']?.[rowIndex]?.[column]?.z
        if (typeof format === 'string' && /^0{2,}$/.test(format)) return String(cell).padStart(format.length, '0')
      }
      return String(cell ?? '')
    }))
    for (const merge of worksheet['!merges'] ?? []) {
      if (merge.s.c !== merge.e.c) continue
      const value = rows[merge.s.r]?.[merge.s.c]
      if (!value) continue
      for (let row = merge.s.r + 1; row <= Math.min(merge.e.r, rows.length - 1); row++) {
        if (!rows[row][merge.s.c]) rows[row][merge.s.c] = value
      }
    }
    return { name, rows }
  })
}

export function mapRows(sheets: Sheet[], mappings: Mapping[], fields: Field[]) {
  const rows: MappedRow[] = []
  const errors: string[] = []
  for (const [index, sheet] of sheets.entries()) {
    const { enabled, header, columns, fillRoute } = mappings[index]
    if (!enabled) continue
    const selected = fields.map(field => columns[field.key]).filter(column => column !== undefined)
    if (fields.some(field => field.required && columns[field.key] === undefined) || new Set(selected).size !== selected.length) {
      errors.push(`${sheet.name.trim()}: select a different column for each required field.`)
      continue
    }
    let previousRoute = ''
    for (const [offset, row] of sheet.rows.slice(header).entries()) {
      const values = Object.fromEntries(fields.map(field => [field.key, row[columns[field.key]] ?? '']))
      if (!Object.values(values).some(value => value.trim())) continue
      const primary = fields.filter(field => field.required)
      if (primary.length > 1 && primary.every(field => normal(values[field.key]) === normal(sheet.rows[header - 1]?.[columns[field.key]] ?? '')
        || field.aliases.some(alias => normal(values[field.key]) === normal(alias)))) continue
      if (fillRoute && 'route' in values) {
        if (values.route.trim()) previousRoute = values.route
        else if (values.postcode?.trim()) values.route = previousRoute
      }
      rows.push({ sheet: sheet.name, row: header + offset + 1, values })
    }
  }
  if (!rows.length && !errors.length) errors.push('No records found. Check the included sheets, header row and columns.')
  return { rows, errors }
}

export function prepareRoutes(name: string, sheets: Sheet[], mappings: Mapping[]) {
  const mapped = mapRows(sheets, mappings, routeFields)
  const rows: SourceRow[] = []
  for (const { sheet, row, values } of mapped.rows) {
    const route = routeId(values.route)
    const postcodes = parsePostcode(values.postcode) ? [values.postcode] : values.postcode.split(/[,;/\n]+/).filter(value => value.trim())
    if (!validRouteId(route) || !postcodes.length || postcodes.some(value => !parsePostcode(value))) {
      mapped.errors.push(`${sheet.trim()}, row ${row}: enter a route identifier and a valid UK postcode, sector or district.`)
      continue
    }
    for (const postcode of postcodes) rows.push({ sheet, row, route, postcode, originalRoute: values.route, originalPostcode: values.postcode })
  }
  const dataset: Dataset | undefined = rows.length && !mapped.errors.length
    ? { id: uid(), name, createdAt: new Date().toISOString(), rows }
    : undefined
  return { dataset, errors: mapped.errors }
}

export const columnLabel = (index: number): string => (index >= 26 ? columnLabel(Math.floor(index / 26) - 1) : '') + String.fromCharCode(65 + index % 26)

export function spreadsheetDate(value: string) {
  const text = value.trim()
  if (!text) return ''
  let date = /^(\d{4})-(\d\d)-(\d\d)$/.exec(text)?.[0]
  const british = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text)
  if (british) date = `${british[3]}-${british[2].padStart(2, '0')}-${british[1].padStart(2, '0')}`
  if (!date) return undefined
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : undefined
}

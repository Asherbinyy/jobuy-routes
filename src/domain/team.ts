import { compare, parsePostcode, sameRoute, type RouteIndex } from './routes'
import { aliases, spreadsheetDate, type Field, type MappedRow } from './spreadsheets'
import { uid } from './util'

export type Company = { id: string; name: string; active: boolean; notes: string; aliases: string[] }
export type Driver = { id: string; name: string; companyId: string; active: boolean; notes: string }
export type Coverage = {
  id: string; companyId: string; driverId: string; date: string; shift: string; routes: string[]
  sectors: string[]; approved: boolean; active: boolean; source: string; notes: string
}
export type Team = { companies: Company[]; drivers: Driver[]; coverage: Coverage[] }
export const emptyTeam: Team = { companies: [], drivers: [], coverage: [] }
export type TeamImportKind = keyof Team

export const teamFields: Record<TeamImportKind, Field[]> = {
  companies: [
    { key: 'company', label: 'Company', required: true, aliases: [...aliases.company, 'name'] },
    { key: 'aliases', label: 'Aliases', aliases: ['alias', 'aliases', 'alternate names'] },
    { key: 'notes', label: 'Notes', aliases: aliases.notes },
  ],
  drivers: [
    { key: 'driver', label: 'Driver', required: true, aliases: [...aliases.driver, 'name'] },
    { key: 'company', label: 'Company', required: true, aliases: aliases.company },
    { key: 'notes', label: 'Notes', aliases: aliases.notes },
  ],
  coverage: [
    { key: 'company', label: 'Company', required: true, aliases: aliases.company },
    { key: 'driver', label: 'Driver', aliases: aliases.driver },
    { key: 'route', label: 'Routes', aliases: [...aliases.route, 'routes'] },
    { key: 'postcode', label: 'Sectors', aliases: aliases.postcode },
    { key: 'date', label: 'Date', aliases: aliases.date },
    { key: 'shift', label: 'Shift', aliases: aliases.shift },
    { key: 'notes', label: 'Notes', aliases: aliases.notes },
  ],
}

const folded = (value: string) => value.trim().toLocaleLowerCase('en-GB')
export const splitValues = (value: string) => [...new Set(value.split(/[,;\n]+/).map(item => item.trim()).filter(Boolean))]
export const companyName = (team: Team, id: string) => team.companies.find(company => company.id === id)?.name ?? ''
export const driverName = (team: Team, id: string) => team.drivers.find(driver => driver.id === id)?.name ?? ''

export function validateCompany(team: Team, company: Company) {
  const names = [company.name, ...company.aliases].map(folded)
  if (!names[0]) return 'Enter a company name.'
  if (new Set(names).size !== names.length) return 'Enter distinct company names and aliases.'
  if (team.companies.some(item => item.id !== company.id && [item.name, ...item.aliases].some(name => names.includes(folded(name))))) {
    return 'This company name or alias is already in use.'
  }
}

export function validateDriver(team: Team, driver: Driver) {
  if (!driver.name.trim()) return 'Enter a driver name.'
  if (!team.companies.some(company => company.id === driver.companyId && (company.active || !driver.active))) return 'Choose an active company.'
  if (team.drivers.some(item => item.id !== driver.id && item.companyId === driver.companyId && folded(item.name) === folded(driver.name))) {
    return 'This driver name already exists at the company.'
  }
}

export function coverageReferences(coverage: Coverage, index: RouteIndex, team: Team) {
  const issues = coverage.routes.filter(id => !index.routes.has(id)).map(id => `Route ${id} retired`)
  for (const sector of coverage.sectors) {
    if (!index.entries.get(sector)?.routes.length && !index.districts.get(parsePostcode(sector)?.district ?? '')?.some(entry => entry.sector === sector)) {
      issues.push(`Sector ${sector} removed`)
    }
  }
  if (!team.companies.some(company => company.id === coverage.companyId && company.active)) issues.push('Company inactive or missing')
  if (coverage.driverId && !team.drivers.some(driver => driver.id === coverage.driverId && driver.companyId === coverage.companyId && driver.active)) {
    issues.push('Driver inactive, missing or moved to another company')
  }
  return issues
}

export function coverageInput(index: RouteIndex, routeText: string, sectorText: string) {
  const routes: string[] = []
  const sectors: string[] = []
  const errors: string[] = []
  for (const value of splitValues(routeText)) {
    const id = sameRoute(index, value)
    if (id) routes.push(id)
    else errors.push(`Unknown route: ${value}`)
  }
  for (const value of splitValues(sectorText)) {
    const postcode = parsePostcode(value, true)
    if (postcode?.kind === 'sector' && index.districts.get(postcode.district)?.some(entry => entry.sector === postcode.key)) {
      sectors.push(postcode.key)
    } else errors.push(`Unknown sector: ${value}`)
  }
  if (!routes.length && !sectors.length && !errors.length) errors.push('Enter at least one route or postcode sector.')
  return { routes: [...new Set(routes)].sort(compare), sectors: [...new Set(sectors)].sort(compare), errors }
}

export function overlaps(a: Coverage, b: Coverage, index: RouteIndex) {
  if (a.id === b.id || !a.active || !b.active || a.date !== b.date || (a.shift && b.shift && folded(a.shift) !== folded(b.shift))) return false
  if (a.companyId === b.companyId && (!a.driverId || !b.driverId || a.driverId === b.driverId)) return false
  return a.routes.some(route => b.routes.includes(route)) || a.sectors.some(sector => b.sectors.includes(sector))
    || a.routes.some(route => index.routes.get(route)?.entries.some(entry => entry.sector && b.sectors.includes(entry.sector)))
    || b.routes.some(route => index.routes.get(route)?.entries.some(entry => entry.sector && a.sectors.includes(entry.sector)))
}

export function suggestCoverage(team: Team, route: string, sector: string, date: string, shift: string) {
  const matches = team.coverage.filter(item => item.active && item.approved && item.date && item.date === date
    && (!item.shift || folded(item.shift) === folded(shift))
    && (item.routes.includes(route) || item.sectors.includes(sector))
    && team.companies.some(company => company.active && company.id === item.companyId)
    && (!item.driverId || team.drivers.some(driver => driver.active && driver.id === item.driverId && driver.companyId === item.companyId)))
  const companies = [...new Set(matches.map(item => item.companyId))]
  const drivers = [...new Set(matches.map(item => item.driverId).filter(Boolean))]
  return {
    matches, companyId: companies.length === 1 ? companies[0] : '',
    driverId: companies.length === 1 && drivers.length === 1 ? drivers[0] : '',
    conflict: companies.length > 1 || drivers.length > 1,
  }
}

export function prepareTeamImport(kind: TeamImportKind, rows: MappedRow[], team: Team, index: RouteIndex, source: string) {
  const next = { companies: [...team.companies], drivers: [...team.drivers], coverage: [...team.coverage] }
  const added: string[] = []
  const skipped: string[] = []
  const errors: string[] = []
  for (const { sheet, row, values: raw } of rows) {
    const values = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value.trim()]))
    const location = `${sheet.trim()}, row ${row}`
    if (!values.company) {
      errors.push(`${location}: company is required.`)
      continue
    }
    const company = next.companies.find(item => [item.name, ...item.aliases].some(name => folded(name) === folded(values.company)))
    if (kind === 'companies') {
      if (company) {
        skipped.push(`${values.company} · existing record kept`)
        continue
      }
      const item = { id: uid(), name: values.company, active: true, aliases: splitValues(values.aliases), notes: values.notes }
      const error = validateCompany(next, item)
      if (error) errors.push(`${location}: ${error}`)
      else {
        next.companies.push(item)
        added.push(item.name)
      }
      continue
    }
    if (!company?.active) {
      errors.push(`${location}: add or activate company “${values.company}” first.`)
      continue
    }
    const driver = next.drivers.find(item => item.companyId === company.id && folded(item.name) === folded(values.driver ?? ''))
    if (kind === 'drivers') {
      if (driver) {
        skipped.push(`${driver.name} · existing record kept`)
        continue
      }
      const item = { id: uid(), name: values.driver, companyId: company.id, active: true, notes: values.notes }
      const error = validateDriver(next, item)
      if (error) errors.push(`${location}: ${error}`)
      else {
        next.drivers.push(item)
        added.push(`${company.name} · ${item.name}`)
      }
      continue
    }
    const date = spreadsheetDate(values.date)
    const allocation = coverageInput(index, values.route, values.postcode)
    if (date === undefined || (values.driver && (!driver?.active || !date)) || (values.shift && !date) || allocation.errors.length) {
      errors.push(`${location}: ${allocation.errors.join('. ') || 'Check the date, shift and active driver. Use YYYY-MM-DD or DD/MM/YYYY.'}`)
      continue
    }
    const match = next.coverage.find(item => item.companyId === company.id && item.driverId === (driver?.id ?? '')
      && item.date === date && folded(item.shift) === folded(values.shift)
      && [...item.routes].sort(compare).join('\0') === allocation.routes.join('\0')
      && [...item.sectors].sort(compare).join('\0') === allocation.sectors.join('\0'))
    const summary = [company.name, driver?.name, date || 'General coverage', ...allocation.routes.map(route => `Route ${route}`), ...allocation.sectors].filter(Boolean).join(' · ')
    if (match) skipped.push(`${summary} · existing allocation kept`)
    else {
      const item: Coverage = {
        id: uid(), companyId: company.id, driverId: driver?.id ?? '', date, shift: values.shift,
        routes: allocation.routes, sectors: allocation.sectors, approved: false, active: true,
        source: `${source} · ${location}`, notes: values.notes,
      }
      const conflict = next.coverage.some(existing => overlaps(item, existing, index))
      next.coverage.push(item)
      added.push(conflict ? `${summary} · overlapping coverage` : summary)
    }
  }
  return { next, added, skipped, errors }
}

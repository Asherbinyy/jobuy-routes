import reference from '../data/dispatch-reference.json'
import { seed } from '../data/seed'
import { buildIndex, type RouteIndex } from './routes'

export type RouteDispatch = { company: string; wave: string; times: string[] }
export type DispatchPlan = ReadonlyMap<string, RouteDispatch>

export const dispatchCompanies = reference.companies
export const dispatchWaves = reference.waves

const seedRoutes = buildIndex(seed).routes
const allocations = new Map<string, RouteDispatch>()
for (const wave of dispatchWaves) {
  for (const group of wave.groups) {
    const company = dispatchCompanies.find(item => item.id === group.company)
    if (!company) continue
    for (const route of group.routes) allocations.set(route, { company: company.name, wave: wave.label, times: wave.times })
  }
}

export function dispatchForRoutes(index: RouteIndex): DispatchPlan {
  const plan = new Map<string, RouteDispatch>()
  for (const [route, allocation] of allocations) {
    const original = seedRoutes.get(route)?.entries
    const current = index.routes.get(route)?.entries
    if (original && current?.length === original.length && current.every((entry, position) => entry.key === original[position].key)) {
      plan.set(route, allocation)
    }
  }
  return plan
}

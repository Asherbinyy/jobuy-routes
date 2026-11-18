import type { SearchHistory } from '../domain/routes'

const key = 'manchester-search-v1'
let memory: SearchHistory = {}
export function readHistory(): SearchHistory {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return memory
    return { ...Object.fromEntries(Object.entries(parsed).filter(([, entry]) =>
      entry && Number.isFinite(entry.count) && entry.count > 0 && Number.isFinite(entry.last))), ...memory }
  } catch {
    return memory
  }
}

export function recordSearch(query: string, history: SearchHistory, now = Date.now()) {
  const merged = { ...history, ...readHistory() }
  merged[query] = { count: (merged[query]?.count ?? 0) + 1, last: now }
  const saved = Object.fromEntries(Object.entries(merged).sort(([, a], [, b]) => b.last - a.last).slice(0, 500))
  try {
    localStorage.setItem(key, JSON.stringify(saved))
    memory = {}
  } catch { memory = saved }
  return saved
}

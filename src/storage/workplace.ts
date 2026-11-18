import type { CompanyRule, DeliveryJob, DeliveryUpload, SavedDeliveryUpload } from '../domain/deliveries'

const api = '/api/dispatch'
export type WorkplaceBoard = { jobs: DeliveryJob[]; latestUpload?: SavedDeliveryUpload; rules: CompanyRule[]; revision: number }

async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(api + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    const detail: { error?: string } = await response.json().catch(() => ({}))
    throw new Error(detail.error ?? 'Could not reach the warehouse checklist.')
  }
  return response.json() as Promise<T>
}

export const loadWorkplace = (date: string, signal?: AbortSignal) => request<WorkplaceBoard>(`?date=${encodeURIComponent(date)}`, undefined, signal)
export const uploadWorkplace = (upload: DeliveryUpload) => request<SavedDeliveryUpload>('/uploads', upload)
export const assignWorkplace = (id: string, assigned: boolean) => request<{ assigned: boolean }>('/assignments', { id, assigned })

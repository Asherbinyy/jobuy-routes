import { useState, type ReactNode } from 'react'
import { copyText } from '../domain/util'

const paths: Record<string, ReactNode> = {
  brand: <><path d="M6 18V7a3 3 0 0 1 6 0v10a3 3 0 0 0 6 0V6"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/></>,
  search: <><circle cx="10.8" cy="10.8" r="5.7"/><path d="m15 15 4.5 4.5"/></>,
  routes: <><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></>,
  pickups: <><path d="m4 7 8-4 8 4v10l-8 4-8-4V7Zm0 0 8 4 8-4m-8 4v10m-4-16 8 4"/></>,
  team: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2m1-15a3 3 0 0 1 0 6m1 3a4 4 0 0 1 4 4v2"/></>,
  data: <><ellipse cx="12" cy="5" rx="7" ry="2.8"/><path d="M5 5v14c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8V5m-14 7c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8"/></>,
  arrow: <><path d="M4.5 12h14m-5-5 5 5-5 5"/></>,
  back: <><path d="M19.5 12h-14m5-5-5 5 5 5"/></>,
  chevron: <path d="m9 6 6 6-6 6"/>,
  pin: <><path d="M19 10c0 4.6-7 10-7 10S5 14.6 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.3"/></>,
  clock: <><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></>,
  trend: <><path d="m3 16 6-6 4 4 7-7m-6 0h6v6"/></>,
  alert: <><path d="M11 4 3 18a1.3 1.3 0 0 0 1 2h16a1.3 1.3 0 0 0 1-2L13 4a1.2 1.2 0 0 0-2 0Z"/><path d="M12 9v4m0 3h.01"/></>,
  clear: <path d="m6 6 12 12M18 6 6 18"/>,
  upload: <><path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
}
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

export const routeNumber = (id: string) => /^\d$/.test(id) ? id.padStart(2, '0') : id
export const routeLink = (id: string) => `#/routes/${encodeURIComponent(id)}`
export const routeNames = (ids: string[]) => ids.length ? ids.map(id => `Route ${id}`).join(', ') : 'None'
export const formatDate = (date: string) => date ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(date)) : 'Original workbook'

export function Heading({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <header className="page-heading"><div><h1>{title}</h1>{children && <p>{children}</p>}</div>{action}</header>
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [status, setStatus] = useState('')
  return <div className="copy-control">
    <button type="button" className="button secondary" onClick={async () => {
      try { setStatus(await copyText(text) ? 'Copied' : 'Select and copy the text below.') }
      catch { setStatus('Select and copy the text below.') }
    }}><Icon name="copy" size={17}/>{label}</button>
    <span role="status" className="copy-status">{status}</span>
    {status.startsWith('Select') && <textarea readOnly aria-label="Text to copy" value={text} onFocus={event => event.target.select()}/>}
  </div>
}

export function FilePicker({ label, accept, onFiles, multiple, capture, disabled }: {
  label: string; accept: string; onFiles: (files: File[]) => void; multiple?: boolean; capture?: 'environment'; disabled?: boolean
}) {
  return <label className={`button secondary file-picker${disabled ? ' disabled' : ''}`}>
    <Icon name={capture ? 'plus' : 'upload'} size={18}/>{label}
    <input type="file" accept={accept} multiple={multiple} capture={capture} disabled={disabled} aria-label={label}
      onChange={event => {
        const files = [...(event.currentTarget.files ?? [])]
        event.currentTarget.value = ''
        if (files.length) onFiles(files)
      }}/>
  </label>
}

export function ProblemList({ errors }: { errors: string[] }) {
  if (!errors.length) return null
  return <details className="notice warning" open>
    <summary>{errors.length} {errors.length === 1 ? 'issue to review' : 'issues to review'}</summary>
    <ul>{errors.slice(0, 100).map((error, index) => <li key={index}>{error}</li>)}</ul>
    {errors.length > 100 && <p>Showing the first 100 issues.</p>}
  </details>
}

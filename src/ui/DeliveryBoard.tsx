import { useCallback, useEffect, useRef, useState } from 'react'
import {
  blankDeliveryRow, deliveriesForDate, deliveryRows, emptyDeliveries, readDeliveryUpload, resolveDelivery,
  saveDeliveryUpload, setDeliveryAssigned, type CompanyRule, type DeliveryJob, type DeliveryKind,
  type DeliveryReviewRow, type SavedDeliveryUpload,
} from '../domain/deliveries'
import { dispatchCompanies, type DispatchPlan } from '../domain/dispatch'
import { browserReadablePhoto, recognizeImage } from '../domain/ocr'
import { compare, type RouteIndex } from '../domain/routes'
import { csv, download, today, uid } from '../domain/util'
import type { Commit } from '../storage/useWorkspace'
import type { Workspace } from '../storage/workspace'
import { assignWorkplace, loadWorkplace, uploadWorkplace, type WorkplaceBoard } from '../storage/workplace'
import { FilePicker, Heading, Icon, formatDate, routeNames } from './shared'

type Screenshot = { id: string; name: string; url: string; rows: DeliveryReviewRow[]; confidence?: number }
const noRules: CompanyRule[] = []
const atDepot = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })

function dayName(date: string) {
  const current = today()
  if (date === current) return 'Today'
  const previous = new Date(`${current}T00:00:00Z`)
  previous.setUTCDate(previous.getUTCDate() - 1)
  return date === previous.toISOString().slice(0, 10) ? 'Yesterday' : formatDate(`${date}T12:00:00Z`)
}

function DeliveryGroups({ jobs, pending, change }: {
  jobs: DeliveryJob[]; pending: Record<string, boolean | undefined>; change: (job: DeliveryJob, assigned: boolean) => void
}) {
  const companies = new Map<string, Map<string, DeliveryJob[]>>()
  for (const job of [...jobs].sort((a, b) => compare(a.company, b.company) || compare(a.route, b.route) || compare(a.orderRef, b.orderRef))) {
    const routes = companies.get(job.company) ?? new Map<string, DeliveryJob[]>()
    const list = routes.get(job.route) ?? []
    list.push(job)
    routes.set(job.route, list)
    companies.set(job.company, routes)
  }
  return <div className="delivery-groups">{[...companies].map(([company, routes]) =>
    <section className="panel content-panel delivery-company" key={company}>
      <h3>{company || 'Company unassigned'}</h3>
      {[...routes].map(([route, rows]) => <div className="delivery-route" key={route}>
        <h4>{route ? `Route ${route}` : 'Route unassigned'}</h4>
        <ul className="delivery-jobs">{rows.map(job => {
          const checked = pending[job.id] ?? job.assigned
          return <li key={job.id}><label className={`delivery-job${checked ? ' assigned' : ''}`}>
            <input type="checkbox" aria-label={`Assigned ${job.orderRef}`} checked={checked} disabled={pending[job.id] !== undefined}
              onChange={event => change(job, event.target.checked)}/>
            <span className="delivery-tick" aria-hidden="true"><Icon name="check" size={15}/></span>
            <span className="delivery-label"><strong>{job.orderRef}</strong><small>{job.postcode}</small></span>
            <span className="delivery-status">{checked ? 'Assigned' : 'To assign'}</span>
          </label></li>
        })}</ul>
      </div>)}
    </section>
  )}</div>
}

export function DeliveryBoard({ index, dispatch, state, commit, shared }: {
  index: RouteIndex; dispatch: DispatchPlan; state: Workspace; commit: Commit; shared: boolean
}) {
  const [date, setDate] = useState(today)
  const [screenshot, setScreenshot] = useState<Screenshot>()
  const [reading, setReading] = useState(false)
  const [progress, setProgress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [networkError, setNetworkError] = useState('')
  const [sharedBoard, setSharedBoard] = useState<{ date: string; board: WorkplaceBoard }>()
  const [pending, setPending] = useState<Record<string, boolean | undefined>>({})
  const previewHeading = useRef<HTMLHeadingElement>(null)
  const pictureUrl = screenshot?.url
  useEffect(() => () => { if (pictureUrl) URL.revokeObjectURL(pictureUrl) }, [pictureUrl])

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!shared) return
    try {
      const board = await loadWorkplace(date, signal)
      if (!signal?.aborted) {
        setSharedBoard(previous => previous?.date === date && previous.board.revision > board.revision ? previous : { date, board })
        setNetworkError('')
      }
    } catch (failure) {
      if (!signal?.aborted) setNetworkError(failure instanceof Error ? failure.message : 'Could not load the shared checklist.')
    }
  }, [date, shared])
  useEffect(() => {
    if (!shared) return
    const controller = new AbortController()
    const check = () => { if (document.visibilityState === 'visible') void refresh(controller.signal) }
    void refresh(controller.signal)
    const timer = window.setInterval(check, 2500)
    window.addEventListener('focus', check)
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', check) }
  }, [shared, refresh])

  const local = deliveriesForDate(state.deliveries ?? emptyDeliveries, date)
  const remote = sharedBoard?.date === date ? sharedBoard.board : undefined
  const jobs = shared ? remote?.jobs ?? [] : local.jobs
  const latest = shared ? remote?.latestUpload : local.latestUpload
  const rules = shared ? remote?.rules ?? noRules : noRules
  const team = shared ? { companies: [], drivers: [], coverage: [] } : state.team
  const companies = [...new Set([
    ...dispatchCompanies.map(item => item.name), ...team.companies.filter(item => item.active).map(item => item.name), ...rules.map(rule => rule.company),
  ])].sort(compare)
  const review = screenshot?.rows.map(row => ({ row, ...resolveDelivery(row, date, index, team, rules, dispatch) })) ?? []
  const included = review.filter(item => item.row.kind === 'delivery')
  const unclear = review.filter(item => item.row.kind === 'unclear').length
  const pickups = review.filter(item => item.row.kind === 'pickup').length
  const assigned = jobs.filter(job => job.assigned).length
  const allDone = !!jobs.length && jobs.length === assigned
  const canWrite = !shared || Boolean(remote && !networkError)

  function patchRow(id: string, changes: Partial<DeliveryReviewRow>) {
    setScreenshot(current => current && { ...current, rows: current.rows.map(row => row.id === id ? { ...row, ...changes } : row) })
    setError('')
  }

  async function readPhoto(file: File) {
    if (screenshot && !confirm('Replace the screenshot and its unsaved review?')) return
    setError('')
    setMessage('')
    if (!file.size || file.size > 20 * 1024 * 1024 || (file.type && !file.type.startsWith('image/') && !/\.hei[cf]$/i.test(file.name))
      || file.type === 'image/svg+xml' || /\.svgz?$/i.test(file.name)) {
      setError('Choose a screenshot image such as PNG or JPEG, up to 20 MB.')
      return
    }
    setReading(true)
    setProgress('Preparing image…')
    const draft = { id: uid(), name: file.name, url: '', rows: [] }
    setScreenshot(draft)
    try {
      const photo = await browserReadablePhoto(file, file.name)
      const preview = { ...draft, url: URL.createObjectURL(photo) }
      setScreenshot(preview)
      const result = await recognizeImage(photo, setProgress, text => deliveryRows(text, state.referencePrefix)
        .every(row => !row.orderRef || (!row.postcode && !row.postcodeChoices?.length)))
      const rows = deliveryRows(result.text, state.referencePrefix, result.detail)
      setScreenshot({ ...preview, rows, confidence: result.confidence })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not read the screenshot.')
    } finally {
      setReading(false)
      setProgress('')
      requestAnimationFrame(() => previewHeading.current?.focus())
    }
  }

  async function save() {
    if (!screenshot || reading || busy) return
    if (unclear) { setError('Choose Delivery, Pickup or Exclude for each unclear row.'); return }
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const upload = readDeliveryUpload({
        id: screenshot.id, date, rows: included.map(item => ({
          id: item.row.id, orderRef: item.row.orderRef, postcode: item.row.postcode, route: item.route, company: item.company,
        })),
      })
      let saved: SavedDeliveryUpload | undefined
      if (shared) {
        saved = await uploadWorkplace(upload)
        await refresh()
      } else {
        const committed = await commit(current => {
          const result = saveDeliveryUpload(current.deliveries ?? emptyDeliveries, upload)
          saved = result.saved
          return { ...current, deliveries: result.state }
        })
        if (!committed) return
      }
      if (saved) {
        setMessage(`${saved.added} ${saved.added === 1 ? 'delivery' : 'deliveries'} added${saved.duplicates ? ` · ${saved.duplicates} already on this date` : ''}.`)
        setScreenshot(undefined)
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save the delivery checklist.')
    } finally { setBusy(false) }
  }

  async function setAssigned(job: DeliveryJob, value: boolean) {
    setPending(current => ({ ...current, [job.id]: value }))
    setError('')
    try {
      if (shared) {
        await assignWorkplace(job.id, value)
        await refresh()
      } else {
        await commit(current => ({ ...current, deliveries: setDeliveryAssigned(current.deliveries ?? emptyDeliveries, job.id, value) }))
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Assignment could not be saved.') }
    finally {
      setPending(current => {
        const next = { ...current }
        delete next[job.id]
        return next
      })
    }
  }

  return <div className="delivery-board">
    <Heading title="Delivery checklist" action={<span className="tag">{shared ? 'Warehouse network' : 'This browser'}</span>}>
      Upload the warehouse screenshot, review the deliveries and tick each one as you assign it.
    </Heading>
    <div className="stack">
      <section className="panel content-panel">
        <div className="section-heading">
          <div><h2>Screenshot</h2>
            <p>{latest ? <>Last upload <time dateTime={latest.uploadedAt}>{atDepot.format(new Date(latest.uploadedAt))}</time> · Delivery date <strong>{formatDate(`${latest.date}T12:00:00Z`)}</strong></> : 'No saved upload yet.'}</p></div>
          <FilePicker label="Upload screenshot" accept="image/*,.heic,.heif" disabled={reading || busy} onFiles={files => { void readPhoto(files[0]) }}/>
        </div>
        {progress && <p role="status">{progress}</p>}
        {error && <p className="notice warning" role="alert">{error}</p>}
        {message && <p className="notice success" role="status">{message}</p>}
        {networkError && <p className="notice warning" role="alert">{networkError} <button className="text-button" onClick={() => { void refresh() }}>Retry</button></p>}
      </section>
      <section className="panel content-panel delivery-day">
        <label>Delivery date<input type="date" required value={date} disabled={busy || reading}
          onChange={event => { if (event.target.value) setDate(event.target.value) }}/></label>
        <span className="tag">{dayName(date)}</span>
      </section>
      {screenshot && <section className="panel content-panel delivery-review">
        <div className="section-heading"><div><h2 ref={previewHeading} tabIndex={-1}>Review screenshot</h2>
          <p>{screenshot.name}{screenshot.confidence !== undefined && ` · ${screenshot.confidence}% reading confidence`}</p></div>
          {!reading && <button className="text-button" disabled={busy} onClick={() => {
            if (confirm('Discard the unsaved screenshot review?')) { setScreenshot(undefined); setError('') }
          }}>Discard review</button>}</div>
        {screenshot.url && <details className="mapping">
          <summary><strong>Original screenshot</strong></summary>
          <div className="mapping-body"><div className="photo"><img src={screenshot.url} alt={`Original screenshot ${screenshot.name}`}/></div></div>
        </details>}
        {!reading && <>
          <p className="stat-line"><strong>{included.length} {included.length === 1 ? 'delivery' : 'deliveries'}</strong>
            <span>{pickups} pickup {pickups === 1 ? 'row' : 'rows'} skipped</span>{unclear > 0 && <span>{unclear} need a type</span>}</p>
          {!review.length && <p>Add a row from the screenshot if the columns were unreadable.</p>}
          {review.map(({ row, route, routes, company, companies: hints, dispatch: allocation }) => <article key={row.id} className="delivery-edit">
            <div className="section-heading"><h3>{row.orderRef || 'Check order reference'}</h3>
              {row.kind === 'pickup' && <span className="tag">Pickup · skipped</span>}
              {row.kind === 'exclude' && <span className="tag">Excluded</span>}</div>
            <div className="form-grid">
              <label>Row type<select value={row.kind} disabled={busy} onChange={event => patchRow(row.id, { kind: event.target.value as DeliveryKind })}>
                <option value="unclear">Choose type</option><option value="delivery">Delivery</option>
                <option value="pickup">Pickup</option><option value="exclude">Exclude</option>
              </select></label>
              {(row.kind === 'delivery' || row.kind === 'unclear') && <>
                <label>Order reference<input value={row.orderRef} maxLength={80} disabled={busy}
                  onChange={event => patchRow(row.id, { orderRef: event.target.value })}/></label>
                <label>Full postcode<input value={row.postcode} maxLength={20} disabled={busy} autoCapitalize="characters" autoComplete="off" spellCheck={false}
                  onChange={event => patchRow(row.id, { postcode: event.target.value, route: undefined, company: undefined })}/></label>
                {Boolean(row.postcodeChoices?.length) && <label>Postcodes on label<select disabled={busy}
                  value={row.postcodeChoices!.includes(row.postcode) ? row.postcode : ''}
                  onChange={event => patchRow(row.id, { postcode: event.target.value, route: undefined, company: undefined })}>
                  <option value="">Choose the delivery postcode</option>
                  {row.postcodeChoices!.map(postcode => <option value={postcode} key={postcode}>
                    {postcode}{row.postcodeCorrections?.includes(postcode) ? ' · check OCR' : ''}
                  </option>)}
                </select></label>}
                <label>Route<select value={row.route ?? 'auto'} disabled={busy} onChange={event => patchRow(row.id, {
                  route: event.target.value === 'auto' ? undefined : event.target.value, company: undefined,
                })}>
                  <option value="auto">{route ? `Matched Route ${route}` : routes.length > 1 ? 'Route conflict · choose below' : 'Route unassigned'}</option>
                  <option value="">Leave unassigned</option>
                  {[...index.routes.keys()].map(item => <option value={item} key={item}>Route {item}{routes.includes(item) ? ' · candidate' : ''}</option>)}
                </select></label>
                <label>Company<select value={row.company === undefined ? 'auto' : `company:${row.company}`} disabled={busy || !route} onChange={event => patchRow(row.id, {
                  company: event.target.value === 'auto' ? undefined : event.target.value.slice('company:'.length),
                })}>
                  <option value="auto">{company ? `Suggested ${company}` : hints.length > 1 ? 'Company conflict · choose below' : 'Company unassigned'}</option>
                  <option value="company:">Leave unassigned</option>
                  {companies.map(item => <option key={item} value={`company:${item}`}>{item}</option>)}
                </select></label>
              </>}
            </div>
            {row.kind === 'delivery' && allocation && <p className="field-hint">{allocation.wave} · {allocation.times.join(' / ')}</p>}
            {row.kind === 'delivery' && routes.length > 1 && <p className="field-hint">Postcode conflict · {routeNames(routes)}</p>}
            {row.kind === 'delivery' && hints.length > 1 && <p className="field-hint">Company candidates · {hints.join(', ')}</p>}
            {row.raw && <details className="mapping"><summary>Extracted row</summary><div className="mapping-body"><pre>{row.raw}</pre></div></details>}
          </article>)}
          <div className="actions">
            <button className="button secondary" disabled={busy} onClick={() =>
              setScreenshot(current => current && { ...current, rows: [...current.rows, blankDeliveryRow()] })}>Add review row</button>
            <button className="button primary" disabled={busy || !included.length || !canWrite} onClick={() => { void save() }}>
              <Icon name="check" size={18}/> Save to checklist
            </button>
          </div>
        </>}
      </section>}
      <section className="panel content-panel delivery-summary">
        <div className="section-heading"><div><h2>Assignments</h2><p aria-live="polite">{assigned} of {jobs.length} assigned</p></div>
        {jobs.length > 0 && <button className="button secondary" onClick={() => {
          const sorted = [...jobs].sort((a, b) => compare(a.company, b.company) || compare(a.route, b.route) || compare(a.orderRef, b.orderRef))
          download(`deliveries-${date}.csv`, csv([['Company', 'Route', 'Order reference', 'Postcode', 'Delivery date', 'Status'],
            ...sorted.map(job => [job.company, job.route, job.orderRef, job.postcode, job.date, job.assigned ? 'Assigned' : 'To assign'])]), 'text/csv;charset=utf-8')
        }}>Export checklist</button>}</div>
        {jobs.length > 0 ? <>
          <progress className="delivery-progress" aria-label="Assignments completed" value={assigned} max={jobs.length}/>
          {allDone && <p className="delivery-complete" role="status"><span><Icon name="check" size={20}/></span> All deliveries assigned</p>}
        </> : <p>{shared && !remote && !networkError ? 'Loading checklist…' : 'No deliveries for this date.'}</p>}
      </section>
      <DeliveryGroups jobs={jobs} pending={pending} change={(job, value) => { void setAssigned(job, value) }}/>
    </div>
  </div>
}

import { useEffect, useState, type ChangeEvent } from 'react'
import { recognizeImage } from '../domain/ocr'
import {
  approveDraft, groupedPickups, newDraft, newJob, parsePickupText, pickupCsv, pickupFields, previewPickups,
  type Draft, type PickupJob, type PickupSource,
} from '../domain/pickups'
import { buildIndex, type RouteIndex } from '../domain/routes'
import { mapRows, spreadsheetDate } from '../domain/spreadsheets'
import { companyName, driverName, type Team } from '../domain/team'
import { download, uid } from '../domain/util'
import type { WorkspaceRepository } from '../storage/repository'
import type { Commit } from '../storage/useWorkspace'
import { activeDataset, undoApproval, type Workspace } from '../storage/workspace'
import { CopyButton, FilePicker, formatDate, Heading, Icon, ProblemList, routeNames } from './shared'
import { Spreadsheet } from './Spreadsheet'

type Review = ReturnType<typeof previewPickups>[number]
type Patch = (job: PickupJob, changes: Partial<PickupJob>) => void

function Photo({ source, repository }: { source: PickupSource; repository: WorkspaceRepository }) {
  const [url, setUrl] = useState('')
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let active = true
    let imageUrl = ''
    void repository.getImage(source.id).then(blob => {
      if (!active) return
      if (blob) {
        imageUrl = URL.createObjectURL(blob)
        setUrl(imageUrl)
      } else setMissing(true)
    }).catch(() => { if (active) setMissing(true) })
    return () => { active = false; if (imageUrl) URL.revokeObjectURL(imageUrl) }
  }, [repository, source.id])
  return url ? <div className="photo"><img src={url} alt={`Source image ${source.name}`}/></div>
    : missing ? <p>Source image unavailable.</p> : null
}

function FieldInput({ label, value, change }: { label: string; value: string; change: (value: string) => void }) {
  // Keep the current keystroke visible while the draft is committed.
  return <label>{label}<input defaultValue={value} onChange={event => change(event.target.value)}/></label>
}

function JobEditor({ item, position, index, team, patch, remove, source, repository }: {
  item: Review; position: number; index: RouteIndex; team: Team; patch: Patch; remove: () => void;
  source?: PickupSource; repository: WorkspaceRepository
}) {
  const { job } = item
  const driverCompany = job.companyId || item.company
  const drivers = team.drivers.filter(driver => driver.active && driver.companyId === driverCompany)
  return <article className="panel content-panel job-editor">
    <div className="section-heading"><div><h3>{job.orderRef || `Pickup ${position + 1}`}</h3>
      <p>{item.route ? `Route ${item.route}` : item.routes.length > 1 ? routeNames(item.routes) : 'No route'}
      {item.sector && ` · ${item.sector}`}{item.company && ` · ${companyName(team, item.company)}`}{item.driver && ` · ${driverName(team, item.driver)}`}</p></div>
      <span className={`tag ${item.issues.length || item.duplicate || !item.driver ? 'warning' : ''}`}>{item.duplicate ? 'Duplicate' : item.issues.length ? 'Needs review' : item.driver ? 'Matched' : 'Unassigned driver'}</span>
    </div>
    {!!item.issues.length && <p className="field-hint">{item.issues.join(' · ')}</p>}
    <div className="form-grid">
      <FieldInput label="Order reference" value={job.orderRef} change={orderRef => patch(job, { orderRef })}/>
      <FieldInput label="Full postcode" value={job.postcode} change={postcode => patch(job, { postcode })}/>
      <FieldInput label="Notes" value={job.notes} change={notes => patch(job, { notes })}/>
      {item.duplicate && <FieldInput label="Reason to keep duplicate" value={job.duplicateReason} change={duplicateReason => patch(job, { duplicateReason })}/>}
    </div>
    {item.suggestions.conflict && <p className="notice warning">Conflicting coverage · {item.suggestions.matches.map(match =>
      [companyName(team, match.companyId), driverName(team, match.driverId)].filter(Boolean).join(' / ')).join(', ')}</p>}
    {source && <details className="mapping job-source">
      <summary><strong>Source and extracted text</strong><span>{job.confidence === undefined ? source.kind : `${job.confidence}% OCR confidence`}</span></summary>
      <div className="mapping-body"><p>{source.name}</p>{job.sourceText && <pre>{job.sourceText}</pre>}
        {source.kind === 'image' && <Photo source={source} repository={repository}/>}</div>
    </details>}
    {source && <label className="check"><input type="checkbox" key={String(job.checked)} defaultChecked={job.checked}
      onChange={event => patch(job, { checked: event.target.checked })}/> Reference and postcode checked against the source</label>}
    <details className="mapping job-source">
      <summary><strong>Override assignment</strong><span>{item.manual ? 'Override set' : 'Optional'}</span></summary>
      <div className="mapping-body form-grid">
        <label>Route<select value={job.route} onChange={event => patch(job, { route: event.target.value })}>
          <option value="">Use matching route</option>
          {job.route && !index.routes.has(job.route) && <option value={job.route}>{job.route} · retired</option>}
          {[...index.routes.keys()].map(id => <option value={id} key={id}>Route {id}{item.routes.includes(id) ? ' · candidate' : ''}</option>)}
        </select></label>
        <label>Company<select value={job.companyId} onChange={event => patch(job, { companyId: event.target.value, driverId: '' })}>
          <option value="">Use approved coverage</option>{job.companyId && !team.companies.some(company => company.active && company.id === job.companyId) && <option value={job.companyId}>Company inactive</option>}
          {team.companies.filter(company => company.active).map(company => <option value={company.id} key={company.id}>{company.name}</option>)}
        </select></label>
        <label>Driver<select value={job.driverId} onChange={event => patch(job, { driverId: event.target.value })}>
          <option value="">Use approved coverage</option>{job.driverId && !drivers.some(driver => driver.id === job.driverId) && <option value={job.driverId}>Driver unavailable</option>}
          {drivers.map(driver => <option value={driver.id} key={driver.id}>{driver.name}</option>)}
        </select></label>
        <FieldInput label="Override reason" value={job.reason} change={reason => patch(job, { reason })}/>
      </div>
    </details>
    <button className="text-button danger" type="button" onClick={remove}>Remove pickup</button>
  </article>
}

export function Pickups({ state, index, repository, commit }: { state: Workspace; index: RouteIndex; repository: WorkspaceRepository; commit: Commit }) {
  const { draft, team } = state
  const approved = state.approvals.at(-1)
  const approvedJobs = approved?.jobs ?? []
  const [mode, setMode] = useState<'draft' | 'approved'>('draft')
  const [importMode, setImportMode] = useState<'sheet' | 'text' | ''>('')
  const [text, setText] = useState('')
  const [showPreview, setShowPreview] = useState(false)
  const [acceptUnassigned, setAcceptUnassigned] = useState(false)
  const [progress, setProgress] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [approvalFilter, setApprovalFilter] = useState('')
  const review = previewPickups(draft, approvedJobs, index, team)
  const version = activeDataset(state).id
  const hasSavedPhotos = draft.sources.some(source => source.kind === 'image')
  const reading = Boolean(progress)

  function updateDraft(change: (draft: Draft) => Draft) {
    setShowPreview(false)
    setAcceptUnassigned(false)
    return commit(current => {
      if (current.draft.id !== draft.id) throw new Error('This batch changed in another tab. Review the current draft.')
      return { ...current, draft: change(current.draft) }
    })
  }
  const patch: Patch = (job, changes) => {
    void updateDraft(current => ({ ...current, jobs: current.jobs.map(item => item.id === job.id ? { ...item, ...changes } : item) }))
  }
  async function addJobs(jobs: PickupJob[], source?: PickupSource) {
    return updateDraft(current => ({
      ...current, jobs: [...current.jobs, ...jobs], sources: source ? [...current.sources, source] : current.sources,
    }))
  }
  async function readPhoto(source: PickupSource, blob: Blob) {
    setProgress('Preparing image reading…')
    const saveSource = (status: 'ready' | 'failed', jobs: PickupJob[], problem?: string) => updateDraft(current => {
      const pending = current.sources.find(item => item.id === source.id && item.attempt === source.attempt && item.status === 'reading')
      return pending ? { ...current,
        sources: current.sources.map(item => item.id === source.id ? { ...item, status, error: problem } : item),
        jobs: [...current.jobs, ...jobs],
      } : current
    })
    try {
      const result = await recognizeImage(blob, setProgress)
      if (!result.text.trim()) throw new Error('No text extracted. Try a clearer image, paste text or add a row.')
      const jobs = parsePickupText(result.text, source.id, state.referencePrefix, result.confidence)
      await saveSource('ready', jobs)
    } catch (failure) {
      await saveSource('failed', [], failure instanceof Error ? failure.message : 'Could not read image.')
    } finally { setProgress('') }
  }
  async function uploadPhotos(files: File[]) {
    setError('')
    setBusy(true)
    for (const file of files) {
      try {
        if (!file.size || file.size > 20 * 1024 * 1024 || (file.type && !file.type.startsWith('image/'))) throw new Error('Choose an image up to 20 MB.')
        const source: PickupSource = { id: uid(), kind: 'image', name: file.name, status: 'reading', attempt: uid() }
        await repository.putImage(source.id, file)
        if (await addJobs([], source)) await readPhoto(source, file)
      } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not keep the image.') }
    }
    setBusy(false)
  }
  async function retry(source: PickupSource) {
    setBusy(true)
    setError('')
    try {
      const blob = await repository.getImage(source.id)
      if (!blob) throw new Error('Source image unavailable. Upload the image again.')
      const pending = { ...source, status: 'reading' as const, error: undefined, attempt: uid() }
      const saved = await updateDraft(current => ({ ...current, sources: current.sources.map(item => item.id === source.id ? pending : item) }))
      if (saved) await readPhoto(pending, blob)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not reopen the image.') }
    setBusy(false)
  }
  async function approve() {
    setBusy(true)
    const saved = await commit(current => {
      if (current.revision !== state.revision) throw new Error('Data changed. Review the current assignments before approving.')
      const snapshot = approveDraft(current.draft, current.approvals.at(-1), buildIndex(activeDataset(current)), current.team, activeDataset(current).id, acceptUnassigned)
      return { ...current, draft: { ...newDraft(), date: current.draft.date, shift: current.draft.shift }, approvals: [...current.approvals, snapshot] }
    })
    if (saved) {
      setMode('approved')
      setShowPreview(false)
      setAcceptUnassigned(false)
      setMessage('Pickup assignments approved and saved.')
    }
    setBusy(false)
  }
  const filteredApproved = approvedJobs.filter(job => !approvalFilter || job.date === approvalFilter)
  const groups = groupedPickups(filteredApproved)
  const exportMessage = [...groups].map(([group, jobs]) => `${group}\n${jobs.map(job => `${job.orderRef} · ${job.postcode}`).join('\n')}`).join('\n\n')
  return <>
    <Heading title="Pickups">Import pickup jobs, check the postcode and approve dispatch assignments.</Heading>
    <div className="segmented" aria-label="Pickup section">
      <button type="button" aria-pressed={mode === 'draft'} onClick={() => setMode('draft')}>Draft pickups</button>
      <button type="button" aria-pressed={mode === 'approved'} onClick={() => setMode('approved')}>Approved pickups</button>
    </div>
    {message && <p className="notice success" role="status">{message}</p>}
    {error && <p className="notice warning" role="alert">{error}</p>}
    {mode === 'draft' ? <div className="stack">
      <section className="panel content-panel">
        <h2>Import pickups</h2>
        <div className="actions">
          <FilePicker label="Upload screenshots or photos" accept="image/*" multiple disabled={busy} onFiles={files => { void uploadPhotos(files) }}/>
          <FilePicker label="Take photo" accept="image/*" capture="environment" disabled={busy} onFiles={files => { void uploadPhotos(files) }}/>
          <button className="button secondary" onClick={() => setImportMode(value => value === 'sheet' ? '' : 'sheet')}>Import spreadsheet</button>
          <button className="button secondary" onClick={() => setImportMode(value => value === 'text' ? '' : 'text')}>Paste text</button>
          <button className="button secondary" onClick={() => { void addJobs([newJob()]) }}><Icon name="plus" size={18}/> Add pickup row</button>
        </div>
        {progress && <p role="status">{progress}</p>}
        {importMode === 'text' && <div className="import-preview">
          <label>Pickup text<textarea rows={4} value={text} onChange={event => setText(event.target.value)}/></label>
          <button className="button primary" disabled={!text.trim() || busy} onClick={async () => {
            const source: PickupSource = { id: uid(), name: 'Pasted text', kind: 'text', status: 'ready' }
            const jobs = parsePickupText(text, source.id, state.referencePrefix)
            if (!jobs.length) { setError('No pickup rows detected. Paste the rows or add one manually.'); return }
            if (await addJobs(jobs, source)) { setText(''); setImportMode(''); setError('') }
          }}>Review pasted rows</button>
        </div>}
        {importMode === 'sheet' && <Spreadsheet fields={pickupFields} label="Upload pickup spreadsheet">
          {file => {
            const mapped = mapRows(file.sheets, file.mappings, pickupFields)
            return <div className="import-preview"><ProblemList errors={mapped.errors}/>
              <h3>{mapped.rows.length} pickup rows</h3>
              <button className="button primary" disabled={!!mapped.errors.length || busy} onClick={async () => {
                const source: PickupSource = { id: uid(), name: file.name, kind: 'sheet', status: 'ready' }
                const jobs = mapped.rows.map(row => newJob({
                  orderRef: row.values.reference, postcode: row.values.postcode, notes: row.values.notes,
                  sourceId: source.id, sourceText: `${row.sheet.trim()}, row ${row.row}: ${[row.values.reference, row.values.postcode, row.values.notes].filter(Boolean).join(' · ')}`,
                  checked: false,
                }))
                if (await addJobs(jobs, source)) setImportMode('')
              }}>Review imported pickups</button>
            </div>
          }}
        </Spreadsheet>}
        <details className="mapping job-source"><summary><strong>Order reference settings</strong></summary>
          <div className="mapping-body">
            <form onSubmit={async event => {
              event.preventDefault()
              const prefix = String(new FormData(event.currentTarget).get('prefix') ?? '').trim().toUpperCase()
              if (prefix && !/^[A-Z0-9-]{1,24}$/.test(prefix)) { setError('Use up to 24 letters, numbers or hyphens for the order prefix.'); return }
              if (await commit(current => ({ ...current, referencePrefix: prefix }))) { setError(''); setMessage('Order reference settings saved.') }
            }}><label>Order reference prefix<input name="prefix" maxLength={24} defaultValue={state.referencePrefix}/></label>
            <p className="field-hint">Leave blank to enter order references by hand.</p>
            <button type="submit" className="button secondary">Save reference prefix</button></form>
          </div>
        </details>
        {hasSavedPhotos && <div className="source-grid">{draft.sources.filter(source => source.kind === 'image').map(source =>
          <article key={source.id} className="source-card">
            <Photo source={source} repository={repository}/><strong>{source.name}</strong>
            <p>{source.status === 'ready' ? 'Text extracted' : source.status === 'failed' ? source.error : reading ? 'Reading image' : 'Image reading interrupted'}</p>
            <button className="text-button" type="button" onClick={() => { void addJobs([newJob({ sourceId: source.id, checked: false })]) }}>Add row from this image</button>
            {source.status !== 'ready' && !busy && <>
              <button type="button" className="button secondary" onClick={() => { void retry(source) }}>Retry image reading</button>
              {source.status === 'reading' && <button type="button" className="text-button" onClick={() => { void updateDraft(current => ({
                ...current, sources: current.sources.map(item => item.id === source.id ? { ...item, status: 'failed', error: 'Ready for manual review.' } : item),
              })) }}>Use manual review</button>}
            </>}
          </article>)}</div>}
      </section>
      <section className="panel content-panel">
        <div className="section-heading"><div><h2>Pickup batch</h2><p>{draft.jobs.length} {draft.jobs.length === 1 ? 'job' : 'jobs'} in review</p></div>
          {(draft.jobs.length > 0 || draft.sources.length > 0) && <button className="text-button danger" disabled={busy} onClick={async () => {
            if (confirm('Clear this draft and its source links? Approved pickups will be kept.')) await updateDraft(() => newDraft())
          }}>Clear draft</button>}</div>
        <div className="form-grid" key={draft.id}>
          <label>Pickup date<input type="date" defaultValue={draft.date} onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const date = event.target.value
            void updateDraft(current => ({ ...current, date }))
          }}/></label>
          <FieldInput label="Pickup shift (optional)" value={draft.shift} change={shift => { void updateDraft(current => ({ ...current, shift })) }}/>
        </div>
      </section>
      {review.map((item, position) => <JobEditor key={item.job.id} item={item} position={position} index={index} team={team} patch={patch}
        source={draft.sources.find(source => source.id === item.job.sourceId)} repository={repository}
        remove={() => { if (confirm('Remove this pickup from the draft?')) void updateDraft(current => ({ ...current, jobs: current.jobs.filter(job => job.id !== item.job.id) })) }}/>)}
      {!!review.length && <section className="panel content-panel">
        <button className="button primary" disabled={busy} onClick={() => { setShowPreview(true); setAcceptUnassigned(false) }}>Preview assignments</button>
        {showPreview && <div className="import-preview">
          <h2>Assignment preview</h2>
          <div className="stat-line"><strong>{review.filter(item => !!item.route).length} route matches</strong>
            <span>{review.filter(item => item.issues.length).length} need review</span><span>{review.filter(item => !item.driver).length} unassigned drivers</span>
            <span>{review.filter(item => item.duplicate).length} duplicate rows</span></div>
          <ul className="record-list">{review.map(item => <li key={item.job.id}><div>
            <strong>{item.job.orderRef || 'Missing reference'} · {item.postcode?.key ?? 'Check postcode'}</strong>
            <small>Proposed · {[item.route ? `Route ${item.route}` : 'No route', companyName(team, item.company) || 'Unassigned company',
              driverName(team, item.driver) || 'Unassigned driver'].join(' · ')}</small>
            {item.previous.length ? item.previous.map(job => <small key={job.id}>Previously approved · {job.route ? `Route ${job.route}` : 'No route'} · {job.company || 'Unassigned company'} · {job.driver || 'Unassigned driver'}</small>)
              : <small>Previous · no approved pickup for this date and shift</small>}
            {!!item.issues.length && <small>{item.issues.join(' · ')}</small>}
          </div></li>)}</ul>
          {review.some(item => !item.route || !item.driver || item.issues.length) && <label className="check">
            <input type="checkbox" checked={acceptUnassigned} onChange={event => setAcceptUnassigned(event.target.checked)}/> Save jobs with unresolved assignments for follow-up</label>}
          <button className="button primary" disabled={busy || !spreadsheetDate(draft.date)} onClick={() => { void approve() }}><Icon name="check" size={18}/> Approve &amp; save</button>
        </div>}
      </section>}
    </div> : <div className="stack">
      <section className="panel content-panel">
        <div className="section-heading"><div><h2>Approved pickups</h2>
          <p>{approvedJobs.length} saved {approvedJobs.length === 1 ? 'job' : 'jobs'}</p></div>
          {approved && !approved.undoOf && <button className="button secondary" disabled={busy} onClick={async () => {
            if (!confirm('Undo the latest approval and restore the previous snapshot?')) return
            if (await commit(current => {
              if (current.approvals.at(-1)?.id !== approved.id) throw new Error('Approvals changed. Review the latest snapshot.')
              return undoApproval(current)
            })) setMessage('Previous approved pickup snapshot restored.')
          }}>Undo latest approval</button>}</div>
        <label className="team-filter">Filter by pickup date<input type="date" value={approvalFilter} onChange={event => setApprovalFilter(event.target.value)}/></label>
        {!!filteredApproved.length && <div className="actions"><CopyButton text={exportMessage} label="Copy WhatsApp text"/>
          <button className="button secondary" onClick={() => download('manchester-approved-pickups.csv', pickupCsv(filteredApproved), 'text/csv;charset=utf-8')}>Export pickup CSV</button></div>}
        {!filteredApproved.length && <p>No approved pickups for this view.</p>}
      </section>
      {[...groups].map(([group, jobs]) => <section className="panel content-panel" key={group}><h2>{group}</h2>
        <ul className="record-list">{jobs.map(job => {
          const historical = job.datasetId !== version
          const retired = job.route && !index.routes.has(job.route)
          return <li key={job.id}><div><strong>{job.orderRef} · {job.postcode}</strong><small>{formatDate(job.date)}{job.shift && ` · ${job.shift}`}</small>
            {(historical || retired) && <span className="tag warning">{retired ? 'Historical · retired route' : 'Historical · earlier route version'}</span>}
            {job.notes && <small>{job.notes}</small>}
            {(job.source || job.sourceText) && <details className="mapping job-source">
              <summary><strong>Approved source</strong></summary><div className="mapping-body">
                {job.source && <p>{job.source.name}</p>}{job.sourceText && <pre>{job.sourceText}</pre>}
                {job.source?.kind === 'image' && <Photo repository={repository} source={job.source}/>}</div>
            </details>}
          </div></li>
        })}</ul>
      </section>)}
      {!!state.approvals.length && <details className="panel content-panel">
        <summary><strong>Approval history</strong></summary><ul className="record-list">{[...state.approvals].reverse().map(snapshot =>
          <li key={snapshot.id}><div><strong>{snapshot.undoOf ? 'Restored snapshot' : 'Approved pickups'}</strong>
            <small>{formatDate(snapshot.at)} · {snapshot.jobs.length} jobs in snapshot</small></div>
            {snapshot.id === approved?.id ? <span className="tag">Current</span> : <button className="button secondary" onClick={async () => {
              if (!confirm('Restore this approved pickup snapshot?')) return
              if (await commit(current => {
                if (current.approvals.at(-1)?.id !== approved?.id) throw new Error('Approvals changed. Reopen the snapshot history.')
                return { ...current, approvals: [...current.approvals, { ...snapshot, id: uid(), at: new Date().toISOString(),
                  previousId: approved?.id, undoOf: approved?.id }] }
              })) setMessage('Selected pickup snapshot restored.')
            }}>Restore snapshot</button>}</li>)}</ul>
      </details>}
    </div>}
  </>
}

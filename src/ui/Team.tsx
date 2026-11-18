import { useState, type FormEvent, type ReactNode } from 'react'
import { compare, type RouteIndex } from '../domain/routes'
import { mapRows, spreadsheetDate } from '../domain/spreadsheets'
import {
  companyName, coverageInput, coverageReferences, driverName, overlaps, prepareTeamImport, splitValues,
  teamFields, validateCompany, validateDriver, type Company, type Coverage, type Driver, type Team as TeamData, type TeamImportKind,
} from '../domain/team'
import { csv, download, today, uid } from '../domain/util'
import { activeDataset, recordTeam, undoTeam, type Workspace } from '../storage/workspace'
import type { Commit } from '../storage/useWorkspace'
import { Heading, Icon, ProblemList, formatDate } from './shared'
import { Spreadsheet } from './Spreadsheet'

const labels = { companies: 'Companies', drivers: 'Drivers', coverage: 'Coverage' }
const singular = { companies: 'company', drivers: 'driver', coverage: 'coverage' }
type TeamRecord = Company | Driver | Coverage
type Edit = { kind: TeamImportKind; id?: string }
const formValue = (form: FormData, name: string) => String(form.get(name) ?? '').trim()

function TeamEditor({ edit, team, index, busy, save, cancel }: {
  edit: Edit; team: TeamData; index: RouteIndex; busy: boolean; save: (item: TeamRecord) => void; cancel: () => void
}) {
  const [error, setError] = useState('')
  const existingCompany = edit.kind === 'companies' ? team.companies.find(item => item.id === edit.id) : undefined
  const existingDriver = edit.kind === 'drivers' ? team.drivers.find(item => item.id === edit.id) : undefined
  const existingCoverage = edit.kind === 'coverage' ? team.coverage.find(item => item.id === edit.id) : undefined
  const existing = existingCompany ?? existingDriver ?? existingCoverage
  const [companyId, setCompanyId] = useState(existingDriver?.companyId ?? existingCoverage?.companyId ?? '')
  const [daily, setDaily] = useState(Boolean(existingCoverage ? existingCoverage.date : true))
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const id = edit.id ?? uid()
    const active = fields.has('active')
    const notes = formValue(fields, 'notes')
    if (edit.kind === 'companies') {
      const company: Company = { id, active, notes, name: formValue(fields, 'name'), aliases: splitValues(formValue(fields, 'aliases')) }
      const problem = validateCompany(team, company)
      if (problem) setError(problem)
      else save(company)
    } else if (edit.kind === 'drivers') {
      const driver: Driver = { id, active, notes, name: formValue(fields, 'name'), companyId }
      const problem = validateDriver(team, driver)
      if (problem) setError(problem)
      else save(driver)
    } else {
      const selections = coverageInput(index, formValue(fields, 'routes'), formValue(fields, 'sectors'))
      const keepingInactive = Boolean(existingCoverage && !active)
      const date = daily ? spreadsheetDate(formValue(fields, 'date')) : ''
      const driverId = daily ? formValue(fields, 'driver') : ''
      const eligibleCompany = team.companies.some(company => company.id === companyId && company.active)
      const eligibleDriver = !driverId || team.drivers.some(driver => driver.id === driverId && driver.companyId === companyId && driver.active)
      if (!keepingInactive && (selections.errors.length || !eligibleCompany || !eligibleDriver || (daily && !date))) {
        setError(selections.errors.join('. ') || 'Check the company, driver and date.')
        return
      }
      const item: Coverage = {
        id, active, notes, date: date ?? '', companyId, driverId, shift: daily ? formValue(fields, 'shift') : '',
        routes: keepingInactive ? existingCoverage!.routes : selections.routes,
        sectors: keepingInactive ? existingCoverage!.sectors : selections.sectors,
        approved: fields.has('approved'), source: existingCoverage?.source ?? 'Manual entry',
      }
      const conflict = item.approved && team.coverage.some(other => other.approved && overlaps(other, item, index))
      if (conflict && !notes) setError('Enter a reason in Notes to approve overlapping coverage.')
      else if (!conflict || confirm('Approve this overlapping allocation? Pickups will flag any coverage conflict.')) save(item)
    }
  }
  const companies = team.companies.filter(company => company.active || company.id === companyId)
  const drivers = team.drivers.filter(driver => driver.companyId === companyId && (driver.active || driver.id === existingCoverage?.driverId))
  const missing = existingCoverage ? coverageReferences(existingCoverage, index, team) : []
  return <form className="panel content-panel editor" onSubmit={submit}>
    <h2>{edit.id ? 'Edit' : 'Add'} {singular[edit.kind]}</h2>
    {error && <p className="notice warning" role="alert">{error}</p>}
    {!!missing.length && <p className="notice warning">{missing.join(' · ')}</p>}
    <div className="form-grid">
      {edit.kind !== 'coverage' && <label>{edit.kind === 'companies' ? 'Company name' : 'Driver name'}
        <input name="name" required maxLength={120} defaultValue={existingCompany?.name ?? existingDriver?.name}/></label>}
      {edit.kind === 'companies' && <label>Aliases <span className="muted">(comma-separated)</span>
        <input name="aliases" defaultValue={existingCompany?.aliases.join(', ')}/></label>}
      {edit.kind !== 'companies' && <label>Company<select name="company" required value={companyId} onChange={event => setCompanyId(event.target.value)}>
        <option value="">Choose company</option>{companies.map(company => <option key={company.id} value={company.id}>{company.name}{company.active ? '' : ' · inactive'}</option>)}
      </select></label>}
      {edit.kind === 'coverage' && <>
        <label>Coverage type<select value={daily ? 'daily' : 'general'} onChange={event => setDaily(event.target.value === 'daily')}>
          <option value="daily">Daily allocation</option><option value="general">General company coverage</option>
        </select></label>
        {daily && <>
          <label>Date<input type="date" name="date" defaultValue={existingCoverage?.date || today()}/></label>
          <label>Shift <span className="muted">(optional)</span><input name="shift" defaultValue={existingCoverage?.shift} placeholder="All shifts"/></label>
          <label>Driver <span className="muted">(optional)</span><select name="driver" key={companyId} defaultValue={existingCoverage?.driverId ?? ''}>
            <option value="">Unassigned</option>{drivers.map(driver => <option key={driver.id} value={driver.id}>{driver.name}{driver.active ? '' : ' · inactive'}</option>)}
          </select></label>
        </>}
        <label>Routes <span className="muted">(comma-separated)</span><input name="routes" defaultValue={existingCoverage?.routes.join(', ')}/></label>
        <label>Postcode sectors <span className="muted">(comma-separated)</span><input name="sectors" defaultValue={existingCoverage?.sectors.join(', ')}/></label>
      </>}
      <label className="wide">Notes<textarea name="notes" defaultValue={existing?.notes} rows={2}/></label>
    </div>
    <label className="check"><input type="checkbox" name="active" defaultChecked={existing?.active ?? true}/> Active</label>
    {edit.kind === 'coverage' && <label className="check"><input type="checkbox" name="approved" defaultChecked={existingCoverage?.approved ?? false}/> Approved coverage</label>}
    <div className="actions"><button className="button primary" disabled={busy}>Save {singular[edit.kind]}</button>
      <button type="button" className="button secondary" onClick={cancel}>Cancel</button></div>
  </form>
}

function CoverageRecord({ item, issues, team, edit }: { item: Coverage; issues: string[]; team: TeamData; edit: ReactNode }) {
  return <li><div>
    <strong>{companyName(team, item.companyId) || 'Missing company'} {item.driverId && <>· {driverName(team, item.driverId) || 'Missing driver'}</>}</strong>
    <small>{item.date ? formatDate(item.date) : 'General company coverage'}{item.shift && ` · ${item.shift}`}{item.date && !item.driverId && ' · Unassigned driver'}</small>
    <small>{[...item.routes.map(id => `Route ${id}`), ...item.sectors].join(' · ')}</small>
    <small>{item.source}{item.notes && ` · ${item.notes}`}</small>
    <div className="record-tags"><span className="tag">{!item.active ? 'Inactive' : item.approved ? 'Approved' : 'Pending approval'}</span>
    {item.active && issues.map(issue => <span className="tag warning" key={issue}>{issue}</span>)}</div>
  </div>{edit}</li>
}

export function Team({ state, index, commit }: { state: Workspace; index: RouteIndex; commit: Commit }) {
  const { team } = state
  const [tab, setTab] = useState<TeamImportKind>('coverage')
  const [edit, setEdit] = useState<Edit>()
  const [filter, setFilter] = useState('')
  const [group, setGroup] = useState('company')
  const [busy, setBusy] = useState(false)
  const [upload, setUpload] = useState(false)
  const [message, setMessage] = useState('')
  function select(value: TeamImportKind) {
    setTab(value)
    setEdit(undefined)
    setUpload(false)
    setFilter('')
  }
  async function update(next: TeamData, label: string) {
    setBusy(true)
    if (await commit(current => {
      if (current.teamChanges.length !== state.teamChanges.length || activeDataset(current).id !== activeDataset(state).id) {
        throw new Error('Team or route data changed. Review the records and try again.')
      }
      return recordTeam(current, next, label)
    })) {
      setEdit(undefined)
      setUpload(false)
      setMessage(label)
    }
    setBusy(false)
  }
  function save(record: TeamRecord) {
    if (!edit) return
    const old = team[edit.kind].find(item => item.id === record.id)
    if (old?.active && !record.active && !confirm('Deactivate this record? Linked allocations may need review.')) return
    const records = old ? team[edit.kind].map(item => item.id === record.id ? record : item) : [...team[edit.kind], record]
    void update({ ...team, [edit.kind]: records }, `${labels[edit.kind]} saved.`)
  }

  const query = filter.trim().toLowerCase()
  const companies = team.companies.filter(company => [company.name, ...company.aliases, company.notes].join(' ').toLowerCase().includes(query))
  const drivers = team.drivers.filter(driver => [driver.name, companyName(team, driver.companyId), driver.notes].join(' ').toLowerCase().includes(query))
  const coverage = team.coverage.filter(item => [companyName(team, item.companyId), driverName(team, item.driverId), item.date, item.shift,
    ...item.routes, ...item.routes.map(id => `route ${id}`), ...item.sectors, item.notes].join(' ').toLowerCase().includes(query))
  const grouped = new Map<string, Coverage[]>()
  for (const item of coverage) {
    if (group === 'unassigned' && (!item.active || item.driverId || !item.date)) continue
    const keys = group === 'route' ? [...item.routes.map(id => `Route ${id}`), ...item.sectors]
      : [group === 'driver' ? driverName(team, item.driverId) || 'Unassigned driver' : companyName(team, item.companyId) || 'Missing company']
    for (const key of keys) {
      const list = grouped.get(key) ?? []
      list.push(item)
      grouped.set(key, list)
    }
  }
  const recordButton = (id: string, kind: TeamImportKind) => <button className="button secondary" onClick={() => {
    setUpload(false)
    setEdit({ kind, id })
  }}>Edit<span className="sr-only"> {singular[kind]}</span></button>
  return <>
    <Heading title="Team" action={<a className="button secondary" href="#/data"><Icon name="data" size={19}/> Data management</a>}>
      Manage companies, drivers and approved dispatch coverage.
    </Heading>
    <div className="segmented" aria-label="Team section">{(Object.keys(labels) as TeamImportKind[]).map(item =>
      <button type="button" key={item} aria-pressed={tab === item} onClick={() => select(item)}>{labels[item]}</button>)}</div>
    {message && <p className="notice success" role="status">{message}</p>}
    <div className="actions team-actions">
      <button className="button primary" onClick={() => { setUpload(false); setEdit({ kind: tab }) }}><Icon name="plus" size={18}/> Add {singular[tab]}</button>
      <button className="button secondary" onClick={() => { setEdit(undefined); setUpload(value => !value) }}>Import {labels[tab].toLowerCase()}</button>
      <button className="button secondary" onClick={() => {
        const rows = tab === 'companies'
          ? [['Company', 'Aliases', 'Active', 'Notes'], ...team.companies.map(item => [item.name, item.aliases.join(', '), String(item.active), item.notes])]
          : tab === 'drivers' ? [['Driver', 'Company', 'Active', 'Notes'], ...team.drivers.map(item => [item.name, companyName(team, item.companyId), String(item.active), item.notes])]
          : [['Company', 'Driver', 'Date', 'Shift', 'Routes', 'Postcode sectors', 'Approved', 'Active', 'Notes'], ...team.coverage.map(item =>
            [companyName(team, item.companyId), driverName(team, item.driverId), item.date, item.shift, item.routes.join(', '), item.sectors.join(', '),
              String(item.approved), String(item.active), item.notes])]
        download(`manchester-${tab}.csv`, csv(rows), 'text/csv;charset=utf-8')
      }}>Export CSV</button>
      {state.teamUndo.length > 0 && <button className="button secondary" disabled={busy} onClick={async () => {
        if (!confirm('Undo the last saved team change?')) return
        setBusy(true)
        const ok = await commit(current => {
          if (current.teamChanges.length !== state.teamChanges.length) throw new Error('Team data changed. Review the latest team edit.')
          return undoTeam(current)
        })
        if (ok) { setEdit(undefined); setMessage('Previous team records restored.') }
        setBusy(false)
      }}>Undo team change</button>}
    </div>
    {edit && <TeamEditor key={`${edit.kind}-${edit.id ?? 'new'}`} edit={edit} team={team} index={index} busy={busy} save={save} cancel={() => setEdit(undefined)}/>}
    {upload && <section className="panel content-panel editor">
      <h2>Import {labels[tab].toLowerCase()}</h2><p>Review additions before saving. Existing records are kept. Imported coverage starts pending approval.</p>
      <Spreadsheet fields={teamFields[tab]} label={`Upload ${tab} spreadsheet`}>
        {file => {
          const mapped = mapRows(file.sheets, file.mappings, teamFields[tab])
          const plan = prepareTeamImport(tab, mapped.rows, team, index, file.name)
          const errors = [...mapped.errors, ...plan.errors]
          return <div className="import-preview"><ProblemList errors={errors}/>
            <h3>{plan.added.length} to add · {plan.skipped.length} kept</h3>
            <ul className="plain-list">{[...plan.added, ...plan.skipped].map((item, position) => <li key={position}>{item}</li>)}</ul>
            <button className="button primary" disabled={busy || !!errors.length || !plan.added.length} onClick={() => void update(plan.next, 'Team import applied.')}>Apply team import</button>
          </div>
        }}
      </Spreadsheet>
    </section>}
    <label className="team-filter">Find {labels[tab].toLowerCase()}<input type="search" value={filter} onChange={event => setFilter(event.target.value)}/></label>
    {tab === 'coverage' && <label className="team-filter">View coverage<select value={group} onChange={event => setGroup(event.target.value)}>
      <option value="company">By company</option><option value="route">By route</option><option value="driver">By driver</option><option value="unassigned">Unassigned</option>
    </select></label>}
    {tab === 'companies' && <section className="panel content-panel"><h2>Companies</h2>
      {companies.length ? <ul className="record-list">{companies.map(item => <li key={item.id}>
        <div><strong>{item.name}</strong><small>{[item.active ? 'Active' : 'Inactive', ...item.aliases, item.notes].filter(Boolean).join(' · ')}</small></div>
        {recordButton(item.id, 'companies')}
      </li>)}</ul> : <p>No companies {filter ? 'match the filter.' : 'added.'}</p>}</section>}
    {tab === 'drivers' && <section className="panel content-panel"><h2>Drivers</h2>
      {drivers.length ? <ul className="record-list">{drivers.map(item => <li key={item.id}>
        <div><strong>{item.name}</strong><small>{[companyName(team, item.companyId), item.active ? 'Active' : 'Inactive', item.notes].filter(Boolean).join(' · ')}</small></div>
        {recordButton(item.id, 'drivers')}
      </li>)}</ul> : <p>No drivers {filter ? 'match the filter.' : 'added.'}</p>}</section>}
    {tab === 'coverage' && (grouped.size ? <div className="stack">{[...grouped].sort(([a], [b]) => compare(a, b)).map(([name, items]) =>
      <section className="panel content-panel" key={name}><h2>{name}</h2><ul className="record-list">{items.map(item => {
        const issues = coverageReferences(item, index, team)
        if (team.coverage.some(other => overlaps(item, other, index))) issues.push('Overlapping coverage')
        return <CoverageRecord key={item.id} item={item} team={team} issues={issues} edit={recordButton(item.id, 'coverage')}/>
      })}</ul></section>
    )}</div> : <p className="panel empty">{group === 'unassigned' ? 'No unassigned daily coverage.' : 'No coverage records to display.'}</p>)}
  </>
}

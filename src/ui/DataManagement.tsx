import { useState } from 'react'
import xl from '../data/seed-xl.json'
import { buildIndex, diffRoutes, type AllocationChange, type RouteIndex } from '../domain/routes'
import { prepareRoutes, routeFields } from '../domain/spreadsheets'
import { coverageReferences } from '../domain/team'
import { csv, download } from '../domain/util'
import type { Commit } from '../storage/useWorkspace'
import { activeDataset, backup, datasetFromBackup, parseBackup, replaceRoutes, restoreBackup, restoreRoutes, type Workspace } from '../storage/workspace'
import { FilePicker, formatDate, Heading, Icon, ProblemList, routeLink, routeNames } from './shared'
import { Spreadsheet } from './Spreadsheet'

function ChangeList({ label, rows }: { label: string; rows: AllocationChange[] }) {
  return <details className="mapping"><summary><strong>{label}</strong><span>{rows.length}</span></summary>
    {rows.length ? <ul className="change-list">{rows.map(row => <li key={row.postcode}>
      <strong>{row.postcode}</strong><span>{routeNames(row.before)} → {routeNames(row.after)}</span>
    </li>)}</ul> : <p className="mapping-body muted">No changes in this group.</p>}
  </details>
}
function RouteDiff({ before, after, state }: { before: RouteIndex; after: RouteIndex; state: Workspace }) {
  const change = diffRoutes(before, after)
  const newWarnings = state.team.coverage.filter(item => item.active && coverageReferences(item, after, state.team)
    .some(issue => !coverageReferences(item, before, state.team).includes(issue)))
  return <div className="import-preview">
    <h3>Review changes</h3>
    <div className="stat-line"><strong>{after.routes.size} routes</strong><span>{after.entries.size} postcode entries</span>
      <span>{after.conflicts.length} {after.conflicts.length === 1 ? 'conflict' : 'conflicts'}</span>
      <span>{after.duplicates.length} duplicate {after.duplicates.length === 1 ? 'allocation' : 'allocations'}</span></div>
    {change.newRoutes.length > 0 && <p>Added routes · {change.newRoutes.join(', ')}</p>}
    {change.retiredRoutes.length > 0 && <p>Retired routes · {change.retiredRoutes.join(', ')}</p>}
    {newWarnings.length > 0 && <p className="notice warning">{newWarnings.length} active coverage {newWarnings.length === 1 ? 'record needs' : 'records need'} review after this update.</p>}
    <ChangeList label="Added postcodes" rows={change.added}/>
    <ChangeList label="Changed allocations" rows={change.changed}/>
    <ChangeList label="Removed postcodes" rows={change.removed}/>
    <details className="mapping"><summary><strong>Conflicts and duplicates</strong><span>{after.conflicts.length + after.duplicates.length}</span></summary>
      <ul className="change-list">
        {after.conflicts.map(entry => <li key={entry.postcode}><strong>{entry.postcode}</strong><span>{routeNames(entry.routes)}</span></li>)}
        {after.duplicates.map(entry => <li key={`${entry.postcode}-${entry.route}`}><strong>{entry.postcode}</strong><span>Route {entry.route} · {entry.count} source rows</span></li>)}
      </ul>
    </details>
  </div>
}

export function DataManagement({ state, index, commit, page }: { state: Workspace; index: RouteIndex; commit: Commit; page?: string }) {
  const [importKey, setImportKey] = useState(0)
  const [restoring, setRestoring] = useState<{ data: ReturnType<typeof parseBackup>; revision: number }>()
  const [backupError, setBackupError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const active = activeDataset(state)
  async function run(action: Parameters<Commit>[0], message: string, after?: () => void) {
    setBusy(true)
    if (await commit(action)) {
      setNotice(message)
      after?.()
    }
    setBusy(false)
  }

  if (page === 'conflicts') return <>
    <a className="back-link" href="#/data"><Icon name="back" size={18}/> Data management</a>
    <Heading title="Postcode conflicts">Check these allocations with dispatch.</Heading>
    {index.conflicts.length ? <div className="stack">{index.conflicts.map(entry => <section className="panel content-panel" key={entry.postcode}>
      <h2>{entry.postcode}</h2><div className="actions">{entry.routes.map(id => <a className="button secondary" href={routeLink(id)} key={id}>Route {id}</a>)}</div>
    </section>)}</div> : <p className="panel empty">No conflicting postcode allocations in the active dataset.</p>}
  </>
  if (page === 'xl') return <>
    <a className="back-link" href="#/data"><Icon name="back" size={18}/> Data management</a>
    <Heading title="Original XL rotations">As printed in the original workbook. Rotation dates are unconfirmed.</Heading>
    <div className="stack">{[...new Set(xl.map(row => row.block))].map(block => <section className="panel content-panel" key={block}>
      <h2>{block}</h2>
      {xl.filter(row => row.block === block).map(row => <details className="mapping" key={row.source_row}>
        <summary><strong>{row.dsp_as_printed || 'Unlabelled'}</strong><span>Source row {row.source_row}</span></summary>
        <dl className="xl-weeks">{[row.week_1, row.week_2, row.week_3, row.week_4].map((week, position) => <div key={position}>
          <dt>Week {position + 1}</dt><dd>{week}</dd></div>)}</dl>{row.comments && <p className="mapping-body">{row.comments}</p>}
      </details>)}
    </section>)}</div>
  </>
  return <>
    <a className="back-link" href="#/team"><Icon name="back" size={18}/> Team</a>
    <Heading title="Data management">Imports and backups apply to this browser. Each device manages its own data.</Heading>
    {notice && <p className="notice success" role="status">{notice}</p>}
    <div className="stack">
      <section className="panel content-panel">
        <div className="section-heading"><div><h2>Import / Update Routes</h2>
          <p>Upload an Excel or CSV file to replace the active route dataset.</p></div></div>
        <p className="current-source"><strong>Active source</strong> <span>{active.name}</span></p>
        <Spreadsheet key={importKey} fields={routeFields} inferRoutes label="Upload route spreadsheet">
          {file => {
            const prepared = prepareRoutes(file.name, file.sheets, file.mappings)
            if (!prepared.dataset) return <ProblemList errors={prepared.errors}/>
            const dataset = prepared.dataset
            const after = buildIndex(dataset)
            return <>
              <RouteDiff before={index} after={after} state={state}/>
              <button className="button primary" disabled={busy} onClick={() => {
                void run(current => replaceRoutes(current, dataset, active.id), 'Route update applied.', () => setImportKey(key => key + 1))
              }}><Icon name="check" size={18}/> Apply route update</button>
            </>
          }}
        </Spreadsheet>
      </section>
      <section className="panel content-panel">
        <div className="section-heading"><div><h2>Route versions</h2><p>Restore a previous spreadsheet while keeping the version history.</p></div>
          {state.activations.length > 1 && <button className="button secondary" disabled={busy} onClick={() => {
            if (confirm('Restore the previous route dataset?')) void run(current => {
              if (activeDataset(current).id !== active.id) throw new Error('Active routes changed. Recheck the version history.')
              return restoreRoutes(current)
            }, 'Previous route dataset restored.')
          }}>Restore previous version</button>}</div>
        <ul className="record-list">{[...state.datasets].reverse().map(dataset => <li key={dataset.id}>
          <div><strong>{dataset.name}</strong><small>{formatDate(dataset.createdAt)} · {dataset.rows.length} source entries</small></div>
          {dataset.id === active.id ? <span className="tag">Active</span> : <button className="button secondary" disabled={busy} onClick={() => {
            if (confirm(`Activate ${dataset.name}?`)) void run(current => restoreRoutes(current, dataset.id), 'Route version activated.')
          }}>Activate</button>}
        </li>)}</ul>
      </section>
      <section className="panel content-panel">
        <h2>Backup and exports</h2><p>JSON backs up route versions and team records. Approved pickup exports are available in Pickups.</p>
        <div className="actions">
          <button className="button secondary" onClick={() => download('manchester-routes-and-team.json', JSON.stringify(backup(state), null, 2), 'application/json')}>Download JSON backup</button>
          <button className="button secondary" onClick={() => download('manchester-active-routes.csv', csv(
            [['Route', 'Postcode', 'Worksheet', 'Source row'], ...active.rows.map(row => [row.route, row.postcode, row.sheet, row.row])],
          ), 'text/csv;charset=utf-8')}>Export active routes CSV</button>
          <FilePicker label="Open JSON backup" accept=".json,application/json" disabled={busy} onFiles={async files => {
            setRestoring(undefined)
            setBackupError('')
            try {
              if (files[0].size > 35 * 1024 * 1024) throw new Error('Choose a backup under 35 MB.')
              setRestoring({ data: parseBackup(await files[0].text()), revision: state.revision })
            } catch (failure) { setBackupError(failure instanceof Error ? failure.message : 'Could not read the backup.') }
          }}/>
        </div>
        {backupError && <p className="notice warning" role="alert">{backupError}</p>}
        {restoring && <>
          <RouteDiff before={index} after={datasetFromBackup(restoring.data)} state={state}/>
          <p className="notice warning">This backup will replace your team lists with {restoring.data.team.companies.length} companies,
            {' '}{restoring.data.team.drivers.length} drivers and {restoring.data.team.coverage.length} coverage records.</p>
          <div className="actions"><button className="button primary" disabled={busy} onClick={() =>
            void run(current => restoreBackup(current, restoring.data, restoring.revision), 'Backup restored.', () => setRestoring(undefined))}>Restore routes and team</button>
            <button className="button secondary" onClick={() => setRestoring(undefined)}>Cancel restore</button></div>
        </>}
      </section>
      <section className="panel content-panel">
        <h2>Source records</h2>
        <div className="actions"><a className="button secondary" href="#/data/conflicts">Review postcode conflicts</a>
          <a className="button secondary" href="#/data/xl">View original XL rotations</a></div>
      </section>
    </div>
  </>
}

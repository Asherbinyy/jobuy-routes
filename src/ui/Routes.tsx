import { useState } from 'react'
import type { DispatchPlan, RouteDispatch } from '../domain/dispatch'
import { compact, parsePostcode, routeId, sameRoute, type Entry, type Route, type RouteIndex } from '../domain/routes'
import { CopyButton, Heading, Icon, routeLink, routeNames, routeNumber } from './shared'

function DispatchDetails({ allocation }: { allocation: RouteDispatch | undefined }) {
  return allocation ? <p className="route-allocation"><strong>{allocation.company}</strong><span>{allocation.wave} · {allocation.times.join(' / ')}</span></p>
    : <p className="route-allocation muted">Company and wave need confirmation.</p>
}

function RouteCard({ route, allocation }: { route: Route; allocation?: RouteDispatch }) {
  const sectorsOnly = route.entries.every(entry => entry.kind === 'sector')
  const unit = route.entries.length === 1 ? (sectorsOnly ? 'sector' : 'postcode entry') : (sectorsOnly ? 'sectors' : 'postcode entries')
  return <a className="route-card panel" href={routeLink(route.id)}>
    <div className="route-card-top"><span className="route-kicker">Route</span><Icon name="arrow" size={17}/></div>
    <div className="route-card-num">{routeNumber(route.id)}</div>
    <div className="route-card-meta">{route.entries.length} {unit}</div>
    {allocation && <div className="route-card-carrier">{allocation.company} · {allocation.wave}</div>}
    <div className="route-card-samples">{route.entries.slice(0, 3).map(entry => entry.key).join(' · ')}</div>
  </a>
}

function EntryDetail({ entry, route }: { entry: Entry; route: string }) {
  return <details className="entry-detail">
    <summary><strong>{entry.key}</strong>
      <span>{entry.kind === 'full' ? 'Full postcode' : entry.kind === 'sector' ? 'Sector' : 'District'}{entry.routes.length > 1 && <span className="tag warning">Conflict</span>}</span>
    </summary>
    <div className="entry-source">
      {entry.routes.length > 1 && <p>Check with dispatch. Also listed on {routeNames(entry.routes.filter(id => id !== route))}.</p>}
      <CopyButton text={entry.key} label="Copy postcode"/>
      <ul>{entry.sources.map((source, index) => <li key={index}>
        {source.sheet.trim()}, row {source.row} · {source.originalPostcode ?? source.postcode} · Route {source.originalRoute}
      </li>)}</ul>
    </div>
  </details>
}

export function Routes({ index, dispatch, id }: { index: RouteIndex; dispatch: DispatchPlan; id?: string }) {
  const [filter, setFilter] = useState('')
  if (id) {
    const route = index.routes.get(id)
    return <>
      <a className="back-link" href="#/routes"><Icon name="back" size={18}/> All routes</a>
      <Heading title={`Route ${id}`}>{route ? `${route.entries.length} postcode entries in the current dataset` : 'This route is retired or missing from the active dataset.'}</Heading>
      {route && <>
        <DispatchDetails allocation={dispatch.get(id)}/>
        <div className="actions detail-actions"><CopyButton text={route.entries.map(entry => entry.key).join('\n')} label="Copy route postcodes"/>
          <a className="button secondary" href="#/">Back to search</a></div>
        <div className="panel entry-list">{route.entries.map(entry => <EntryDetail key={entry.key} entry={entry} route={id}/>)}</div>
      </>}
    </>
  }
  const postcode = parsePostcode(filter)
  const idFilter = routeId(filter)
  const exactRoute = sameRoute(index, filter)
  const routes = [...index.routes.values()].filter(route => !filter.trim() || route.id === exactRoute || route.id.includes(idFilter)
    || dispatch.get(route.id)?.company.toLowerCase().includes(filter.trim().toLowerCase())
    || route.entries.some(entry => postcode?.kind === 'district' ? entry.district === postcode.key
      : postcode ? entry.key === postcode.key || entry.key === postcode.sector || entry.sector === postcode.key : compact(entry.key).startsWith(compact(filter))))
  return <>
    <Heading title="Route directory" action={<a className="button secondary" href="#/warehouse">Warehouse plan</a>}>{index.routes.size} active {index.routes.size === 1 ? 'route' : 'routes'}</Heading>
    <div className="route-filter"><label className="field-label" htmlFor="route-filter">Filter by route, postcode or company</label>
      <div className="search-input"><Icon name="search"/><input id="route-filter" value={filter} placeholder="Enter route, postcode or company"
        onChange={event => setFilter(event.target.value)}/>
        {filter && <button type="button" className="icon-button" aria-label="Clear filter" onClick={() => setFilter('')}><Icon name="clear"/></button>}
      </div>
    </div>
    {routes.length ? <div className="route-grid">{routes.map(route => <RouteCard key={route.id} route={route} allocation={dispatch.get(route.id)}/>)}</div>
      : <p className="panel empty">No routes match this filter.</p>}
  </>
}

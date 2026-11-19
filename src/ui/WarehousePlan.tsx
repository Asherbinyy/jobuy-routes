import { dispatchCompanies, dispatchWaves, type DispatchPlan } from '../domain/dispatch'
import { type RouteIndex } from '../domain/routes'
import { Heading, Icon, routeLink } from './shared'

export function WarehousePlan({ index, dispatch }: { index: RouteIndex; dispatch: DispatchPlan }) {
  const unlisted = [...index.routes.keys()].filter(id => !dispatch.has(id))
  return <>
    <a className="back-link" href="#/routes"><Icon name="back" size={18}/> All routes</a>
    <Heading title="Warehouse plan">Company sortation zones and the printed dispatch waves.</Heading>
    <div className="stack">
      <section className="panel content-panel">
        <h2>Sortation zones</h2>
        <p>Relative positions as pictured in the warehouse reference.</p>
        <ul className="warehouse-map" aria-label="Warehouse sortation zones">
          {dispatchCompanies.map(company => <li className={`warehouse-zone zone-${company.zone}`} key={company.id}>
            <strong>{company.name}</strong><small>{company.position}</small>
          </li>)}
        </ul>
      </section>
      <section className="panel content-panel">
        <h2>Dispatch waves</h2>
        <div className="wave-list">{dispatchWaves.map(wave => <section className="wave" key={wave.label}>
          <header><h3>{wave.label}</h3><span>{wave.times.join(' / ')}</span></header>
          {wave.groups.map(group => {
            const company = dispatchCompanies.find(item => item.id === group.company)
            const routes = group.routes.filter(route => dispatch.has(route))
            return company && routes.length > 0 && <div className="wave-company" key={group.company}>
              <strong>{company.name}</strong><div className="chips">{routes.map(route =>
                <a key={route} className="chip" href={routeLink(route)}>Route {route}</a>)}</div>
            </div>
          })}
        </section>)}</div>
        {unlisted.length > 0 && <details className="mapping">
          <summary><strong>Routes without a confirmed wave</strong><span>{unlisted.length}</span></summary>
          <div className="mapping-body"><div className="chips">{unlisted.map(route =>
            <a key={route} href={routeLink(route)} className="chip">Route {route}</a>)}</div></div>
        </details>}
      </section>
    </div>
  </>
}

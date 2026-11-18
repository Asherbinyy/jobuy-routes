import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { buildIndex } from './domain/routes'
import { activeDataset } from './storage/workspace'
import { useWorkspace } from './storage/useWorkspace'
import { DataManagement } from './ui/DataManagement'
import { Pickups } from './ui/Pickups'
import { Routes } from './ui/Routes'
import { Search } from './ui/Search'
import { Team } from './ui/Team'
import { Icon } from './ui/shared'
import './styles.css'

const destinations = [
  { page: 'search', label: 'Search', href: '#/' },
  { page: 'routes', label: 'Routes', href: '#/routes' },
  { page: 'pickups', label: 'Pickups', href: '#/pickups' },
  { page: 'team', label: 'Team', href: '#/team' },
] as const

function readLocation() {
  const [, page = '', argument] = location.hash.split('/')
  let id: string | undefined
  try { id = argument ? decodeURIComponent(argument) : undefined } catch { id = undefined }
  return { page: page || 'search', id }
}

function App() {
  const workspace = useWorkspace()
  const [location, setLocation] = useState(readLocation)
  const [query, setQuery] = useState('')
  const dataset = workspace.state ? activeDataset(workspace.state) : undefined
  // Only route version changes invalidate the derived directory and prefix search index.
  const index = useMemo(() => dataset ? buildIndex(dataset) : undefined, [dataset?.id])

  useEffect(() => {
    const handle = () => {
      setLocation(readLocation())
      workspace.clearError()
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', handle)
    return () => window.removeEventListener('hashchange', handle)
  }, [])

  const { page, id } = location
  const { state, repository, commit } = workspace
  const selected = page === 'data' ? 'team' : page
  const nav = (className: string) => <nav className={className} aria-label="Main navigation">
    {destinations.map(item => <a key={item.page} href={item.href} aria-current={selected === item.page ? 'page' : undefined}>
      <Icon name={item.page} size={19}/><span>{item.label}</span>
    </a>)}
  </nav>
  return <>
    <a href="#main-content" className="skip-link" onClick={event => {
      event.preventDefault()
      document.querySelector<HTMLElement>('main')?.focus()
    }}>Skip to content</a>
    <header className="site-header">
      <div className="header-inner">
        <a className="brand" href="#/">
          <span className="brand-icon"><Icon name="brand" size={24}/></span>
          <strong>Manchester Route Finder</strong>
        </a>
        {nav('desktop-nav')}
        <a href="#/data" className="header-data" aria-label="Data management"><Icon name="data" size={17}/><span>Data management</span></a>
      </div>
    </header>
    <main id="main-content" tabIndex={-1} className="container">
      {workspace.error && <div className="notice warning global-notice" role="alert">
        <span>{workspace.error}</span><button className="icon-button" aria-label="Dismiss error" onClick={workspace.clearError}><Icon name="clear"/></button>
      </div>}
      {repository && !repository.durable && <p className="notice warning" role="status">Browser storage is unavailable. Changes last until this tab closes or reloads.</p>}
      {state && repository && dataset && index ? <>
        {page === 'routes' ? <Routes index={index} id={id}/> : page === 'data' ? <DataManagement state={state} index={index} commit={commit} page={id}/>
          : page === 'team' ? <Team state={state} index={index} commit={commit}/>
            : page === 'pickups' ? <Pickups state={state} index={index} repository={repository} commit={commit}/>
              : <Search index={index} dataset={dataset} query={query} setQuery={setQuery}/>}
      </> : !workspace.error && <p role="status">Opening route data…</p>}
    </main>
    {nav('mobile-nav')}
  </>
}

createRoot(document.getElementById('root')!).render(<App />)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {})
  })
}

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { autocomplete, compare, historyKey, lookup, type Entry, type Lookup, type RouteIndex } from '../domain/routes'
import { readHistory, recordSearch } from '../storage/searchHistory'
import { Heading, Icon, routeLink, routeNames } from './shared'

function Result({ result, choose }: { result: Lookup; choose: (value: string) => void }) {
  if (result.type === 'route') return <article className="result panel">
    <span className="status"><Icon name="check" size={16}/> Route found</span>
    <h2>Route {result.route.id}</h2>
    <p>{result.route.entries.length} postcode entries</p>
    <a className="button primary" href={routeLink(result.route.id)}>Open route <Icon name="arrow" size={18}/></a>
  </article>
  if (result.type === 'match' || result.type === 'conflict') {
    const { entry, postcode } = result
    return <article className={`result panel ${result.type === 'conflict' ? 'result-warning' : ''}`}>
      <span className="status"><Icon name={result.type === 'conflict' ? 'alert' : 'check'} size={16}/>
        {result.type === 'conflict' ? 'Needs confirmation' : 'Matched'}
      </span>
      <h2>{routeNames(entry.routes)}</h2>
      <p>{entry.kind === 'full' ? 'Full postcode' : 'Sector match'} <strong>{entry.key}</strong>
        {postcode.key !== entry.key && <> · searched {postcode.key}</>}</p>
      {result.type === 'conflict' && <p>Check with dispatch.</p>}
      <div className="actions">{entry.routes.map(id => <a key={id} className="button primary" href={routeLink(id)}>
        {entry.routes.length === 1 ? 'Open route' : `Open route ${id}`} <Icon name="arrow" size={18}/>
      </a>)}</div>
    </article>
  }
  if (result.type === 'district') {
    return <section className="panel result">
      <span className="status"><Icon name="pin" size={16}/> District</span>
      <h2>{result.postcode.key}</h2>
      <p>Choose a more specific postcode entry or compare candidate routes.</p>
      <div className="district-routes">{[...new Set(result.entries.flatMap(entry => entry.routes))].sort(compare).map(id =>
        <div key={id}><a href={routeLink(id)}>Route {id}</a><div className="chips">
          {result.entries.filter(entry => entry.routes.includes(id)).map(entry =>
            entry.kind === 'district' ? <span key={entry.key} className="tag">District allocation</span> :
              <button key={entry.key} type="button" className="chip" onClick={() => choose(entry.key)}>{entry.key}</button>)}
        </div></div>)}</div>
    </section>
  }
  if (result.type === 'missing') return <article className="result panel">
    <span className="status neutral"><Icon name="search" size={16}/> {result.postcode.key}</span>
    <h2>No route found</h2><p>No allocation in the current spreadsheet.</p>
  </article>
  if (result.type === 'invalid') return <article className="result panel">
    <span className="status neutral"><Icon name="search" size={16}/> {result.query}</span>
    <h2>No route found</h2><p>Check the postcode format and try again.</p>
  </article>
  return null
}

function SearchHistoryChips({ title, icon, entries, select }: {
  title: string; icon: string; entries: string[]; select: (value: string) => void
}) {
  return <div className="history-group">
    <h3><Icon name={icon} size={17}/>{title}</h3>
    {entries.length ? <div className="chips">{entries.map(entry => <button key={entry} className="chip"
      onClick={() => select(entry)}>{entry}</button>)}</div> : <p>No searches yet</p>}
  </div>
}

export function Search({ index, query, setQuery }: {
  index: RouteIndex; query: string; setQuery: (value: string) => void
}) {
  const [history, setHistory] = useState(readHistory)
  const [more, setMore] = useState(false)
  const [suggestOpen, setSuggestOpen] = useState(true)
  const [selected, setSelected] = useState(-1)
  const lastRecorded = useRef(historyKey(query, lookup(index, query)))
  const field = useRef<HTMLInputElement>(null)
  const result = lookup(index, query)
  const suggestions = autocomplete(index, history, query)
  const initial = suggestions.slice(0, 7)
  if (initial.length === 7 && initial.every(entry => entry.kind === 'district')) {
    const allocations = suggestions.filter(entry => entry.kind !== 'district').slice(0, 2)
    if (allocations.length) initial.splice(-allocations.length, allocations.length, ...allocations)
  }
  const list = more ? suggestions : initial
  const key = historyKey(query, result)
  const isComplete = result.type === 'match' || result.type === 'conflict' || result.type === 'route'
  const isEmpty = !query.trim()
  const historyEntries = Object.entries(history).filter(([value]) => {
    const item = lookup(index, value)
    return item.type !== 'partial' && item.type !== 'missing' && item.type !== 'invalid'
  })
  const frequent = [...historyEntries].sort(([, a], [, b]) => b.count - a.count || b.last - a.last).slice(0, 6).map(([value]) => value)
  const recent = historyEntries.sort(([, a], [, b]) => b.last - a.last).slice(0, 6).map(([value]) => value)
  const starterDistricts = [...index.districts.keys()].sort(compare).slice(0, 8)
  const visibleSuggestions = !isEmpty && suggestOpen && Boolean(list.length)
  const activeOption = visibleSuggestions && selected >= 0 && selected < list.length
  useEffect(() => {
    if (!isComplete || lastRecorded.current === key) return
    const timer = setTimeout(() => {
      lastRecorded.current = key
      setHistory(previous => recordSearch(key, previous))
    }, 900)
    return () => clearTimeout(timer)
  }, [key, isComplete])

  function choose(value: string, dismiss = true) {
    setQuery(value)
    setSelected(-1)
    setMore(false)
    setSuggestOpen(!dismiss)
    if (dismiss) field.current?.blur()
    const next = lookup(index, value)
    const chosen = historyKey(value, next)
    if (next.type !== 'partial' && next.type !== 'missing' && next.type !== 'invalid' && (lastRecorded.current !== chosen || value !== query)) {
      lastRecorded.current = chosen
      setHistory(previous => recordSearch(chosen, previous))
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    choose(activeOption ? list[selected].key : query)
  }

  return <div className="search-view">
    <Heading title="Search postcode">Enter a full postcode, sector, district or route number.</Heading>
    <div className="search-layout">
      <section className="search-content" aria-label="Postcode lookup">
        <div className="panel search-panel">
          <form onSubmit={submit}>
            <label className="field-label" htmlFor="postcode-query">Postcode or route number</label>
            <div className="search-input">
              <Icon name="search" size={23}/>
              <input id="postcode-query" ref={field} value={query} placeholder="Enter postcode or route"
                role="combobox" aria-autocomplete="list" aria-controls="postcode-options"
                aria-expanded={visibleSuggestions} aria-activedescendant={activeOption ? `postcode-option-${selected}` : undefined}
                autoComplete="off" autoCapitalize="characters" spellCheck={false} enterKeyHint="search"
                onFocus={() => setSuggestOpen(true)} onChange={event => {
                  if (historyKey(event.target.value, lookup(index, event.target.value)) !== lastRecorded.current) lastRecorded.current = ''
                  setQuery(event.target.value)
                  setSelected(-1)
                  setMore(false)
                  setSuggestOpen(true)
                }} onKeyDown={event => {
                  if (event.key === 'Escape') {
                    setSuggestOpen(false)
                    setSelected(-1)
                  }
                  if (list.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
                    event.preventDefault()
                    setSuggestOpen(true)
                    setSelected(current => event.key === 'ArrowDown' ? (current + 1) % list.length : (current < 0 ? list.length - 1 : (current + list.length - 1) % list.length))
                  }
                }}/>
              {!isEmpty && <button type="button" className="icon-button" aria-label="Clear search" onClick={() => {
                setQuery('')
                lastRecorded.current = ''
                setSelected(-1)
                field.current?.focus()
              }}><Icon name="clear"/></button>}
            </div>
          </form>
          <div id="postcode-options" role="listbox" aria-label="Postcode suggestions" hidden={!visibleSuggestions}>
            {visibleSuggestions && list.map((entry: Entry, position) => <button type="button" role="option" key={entry.key}
              id={`postcode-option-${position}`} aria-selected={selected === position} className="suggestion"
              onClick={() => choose(entry.key)}>
              <span><strong>{entry.key}</strong><small>{entry.kind === 'full' ? 'Full postcode' : entry.kind === 'sector' ? 'Sector' : 'District'}</small></span>
              <span className="suggestion-route">{entry.kind === 'district' ? `${entry.routes.length} candidate ${entry.routes.length === 1 ? 'route' : 'routes'}` : routeNames(entry.routes)}<Icon name="chevron" size={16}/></span>
            </button>)}
          </div>
          {visibleSuggestions && suggestions.length > list.length && <button className="text-button show-more" onClick={() => setMore(true)}>Show {suggestions.length - list.length} more suggestions</button>}
          {isEmpty && <div className="history">
            <SearchHistoryChips title="Recent" icon="clock" entries={recent} select={choose}/>
            <SearchHistoryChips title="Most searched" icon="trend" entries={frequent} select={choose}/>
          </div>}
          {!isEmpty && result.type === 'partial' && !list.length && <p className="field-hint">Keep typing a postcode, or enter an active route number.</p>}
        </div>
        <div aria-live="polite"><Result result={result} choose={choose}/></div>
        {isEmpty && <section className="panel district-panel">
          <div className="section-heading"><h2>Browse by district</h2><Icon name="pin" size={21}/></div>
          <div className="chips">{starterDistricts.map(district =>
            <button className="chip" key={district} onClick={() => choose(district)}>{district}</button>)}</div>
        </section>}
      </section>
    </div>
  </div>
}

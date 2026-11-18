import { useState, type ReactNode } from 'react'
import { columnLabel, detectMapping, readSpreadsheet, type Field, type Mapping, type Sheet } from '../domain/spreadsheets'
import { FilePicker } from './shared'

export const spreadsheetTypes = '.xlsx,.xls,.csv'

type ImportInput = { name: string; sheets: Sheet[]; mappings: Mapping[] }
export function Spreadsheet({ fields, inferRoutes, label, children }: {
  fields: Field[]; inferRoutes?: boolean; label: string; children: (file: ImportInput) => ReactNode
}) {
  const [file, setFile] = useState<ImportInput>()
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  async function load(upload: File) {
    setReading(true)
    setError('')
    setFile(undefined)
    try {
      const sheets = await readSpreadsheet(upload)
      if (!sheets.some(sheet => sheet.rows.some(row => row.some(value => value.trim())))) throw new Error('This spreadsheet is empty.')
      setFile({ name: upload.name, sheets, mappings: sheets.map(sheet => detectMapping(sheet, fields, inferRoutes)) })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not read this spreadsheet.')
    } finally { setReading(false) }
  }
  function change(index: number, mapping: Mapping) {
    setFile(current => current ? { ...current, mappings: current.mappings.map((old, position) => position === index ? mapping : old) } : current)
  }
  return <div className="spreadsheet">
    <FilePicker label={label} accept={spreadsheetTypes} disabled={reading} onFiles={files => { void load(files[0]) }}/>
    {reading && <p role="status">Reading spreadsheet…</p>}
    {error && <p className="notice warning" role="alert">{error}</p>}
    {file && <>
      <div className="section-heading mapping-heading"><div><h3>{file.name}</h3>
        <p>{file.mappings.filter(mapping => mapping.enabled).length} of {file.sheets.length} sheets included. Review or change the columns before applying.</p></div>
        <button type="button" className="text-button" onClick={() => setFile(undefined)}>Cancel import</button>
      </div>
      <div className="mapping-list">{file.sheets.map((sheet, index) => {
        const mapping = file.mappings[index]
        const sample = sheet.rows.slice(Math.max(mapping.header - 1, 0), mapping.header + 3)
        const width = sheet.rows.reduce((maximum, row) => Math.max(maximum, row.length), 0)
        return <details className="mapping" key={sheet.name}>
          <summary><strong>{sheet.name.trim()}</strong><span>{mapping.enabled ? 'Included' : 'Excluded'} · {sheet.rows.length} rows</span></summary>
          <div className="mapping-body">
            <label className="check"><input type="checkbox" checked={mapping.enabled} onChange={event => change(index, { ...mapping, enabled: event.target.checked })}/> Include this sheet</label>
            <label>Header row <span className="muted">(0 if there is no header)</span>
              <input type="number" min="0" max={sheet.rows.length} value={mapping.header} onChange={event =>
                change(index, { ...mapping, header: Math.max(0, Math.min(sheet.rows.length, Number(event.target.value))) })}/>
            </label>
            <div className="form-grid">{fields.map(field => <label key={field.key}>{field.label}{field.required ? ' *' : ''}
              <select aria-label={field.label} aria-required={mapping.enabled && Boolean(field.required)} value={mapping.columns[field.key] ?? ''} onChange={event => {
                const columns = { ...mapping.columns }
                if (event.target.value === '') delete columns[field.key]
                else columns[field.key] = Number(event.target.value)
                change(index, { ...mapping, columns })
              }}>
                <option value="">Choose column</option>
                {Array.from({ length: width }, (_, column) => {
                  const example = sheet.rows[mapping.header - 1]?.[column] || sample.find(row => row[column])?.[column]
                  return <option value={column} key={column}>{columnLabel(column)}{example && ` · ${example.slice(0, 70)}`}</option>
                })}
              </select></label>)}</div>
            {inferRoutes && <label className="check"><input type="checkbox" checked={Boolean(mapping.fillRoute)}
              onChange={event => change(index, { ...mapping, fillRoute: event.target.checked })}/> Use the previous route when its cell is blank</label>}
            {sample.length > 0 && <div className="table-scroll" tabIndex={0} aria-label="Spreadsheet sample"><table><thead><tr>
              <th>Row</th>{Array.from({ length: width }, (_, column) => <th key={column}>{columnLabel(column)}</th>)}
            </tr></thead><tbody>{sample.map((row, position) => <tr key={position}><th>{Math.max(mapping.header, 1) + position}</th>
              {Array.from({ length: width }, (_, column) => <td key={column}>{row[column]}</td>)}</tr>)}</tbody></table></div>}
          </div>
        </details>
      })}</div>
      {children(file)}
    </>}
  </div>
}

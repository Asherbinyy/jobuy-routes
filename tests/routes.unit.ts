import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { seed } from '../src/data/seed'
import { autocomplete, buildIndex, diffRoutes, lookup, parsePostcode, type RouteIndex } from '../src/domain/routes'
import { detectMapping, prepareRoutes, readSpreadsheet, routeFields } from '../src/domain/spreadsheets'
import { activeDataset, initialWorkspace, parseBackup, backup, replaceRoutes, restoreRoutes } from '../src/storage/workspace'
import { fixtureRows, workbookBytes } from './fixtures'

const original = buildIndex(seed)
function routesFor(index: RouteIndex, query: string) {
  const result = lookup(index, query, true)
  return result.type === 'match' || result.type === 'conflict' ? result.entry.routes : []
}
function originalRouteIds(query: string) {
  return routesFor(original, query)
}

test('normalises postcode levels and rejects invalid full postcodes', () => {
  assert.deepEqual(parsePostcode(' m6—5a b '), { key: 'M6 5AB', district: 'M6', sector: 'M6 5', kind: 'full' })
  assert.equal(parsePostcode('M6 - 5')?.key, 'M6 5')
  assert.equal(parsePostcode('M1')?.kind, 'district')
  assert.equal(parsePostcode('m10')?.key, 'M10')
  assert.equal(parsePostcode('M1 0')?.district, 'M1')
  assert.equal(parsePostcode('GIR0AA')?.kind, 'full')
  assert.equal(parsePostcode('GIR9AA'), undefined)
  assert.equal(parsePostcode('M6 5I0'), undefined)
})

test('original workbook preserves the source rows, route counts, duplicate allocations and conflicts', () => {
  assert.equal(seed.rows.length, 353)
  assert.equal(original.routes.size, 40)
  assert.equal(original.entries.size, 345)
  assert.equal(original.duplicates.length, 6)
  for (const entry of original.entries.values()) assert.ok(entry.sources.every(row => row.sheet && row.row > 1))
  assert.deepEqual(original.conflicts, [{ postcode: 'M32 9', routes: ['22', '37'] }, { postcode: 'SK1 1', routes: ['30', '32'] }])
  for (const [query, matches] of [
    ['M1 3XP', ['3']], ['M6 5AB', ['16']], ['m65ab', ['16']], ['M60 7AA', ['2']], ['OL8 4AA', ['40']],
    ['M32 9AA', ['22', '37']], ['SK1 1AA', ['30', '32']], ['M15 7PO', []],
  ] as const) assert.deepEqual(originalRouteIds(query), matches, query)
  assert.equal(lookup(original, 'M1').type, 'district')
  assert.equal(lookup(original, 'M15 7PO').type, 'invalid')
  assert.equal(lookup(original, 'Route 30').type, 'route')
  assert.equal(lookup(original, '01').type, 'route')
})

test('Excel dates and zero-padded identifiers survive conversion', async () => {
  const bytes = workbookBytes({ Examples: [['Date', 'Code'], [new Date('2026-11-18T00:00:00Z'), '001']] })
  const [sheet] = await readSpreadsheet(new File([new Uint8Array(bytes)], 'examples.xlsx'))
  assert.deepEqual(sheet.rows[1], ['2026-11-18', '001'])
})

const originalWorkbook = 'data/Manchester Routing for peak 40 routes.xlsx'
test('original Excel import detects SM allocations and excludes XL rotations', { skip: !existsSync(originalWorkbook) }, async () => {
  const file = new File([new Uint8Array(readFileSync(originalWorkbook))], 'original.xlsx')
  const sheets = await readSpreadsheet(file)
  const mappings = sheets.map(sheet => detectMapping(sheet, routeFields, true))
  assert.deepEqual(mappings.map(mapping => mapping.enabled), [true, false])
  const prepared = prepareRoutes(file.name, sheets, mappings)
  assert.deepEqual(prepared.errors, [])
  assert.equal(prepared.dataset?.rows.length, 353)
  assert.deepEqual(diffRoutes(original, buildIndex(prepared.dataset!)), { added: [], removed: [], changed: [], newRoutes: [], retiredRoutes: [] })
})

test('imports reordered columns across Excel sheets and replaces 12, 80 and 120 routes dynamically', async () => {
  let state = initialWorkspace()
  for (const count of [12, 80, 120]) {
    const [header, ...records] = fixtureRows(count)
    const bytes = workbookBytes({
      'Route data': [['Planning export'], header, ...records.slice(0, 10)],
      'More routes': [['Route ID', 'Postcode'], ...records.slice(10).map(row => [row[2], row[1]])],
      'Instructions': [['See dispatch before editing']],
    }, count === 12 ? 'biff8' : 'xlsx')
    const file = new File([new Uint8Array(bytes)], count === 12 ? 'routes.xls' : 'routes.xlsx')
    const sheets = await readSpreadsheet(file)
    const mappings = sheets.map(sheet => detectMapping(sheet, routeFields, true))
    assert.deepEqual(mappings.map(mapping => mapping.enabled), [true, true, false])
    const { dataset, errors } = prepareRoutes(file.name, sheets, mappings)
    assert.deepEqual(errors, [])
    const before = activeDataset(state)
    state = replaceRoutes(state, dataset!, before.id)
    const index = buildIndex(activeDataset(state))
    assert.equal(index.routes.size, count)
    assert.equal(index.routes.has(`R${count}`), true)
    assert.equal(index.routes.has('40'), false)
    assert.deepEqual(routesFor(index, 'M1 3XP'), [count === 12 ? 'R2' : 'R3'])
    const values = autocomplete(index, {}, 'M1').map(entry => entry.key)
    assert.ok(values.includes(count === 12 ? 'M1 4' : 'M1 7'))
    assert.ok(values.includes('M1 6HQ'))
    assert.ok(!values.includes('M10 1'))
    assert.ok(!values.includes('M1 6AA'))
    if (count === 80) {
      const diff = diffRoutes(buildIndex(before), index)
      assert.ok(diff.added.some(entry => entry.postcode === 'M1 7'))
      assert.ok(diff.removed.some(entry => entry.postcode === 'M1 4'))
      assert.deepEqual(diff.changed.find(entry => entry.postcode === 'M1 3')?.after, ['R3'])
    }
  }
  assert.equal(buildIndex(activeDataset(restoreRoutes(state))).routes.size, 80)
})

test('manual mapping retains source coordinates and rejects a broken or empty replacement', () => {
  const sheet = { name: 'column changes', rows: [['Other', 'Area', 'Plan'], ['text', 'M1 3', 'ALPHA'], ['text', 'M1 3', 'BRAVO']] }
  assert.equal(detectMapping(sheet, routeFields, true).enabled, false)
  const mapping = { enabled: true, header: 1, columns: { route: 2, postcode: 1 } }
  const prepared = prepareRoutes('changed.csv', [sheet], [mapping])
  assert.equal(prepared.dataset?.rows[0].row, 2)
  assert.deepEqual(buildIndex(prepared.dataset!).conflicts, [{ postcode: 'M1 3', routes: ['ALPHA', 'BRAVO'] }])
  assert.equal(prepareRoutes('empty.csv', [{ name: 'empty', rows: [] }], [mapping]).dataset, undefined)
  assert.equal(prepareRoutes('invalid.csv', [{ name: 'bad', rows: [sheet.rows[0], ['text', 'INVALID', 'ALPHA']] }], [mapping]).dataset, undefined)
  const state = initialWorkspace()
  assert.throws(() => replaceRoutes(state, { ...seed, rows: [] }, seed.id), /missing or invalid/)
  assert.throws(() => replaceRoutes(state, prepared.dataset!, 'other-version'), /changed/)
  assert.equal(activeDataset(state).id, seed.id)
})

test('autocomplete ranks complete matches and uses real frequency and recency', () => {
  const suggestions = autocomplete(original, { 'M1 6': { count: 4, last: 2 }, 'M1 3': { count: 4, last: 1 } }, 'm1')
  assert.deepEqual(suggestions.slice(0, 3).map(item => item.key), ['M1', 'M1 6', 'M1 3'])
  assert.ok(suggestions.every(entry => entry.district === 'M1' && entry.kind !== 'full'))
})

test('backups preserve versions and validate malformed route records', () => {
  const data = backup(initialWorkspace())
  assert.equal(parseBackup(JSON.stringify(data)).datasets[0].rows.length, 353)
  assert.throws(() => parseBackup('{}'), /invalid routes/)
  data.datasets = [{ ...seed, rows: [{ ...seed.rows[0], postcode: 'unknown' }] }]
  assert.throws(() => parseBackup(JSON.stringify(data)), /invalid routes/)
})

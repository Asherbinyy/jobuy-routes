import assert from 'node:assert/strict'
import test from 'node:test'
import { seed } from '../src/data/seed'
import { deliveriesForDate, deliveryRows, emptyDeliveries, readDeliveryUpload, resolveDelivery, saveDeliveryUpload, setDeliveryAssigned } from '../src/domain/deliveries'
import { buildIndex } from '../src/domain/routes'
import { emptyTeam } from '../src/domain/team'
import { uid } from '../src/domain/util'

const date = '2026-11-18'
const index = buildIndex(seed)
test('only explicit delivery rows are classified as delivery, with partial and ambiguous rows for review', () => {
  const rows = deliveryRows('Order reference Postcode Pickup/Delivery\nJDW101 M6 5AB Delivery\nJDW102 M32 9AA Pick-up\nJDW103 M1 3XP\nJDW104 Delivery\nJDW105 M1 3AA Delivery Pickup', 'JDW')
  assert.deepEqual(rows.map(row => [row.kind, row.orderRef, row.postcode]), [
    ['delivery', 'JDW101', 'M6 5AB'], ['pickup', 'JDW102', 'M32 9AA'], ['unclear', 'JDW103', 'M1 3XP'],
    ['delivery', 'JDW104', ''], ['unclear', 'JDW105', 'M1 3AA'],
  ])
})

test('uses existing postcode routes and approved company rules while surfacing conflicts', () => {
  const [row, conflict] = deliveryRows('JDW101 M6 5AB Delivery\nJDW102 M32 9AA Delivery', 'JDW')
  assert.equal(resolveDelivery(row, date, index, emptyTeam, []).route, '16')
  assert.equal(resolveDelivery(row, date, index, emptyTeam, []).company, '')
  assert.deepEqual(resolveDelivery(conflict, date, index, emptyTeam, []).routes, ['22', '37'])
  const rules = [
    { route: '16', company: 'Fixture Carrier' },
    { route: '16', company: 'Temporary Carrier', date },
  ]
  assert.equal(resolveDelivery(row, date, index, emptyTeam, rules).company, 'Temporary Carrier')
  const clashes = resolveDelivery(row, date, index, emptyTeam, [...rules, { route: '16', company: 'Other Carrier', date }])
  assert.deepEqual(clashes.companies, ['Other Carrier', 'Temporary Carrier'])
  assert.equal(clashes.company, '')
})

test('preserves ticks on duplicate imports, stores upload time and separates delivery dates', () => {
  const row = { id: uid(), orderRef: 'jdw101', postcode: 'm65ab', route: '16', company: '' }
  const first = readDeliveryUpload({ id: uid(), date, rows: [row] })
  const before = saveDeliveryUpload(emptyDeliveries, first, '2026-11-18T09:00:00Z')
  assert.equal(before.saved.added, 1)
  assert.equal(saveDeliveryUpload(before.state, first).state, before.state)
  const assigned = setDeliveryAssigned(before.state, row.id, true)
  const again = readDeliveryUpload({ id: uid(), date, rows: [{ ...row, id: uid() }] })
  const after = saveDeliveryUpload(assigned, again, '2026-11-18T10:00:00Z')
  assert.deepEqual([after.saved.added, after.saved.duplicates], [0, 1])
  assert.equal(deliveriesForDate(after.state, date).jobs[0].assigned, true)
  assert.equal(deliveriesForDate(after.state, date).latestUpload?.uploadedAt, '2026-11-18T10:00:00Z')
  assert.equal(deliveriesForDate(after.state, '2026-11-17').jobs.length, 0)
  assert.throws(() => readDeliveryUpload({ ...first, rows: [{ ...row, postcode: 'M6 5' }] }), /valid full postcode/)
})

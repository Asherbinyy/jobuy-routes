import assert from 'node:assert/strict'
import test from 'node:test'
import { seed } from '../src/data/seed'
import { deliveryRows, resolveDelivery } from '../src/domain/deliveries'
import { dispatchCompanies, dispatchForRoutes, dispatchWaves } from '../src/domain/dispatch'
import { buildIndex } from '../src/domain/routes'
import { emptyTeam } from '../src/domain/team'

const index = buildIndex(seed)

test('printed plan lists each confirmed route once with five companies and three waves', () => {
  const plan = dispatchForRoutes(index)
  assert.equal(dispatchCompanies.length, 5)
  assert.equal(dispatchWaves.length, 3)
  assert.equal(plan.size, 32)
  assert.deepEqual([...index.routes.keys()].filter(id => !plan.has(id)), ['11', '14', '15', '16', '23', '24', '25', '34'])
  assert.deepEqual(plan.get('5'), { company: 'Dragonsea', wave: 'Wave 3', times: ['08:30', '09:15'] })
  assert.equal(plan.get('1')?.wave, 'Wave 2')
  assert.equal(plan.get('40')?.company, 'Forge')
  for (const route of ['22', '37']) assert.equal(plan.get(route)?.company, 'Crown SDS')
  for (const route of ['30', '32']) assert.equal(plan.get(route)?.company, 'UCLS')
  for (const route of ['21', '26', '38', '39']) assert.equal(plan.get(route)?.company, 'Warrior')
})

test('replacement workbooks retain reference assignments only for routes with the verified postcode set', () => {
  const replaced = buildIndex({
    ...seed, id: 'replacement',
    rows: seed.rows.map(row => row.route === '5' ? { ...row, postcode: 'M1-8' } : row),
  })
  const plan = dispatchForRoutes(replaced)
  assert.equal(plan.has('5'), false)
  assert.equal(plan.get('40')?.company, 'Forge')
})

test('delivery review uses the printed company and respects overrides, conflicts and unlisted routes', () => {
  const plan = dispatchForRoutes(index)
  const [delivery, conflict, unlisted] = deliveryRows('JDW100 M1 5AA Delivery\nJDW200 M32 9AA Delivery\nJDW300 M6 5AB Delivery', 'JDW')
  const date = '2026-11-19'
  assert.equal(resolveDelivery(delivery, date, index, emptyTeam, [], plan).company, 'Dragonsea')
  assert.equal(resolveDelivery(delivery, date, index, emptyTeam, [{ route: '5', company: 'Fixture Override', date }], plan).company, 'Fixture Override')
  assert.equal(resolveDelivery(delivery, date, index, emptyTeam, [{ route: '5', company: 'Fixture Override', date }], plan).dispatch, undefined)
  assert.equal(resolveDelivery(unlisted, date, index, emptyTeam, [], plan).company, '')
  assert.deepEqual(resolveDelivery(conflict, date, index, emptyTeam, [], plan).routes, ['22', '37'])
  assert.equal(resolveDelivery(conflict, date, index, emptyTeam, [], plan).company, '')
  assert.equal(resolveDelivery({ ...conflict, route: '37' }, date, index, emptyTeam, [], plan).company, 'Crown SDS')
})

test('parcel labels prefer Main WB and leave either postcode for explicit review', () => {
  const lines = ['Main WB JDW99010111991', 'Sub WB JDW99010111992', 'Warehouse LS1 1AA', 'Customer M1 5AA']
  const rows = deliveryRows(lines.join('\n'), 'JDW')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].orderRef, 'JDW99010111991')
  assert.equal(rows[0].postcode, '')
  assert.equal(rows[0].kind, 'unclear')
  assert.deepEqual(rows[0].postcodeChoices, ['LS1 1AA', 'M1 5AA'])
  assert.equal(deliveryRows([...lines, 'Pickup example'].join('\n'), 'JDW')[0].kind, 'pickup')
  assert.equal(deliveryRows([...lines, 'Type: Delivery'].join('\n'), 'JDW')[0].kind, 'delivery')
})

test('an incomplete photo read shows OCR corrections as choices requiring confirmation', () => {
  const rows = deliveryRows('Warehouse\nLS1 1AA', 'JDW', ['JDW99010111991', 'M1 SAA'])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].orderRef, 'JDW99010111991')
  assert.equal(rows[0].kind, 'unclear')
  assert.equal(rows[0].postcode, '')
  assert.deepEqual(rows[0].postcodeChoices, ['LS1 1AA', 'M1 5AA'])
  assert.deepEqual(rows[0].postcodeCorrections, ['M1 5AA'])
})

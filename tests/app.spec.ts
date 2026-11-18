import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { createRequire } from 'node:module'
import type { AxeResults, RunOptions } from 'axe-core'
import { csvBuffer, fixtureRows, workbookBytes } from './fixtures'

const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js')

const search = (page: Page) => page.getByRole('combobox', { name: 'Postcode or route number' })
const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name, exact: true })
const warnings = (page: Page) => page.getByRole('alert')
const opt = (page: Page, value: string) => page.getByRole('listbox', { name: 'Postcode suggestions' }).getByRole('option').filter({ hasText: value })
const routeFile = (page: Page) => page.getByLabel('Upload route spreadsheet')
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)

async function activate(element: Locator, info: TestInfo) {
  if (info.project.use.hasTouch) await element.tap()
  else await element.click()
}
async function openData(page: Page) {
  await page.getByRole('link', { name: 'Data management', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Import / Update Routes' })).toBeVisible()
}
async function applyRoutes(page: Page) {
  await page.getByRole('button', { name: 'Apply route update' }).click()
  await expect(page.getByText('Route update applied.')).toBeVisible()
}
async function uploadRoutes(page: Page, count: number, kind: 'xlsx' | 'csv' = 'xlsx') {
  const [header, ...rows] = fixtureRows(count)
  await routeFile(page).setInputFiles({
    name: `routes-${count}.${kind}`, mimeType: kind === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: kind === 'csv' ? csvBuffer([header, ...rows]) : workbookBytes({
      'North routes': [header, ...rows.slice(0, 10)],
      'Other routes': [['Title'], ['Route #', 'Postal code'], ...rows.slice(10).map(row => [row[2], row[1]])],
      'Notes': [['Review with dispatch']],
    }),
  })
  await expect(page.getByText(`${count} routes`, { exact: true })).toBeVisible()
}

test('seed routes, exact sector matching, conflicts, keyboard and touch navigation', async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto('./')
  await expect(page.getByRole('heading', { level: 1, name: 'Search postcode' })).toBeVisible()
  await noOverflow(page)
  await search(page).fill('M')
  await expect(page.getByRole('option').filter({ has: page.getByText('Sector', { exact: true }) }).first()).toBeVisible()
  await expect(page.getByRole('option').filter({ hasText: /District/ }).first()).toBeVisible()
  await search(page).fill('m1')
  await expect(opt(page, 'M1 3')).toBeVisible()
  await expect(opt(page, 'M10')).toHaveCount(0)
  await search(page).press('ArrowDown')
  await expect(search(page)).toHaveAttribute('aria-activedescendant', 'postcode-option-0')
  await search(page).press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await search(page).fill('m65ab')
  await expect(page.getByRole('heading', { name: 'Route 16', exact: true })).toBeVisible()
  await expect(page.getByText('Sector match', { exact: false })).toContainText('M6 5')
  await activate(page.getByRole('link', { name: 'Open route', exact: true }), info)
  await expect(page.getByRole('heading', { level: 1, name: 'Route 16' })).toBeVisible()
  await expect(page.getByText('M6 5', { exact: true })).toBeVisible()
  await page.goBack()
  await expect(search(page)).toHaveValue('m65ab')
  for (const [postcode, heading] of [['M32 9AA', 'Route 22, Route 37'], ['SK1 1AA', 'Route 30, Route 32']]) {
    await search(page).fill(postcode)
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    await expect(page.getByText('Check with dispatch.', { exact: true })).toBeVisible()
  }
  await search(page).fill('M15 7PO')
  await expect(page.getByRole('heading', { name: 'No route found' })).toBeVisible()
  await activate(nav(page, 'Routes'), info)
  await expect(page.locator('.route-card')).toHaveCount(40)
  await activate(page.locator('.route-card').getByText('40', { exact: true }), info)
  await expect(page.getByRole('heading', { level: 1, name: 'Route 40' })).toBeVisible()
  await noOverflow(page)
  expect(errors).toEqual([])
})

test('one spreadsheet replaces 12, 80 and 120 routes, with a diff and rollback', async ({ page }, info) => {
  await page.goto('./')
  await openData(page)
  await uploadRoutes(page, 12)
  await expect(page.getByText('2 of 3 sheets included.', { exact: false })).toBeVisible()
  await applyRoutes(page)

  await activate(nav(page, 'Routes'), info)
  await expect(page.locator('.route-card')).toHaveCount(12)
  await activate(nav(page, 'Search'), info)
  await search(page).fill('M1')
  await expect(opt(page, 'M1 4')).toBeVisible()
  await expect(opt(page, 'M1 6HQ')).toBeVisible()
  await expect(opt(page, 'M10 1')).toHaveCount(0)
  await activate(opt(page, 'M1 4'), info)
  await expect(page.getByRole('heading', { name: 'Route R3' })).toBeVisible()
  await search(page).fill('M1 3XP')
  await expect(page.getByRole('heading', { name: 'Route R2' })).toBeVisible()

  await openData(page)
  await uploadRoutes(page, 80, 'csv')
  await page.getByText('Added postcodes', { exact: true }).click()
  await page.getByText('Changed allocations', { exact: true }).click()
  await page.getByText('Removed postcodes', { exact: true }).click()
  await expect(page.locator('.change-list').getByText('M1 7', { exact: true })).toBeVisible()
  await expect(page.getByText('Route R2 → Route R3', { exact: true })).toBeVisible()
  await expect(page.locator('.change-list').getByText('M1 4', { exact: true })).toBeVisible()
  await applyRoutes(page)
  await activate(nav(page, 'Search'), info)
  await expect(page.getByRole('heading', { name: 'Route R3' })).toBeVisible()
  await search(page).fill('M1')
  await expect(opt(page, 'M1 7')).toBeVisible()
  await expect(opt(page, 'M1 4')).toHaveCount(0)
  await activate(nav(page, 'Routes'), info)
  await expect(page.locator('.route-card')).toHaveCount(80)
  await expect(page.getByRole('link', { name: 'Route R80' })).toBeVisible()

  await openData(page)
  await uploadRoutes(page, 120)
  await applyRoutes(page)
  await activate(nav(page, 'Routes'), info)
  await expect(page.locator('.route-card')).toHaveCount(120)
  await expect(page.getByRole('link', { name: 'Route R120' })).toBeVisible()
  await page.reload()
  await expect(page.locator('.route-card')).toHaveCount(120)
  await openData(page)
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Restore previous version' }).click()
  await expect(page.getByText('Previous route dataset restored.')).toBeVisible()
  await activate(nav(page, 'Routes'), info)
  await expect(page.locator('.route-card')).toHaveCount(80)
  await expect(page.getByRole('link', { name: 'Route R120' })).toHaveCount(0)
})

test('invalid uploads preserve active routes and unexpected columns can be mapped', async ({ page }) => {
  await page.goto('./')
  await openData(page)
  await routeFile(page).setInputFiles({ name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.alloc(0) })
  await expect(warnings(page)).toContainText('non-empty spreadsheet')
  await routeFile(page).setInputFiles({ name: 'invalid.csv', mimeType: 'text/csv', buffer: Buffer.from('Route,Postcode\nZETA,unknown') })
  await expect(page.getByText('enter a route identifier', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply route update' })).toHaveCount(0)
  await nav(page, 'Routes').click()
  await expect(page.locator('.route-card')).toHaveCount(40)
  await openData(page)
  await routeFile(page).setInputFiles({ name: 'new columns.xlsx', mimeType: 'application/octet-stream',
    buffer: workbookBytes({ Custom: [['Planning area', 'Dispatch bucket'], ['M1 3', 'ALPHA'], ['M1 3', 'BRAVO']] }) })
  await page.getByText('Custom', { exact: true }).click()
  await page.getByLabel('Include this sheet').check()
  const columnMapping = page.locator('.mapping[open]')
  await columnMapping.getByRole('combobox', { name: 'Route', exact: true }).selectOption('1')
  await columnMapping.getByRole('combobox', { name: 'Postcode', exact: true }).selectOption('0')
  await expect(page.getByText('1 conflict', { exact: true })).toBeVisible()
  await applyRoutes(page)
  await nav(page, 'Search').click()
  await search(page).fill('M1 3XP')
  await expect(page.getByRole('heading', { name: 'Route ALPHA, Route BRAVO' })).toBeVisible()
  await expect(page.getByText('Needs confirmation', { exact: true })).toBeVisible()
})

test('recent searches and usage order survive reloads and handle denied localStorage writes', async ({ page, context }) => {
  await page.goto('./')
  for (const postcode of ['M1 6', 'M1 3', 'M1 6']) {
    await search(page).fill(postcode)
    await search(page).press('Enter')
  }
  await page.reload()
  const recent = page.getByRole('heading', { name: 'Recent' }).locator('..')
  const most = page.getByRole('heading', { name: 'Most searched' }).locator('..')
  await expect(recent.getByRole('button', { name: 'M1 6' })).toBeVisible()
  await expect(most.getByRole('button').first()).toHaveText('M1 6')
  await search(page).fill('M1')
  await expect(page.getByRole('option').nth(1)).toContainText('M1 6')
  const second = await context.newPage()
  await second.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new Error('Storage blocked') }
  })
  await second.goto('./')
  await search(second).fill('M6 5AB')
  await search(second).press('Enter')
  await expect(second.getByRole('heading', { name: 'Route 16' })).toBeVisible()
  await second.getByRole('button', { name: 'Clear search' }).click()
  await expect(second.getByRole('heading', { name: 'Recent' }).locator('..').getByRole('button', { name: 'M6 5AB' })).toBeVisible()
})

async function importTeam(page: Page, kind: 'companies' | 'drivers' | 'coverage', rows: string) {
  await page.getByRole('button', { name: `Import ${kind}`, exact: true }).click()
  await page.getByLabel(`Upload ${kind} spreadsheet`).setInputFiles({ name: `${kind}.csv`, mimeType: 'text/csv', buffer: Buffer.from(rows) })
  await expect(page.getByText('1 to add · 0 kept')).toBeVisible()
  await page.getByRole('button', { name: 'Apply team import' }).click()
  await expect(page.getByRole('heading', { name: `Import ${kind}`, exact: true })).toHaveCount(0)
}

test('team imports require approval and retired routes flag saved company and driver coverage', async ({ page }) => {
  await page.goto('./')
  await nav(page, 'Team').click()
  await page.getByRole('button', { name: 'Companies', exact: true }).click()
  await importTeam(page, 'companies', 'Remarks,Carrier\nTest notes,Fixture Company')
  await expect(page.getByText('Fixture Company', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Drivers', exact: true }).click()
  await importTeam(page, 'drivers', 'Courier,Employer\nFixture Driver,Fixture Company')
  await expect(page.getByText('Fixture Driver', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Coverage', exact: true }).click()
  await importTeam(page, 'coverage', 'Date,DSP,Driver,Route code\n2026-11-18,Fixture Company,Fixture Driver,16')
  await expect(page.getByText('Pending approval', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Edit coverage', exact: true }).click()
  await page.getByLabel('Approved coverage', { exact: true }).check()
  await page.getByRole('button', { name: 'Save coverage', exact: true }).click()
  await expect(page.getByText('Approved', { exact: true })).toBeVisible()

  await openData(page)
  await uploadRoutes(page, 12, 'csv')
  await expect(page.getByText('1 active coverage record needs review after this update.')).toBeVisible()
  await applyRoutes(page)
  await nav(page, 'Team').click()
  await expect(page.getByText('Route 16 retired', { exact: true })).toBeVisible()
  await expect(page.getByText('Fixture Company · Fixture Driver', { exact: true })).toBeVisible()
})

test('on-device OCR retains the source, supports correction, approves, exports and restores', async ({ page }, info) => {
  test.setTimeout(150000)
  await page.goto('./')
  await activate(nav(page, 'Pickups'), info)
  const requests: string[] = []
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()) })
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1050
    canvas.height = 245
    const context = canvas.getContext('2d')!
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#161616'
    context.font = '36px Arial'
    context.fillText('Order reference', 45, 58)
    context.fillText('Postcode', 555, 58)
    context.fillText('JDW123456', 45, 125)
    context.fillText('M6 5AB', 555, 125)
    context.fillText('JDW723458', 45, 196)
    context.fillText('M32 9AA', 555, 196)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await page.getByLabel('Upload screenshots or photos').setInputFiles({
    name: 'labelled-test-pickups.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64'),
  })
  const extracted = page.getByText('Text extracted', { exact: true })
  await expect(extracted.or(warnings(page)).first()).toBeVisible({ timeout: 125000 })
  await expect(extracted).toBeVisible()
  const rows = page.locator('.job-editor')
  await expect(rows).toHaveCount(2)
  await expect(rows.first().getByLabel('Full postcode')).toHaveValue('M6 5AB')
  await expect(rows.first().getByLabel('Order reference')).toHaveValue('JDW123456')
  await expect(rows.nth(1).getByText('Route conflict', { exact: false })).toBeVisible()
  await rows.first().getByText('Source and extracted text').click()
  await expect(rows.first().getByText(/% OCR confidence/)).toBeVisible()
  await expect(rows.first().getByRole('img', { name: 'Source image labelled-test-pickups.png' })).toBeVisible()
  await rows.nth(1).getByLabel('Full postcode').fill('M1 3XP')
  for (const row of await rows.all()) await row.getByLabel('Reference and postcode checked against the source').check()
  await expect(rows.nth(1).getByText('Route 3 · M1 3', { exact: true })).toBeVisible()
  await page.reload()
  await expect(rows.nth(1).getByLabel('Full postcode')).toHaveValue('M1 3XP')
  await page.getByRole('button', { name: 'Preview assignments' }).click()
  await expect(page.getByRole('heading', { name: 'Assignment preview' })).toBeVisible()
  await page.getByLabel('Save jobs with unresolved assignments for follow-up').check()
  await page.getByRole('button', { name: 'Approve & save' }).click()
  await expect(page.getByText('Pickup assignments approved and saved.')).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export pickup CSV' }).click()
  expect((await download).suggestedFilename()).toBe('manchester-approved-pickups.csv')
  await expect(page.getByRole('heading', { name: 'Unassigned company › Unassigned driver › Route 16' })).toBeVisible()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Undo latest approval' }).click()
  await expect(page.getByText('Previous approved pickup snapshot restored.')).toBeVisible()
  await expect(page.getByText('0 saved jobs')).toBeVisible()
  await noOverflow(page)
  expect(requests.every(url => new URL(url).origin === new URL(page.url()).origin)).toBe(true)
})

test('core screens fit common mobile widths and pass automated accessibility checks', async ({ page }, info) => {
  await page.goto('./')
  await expect(search(page)).toBeVisible()
  const violationIds = async () => {
    await page.addScriptTag({ path: axePath })
    return page.evaluate(async () => {
      const axe = (window as Window & { axe?: { run(options: RunOptions): Promise<AxeResults> } }).axe!
      const result = await axe.run({ runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })
      return result.violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) }))
    })
  }
  expect(await violationIds()).toEqual([])
  if (info.project.use.hasTouch) {
    for (const width of [320, 360, 375, 390, 414, 430]) {
      await page.setViewportSize({ width, height: 800 })
      await noOverflow(page)
    }
  }
  for (const name of ['Routes', 'Pickups', 'Team']) {
    await nav(page, name).click()
    await noOverflow(page)
  }
  expect(await violationIds()).toEqual([])
})

test('search and directory reopen offline after installation', async ({ context, page }) => {
  await page.goto('./')
  await expect(search(page)).toBeVisible()
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve =>
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }))
    return registration.scope
  })
  await context.setOffline(true)
  await page.reload()
  await expect(search(page)).toBeVisible()
  await search(page).fill('M6 5AB')
  await expect(page.getByRole('heading', { name: 'Route 16', exact: true })).toBeVisible()
  await nav(page, 'Routes').click()
  await expect(page.locator('.route-card')).toHaveCount(40)
})

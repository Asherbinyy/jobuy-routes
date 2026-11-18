import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { startWorkplace } from '../scripts/workplace-server'

const date = '2026-11-18'
const entry = (page: Page) => page.getByRole('link', { name: 'Upload screenshot', exact: true })

async function upload(page: Page) {
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1050
    canvas.height = 310
    const context = canvas.getContext('2d')!
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.font = '34px Arial'
    context.fillStyle = '#15211b'
    const rows = [
      ['Order Reference', 'Postcode', 'Type'],
      ['JDW123456', 'M6 5AB', 'Delivery'],
      ['JDW723458', 'M32 9AA', 'Pickup'],
      ['JDW123459', 'M1 3XP', 'Pending'],
    ]
    rows.forEach((row, line) => row.forEach((value, column) => context.fillText(value, [45, 450, 745][column], 58 + 65 * line)))
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await page.locator('input[aria-label="Upload screenshot"]').setInputFiles({
    name: 'warehouse-delivery-fixture.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64'),
  })
  const review = page.locator('.delivery-review')
  await expect(review.getByText('1 pickup row skipped')).toBeVisible({ timeout: 50000 })
  await expect(review.getByText('1 need a type')).toBeVisible()
  const unknown = review.locator('article').filter({ has: page.getByRole('heading', { name: 'JDW123459' }) })
  await unknown.getByRole('combobox', { name: 'Row type' }).selectOption('exclude')
  await expect(review.getByText('1 delivery', { exact: true })).toBeVisible()
}

test('screenshot review saves only deliveries locally and supports reversible assignment ticks', async ({ page }, info: TestInfo) => {
  test.setTimeout(90000)
  const mutations: string[] = []
  page.on('request', request => { if (request.method() !== 'GET') mutations.push(request.url()) })
  await page.goto('./')
  if (info.project.use.hasTouch) await entry(page).tap()
  else await entry(page).click()
  await page.getByLabel('Delivery date').fill(date)
  await upload(page)
  await page.getByRole('button', { name: 'Save to checklist' }).click()
  await expect(page.getByText('1 delivery added.')).toBeVisible()
  await expect(page.getByText('Last upload', { exact: false })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Route 16' })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Assigned JDW723458' })).toHaveCount(0)
  const check = page.getByRole('checkbox', { name: 'Assigned JDW123456' })
  await check.check()
  await expect(page.getByText('All deliveries assigned')).toBeVisible()
  await page.reload()
  await page.getByLabel('Delivery date').fill(date)
  await expect(check).toBeChecked()
  await check.uncheck()
  await expect(page.getByText('0 of 1 assigned')).toBeVisible()
  await expect(page.getByText('All deliveries assigned')).toHaveCount(0)
  await page.getByLabel('Delivery date').fill('2026-11-17')
  await expect(page.getByText('No deliveries for this date.')).toBeVisible()
  expect(mutations).toEqual([])
})

test('private workplace checklist shares review and assignment changes across signed-in browsers', async ({ browser }, info) => {
  test.skip(info.project.name !== 'Desktop Chromium', 'Cross-browser contexts are exercised from the desktop project.')
  test.setTimeout(90000)
  const folder = await mkdtemp(join(tmpdir(), 'manchester-private-checklist-'))
  const operator = { username: 'desk-a', password: 'fixture-operator-one' }
  const colleague = { username: 'desk-b', password: 'fixture-operator-two' }
  const host = await startWorkplace({
    accounts: { [operator.username]: operator.password, [colleague.username]: colleague.password },
    dataDir: folder, dist: 'dist', port: 0, rules: [{ route: '16', company: 'Fixture Carrier' }],
  })
  const first = await browser.newContext({ httpCredentials: operator })
  const second = await browser.newContext({ httpCredentials: colleague })
  try {
    const a = await first.newPage()
    const b = await second.newPage()
    const api = host.url + '/api/dispatch?date=' + date
    expect((await fetch(api)).status).toBe(401)
    expect((await first.request.post(host.url + '/api/dispatch/assignments', {
      headers: { Origin: 'https://another-site.invalid', 'Content-Type': 'application/json' }, data: { id: 'example', assigned: true },
    })).status()).toBe(403)
    await Promise.all([a.goto(host.url + '/#/deliveries'), b.goto(host.url + '/#/deliveries')])
    await expect(a.getByText('Warehouse network', { exact: true })).toBeVisible()
    await Promise.all([a.getByLabel('Delivery date').fill(date), b.getByLabel('Delivery date').fill(date)])
    await expect(b.getByText('No deliveries for this date.')).toBeVisible()
    await upload(a)
    await a.getByRole('button', { name: 'Save to checklist' }).click()
    await expect(b.getByRole('heading', { name: 'Fixture Carrier' })).toBeVisible({ timeout: 10000 })
    const aCheck = a.getByRole('checkbox', { name: 'Assigned JDW123456' })
    const bCheck = b.getByRole('checkbox', { name: 'Assigned JDW123456' })
    await aCheck.check()
    await expect(bCheck).toBeChecked({ timeout: 10000 })
    await bCheck.uncheck()
    await expect(aCheck).not.toBeChecked({ timeout: 10000 })
  } finally {
    await Promise.all([first.close(), second.close()])
    await host.close()
    await rm(folder, { recursive: true, force: true })
  }
})

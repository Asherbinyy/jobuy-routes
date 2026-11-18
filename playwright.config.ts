import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4173)
const base = process.env.APP_BASE || '/'
const url = `http://127.0.0.1:${port}${base}`
const external = process.env.PLAYWRIGHT_BASE_URL

export default defineConfig({
  testDir: 'tests',
  testMatch: '**/*.spec.ts',
  timeout: 50_000,
  workers: 2,
  use: { baseURL: external ?? url, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: external ? undefined : {
    command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`,
    url,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'iPhone WebKit 390', use: { ...devices['iPhone 13'] } },
    { name: 'iPhone WebKit 320', use: { ...devices['iPhone 13'], viewport: { width: 320, height: 690 }, screen: { width: 320, height: 690 } } },
    { name: 'Android Chromium 430', use: { ...devices['Pixel 7'], viewport: { width: 430, height: 880 }, screen: { width: 430, height: 880 } } },
    { name: 'Desktop Chromium', use: { ...devices['Desktop Chrome'] } },
  ],
})

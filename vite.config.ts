import { defineConfig } from 'vite'

export default defineConfig({
  base: process.env.APP_BASE || '/manchester-route-finder/',
  build: { target: ['safari16.4', 'chrome109'], cssTarget: 'safari16.4' },
})

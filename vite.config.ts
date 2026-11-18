import { defineConfig } from 'vite'

export default defineConfig({
  base: process.env.APP_BASE || '/',
  build: { target: ['safari16.4', 'chrome109'], cssTarget: 'safari16.4' },
})

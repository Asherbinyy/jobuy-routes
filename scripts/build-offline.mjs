import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'

const files = (await readdir('dist', { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
  .map(entry => `${entry.parentPath ?? entry.path}/${entry.name}`.replace(/^dist\//, ''))
  .filter(file => file !== 'sw.js' && !file.startsWith('ocr/') && !file.endsWith('.map')).sort()
const hash = createHash('sha256')
for (const file of files) hash.update(file).update(await readFile(`dist/${file}`))
hash.update(await readFile('package-lock.json'))
hash.update(await readFile(new URL(import.meta.url)))
await writeFile('dist/sw.js', `
const scope = self.registration.scope
const cacheName = 'manchester-app-' + ${JSON.stringify(hash.digest('hex').slice(0, 16))}
const ocrCache = cacheName + '-ocr'
const shell = new URL('index.html', scope).href
const assets = new Set(${JSON.stringify(files)}.map(file => new URL(file, scope).href))
const assetDirectory = new URL('assets/', scope).href

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName)
    await cache.addAll([...assets].map(url => url === shell ? new Request(url, { cache: 'reload' }) : url))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Keep the previous build's assets available to tabs that are still open.
    const builds = (await caches.keys()).filter(key => key.startsWith('manchester-app-') && !key.endsWith('-ocr'))
    const obsolete = builds.slice(0, Math.max(0, builds.indexOf(cacheName) - 1))
    await Promise.all(obsolete.flatMap(key => [caches.delete(key), caches.delete(key + '-ocr')]))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET' || !request.url.startsWith(scope)) return
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const response = await fetch(request, { cache: 'no-cache' }).catch(() => undefined)
      if (response?.ok) return response
      const cache = await caches.open(cacheName)
      return await cache.match(shell) ?? response ?? Response.error()
    })())
    return
  }
  if (assets.has(request.url)) {
    // These fingerprinted files are identical for every request from this app.
    event.respondWith(caches.open(cacheName).then(async cache => await cache.match(request, { ignoreVary: true }) || fetch(request)))
    return
  }
  if (request.url.startsWith(assetDirectory)) {
    event.respondWith(caches.match(request, { ignoreVary: true }).then(saved => saved ?? fetch(request)))
    return
  }
  if (request.url.startsWith(new URL('ocr/', scope).href)) {
    event.respondWith((async () => {
      const cache = await caches.open(ocrCache)
      const saved = await cache.match(request)
      if (saved) return saved
      const response = await fetch(request)
      if (response.ok) {
        try { await cache.put(request, response.clone()) } catch {}
      }
      return response
    })())
  }
})
`)

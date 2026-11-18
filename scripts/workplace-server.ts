import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs'
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { extname, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { readDeliveryUpload, type CompanyRule, type DeliveryUpload, type SavedDeliveryUpload } from '../src/domain/deliveries'
import { routeId, validRouteId } from '../src/domain/routes'
import { spreadsheetDate } from '../src/domain/spreadsheets'

type Options = {
  accounts: Record<string, string>; dataDir: string; dist: string; port?: number; host?: string; origin?: string
  certificates?: { cert: Buffer; key: Buffer }; rules?: CompanyRule[]
}
const digest = (value: string) => createHash('sha256').update(value).digest()
const unknownAccount = digest('unknown-account')
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.gz': 'application/gzip',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
}

function json(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(payload))
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 512 * 1024) throw new Error('That request is too large.')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

export function readCompanyRules(value: unknown): CompanyRule[] {
  if (!Array.isArray(value)) throw new Error('The company map must be a list.')
  return value.map(item => {
    const route = typeof item?.route === 'string' ? routeId(item.route) : ''
    const company = typeof item?.company === 'string' ? item.company.trim() : ''
    const date = item?.date
    if (!validRouteId(route) || !company || company.length > 120 || /\p{C}/u.test(company)
      || (date !== undefined && (typeof date !== 'string' || !date || spreadsheetDate(date) !== date))) {
      throw new Error('Each company rule needs a route, company and optional YYYY-MM-DD date.')
    }
    return { route, company, date }
  })
}

function openChecklist(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const filename = join(dataDir, 'checklist.sqlite')
  closeSync(openSync(filename, 'a', 0o600))
  const database = new DatabaseSync(filename)
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=2500;
    CREATE TABLE IF NOT EXISTS board_state (key INTEGER PRIMARY KEY CHECK(key=1), revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO board_state VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, uploadedAt TEXT NOT NULL, added INTEGER NOT NULL, duplicates INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, orderRef TEXT NOT NULL, postcode TEXT NOT NULL, route TEXT NOT NULL,
      company TEXT NOT NULL, assigned INTEGER NOT NULL DEFAULT 0 CHECK(assigned IN (0,1)), UNIQUE(date, orderRef)
    );
  `)
  const getVersion = database.prepare('SELECT revision FROM board_state WHERE key=1')
  const changeVersion = database.prepare('UPDATE board_state SET revision=revision+1 WHERE key=1')
  const getUpload = database.prepare('SELECT * FROM uploads WHERE id=?')
  const latest = database.prepare('SELECT * FROM uploads ORDER BY uploadedAt DESC, rowid DESC LIMIT 1')
  const getJobs = database.prepare('SELECT * FROM jobs WHERE date=?')
  const insertJob = database.prepare('INSERT INTO jobs (id, date, orderRef, postcode, route, company) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(date, orderRef) DO NOTHING')
  const insertUpload = database.prepare('INSERT INTO uploads VALUES (?, ?, ?, ?, ?)')
  const getJob = database.prepare('SELECT assigned FROM jobs WHERE id=?')
  const assignJob = database.prepare('UPDATE jobs SET assigned=? WHERE id=?')

  return {
    close: () => database.close(),
    load(date: string, rules: CompanyRule[]) {
      return {
        jobs: getJobs.all(date).map(job => ({ ...job, assigned: Boolean(job.assigned) })),
        latestUpload: latest.get(), revision: getVersion.get()?.revision ?? 0, rules,
      }
    },
    upload(upload: DeliveryUpload) {
      database.exec('BEGIN IMMEDIATE')
      try {
        const existing = getUpload.get(upload.id) as SavedDeliveryUpload | undefined
        if (existing) {
          database.exec('COMMIT')
          return existing
        }
        const uploadedAt = new Date().toISOString()
        let added = 0
        for (const row of upload.rows) {
          added += Number(insertJob.run(row.id, upload.date, row.orderRef, row.postcode, row.route, row.company).changes)
        }
        const duplicates = upload.rows.length - added
        insertUpload.run(upload.id, upload.date, uploadedAt, added, duplicates)
        changeVersion.run()
        database.exec('COMMIT')
        return { id: upload.id, date: upload.date, uploadedAt, added, duplicates }
      } catch (failure) {
        database.exec('ROLLBACK')
        throw failure
      }
    },
    setAssigned(id: string, assigned: boolean) {
      database.exec('BEGIN IMMEDIATE')
      try {
        const job = getJob.get(id)
        if (!job) {
          database.exec('COMMIT')
          return false
        }
        if (Boolean(job.assigned) !== assigned) {
          assignJob.run(Number(assigned), id)
          changeVersion.run()
        }
        database.exec('COMMIT')
        return true
      } catch (failure) {
        database.exec('ROLLBACK')
        throw failure
      }
    },
  }
}

export async function startWorkplace(options: Options) {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 8787
  const trusted = options.origin && new URL(options.origin)
  const loopback = host === '127.0.0.1' || host === '::1'
  if (!loopback && (!options.certificates || !trusted || trusted.protocol !== 'https:')) {
    throw new Error('Warehouse network access requires a HTTPS origin and a TLS certificate and key.')
  }
  if (trusted && (trusted.origin !== options.origin || trusted.username || trusted.password
    || trusted.protocol !== (options.certificates ? 'https:' : 'http:'))) throw new Error('Set the exact website origin, without a trailing slash.')
  if (options.certificates && !trusted) throw new Error('Set the exact HTTPS origin for the workplace server.')
  const names = Object.entries(options.accounts)
  if (!names.length || names.some(([name, password]) => !/^[a-z0-9_.-]{1,60}$/i.test(name) || typeof password !== 'string' || password.length < 16)) {
    throw new Error('Configure named accounts with passwords at least 16 characters long.')
  }
  const users = new Map(names.map(([name, password]) => [name, digest(password)]))
  const dist = resolve(options.dist)
  const shell = readFileSync(join(dist, 'index.html'), 'utf8').replace('</head>', '<meta name="dispatch-mode" content="workplace" /></head>')
  const rules = readCompanyRules(options.rules ?? [])
  const board = openChecklist(resolve(options.dataDir))
  const attempts = new Map<string, { count: number; until: number }>()
  let origin = trusted ? trusted.origin : ''

  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    response.setHeader('Referrer-Policy', 'no-referrer')
    if (request.headers.host?.toLowerCase() !== new URL(origin).host.toLowerCase()) return json(response, 421, { error: 'Open the configured workplace address.' })
    const key = request.socket.remoteAddress ?? ''
    const now = Date.now()
    const attempt = attempts.get(key)
    if (attempt && attempt.until > now && attempt.count >= 12) {
      response.setHeader('Retry-After', String(Math.ceil((attempt.until - now) / 1000)))
      return json(response, 429, { error: 'Too many sign-in attempts. Try again in a minute.' })
    }
    const credentials = /^Basic (\S+)$/i.exec(request.headers.authorization ?? '')
    const decoded = credentials ? Buffer.from(credentials[1], 'base64').toString('utf8') : ''
    const split = decoded.indexOf(':')
    const match = split >= 0 ? users.get(decoded.slice(0, split)) : undefined
    if (!timingSafeEqual(match ?? unknownAccount, digest(decoded.slice(split + 1))) || !match) {
      if (credentials) {
        if (attempts.size >= 2500) for (const [host, value] of attempts) if (value.until <= now) attempts.delete(host)
        if (attempts.size < 2500 || attempt) attempts.set(key, attempt && attempt.until > now ? { ...attempt, count: attempt.count + 1 } : { count: 1, until: now + 60_000 })
      }
      response.setHeader('WWW-Authenticate', 'Basic realm="Warehouse checklist", charset="UTF-8"')
      return json(response, 401, { error: 'Sign in with your warehouse account.' })
    }
    attempts.delete(key)
    const url = new URL(request.url ?? '/', origin)
    if (url.origin !== origin) return json(response, 400, { error: 'Open the configured workplace address.' })
    if (url.pathname.startsWith('/api/')) {
      if (request.method === 'GET' && url.pathname === '/api/dispatch') {
        const date = url.searchParams.get('date')
        if (!date || spreadsheetDate(date) !== date) return json(response, 400, { error: 'Choose a valid delivery date.' })
        return json(response, 200, board.load(date, rules))
      }
      if (request.method !== 'POST' || request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') {
        return json(response, 403, { error: 'Open the warehouse app to make changes.' })
      }
      const body = await readBody(request).catch(() => undefined)
      if (url.pathname === '/api/dispatch/uploads') {
        let upload: DeliveryUpload
        try { upload = readDeliveryUpload(body) }
        catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : 'Review the upload.' }) }
        return json(response, 200, board.upload(upload))
      }
      if (url.pathname === '/api/dispatch/assignments') {
        const item = body as { id?: unknown; assigned?: unknown } | undefined
        if (!item || typeof item.id !== 'string' || item.id.length > 36 || typeof item.assigned !== 'boolean') {
          return json(response, 400, { error: 'Choose a checklist item and a status.' })
        }
        if (!board.setAssigned(item.id, item.assigned)) return json(response, 404, { error: 'Delivery was not found.' })
        return json(response, 200, { assigned: item.assigned })
      }
      return json(response, 404, { error: 'Checklist action was not found.' })
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Method not allowed.' })
    if (url.pathname === '/' || url.pathname === '/index.html') {
      response.writeHead(200, { 'Content-Type': mime['.html'], 'Cache-Control': 'no-store' })
      return response.end(request.method === 'HEAD' ? undefined : shell)
    }
    const file = resolve(dist, '.' + decodeURIComponent(url.pathname))
    if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile()) {
      return json(response, 404, { error: 'File was not found.' })
    }
    response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' })
    if (request.method === 'HEAD') return response.end()
    createReadStream(file).on('error', () => response.destroy()).pipe(response)
  }

  const listener = (request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response).catch(() => {
      if (response.headersSent) response.destroy()
      else json(response, 500, { error: 'The warehouse checklist could not complete the request.' })
    })
  }
  const server = options.certificates ? httpsServer(options.certificates, listener) : httpServer(listener)
  try {
    await new Promise<void>((success, failure) => {
      server.once('error', failure)
      server.listen(port, host, () => { server.off('error', failure); success() })
    })
  } catch (failure) { board.close(); throw failure }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The workplace server could not open a network address.')
  origin ||= `http://${host === '::1' ? '[::1]' : host}:${address.port}`
  return {
    url: origin, async close() {
      await new Promise<void>((success, failure) => server.close(error => error ? failure(error) : success()))
      board.close()
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { WORKPLACE_ACCOUNTS_FILE, WORKPLACE_DATA_DIR, WORKPLACE_COMPANY_FILE, WORKPLACE_ORIGIN, WORKPLACE_HOST,
    WORKPLACE_PORT, WORKPLACE_CERT, WORKPLACE_KEY } = process.env
  if (!WORKPLACE_ACCOUNTS_FILE || !WORKPLACE_DATA_DIR || Boolean(WORKPLACE_CERT) !== Boolean(WORKPLACE_KEY)) {
    throw new Error('Set WORKPLACE_ACCOUNTS_FILE and WORKPLACE_DATA_DIR. Configure both TLS files for a network deployment.')
  }
  const workplace = await startWorkplace({
    accounts: JSON.parse(readFileSync(WORKPLACE_ACCOUNTS_FILE, 'utf8')),
    dataDir: WORKPLACE_DATA_DIR, dist: 'dist', port: Number(WORKPLACE_PORT ?? 8787),
    host: WORKPLACE_HOST, origin: WORKPLACE_ORIGIN,
    rules: WORKPLACE_COMPANY_FILE ? readCompanyRules(JSON.parse(readFileSync(WORKPLACE_COMPANY_FILE, 'utf8'))) : undefined,
    certificates: WORKPLACE_CERT && WORKPLACE_KEY ? { cert: readFileSync(WORKPLACE_CERT), key: readFileSync(WORKPLACE_KEY) } : undefined,
  })
  console.log(`Warehouse checklist available at ${workplace.url}`)
}

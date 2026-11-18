import { initialWorkspace, type Workspace } from './workspace'

type Update = (state: Workspace) => Workspace
export interface WorkspaceRepository {
  load(): Promise<Workspace>
  update(change: Update): Promise<Workspace>
  putImage(id: string, blob: Blob): Promise<void>
  getImage(id: string): Promise<Blob | undefined>
  subscribe(listener: () => void): () => void
  durable: boolean
}

const databaseName = 'manchester-route-finder'
function request<T>(operation: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result)
    operation.onerror = () => reject(operation.error)
  })
}
function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('Local save was interrupted.'))
  })
}

async function indexedRepository(): Promise<WorkspaceRepository> {
  if (!globalThis.indexedDB) throw new Error('IndexedDB unavailable')
  const opening = indexedDB.open(databaseName, 1)
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore('app')
    opening.result.createObjectStore('images')
  }
  const database = await request(opening)
  database.onversionchange = () => database.close()
  const events = typeof BroadcastChannel === 'function' ? new BroadcastChannel(databaseName) : undefined
  const initial = initialWorkspace()
  return {
    durable: true,
    async load() {
      return await request(database.transaction('app').objectStore('app').get('workspace')) ?? initial
    },
    async update(change) {
      const transaction = database.transaction('app', 'readwrite')
      const done = transactionDone(transaction)
      const app = transaction.objectStore('app')
      // Apply and enqueue the write inside the IDB callback, including on Safari.
      const updated = new Promise<Workspace>((resolve, reject) => {
        const read = app.get('workspace')
        read.onerror = () => reject(read.error)
        read.onsuccess = () => {
          try {
            const current: Workspace = read.result ?? initial
            const next = change(current)
            if (next !== current) {
              const committed = { ...next, revision: current.revision + 1 }
              app.put(committed, 'workspace')
              resolve(committed)
            } else resolve(current)
          } catch (error) {
            transaction.abort()
            reject(error)
          }
        }
      })
      const [state] = await Promise.all([updated, done])
      events?.postMessage(state.revision)
      return state
    },
    async putImage(id, blob) {
      // Store bytes so WebKit can persist files from the browser's temporary picker storage.
      const image = { bytes: await blob.arrayBuffer(), type: blob.type }
      const transaction = database.transaction('images', 'readwrite')
      const done = transactionDone(transaction)
      transaction.objectStore('images').put(image, id)
      await done
    },
    async getImage(id) {
      const stored: Blob | { bytes: ArrayBuffer; type: string } | undefined = await request(database.transaction('images').objectStore('images').get(id))
      return !stored || stored instanceof Blob ? stored : new Blob([stored.bytes], { type: stored.type })
    },
    subscribe(listener) {
      events?.addEventListener('message', listener)
      return () => events?.removeEventListener('message', listener)
    },
  }
}

function memoryRepository(): WorkspaceRepository {
  let state = initialWorkspace()
  const images = new Map<string, Blob>()
  return {
    durable: false,
    async load() { return state },
    async update(change) {
      const next = change(state)
      if (next !== state) state = { ...next, revision: state.revision + 1 }
      return state
    },
    async putImage(id, blob) { images.set(id, blob) },
    async getImage(id) { return images.get(id) },
    subscribe() { return () => {} },
  }
}

let repository: Promise<WorkspaceRepository> | undefined
export function openWorkspace() {
  repository ??= indexedRepository().then(async store => {
    await store.load()
    return store
  }).catch(memoryRepository)
  return repository
}

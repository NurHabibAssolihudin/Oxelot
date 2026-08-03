import { Oxelot } from '@oxelot/core'

declare global {
  interface Window {
    __oxelot?: { Oxelot: typeof Oxelot }
  }
}

window.__oxelot = { Oxelot }

const root = document.getElementById('root')
if (!root) throw new Error('missing root')

const status = document.createElement('pre')
root.append(status)

const log = (line: string): void => {
  status.textContent += line + '\n'
}

log('initializing Oxelot…')

Oxelot.init({ workers: 2, dbName: 'playground.db' })
  .then(async (oxelot) => {
    log(`ready: backend=${oxelot.storage.backend}`)
    await oxelot.storage.set('greeting', 'hello from oxelot')
    const v = await oxelot.storage.get<string>('greeting')
    log(`storage round-trip: ${String(v)}`)
    const file = await oxelot.storage.open('demo.bin')
    await file.writeBytes(0, new Uint8Array([1, 2, 3, 4]))
    await file.sync()
    const size = await file.size()
    log(`file size: ${size}`)
    await file.close()
    await oxelot.storage.remove('demo.bin')

    await oxelot.db.run('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT)')
    await oxelot.db.run('INSERT INTO notes (text) SELECT ?1 WHERE NOT EXISTS (SELECT 1 FROM notes WHERE text = ?1)', [
      'hello db',
    ])
    const rows = await oxelot.db.query<{ id: number; text: string }>('SELECT id, text FROM notes ORDER BY id')
    log(`db round-trip: ${rows.map((r) => r.text).join(',')}`)
    log(`db rows persisted: ${rows.length}`)
    await oxelot.db.checkpoint()

    log('playground smoke test complete')
  })
  .catch((err: unknown) => {
    log(`ERROR: ${err instanceof Error ? err.message : String(err)}`)
  })

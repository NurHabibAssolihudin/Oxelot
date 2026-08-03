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
    log('playground smoke test complete')
  })
  .catch((err: unknown) => {
    log(`ERROR: ${err instanceof Error ? err.message : String(err)}`)
  })

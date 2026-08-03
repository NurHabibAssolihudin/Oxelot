import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Oxelot } from '@oxelot/core'
import { useOxelot, useOxelotStorage, useOxelotDB, useOxelotSyncStatus } from '@oxelot/react'

declare global {
  interface Window {
    __oxelot?: { Oxelot: typeof Oxelot }
  }
}

window.__oxelot = { Oxelot }

interface LogLine {
  id: number
  text: string
}

function useLog(): { lines: LogLine[]; log: (line: string) => void } {
  const [lines, setLines] = useState<LogLine[]>([])
  const log = useCallback((text: string): void => {
    setLines((prev) => (prev.some((l) => l.text === text) ? prev : [...prev, { id: prev.length, text }]))
  }, [])
  return { lines, log }
}

function App() {
  const oxelot = useOxelot({ workers: 2, dbName: 'playground.db' })
  const { lines, log } = useLog()

  useEffect(() => {
    if (oxelot) log(`ready: backend=${oxelot.storage.backend}`)
  }, [oxelot, log])

  // Storage round-trip via useOxelotStorage (re-renders on storage-change).
  const storage = useOxelotStorage<{ greeting: string }>('greeting', oxelot)
  const storageLoaded = !storage.loading
  const storageData = storage.data
  const storageError = storage.error
  useEffect(() => {
    if (!oxelot) return
    if (!storageLoaded) return
    if (storageData) {
      log(`storage round-trip: ${storageData.greeting}`)
    } else if (storageError) {
      log(`storage error: ${storageError.message}`)
    } else {
      void storage.write({ greeting: 'hello from oxelot' })
    }
  }, [oxelot, storageLoaded, storageData, storageError, log])

  // File write/read + remove (once).
  const fileDoneRef = useRef(false)
  useEffect(() => {
    if (!oxelot || fileDoneRef.current) return
    fileDoneRef.current = true
    void (async () => {
      const file = await oxelot.storage.open('demo.bin')
      await file.writeBytes(0, new Uint8Array([1, 2, 3, 4]))
      await file.sync()
      const size = await file.size()
      log(`file size: ${size}`)
      await file.close()
      await oxelot.storage.remove('demo.bin')
    })()
  }, [oxelot, log])

  // SQLite via useOxelotDB: seed + query (once, in order).
  const [seeded, setSeeded] = useState(false)
  useEffect(() => {
    if (!oxelot || seeded) return
    void (async () => {
      await oxelot.db.run('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT)')
      await oxelot.db.run('INSERT INTO notes (text) SELECT ?1 WHERE NOT EXISTS (SELECT 1 FROM notes WHERE text = ?1)', [
        'hello db',
      ])
      await oxelot.db.checkpoint()
      setSeeded(true)
    })()
  }, [oxelot, seeded])

  const db = useOxelotDB(
    async (db) => db.query<{ id: number; text: string }>('SELECT id, text FROM notes ORDER BY id'),
    [seeded],
    oxelot,
  )
  const dbResult = db.result
  const dbLoaded = !db.loading
  const loggedDbRef = useRef('')
  useEffect(() => {
    if (!dbResult || !dbLoaded) return
    if (dbResult.length === 0) return // pre-seed empty query; nothing to log yet
    const summary = dbResult.map((r) => r.text).join(',')
    if (loggedDbRef.current !== `${summary}|${dbResult.length}`) {
      loggedDbRef.current = `${summary}|${dbResult.length}`
      log(`db round-trip: ${summary}`)
      log(`db rows persisted: ${dbResult.length}`)
    }
  }, [dbResult, dbLoaded, log])

  const sync = useOxelotSyncStatus(oxelot)
  useEffect(() => {
    if (sync.state.kind !== 'idle') {
      log(`sync state: ${sync.state.kind}`)
    }
  }, [sync.state, log])

  const smokeLoggedRef = useRef(false)
  useEffect(() => {
    if (storageData && dbResult && dbResult.length >= 1 && !storage.loading && !db.loading && !smokeLoggedRef.current) {
      smokeLoggedRef.current = true
      log('playground smoke test complete')
    }
  }, [storageData, dbResult, storage.loading, db.loading, log])

  return (
    <pre>
      {lines.map((l) => (
        <div key={l.id}>{l.text}</div>
      ))}
    </pre>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('missing root')

createRoot(root).render(<App />)

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Oxelot } from '@oxelot/core'
import type { Oxelot as OxelotInstance, HardwareCapabilities } from '@oxelot/core'
import { useOxelot, useOxelotStorage, useOxelotDB, useOxelotSyncStatus } from '@oxelot/react'

declare global {
  interface Window {
    __oxelot?: { Oxelot: typeof Oxelot }
  }
}

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

/* ------------------------------------------------------------------ */
/* Smoke panel — the original automated-test flow. Its <pre> output is */
/* asserted verbatim by packages/e2e/smoke.spec.ts; do not reword.     */
/* ------------------------------------------------------------------ */

function SmokePanel({ oxelot }: { oxelot: OxelotInstance | null }): ReactNode {
  const { lines, log } = useLog()

  useEffect(() => {
    if (oxelot) log(`ready: backend=${oxelot.storage.backend}`)
  }, [oxelot, log])

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
    <section>
      <h2>Automated smoke flow</h2>
      <p className="muted">Output asserted by the e2e suite.</p>
      <pre>
        {lines.map((l) => (
          <div key={l.id}>{l.text}</div>
        ))}
      </pre>
    </section>
  )
}

/* ------------------------------ Storage --------------------------- */

function StoragePanel({ oxelot }: { oxelot: OxelotInstance | null }): ReactNode {
  const [key, setKey] = useState('inventory')
  const store = useOxelotStorage<Record<string, unknown>>(key, oxelot)
  const [sku, setSku] = useState('SKU-001')
  const [qty, setQty] = useState('42')

  return (
    <section>
      <h2>Key/value storage</h2>
      <p className="muted">Optimistic write, persisted to OPFS/IndexedDB, enqueued for background sync.</p>
      <label>
        key <input value={key} onChange={(e) => setKey(e.target.value)} />
      </label>
      {store.error && <p role="alert" className="err">{store.error.message}</p>}
      <pre>{store.loading ? 'loading…' : JSON.stringify(store.data, null, 2)}</pre>
      <div className="row">
        <input value={sku} onChange={(e) => setSku(e.target.value)} aria-label="sku" />
        <input value={qty} onChange={(e) => setQty(e.target.value)} aria-label="qty" size={6} />
        <button
          onClick={() => {
            void store.write({ ...(store.data ?? {}), [sku]: Number(qty) })
          }}
        >
          write
        </button>
        <button onClick={() => void store.remove()}>remove</button>
      </div>
    </section>
  )
}

/* -------------------------------- DB ------------------------------ */

function DbPanel({ oxelot }: { oxelot: OxelotInstance | null }): ReactNode {
  const [text, setText] = useState('')
  const notes = useOxelotDB(
    async (db) => db.query<{ id: number; text: string }>('SELECT id, text FROM notes ORDER BY id'),
    [],
    oxelot,
  )

  const addNote = async (): Promise<void> => {
    if (!oxelot || !text.trim()) return
    await oxelot.db.run('INSERT INTO notes (text) VALUES (?1)', [text.trim()])
    setText('')
    notes.refresh()
  }

  return (
    <section>
      <h2>SQLite (WASM)</h2>
      <p className="muted">Queries run inside a worker; the main thread never blocks.</p>
      {notes.error && <p role="alert" className="err">{notes.error.message}</p>}
      <ul className="list">
        {(notes.result ?? []).map((n) => (
          <li key={n.id}>{n.text}</li>
        ))}
      </ul>
      <div className="row">
        <input
          value={text}
          placeholder="new note"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addNote()
          }}
        />
        <button onClick={() => void addNote()}>insert</button>
        <button onClick={notes.refresh}>refresh</button>
      </div>
    </section>
  )
}

/* ------------------------------- Sync ------------------------------ */

function SyncPanel({ oxelot }: { oxelot: OxelotInstance | null }): ReactNode {
  const sync = useOxelotSyncStatus(oxelot)
  const [msg, setMsg] = useState('')
  const label =
    sync.state.kind === 'idle'
      ? 'in sync'
      : sync.state.kind === 'dead_letter'
        ? `${sync.deadLetters} dead letters`
        : `${sync.pending} pending (${sync.state.kind})`

  return (
    <section>
      <h2>Background sync</h2>
      <p className="muted">
        Mutations survive reloads in an IndexedDB queue and drain through the service worker when connectivity returns.
      </p>
      <p>
        queue: <strong>{label}</strong>
      </p>
      <div className="row">
        <button onClick={() => void sync.flush()} disabled={sync.state.kind === 'syncing'}>
          flush now
        </button>
        <button
          onClick={() => {
            if (!oxelot) return
            void Oxelot.enqueue(oxelot, {
              id: crypto.randomUUID(),
              schemaVersion: 1,
              collection: 'demo',
              op: 'upsert',
              payload: { hello: 'offline world', at: Date.now() },
              createdAt: Date.now(),
              attempts: 0,
            })
            setMsg('enqueued one demo mutation')
          }}
        >
          enqueue demo mutation
        </button>
      </div>
      {msg && <p className="muted">{msg}</p>}
    </section>
  )
}

/* ----------------------------- Hardware ---------------------------- */

function HardwarePanel({ oxelot }: { oxelot: OxelotInstance | null }): ReactNode {
  const [caps, setCaps] = useState<HardwareCapabilities | null>(null)
  const [out, setOut] = useState('')

  useEffect(() => {
    if (!oxelot) return
    void oxelot.hardware.capabilities().then(setCaps)
  }, [oxelot])

  return (
    <section>
      <h2>Hardware (Fugu APIs)</h2>
      <p className="muted">Truth table for this browser; acquire() maps native permission prompts.</p>
      {caps && (
        <table>
          <tbody>
            {Object.entries(caps).map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{v ? 'yes' : 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row">
        <button
          onClick={() => {
            if (!oxelot) return
            void oxelot.hardware
              .acquire('vibration')
              .then(() => setOut('vibration: ok'))
              .catch((e: unknown) => setOut(`vibration: ${(e as { code?: string }).code ?? 'error'}`))
          }}
        >
          vibrate
        </button>
      </div>
      {out && <p>{out}</p>}
    </section>
  )
}

/* ------------------------------ Daemon ------------------------------ */

type DaemonState = 'idle' | 'connecting' | 'ready' | 'disconnected'

function DaemonPanel(): ReactNode {
  const [url, setUrl] = useState('ws://127.0.0.1:9090')
  const [bridge, setBridge] = useState<OxelotInstance['daemon']>(null)
  const [state, setState] = useState<DaemonState>('idle')
  const [caps, setCaps] = useState<string[]>([])
  const [out, setOut] = useState('')
  const [own, setOwn] = useState<OxelotInstance | null>(null)

  const connect = async (): Promise<void> => {
    setState('connecting')
    setOut('')
    const inst = own ?? (await Oxelot.init({ workers: 1, dbName: 'playground-daemon.db', daemon: { url } }))
    setOwn(inst)
    const d = inst.daemon
    if (!d) {
      setState('idle')
      return
    }
    d.onStateChange((s) => {
      setState(s)
      if (s === 'ready') setCaps(d.capabilities().map((c) => c.cap))
    })
    setBridge(d)
    try {
      await d.connect()
    } catch (e) {
      setOut(`connect failed: ${(e as Error).message} (is the daemon running?)`)
    }
  }

  useEffect(
    () => () => {
      void own?.dispose()
    },
    [own],
  )

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      setOut(JSON.stringify(await fn()))
    } catch (e) {
      setOut(`${(e as { code?: string }).code ?? 'error'}: ${(e as Error).message}`)
    }
  }

  const grantedClick = (cap: string, fn: () => Promise<unknown>): void => {
    void run(async () => {
      bridge?.grant(cap) // must happen inside the click gesture
      return fn()
    })
  }

  return (
    <section>
      <h2>Local daemon bridge</h2>
      <p className="muted">
        Out-of-browser hardware over ws://127.0.0.1 (ADR-07). Start an oxelot daemon locally, or watch the graceful
        error path.
      </p>
      <div className="row">
        <input value={url} onChange={(e) => setUrl(e.target.value)} aria-label="daemon url" />
        <button onClick={() => void connect()}>connect</button>
        <span>
          state: <strong>{state}</strong>
        </span>
      </div>
      {bridge && state === 'ready' && (
        <>
          <p>capabilities: {caps.join(', ') || '(none advertised)'}</p>
          <div className="row">
            <button onClick={() => void run(() => bridge.request('sys:stats'))}>sys:stats</button>
            <button onClick={() => void run(() => bridge.serial.list())}>serial:list</button>
            <button onClick={() => grantedClick('serial:open', () => bridge.serial.open('/dev/ttyUSB0', 115200))}>
              serial:open
            </button>
            <button
              onClick={() =>
                grantedClick('serial:read', async () => {
                  const r = await bridge.serial.read('h1', 64)
                  return r
                })
              }
            >
              serial:read
            </button>
            <button
              onClick={() =>
                grantedClick('serial:write', () => bridge.serial.write('h1', 'hello'))
              }
            >
              serial:write
            </button>
          </div>
        </>
      )}
      {out && <pre>{out}</pre>}
    </section>
  )
}

/* -------------------------------- Shell ----------------------------- */

const TABS = ['Smoke', 'Storage', 'Database', 'Sync', 'Hardware', 'Daemon'] as const
type Tab = (typeof TABS)[number]

function App(): ReactNode {
  const oxelot = useOxelot({ workers: 2, dbName: 'playground.db' })
  const [tab, setTab] = useState<Tab>('Smoke')

  return (
    <main>
      <header>
        <h1>Oxelot playground</h1>
        <span className="badge">{oxelot ? 'connected' : 'booting…'}</span>
      </header>
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      {tab === 'Smoke' && <SmokePanel oxelot={oxelot} />}
      {tab === 'Storage' && <StoragePanel oxelot={oxelot} />}
      {tab === 'Database' && <DbPanel oxelot={oxelot} />}
      {tab === 'Sync' && <SyncPanel oxelot={oxelot} />}
      {tab === 'Hardware' && <HardwarePanel oxelot={oxelot} />}
      {tab === 'Daemon' && <DaemonPanel />}
      <footer className="muted">@oxelot/core demo — docs at docs/10-user-guide.md</footer>
    </main>
  )
}

export default App

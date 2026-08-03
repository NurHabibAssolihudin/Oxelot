/**
 * G1 heavy workload (Chapter 8 §8.4.2): a ~30s scripted loop driving storage
 * (kv + file), db (run/query), and bridge round-trips from inside the page.
 * Runs entirely on the main thread via the public facade; the long-task
 * collector observes main-thread stalls.
 */
import type { OxelotLike } from './oxelot-like'

export async function runHeavyWorkload(oxelot: OxelotLike, durationMs = 30_000): Promise<void> {
  const deadline = performance.now() + durationMs
  let i = 0
  while (performance.now() < deadline) {
    // KV round-trip.
    await oxelot.storage.set(`perf-kv-${i % 8}`, { n: i })
    await oxelot.storage.get(`perf-kv-${i % 8}`)

    // File write/read round-trip.
    const file = await oxelot.storage.open(`perf-${i % 4}.bin`)
    const buf = new Uint8Array(4096)
    buf.fill(i % 256)
    await file.writeBytes(0, buf)
    await file.sync()
    await file.readBytes(0, 4096)
    await file.close()

    // SQLite run/query (wasm; lazy-loaded on first call).
    await oxelot.db.run('INSERT INTO perf (n) VALUES (?1)', [i])
    await oxelot.db.query('SELECT COUNT(*) AS c FROM perf')

    // Bridge round-trip.
    await oxelot.pool.request('ping')

    i++
  }
}

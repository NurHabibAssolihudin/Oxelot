/**
 * M3.4 fuzz gate: run the daemon schema + handshake fuzz harness at full depth.
 * Fuzzes `parseDaemonMessage` with ≥ 1M malformed frames and asserts the
 * connection can never reach `ready` on garbage (§5.4.5.6).
 *
 * The harness lives in `packages/core/test/fuzz-daemon.test.ts` and runs at
 * smoke depth in the default suite; this script flips `FUZZ_DAEMON=1` so the
 * same tests run at full iteration counts.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const cli = require.resolve('vitest/vitest.mjs')

const res = spawnSync(process.execPath, [cli, 'run', 'packages/core/test/fuzz-daemon.test.ts'], {
  env: { ...process.env, FUZZ_DAEMON: '1' },
  stdio: 'inherit',
})
process.exit(res.status ?? 1)

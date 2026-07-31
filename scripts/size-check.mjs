import { readFileSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CORE_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'core', 'dist')
const LIMIT_BYTES = 35 * 1024 // G7: @oxelot/core ≤ 35 KB gzip, excluding .wasm

function gzipBytes(file) {
  const buf = readFileSync(join(CORE_DIST, file))
  return gzipSync(buf).length
}

const esm = join(CORE_DIST, 'index.js')
const cjs = join(CORE_DIST, 'index.cjs')

if (!statSync(esm).isFile() || !statSync(cjs).isFile()) {
  console.error('dist missing; run `npm run build` first')
  process.exit(1)
}

const esmGzip = gzipBytes('index.js')
const cjsGzip = gzipBytes('index.cjs')
const smallest = Math.min(esmGzip, cjsGzip)

console.log(`index.js gzip: ${esmGzip} B`)
console.log(`index.cjs gzip: ${cjsGzip} B`)
console.log(`budget: ${LIMIT_BYTES} B (G7)`)

if (smallest > LIMIT_BYTES) {
  console.error(`FAIL: smallest build ${smallest} B exceeds ${LIMIT_BYTES} B budget`)
  process.exit(1)
}
console.log('PASS: bundle within G7 budget (excluding .wasm assets)')

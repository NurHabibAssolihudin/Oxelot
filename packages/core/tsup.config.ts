import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    sw: 'src/sw.ts',
    worker: 'src/worker-entry.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  treeshake: true,
  target: 'es2022',
  // Do not wipe the whole outDir: the compiled `.wasm` SQLite asset lives in
  // `dist/wasm/` (built by `npm run build:wasm`) and must survive JS rebuilds.
  // With `splitting: false` each entry is a single stable-named file, so stale
  // outputs are not a concern.
  clean: false,
  // Each entry must be self-contained: the SW is copied to the consumer's
  // public dir and the worker is fetched via `new URL(..., import.meta.url)`,
  // so neither can rely on sibling chunk files being served.
  splitting: false,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
})

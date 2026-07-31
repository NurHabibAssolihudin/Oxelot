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
  clean: true,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
})

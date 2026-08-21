import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace package to its TypeScript source so unit tests
      // run hermetically without a prior `npm run build`.
      '@oxelot/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**/*.ts'],
      thresholds: { statements: 80, branches: 75, functions: 80, lines: 80 },
    },
  },
})

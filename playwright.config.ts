import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './packages/e2e',
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5199',
    serviceWorkers: 'allow',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', testMatch: /opfs|hardware/, use: { browserName: 'webkit' } },
    // Optional 3-browser matrix (M2.5 slice 5.2): run with
    // `PW_MATRIX=1 npx playwright install firefox && PW_MATRIX=1 npx playwright test`.
    ...(process.env.PW_MATRIX === '1'
      ? [{ name: 'firefox', testMatch: /hardware/, use: { browserName: 'firefox' } }]
      : []),
  ],
  webServer: {
    command: 'npx vite --port 5199 --strictPort',
    url: 'http://localhost:5199',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})

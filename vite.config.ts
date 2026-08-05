import { defineConfig } from 'vite'
import type { Connect, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'

// Serve the built service worker (packages/core/dist/sw.js) at /sw.js so
// `navigator.serviceWorker.register('./sw.js')` works from the playground dev
// server. Without this, Vite's SPA fallback would return index.html for the
// path and SW registration would fail (wrong MIME type).
function serveBuiltSw(): Plugin {
  const swPath = resolve(__dirname, 'packages/core/dist/sw.js')
  return {
    name: 'oxelot-serve-sw',
    configureServer(server) {
      server.middlewares.use('/sw.js', (req, res) => {
        res.setHeader('content-type', 'text/javascript')
        createReadStream(swPath).pipe(res)
      })
    },
  }
}

// E2E fixture for the sync relay: a same-origin sync endpoint the service worker
// can flush to (Chromium SWs can fetch same-origin reliably), plus a log that
// tests read/reset. Kept out of the library; the SW is only reachable same-origin
// here, so sync delivery is asserted from the recorded bodies.
const syncLog: string[] = []

function syncFixture(): Plugin {
  const handle = (req: Connect.IncomingMessage, res: Connect.ServerResponse): void => {
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => {
        body += String(chunk)
      })
      req.on('end', () => {
        syncLog.push(body)
        res.statusCode = 204
        res.end()
      })
      return
    }
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(syncLog))
      return
    }
    if (req.method === 'DELETE') {
      syncLog.length = 0
      res.statusCode = 204
      res.end()
      return
    }
    res.statusCode = 404
    res.end()
  }
  return {
    name: 'oxelot-sync-fixture',
    configureServer(server) {
      server.middlewares.use('/__oxelot_sync', handle)
    },
  }
}

export default defineConfig({
  root: 'playground',
  plugins: [react(), serveBuiltSw(), syncFixture()],
})
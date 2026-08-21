import { createRoot } from 'react-dom/client'
import { Oxelot } from '@oxelot/core'
import App from './App'
import './style.css'

declare global {
  interface Window {
    __oxelot?: { Oxelot: typeof Oxelot }
  }
}

window.__oxelot = { Oxelot }

const root = document.getElementById('root')
if (!root) throw new Error('missing root')

createRoot(root).render(<App />)

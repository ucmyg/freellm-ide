import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// Side-effecting: points Monaco at the bundled copy before any editor mounts.
import './monaco-setup'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root missing from index.html')

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

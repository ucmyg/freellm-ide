import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import Resizer from './Resizer'

const MIN_HEIGHT = 100
const MAX_HEIGHT = 600

export default function TerminalPane() {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const idRef = useRef<string | null>(null)
  const [height, setHeight] = useState(220)
  const [error, setError] = useState<string | null>(null)
  const setTerminalOpen = useStore((s) => s.setTerminalOpen)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      fontSize: 12,
      fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: '#0e1013',
        foreground: '#dfe3ea',
        cursor: '#e8a33d',
        black: '#15181d',
        red: '#e56a6a',
        green: '#4fbf7b',
        yellow: '#e0b341',
        blue: '#5aa9e6',
        magenta: '#b48ead',
        cyan: '#7fd0e0',
        white: '#dfe3ea',
        selectionBackground: '#2a3340',
      },
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(el)
    fit.fit()

    termRef.current = term
    fitRef.current = fit

    let disposed = false

    void window.ide.terminal.create(term.cols, term.rows).then((res) => {
      if (!res.ok) {
        setError(res.error)
        term.writeln(`\x1b[31m${res.error}\x1b[0m`)
        return
      }
      // The pane can unmount while the shell is still spawning.
      if (disposed) {
        window.ide.terminal.dispose(res.value.id)
        return
      }
      idRef.current = res.value.id
      term.focus()
    })

    const offData = window.ide.terminal.onEvent((event) => {
      if (event.id !== idRef.current) return
      if (event.type === 'data') term.write(event.data)
      else term.writeln(`\r\n\x1b[90m[process exited with code ${event.exitCode}]\x1b[0m`)
    })

    const offInput = term.onData((data) => {
      if (idRef.current) window.ide.terminal.write(idRef.current, data)
    })

    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
        if (idRef.current) window.ide.terminal.resize(idRef.current, term.cols, term.rows)
      } catch {
        // fit() throws when the element is momentarily zero-sized
      }
    })
    observer.observe(el)

    return () => {
      disposed = true
      observer.disconnect()
      offData()
      offInput.dispose()
      if (idRef.current) window.ide.terminal.dispose(idRef.current)
      term.dispose()
    }
  }, [])

  // Refit after a drag so the shell's idea of the size matches the pane.
  useEffect(() => {
    try {
      fitRef.current?.fit()
      const term = termRef.current
      if (term && idRef.current) window.ide.terminal.resize(idRef.current, term.cols, term.rows)
    } catch {
      // as above
    }
  }, [height])

  return (
    <>
      <Resizer
        orientation="horizontal"
        onResize={(d) => setHeight((h) => Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, h - d)))}
      />
      <div
        style={{ height }}
        className="flex shrink-0 flex-col border-t border-[var(--color-border)] bg-[var(--color-bg)]"
      >
        <div className="flex h-[28px] shrink-0 items-center justify-between border-b border-[var(--color-border)] px-2">
          <span className="pane-label">
            Terminal
            {error && <span className="ml-1 text-[var(--color-danger)]">— {error}</span>}
          </span>
          <button
            onClick={() => setTerminalOpen(false)}
            title="Close terminal (Ctrl+`)"
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-faint)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
          >
            <X size={13} />
          </button>
        </div>
        <div ref={containerRef} className="selectable min-h-0 flex-1 px-2 py-1" />
      </div>
    </>
  )
}

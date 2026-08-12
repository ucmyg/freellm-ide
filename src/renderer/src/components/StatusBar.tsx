import { CircleDot, Loader2, ShieldAlert, Square, TerminalSquare } from 'lucide-react'
import { useEffect, useState } from 'react'
import { PERMISSION_MODE_INFO, type ProcessInfo } from '@shared/types'
import { isDirty, useStore } from '../store'

export default function StatusBar() {
  const workspaceRoot = useStore((s) => s.workspaceRoot)
  const tabs = useStore((s) => s.tabs)
  const activeTab = useStore((s) => s.activeTab)
  const isStreaming = useStore((s) => s.isStreaming)
  const settings = useStore((s) => s.settings)
  const terminalOpen = useStore((s) => s.terminalOpen)
  const setTerminalOpen = useStore((s) => s.setTerminalOpen)

  const tab = tabs.find((t) => t.path === activeTab)
  const dirtyCount = tabs.filter(isDirty).length
  const elevated = settings?.permissionMode === 'full' || settings?.fullDiskAccess

  return (
    <footer className="flex h-[24px] shrink-0 items-center gap-2.5 border-t border-[var(--color-border)] bg-[var(--color-bg-raised)] px-2 text-[11px] text-[var(--color-text-faint)]">
      <button
        onClick={() => setTerminalOpen(!terminalOpen)}
        title="Toggle terminal (Ctrl+`)"
        className={`flex items-center gap-1 rounded px-1 transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] ${
          terminalOpen ? 'text-[var(--color-text-muted)]' : ''
        }`}
      >
        <TerminalSquare size={11} />
        Terminal
      </button>

      <ProcessIndicator />

      {tab && (
        <span className="truncate text-[var(--color-text-muted)]" title={tab.path}>
          {tab.path}
          {isDirty(tab) && <span className="text-[var(--color-accent)]"> ●</span>}
        </span>
      )}

      <span className="ml-auto flex items-center gap-2.5">
        {dirtyCount > 0 && <span>{dirtyCount} unsaved</span>}

        {isStreaming && (
          <span className="flex items-center gap-1 text-[var(--color-accent)]">
            <Loader2 size={11} className="animate-spin" />
            working
          </span>
        )}

        {settings && (
          <button
            onClick={() => useStore.getState().setSettingsOpen(true)}
            title={PERMISSION_MODE_INFO[settings.permissionMode].hint}
            className={`flex items-center gap-1 rounded px-1 transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] ${
              elevated ? 'text-[var(--color-warn)]' : ''
            }`}
          >
            {elevated && <ShieldAlert size={11} />}
            {PERMISSION_MODE_INFO[settings.permissionMode].label}
            {settings.fullDiskAccess && ' · full disk'}
          </button>
        )}

        <button
          onClick={() => useStore.getState().setSettingsOpen(true)}
          className="flex items-center gap-1 rounded px-1 transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
          title={settings?.hasApiKey ? `Gateway: ${settings.baseUrl}` : 'No API key set'}
        >
          <CircleDot
            size={10}
            className={settings?.hasApiKey ? 'text-[var(--color-ok)]' : 'text-[var(--color-danger)]'}
          />
          {settings?.model || 'auto'}
        </button>

        {workspaceRoot && (
          <span className="max-w-[280px] truncate" title={workspaceRoot}>
            {workspaceRoot}
          </span>
        )}
      </span>
    </footer>
  )
}

/**
 * Anything the agent left running. Polled rather than pushed — a background
 * process changes state rarely, and this keeps the main process free of
 * another event channel.
 */
function ProcessIndicator() {
  const [processes, setProcesses] = useState<ProcessInfo[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const refresh = () => void window.ide.agent.processes().then(setProcesses)
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => clearInterval(timer)
  }, [])

  const running = processes.filter((p) => p.running)
  if (running.length === 0) return null

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded px-1 text-[var(--color-ok)] transition-colors hover:bg-[var(--color-bg-hover)]"
        title="Background processes the agent started"
      >
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-ok)] opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--color-ok)]" />
        </span>
        {running.length} running
      </button>

      {open && (
        <>
          {/* Click-away layer, so the popover closes like a menu should. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-[22px] left-0 z-50 w-[420px] rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-overlay)] p-1.5 shadow-xl">
            {running.map((p) => (
              <div key={p.id} className="flex items-center gap-2 rounded px-1.5 py-1">
                <span className="truncate font-[family-name:var(--font-mono)] text-[11px] text-[var(--color-text-muted)]">
                  {p.command}
                </span>
                <button
                  onClick={() => {
                    void window.ide.agent.stopProcess(p.id).then(() => {
                      void window.ide.agent.processes().then(setProcesses)
                    })
                  }}
                  title="Stop this process"
                  className="ml-auto flex shrink-0 items-center gap-1 rounded border border-[var(--color-border-strong)] px-1.5 py-0.5 text-[10px] transition-colors hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
                >
                  <Square size={8} className="fill-current" />
                  Stop
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

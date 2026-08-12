import { useCallback, useEffect } from 'react'
import AgentPanel from './components/AgentPanel'
import EditorPane from './components/EditorPane'
import Explorer from './components/Explorer'
import Resizer from './components/Resizer'
import SettingsDialog from './components/SettingsDialog'
import StatusBar from './components/StatusBar'
import TerminalPane from './components/TerminalPane'
import { useStore } from './store'

const MIN_SIDEBAR = 160
const MAX_SIDEBAR = 520
const MIN_AGENT = 300
const MAX_AGENT = 760

export default function App() {
  const sidebarWidth = useStore((s) => s.sidebarWidth)
  const agentWidth = useStore((s) => s.agentWidth)
  const setSidebarWidth = useStore((s) => s.setSidebarWidth)
  const setAgentWidth = useStore((s) => s.setAgentWidth)
  const terminalOpen = useStore((s) => s.terminalOpen)
  const setTerminalOpen = useStore((s) => s.setTerminalOpen)
  const setSettings = useStore((s) => s.setSettings)
  const setWorkspaceRoot = useStore((s) => s.setWorkspaceRoot)

  // Load persisted settings, plus any folder/file the main process opened from
  // the command line.
  useEffect(() => {
    void window.ide.settings.get().then(setSettings)
    void window.ide.workspace.current().then(async ({ root, initialFile }) => {
      if (!root) return
      setWorkspaceRoot(root)
      if (!initialFile) return

      const res = await window.ide.workspace.read(initialFile)
      if (res.ok) {
        useStore.getState().openTab({
          path: res.value.path,
          content: res.value.content,
          savedContent: res.value.content,
          language: res.value.language,
        })
      }
    })
  }, [setSettings, setWorkspaceRoot])

  const onSaveActive = useCallback(async () => {
    const { tabs, activeTab, markTabSaved } = useStore.getState()
    const tab = tabs.find((t) => t.path === activeTab)
    if (!tab) return
    const res = await window.ide.workspace.write(tab.path, tab.content)
    if (res.ok) markTabSaved(tab.path, tab.content)
    else useStore.getState().setTreeError(res.error)
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey

      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void onSaveActive()
      } else if (mod && e.key === '`') {
        e.preventDefault()
        setTerminalOpen(!useStore.getState().terminalOpen)
      } else if (mod && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        const { activeTab, closeTab } = useStore.getState()
        if (activeTab) closeTab(activeTab)
      } else if (mod && e.key === ',') {
        e.preventDefault()
        useStore.getState().setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onSaveActive, setTerminalOpen])

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
      <div className="flex min-h-0 flex-1">
        <aside
          style={{ width: sidebarWidth }}
          className="shrink-0 border-r border-[var(--color-border)] bg-[var(--color-bg-raised)]"
        >
          <Explorer />
        </aside>

        <Resizer
          orientation="vertical"
          onResize={(d) =>
            setSidebarWidth(Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, sidebarWidth + d)))
          }
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <EditorPane onSave={onSaveActive} />
          </div>
          {terminalOpen && <TerminalPane />}
        </main>

        <Resizer
          orientation="vertical"
          onResize={(d) => setAgentWidth(Math.min(MAX_AGENT, Math.max(MIN_AGENT, agentWidth - d)))}
        />

        <aside
          style={{ width: agentWidth }}
          className="shrink-0 border-l border-[var(--color-border)] bg-[var(--color-bg-raised)]"
        >
          <AgentPanel />
        </aside>
      </div>

      <StatusBar />
      <SettingsDialog />
    </div>
  )
}

import Editor from '@monaco-editor/react'
import { Circle, X } from 'lucide-react'
import { useEffect } from 'react'
import { isDirty, useStore } from '../store'
import { THEME_NAME } from '../monaco-setup'

interface Props {
  onSave(): void
}

export default function EditorPane({ onSave }: Props) {
  const tabs = useStore((s) => s.tabs)
  const activeTab = useStore((s) => s.activeTab)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const closeTab = useStore((s) => s.closeTab)
  const updateTabContent = useStore((s) => s.updateTabContent)

  const tab = tabs.find((t) => t.path === activeTab) ?? null

  // When the agent edits a file that is open, reload it so the editor never
  // shows stale text. Unsaved local edits win — we do not clobber the user.
  useEffect(() => {
    return window.ide.agent.onEvent(async (event) => {
      if (event.type !== 'files_changed') return
      for (const path of event.paths) {
        const before = useStore.getState().tabs.find((t) => t.path === path)
        if (!before || isDirty(before)) continue

        const res = await window.ide.workspace.read(path)
        if (!res.ok) continue

        // Re-check after the await: the user may have started typing while the
        // read was in flight, and "local edits win" has to still hold.
        const after = useStore.getState().tabs.find((t) => t.path === path)
        if (!after || isDirty(after)) continue
        useStore.getState().markTabSaved(path, res.value.content)
      }
    })
  }, [])

  if (!tab) {
    return (
      <div className="flex h-full flex-col">
        <TabStrip />
        <div className="flex flex-1 items-center justify-center">
          <p className="text-[12px] text-[var(--color-text-faint)]">
            Select a file, or ask the agent to find one
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <TabStrip />
      <div className="min-h-0 flex-1">
        <Editor
          // Keying on path gives each file its own model and undo stack.
          key={tab.path}
          language={tab.language}
          value={tab.content}
          theme={THEME_NAME}
          onChange={(value) => updateTabContent(tab.path, value ?? '')}
          onMount={(editor, monaco) => {
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, onSave)
          }}
          options={{
            fontSize: 13,
            fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
            fontLigatures: true,
            minimap: { enabled: true, maxColumn: 80 },
            scrollBeyondLastLine: false,
            renderWhitespace: 'selection',
            tabSize: 2,
            automaticLayout: true,
            smoothScrolling: true,
            cursorBlinking: 'smooth',
            padding: { top: 8 },
            bracketPairColorization: { enabled: true },
          }}
        />
      </div>
    </div>
  )

  function TabStrip() {
    if (tabs.length === 0) {
      return <div className="h-[35px] shrink-0 border-b border-[var(--color-border)]" />
    }
    return (
      <div className="flex h-[35px] shrink-0 items-stretch overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-bg-raised)]">
        {tabs.map((t) => {
          const active = t.path === activeTab
          const dirty = isDirty(t)
          return (
            <div
              key={t.path}
              onClick={() => setActiveTab(t.path)}
              title={t.path}
              // The 2px top rule marks the active tab; a transparent one on the
              // rest keeps every label on the same baseline.
              className={`group relative flex cursor-pointer items-center gap-2 border-r border-t-2 border-r-[var(--color-border)] pr-1.5 pl-3 text-[12px] ${
                active
                  ? 'border-t-[var(--color-accent)] bg-[var(--color-bg)] text-white'
                  : 'border-t-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'
              }`}
            >
              <span className="whitespace-nowrap">{t.path.split('/').pop()}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.path)
                }}
                title={dirty ? 'Unsaved changes — close anyway' : 'Close'}
                className="flex h-4 w-4 items-center justify-center rounded text-[var(--color-text-faint)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
              >
                {dirty ? (
                  <>
                    <Circle
                      size={8}
                      className="fill-[var(--color-accent)] text-[var(--color-accent)] group-hover:hidden"
                    />
                    <X size={12} className="hidden group-hover:block" />
                  </>
                ) : (
                  <X size={12} className="opacity-0 group-hover:opacity-100" />
                )}
              </button>
            </div>
          )
        })}
      </div>
    )
  }
}

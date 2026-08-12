import { useCallback, useEffect } from 'react'
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { useStore } from '../store'
import type { DirEntry } from '@shared/types'

const ROOT = ''

export default function Explorer() {
  const workspaceRoot = useStore((s) => s.workspaceRoot)
  const entries = useStore((s) => s.entries)
  const expanded = useStore((s) => s.expanded)
  const treeError = useStore((s) => s.treeError)
  const setEntries = useStore((s) => s.setEntries)
  const toggleExpanded = useStore((s) => s.toggleExpanded)
  const setTreeError = useStore((s) => s.setTreeError)
  const openTab = useStore((s) => s.openTab)
  const activeTab = useStore((s) => s.activeTab)

  const loadDir = useCallback(
    async (path: string) => {
      const res = await window.ide.workspace.list(path || undefined)
      if (res.ok) setEntries(path, res.value)
      else setTreeError(res.error)
    },
    [setEntries, setTreeError],
  )

  useEffect(() => {
    if (workspaceRoot) void loadDir(ROOT)
  }, [workspaceRoot, loadDir])

  // Refresh any directory the agent touched, without collapsing the tree.
  useEffect(() => {
    return window.ide.agent.onEvent((event) => {
      if (event.type !== 'files_changed') return
      const dirs = new Set<string>([ROOT])
      for (const p of event.paths) {
        const parts = p.split('/')
        parts.pop()
        dirs.add(parts.join('/'))
      }
      for (const d of dirs) if (d === ROOT || expanded.has(d)) void loadDir(d)
    })
  }, [expanded, loadDir])

  const onToggle = useCallback(
    (entry: DirEntry) => {
      const willExpand = !expanded.has(entry.path)
      toggleExpanded(entry.path)
      if (willExpand && !entries[entry.path]) void loadDir(entry.path)
    },
    [expanded, entries, toggleExpanded, loadDir],
  )

  const onOpenFile = useCallback(
    async (entry: DirEntry) => {
      const res = await window.ide.workspace.read(entry.path)
      if (!res.ok) {
        setTreeError(res.error)
        return
      }
      openTab({
        path: res.value.path,
        content: res.value.content,
        savedContent: res.value.content,
        language: res.value.language,
      })
    },
    [openTab, setTreeError],
  )

  const onOpenFolder = useCallback(async () => {
    const res = await window.ide.workspace.open()
    if (res.ok && res.value) useStore.getState().setWorkspaceRoot(res.value)
    else if (!res.ok) setTreeError(res.error)
  }, [setTreeError])

  const onCreate = useCallback(
    async (isDirectory: boolean) => {
      const name = window.prompt(isDirectory ? 'New folder path' : 'New file path')
      if (!name) return
      const res = await window.ide.workspace.create(name, isDirectory)
      if (!res.ok) setTreeError(res.error)
      else void loadDir(ROOT)
    },
    [loadDir, setTreeError],
  )

  const onDelete = useCallback(
    async (entry: DirEntry) => {
      if (!window.confirm(`Delete ${entry.path}? This cannot be undone.`)) return
      const res = await window.ide.workspace.remove(entry.path)
      if (!res.ok) {
        setTreeError(res.error)
        return
      }
      const parent = entry.path.split('/').slice(0, -1).join('/')
      void loadDir(parent)
      useStore.getState().closeTab(entry.path)
    },
    [loadDir, setTreeError],
  )

  if (!workspaceRoot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <FolderOpen size={22} className="text-[var(--color-text-faint)]" strokeWidth={1.5} />
        <p className="text-[12px] text-[var(--color-text-muted)]">No folder open</p>
        <button
          onClick={onOpenFolder}
          className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-overlay)] px-3 py-1.5 text-[12px] transition-colors hover:border-[var(--color-accent)] hover:text-white"
        >
          Open folder
        </button>
      </div>
    )
  }

  const folderName = workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? workspaceRoot

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-[35px] shrink-0 items-center gap-0.5 border-b border-[var(--color-border)] px-2">
        <span className="pane-label flex-1 truncate" title={workspaceRoot}>
          {folderName}
        </span>
        <IconButton title="New file" onClick={() => void onCreate(false)}>
          <FilePlus2 size={14} />
        </IconButton>
        <IconButton title="New folder" onClick={() => void onCreate(true)}>
          <FolderPlus size={14} />
        </IconButton>
        <IconButton title="Refresh" onClick={() => void loadDir(ROOT)}>
          <RefreshCw size={14} />
        </IconButton>
        <IconButton title="Open another folder" onClick={() => void onOpenFolder()}>
          <FolderOpen size={14} />
        </IconButton>
      </header>

      {treeError && (
        <p className="border-b border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-danger)]">
          {treeError}
        </p>
      )}

      <div className="flex-1 overflow-auto py-1">
        <Tree
          path={ROOT}
          depth={0}
          entries={entries}
          expanded={expanded}
          activeTab={activeTab}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
          onDelete={onDelete}
        />
      </div>
    </div>
  )
}

interface TreeProps {
  path: string
  depth: number
  entries: Record<string, DirEntry[]>
  expanded: Set<string>
  activeTab: string | null
  onToggle(entry: DirEntry): void
  onOpenFile(entry: DirEntry): void
  onDelete(entry: DirEntry): void
}

function Tree(props: TreeProps) {
  const list = props.entries[props.path]
  if (!list) return null

  return (
    <>
      {list.map((entry) => {
        const isOpen = props.expanded.has(entry.path)
        const isActive = props.activeTab === entry.path
        return (
          <div key={entry.path}>
            <div
              onClick={() => (entry.isDirectory ? props.onToggle(entry) : props.onOpenFile(entry))}
              className={`group flex h-[24px] cursor-pointer items-center gap-1.5 pr-1 text-[12.5px] ${
                isActive
                  ? 'bg-[var(--color-bg-overlay)] text-white'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'
              }`}
              style={{ paddingLeft: 8 + props.depth * 11 }}
              title={entry.path}
            >
              {entry.isDirectory ? (
                isOpen ? (
                  <ChevronDown size={13} className="shrink-0 text-[var(--color-text-faint)]" />
                ) : (
                  <ChevronRight size={13} className="shrink-0 text-[var(--color-text-faint)]" />
                )
              ) : (
                <FileIcon
                  size={13}
                  strokeWidth={1.5}
                  className="ml-[1px] shrink-0 text-[var(--color-text-faint)]"
                />
              )}
              <span className="flex-1 truncate">{entry.name}</span>
              <button
                title={`Delete ${entry.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  props.onDelete(entry)
                }}
                className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--color-text-faint)] hover:bg-[var(--color-bg-overlay)] hover:text-[var(--color-danger)] group-hover:flex"
              >
                <Trash2 size={12} />
              </button>
            </div>
            {entry.isDirectory && isOpen && <Tree {...props} path={entry.path} depth={props.depth + 1} />}
          </div>
        )
      })}
    </>
  )
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string
  onClick(): void
  children: React.ReactNode
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-faint)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
    >
      {children}
    </button>
  )
}

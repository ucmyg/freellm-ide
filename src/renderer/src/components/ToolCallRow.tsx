import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  FileEdit,
  FilePlus2,
  FileText,
  FolderTree,
  Info,
  ListTree,
  Loader2,
  Play,
  ScrollText,
  Search,
  Square,
  Terminal,
  Trash2,
  TriangleAlert,
  Wrench,
} from 'lucide-react'
import { useState } from 'react'
import type { ToolCallView } from '@shared/types'
import DiffView from './DiffView'

const ICONS: Record<string, typeof FileText> = {
  read_file: FileText,
  list_files: FolderTree,
  find_files: Search,
  search_files: Search,
  edit_file: FileEdit,
  write_file: FilePlus2,
  delete_file: Trash2,
  run_command: Terminal,
  start_background: Play,
  read_background: ScrollText,
  stop_background: Square,
  list_background: ListTree,
  system_info: Info,
}

/** Verb shown in the row — reads better than the raw tool name. */
const LABELS: Record<string, string> = {
  read_file: 'Read',
  list_files: 'List',
  find_files: 'Find',
  search_files: 'Search',
  edit_file: 'Edit',
  write_file: 'Write',
  delete_file: 'Delete',
  run_command: 'Run',
  start_background: 'Start',
  read_background: 'Output',
  stop_background: 'Stop',
  list_background: 'Processes',
  system_info: 'System',
}

export default function ToolCallRow({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false)
  const Icon = ICONS[call.name] ?? Wrench
  const label = LABELS[call.name] ?? call.name
  const target = describeTarget(call)
  const hasDetail = Boolean(call.detail)

  return (
    <div className="overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg-overlay)]">
      <button
        onClick={() => hasDetail && setOpen(!open)}
        className={`flex w-full items-center gap-1.5 px-1.5 py-1.5 text-left text-[12px] transition-colors ${
          hasDetail ? 'cursor-pointer hover:bg-[var(--color-bg-hover)]' : 'cursor-default'
        }`}
      >
        {hasDetail ? (
          open ? (
            <ChevronDown size={12} className="shrink-0 text-[var(--color-text-faint)]" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-[var(--color-text-faint)]" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}

        <Icon size={12.5} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-faint)]" />
        <span className="shrink-0">{label}</span>
        <span className="truncate font-[family-name:var(--font-mono)] text-[11px] text-[var(--color-text-muted)]">
          {target}
        </span>

        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1 text-[11px]">
          {call.summary && call.status !== 'running' && (
            <span className="text-[var(--color-text-faint)]">{call.summary}</span>
          )}
          <StatusIcon status={call.status} />
        </span>
      </button>

      {open && call.detail && (
        <div className="border-t border-[var(--color-border)] p-2">
          <DiffView text={call.detail} />
        </div>
      )}
    </div>
  )
}

function StatusIcon({ status }: { status: ToolCallView['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 size={12} className="animate-spin text-[var(--color-accent)]" />
    case 'ok':
      return <Check size={12} className="text-[var(--color-ok)]" />
    case 'denied':
      return <Ban size={12} className="text-[var(--color-warn)]" />
    case 'error':
      return <TriangleAlert size={12} className="text-[var(--color-danger)]" />
  }
}

/** Pull the most informative argument out for the collapsed row. */
function describeTarget(call: ToolCallView): string {
  const input = (call.input ?? {}) as Record<string, unknown>
  const candidate = input.path ?? input.command ?? input.pattern ?? input.query
  if (typeof candidate !== 'string') return ''
  return candidate.length > 70 ? `${candidate.slice(0, 70)}…` : candidate
}

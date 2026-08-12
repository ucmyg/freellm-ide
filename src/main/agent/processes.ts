import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { shellInvocation } from './shell.js'

/**
 * Long-running processes the agent starts and leaves running: dev servers,
 * watchers, tailed logs. run_command is for things that finish; this is for
 * things that don't.
 *
 * Output is buffered in a ring so a chatty server cannot grow without bound,
 * and every process is killed when the app quits.
 */

const MAX_LINES = 2000

export interface BackgroundInfo {
  id: string
  command: string
  cwd: string
  startedAt: number
  running: boolean
  exitCode: number | null
  /** Total lines produced, including any already dropped from the ring. */
  totalLines: number
}

interface Entry extends BackgroundInfo {
  child: ChildProcess
  lines: string[]
  /** Index in the overall stream of lines[0], so cursors survive trimming. */
  firstLineIndex: number
  partial: string
}

const processes = new Map<string, Entry>()

function append(entry: Entry, chunk: string): void {
  const text = entry.partial + chunk
  const parts = text.split('\n')
  // The last element is an unterminated line; hold it until more arrives.
  entry.partial = parts.pop() ?? ''

  for (const line of parts) {
    entry.lines.push(line)
    entry.totalLines++
  }

  if (entry.lines.length > MAX_LINES) {
    const dropped = entry.lines.length - MAX_LINES
    entry.lines.splice(0, dropped)
    entry.firstLineIndex += dropped
  }
}

export function startBackground(command: string, cwd: string): BackgroundInfo {
  const id = randomUUID().slice(0, 8)
  const { file, args } = shellInvocation(command)
  const child = spawn(file, args, { cwd, windowsHide: true })

  const entry: Entry = {
    id,
    command,
    cwd,
    startedAt: Date.now(),
    running: true,
    exitCode: null,
    totalLines: 0,
    child,
    lines: [],
    firstLineIndex: 0,
    partial: '',
  }
  processes.set(id, entry)

  child.stdout?.on('data', (b: Buffer) => append(entry, b.toString('utf8')))
  child.stderr?.on('data', (b: Buffer) => append(entry, b.toString('utf8')))

  child.on('error', (err) => {
    append(entry, `\n[failed to start: ${err.message}]\n`)
    entry.running = false
  })

  child.on('close', (code) => {
    if (entry.partial) append(entry, '\n')
    entry.running = false
    entry.exitCode = code
  })

  return toInfo(entry)
}

function toInfo(entry: Entry): BackgroundInfo {
  return {
    id: entry.id,
    command: entry.command,
    cwd: entry.cwd,
    startedAt: entry.startedAt,
    running: entry.running,
    exitCode: entry.exitCode,
    totalLines: entry.totalLines,
  }
}

export interface BackgroundOutput extends BackgroundInfo {
  lines: string[]
  /** Pass back as `since` to read only what is new. */
  nextCursor: number
  /** True when output was dropped between `since` and what is returned. */
  gap: boolean
}

export function readBackground(id: string, since = 0, limit = 200): BackgroundOutput {
  const entry = processes.get(id)
  if (!entry) throw new Error(`No background process with id "${id}".`)

  const start = Math.max(since, entry.firstLineIndex)
  const offset = start - entry.firstLineIndex
  const lines = entry.lines.slice(offset, offset + limit)

  return {
    ...toInfo(entry),
    lines,
    nextCursor: start + lines.length,
    gap: since < entry.firstLineIndex,
  }
}

export function stopBackground(id: string): BackgroundInfo {
  const entry = processes.get(id)
  if (!entry) throw new Error(`No background process with id "${id}".`)
  if (entry.running) {
    try {
      // On Windows, killing the shell leaves grandchildren; taskkill /T gets the tree.
      if (process.platform === 'win32' && entry.child.pid) {
        spawn('taskkill', ['/pid', String(entry.child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        entry.child.kill()
      }
    } catch {
      // already gone
    }
    entry.running = false
  }
  return toInfo(entry)
}

export function listBackground(): BackgroundInfo[] {
  return [...processes.values()].map(toInfo)
}

/** Drops finished processes so the list stays useful over a long session. */
export function pruneBackground(): void {
  for (const [id, entry] of processes) {
    if (!entry.running) processes.delete(id)
  }
}

export function stopAllBackground(): void {
  for (const id of [...processes.keys()]) {
    try {
      stopBackground(id)
    } catch {
      // best effort during shutdown
    }
  }
  processes.clear()
}

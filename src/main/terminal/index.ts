import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from 'node:child_process'
import os from 'node:os'
import type { TerminalEvent, TerminalSpawnResult } from '@shared/types'

/**
 * Integrated terminal backend.
 *
 * Prefers a real PTY (@lydell/node-pty ships prebuilt N-API binaries, so no
 * compiler is needed). If that import fails on some platform we fall back to a
 * piped child process: good enough for builds, tests and git, but without TTY
 * semantics, so full-screen programs will not render correctly.
 */

type PtyModule = typeof import('@lydell/node-pty')

let ptyModule: PtyModule | null = null
let ptyLoadAttempted = false

async function loadPty(): Promise<PtyModule | null> {
  if (ptyLoadAttempted) return ptyModule
  ptyLoadAttempted = true
  try {
    ptyModule = await import('@lydell/node-pty')
  } catch (err) {
    console.warn('[terminal] PTY unavailable, falling back to piped shell:', err)
    ptyModule = null
  }
  return ptyModule
}

interface Session {
  id: string
  kill(): void
  write(data: string): void
  resize(cols: number, rows: number): void
}

const sessions = new Map<string, Session>()
let nextId = 1

export function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    // Prefer PowerShell 7 if present on PATH; the launcher falls back on error.
    return { file: process.env.COMSPEC ?? 'powershell.exe', args: [] }
  }
  return { file: process.env.SHELL ?? '/bin/bash', args: ['-l'] }
}

function shellForPty(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo'] }
  }
  return { file: process.env.SHELL ?? '/bin/bash', args: [] }
}

export async function createTerminal(
  opts: { cwd: string; cols: number; rows: number },
  emit: (event: TerminalEvent) => void,
): Promise<TerminalSpawnResult> {
  const id = `term-${nextId++}`
  const pty = await loadPty()

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  // Signal to child processes that this is an interactive colour-capable shell.
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'

  if (pty) {
    const { file, args } = shellForPty()
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env,
    })

    proc.onData((data) => emit({ type: 'data', id, data }))
    proc.onExit(({ exitCode }) => {
      sessions.delete(id)
      emit({ type: 'exit', id, exitCode })
    })

    sessions.set(id, {
      id,
      kill: () => proc.kill(),
      write: (d) => proc.write(d),
      resize: (cols, rows) => {
        try {
          proc.resize(Math.max(1, cols), Math.max(1, rows))
        } catch {
          // resize races against exit; a dead pty is not an error worth surfacing
        }
      },
    })

    return { id, shell: file, pty: true }
  }

  // ---- Degraded fallback: piped shell, no TTY ----
  const { file, args } = defaultShell()
  const proc: ChildProcessWithoutNullStreams = spawnChild(file, args, {
    cwd: opts.cwd,
    env,
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams

  proc.stdout.on('data', (b: Buffer) => emit({ type: 'data', id, data: b.toString('utf8') }))
  proc.stderr.on('data', (b: Buffer) => emit({ type: 'data', id, data: b.toString('utf8') }))

  // Without this listener, a missing or misconfigured shell emits an unhandled
  // 'error' event, which takes down the entire main process.
  proc.on('error', (err) => {
    sessions.delete(id)
    emit({ type: 'data', id, data: `\x1b[31mFailed to start ${file}: ${err.message}\x1b[0m\r\n` })
    emit({ type: 'exit', id, exitCode: 1 })
  })

  proc.on('exit', (code) => {
    sessions.delete(id)
    emit({ type: 'exit', id, exitCode: code ?? 0 })
  })

  sessions.set(id, {
    id,
    kill: () => proc.kill(),
    write: (d) => proc.stdin.write(d),
    resize: () => {},
  })

  emit({
    type: 'data',
    id,
    // Tell the user why arrow keys and vim will misbehave, rather than leaving them guessing.
    data: `\x1b[33mPTY unavailable — running a piped shell. Interactive programs may not render.\x1b[0m\r\n`,
  })

  return { id, shell: file, pty: false }
}

export function writeTerminal(id: string, data: string): void {
  sessions.get(id)?.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  sessions.get(id)?.resize(cols, rows)
}

export function disposeTerminal(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  try {
    s.kill()
  } catch {
    // already gone
  }
}

export function disposeAllTerminals(): void {
  for (const id of [...sessions.keys()]) disposeTerminal(id)
}

export function homeDir(): string {
  return os.homedir()
}

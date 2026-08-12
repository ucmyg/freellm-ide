import { spawn } from 'node:child_process'
import os from 'node:os'
import type { RiskLevel } from '@shared/types'
import * as ws from '../workspace/index.js'
import { summarizeStats, unifiedDiff } from './diff.js'
import type { ToolKind } from './permissions.js'
import {
  listBackground,
  readBackground,
  startBackground,
  stopBackground,
} from './processes.js'
import { shellInvocation, shellName } from './shell.js'

/**
 * The agent's toolbelt. Each tool declares a JSON Schema the model sees, a risk
 * level driving approval, and an optional preview so the user approves the
 * concrete effect (a diff, a command line) rather than an opaque tool name.
 */

export interface ToolResult {
  /** One line shown in the collapsed tool row. */
  summary: string
  /** Full text returned to the model and shown when expanded. */
  content: string
  isError?: boolean
}

export interface ToolPreview {
  title: string
  detail: string
}

export interface ToolContext {
  signal: AbortSignal
  /** Called when a tool changes files on disk, so the UI can refresh. */
  onFilesChanged(paths: string[]): void
  /** How long run_command may run before it is killed. */
  commandTimeoutMs: number
}

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  risk: RiskLevel
  /** What the tool does â€” the permission modes gate on this. */
  kind: ToolKind
  preview?(input: Record<string, unknown>): Promise<ToolPreview>
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

/* ------------------------------------------------------------------ */
/* Input coercion helpers                                              */
/* ------------------------------------------------------------------ */

function str(input: Record<string, unknown>, key: string, required = true): string {
  const v = input[key]
  if (typeof v === 'string') return v
  if (v === undefined || v === null) {
    if (required) throw new Error(`Missing required parameter "${key}"`)
    return ''
  }
  return String(v)
}

function num(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key]
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function bool(input: Record<string, unknown>, key: string): boolean {
  const v = input[key]
  return v === true || v === 'true'
}

/** Clip tool output so a huge file cannot blow the context window. */
const MAX_TOOL_OUTPUT = 60_000

function clip(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n\n[output truncated at ${MAX_TOOL_OUTPUT} characters]`
}

/* ------------------------------------------------------------------ */
/* Command risk classification                                         */
/* ------------------------------------------------------------------ */

/** Patterns that should always be treated as high risk in the approval UI. */
const DANGEROUS_COMMAND = [
  /\brm\s+-[a-z]*r[a-z]*f?\b/i,
  /\bRemove-Item\b[^|]*-Recurse/i,
  /\bformat\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bnpm\s+publish\b/i,
  /\bcurl\b[^|]*\|\s*(ba)?sh/i,
  /\bshutdown\b/i,
  /\breg\s+delete\b/i,
]

function commandRisk(command: string): RiskLevel {
  if (DANGEROUS_COMMAND.some((re) => re.test(command))) return 'high'
  return 'medium'
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

const readFile: ToolDef = {
  name: 'read_file',
  description:
    'Read a file from the workspace. Returns the contents with 1-based line numbers. Use offset/limit for very large files.',
  risk: 'low',
  kind: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      offset: { type: 'integer', description: 'First line to read (1-based).' },
      limit: { type: 'integer', description: 'Maximum number of lines to read.' },
    },
    required: ['path'],
  },
  async execute(input) {
    const p = str(input, 'path')
    const file = await ws.readFile(p)
    const allLines = file.content.split('\n')
    const offset = Math.max(1, num(input, 'offset') ?? 1)
    const limit = num(input, 'limit') ?? 2000
    const slice = allLines.slice(offset - 1, offset - 1 + limit)

    const numbered = slice.map((line, i) => `${offset + i}\t${line}`).join('\n')
    const shown = `${offset}-${offset + slice.length - 1}`
    const more =
      offset - 1 + slice.length < allLines.length
        ? `\n\n[showing lines ${shown} of ${allLines.length}]`
        : ''

    return {
      summary: `${p} (${slice.length} lines)`,
      content: clip(numbered + more) || '[empty file]',
    }
  },
}

const listFiles: ToolDef = {
  name: 'list_files',
  description:
    'List the contents of a directory in the workspace. Omit path for the workspace root. Ignored paths (node_modules, .git, build output) are hidden.',
  risk: 'low',
  kind: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory relative to the workspace root.' },
    },
  },
  async execute(input) {
    const p = str(input, 'path', false)
    const entries = await ws.listDir(p)
    const body = entries.map((e) => (e.isDirectory ? `${e.path}/` : e.path)).join('\n')
    return {
      summary: `${p || '.'} (${entries.length} entries)`,
      content: clip(body) || '[empty directory]',
    }
  },
}

const findFiles: ToolDef = {
  name: 'find_files',
  description:
    'Find files by glob pattern, e.g. "**/*.ts" or "src/**/index.*". Use this to locate files by name.',
  risk: 'low',
  kind: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern. Supports **, * and ?.' },
    },
    required: ['pattern'],
  },
  async execute(input) {
    const pattern = str(input, 'pattern')
    const hits = await ws.globFiles(pattern)
    return {
      summary: `${hits.length} file${hits.length === 1 ? '' : 's'} matching ${pattern}`,
      content: clip(hits.join('\n')) || '[no matches]',
    }
  },
}

const searchFiles: ToolDef = {
  name: 'search_files',
  description:
    'Search file contents across the workspace and return matching lines with their paths and line numbers.',
  risk: 'low',
  kind: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text or regular expression to search for.' },
      is_regex: { type: 'boolean', description: 'Treat query as a regular expression.' },
      case_sensitive: { type: 'boolean' },
      include: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts".' },
    },
    required: ['query'],
  },
  async execute(input) {
    const query = str(input, 'query')
    const hits = await ws.searchText(query, {
      isRegex: bool(input, 'is_regex'),
      caseSensitive: bool(input, 'case_sensitive'),
      include: str(input, 'include', false) || undefined,
    })
    const body = hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n')
    return {
      summary: `${hits.length} match${hits.length === 1 ? '' : 'es'} for "${query}"`,
      content: clip(body) || '[no matches]',
    }
  },
}

const writeFile: ToolDef = {
  name: 'write_file',
  description:
    'Create a file, or replace an existing file entirely. Prefer edit_file for changes to existing files.',
  risk: 'medium',
  kind: 'edit',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string', description: 'Full contents to write.' },
    },
    required: ['path', 'content'],
  },
  async preview(input) {
    const p = str(input, 'path')
    const content = str(input, 'content')
    let before = ''
    let existed = false
    try {
      before = (await ws.readFile(p)).content
      existed = true
    } catch {
      // new file
    }
    const { text, stats } = unifiedDiff(before, content, p)
    return {
      title: existed ? `Overwrite ${p} (${summarizeStats(stats)})` : `Create ${p}`,
      detail: existed ? text : content.slice(0, 8000),
    }
  },
  async execute(input, ctx) {
    const p = str(input, 'path')
    const content = str(input, 'content')
    let before = ''
    try {
      before = (await ws.readFile(p)).content
    } catch {
      // new file
    }
    await ws.writeFile(p, content)
    ctx.onFilesChanged([p])
    const { stats } = unifiedDiff(before, content, p)
    return {
      summary: `${p} (${summarizeStats(stats)})`,
      content: `Wrote ${content.split('\n').length} lines to ${p}.`,
    }
  },
}

const editFile: ToolDef = {
  name: 'edit_file',
  description:
    'Replace an exact string in a file. old_string must match the file exactly, including whitespace, and must be unique unless replace_all is true. This is the preferred way to modify existing files.',
  risk: 'medium',
  kind: 'edit',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'Exact text to find.' },
      new_string: { type: 'string', description: 'Text to replace it with.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async preview(input) {
    const p = str(input, 'path')
    const { before, after } = await computeEdit(input)
    const { text, stats } = unifiedDiff(before, after, p)
    return { title: `Edit ${p} (${summarizeStats(stats)})`, detail: text }
  },
  async execute(input, ctx) {
    const p = str(input, 'path')
    const { before, after, count } = await computeEdit(input)
    await ws.writeFile(p, after)
    ctx.onFilesChanged([p])
    const { stats } = unifiedDiff(before, after, p)
    return {
      summary: `${p} (${summarizeStats(stats)})`,
      content: `Replaced ${count} occurrence${count === 1 ? '' : 's'} in ${p}.`,
    }
  },
}

/** Shared by editFile's preview and execute so they can never disagree. */
async function computeEdit(
  input: Record<string, unknown>,
): Promise<{ before: string; after: string; count: number }> {
  const p = str(input, 'path')
  const oldString = str(input, 'old_string')
  const newString = str(input, 'new_string')
  const replaceAll = bool(input, 'replace_all')

  const before = (await ws.readFile(p)).content
  if (oldString === '') throw new Error('old_string must not be empty')

  const occurrences = before.split(oldString).length - 1
  if (occurrences === 0) {
    throw new Error(
      `old_string was not found in ${p}. The file may have changed â€” read it again and retry with an exact match.`,
    )
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `old_string appears ${occurrences} times in ${p}. Include more surrounding context to make it unique, or set replace_all.`,
    )
  }

  const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString)
  return { before, after, count: replaceAll ? occurrences : 1 }
}

const deleteFile: ToolDef = {
  name: 'delete_file',
  description: 'Delete a file or directory from the workspace.',
  risk: 'high',
  kind: 'destructive',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  async preview(input) {
    const p = str(input, 'path')
    return { title: `Delete ${p}`, detail: `${p} will be permanently removed from disk.` }
  },
  async execute(input, ctx) {
    const p = str(input, 'path')
    await ws.deleteEntry(p)
    ctx.onFilesChanged([p])
    return { summary: `deleted ${p}`, content: `Deleted ${p}.` }
  },
}

const runCommand: ToolDef = {
  name: 'run_command',
  description:
    'Run a shell command in the workspace root and return its combined stdout and stderr. Use for builds, tests, linters and git. Long-running servers will hit the timeout and be killed.',
  risk: 'medium',
  kind: 'command',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      cwd: {
        type: 'string',
        description:
          'Working directory. Relative to the workspace root, or an absolute path if access allows.',
      },
      timeout_seconds: {
        type: 'integer',
        description: 'Override the default timeout for a command you expect to be slow.',
      },
    },
    required: ['command'],
  },
  async preview(input) {
    const command = str(input, 'command')
    const cwd = str(input, 'cwd', false)
    return {
      title: `Run: ${command.length > 80 ? `${command.slice(0, 80)}â€¦` : command}`,
      detail: cwd ? `${command}\n\nin ./${cwd}` : command,
    }
  },
  async execute(input, ctx) {
    const command = str(input, 'command')
    const cwdRel = str(input, 'cwd', false)
    const cwd = cwdRel ? ws.resolveInWorkspace(cwdRel) : ws.requireRoot()

    const { file: shell, args } = shellInvocation(command)

    const override = num(input, 'timeout_seconds')
    const timeoutMs = override && override > 0 ? override * 1000 : ctx.commandTimeoutMs
    const timeoutSeconds = Math.round(timeoutMs / 1000)

    return await new Promise<ToolResult>((resolve) => {
      const child = spawn(shell, args, { cwd, windowsHide: true })
      let out = ''
      let settled = false

      const finish = (result: ToolResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        resolve(result)
      }

      const timer = setTimeout(() => {
        child.kill()
        finish({
          summary: `timed out after ${timeoutSeconds}s`,
          content: clip(`${out}\n\n[command timed out after ${timeoutSeconds}s and was killed]`),
          isError: true,
        })
      }, timeoutMs)

      const onAbort = () => {
        child.kill()
        finish({ summary: 'cancelled', content: clip(`${out}\n\n[cancelled]`), isError: true })
      }
      ctx.signal.addEventListener('abort', onAbort, { once: true })

      child.stdout.on('data', (b: Buffer) => {
        out += b.toString('utf8')
      })
      child.stderr.on('data', (b: Buffer) => {
        out += b.toString('utf8')
      })

      child.on('error', (err) => {
        finish({ summary: 'failed to start', content: String(err), isError: true })
      })

      child.on('close', (code) => {
        // Any command may have touched files; let the UI reconcile.
        ctx.onFilesChanged([])
        const body = out.trim() || '[no output]'
        finish({
          summary: code === 0 ? 'exit 0' : `exit ${code}`,
          content: clip(`${body}\n\n[exit code ${code}]`),
          isError: code !== 0,
        })
      })
    })
  },
}

/* ------------------------------------------------------------------ */
/* Long-running processes                                              */
/* ------------------------------------------------------------------ */

const startBackgroundTool: ToolDef = {
  name: 'start_background',
  description:
    'Start a long-running process that will not finish on its own — a dev server, a watcher, a log tail. Returns immediately with an id. Use read_background to see its output and stop_background to kill it. For commands that finish, use run_command instead.',
  risk: 'medium',
  kind: 'command',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      cwd: { type: 'string', description: 'Working directory. Defaults to the workspace root.' },
    },
    required: ['command'],
  },
  async preview(input) {
    const command = str(input, 'command')
    return {
      title: `Start in background: ${command.length > 70 ? `${command.slice(0, 70)}…` : command}`,
      detail: `${command}\n\nRuns until you or the agent stops it, or until FreeLLM IDE quits.`,
    }
  },
  async execute(input) {
    const command = str(input, 'command')
    const cwdRel = str(input, 'cwd', false)
    const cwd = cwdRel ? ws.resolveInWorkspace(cwdRel) : ws.requireRoot()

    const info = startBackground(command, cwd)
    return {
      summary: `started ${info.id}`,
      content: `Started background process ${info.id}: ${command}\nRead its output with read_background({ id: "${info.id}" }).`,
    }
  },
}

const readBackgroundTool: ToolDef = {
  name: 'read_background',
  description:
    'Read output from a background process. Pass the cursor from the previous call as `since` to get only what is new.',
  risk: 'low',
  kind: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      since: { type: 'integer', description: 'Line cursor returned by the previous call.' },
    },
    required: ['id'],
  },
  async execute(input) {
    const id = str(input, 'id')
    const out = readBackground(id, num(input, 'since') ?? 0)

    const status = out.running ? 'running' : `exited (${out.exitCode})`
    const header = `[${id}] ${status} — ${out.command}`
    const gap = out.gap ? '\n[earlier output was dropped from the buffer]' : ''
    const body = out.lines.length ? out.lines.join('\n') : '[no new output]'

    return {
      summary: `${out.lines.length} line${out.lines.length === 1 ? '' : 's'}, ${status}`,
      content: clip(`${header}${gap}\n\n${body}\n\n[cursor: ${out.nextCursor}]`),
    }
  },
}

const stopBackgroundTool: ToolDef = {
  name: 'stop_background',
  description: 'Stop a background process and its child processes.',
  risk: 'low',
  kind: 'command',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  async preview(input) {
    return { title: `Stop background process ${str(input, 'id')}`, detail: 'The process tree will be killed.' }
  },
  async execute(input) {
    const info = stopBackground(str(input, 'id'))
    return { summary: `stopped ${info.id}`, content: `Stopped ${info.id} (${info.command}).` }
  },
}

const listBackgroundTool: ToolDef = {
  name: 'list_background',
  description: 'List background processes started this session, running or finished.',
  risk: 'low',
  kind: 'read',
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    const all = listBackground()
    if (!all.length) return { summary: 'none', content: 'No background processes.' }

    const body = all
      .map((p) => {
        const status = p.running ? 'running' : `exited (${p.exitCode})`
        const age = Math.round((Date.now() - p.startedAt) / 1000)
        return `${p.id}  ${status}  ${age}s  ${p.command}`
      })
      .join('\n')
    return { summary: `${all.length} process${all.length === 1 ? '' : 'es'}`, content: body }
  },
}

const systemInfo: ToolDef = {
  name: 'system_info',
  description:
    'Report the machine, shell, and where the agent is allowed to reach. Use this when a command depends on the platform, or when a path is refused and you need to know the current limits.',
  risk: 'low',
  kind: 'read',
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    const scope = ws.describeAccess()
    const body = [
      `platform: ${process.platform} (${os.release()}, ${process.arch})`,
      `shell: ${shellName()}`,
      `node: ${process.versions.node}`,
      `home: ${os.homedir()}`,
      `workspace: ${ws.getWorkspaceRoot() ?? '(none open)'}`,
      `access: ${scope}`,
    ].join('\n')
    return { summary: process.platform, content: body }
  },
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export const TOOLS: ToolDef[] = [
  readFile,
  listFiles,
  findFiles,
  searchFiles,
  editFile,
  writeFile,
  deleteFile,
  runCommand,
  startBackgroundTool,
  readBackgroundTool,
  stopBackgroundTool,
  listBackgroundTool,
  systemInfo,
]

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

/** Risk shown in the approval prompt â€” commands are scored on their content. */
export function riskFor(tool: ToolDef, input: Record<string, unknown>): RiskLevel {
  if (tool.name === 'run_command') return commandRisk(String(input.command ?? ''))
  return tool.risk
}

import { promises as fs } from 'node:fs'
import path from 'node:path'
import ignore, { type Ignore } from 'ignore'
import type { DirEntry, FileContent } from '@shared/types'

/**
 * Everything the agent and the UI do to the filesystem goes through here, so
 * that path confinement is enforced in exactly one place.
 */

/** Directories that are never worth walking and would swamp search results. */
const ALWAYS_SKIP = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'out',
  'build',
  'release',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  'target',
  'vendor',
  'Pods',
  '.gradle',
  '.idea',
])

const MAX_FILE_BYTES = 2 * 1024 * 1024 // 2 MB — above this we truncate
const MAX_SEARCH_RESULTS = 200
const MAX_WALK_ENTRIES = 20_000

let workspaceRoot: string | null = null
let ignoreFilter: Ignore | null = null

/**
 * How far outside the open folder the agent may reach. Defaults to "nowhere",
 * so a fresh install is confined until the user widens it in Settings.
 */
let accessPolicy: { fullDiskAccess: boolean; additionalRoots: string[] } = {
  fullDiskAccess: false,
  additionalRoots: [],
}

export function configureAccess(policy: {
  fullDiskAccess: boolean
  additionalRoots: string[]
}): void {
  accessPolicy = {
    fullDiskAccess: policy.fullDiskAccess,
    additionalRoots: policy.additionalRoots.filter(Boolean).map((p) => path.resolve(p)),
  }
}

/** One line describing where the agent may reach, for the system_info tool. */
export function describeAccess(): string {
  if (accessPolicy.fullDiskAccess) return 'full disk — any path this user account can reach'
  const extra = accessPolicy.additionalRoots
  return extra.length
    ? `the open folder, plus ${extra.join(', ')}`
    : 'the open folder only'
}

/** True when `child` is `parent` or sits beneath it. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function getWorkspaceRoot(): string | null {
  return workspaceRoot
}

export async function setWorkspaceRoot(dir: string): Promise<string> {
  const resolved = path.resolve(dir)
  const stat = await fs.stat(resolved)
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`)
  workspaceRoot = resolved
  ignoreFilter = await loadIgnore(resolved)
  return resolved
}

async function loadIgnore(root: string): Promise<Ignore> {
  const ig = ignore()
  for (const file of ['.gitignore', '.ideignore']) {
    try {
      ig.add(await fs.readFile(path.join(root, file), 'utf8'))
    } catch {
      // absent is the normal case
    }
  }
  return ig
}

export function requireRoot(): string {
  if (!workspaceRoot) throw new Error('No folder is open. Open a folder first.')
  return workspaceRoot
}

/**
 * Resolve a workspace-relative path to an absolute one, refusing anything the
 * current access policy does not cover. Absolute inputs are accepted when they
 * land somewhere permitted — models routinely pass absolute paths back after
 * reading them.
 */
export function resolveInWorkspace(relOrAbs: string): string {
  const root = requireRoot()
  const candidate = path.resolve(root, relOrAbs)

  if (accessPolicy.fullDiskAccess) return candidate
  if (isInside(root, candidate)) return candidate
  if (accessPolicy.additionalRoots.some((extra) => isInside(extra, candidate))) return candidate

  throw new Error(
    `Path is outside the open folder: ${relOrAbs}. Add its directory under Settings → Access, or turn on full disk access.`,
  )
}

/**
 * The form shown in the UI and given to the model: workspace-relative when the
 * path is inside the folder, absolute when the access policy let it out.
 */
export function toRelative(absPath: string): string {
  const root = requireRoot()
  if (!isInside(root, absPath)) return absPath.split(path.sep).join('/')
  return path.relative(root, absPath).split(path.sep).join('/')
}

export function isIgnored(relPath: string): boolean {
  if (!relPath || relPath === '.') return false
  const first = relPath.split('/')[0]
  if (first && ALWAYS_SKIP.has(first)) return true
  const segments = relPath.split('/')
  if (segments.some((s) => ALWAYS_SKIP.has(s))) return true
  return ignoreFilter?.ignores(relPath) ?? false
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

export async function listDir(relPath = ''): Promise<DirEntry[]> {
  const abs = resolveInWorkspace(relPath)
  const dirents = await fs.readdir(abs, { withFileTypes: true })
  const entries: DirEntry[] = []

  for (const d of dirents) {
    const childRel = relPath ? `${relPath.replace(/\/$/, '')}/${d.name}` : d.name
    if (isIgnored(childRel)) continue
    let size: number | undefined
    if (d.isFile()) {
      try {
        size = (await fs.stat(path.join(abs, d.name))).size
      } catch {
        // a file can vanish between readdir and stat; leave size undefined
      }
    }
    entries.push({
      name: d.name,
      path: childRel,
      isDirectory: d.isDirectory(),
      ...(size === undefined ? {} : { size }),
    })
  }

  // Directories first, then case-insensitive by name — standard explorer order.
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  return entries
}

/** Heuristic binary check: a NUL byte in the first 8 KB. */
function looksBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, 8192)
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true
  return false
}

export async function readFile(relPath: string): Promise<FileContent> {
  const abs = resolveInWorkspace(relPath)
  const stat = await fs.stat(abs)
  if (stat.isDirectory()) throw new Error(`${relPath} is a directory`)

  const buf = await fs.readFile(abs)
  if (looksBinary(buf)) {
    return {
      path: toRelative(abs),
      content: `[binary file — ${stat.size} bytes]`,
      language: 'plaintext',
      truncated: true,
    }
  }

  const truncated = buf.length > MAX_FILE_BYTES
  const content = (truncated ? buf.subarray(0, MAX_FILE_BYTES) : buf).toString('utf8')
  return {
    path: toRelative(abs),
    content,
    language: languageFor(abs),
    truncated,
  }
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

export async function writeFile(relPath: string, content: string): Promise<void> {
  const abs = resolveInWorkspace(relPath)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, 'utf8')
}

export async function createEntry(relPath: string, isDirectory: boolean): Promise<void> {
  const abs = resolveInWorkspace(relPath)
  if (isDirectory) {
    await fs.mkdir(abs, { recursive: true })
    return
  }
  await fs.mkdir(path.dirname(abs), { recursive: true })
  // 'wx' so an existing file is never silently clobbered.
  const handle = await fs.open(abs, 'wx')
  await handle.close()
}

export async function deleteEntry(relPath: string): Promise<void> {
  const abs = resolveInWorkspace(relPath)
  if (abs === requireRoot()) throw new Error('Refusing to delete the workspace root')
  await fs.rm(abs, { recursive: true, force: true })
}

export async function renameEntry(fromRel: string, toRel: string): Promise<void> {
  const from = resolveInWorkspace(fromRel)
  const to = resolveInWorkspace(toRel)
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.rename(from, to)
}

export async function pathExists(relPath: string): Promise<boolean> {
  try {
    await fs.access(resolveInWorkspace(relPath))
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* Walking & searching                                                 */
/* ------------------------------------------------------------------ */

/** Yields workspace-relative file paths, honouring ignore rules. */
export async function* walkFiles(startRel = ''): AsyncGenerator<string> {
  let visited = 0
  const queue: string[] = [startRel]

  while (queue.length) {
    const dirRel = queue.shift()!
    let dirents
    try {
      dirents = await fs.readdir(resolveInWorkspace(dirRel), { withFileTypes: true })
    } catch {
      continue // unreadable directory — skip rather than abort the walk
    }

    for (const d of dirents) {
      if (visited++ > MAX_WALK_ENTRIES) return
      const rel = dirRel ? `${dirRel}/${d.name}` : d.name
      if (isIgnored(rel)) continue
      if (d.isDirectory()) queue.push(rel)
      else if (d.isFile()) yield rel
    }
  }
}

/** Translate a glob (`**`, `*`, `?`) into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` should also match zero directories, so make the slash optional.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`, 'i')
}

export async function globFiles(pattern: string, limit = MAX_SEARCH_RESULTS): Promise<string[]> {
  const re = globToRegExp(pattern)
  const hits: string[] = []
  for await (const rel of walkFiles()) {
    // Bare patterns like "*.ts" should match at any depth, which is what users mean.
    if (re.test(rel) || (!pattern.includes('/') && re.test(rel.split('/').pop()!))) {
      hits.push(rel)
      if (hits.length >= limit) break
    }
  }
  return hits
}

export interface SearchHit {
  path: string
  line: number
  text: string
}

export async function searchText(
  query: string,
  opts: { isRegex?: boolean; caseSensitive?: boolean; include?: string; limit?: number } = {},
): Promise<SearchHit[]> {
  const limit = opts.limit ?? MAX_SEARCH_RESULTS
  const flags = opts.caseSensitive ? 'g' : 'gi'
  const re = opts.isRegex
    ? new RegExp(query, flags)
    : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
  const includeRe = opts.include ? globToRegExp(opts.include) : null

  const hits: SearchHit[] = []
  for await (const rel of walkFiles()) {
    if (includeRe && !includeRe.test(rel) && !includeRe.test(rel.split('/').pop()!)) continue

    let buf: Buffer
    try {
      buf = await fs.readFile(resolveInWorkspace(rel))
    } catch {
      continue
    }
    if (buf.length > MAX_FILE_BYTES || looksBinary(buf)) continue

    const lines = buf.toString('utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0
      if (re.test(lines[i]!)) {
        hits.push({ path: rel, line: i + 1, text: lines[i]!.slice(0, 400) })
        if (hits.length >= limit) return hits
      }
    }
  }
  return hits
}

/* ------------------------------------------------------------------ */
/* Language detection for Monaco                                       */
/* ------------------------------------------------------------------ */

const EXT_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.sql': 'sql',
  '.xml': 'xml',
  '.svg': 'xml',
  '.vue': 'html',
  '.dockerfile': 'dockerfile',
  '.graphql': 'graphql',
  '.lua': 'lua',
  '.r': 'r',
  '.dart': 'dart',
}

const FILENAME_LANGUAGE: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'plaintext',
  '.gitignore': 'plaintext',
  '.env': 'ini',
}

export function languageFor(filePath: string): string {
  const base = path.basename(filePath).toLowerCase()
  if (FILENAME_LANGUAGE[base]) return FILENAME_LANGUAGE[base]!
  return EXT_LANGUAGE[path.extname(base)] ?? 'plaintext'
}

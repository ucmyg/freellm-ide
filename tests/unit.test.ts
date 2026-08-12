import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { summarizeStats, unifiedDiff } from '../src/main/agent/diff'
import * as ws from '../src/main/workspace/index'

let root: string

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'freellm-ide-unit-'))
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.mkdir(path.join(root, 'node_modules', 'junk'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'const a = 1\nconst b = 2\n')
  await fs.writeFile(path.join(root, 'src', 'b.tsx'), 'export const B = () => null\n')
  await fs.writeFile(path.join(root, 'node_modules', 'junk', 'x.ts'), 'ignored\n')
  await fs.writeFile(path.join(root, '.gitignore'), 'secret.txt\n')
  await fs.writeFile(path.join(root, 'secret.txt'), 'hidden\n')
  await ws.setWorkspaceRoot(root)
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('workspace path confinement', () => {
  test('resolves a relative path inside the root', () => {
    expect(ws.resolveInWorkspace('src/a.ts')).toBe(path.join(root, 'src', 'a.ts'))
  })

  test('accepts an absolute path that is already inside the root', () => {
    const abs = path.join(root, 'src', 'a.ts')
    expect(ws.resolveInWorkspace(abs)).toBe(abs)
  })

  test.each([
    '../outside.ts',
    '../../etc/passwd',
    'src/../../escape.ts',
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    '/etc/passwd',
  ])('refuses to escape the workspace: %s', (evil) => {
    expect(() => ws.resolveInWorkspace(evil)).toThrow(/outside the open folder/)
  })

  test('refuses to delete the workspace root', async () => {
    await expect(ws.deleteEntry('.')).rejects.toThrow(/workspace root/)
  })
})

describe('ignore rules', () => {
  test('hides node_modules from listings', async () => {
    const entries = await ws.listDir('')
    expect(entries.map((e) => e.name)).not.toContain('node_modules')
  })

  test('honours .gitignore', () => {
    expect(ws.isIgnored('secret.txt')).toBe(true)
    expect(ws.isIgnored('src/a.ts')).toBe(false)
  })

  test('glob search skips ignored trees', async () => {
    const hits = await ws.globFiles('**/*.ts')
    expect(hits).toContain('src/a.ts')
    expect(hits.some((h) => h.includes('node_modules'))).toBe(false)
  })
})

describe('globToRegExp', () => {
  test.each([
    ['*.ts', 'a.ts', true],
    ['*.ts', 'a.tsx', false],
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/deep/a.ts', false],
    ['**/*.ts', 'src/deep/a.ts', true],
    // `**/` must also match zero directories.
    ['**/*.ts', 'a.ts', true],
    ['src/**/*.ts', 'src/a.ts', true],
    ['?.ts', 'a.ts', true],
    ['?.ts', 'ab.ts', false],
    // Dots are literal, not "any character".
    ['a.ts', 'axts', false],
  ])('%s vs %s -> %s', (pattern, input, expected) => {
    expect(ws.globToRegExp(pattern).test(input)).toBe(expected)
  })
})

describe('text search', () => {
  test('finds a literal match with a line number', async () => {
    const hits = await ws.searchText('const b')
    expect(hits).toContainEqual({ path: 'src/a.ts', line: 2, text: 'const b = 2' })
  })

  test('is case-insensitive by default and exact when asked', async () => {
    // 'const b' also matches 'const B' in b.tsx unless case sensitivity is on.
    const loose = await ws.searchText('const b')
    expect(loose.some((h) => h.path === 'src/b.tsx')).toBe(true)

    const strict = await ws.searchText('const b', { caseSensitive: true })
    expect(strict.some((h) => h.path === 'src/b.tsx')).toBe(false)
    expect(strict.some((h) => h.path === 'src/a.ts')).toBe(true)
  })

  test('treats regex metacharacters literally unless asked', async () => {
    expect(await ws.searchText('const .')).toHaveLength(0)
    expect((await ws.searchText('const .', { isRegex: true })).length).toBeGreaterThan(0)
  })
})

describe('unified diff', () => {
  test('reports added and removed counts', () => {
    const { stats } = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'f.ts')
    expect(stats).toEqual({ added: 1, removed: 1 })
  })

  test('renders +/- lines and a hunk header', () => {
    const { text } = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'f.ts')
    expect(text).toContain('@@')
    expect(text).toContain('-b')
    expect(text).toContain('+B')
  })

  test('says so when nothing changed', () => {
    const { text, stats } = unifiedDiff('same\n', 'same\n', 'f.ts')
    expect(stats).toEqual({ added: 0, removed: 0 })
    expect(text).toContain('no changes')
  })

  test('summarizes stats compactly', () => {
    expect(summarizeStats({ added: 3, removed: 1 })).toBe('+3 -1')
    expect(summarizeStats({ added: 0, removed: 0 })).toBe('no changes')
  })

  test('elides unchanged regions far from any edit', () => {
    const before = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
    const after = before.replace('line 30', 'CHANGED')
    const { text } = unifiedDiff(before, after, 'big.ts')
    expect(text).not.toContain('line 5')
    expect(text).toContain('CHANGED')
  })
})

describe('language detection', () => {
  test.each([
    ['a.ts', 'typescript'],
    ['a.tsx', 'typescript'],
    ['a.py', 'python'],
    ['build.ps1', 'powershell'],
    ['Dockerfile', 'dockerfile'],
    ['weird.qqq', 'plaintext'],
  ])('%s -> %s', (file, lang) => {
    expect(ws.languageFor(file)).toBe(lang)
  })
})

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { AppSettings, PermissionMode } from '../src/shared/types'
import { decide, parseRule, ruleForAlwaysAllow, subjectFor } from '../src/main/agent/permissions'
import * as ws from '../src/main/workspace/index'

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    baseUrl: 'http://localhost:3001',
    hasApiKey: true,
    model: 'auto',
    maxTokens: 4096,
    temperature: 0,
    permissionMode: 'default',
    allowRules: [],
    denyRules: [],
    fullDiskAccess: false,
    additionalRoots: [],
    commandTimeoutMs: 120_000,
    maxIterations: 20,
    ...overrides,
  }
}

describe('rule parsing', () => {
  test.each([
    ['run_command', { tool: 'run_command' }],
    ['run_command(npm test)', { tool: 'run_command', pattern: 'npm test' }],
    ['  edit_file  ', { tool: 'edit_file' }],
    // An empty pattern is the same as no pattern.
    ['edit_file()', { tool: 'edit_file' }],
  ])('parses %s', (raw, expected) => {
    expect(parseRule(raw)).toEqual(expected)
  })

  test.each(['', '   ', 'run_command(unclosed', '(no tool)'])('rejects %s', (raw) => {
    expect(parseRule(raw)).toBeNull()
  })
})

describe('subject extraction', () => {
  test('uses the command line for run_command', () => {
    expect(subjectFor('run_command', { command: 'npm test' })).toBe('npm test')
  })

  test('uses the path for file tools, normalised to forward slashes', () => {
    expect(subjectFor('edit_file', { path: 'src\\a.ts' })).toBe('src/a.ts')
  })

  test('is null when there is nothing to match on', () => {
    expect(subjectFor('list_files', {})).toBeNull()
  })
})

describe('permission modes', () => {
  const cases: Array<[PermissionMode, string, 'allow' | 'ask' | 'deny']> = [
    // reads are always allowed except never in readOnly... reads ARE allowed there.
    ['readOnly', 'read', 'allow'],
    ['readOnly', 'edit', 'deny'],
    ['readOnly', 'command', 'deny'],
    ['readOnly', 'destructive', 'deny'],

    ['default', 'read', 'allow'],
    ['default', 'edit', 'ask'],
    ['default', 'command', 'ask'],
    ['default', 'destructive', 'ask'],

    ['acceptEdits', 'read', 'allow'],
    ['acceptEdits', 'edit', 'allow'],
    ['acceptEdits', 'command', 'ask'],
    // Deleting is not an "edit" — it still stops for a human.
    ['acceptEdits', 'destructive', 'ask'],

    ['full', 'read', 'allow'],
    ['full', 'edit', 'allow'],
    ['full', 'command', 'allow'],
    ['full', 'destructive', 'allow'],
  ]

  test.each(cases)('%s mode, %s tool -> %s', (permissionMode, kind, expected) => {
    const result = decide('some_tool', kind as never, {}, settings({ permissionMode }))
    expect(result.decision).toBe(expected)
  })
})

describe('allow and deny rules', () => {
  test('an allow rule turns an ask into an allow', () => {
    const s = settings({ allowRules: ['run_command'] })
    expect(decide('run_command', 'command', { command: 'npm test' }, s).decision).toBe('allow')
  })

  test('a pattern rule only matches the pattern', () => {
    const s = settings({ allowRules: ['run_command(npm run test:*)'] })
    expect(decide('run_command', 'command', { command: 'npm run test:unit' }, s).decision).toBe('allow')
    expect(decide('run_command', 'command', { command: 'npm run build' }, s).decision).toBe('ask')
    // Prefix matching must not leak: the glob is anchored at both ends.
    expect(decide('run_command', 'command', { command: 'x && npm run test:unit' }, s).decision).toBe('ask')
  })

  test('a deny rule beats an allow rule', () => {
    const s = settings({ allowRules: ['run_command'], denyRules: ['run_command(git push*)'] })
    expect(decide('run_command', 'command', { command: 'npm test' }, s).decision).toBe('allow')
    expect(decide('run_command', 'command', { command: 'git push origin main' }, s).decision).toBe('deny')
  })

  test('a deny rule beats full-access mode', () => {
    const s = settings({ permissionMode: 'full', denyRules: ['delete_file'] })
    expect(decide('delete_file', 'destructive', { path: 'a.ts' }, s).decision).toBe('deny')
  })

  test('an allow rule cannot unlock read-only mode', () => {
    const s = settings({ permissionMode: 'readOnly', allowRules: ['write_file'] })
    expect(decide('write_file', 'edit', { path: 'a.ts' }, s).decision).toBe('deny')
  })

  test('command rules are case-sensitive so casing cannot widen a grant', () => {
    const s = settings({ allowRules: ['run_command(npm test)'] })
    expect(decide('run_command', 'command', { command: 'NPM TEST' }, s).decision).toBe('ask')
  })

  test('path rules match a glob', () => {
    const s = settings({ allowRules: ['edit_file(src/*.ts)'] })
    expect(decide('edit_file', 'edit', { path: 'src/a.ts' }, s).decision).toBe('allow')
    expect(decide('edit_file', 'edit', { path: 'secrets/a.ts' }, s).decision).toBe('ask')
  })

  test('malformed rules are ignored rather than throwing', () => {
    const s = settings({ allowRules: ['run_command(unclosed', ''] })
    expect(() => decide('run_command', 'command', { command: 'x' }, s)).not.toThrow()
    expect(decide('run_command', 'command', { command: 'x' }, s).decision).toBe('ask')
  })
})

describe('always-allow rules', () => {
  test('scopes commands to the exact command line', () => {
    expect(ruleForAlwaysAllow('run_command', { command: 'npm test' })).toBe('run_command(npm test)')
  })

  test('grants the whole tool for file edits', () => {
    expect(ruleForAlwaysAllow('edit_file', { path: 'src/a.ts' })).toBe('edit_file')
  })
})

describe('workspace access policy', () => {
  let root: string
  let outside: string

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'freellm-ide-perm-'))
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'freellm-ide-out-'))
    await ws.setWorkspaceRoot(root)
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })

  test('confines to the open folder by default', () => {
    ws.configureAccess({ fullDiskAccess: false, additionalRoots: [] })
    expect(() => ws.resolveInWorkspace(path.join(outside, 'x.ts'))).toThrow(/outside the open folder/)
  })

  test('additional roots widen access to exactly those trees', () => {
    ws.configureAccess({ fullDiskAccess: false, additionalRoots: [outside] })
    expect(ws.resolveInWorkspace(path.join(outside, 'x.ts'))).toBe(path.join(outside, 'x.ts'))
    expect(() => ws.resolveInWorkspace(path.join(os.tmpdir(), 'elsewhere', 'x.ts'))).toThrow()
  })

  test('full disk access removes confinement', () => {
    ws.configureAccess({ fullDiskAccess: true, additionalRoots: [] })
    expect(() => ws.resolveInWorkspace(path.join(outside, 'x.ts'))).not.toThrow()
  })

  test('paths outside the root are reported absolutely, not as ../..', () => {
    ws.configureAccess({ fullDiskAccess: true, additionalRoots: [] })
    const abs = path.join(outside, 'x.ts')
    expect(ws.toRelative(abs)).toBe(abs.split(path.sep).join('/'))
  })

  afterAll(() => {
    // Leave the module confined for any suite that runs after this one.
    ws.configureAccess({ fullDiskAccess: false, additionalRoots: [] })
  })
})

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { AgentEvent, AppSettings } from '../src/shared/types'
import { AgentSession } from '../src/main/agent/loop'
import { listModels, ping, type GatewayConfig } from '../src/main/gateway/client'
import * as ws from '../src/main/workspace/index'

/**
 * End-to-end against a real FreeLLMAPI gateway: a real model, real tool calls,
 * real files on disk.
 *
 * Opt-in. Set FREELLMAPI_API_KEY (and optionally FREELLMAPI_URL) to run it;
 * without a reachable gateway every test no-ops, so `npm test` still passes on
 * a clean checkout and in CI.
 *
 *   $env:FREELLMAPI_API_KEY = 'freellmapi-...'; npm test
 */

const BASE_URL = process.env.FREELLMAPI_URL ?? 'http://127.0.0.1:3001'

let cfg: GatewayConfig | null = null
let root: string

beforeAll(async () => {
  const apiKey = process.env.FREELLMAPI_API_KEY
  if (apiKey) {
    const candidate = { baseUrl: BASE_URL, apiKey }
    const result = await ping(candidate)
    if (result.ok) cfg = candidate
    else console.warn(`[agent-live] skipping: ${result.detail}`)
  } else {
    console.warn('[agent-live] skipping: set FREELLMAPI_API_KEY to run these')
  }

  root = await fs.mkdtemp(path.join(os.tmpdir(), 'freellm-ide-live-'))
  await ws.setWorkspaceRoot(root)
})

afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true })
})

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    baseUrl: BASE_URL,
    hasApiKey: true,
    model: 'auto',
    maxTokens: 4096,
    temperature: 0,
    // Edits apply unattended so the loop can run to completion; the prompting
    // path has its own tests below, which override this back to 'default'.
    permissionMode: 'acceptEdits',
    allowRules: [],
    denyRules: [],
    fullDiskAccess: false,
    additionalRoots: [],
    commandTimeoutMs: 60_000,
    maxIterations: 12,
    ...overrides,
  }
}

/** Run one turn to completion and return everything the UI would have seen. */
async function runTurn(
  prompt: string,
  settings: AppSettings,
  onApproval?: (session: AgentSession, event: AgentEvent) => void,
): Promise<{ events: AgentEvent[]; text: string }> {
  const events: AgentEvent[] = []
  let text = ''

  const session: AgentSession = new AgentSession(
    (event) => {
      events.push(event)
      if (event.type === 'text_delta') text += event.text
      onApproval?.(session, event)
    },
    async () => ({ cfg: cfg!, settings }),
    () => [],
  )

  await session.send(prompt, [])
  return { events, text }
}

describe('agent loop against a live gateway', () => {
  test('lists tool-capable models', async () => {
    if (!cfg) return
    const models = await listModels(cfg)
    expect(models.length).toBeGreaterThan(0)
    // 'auto' must always be offered — it is the default and the router's entry point.
    expect(models.map((m) => m.id)).toContain('auto')
  })

  test('reads a file with a tool call and answers from its contents', async () => {
    if (!cfg) return
    await fs.writeFile(
      path.join(root, 'config.json'),
      JSON.stringify({ port: 8642, name: 'probe-app' }, null, 2),
    )

    const { events, text } = await runTurn(
      'Read config.json and tell me only the port number. Nothing else.',
      makeSettings(),
    )

    const toolNames = events.filter((e) => e.type === 'tool_start').map((e) => e.name)
    expect(toolNames).toContain('read_file')

    const end = events.find((e) => e.type === 'turn_end')
    expect(end?.reason).toBe('complete')
    expect(text).toContain('8642')
  })

  test('creates a file on disk when asked', async () => {
    if (!cfg) return
    const { events } = await runTurn(
      'Create a file called greet.js containing exactly one line: module.exports = () => "hi"',
      makeSettings(),
    )

    const end = events.find((e) => e.type === 'turn_end')
    expect(end?.reason).toBe('complete')

    const written = await fs.readFile(path.join(root, 'greet.js'), 'utf8')
    expect(written).toContain('module.exports')
  })

  test('a denied approval stops the write and tells the model why', async () => {
    if (!cfg) return
    const settings = makeSettings({ permissionMode: 'default' })

    const { events } = await runTurn(
      'Create a file called should-not-exist.txt containing the word blocked.',
      settings,
      (session, event) => {
        // Deny every approval the moment it is requested.
        if (event.type === 'approval_request') session.resolveApproval(event.request.id, false)
      },
    )

    const approvals = events.filter((e) => e.type === 'approval_request')
    expect(approvals.length).toBeGreaterThan(0)

    const denied = events.filter((e) => e.type === 'tool_end' && e.status === 'denied')
    expect(denied.length).toBeGreaterThan(0)

    await expect(fs.access(path.join(root, 'should-not-exist.txt'))).rejects.toThrow()
  })

  test('an approval prompt previews the real effect before it happens', async () => {
    if (!cfg) return
    const settings = makeSettings({ permissionMode: 'default' })
    let captured: { title: string; detail: string } | null = null

    await runTurn(
      'Create a file called previewed.txt containing the word hello.',
      settings,
      (session, event) => {
        if (event.type === 'approval_request') {
          captured = { title: event.request.title, detail: event.request.detail }
          session.resolveApproval(event.request.id, false)
        }
      },
    )

    expect(captured).not.toBeNull()
    // The user must see the filename and the content, not just a tool name.
    expect(captured!.title.toLowerCase()).toContain('previewed.txt')
    expect(captured!.detail.toLowerCase()).toContain('hello')
  })

  test('surfaces a bad API key as a clear error rather than hanging', async () => {
    if (!cfg) return
    const badCfg: GatewayConfig = { baseUrl: BASE_URL, apiKey: 'freellmapi-not-a-real-key' }
    const result = await ping(badCfg)
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/key/i)
  })
})

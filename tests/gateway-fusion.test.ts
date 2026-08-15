import { afterEach, describe, expect, test, vi } from 'vitest'
import { GatewayError, streamChat, type StreamHandlers } from '../src/main/gateway/client'

const cfg = { baseUrl: 'http://gateway.test', apiKey: 'test-key' }
const handlers: StreamHandlers = {
  onText: () => {}, onToolCalls: () => {}, onUsage: () => {}, onRoutedVia: () => {},
}

function mockStream(...frames: object[]): void {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))
}

function request() {
  return {
    model: 'fusion', messages: [], tools: [], maxTokens: 100,
    temperature: 0, sessionId: 'fusion-test', signal: new AbortController().signal,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('fusion stream failure isolation', () => {
  test('discards a failed panel model and keeps the working result', async () => {
    mockStream(
      { error: { message: 'model unavailable', type: 'upstream_error' }, _fusion: { event: 'panel', status: 'failed' } },
      { choices: [{ delta: { content: 'working models won' }, finish_reason: 'stop' }] },
    )

    await expect(streamChat(cfg, request(), handlers)).resolves.toMatchObject({
      text: 'working models won', finishReason: 'stop',
    })
  })

  test('still rejects a failure for the fusion request itself', async () => {
    mockStream({ error: { message: 'every panel model failed', type: 'rate_limit_error' } })

    await expect(streamChat(cfg, request(), handlers)).rejects.toEqual(
      expect.objectContaining<Partial<GatewayError>>({ message: 'every panel model failed' }),
    )
  })
})

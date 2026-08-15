import type { ModelInfo } from '@shared/types'

/**
 * Client for a FreeLLMAPI gateway.
 *
 * Protocol choice: POST /v1/chat/completions (OpenAI shape), not /v1/messages.
 * The OpenAI shape is the gateway's own internal type system — every provider
 * adapter returns it — so this path has zero translation hops. The Anthropic
 * surface is a documented shim over the same router that silently drops
 * stop_sequences, response_format and parallel_tool_calls.
 *
 * All requests are made from the Electron main process. The gateway's CORS
 * allowlist only admits the dashboard's own origins, but a request with no
 * Origin header (i.e. any non-browser caller) is allowed — which is what the
 * main process is.
 */

/* ------------------------------------------------------------------ */
/* Wire types                                                          */
/* ------------------------------------------------------------------ */

export interface ChatToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessageWire =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface StreamHandlers {
  onText(delta: string): void
  /** Fired once per turn, with every tool call the model made. */
  onToolCalls(calls: ChatToolCall[]): void
  onUsage(usage: { inputTokens: number; outputTokens: number }): void
  /** The model the gateway actually routed to, from the X-Routed-Via header. */
  onRoutedVia(model: string): void
}

export interface TurnResult {
  text: string
  toolCalls: ChatToolCall[]
  finishReason: string
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'GatewayError'
  }
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

export interface GatewayConfig {
  baseUrl: string
  apiKey: string
}

function normalizeBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  // Accept a URL with or without the /v1 suffix — both are things people paste.
  return trimmed.replace(/\/v1$/, '')
}

function headers(cfg: GatewayConfig, extra: Record<string, string> = {}): Record<string, string> {
  return {
    // extractApiToken checks Authorization first, then x-api-key, then x-goog-api-key.
    Authorization: `Bearer ${cfg.apiKey}`,
    'Content-Type': 'application/json',
    ...extra,
  }
}

/** Pull a human message out of whichever error envelope the gateway used. */
function errorMessage(status: number, body: string): GatewayError {
  let message = body.slice(0, 500)
  let code: string | undefined

  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; type?: string; code?: string }
    }
    if (parsed.error?.message) message = parsed.error.message
    code = parsed.error?.code ?? parsed.error?.type
  } catch {
    // non-JSON body — keep the raw text
  }

  // Turn the gateway's known failure modes into advice the user can act on.
  if (status === 401) {
    message = 'Gateway rejected the API key. Check it on the gateway dashboard (Keys page).'
  } else if (code === 'no_tools_model') {
    message =
      'No tool-capable model is enabled on the gateway. Enable one on the Models page — the agent needs tool calling to read and edit files.'
  } else if (status === 429) {
    message = `${message} (the gateway allows 120 requests/min per client by default)`
  }

  return new GatewayError(message, status, code)
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

interface WireModel {
  id: string
  name?: string
  owned_by?: string
  context_window?: number | null
  context_length?: number | null
  available?: boolean
  unavailable_reason?: string | null
  supported_parameters?: string[]
}

/** The gateway's two virtual models. Both handle tools; the router gates per request. */
const VIRTUAL_MODEL_IDS = new Set(['auto', 'fusion'])

/**
 * The gateway names these with a full sentence of explanation, which does not
 * fit a picker. The description lives in the UI's tooltip instead.
 */
const VIRTUAL_MODEL_LABELS: Record<string, string> = {
  auto: 'Auto — best available',
  fusion: 'Fusion — panel of models',
}

export async function listModels(cfg: GatewayConfig, signal?: AbortSignal): Promise<ModelInfo[]> {
  const url = `${normalizeBase(cfg.baseUrl)}/v1/models?available=true`
  const res = await fetch(url, {
    headers: headers(cfg),
    ...(signal ? { signal } : {}),
  })

  if (!res.ok) throw errorMessage(res.status, await res.text())

  const body = (await res.json()) as { data?: WireModel[] }
  const models = body.data ?? []

  // FreeLLMAPI advertises per-model capabilities; a plain OpenAI-compatible
  // server does not. Only filter when the server actually tells us something —
  // otherwise every model is dropped and the picker comes up empty.
  const advertisesCapabilities = models.some((m) => Array.isArray(m.supported_parameters))

  return models
    .filter((m) => {
      if (!advertisesCapabilities) return true
      if (VIRTUAL_MODEL_IDS.has(m.id)) return true
      // Only tool-capable models can run this agent at all.
      return (m.supported_parameters ?? []).includes('tools')
    })
    .map((m): ModelInfo => {
      const ctx = m.context_window ?? m.context_length ?? undefined
      return {
        id: m.id,
        label: VIRTUAL_MODEL_LABELS[m.id] ?? m.name ?? m.id,
        ...(m.owned_by ? { owner: m.owned_by } : {}),
        ...(ctx ? { contextWindow: ctx } : {}),
        ...(advertisesCapabilities ? { supportsTools: true } : {}),
      }
    })
}

/**
 * Connection check built only on GET /v1/models, so it works against any
 * OpenAI-compatible server rather than just a FreeLLMAPI gateway. The failure
 * modes are separated because the fixes are completely different: a network
 * error means the server is not there, a 401 means the key is wrong.
 */
export async function ping(cfg: GatewayConfig): Promise<{ ok: boolean; detail: string }> {
  const base = normalizeBase(cfg.baseUrl)
  if (!cfg.apiKey) return { ok: false, detail: 'No API key set.' }

  try {
    const models = await listModels(cfg)
    if (models.length === 0) {
      return {
        ok: false,
        detail: 'Connected, but the server reported no available models.',
      }
    }
    return {
      ok: true,
      detail: `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.`,
    }
  } catch (err) {
    if (err instanceof GatewayError) return { ok: false, detail: err.message }
    return {
      ok: false,
      detail: `Cannot reach ${base}. Is the server running? (${(err as Error).message})`,
    }
  }
}

/* ------------------------------------------------------------------ */
/* Streaming chat completion                                           */
/* ------------------------------------------------------------------ */

interface StreamChunk {
  choices?: Array<{
    index?: number
    delta?: {
      content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string; type?: string }
  /** Additive gateway trace for one fusion panel member or the judge. */
  _fusion?: { event?: 'panel' | 'judge'; status?: 'ok' | 'failed' }
}

export interface ChatRequest {
  model: string
  messages: ChatMessageWire[]
  tools: ChatToolDef[]
  maxTokens: number
  temperature: number
  /** Pins the whole conversation to one upstream model, avoiding mid-chat switches. */
  sessionId: string
  signal: AbortSignal
}

export async function streamChat(
  cfg: GatewayConfig,
  req: ChatRequest,
  handlers: StreamHandlers,
): Promise<TurnResult> {
  const url = `${normalizeBase(cfg.baseUrl)}/v1/chat/completions`

  const res = await fetch(url, {
    method: 'POST',
    headers: headers(cfg, {
      // The gateway buckets sticky sessions on this, keeping one conversation
      // on one model. Switching models mid-thread is what triggers its
      // tool-dialect rescue path.
      'X-Session-Id': req.sessionId,
    }),
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: true,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      ...(req.tools.length ? { tools: req.tools, tool_choice: 'auto' } : {}),
      // stream_options is stripped by the gateway's schema — usage arrives
      // opportunistically instead, so asking for it would be noise.
    }),
    signal: req.signal,
  })

  if (!res.ok) throw errorMessage(res.status, await res.text())
  if (!res.body) throw new GatewayError('Gateway returned an empty response body')

  const routedVia = res.headers.get('x-routed-via')
  if (routedVia) handlers.onRoutedVia(routedVia)

  let text = ''
  let finishReason = 'stop'
  /**
   * Keyed by the delta's index. The gateway emits one complete tool_calls
   * chunk rather than argument fragments, but accumulating handles both that
   * and a provider that streams fragments, at no extra cost.
   */
  const toolAcc = new Map<number, { id?: string; name: string; args: string }>()

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE frames are separated by a blank line. Keep the trailing partial.
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload) continue
          if (payload === '[DONE]') {
            buffer = ''
            return finalize()
          }

          let chunk: StreamChunk
          try {
            chunk = JSON.parse(payload) as StreamChunk
          } catch {
            continue // a malformed frame is not worth killing the turn over
          }

          // A frame carrying an error and no choices normally means the turn
          // failed after headers were committed. Some gateway versions attach
          // an individual panel member's failure this way, though. That model
          // is only one fusion candidate: ignore its error trace and keep
          // reading so the working panel members can still produce the answer.
          const failedFusionMember =
            chunk._fusion?.event === 'panel' && chunk._fusion.status === 'failed'
          if (chunk.error && !chunk.choices && !failedFusionMember) {
            throw new GatewayError(chunk.error.message ?? 'Stream failed', undefined, chunk.error.type)
          }

          if (chunk.usage) {
            handlers.onUsage({
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
            })
          }

          const choice = chunk.choices?.[0]
          if (!choice) continue

          const content = choice.delta?.content
          if (content) {
            text += content
            handlers.onText(content)
          }

          for (const tc of choice.delta?.tool_calls ?? []) {
            const idx = tc.index ?? 0
            let acc = toolAcc.get(idx)
            if (!acc) {
              acc = { name: '', args: '' }
              toolAcc.set(idx, acc)
            }
            if (tc.id && !acc.id) acc.id = tc.id
            if (tc.function?.name) acc.name += tc.function.name
            if (tc.function?.arguments) acc.args += tc.function.arguments
          }

          if (choice.finish_reason) finishReason = choice.finish_reason
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {
      // the stream is already going away; nothing useful to do
    })
  }

  return finalize()

  function finalize(): TurnResult {
    const toolCalls: ChatToolCall[] = [...toolAcc.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, acc], i) => ({
        id: acc.id && acc.id.length > 0 ? acc.id : `call_${i}`,
        type: 'function' as const,
        function: { name: acc.name, arguments: acc.args || '{}' },
      }))
      .filter((c) => c.function.name.length > 0)

    if (toolCalls.length) handlers.onToolCalls(toolCalls)
    return { text, toolCalls, finishReason }
  }
}

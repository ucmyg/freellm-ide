import { randomUUID } from 'node:crypto'
import type { AgentEvent, AppSettings, ApprovalRequest } from '@shared/types'
import {
  GatewayError,
  streamChat,
  type ChatMessageWire,
  type ChatToolCall,
  type ChatToolDef,
  type GatewayConfig,
} from '../gateway/client.js'
import * as ws from '../workspace/index.js'
import { decide, ruleForAlwaysAllow } from './permissions.js'
import { systemPrompt } from './prompt.js'
import { riskFor, TOOLS, TOOLS_BY_NAME, type ToolContext } from './tools.js'

/**
 * Owns the conversation and drives the tool-calling loop:
 * stream a turn -> if the model called tools, run them (asking the user when
 * needed) -> feed the results back -> repeat until it answers with no calls.
 */

export type EventSink = (event: AgentEvent) => void

const toolDefs: ChatToolDef[] = TOOLS.map((t) => ({
  type: 'function',
  function: {
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  },
}))

export class AgentSession {
  /** Everything after the system message, which is rebuilt each turn. */
  private history: ChatMessageWire[] = []
  private abort: AbortController | null = null
  private pendingApprovals = new Map<string, (approved: boolean) => void>()
  /** Approval id -> the allow rule to persist if the user picks "always allow". */
  private pendingRules = new Map<string, string>()
  /** Kept stable so the gateway pins this conversation to one upstream model. */
  private sessionId = randomUUID()

  constructor(
    private readonly emit: EventSink,
    private readonly getConfig: () => Promise<{ cfg: GatewayConfig; settings: AppSettings }>,
    private readonly getOpenFiles: () => string[],
  ) {}

  get isRunning(): boolean {
    return this.abort !== null
  }

  reset(): void {
    this.cancel()
    this.history = []
    this.sessionId = randomUUID()
  }

  cancel(): void {
    this.abort?.abort()
    // Unblock anything waiting on a prompt the user will never answer.
    for (const [, resolve] of this.pendingApprovals) resolve(false)
    this.pendingApprovals.clear()
    this.pendingRules.clear()
  }

  /**
   * Resolve a pending approval. Returns the allow rule the caller should
   * persist when the user chose "always allow", or null.
   */
  resolveApproval(id: string, approved: boolean, alwaysAllow = false): string | null {
    const resolve = this.pendingApprovals.get(id)
    const rule = this.pendingRules.get(id) ?? null
    this.pendingRules.delete(id)
    if (!resolve) return null

    this.pendingApprovals.delete(id)
    this.emit({ type: 'approval_resolved', id, approved })
    resolve(approved)

    // Only a granted approval can widen permissions.
    return approved && alwaysAllow ? rule : null
  }

  async send(userText: string, attachedPaths: string[]): Promise<void> {
    if (this.isRunning) throw new Error('The agent is already working on something.')

    const { cfg, settings } = await this.getConfig()
    if (!cfg.apiKey) throw new Error('No gateway API key is set. Add one in Settings.')
    if (!ws.getWorkspaceRoot()) throw new Error('Open a folder before asking the agent to work.')

    const startedAt = Date.now()
    const controller = new AbortController()
    this.abort = controller

    // Attachments are inlined so the model does not have to spend a tool call
    // re-reading a file the user explicitly pointed at.
    let content = userText
    for (const p of attachedPaths) {
      try {
        const file = await ws.readFile(p)
        content += `\n\n--- ${p} ---\n${file.content}`
      } catch (err) {
        content += `\n\n[could not read ${p}: ${(err as Error).message}]`
      }
    }

    this.history.push({ role: 'user', content })

    const messageId = `assistant-${Date.now()}`
    this.emit({ type: 'turn_start', messageId })

    let usage: { inputTokens: number; outputTokens: number } | undefined
    let servedBy: string | undefined
    const changedPaths = new Set<string>()

    const toolContext: ToolContext = {
      signal: controller.signal,
      onFilesChanged: (paths) => {
        for (const p of paths) changedPaths.add(p)
        this.emit({ type: 'files_changed', paths })
      },
      commandTimeoutMs: settings.commandTimeoutMs,
    }

    try {
      for (let iteration = 0; iteration < settings.maxIterations; iteration++) {
        const messages: ChatMessageWire[] = [
          {
            role: 'system',
            content: systemPrompt(
              ws.requireRoot(),
              this.getOpenFiles(),
              settings.permissionMode,
              settings.commandTimeoutMs,
            ),
          },
          ...this.history,
        ]

        const result = await streamChat(
          cfg,
          {
            model: settings.model || 'auto',
            messages,
            tools: toolDefs,
            maxTokens: settings.maxTokens,
            temperature: settings.temperature,
            sessionId: this.sessionId,
            signal: controller.signal,
          },
          {
            onText: (delta) => this.emit({ type: 'text_delta', text: delta }),
            onToolCalls: () => {
              // Individual calls are announced as they are executed below,
              // so the UI shows them in the order they actually run.
            },
            onUsage: (u) => {
              usage = u
            },
            onRoutedVia: (m) => {
              servedBy = m
            },
          },
        )

        if (result.toolCalls.length === 0) {
          this.history.push({ role: 'assistant', content: result.text })
          this.finish('complete', startedAt, usage, servedBy)
          return
        }

        this.history.push({
          role: 'assistant',
          content: result.text || null,
          tool_calls: result.toolCalls,
        })

        for (const call of result.toolCalls) {
          const output = await this.runTool(call, settings, toolContext)
          this.history.push({
            role: 'tool',
            tool_call_id: call.id,
            content: output,
          })
        }

        if (controller.signal.aborted) {
          this.finish('cancelled', startedAt, usage, servedBy)
          return
        }
      }

      this.finish('max_iterations', startedAt, usage, servedBy)
    } catch (err) {
      if (controller.signal.aborted) {
        this.finish('cancelled', startedAt, usage, servedBy)
        return
      }
      const message =
        err instanceof GatewayError ? err.message : ((err as Error).message ?? String(err))
      this.emit({
        type: 'turn_end',
        reason: 'error',
        error: message,
        durationMs: Date.now() - startedAt,
        ...(usage ? { usage } : {}),
        ...(servedBy ? { servedBy } : {}),
      })
    } finally {
      this.abort = null
      if (changedPaths.size) this.emit({ type: 'files_changed', paths: [...changedPaths] })
    }
  }

  private finish(
    reason: 'complete' | 'cancelled' | 'max_iterations',
    startedAt: number,
    usage: { inputTokens: number; outputTokens: number } | undefined,
    servedBy: string | undefined,
  ): void {
    this.emit({
      type: 'turn_end',
      reason,
      durationMs: Date.now() - startedAt,
      ...(usage ? { usage } : {}),
      ...(servedBy ? { servedBy } : {}),
    })
  }

  /** Execute one tool call, gating on approval, and return the text the model sees. */
  private async runTool(
    call: ChatToolCall,
    settings: AppSettings,
    ctx: ToolContext,
  ): Promise<string> {
    const tool = TOOLS_BY_NAME.get(call.function.name)

    if (!tool) {
      const message = `Unknown tool "${call.function.name}". Available tools: ${TOOLS.map((t) => t.name).join(', ')}.`
      this.emit({ type: 'tool_start', id: call.id, name: call.function.name, input: {} })
      this.emit({ type: 'tool_end', id: call.id, status: 'error', summary: 'unknown tool' })
      return message
    }

    let input: Record<string, unknown>
    try {
      input = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
    } catch {
      this.emit({ type: 'tool_start', id: call.id, name: tool.name, input: {} })
      this.emit({ type: 'tool_end', id: call.id, status: 'error', summary: 'bad arguments' })
      return `The arguments for ${tool.name} were not valid JSON. Send them again as a JSON object.`
    }

    this.emit({ type: 'tool_start', id: call.id, name: tool.name, input })

    const verdict = decide(tool.name, tool.kind, input, settings)

    if (verdict.decision === 'deny') {
      this.emit({ type: 'tool_end', id: call.id, status: 'denied', summary: 'blocked' })
      return verdict.reason
    }

    if (verdict.decision === 'ask') {
      let preview: { title: string; detail: string }
      try {
        preview = tool.preview
          ? await tool.preview(input)
          : { title: tool.name, detail: JSON.stringify(input, null, 2) }
      } catch (err) {
        // A preview that throws usually means the call itself is invalid
        // (e.g. old_string not found) — report that instead of prompting.
        const message = (err as Error).message
        this.emit({ type: 'tool_end', id: call.id, status: 'error', summary: message })
        return `Error: ${message}`
      }

      const request: ApprovalRequest = {
        id: call.id,
        toolName: tool.name,
        title: preview.title,
        detail: preview.detail,
        risk: riskFor(tool, input),
      }

      const approved = await this.awaitApproval(request, input)
      if (!approved) {
        this.emit({ type: 'tool_end', id: call.id, status: 'denied', summary: 'denied by user' })
        return `The user denied this ${tool.name} call. Do not retry it or attempt the same change another way. Ask them how they would like to proceed.`
      }
    }

    try {
      const result = await tool.execute(input, ctx)
      this.emit({
        type: 'tool_end',
        id: call.id,
        status: result.isError ? 'error' : 'ok',
        summary: result.summary,
        detail: result.content,
      })
      return result.content
    } catch (err) {
      const message = (err as Error).message
      this.emit({ type: 'tool_end', id: call.id, status: 'error', summary: message, detail: message })
      return `Error: ${message}`
    }
  }

  private awaitApproval(
    request: ApprovalRequest,
    input: Record<string, unknown>,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(request.id, resolve)
      // Remembered so "always allow" can be scoped to the actual call — a
      // blanket run_command grant is not what one prompt should buy.
      this.pendingRules.set(request.id, ruleForAlwaysAllow(request.toolName, input))
      this.emit({ type: 'approval_request', request })
    })
  }
}

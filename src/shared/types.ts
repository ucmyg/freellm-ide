/**
 * Types shared across the main process, the preload bridge and the renderer.
 * Keep this file dependency-free — it is imported from all three contexts.
 */

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export interface GatewaySettings {
  /** Base URL of the FreeLLMAPI gateway, e.g. http://localhost:3001 */
  baseUrl: string
  /** Whether a unified API key has been stored (the key itself never leaves main). */
  hasApiKey: boolean
  /** Model id the agent should use, as the gateway expects it. */
  model: string
  /** Upper bound on tokens the model may emit per turn. */
  maxTokens: number
  temperature: number
}

export interface AppSettings extends GatewaySettings {
  /** How much the agent may do without asking. See PermissionMode. */
  permissionMode: PermissionMode
  /** Rules granting silent approval, e.g. "run_command(npm run test:*)". */
  allowRules: string[]
  /** Rules that always refuse, overriding every mode including 'full'. */
  denyRules: string[]
  /** Let the agent reach paths outside the open folder, anywhere on the machine. */
  fullDiskAccess: boolean
  /** Extra directory roots the agent may reach when fullDiskAccess is off. */
  additionalRoots: string[]
  /** How long run_command waits before killing a foreground command. */
  commandTimeoutMs: number
  /** Hard cap on agent tool-call iterations in a single turn. */
  maxIterations: number
}

/* ------------------------------------------------------------------ */
/* Permissions                                                         */
/* ------------------------------------------------------------------ */

/**
 * How much the agent may do on its own.
 *
 * - `readOnly`  — inspect only; every write and command is refused.
 * - `default`   — reads run freely, writes and commands ask first.
 * - `acceptEdits` — file edits apply silently, commands still ask.
 * - `full`      — nothing asks. Deny rules are still enforced.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'full' | 'readOnly'

export const PERMISSION_MODES: readonly PermissionMode[] = [
  'readOnly',
  'default',
  'acceptEdits',
  'full',
]

export interface PermissionModeInfo {
  id: PermissionMode
  label: string
  /** One line, shown in the switcher and the status bar tooltip. */
  hint: string
}

export const PERMISSION_MODE_INFO: Record<PermissionMode, PermissionModeInfo> = {
  readOnly: { id: 'readOnly', label: 'Read only', hint: 'Look, never touch. Writes and commands are refused.' },
  default: { id: 'default', label: 'Ask first', hint: 'Reads run freely. Edits and commands ask for approval.' },
  acceptEdits: { id: 'acceptEdits', label: 'Auto edit', hint: 'File edits apply on their own. Commands still ask.' },
  full: { id: 'full', label: 'Full access', hint: 'Nothing asks. Only your deny rules still apply.' },
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

export interface ModelInfo {
  id: string
  label: string
  /** Provider/owner as reported by the gateway, when known. */
  owner?: string
  contextWindow?: number
  maxOutputTokens?: number
  /** True when the gateway reports the model can do tool/function calling. */
  supportsTools?: boolean
  supportsVision?: boolean
}

/* ------------------------------------------------------------------ */
/* Workspace                                                           */
/* ------------------------------------------------------------------ */

export interface DirEntry {
  name: string
  /** Path relative to the workspace root, using forward slashes. */
  path: string
  isDirectory: boolean
  size?: number
}

export interface FileContent {
  path: string
  content: string
  /** Detected Monaco language id. */
  language: string
  /** True when the file was too large or looked binary and was not fully read. */
  truncated: boolean
}

/* ------------------------------------------------------------------ */
/* Agent conversation                                                  */
/* ------------------------------------------------------------------ */

export type ToolStatus = 'running' | 'ok' | 'error' | 'denied'

export interface ToolCallView {
  id: string
  name: string
  input: unknown
  status: ToolStatus
  /** One-line result summary shown collapsed, e.g. "read 128 lines". */
  summary?: string
  /** Full result body shown when expanded. */
  detail?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** Tool calls issued during this assistant message, in order. */
  toolCalls: ToolCallView[]
  /** Set when the turn failed. */
  error?: string
  /** Wall-clock ms the turn took, assistant messages only. */
  durationMs?: number
  usage?: { inputTokens: number; outputTokens: number }
  /** Model that actually served the turn, as reported by the gateway. */
  servedBy?: string
}

/* ------------------------------------------------------------------ */
/* Streaming events: main -> renderer                                  */
/* ------------------------------------------------------------------ */

export type RiskLevel = 'low' | 'medium' | 'high'

export interface ApprovalRequest {
  id: string
  toolName: string
  /** Short human phrasing, e.g. "Run npm test". */
  title: string
  /** The concrete thing that will happen — a command line, or a unified diff. */
  detail: string
  risk: RiskLevel
}

export type AgentEvent =
  | { type: 'turn_start'; messageId: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_end'; id: string; status: ToolStatus; summary: string; detail?: string }
  | { type: 'approval_request'; request: ApprovalRequest }
  | { type: 'approval_resolved'; id: string; approved: boolean }
  | { type: 'files_changed'; paths: string[] }
  | {
      type: 'turn_end'
      reason: 'complete' | 'cancelled' | 'error' | 'max_iterations'
      error?: string
      durationMs: number
      usage?: { inputTokens: number; outputTokens: number }
      servedBy?: string
    }

/* ------------------------------------------------------------------ */
/* Background processes the agent started                              */
/* ------------------------------------------------------------------ */

export interface ProcessInfo {
  id: string
  command: string
  cwd: string
  startedAt: number
  running: boolean
  exitCode: number | null
  totalLines: number
}

/* ------------------------------------------------------------------ */
/* Terminal                                                            */
/* ------------------------------------------------------------------ */

export interface TerminalSpawnResult {
  id: string
  /** Shell that was actually launched. */
  shell: string
  /** False when no PTY backend was available and a degraded pipe shell is used. */
  pty: boolean
}

export type TerminalEvent =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number }

/* ------------------------------------------------------------------ */
/* Generic result envelope for IPC calls that can fail                 */
/* ------------------------------------------------------------------ */

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

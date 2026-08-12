import type { AppSettings, PermissionMode } from '@shared/types'

/**
 * Decides whether a tool call runs silently, asks the user, or is refused.
 *
 * Rules are strings the user writes, in one of two forms:
 *   run_command                  — every call of that tool
 *   run_command(npm run test:*)  — only calls whose subject matches the glob
 *
 * The subject is the argument that matters for that tool: the command line for
 * run_command, the path for file tools.
 */

export type Decision = 'allow' | 'ask' | 'deny'

/** What a tool does, which is what the permission modes actually gate on. */
export type ToolKind = 'read' | 'edit' | 'command' | 'destructive'

export interface PermissionResult {
  decision: Decision
  /** Shown to the user, or handed to the model when refused. */
  reason: string
}

export interface ParsedRule {
  tool: string
  /** Absent means "any call of this tool". */
  pattern?: string
}

/** `tool` or `tool(pattern)`; anything else is ignored rather than throwing. */
export function parseRule(raw: string): ParsedRule | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const open = trimmed.indexOf('(')
  if (open === -1) return { tool: trimmed }

  if (!trimmed.endsWith(')')) return null
  const tool = trimmed.slice(0, open).trim()
  const pattern = trimmed.slice(open + 1, -1).trim()
  if (!tool) return null
  return pattern ? { tool, pattern } : { tool }
}

/** Glob with `*` as "any run of characters". Everything else is literal. */
function globToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, caseInsensitive ? 'i' : '')
}

/**
 * The argument a rule's pattern is matched against.
 * Returns null when the tool has nothing meaningful to match on, in which case
 * only a bare `tool` rule can apply.
 */
export function subjectFor(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'run_command') {
    return typeof input.command === 'string' ? input.command : null
  }
  const path = input.path
  if (typeof path === 'string') return path.split('\\').join('/')
  return null
}

function matches(rule: ParsedRule, toolName: string, subject: string | null): boolean {
  if (rule.tool !== toolName) return false
  if (!rule.pattern) return true
  if (subject === null) return false

  // Paths are case-insensitive on Windows; commands never are, so a rule
  // cannot be widened by casing.
  const caseInsensitive = toolName !== 'run_command' && process.platform === 'win32'
  return globToRegExp(rule.pattern, caseInsensitive).test(subject)
}

function anyMatch(
  rules: string[],
  toolName: string,
  subject: string | null,
): ParsedRule | null {
  for (const raw of rules) {
    const rule = parseRule(raw)
    if (rule && matches(rule, toolName, subject)) return rule
  }
  return null
}

function describe(rule: ParsedRule): string {
  return rule.pattern ? `${rule.tool}(${rule.pattern})` : rule.tool
}

const MODE_REFUSAL: Record<PermissionMode, string> = {
  readOnly:
    'The IDE is in read-only mode, so this was refused. Tell the user what you would change and let them switch modes.',
  default: '',
  acceptEdits: '',
  full: '',
}

export function decide(
  toolName: string,
  kind: ToolKind,
  input: Record<string, unknown>,
  settings: AppSettings,
): PermissionResult {
  const subject = subjectFor(toolName, input)

  // Deny rules win over everything, including 'full'.
  const denied = anyMatch(settings.denyRules, toolName, subject)
  if (denied) {
    return {
      decision: 'deny',
      reason: `Refused by your deny rule "${describe(denied)}". Do not attempt this another way — tell the user it is blocked.`,
    }
  }

  if (settings.permissionMode === 'readOnly' && kind !== 'read') {
    return { decision: 'deny', reason: MODE_REFUSAL.readOnly }
  }

  // Reads never prompt in any mode that allows them at all.
  if (kind === 'read') return { decision: 'allow', reason: 'read-only tool' }

  const allowed = anyMatch(settings.allowRules, toolName, subject)
  if (allowed) {
    return { decision: 'allow', reason: `allowed by "${describe(allowed)}"` }
  }

  switch (settings.permissionMode) {
    case 'full':
      return { decision: 'allow', reason: 'full access mode' }
    case 'acceptEdits':
      // Edits apply silently; commands and deletions still stop for a human.
      return kind === 'edit'
        ? { decision: 'allow', reason: 'auto-edit mode' }
        : { decision: 'ask', reason: 'auto-edit mode still asks before this' }
    default:
      return { decision: 'ask', reason: 'ask-first mode' }
  }
}

/**
 * The rule to persist when the user picks "always allow" on a prompt.
 * Commands are scoped to the exact command line rather than the whole tool —
 * granting blanket shell access from a single prompt is not what anyone means.
 */
export function ruleForAlwaysAllow(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName !== 'run_command') return toolName
  const subject = subjectFor(toolName, input)
  return subject ? `${toolName}(${subject})` : toolName
}

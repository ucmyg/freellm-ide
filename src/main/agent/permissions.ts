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
function globToRegExp(
  pattern: string,
  opts: { caseInsensitive: boolean; anchored: boolean },
): RegExp {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  const body = opts.anchored ? `^${source}$` : source
  return new RegExp(body, opts.caseInsensitive ? 'i' : '')
}

/** Tools that hand a string straight to a shell. */
const COMMAND_TOOLS = new Set(['run_command', 'start_background'])

/**
 * The argument a rule's pattern is matched against.
 * Returns null when the tool has nothing meaningful to match on, in which case
 * only a bare `tool` rule can apply.
 */
export function subjectFor(toolName: string, input: Record<string, unknown>): string | null {
  if (COMMAND_TOOLS.has(toolName)) {
    return typeof input.command === 'string' ? input.command : null
  }
  const path = input.path
  if (typeof path === 'string') return path.split('\\').join('/')
  return null
}

/**
 * Allow and deny are matched deliberately asymmetrically.
 *
 * An allow rule is a grant, so it stays narrow: anchored end to end, and
 * case-sensitive for commands, so no casing trick can widen what the user
 * agreed to.
 *
 * A deny rule is a prohibition, so it stays broad: matched anywhere in the
 * subject and case-insensitively, because `cd /tmp && GIT PUSH` is the same
 * dangerous act as `git push` and a Windows shell would run both.
 */
function matches(
  rule: ParsedRule,
  toolName: string,
  subject: string | null,
  intent: 'allow' | 'deny',
): boolean {
  if (rule.tool !== toolName) return false
  if (!rule.pattern) return true
  if (subject === null) return false

  if (intent === 'deny') {
    return globToRegExp(rule.pattern, { caseInsensitive: true, anchored: false }).test(subject)
  }

  // Paths are case-insensitive on Windows; command lines are never treated as
  // such for an allow rule, so casing cannot widen a grant.
  const caseInsensitive = !COMMAND_TOOLS.has(toolName) && process.platform === 'win32'
  return globToRegExp(rule.pattern, { caseInsensitive, anchored: true }).test(subject)
}

function anyMatch(
  rules: string[],
  toolName: string,
  subject: string | null,
  intent: 'allow' | 'deny',
): ParsedRule | null {
  for (const raw of rules) {
    const rule = parseRule(raw)
    if (rule && matches(rule, toolName, subject, intent)) return rule
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
  const denied = anyMatch(settings.denyRules, toolName, subject, 'deny')
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

  const allowed = anyMatch(settings.allowRules, toolName, subject, 'allow')
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
 *
 * Every command-kind tool is scoped to the exact command line rather than the
 * whole tool. Keying on the kind rather than the name matters: start_background
 * also runs arbitrary shell, so a bare rule for it would hand over unattended
 * shell access from a single prompt — which is not what "always allow" means
 * to anyone clicking it.
 */
export function ruleForAlwaysAllow(
  toolName: string,
  kind: ToolKind,
  input: Record<string, unknown>,
): string {
  if (kind !== 'command') return toolName
  const subject = subjectFor(toolName, input)
  return subject ? `${toolName}(${subject})` : toolName
}

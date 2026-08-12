/**
 * Minimal unified-diff generator, used to show the user exactly what an edit
 * will do before they approve it. Not a full diff implementation — it only
 * needs to be readable and honest.
 */

interface Op {
  type: 'equal' | 'delete' | 'insert'
  line: string
}

/** Classic LCS table. Inputs are capped by the caller, so O(n*m) is acceptable. */
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  // lengths[i][j] = LCS length of a[i..] and b[j..]
  const lengths: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i]![j] =
        a[i] === b[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', line: a[i]! })
      i++
      j++
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      ops.push({ type: 'delete', line: a[i]! })
      i++
    } else {
      ops.push({ type: 'insert', line: b[j]! })
      j++
    }
  }
  while (i < n) ops.push({ type: 'delete', line: a[i++]! })
  while (j < m) ops.push({ type: 'insert', line: b[j++]! })
  return ops
}

const MAX_DIFF_LINES = 4000

export interface DiffStats {
  added: number
  removed: number
}

/**
 * Produce a unified diff with `context` lines around each hunk.
 * Returns the rendered text plus counts for a one-line summary.
 */
export function unifiedDiff(
  before: string,
  after: string,
  filePath: string,
  context = 3,
): { text: string; stats: DiffStats } {
  const a = before.split('\n')
  const b = after.split('\n')

  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    const added = Math.max(0, b.length - a.length)
    return {
      text: `--- ${filePath}\n+++ ${filePath}\n[file too large to diff — ${a.length} lines before, ${b.length} lines after]`,
      stats: { added, removed: 0 },
    }
  }

  const ops = lcsOps(a, b)
  const stats: DiffStats = { added: 0, removed: 0 }
  for (const op of ops) {
    if (op.type === 'insert') stats.added++
    else if (op.type === 'delete') stats.removed++
  }

  if (stats.added === 0 && stats.removed === 0) {
    return { text: `--- ${filePath}\n+++ ${filePath}\n[no changes]`, stats }
  }

  // Mark which ops to keep: every change, plus `context` equal lines each side.
  const keep = new Array<boolean>(ops.length).fill(false)
  for (let k = 0; k < ops.length; k++) {
    if (ops[k]!.type === 'equal') continue
    for (let d = -context; d <= context; d++) {
      const idx = k + d
      if (idx >= 0 && idx < ops.length) keep[idx] = true
    }
  }

  const lines: string[] = [`--- ${filePath}`, `+++ ${filePath}`]
  let aLine = 1
  let bLine = 1
  let k = 0

  while (k < ops.length) {
    if (!keep[k]) {
      // Skipped region — advance the line counters without emitting.
      if (ops[k]!.type !== 'insert') aLine++
      if (ops[k]!.type !== 'delete') bLine++
      k++
      continue
    }

    // Collect one contiguous hunk.
    const hunkStartA = aLine
    const hunkStartB = bLine
    const body: string[] = []
    let aCount = 0
    let bCount = 0

    while (k < ops.length && keep[k]) {
      const op = ops[k]!
      if (op.type === 'equal') {
        body.push(` ${op.line}`)
        aCount++
        bCount++
        aLine++
        bLine++
      } else if (op.type === 'delete') {
        body.push(`-${op.line}`)
        aCount++
        aLine++
      } else {
        body.push(`+${op.line}`)
        bCount++
        bLine++
      }
      k++
    }

    lines.push(`@@ -${hunkStartA},${aCount} +${hunkStartB},${bCount} @@`)
    lines.push(...body)
  }

  return { text: lines.join('\n'), stats }
}

export function summarizeStats(stats: DiffStats): string {
  const parts: string[] = []
  if (stats.added) parts.push(`+${stats.added}`)
  if (stats.removed) parts.push(`-${stats.removed}`)
  return parts.length ? parts.join(' ') : 'no changes'
}

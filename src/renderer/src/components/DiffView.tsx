/**
 * Renders a unified diff (or any plain tool output) with per-line colouring.
 * Kept dumb on purpose — the main process produces the diff text.
 */
export default function DiffView({ text, maxHeight = 320 }: { text: string; maxHeight?: number }) {
  const lines = text.split('\n')

  return (
    <pre
      style={{ maxHeight }}
      className="selectable overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-[family-name:var(--font-mono)] text-[11px] leading-[1.5]"
    >
      {lines.map((line, i) => (
        <div key={i} className={classFor(line)}>
          {line || ' '}
        </div>
      ))}
    </pre>
  )
}

function classFor(line: string): string {
  // Guard against the +++/--- file headers being coloured as content.
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-[var(--color-text-faint)]'
  if (line.startsWith('@@')) return 'diff-line-hunk'
  if (line.startsWith('+')) return 'diff-line-add'
  if (line.startsWith('-')) return 'diff-line-del'
  return ''
}

import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import type { ApprovalRequest, RiskLevel } from '@shared/types'
import DiffView from './DiffView'

interface Props {
  request: ApprovalRequest
  onResolve(approved: boolean, alwaysAllow?: boolean): void
}

const RISK_STYLES: Record<RiskLevel, { border: string; text: string; Icon: typeof ShieldCheck }> = {
  low: { border: 'var(--color-ok)', text: 'var(--color-ok)', Icon: ShieldCheck },
  medium: { border: 'var(--color-accent)', text: 'var(--color-accent)', Icon: ShieldQuestion },
  high: { border: 'var(--color-danger)', text: 'var(--color-danger)', Icon: ShieldAlert },
}

export default function ApprovalPrompt({ request, onResolve }: Props) {
  const style = RISK_STYLES[request.risk]
  const { Icon } = style

  return (
    <div
      // A left rule carries the risk colour so the whole card is not outlined
      // in red for an ordinary edit.
      className="rounded-md border border-[var(--color-border-strong)] border-l-2 bg-[var(--color-bg-overlay)] p-3"
      style={{ borderLeftColor: style.border }}
    >
      <div className="mb-2 flex items-start gap-2">
        <Icon size={15} className="mt-[1px] shrink-0" style={{ color: style.text }} />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{request.title}</p>
          {request.risk === 'high' && (
            <p className="mt-0.5 text-[11px]" style={{ color: style.text }}>
              This is destructive or hard to undo. Read it carefully.
            </p>
          )}
        </div>
      </div>

      <DiffView text={request.detail} maxHeight={240} />

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          onClick={() => onResolve(true)}
          autoFocus
          className="rounded-md bg-[var(--color-accent)] px-3 py-1 text-[12px] font-medium text-black transition-[filter] hover:brightness-110"
        >
          Approve
        </button>
        <button
          onClick={() => onResolve(false)}
          className="rounded-md border border-[var(--color-border-strong)] px-3 py-1 text-[12px] transition-colors hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
        >
          Deny
        </button>
        {/* Escalating trust is offered only for the reversible tools. */}
        {request.risk !== 'high' && (
          <button
            onClick={() => onResolve(true, true)}
            title={
              request.toolName === 'run_command'
                ? 'Adds an allow rule for exactly this command'
                : `Stop asking before every ${request.toolName} call`
            }
            className="ml-auto text-[11px] text-[var(--color-text-faint)] underline decoration-dotted hover:text-[var(--color-text-muted)]"
          >
            {request.toolName === 'run_command'
              ? 'Always allow this command'
              : `Always allow ${request.toolName}`}
          </button>
        )}
      </div>
    </div>
  )
}

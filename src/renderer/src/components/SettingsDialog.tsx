import { Check, Loader2, TriangleAlert, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { PERMISSION_MODE_INFO, PERMISSION_MODES } from '@shared/types'
import { useStore } from '../store'

export default function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen)
  const setOpen = useStore((s) => s.setSettingsOpen)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const models = useStore((s) => s.models)

  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [maxTokens, setMaxTokens] = useState(8192)
  const [temperature, setTemperature] = useState(0)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null)

  // Seed the form on the open transition only. Depending on `settings` would
  // re-run on every save — including the ones this dialog itself triggers —
  // wiping the URL or key the user is halfway through typing.
  useEffect(() => {
    if (!open) return
    const current = useStore.getState().settings
    if (!current) return
    setBaseUrl(current.baseUrl)
    setMaxTokens(current.maxTokens)
    setTemperature(current.temperature)
    setApiKey('')
    setTestResult(null)
  }, [open])

  const onSaveAndTest = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      // Only overwrite the stored key when the user actually typed a new one —
      // the field is intentionally blank on open so the key is never displayed.
      if (apiKey.trim()) {
        const keyRes = await window.ide.settings.setApiKey(apiKey.trim())
        if (!keyRes.ok) {
          setTestResult({ ok: false, detail: keyRes.error })
          return
        }
      }

      const updated = await window.ide.settings.update({
        baseUrl: baseUrl.trim(),
        maxTokens,
        temperature,
      })
      setSettings(updated)

      const res = await window.ide.gateway.test()
      setTestResult(res.ok ? res.value : { ok: false, detail: res.error })

      if (res.ok && res.value.ok) {
        const modelsRes = await window.ide.gateway.models()
        if (modelsRes.ok) {
          useStore.getState().setModels(modelsRes.value)
          // Adopt a sensible default the first time a catalog arrives.
          if (!updated.model && modelsRes.value.length) {
            setSettings(await window.ide.settings.update({ model: 'auto' }))
          }
        }
      }
    } catch (err) {
      // Without this, one rejected IPC call leaves `testing` true forever and
      // the button is permanently disabled with no explanation.
      setTestResult({ ok: false, detail: (err as Error).message ?? String(err) })
    } finally {
      setApiKey('')
      setTesting(false)
    }
  }, [apiKey, baseUrl, maxTokens, temperature, setSettings])

  const onClearKey = useCallback(async () => {
    await window.ide.settings.clearApiKey()
    setSettings(await window.ide.settings.get())
    setTestResult(null)
  }, [setSettings])

  const patch = useCallback(
    async (next: Parameters<typeof window.ide.settings.update>[0]) => {
      setSettings(await window.ide.settings.update(next))
    },
    [setSettings],
  )

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={() => setOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-full w-[560px] overflow-y-auto rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-raised)] shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <h2 className="font-semibold">Settings</h2>
          <button
            onClick={() => setOpen(false)}
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-overlay)] hover:text-[var(--color-text)]"
          >
            <X size={15} />
          </button>
        </header>

        <div className="space-y-5 p-4">
          <section className="space-y-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
              Gateway
            </h3>

            <Field
              label="Base URL"
              hint="Any OpenAI-compatible endpoint. The /v1 suffix is optional."
            >
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:3001"
                spellCheck={false}
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-input)] px-2 py-1.5 font-[family-name:var(--font-mono)] text-[12px] outline-none focus:border-[var(--color-accent)]"
              />
            </Field>

            <Field
              label="API key"
              hint={
                settings?.hasApiKey
                  ? 'A key is stored, encrypted with your OS keychain. Type a new one to replace it.'
                  : 'Sent as an Authorization: Bearer header. For FreeLLMAPI this is the unified key on the Keys page.'
              }
            >
              <div className="flex gap-2">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={settings?.hasApiKey ? '•••••••••• (stored)' : 'freellmapi-…'}
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-input)] px-2 py-1.5 font-[family-name:var(--font-mono)] text-[12px] outline-none focus:border-[var(--color-accent)]"
                />
                {settings?.hasApiKey && (
                  <button
                    onClick={() => void onClearKey()}
                    className="shrink-0 rounded border border-[var(--color-border-strong)] px-2 text-[11px] hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
                  >
                    Clear
                  </button>
                )}
              </div>
            </Field>

            <div className="flex items-center gap-2">
              <button
                onClick={() => void onSaveAndTest()}
                disabled={testing}
                className="flex items-center gap-1.5 rounded bg-[var(--color-accent)] px-3 py-1.5 font-medium text-black hover:brightness-110 disabled:opacity-50"
              >
                {testing && <Loader2 size={12} className="animate-spin" />}
                Save & test connection
              </button>
            </div>

            {testResult && (
              <p
                className={`flex items-start gap-1.5 rounded border px-2 py-1.5 text-[12px] ${
                  testResult.ok
                    ? 'border-[var(--color-ok)] text-[var(--color-ok)]'
                    : 'border-[var(--color-danger)] text-[var(--color-danger)]'
                }`}
              >
                {testResult.ok ? (
                  <Check size={13} className="mt-[2px] shrink-0" />
                ) : (
                  <TriangleAlert size={13} className="mt-[2px] shrink-0" />
                )}
                <span className="selectable">{testResult.detail}</span>
              </p>
            )}
          </section>

          <section className="space-y-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
              Generation
            </h3>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Max tokens per reply">
                <input
                  type="number"
                  min={256}
                  max={200000}
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(Number(e.target.value))}
                  className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-input)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--color-accent)]"
                />
              </Field>
              <Field label="Temperature" hint="0 is best for code.">
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature}
                  onChange={(e) => setTemperature(Number(e.target.value))}
                  className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-input)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--color-accent)]"
                />
              </Field>
            </div>

            {models.length > 0 && (
              <p className="text-[11px] text-[var(--color-text-faint)]">
                {models.length} models available. Pick one in the Agent panel. The agent needs a
                model that supports tool calling.
              </p>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
              Permissions
            </h3>
            <div className="space-y-1">
              {PERMISSION_MODES.map((mode) => {
                const info = PERMISSION_MODE_INFO[mode]
                const active = settings?.permissionMode === mode
                return (
                  <label
                    key={mode}
                    className={`flex cursor-pointer items-start gap-2 rounded border px-2 py-1.5 ${
                      active
                        ? 'border-[var(--color-accent)] bg-[var(--color-bg-overlay)]'
                        : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="permission-mode"
                      checked={active}
                      onChange={() => void patch({ permissionMode: mode })}
                      className="mt-[3px] accent-[var(--color-accent)]"
                    />
                    <span className="min-w-0">
                      <span className="block text-[12px]">{info.label}</span>
                      <span className="block text-[11px] text-[var(--color-text-faint)]">
                        {info.hint}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>

            <RuleList
              label="Always allow"
              hint='One rule per line. Either a tool name, or a tool with a pattern: run_command(npm run test:*)'
              value={settings?.allowRules ?? []}
              onChange={(allowRules) => void patch({ allowRules })}
            />
            <RuleList
              label="Never allow"
              hint="Refused outright, overriding every mode including full access."
              value={settings?.denyRules ?? []}
              onChange={(denyRules) => void patch({ denyRules })}
              danger
            />
          </section>

          <section className="space-y-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
              Access
            </h3>
            <p className="text-[11px] text-[var(--color-text-faint)]">
              The agent is confined to the open folder. Anything else is refused before it reaches
              the filesystem.
            </p>

            <RuleList
              label="Additional folders"
              hint="One absolute path per line. The agent may read and write inside these too."
              value={settings?.additionalRoots ?? []}
              onChange={(additionalRoots) => void patch({ additionalRoots })}
            />

            <label className="flex cursor-pointer items-start gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={settings?.fullDiskAccess ?? false}
                onChange={(e) => void patch({ fullDiskAccess: e.target.checked })}
                className="mt-[3px] accent-[var(--color-danger)]"
              />
              <span>
                Full disk access
                <span className="block text-[11px] text-[var(--color-danger)]">
                  Removes path confinement entirely — the agent can reach any file your user account
                  can.
                </span>
              </span>
            </label>

            <Field label="Command timeout (seconds)">
              <input
                type="number"
                min={5}
                max={3600}
                value={Math.round((settings?.commandTimeoutMs ?? 120_000) / 1000)}
                onChange={(e) =>
                  void patch({ commandTimeoutMs: Math.max(5, Number(e.target.value)) * 1000 })
                }
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-input)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--color-accent)]"
              />
            </Field>
          </section>
        </div>
      </div>
    </div>
  )
}

/**
 * Edits a string list as one-per-line text. Local state while typing so the
 * caret does not jump, committed on blur.
 */
function RuleList({
  label,
  hint,
  value,
  onChange,
  danger,
}: {
  label: string
  hint: string
  value: string[]
  onChange(next: string[]): void
  danger?: boolean
}) {
  const [draft, setDraft] = useState(value.join('\n'))
  const [editing, setEditing] = useState(false)

  // Adopt external updates (e.g. an "always allow" added from a prompt) only
  // while the user is not mid-edit.
  useEffect(() => {
    if (!editing) setDraft(value.join('\n'))
  }, [value, editing])

  const commit = () => {
    setEditing(false)
    const next = draft
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (next.join('\n') !== value.join('\n')) onChange(next)
  }

  return (
    <label className="block">
      <span className="mb-1 block text-[12px]">{label}</span>
      <textarea
        value={draft}
        rows={Math.min(6, Math.max(2, draft.split('\n').length + 1))}
        spellCheck={false}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        className={`w-full resize-y rounded border bg-[var(--color-bg-input)] px-2 py-1.5 font-[family-name:var(--font-mono)] text-[11px] outline-none ${
          danger
            ? 'border-[var(--color-border)] focus:border-[var(--color-danger)]'
            : 'border-[var(--color-border)] focus:border-[var(--color-accent)]'
        }`}
      />
      <span className="mt-1 block text-[11px] text-[var(--color-text-faint)]">{hint}</span>
    </label>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px]">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-[var(--color-text-faint)]">{hint}</span>}
    </label>
  )
}

import { ArrowUp, Paperclip, Plus, Settings2, Square, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PERMISSION_MODE_INFO, PERMISSION_MODES, type PermissionMode } from '@shared/types'
import { useStore } from '../store'
import ApprovalPrompt from './ApprovalPrompt'
import ToolCallRow from './ToolCallRow'

export default function AgentPanel() {
  const messages = useStore((s) => s.messages)
  const isStreaming = useStore((s) => s.isStreaming)
  const pendingApproval = useStore((s) => s.pendingApproval)
  const applyAgentEvent = useStore((s) => s.applyAgentEvent)
  const settings = useStore((s) => s.settings)
  const models = useStore((s) => s.models)
  const workspaceRoot = useStore((s) => s.workspaceRoot)

  const [input, setInput] = useState('')
  const [attachActive, setAttachActive] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => window.ide.agent.onEvent(applyAgentEvent), [applyAgentEvent])

  // Load the catalog once a key exists so the picker isn't empty on first run.
  useEffect(() => {
    if (!settings?.hasApiKey) return
    void window.ide.gateway.models().then((res) => {
      if (res.ok) {
        useStore.getState().setModels(res.value)
        useStore.getState().setModelsError(null)
      } else {
        useStore.getState().setModelsError(res.error)
      }
    })
  }, [settings?.hasApiKey])

  // Stick to the bottom while the answer streams in.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [messages, pendingApproval])

  const onSend = useCallback(async () => {
    const text = input.trim()
    if (!text || isStreaming) return

    const { activeTab, addUserMessage } = useStore.getState()
    const attachments = attachActive && activeTab ? [activeTab] : []

    setInput('')
    setSendError(null)
    addUserMessage(text)

    const res = await window.ide.agent.send(text, attachments)
    if (!res.ok) setSendError(res.error)
  }, [input, isStreaming, attachActive])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends; Shift+Enter makes a newline.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void onSend()
      }
    },
    [onSend],
  )

  const onModelChange = useCallback((model: string) => {
    void window.ide.settings.update({ model }).then(useStore.getState().setSettings)
  }, [])

  const onNewChat = useCallback(() => {
    void window.ide.agent.reset()
    useStore.getState().clearMessages()
    setSendError(null)
  }, [])

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-[35px] shrink-0 items-center gap-1 border-b border-[var(--color-border)] px-2">
        <span className="pane-label">Agent</span>

        <select
          value={settings?.model ?? 'auto'}
          onChange={(e) => onModelChange(e.target.value)}
          title="Model the agent uses"
          className="ml-auto max-w-[180px] truncate rounded border border-transparent bg-transparent px-1 py-0.5 text-[11.5px] text-[var(--color-text-muted)] outline-none transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
        >
          {models.length === 0 && <option value="auto">auto</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>

        <button
          onClick={onNewChat}
          title="New chat"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-faint)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
        >
          <Plus size={14} />
        </button>
        <button
          onClick={() => useStore.getState().setSettingsOpen(true)}
          title="Settings (Ctrl+,)"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-faint)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
        >
          <Settings2 size={14} />
        </button>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3.5">
        {messages.length === 0 && <EmptyState hasKey={settings?.hasApiKey ?? false} />}

        {messages.map((message, i) => (
          <div key={message.id}>
            {message.role === 'user' ? (
              // A left rule reads as "you said this" without boxing every turn.
              <div className="selectable border-l-2 border-[var(--color-accent-soft)] py-0.5 pl-2.5 whitespace-pre-wrap text-[var(--color-text)]">
                {message.text}
              </div>
            ) : (
              <div className="space-y-2">
                {message.toolCalls.length > 0 && (
                  <div className="space-y-1">
                    {message.toolCalls.map((call) => (
                      <ToolCallRow key={call.id} call={call} />
                    ))}
                  </div>
                )}

                {message.text && (
                  <div
                    className={`md selectable ${
                      isStreaming && i === messages.length - 1 ? 'streaming-caret' : ''
                    }`}
                  >
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
                  </div>
                )}

                {message.error && (
                  <p className="flex items-start gap-1.5 rounded border border-[var(--color-danger)] px-2 py-1.5 text-[var(--color-danger)]">
                    <TriangleAlert size={13} className="mt-[2px] shrink-0" />
                    <span className="selectable">{message.error}</span>
                  </p>
                )}

                <Meta message={message} />
              </div>
            )}
          </div>
        ))}

        {pendingApproval && (
          <ApprovalPrompt
            request={pendingApproval}
            onResolve={(approved, alwaysAllow) =>
              void window.ide.agent.approve(pendingApproval.id, approved, alwaysAllow)
            }
          />
        )}

        {sendError && (
          <p className="rounded border border-[var(--color-danger)] px-2 py-1.5 text-[var(--color-danger)]">
            {sendError}
          </p>
        )}
      </div>

      <div className="shrink-0 border-t border-[var(--color-border)] p-2">
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-input)] transition-colors focus-within:border-[var(--color-border-strong)]">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
            placeholder={
              workspaceRoot ? 'Ask the agent to build or change something…' : 'Open a folder first'
            }
            disabled={!workspaceRoot}
            className="selectable w-full resize-none bg-transparent px-2.5 py-2 text-[13px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] disabled:cursor-not-allowed"
          />

          <div className="flex items-center gap-2 px-2 pb-1.5">
            <button
              onClick={() => setAttachActive(!attachActive)}
              title="Include the file open in the editor with your message"
              className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] ${
                attachActive
                  ? 'bg-[var(--color-accent-dim)] text-[var(--color-text)]'
                  : 'text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]'
              }`}
            >
              <Paperclip size={12} />
              {attachActive ? 'File attached' : 'Attach file'}
            </button>

            <select
              value={settings?.permissionMode ?? 'default'}
              onChange={(e) =>
                void window.ide.settings
                  .update({ permissionMode: e.target.value as PermissionMode })
                  .then(useStore.getState().setSettings)
              }
              title={
                settings ? PERMISSION_MODE_INFO[settings.permissionMode].hint : 'Permission mode'
              }
              className="min-w-0 rounded border border-[var(--color-border)] bg-transparent px-1 py-0.5 text-[11px] text-[var(--color-text-faint)] outline-none hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-muted)]"
            >
              {PERMISSION_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {PERMISSION_MODE_INFO[mode].label}
                </option>
              ))}
            </select>

            {isStreaming ? (
              <button
                onClick={() => void window.ide.agent.cancel()}
                className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] px-2.5 py-1 text-[12px] transition-colors hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
              >
                <Square size={10} className="fill-current" />
                Stop
              </button>
            ) : (
              <button
                onClick={() => void onSend()}
                disabled={!input.trim() || !workspaceRoot}
                title="Enter to send, Shift+Enter for a newline"
                className="ml-auto flex shrink-0 items-center gap-1 rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[12px] font-medium text-black transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30"
              >
                <ArrowUp size={12} />
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Meta({ message }: { message: { durationMs?: number; usage?: { inputTokens: number; outputTokens: number }; servedBy?: string } }) {
  if (!message.durationMs) return null
  const parts: string[] = [`${(message.durationMs / 1000).toFixed(1)}s`]
  if (message.servedBy) parts.push(message.servedBy)
  if (message.usage?.outputTokens) parts.push(`${message.usage.outputTokens} out`)

  return (
    <p className="pt-0.5 font-[family-name:var(--font-mono)] text-[10px] text-[var(--color-text-faint)]">
      {parts.join('  ·  ')}
    </p>
  )
}

function EmptyState({ hasKey }: { hasKey: boolean }) {
  if (!hasKey) {
    return (
      <div className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-overlay)] p-3">
        <p className="mb-1 font-medium">Connect your gateway</p>
        <p className="text-[12px] text-[var(--color-text-muted)]">
          Add your gateway URL and API key to start. The key is on your gateway dashboard&apos;s Keys
          page.
        </p>
        <button
          onClick={() => useStore.getState().setSettingsOpen(true)}
          className="mt-2.5 rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[12px] font-medium text-black transition-[filter] hover:brightness-110"
        >
          Open settings
        </button>
      </div>
    )
  }

  const examples = [
    'What does this project do?',
    'Add retry with backoff to the fetch helper',
    'Run the tests and fix whatever fails',
    'Start the dev server and check it boots',
  ]

  return (
    <div>
      <p className="mb-2.5 text-[12px] text-[var(--color-text-muted)]">
        Ask for a change and the agent will work in this folder.
      </p>
      <ul className="space-y-1.5">
        {examples.map((example) => (
          <li
            key={example}
            className="text-[12px] text-[var(--color-text-faint)] before:mr-1.5 before:text-[var(--color-border-strong)] before:content-['—']"
          >
            {example}
          </li>
        ))}
      </ul>
    </div>
  )
}

import { create } from 'zustand'
import type {
  AgentEvent,
  AppSettings,
  ApprovalRequest,
  ChatMessage,
  DirEntry,
  ModelInfo,
  ToolCallView,
} from '@shared/types'

/**
 * Single renderer store. The main process owns the truth for files, settings
 * and the conversation transcript sent to the model; this mirrors just enough
 * to render.
 */

export interface OpenTab {
  path: string
  content: string
  /** Content as last read from or written to disk, for dirty checks. */
  savedContent: string
  language: string
}

interface State {
  /* workspace */
  workspaceRoot: string | null
  entries: Record<string, DirEntry[]>
  expanded: Set<string>
  treeError: string | null

  /* editor */
  tabs: OpenTab[]
  activeTab: string | null

  /* agent */
  messages: ChatMessage[]
  isStreaming: boolean
  pendingApproval: ApprovalRequest | null

  /* settings */
  settings: AppSettings | null
  models: ModelInfo[]
  modelsError: string | null
  settingsOpen: boolean

  /* layout */
  terminalOpen: boolean
  sidebarWidth: number
  agentWidth: number

  /* actions */
  setWorkspaceRoot(root: string | null): void
  setEntries(path: string, entries: DirEntry[]): void
  toggleExpanded(path: string): void
  setTreeError(err: string | null): void

  openTab(tab: OpenTab): void
  closeTab(path: string): void
  setActiveTab(path: string | null): void
  updateTabContent(path: string, content: string): void
  markTabSaved(path: string, content: string): void

  addUserMessage(text: string): void
  applyAgentEvent(event: AgentEvent): void
  clearMessages(): void
  setPendingApproval(req: ApprovalRequest | null): void

  setSettings(s: AppSettings): void
  setModels(models: ModelInfo[]): void
  setModelsError(err: string | null): void
  setSettingsOpen(open: boolean): void

  setTerminalOpen(open: boolean): void
  setSidebarWidth(w: number): void
  setAgentWidth(w: number): void
}

let messageCounter = 0
const nextId = (prefix: string): string => `${prefix}-${++messageCounter}-${Date.now()}`

export const useStore = create<State>((set, get) => ({
  workspaceRoot: null,
  entries: {},
  expanded: new Set<string>(),
  treeError: null,

  tabs: [],
  activeTab: null,

  messages: [],
  isStreaming: false,
  pendingApproval: null,

  settings: null,
  models: [],
  modelsError: null,
  settingsOpen: false,

  terminalOpen: false,
  sidebarWidth: 240,
  agentWidth: 400,

  setWorkspaceRoot: (root) =>
    set({
      workspaceRoot: root,
      entries: {},
      expanded: new Set<string>(),
      tabs: [],
      activeTab: null,
      treeError: null,
    }),

  setEntries: (path, entries) => set((s) => ({ entries: { ...s.entries, [path]: entries } })),

  toggleExpanded: (path) =>
    set((s) => {
      const next = new Set(s.expanded)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return { expanded: next }
    }),

  setTreeError: (treeError) => set({ treeError }),

  openTab: (tab) =>
    set((s) => {
      const existing = s.tabs.find((t) => t.path === tab.path)
      if (existing) return { activeTab: tab.path }
      return { tabs: [...s.tabs, tab], activeTab: tab.path }
    }),

  closeTab: (path) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.path !== path)
      let activeTab = s.activeTab
      if (activeTab === path) {
        const idx = s.tabs.findIndex((t) => t.path === path)
        // Prefer the tab to the left, matching editor convention.
        activeTab = tabs[Math.max(0, idx - 1)]?.path ?? null
      }
      return { tabs, activeTab }
    }),

  setActiveTab: (activeTab) => set({ activeTab }),

  updateTabContent: (path, content) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.path === path ? { ...t, content } : t)),
    })),

  markTabSaved: (path, content) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.path === path ? { ...t, content, savedContent: content } : t)),
    })),

  addUserMessage: (text) =>
    set((s) => ({
      messages: [...s.messages, { id: nextId('user'), role: 'user', text, toolCalls: [] }],
    })),

  applyAgentEvent: (event) => {
    const s = get()

    switch (event.type) {
      case 'turn_start':
        set({
          isStreaming: true,
          messages: [
            ...s.messages,
            { id: event.messageId, role: 'assistant', text: '', toolCalls: [] },
          ],
        })
        return

      case 'text_delta':
        set({ messages: patchLast(s.messages, (m) => ({ ...m, text: m.text + event.text })) })
        return

      case 'tool_start':
        set({
          messages: patchLast(s.messages, (m) => ({
            ...m,
            toolCalls: [
              ...m.toolCalls,
              { id: event.id, name: event.name, input: event.input, status: 'running' },
            ],
          })),
        })
        return

      case 'tool_end':
        set({
          messages: patchLast(s.messages, (m) => ({
            ...m,
            toolCalls: m.toolCalls.map((tc): ToolCallView =>
              tc.id === event.id
                ? {
                    ...tc,
                    status: event.status,
                    summary: event.summary,
                    ...(event.detail === undefined ? {} : { detail: event.detail }),
                  }
                : tc,
            ),
          })),
        })
        return

      case 'approval_request':
        set({ pendingApproval: event.request })
        return

      case 'approval_resolved':
        set({ pendingApproval: null })
        return

      case 'turn_end':
        set({
          isStreaming: false,
          pendingApproval: null,
          messages: patchLast(s.messages, (m) => ({
            ...m,
            durationMs: event.durationMs,
            ...(event.usage ? { usage: event.usage } : {}),
            ...(event.servedBy ? { servedBy: event.servedBy } : {}),
            ...(event.reason === 'error' && event.error ? { error: event.error } : {}),
            ...(event.reason === 'cancelled' ? { error: 'Cancelled.' } : {}),
            ...(event.reason === 'max_iterations'
              ? { error: 'Stopped: hit the tool-call limit for one turn.' }
              : {}),
          })),
        })
        return

      case 'files_changed':
        // Handled by a subscriber in App; nothing to mirror in the store.
        return
    }
  },

  clearMessages: () => set({ messages: [], pendingApproval: null }),
  setPendingApproval: (pendingApproval) => set({ pendingApproval }),

  setSettings: (settings) => set({ settings }),
  setModels: (models) => set({ models }),
  setModelsError: (modelsError) => set({ modelsError }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  setTerminalOpen: (terminalOpen) => set({ terminalOpen }),
  setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
  setAgentWidth: (agentWidth) => set({ agentWidth }),
}))

/** Replace the final assistant message, leaving everything before it untouched. */
function patchLast(
  messages: ChatMessage[],
  fn: (m: ChatMessage) => ChatMessage,
): ChatMessage[] {
  if (messages.length === 0) return messages
  const last = messages[messages.length - 1]!
  if (last.role !== 'assistant') return messages
  return [...messages.slice(0, -1), fn(last)]
}

export const isDirty = (tab: OpenTab): boolean => tab.content !== tab.savedContent

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AgentEvent,
  AppSettings,
  DirEntry,
  FileContent,
  ModelInfo,
  ProcessInfo,
  Result,
  TerminalEvent,
  TerminalSpawnResult,
} from '@shared/types'

/**
 * The only surface the renderer can reach. Node integration stays off and
 * context isolation stays on — everything crosses here, explicitly.
 */

const api = {
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC.settingsUpdate, patch),
    setApiKey: (key: string): Promise<Result<null>> => ipcRenderer.invoke(IPC.settingsSetApiKey, key),
    clearApiKey: (): Promise<Result<null>> => ipcRenderer.invoke(IPC.settingsClearApiKey),
  },

  gateway: {
    test: (): Promise<Result<{ ok: boolean; detail: string }>> => ipcRenderer.invoke(IPC.gatewayTest),
    models: (): Promise<Result<ModelInfo[]>> => ipcRenderer.invoke(IPC.gatewayModels),
  },

  workspace: {
    open: (): Promise<Result<string | null>> => ipcRenderer.invoke(IPC.workspaceOpen),
    /** The open folder, plus any file passed on the command line (once). */
    current: (): Promise<{ root: string | null; initialFile: string | null }> =>
      ipcRenderer.invoke(IPC.workspaceCurrent),
    list: (path?: string): Promise<Result<DirEntry[]>> => ipcRenderer.invoke(IPC.workspaceList, path),
    read: (path: string): Promise<Result<FileContent>> => ipcRenderer.invoke(IPC.workspaceRead, path),
    write: (path: string, content: string): Promise<Result<null>> =>
      ipcRenderer.invoke(IPC.workspaceWrite, path, content),
    create: (path: string, isDirectory: boolean): Promise<Result<null>> =>
      ipcRenderer.invoke(IPC.workspaceCreate, path, isDirectory),
    remove: (path: string): Promise<Result<null>> => ipcRenderer.invoke(IPC.workspaceDelete, path),
    rename: (from: string, to: string): Promise<Result<null>> =>
      ipcRenderer.invoke(IPC.workspaceRename, from, to),
    search: (
      query: string,
      opts?: { include?: string; isRegex?: boolean; caseSensitive?: boolean },
    ): Promise<Result<{ path: string; line: number; text: string }[]>> =>
      ipcRenderer.invoke(IPC.workspaceSearch, query, opts),
  },

  agent: {
    send: (text: string, attachedPaths: string[]): Promise<Result<null>> =>
      ipcRenderer.invoke(IPC.agentSend, text, attachedPaths),
    cancel: (): Promise<void> => ipcRenderer.invoke(IPC.agentCancel),
    /** alwaysAllow persists an allow rule scoped to this call. */
    approve: (id: string, approved: boolean, alwaysAllow?: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.agentApprove, id, approved, alwaysAllow),
    reset: (): Promise<void> => ipcRenderer.invoke(IPC.agentReset),
    /** Long-running processes the agent started this session. */
    processes: (): Promise<ProcessInfo[]> => ipcRenderer.invoke(IPC.processesList),
    stopProcess: (id: string): Promise<Result<null>> => ipcRenderer.invoke(IPC.processesStop, id),
    onEvent: (handler: (event: AgentEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: AgentEvent) => handler(payload)
      ipcRenderer.on(IPC.agentEvent, listener)
      return () => ipcRenderer.off(IPC.agentEvent, listener)
    },
  },

  terminal: {
    create: (cols: number, rows: number): Promise<Result<TerminalSpawnResult>> =>
      ipcRenderer.invoke(IPC.terminalCreate, cols, rows),
    write: (id: string, data: string): void => {
      void ipcRenderer.invoke(IPC.terminalWrite, id, data)
    },
    resize: (id: string, cols: number, rows: number): void => {
      void ipcRenderer.invoke(IPC.terminalResize, id, cols, rows)
    },
    dispose: (id: string): void => {
      void ipcRenderer.invoke(IPC.terminalDispose, id)
    },
    onEvent: (handler: (event: TerminalEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: TerminalEvent) => handler(payload)
      ipcRenderer.on(IPC.terminalEvent, listener)
      return () => ipcRenderer.off(IPC.terminalEvent, listener)
    },
  },
}

export type IdeApi = typeof api

contextBridge.exposeInMainWorld('ide', api)

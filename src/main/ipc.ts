import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { AgentEvent, AppSettings, Result, TerminalEvent } from '@shared/types'
import { AgentSession } from './agent/loop.js'
import { listBackground, stopBackground } from './agent/processes.js'
import { listModels, ping, type GatewayConfig } from './gateway/client.js'
import { getApiKey, loadSettings, setApiKey, clearApiKey, updateSettings } from './settings.js'
import {
  createTerminal,
  disposeTerminal,
  homeDir,
  resizeTerminal,
  writeTerminal,
} from './terminal/index.js'
import * as ws from './workspace/index.js'

/** Wrap a handler so a thrown error becomes a Result the renderer can render. */
async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? String(err) }
  }
}

/** Paths of files open in the editor, mirrored from the renderer for prompt context. */
let openFiles: string[] = []

export function registerIpc(
  getWindow: () => BrowserWindow | null,
  initialFile: string | null = null,
): void {
  // Consumed once: a renderer reload should not reopen the CLI file after the
  // user has closed it.
  let pendingInitialFile = initialFile

  const send = (channel: string, payload: unknown): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  const emitAgent = (event: AgentEvent): void => send(IPC.agentEvent, event)
  const emitTerminal = (event: TerminalEvent): void => send(IPC.terminalEvent, event)

  const gatewayConfig = async (): Promise<{ cfg: GatewayConfig; settings: AppSettings }> => {
    const settings = await loadSettings()
    return {
      cfg: { baseUrl: settings.baseUrl, apiKey: (await getApiKey()) ?? '' },
      settings,
    }
  }

  const agent = new AgentSession(emitAgent, gatewayConfig, () => openFiles)

  /* ---------------- settings ---------------- */

  ipcMain.handle(IPC.settingsGet, () => loadSettings())

  ipcMain.handle(IPC.settingsUpdate, (_e, patch: Partial<AppSettings>) => updateSettings(patch))

  ipcMain.handle(IPC.settingsSetApiKey, (_e, key: string) =>
    attempt(async () => {
      await setApiKey(key)
      return null
    }),
  )

  ipcMain.handle(IPC.settingsClearApiKey, () =>
    attempt(async () => {
      await clearApiKey()
      return null
    }),
  )

  /* ---------------- gateway ---------------- */

  ipcMain.handle(IPC.gatewayTest, () =>
    attempt(async () => {
      const { cfg } = await gatewayConfig()
      return ping(cfg)
    }),
  )

  ipcMain.handle(IPC.gatewayModels, () =>
    attempt(async () => {
      const { cfg } = await gatewayConfig()
      if (!cfg.apiKey) throw new Error('No API key set. Add one in Settings.')
      return listModels(cfg)
    }),
  )

  /* ---------------- workspace ---------------- */

  ipcMain.handle(IPC.workspaceOpen, () =>
    attempt(async () => {
      const win = getWindow()
      const result = win
        ? await dialog.showOpenDialog(win, {
            properties: ['openDirectory'],
            defaultPath: homeDir(),
            title: 'Open Folder',
          })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] })

      const dir = result.filePaths[0]
      if (result.canceled || !dir) return null
      await ws.setWorkspaceRoot(dir)
      agent.reset()
      openFiles = []
      return ws.getWorkspaceRoot()
    }),
  )

  ipcMain.handle(IPC.workspaceCurrent, () => {
    const file = pendingInitialFile
    pendingInitialFile = null
    return { root: ws.getWorkspaceRoot(), initialFile: file }
  })

  ipcMain.handle(IPC.workspaceList, (_e, path?: string) => attempt(() => ws.listDir(path ?? '')))

  ipcMain.handle(IPC.workspaceRead, (_e, path: string) =>
    attempt(async () => {
      const file = await ws.readFile(path)
      if (!openFiles.includes(file.path)) openFiles = [...openFiles, file.path].slice(-20)
      return file
    }),
  )

  ipcMain.handle(IPC.workspaceWrite, (_e, path: string, content: string) =>
    attempt(async () => {
      await ws.writeFile(path, content)
      return null
    }),
  )

  ipcMain.handle(IPC.workspaceCreate, (_e, path: string, isDirectory: boolean) =>
    attempt(async () => {
      await ws.createEntry(path, isDirectory)
      return null
    }),
  )

  ipcMain.handle(IPC.workspaceDelete, (_e, path: string) =>
    attempt(async () => {
      await ws.deleteEntry(path)
      openFiles = openFiles.filter((p) => p !== path)
      return null
    }),
  )

  ipcMain.handle(IPC.workspaceRename, (_e, from: string, to: string) =>
    attempt(async () => {
      await ws.renameEntry(from, to)
      return null
    }),
  )

  ipcMain.handle(
    IPC.workspaceSearch,
    (_e, query: string, opts?: { include?: string; isRegex?: boolean; caseSensitive?: boolean }) =>
      attempt(() => ws.searchText(query, opts ?? {})),
  )

  /* ---------------- agent ---------------- */

  ipcMain.handle(IPC.agentSend, (_e, text: string, attachedPaths: string[]) =>
    attempt(async () => {
      await agent.send(text, attachedPaths ?? [])
      return null
    }),
  )

  ipcMain.handle(IPC.agentCancel, () => agent.cancel())

  ipcMain.handle(
    IPC.agentApprove,
    async (_e, id: string, approved: boolean, alwaysAllow?: boolean) => {
      // The session decides what rule an "always allow" actually grants, so a
      // single prompt cannot buy blanket shell access.
      const rule = agent.resolveApproval(id, approved, alwaysAllow === true)
      if (!rule) return

      const settings = await loadSettings()
      if (!settings.allowRules.includes(rule)) {
        await updateSettings({ allowRules: [...settings.allowRules, rule] })
      }
    },
  )

  ipcMain.handle(IPC.agentReset, () => agent.reset())

  ipcMain.handle(IPC.processesList, () => listBackground())

  ipcMain.handle(IPC.processesStop, (_e, id: string) =>
    attempt(async () => {
      stopBackground(id)
      return null
    }),
  )

  /* ---------------- terminal ---------------- */

  ipcMain.handle(IPC.terminalCreate, (_e, cols: number, rows: number) =>
    attempt(() =>
      createTerminal({ cwd: ws.getWorkspaceRoot() ?? homeDir(), cols, rows }, emitTerminal),
    ),
  )

  ipcMain.handle(IPC.terminalWrite, (_e, id: string, data: string) => writeTerminal(id, data))

  ipcMain.handle(IPC.terminalResize, (_e, id: string, cols: number, rows: number) =>
    resizeTerminal(id, cols, rows),
  )

  ipcMain.handle(IPC.terminalDispose, (_e, id: string) => disposeTerminal(id))
}

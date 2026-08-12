import { app, BrowserWindow, shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerIpc } from './ipc.js'
import { stopAllBackground } from './agent/processes.js'
import { disposeAllTerminals } from './terminal/index.js'
import { setWorkspaceRoot } from './workspace/index.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * This package is ESM, so electron-vite emits the preload as .mjs — which is
 * also what Electron requires for an ESM preload. Resolve by probing so a
 * change in that convention fails loudly here rather than as an undefined
 * window.ide in the renderer.
 */
function preloadPath(): string {
  const candidates = ['../preload/index.mjs', '../preload/index.js'].map((p) =>
    path.join(dirname, p),
  )
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error(`Preload script not found. Looked in:\n  ${candidates.join('\n  ')}`)
  return found
}

/** Files that mark the top of a project, nearest-first from the starting dir. */
const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'Gemfile',
]

/**
 * Walk up from a file's directory to the project root, so opening
 * `src/main/agent/thing.ts` gives the whole repo rather than just `agent/`.
 * Falls back to the file's own directory when nothing marks a root.
 */
function projectRootFor(startDir: string): string {
  let dir = startDir
  for (;;) {
    if (PROJECT_MARKERS.some((marker) => existsSync(path.join(dir, marker)))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return startDir
    dir = parent
  }
}

/**
 * Path passed on the command line: `freellm-ide .` opens a project, and
 * `freellm-ide src/app.ts` opens that file's project with the file already up.
 */
function targetFromArgv(): { folder: string; file: string | null } | null {
  // Packaged: argv[0] is the exe. Unpackaged: argv[0] is electron, argv[1] the app dir.
  const args = process.argv.slice(app.isPackaged ? 1 : 2)
  for (const arg of args) {
    if (arg.startsWith('-')) continue
    try {
      const resolved = path.resolve(arg)
      const stat = statSync(resolved)
      if (stat.isDirectory()) return { folder: resolved, file: null }
      if (stat.isFile()) {
        const folder = projectRootFor(path.dirname(resolved))
        // The renderer opens by workspace-relative path.
        return { folder, file: path.relative(folder, resolved).split(path.sep).join('/') }
      }
    } catch {
      // not a path we can open; keep looking
    }
  }
  return null
}

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#0d0f12',
    // Wait for the first paint so the window never flashes white.
    show: false,
    // Packaged builds get the icon embedded in the executable; this is what
    // makes the taskbar and title bar right when running from source.
    ...(process.platform === 'linux' || !app.isPackaged
      ? { icon: path.join(dirname, '../../build/icon.png') }
      : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  // A renderer that throws early paints nothing and says nothing. Forward its
  // console and load failures to the terminal so a blank window has a cause.
  win.webContents.on('console-message', (event) => {
    const { level, message, lineNumber, sourceId } = event
    if (level === 'error' || level === 'warning') {
      console.error(`[renderer:${level}] ${message} (${sourceId}:${lineNumber})`)
    }
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, url) => {
    console.error(`[renderer] failed to load ${url}: ${errorDescription} (${errorCode})`)
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer] process gone: ${details.reason} (exit ${details.exitCode})`)
  })

  if (process.env['ELECTRON_RENDERER_URL']) win.webContents.openDevTools({ mode: 'detach' })

  // Anything that would open a new window goes to the real browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Block in-app navigation; this window only ever renders our own UI.
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
    void shell.openExternal(url)
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(path.join(dirname, '../renderer/index.html'))

  return win
}

// A second instance should focus the existing window rather than opening another.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(async () => {
    app.setAppUserModelId('dev.aiden.freellm-ide')

    const target = targetFromArgv()
    let initialFile: string | null = null
    if (target) {
      try {
        await setWorkspaceRoot(target.folder)
        initialFile = target.file
      } catch (err) {
        console.error(`[main] could not open ${target.folder}: ${(err as Error).message}`)
      }
    }

    mainWindow = createWindow()
    registerIpc(() => mainWindow, initialFile)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  app.on('window-all-closed', () => {
    disposeAllTerminals()
    stopAllBackground()
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    disposeAllTerminals()
    stopAllBackground()
  })
}

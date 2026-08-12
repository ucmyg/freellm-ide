import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AppSettings } from '@shared/types'
import { configureAccess } from './workspace/index.js'

/**
 * Settings live in the Electron userData dir. The gateway API key is kept in a
 * separate file, encrypted with the OS keychain (DPAPI on Windows) via
 * safeStorage, and is never sent to the renderer — only a hasApiKey flag is.
 */

const SETTINGS_FILE = 'settings.json'
const KEY_FILE = 'gateway-key.bin'
/** Written when the OS refuses encryption, so we never silently store plaintext without saying so. */
const KEY_FILE_PLAIN = 'gateway-key.plain'

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: 'http://localhost:3001',
  hasApiKey: false,
  model: '',
  maxTokens: 8192,
  temperature: 0,
  // Ask before every write and command, confined to the open folder. Widening
  // this should be a decision the user makes, not a default they inherit.
  permissionMode: 'default',
  allowRules: [],
  denyRules: [],
  fullDiskAccess: false,
  additionalRoots: [],
  commandTimeoutMs: 120_000,
  maxIterations: 50,
}

let cached: AppSettings | null = null
let cachedKey: string | null = null

function settingsPath(): string {
  return path.join(app.getPath('userData'), SETTINGS_FILE)
}

function keyPath(encrypted: boolean): string {
  return path.join(app.getPath('userData'), encrypted ? KEY_FILE : KEY_FILE_PLAIN)
}

export async function loadSettings(): Promise<AppSettings> {
  if (cached) return cached
  let stored: Partial<AppSettings> = {}
  try {
    stored = JSON.parse(await fs.readFile(settingsPath(), 'utf8')) as Partial<AppSettings>
  } catch {
    // first run — defaults are correct
  }
  cached = {
    ...DEFAULT_SETTINGS,
    ...stored,
    // hasApiKey is derived state, never trusted from disk
    hasApiKey: (await getApiKey()) !== null,
  }
  syncAccessPolicy(cached)
  return cached
}

/** Keep the workspace's path confinement in step with the stored settings. */
function syncAccessPolicy(settings: AppSettings): void {
  configureAccess({
    fullDiskAccess: settings.fullDiskAccess,
    additionalRoots: settings.additionalRoots,
  })
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await loadSettings()
  // hasApiKey is derived; the renderer must not be able to set it.
  const { hasApiKey: _ignored, ...safe } = patch
  const next: AppSettings = { ...current, ...safe }

  const { hasApiKey: _derived, ...persisted } = next
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true })
  await fs.writeFile(settingsPath(), JSON.stringify(persisted, null, 2), 'utf8')

  cached = next
  syncAccessPolicy(next)
  return next
}

/* ------------------------------------------------------------------ */
/* API key                                                             */
/* ------------------------------------------------------------------ */

export async function setApiKey(key: string): Promise<void> {
  const trimmed = key.trim()
  if (!trimmed) {
    await clearApiKey()
    return
  }

  await fs.mkdir(app.getPath('userData'), { recursive: true })

  if (safeStorage.isEncryptionAvailable()) {
    await fs.writeFile(keyPath(true), safeStorage.encryptString(trimmed))
    await fs.rm(keyPath(false), { force: true })
  } else {
    // Better to work with a clear warning than to fail outright on a machine
    // without a usable keyring.
    console.warn('[settings] OS encryption unavailable — storing gateway key unencrypted')
    await fs.writeFile(keyPath(false), trimmed, 'utf8')
    await fs.rm(keyPath(true), { force: true })
  }

  cachedKey = trimmed
  if (cached) cached.hasApiKey = true
}

export async function getApiKey(): Promise<string | null> {
  if (cachedKey !== null) return cachedKey

  try {
    const buf = await fs.readFile(keyPath(true))
    if (safeStorage.isEncryptionAvailable()) {
      cachedKey = safeStorage.decryptString(buf)
      return cachedKey
    }
  } catch {
    // fall through to the plaintext path
  }

  try {
    cachedKey = (await fs.readFile(keyPath(false), 'utf8')).trim()
    return cachedKey || null
  } catch {
    return null
  }
}

export async function clearApiKey(): Promise<void> {
  cachedKey = null
  if (cached) cached.hasApiKey = false
  await fs.rm(keyPath(true), { force: true })
  await fs.rm(keyPath(false), { force: true })
}

/** True when the key is stored without OS encryption, so the UI can warn. */
export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

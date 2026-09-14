import { homedir, tmpdir } from 'os'
import { mkdirSync } from 'fs'
import { join } from 'path'

/**
 * Expand "~" prefix to current user's home directory.
 * Examples:
 * - "~" => "/Users/alex"
 * - "~/Library/..." => "/Users/alex/Library/..."
 */
export function expandHomePath(inputPath: string): string {
  const raw = String(inputPath || '').trim()
  if (!raw) return raw

  if (raw === '~') return homedir()
  if (/^~[\\/]/.test(raw)) {
    return `${homedir()}${raw.slice(1)}`
  }

  return raw
}

/**
 * Resolve the OS-managed userData directory when Electron's `app.getPath`
 * is unavailable (e.g. worker threads, or when this util is imported before
 * `app` is ready).
 *
 * - macOS:  ~/Library/Application Support
 * - Linux:  $XDG_CONFIG_HOME or ~/.config
 * - Windows: %APPDATA%
 */
export function getOsUserDataPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support')
  }
  if (process.platform === 'win32') {
    return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  }
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
}

/**
 * Default fallback cache directory when the configured one is not usable
 * (e.g. external volume not mounted, EACCES on /Volumes/<x>).
 *
 * Returns `<userData>/cache` for the given app name, or `~/.cache/<appName>`
 * as a last resort.
 */
export function getDefaultCacheDir(appName = 'WeFlow'): string {
  try {
    return join(getOsUserDataPath(), appName, 'cache')
  } catch {
    return join(homedir(), '.cache', appName)
  }
}

/**
 * Synchronously ensure a directory exists, with a writable fallback.
 *
 * Returns the directory that was actually created/verified.
 * Returns `null` only if neither the primary nor the fallback could be created,
 * which should be treated as a fatal "no writable disk at all" condition.
 *
 * The fallback is determined lazily so this function is safe to import from
 * any process (main, worker, preload shim).
 */
export function ensureDirWithFallback(
  primaryDir: string,
  options: { fallbackDir?: string; appName?: string; label?: string } = {}
): string | null {
  const { fallbackDir, appName = 'WeFlow', label = 'cache' } = options
  const candidates: string[] = []
  if (primaryDir) candidates.push(primaryDir)
  if (fallbackDir) candidates.push(fallbackDir)
  candidates.push(getDefaultCacheDir(appName))
  candidates.push(join(tmpdir(), `${appName}-${label}`))

  for (const dir of candidates) {
    if (!dir) continue
    try {
      mkdirSync(dir, { recursive: true })
      return dir
    } catch (error) {
      // Try the next candidate. Log only the primary failure to avoid spam.
      if (dir === primaryDir) {
        console.warn(
          `[WeFlow] failed to create ${label} dir "${dir}", falling back:`,
          (error as Error)?.message || error
        )
      }
    }
  }
  console.error(`[WeFlow] all ${label} dir candidates failed; persistence will be unavailable`)
  return null
}

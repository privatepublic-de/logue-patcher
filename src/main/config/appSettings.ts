import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings } from '../../shared/domain/appSettings'

/**
 * `homeDir` is always `~/.logue-patcher` in the real app (see main/index.ts / main/ipc/settings.ts)
 * -- taken as an explicit parameter, matching main/config/libraryConfig.ts's established
 * pattern, so this module has no `electron` import and stays directly unit-testable.
 */
function configFilePath(homeDir: string): string {
  return join(homeDir, 'app-settings.json')
}

/** No persisted settings yet (first run) resolves to an empty object, not an error. */
export function loadAppSettings(homeDir: string): AppSettings {
  const path = configFilePath(homeDir)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Merges `patch` into whatever's already on disk rather than overwriting the whole file --
 * window-bounds persistence and checkout-path persistence are independent concerns that both
 * write this same file, and neither should be able to clobber the other's field.
 */
export function updateAppSettings(homeDir: string, patch: Partial<AppSettings>): AppSettings {
  const merged = { ...loadAppSettings(homeDir), ...patch }
  if (!existsSync(homeDir)) mkdirSync(homeDir, { recursive: true })
  writeFileSync(configFilePath(homeDir), JSON.stringify(merged, null, 2), 'utf-8')
  return merged
}

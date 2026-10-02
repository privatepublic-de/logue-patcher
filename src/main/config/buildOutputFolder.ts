import { existsSync, renameSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { loadAppSettings } from './appSettings'
import { historyRenamedName } from './buildResultNaming'

export class BuildOutputFolderNotConfiguredError extends Error {}

/**
 * Reads the user's configured build output folder (see AppSettings.buildOutputFolder) --
 * Export/Build now write directly into it with no per-click save dialog. Throws rather than
 * returning undefined, matching `logueBuild.ts`'s own `LogueSdkNotConfiguredError` precedent: a
 * clear, specific message reaching the renderer as-is instead of a generic wrapper.
 */
export function resolveBuildOutputFolder(homeDir: string): string {
  const folder = loadAppSettings(homeDir).buildOutputFolder
  if (!folder) {
    throw new BuildOutputFolderNotConfiguredError(
      'Set a Build Output Folder in Settings (gear icon, top right) before exporting/building.'
    )
  }
  return folder
}

/**
 * If something already exists at `destPath` (a leftover file or folder from a previous
 * Export/Build of the same unit name/platform), renames it aside using `historyRenamedName`
 * rather than silently overwriting it. The extremely unlikely case of the computed history name
 * ALSO already being taken (two renames within the same second) falls back to an incrementing
 * numeric suffix so this never throws on a legitimate double-click.
 */
export function makeRoomForDestination(destPath: string): void {
  if (!existsSync(destPath)) return
  const dir = dirname(destPath)
  const base = basename(destPath)
  const historyName = historyRenamedName(base, new Date())
  let candidate = historyName
  let n = 2
  while (existsSync(join(dir, candidate))) {
    candidate = `${historyName}-${n++}`
  }
  renameSync(destPath, join(dir, candidate))
}

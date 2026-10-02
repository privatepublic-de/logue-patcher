/**
 * Pure naming logic for build-result file management (BuildPanel.tsx's Export/Build buttons) --
 * no `electron`/`fs` import, matching `logueBuildStaging.ts`'s own "stay directly unit-testable"
 * convention. The actual filesystem side effects (checking/renaming a pre-existing destination)
 * live in `buildOutputFolder.ts` instead, which only touches real disk and is verified manually.
 */

/**
 * Filesystem-safe fragment derived from a unit name -- same character class as
 * `logueBuildStaging.ts`'s own `deriveStagingName`, but deliberately no random suffix: this name
 * IS the real destination (the whole point is that a repeat Export/Build reuses it, triggering
 * the history-rename), not a disposable scratch staging dir.
 */
function sanitizeForFs(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'unit'
}

/** The single-file Build destination's own name, e.g. `deriveBuildFileName('My Patch', 'mnlgxdunit') -> 'My_Patch.mnlgxdunit'`. */
export function deriveBuildFileName(unitName: string, extension: string): string {
  return `${sanitizeForFs(unitName)}.${extension}`
}

/**
 * The multi-file Export destination's own folder name. Includes the platform (unlike
 * `deriveBuildFileName`, which doesn't need to -- its own extension already disambiguates
 * platform) since an export folder has no extension of its own to tell two platforms' output
 * apart, e.g. `deriveExportFolderName('My Patch', 'nts1mkii') -> 'My_Patch-nts1mkii'`.
 */
export function deriveExportFolderName(
  unitName: string,
  platform: 'nts1mkii' | 'minilogue-xd'
): string {
  return `${sanitizeForFs(unitName)}-${platform}`
}

/** `YYYYMMDD-HHMMSS` in local time -- sortable, human-readable, no colons that would need escaping on any filesystem. */
export function formatHistoryTimestamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/**
 * Renames a pre-existing destination (file or folder) aside for history purposes: inserts
 * `.history-<timestamp>` before a FILE's own real extension (`MyUnit.mnlgxdunit` ->
 * `MyUnit.history-20260923-143512.mnlgxdunit`, preserving the real extension per the project's
 * own "not file extension" requirement), or appends it outright to an extension-less FOLDER name
 * (`MyUnit-nts1mkii` -> `MyUnit-nts1mkii.history-20260923-143512`). One function covers both
 * shapes since a folder name simply has no `.` to split on -- `lastIndexOf('.')` returns -1 and
 * the segment is appended instead of inserted.
 */
export function historyRenamedName(name: string, now: Date): string {
  const suffix = `history-${formatHistoryTimestamp(now)}`
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex <= 0) return `${name}.${suffix}`
  return `${name.slice(0, dotIndex)}.${suffix}${name.slice(dotIndex)}`
}

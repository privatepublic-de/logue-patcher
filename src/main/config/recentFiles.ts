/** How many recently opened/saved patches the start screen lists. */
export const MAX_RECENT_FILES = 8

/**
 * `path` moved to the front of `list`, without duplicates, capped at `max`. The app keeps this
 * list itself (`AppSettings.recentFiles`): Electron can add to macOS's Open Recent menu but can't
 * read it back for the start screen.
 */
export function withRecentFile(
  list: readonly string[] | undefined,
  path: string,
  max = MAX_RECENT_FILES
): string[] {
  return [path, ...(list ?? []).filter((p) => p !== path)].slice(0, max)
}

import { useSubpatchLibraryStore } from './subpatchLibraryStore'
import { useTabsStore } from './tabsStore'

let latest = 0

/** The active tab's file, whose folder's own subpatches override the library's. */
export function activePatchFilePath(): string | null {
  const { tabs, activeTabId } = useTabsStore.getState()
  return tabs.find((t) => t.id === activeTabId)?.filePath ?? null
}

/** Re-reads what the active patch sees -- its folder's subpatches, then the library -- from disk
 *  (main process) into the renderer's cache. Kept apart from the store itself so modules that
 *  only resolve types don't pull in `window.axoloti`. A reply to an older request (the active tab
 *  changed meanwhile) is dropped. */
export async function refreshSubpatchLibrary(): Promise<void> {
  const request = ++latest
  const entries = await window.axoloti.subpatchLibrary.list(activePatchFilePath())
  if (request === latest) useSubpatchLibraryStore.getState().setEntries(entries)
}

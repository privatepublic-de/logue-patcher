import { create } from 'zustand'
import type { LoguePlatform } from '@shared/domain/patch'

/**
 * One completed Export or Build. Only successful attempts are recorded -- a failed attempt
 * produces no real output file/folder to reveal in Finder, and already shows in the panel's own
 * red error message.
 */
export interface BuildResultEntry {
  id: string
  kind: 'export' | 'build'
  platform: LoguePlatform
  unitName: string
  /** The exported folder's path, or the built unit file's path. */
  path: string
  createdAt: number
  /** Only set for a 'build' entry (LogueBuildResult.builtWith) -- e.g. "Local ARM GCC (arm-none-eabi-gcc 15.3.1)". */
  builtWith?: string
}

interface BuildResultsState {
  results: BuildResultEntry[]
  addResult: (entry: Omit<BuildResultEntry, 'id' | 'createdAt'>) => void
}

/**
 * Global (not per-document) and session-only (not persisted to disk) -- see BuildPanel.tsx's own
 * `key={activeTab.id}` remount on every tab switch, which would otherwise wipe a plain component
 * `useState` list. A plain Zustand store instance, module-scoped like `tabsStore.ts`, survives
 * that remount since it's created once at module load, independent of BuildPanel's own lifecycle.
 */
export const useBuildResultsStore = create<BuildResultsState>((set) => ({
  results: [],
  addResult: (entry) =>
    set((s) => ({
      results: [{ ...entry, id: crypto.randomUUID(), createdAt: Date.now() }, ...s.results]
    }))
}))

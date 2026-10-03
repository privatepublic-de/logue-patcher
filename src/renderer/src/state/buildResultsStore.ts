import { create } from 'zustand'
import type { LoguePlatform } from '@shared/domain/patch'
import type { LogueUnitModule } from '@logue-codegen/sysex/korgUserUnitMessages'

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

/** Where a built unit was last uploaded. */
export interface UploadTarget {
  /** The MIDI output it went through, to find the same device again. */
  device: string
  module: LogueUnitModule
  slot: number
  at: number
}

interface BuildResultsState {
  results: BuildResultEntry[]
  addResult: (entry: Omit<BuildResultEntry, 'id' | 'createdAt'>) => void
  /** Keyed by the unit file's path, which a rebuild of the same unit keeps. */
  uploads: Record<string, UploadTarget>
  recordUpload: (path: string, target: Omit<UploadTarget, 'at'>) => void
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
    })),
  uploads: {},
  recordUpload: (path, target) =>
    set((s) => ({ uploads: { ...s.uploads, [path]: { ...target, at: Date.now() } } }))
}))

/** One row per unit file: its newest result and how many times it was produced. A rebuild
 *  renames the previous file aside (`makeRoomForDestination`), so only the newest is at `path`. */
export interface BuildResultGroup {
  latest: BuildResultEntry
  count: number
}

export function groupResultsByPath(results: BuildResultEntry[]): BuildResultGroup[] {
  const groups = new Map<string, BuildResultGroup>()
  for (const r of results) {
    const group = groups.get(r.path)
    if (group) group.count++
    else groups.set(r.path, { latest: r, count: 1 })
  }
  return [...groups.values()]
}

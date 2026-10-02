import { create } from 'zustand'
import type { PatchDocument } from '@shared/domain/patch'
import type { SubpatchLibraryEntry } from '@shared/ipc/contract'
import type { LoguePrimitive } from '@logue-codegen/primitives'
import { createSubpatchAwareResolver } from '@logue-codegen/subpatches'

interface SubpatchLibraryState {
  entries: SubpatchLibraryEntry[]
  /** Saved definitions by instance `type` -- the same data Export/Build read from disk. */
  defs: Map<string, PatchDocument>
  /** Bumped on every refresh; part of `PatchCanvas`'s remount key, so an open canvas re-derives
   *  instance ports/params when a definition it uses is saved. */
  version: number
  resolve: (type: string) => LoguePrimitive | undefined
  setEntries: (entries: SubpatchLibraryEntry[]) => void
}

function stateFor(
  entries: SubpatchLibraryEntry[]
): Pick<SubpatchLibraryState, 'entries' | 'defs' | 'resolve'> {
  const defs = new Map<string, PatchDocument>()
  for (const entry of entries) if (entry.doc) defs.set(entry.type, entry.doc)
  return { entries, defs, resolve: createSubpatchAwareResolver(defs) }
}

/**
 * Global, like `buildResultsStore.ts`: one library shared by every tab. Always the last SAVED
 * state of each definition (refreshed from disk via the main-process watcher), never an open
 * definition tab's unsaved edits -- so the canvas shows what Export/Build will actually use.
 */
export const useSubpatchLibraryStore = create<SubpatchLibraryState>((set) => ({
  ...stateFor([]),
  version: 0,
  setEntries: (entries) => set((s) => ({ ...stateFor(entries), version: s.version + 1 }))
}))

/**
 * The one lookup every canvas consumer uses for "what does a node of this type look like":
 * the fixed primitive registry, the two subpatch port nodes, or a library subpatch's stand-in
 * primitive. Non-reactive -- a component that needs to re-render on library changes also
 * subscribes to `version`.
 */
export function resolveNodePrimitive(type: string): LoguePrimitive | undefined {
  return useSubpatchLibraryStore.getState().resolve(type)
}

export function subpatchDefinitions(): Map<string, PatchDocument> {
  return useSubpatchLibraryStore.getState().defs
}

export function subpatchFilePath(type: string): string | undefined {
  return subpatchEntry(type)?.filePath
}

/** The file an instance of `type` resolves to -- the patch folder's own (`source` `local`) when
 *  there is one, else the library's. */
export function subpatchEntry(type: string): SubpatchLibraryEntry | undefined {
  return useSubpatchLibraryStore.getState().entries.find((e) => e.type === type)
}

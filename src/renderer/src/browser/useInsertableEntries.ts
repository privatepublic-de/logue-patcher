import { useMemo } from 'react'
import { useOptionalPatchStore } from '../state/patchStore'
import { useSubpatchLibraryStore } from '../state/subpatchLibraryStore'
import { normalizePath } from '../util/paths'
import {
  COMMENT_ENTRY,
  SUBPATCH_PORT_ENTRIES,
  busPresetEntries,
  busPresetKey,
  controlPresetEntries,
  listInsertablePrimitives,
  listSubpatchEntries,
  type PrimitiveCatalogEntry
} from './loguePrimitiveCatalog'

/**
 * Everything the palette and the insert popup offer for the ACTIVE document: every primitive,
 * the library's subpatches, and -- only while editing a subpatch definition -- its inlet/outlet
 * port nodes. One hook for both UIs so they can't disagree about what's placeable. `forInsert`
 * adds what only makes sense for a NEW node -- the canvas comment, the control presets and one
 * send/receive per bus already in the document -- and
 * is false for "Replace with…".
 */
export function useInsertableEntries(forInsert: boolean): PrimitiveCatalogEntry[] {
  const inSubpatch = useOptionalPatchStore((s) => s.rootDoc?.settings.subpatch === true) ?? false
  // A definition can be used in either kind of patch, so it's offered everything.
  const docModule = useOptionalPatchStore((s) => s.rootDoc?.settings.logueTarget?.module)
  const module = inSubpatch ? undefined : docModule
  const filePath = useOptionalPatchStore((s) => s.filePath) ?? null
  const library = useSubpatchLibraryStore((s) => s.entries)
  const defs = useSubpatchLibraryStore((s) => s.defs)
  const busKey = useOptionalPatchStore((s) => busPresetKey(s.rootDoc)) ?? '[]'

  return useMemo(() => {
    const editingType =
      inSubpatch && filePath
        ? library.find((e) => normalizePath(e.filePath) === normalizePath(filePath))?.type
        : undefined
    return [
      ...(forInsert ? [COMMENT_ENTRY] : []),
      ...listInsertablePrimitives(module),
      ...(forInsert ? controlPresetEntries(module) : []),
      ...(forInsert ? busPresetEntries(JSON.parse(busKey)) : []),
      ...(inSubpatch ? SUBPATCH_PORT_ENTRIES : []),
      ...listSubpatchEntries(library, defs, editingType, module)
    ]
  }, [forInsert, inSubpatch, module, filePath, library, defs, busKey])
}

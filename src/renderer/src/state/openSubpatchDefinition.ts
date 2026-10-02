import { openPatchTab } from './tabRegistry'
import { subpatchFilePath } from './subpatchLibraryStore'

/**
 * Opens a subpatch instance's definition file in its own tab (or focuses the tab already showing
 * it) -- the live reference is the file, so editing and saving it there updates every instance
 * everywhere. Resolves `false` when the type isn't in the library (its instance already carries a
 * "missing subpatch" badge saying why), or the file can't be read.
 */
export async function openSubpatchDefinition(type: string): Promise<boolean> {
  const filePath = subpatchFilePath(type)
  if (!filePath) return false
  try {
    const result = await window.axoloti.patchFile.openPath(filePath)
    openPatchTab({ doc: result.doc, filePath: result.filePath })
    return true
  } catch {
    return false
  }
}

import { readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { PatchDocument } from '../../shared/domain/patch'
import type { SubpatchLibraryEntry } from '../../shared/ipc/contract'
import { parsePatchFile } from '../../shared/json/patchCodec'
import { SUBPATCH_TYPE_PREFIX } from '@logue-codegen/subpatches'

export const LOGUESUB_EXTENSION = 'loguesub'

/** `sub/<path relative to the library folder, '/'-separated, no extension>` -- see `AppSettings.subpatchLibraryPath`. */
export function subpatchTypeForPath(libraryDir: string, filePath: string): string {
  const rel = relative(libraryDir, filePath).split(sep).join('/')
  return SUBPATCH_TYPE_PREFIX + rel.slice(0, -(LOGUESUB_EXTENSION.length + 1))
}

function findLoguesubFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...findLoguesubFiles(path))
    else if (entry.isFile() && entry.name.endsWith(`.${LOGUESUB_EXTENSION}`)) found.push(path)
  }
  return found
}

/**
 * Every definition in the library folder, read fresh from disk. A file that fails to parse is
 * still listed (with `error`) rather than dropped, so a broken definition shows up as broken in
 * the palette instead of silently vanishing -- and never takes the rest of the library down with
 * it. A missing/unset folder is an empty library, not an error: instances then surface as
 * unresolved references.
 */
export function listSubpatchLibrary(libraryDir: string | undefined): SubpatchLibraryEntry[] {
  if (!libraryDir) return []
  let files: string[]
  try {
    files = findLoguesubFiles(libraryDir)
  } catch {
    return []
  }
  return files.sort().map((filePath) => readEntry(libraryDir, filePath, 'library'))
}

function readEntry(
  root: string,
  filePath: string,
  source: SubpatchLibraryEntry['source']
): SubpatchLibraryEntry {
  const type = subpatchTypeForPath(root, filePath)
  try {
    return { type, filePath, source, doc: parsePatchFile(readFileSync(filePath, 'utf-8')) }
  } catch (err) {
    return { type, filePath, source, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The `.loguesub` files at the top level of a patch's own folder (docs/PLAN-grain-mill.md):
 * shipped next to a patch, they make it work without touching the library. Only the top level --
 * a patch may sit in a large folder (Desktop, Documents), and scanning below it has no bound.
 */
export function listLocalSubpatches(patchFilePath: string | null): SubpatchLibraryEntry[] {
  if (!patchFilePath) return []
  const dir = dirname(patchFilePath)
  let names: string[]
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter(
        (e) => e.isFile() && !e.name.startsWith('.') && e.name.endsWith(`.${LOGUESUB_EXTENSION}`)
      )
      .map((e) => e.name)
  } catch {
    return []
  }
  return names.sort().map((name) => readEntry(dir, join(dir, name), 'local'))
}

/** What a patch at `patchFilePath` sees: its folder's own subpatches, then the library's, a
 *  local file overriding a library one of the same type. */
export function listSubpatchesFor(
  patchFilePath: string | null,
  libraryDir: string | undefined
): SubpatchLibraryEntry[] {
  const local = listLocalSubpatches(patchFilePath)
  const shadowed = new Set(local.map((e) => e.type))
  return [...local, ...listSubpatchLibrary(libraryDir).filter((e) => !shadowed.has(e.type))]
}

/** The saved definitions Export/Build flatten against -- never an open tab's unsaved edits. */
export function loadSubpatchDefinitions(
  patchFilePath: string | null,
  libraryDir: string | undefined
): Map<string, PatchDocument> {
  const defs = new Map<string, PatchDocument>()
  for (const entry of listSubpatchesFor(patchFilePath, libraryDir))
    if (entry.doc) defs.set(entry.type, entry.doc)
  return defs
}

/**
 * Watches the library folder recursively (macOS supports `recursive` natively) and calls
 * `onChange` once per burst of events -- a single save typically fires several. Returns a
 * closer; a folder that can't be watched (missing, unreadable) just yields no events.
 */
export function watchSubpatchLibrary(
  libraryDir: string,
  onChange: () => void,
  /** A patch's own folder: only its top level, and only `.loguesub` files. */
  topLevelOnly = false
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let watcher: FSWatcher | undefined
  try {
    watcher = watch(libraryDir, { recursive: !topLevelOnly }, (_event, name) => {
      if (topLevelOnly && name && !String(name).endsWith(`.${LOGUESUB_EXTENSION}`)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(onChange, 200)
    })
    watcher.on('error', () => watcher?.close())
  } catch {
    watcher = undefined
  }
  return () => {
    if (timer) clearTimeout(timer)
    watcher?.close()
  }
}

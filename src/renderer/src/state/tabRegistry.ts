import { MODULE_LABEL } from '@logue-codegen/unitKinds'
import { createStore, type StoreApi } from 'zustand'
import type { PatchDocument, LogueTargetSettings } from '@shared/domain/patch'
import { basenamePath, normalizePath } from '../util/paths'
import { createPatchStoreState, type PatchStoreState } from './patchStore'
import { useTabsStore } from './tabsStore'

interface TabEntry {
  kind: 'patch'
  api: StoreApi<PatchStoreState>
}

/**
 * The real per-tab store instances -- `tabsStore.ts` only ever holds denormalized display
 * metadata about these, never the instances themselves, so a plain module-level `Map` (not
 * itself a Zustand store) is the right shape here: nothing outside this file needs to react to
 * the registry's own membership changing, only to `tabsStore`'s mirrored metadata.
 */
const registry = new Map<string, TabEntry>()
const unsubscribers = new Map<string, () => void>()

function patchTabTitle(state: PatchStoreState): string {
  if (state.filePath) return basenamePath(state.filePath)
  const logueTarget = state.rootDoc?.settings.logueTarget
  if (state.rootDoc?.settings.subpatch) return 'untitled subpatch'
  if (!logueTarget) return 'untitled'
  // No platform suffix -- a document no longer commits
  // to, or even currently "views," one platform, so there's nothing left to name here.
  if (logueTarget.module === 'osc') return 'untitled logue osc'
  return `untitled ${MODULE_LABEL[logueTarget.module].toLowerCase()}`
}

/** Mirrors a fresh tab instance's title/filePath/dirty into tabsStore, then keeps them synced for its lifetime. */
function registerTabMeta(id: string, entry: TabEntry): void {
  const sync = (): void => {
    const state = entry.api.getState()
    useTabsStore.getState().updateTab(id, {
      title: patchTabTitle(state),
      filePath: state.filePath,
      dirty: state.dirty,
      module: state.rootDoc?.settings.logueTarget?.module
    })
  }
  sync()
  const unsubscribeDoc = entry.api.subscribe(sync)
  unsubscribers.set(id, unsubscribeDoc)
}

/**
 * Finds an already-open patch tab pointed at `filePath`, so a caller can focus it instead of
 * opening a duplicate -- every file should occupy one tab. Never matches on `null` (a fresh/
 * untitled document never dedupes against another untitled one).
 */
function findTabByFilePath(filePath: string): string | null {
  const normalized = normalizePath(filePath)
  return (
    useTabsStore
      .getState()
      .tabs.find((t) => t.filePath != null && normalizePath(t.filePath) === normalized)?.id ?? null
  )
}

/**
 * Opens a new patch tab and activates it -- `initial` omitted starts a fresh empty patch
 * (mirrors patchStore's own `newDoc`), matching an existing file's own `filePath`/`doc` when
 * opened from disk. Reuses (and activates) an already-open tab for the same `filePath` rather
 * than opening a duplicate. `logueTarget` (only meaningful together with an omitted `initial`,
 * i.e. a brand-new document) marks the new document for logue-sdk export.
 */
export function openPatchTab(
  initial?: { doc: PatchDocument; filePath: string | null },
  logueTarget?: LogueTargetSettings
): string {
  if (initial?.filePath) {
    const existing = findTabByFilePath(initial.filePath)
    if (existing) {
      useTabsStore.getState().setActiveTab(existing)
      return existing
    }
  }
  const id = crypto.randomUUID()
  const api = createStore<PatchStoreState>(createPatchStoreState)
  if (initial) {
    api.getState().loadDoc(initial.doc, initial.filePath)
  } else api.getState().newDoc(logueTarget)

  const entry: TabEntry = { kind: 'patch', api }
  registry.set(id, entry)
  registerTabMeta(id, entry)
  useTabsStore.getState().addTab({
    id,
    kind: 'patch',
    title: patchTabTitle(api.getState()),
    filePath: api.getState().filePath,
    dirty: api.getState().dirty
  })
  return id
}

export function getTabEntry(id: string | null): TabEntry | null {
  if (!id) return null
  return registry.get(id) ?? null
}

export function getPatchStoreApi(id: string | null): StoreApi<PatchStoreState> | null {
  const entry = getTabEntry(id)
  return entry ? entry.api : null
}

/**
 * Disposes a tab's store instance and its title-sync subscription, then removes it from
 * tabsStore (which also picks the next active tab -- see tabsStore.ts's `removeTab`). Does NOT
 * itself check dirty state or confirm with the user -- that's App.tsx's job, before calling
 * this.
 */
export function closeTab(id: string): void {
  unsubscribers.get(id)?.()
  unsubscribers.delete(id)
  registry.delete(id)
  useTabsStore.getState().removeTab(id)
}

import { create } from 'zustand'
import type { LogueModule } from '@shared/domain/patch'

export type TabKind = 'patch'

/**
 * Denormalized display metadata for one open tab -- the real editable state lives in that
 * tab's own `patchStore` instance (see tabRegistry.ts), which subscribes to itself and mirrors
 * `title`/`filePath`/`dirty` back in here. This is what lets `TabBar` render the tab strip from
 * this one plain global store, with no per-tab Context lookup.
 */
export interface TabInfo {
  id: string
  kind: TabKind
  title: string
  filePath: string | null
  dirty: boolean
  /** Its document's `logueTarget.module`, so the tab can show an effect as one. */
  module?: LogueModule
}

interface TabsState {
  tabs: TabInfo[]
  activeTabId: string | null
  addTab: (tab: TabInfo) => void
  removeTab: (id: string) => void
  setActiveTab: (id: string) => void
  updateTab: (id: string, patch: Partial<Omit<TabInfo, 'id' | 'kind'>>) => void
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  addTab: (tab) => set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id })),

  removeTab: (id) => {
    const { tabs, activeTabId } = get()
    const index = tabs.findIndex((t) => t.id === id)
    if (index === -1) return
    const remaining = tabs.filter((t) => t.id !== id)
    let nextActive = activeTabId
    if (activeTabId === id) {
      // Prefer the tab to the left; falling back to the right covers removing the first tab.
      const neighbor = tabs[index - 1] ?? tabs[index + 1]
      nextActive = neighbor?.id ?? null
    }
    set({ tabs: remaining, activeTabId: nextActive })
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  // Called on every patch-store notification (tabRegistry's sync) -- a new `tabs` array each
  // time would re-render every subscriber on every dial frame.
  updateTab: (id, patch) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    const keys = Object.keys(patch) as (keyof typeof patch)[]
    if (keys.every((k) => tab[k] === patch[k])) return
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
  }
}))

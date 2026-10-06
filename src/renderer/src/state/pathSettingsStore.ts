import { create } from 'zustand'

interface PathSettingsState {
  /** Bumped after every path setting write. */
  version: number
  changed: () => void
}

/**
 * Tells readers of the path settings (BuildPanel.tsx's output folder and toolchain line) that
 * SettingsModal.tsx wrote one, so they re-read it: the values themselves live in main
 * (`settings.getPath`), and each reader fetched them only once per mount, so a change in Settings
 * didn't show until the panel remounted (a tab switch).
 */
export const usePathSettingsStore = create<PathSettingsState>((set) => ({
  version: 0,
  changed: () => set((s) => ({ version: s.version + 1 }))
}))

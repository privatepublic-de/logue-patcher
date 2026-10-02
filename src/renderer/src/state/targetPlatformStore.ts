import { create } from 'zustand'
import type { LoguePlatform } from '@shared/domain/patch'

interface TargetPlatformState {
  platform: LoguePlatform
  setPlatform: (platform: LoguePlatform) => void
}

/**
 * The platform the user is currently working on, shared by BuildPanel.tsx's build-target toggle
 * and ParamMatrixOverlay.tsx's platform toggle, so switching one switches the other. Global and
 * session-only like `buildResultsStore.ts`: a document itself stays platform-agnostic, and
 * BuildPanel remounts per tab, so a component `useState` would reset on every tab switch.
 */
export const useTargetPlatformStore = create<TargetPlatformState>((set) => ({
  platform: 'nts1mkii',
  setPlatform: (platform) => set({ platform })
}))

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Persisted to ~/.logue-patcher/app-settings.json -- see main/config/appSettings.ts. */
export interface AppSettings {
  windowBounds?: WindowBounds
  /** Persisted drag-resized widths (px) of the two always-visible side panels -- see App.tsx's useSidebarResize. Undefined (first run) falls back to main.css's own defaults. */
  sidebarWidths?: { left: number; right: number }
  /**
   * Absolute path to the user's own local `logue-sdk` checkout (https://github.com/korginc/
   * logue-sdk) -- used by `main/ipc/logueBuild.ts` to stage and build
   * an installable `.mnlgxdunit`/`.nts1mkiiunit`. Not bundled/vendored: the app points at a checkout
   * the user maintains themselves (`git pull` to stay current), configured via SettingsModal.tsx.
   * Undefined until the user picks one.
   */
  logueSdkPath?: string
  /**
   * Absolute path to a local ARM GCC (`arm-none-eabi-*`) toolchain's `bin` directory, used by
   * `main/ipc/logueBuild.ts` for every build. Optional: when unset, `logueBuild.ts` probes a
   * short list of known install locations (Homebrew's `gcc-arm-embedded` cask, the Arm GNU
   * Toolchain installer's `/Applications/ArmGNUToolchain/*` layout) before giving up.
   */
  armToolchainPath?: string
  /**
   * Absolute path to the folder Export/Build write their output into directly -- no per-click
   * "Save As"/folder-picker dialog any more (see main/config/buildOutputFolder.ts). A
   * pre-existing file/folder already occupying the exact destination is renamed aside with a
   * `.history-<timestamp>` segment first (main/config/buildResultNaming.ts), never silently
   * overwritten. Undefined until the user configures one via SettingsModal.tsx; Export/Build
   * throw a clear `BuildOutputFolderNotConfiguredError` on click until it's set.
   */
  buildOutputFolder?: string
  /**
   * Absolute path to the folder holding the user's reusable subpatch definitions (`*.loguesub`,
   * subfolders allowed). A placed instance's `type` is `sub/<path relative to this folder, no
   * extension>`, so moving the folder keeps every reference valid while renaming a file inside it
   * breaks them (surfaced as an unresolved reference, never silently dropped). Watched by the main
   * process so the palette and open canvases refresh on save.
   */
  subpatchLibraryPath?: string
  /** The Upload dialog's "Always replace" checkbox: when true, uploading into an occupied slot
   *  skips the second "Replace slot N" confirmation click. Both devices share it. */
  uploadAlwaysReplace?: boolean
  /** Recently opened or saved patches, newest first, for the start screen (main/config/recentFiles.ts). */
  recentFiles?: string[]
}

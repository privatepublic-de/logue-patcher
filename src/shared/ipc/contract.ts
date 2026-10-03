/**
 * Single source of truth for the main <-> renderer boundary.
 *
 * `AxolotiIpcApi` is the request/response surface (renderer calls, main handles).
 * `AxolotiIpcEvents` is the push surface (main emits, renderer subscribes).
 * Both preload/index.ts and main/ipc/* are written against these types so the
 * three processes cannot silently drift out of sync.
 */

import type { LogueEffectModule, PatchDocument } from '../domain/patch'

export interface PingResult {
  message: string
  appVersion: string
  respondedAt: number
}

export interface OpenPatchResult {
  filePath: string
  doc: PatchDocument
}

/** One `.loguesub` file in the subpatch library folder -- `doc` when it parsed, `error` when it didn't. */
export interface SubpatchLibraryEntry {
  /** The `ObjNode.type` an instance of it carries: `sub/<relative path, no extension>`. */
  type: string
  filePath: string
  /**
   * `local`: a top-level `.loguesub` next to the open patch, which overrides a library file of
   * the same type (docs/PLAN-grain-mill.md); `library`: from `AppSettings.subpatchLibraryPath`.
   */
  source: 'local' | 'library'
  doc?: PatchDocument
  error?: string
}

export interface LogueBuildResult {
  savedPath: string
  /** Human-readable label for whichever toolchain actually produced this build, e.g. "Local ARM GCC (arm-none-eabi-gcc 15.3.1)" -- surfaced in BuildPanel.tsx's success message so a saved unit's provenance is never ambiguous. */
  builtWith: string
}

export interface DeviceBackupFile {
  name: string
  bytes: Uint8Array
}

export interface OpenedDeviceBackup {
  /** The backup zip's path, or an older backup folder's. */
  folder: string
  indexJson: string
  /** Keyed by file name, e.g. `osc-01-string.body.bin` or `osc-02-combnew.nts1mkiiunit`. */
  bodies: Record<string, Uint8Array>
}

export interface MidiPortInfo {
  /** CoreMIDI kMIDIPropertyUniqueID -- stable across replugging, unlike an index. */
  id: number
  name: string
}

export interface ArmToolchainInfo {
  binDir: string
  version: string
}

export interface PickedWavFile {
  name: string
  path: string
  bytes: Uint8Array
}

/** The folder-valued `AppSettings` fields, edited in SettingsModal.tsx through one get/set/pick trio. */
export const PATH_SETTING_KEYS = [
  'logueSdkPath',
  'armToolchainPath',
  'buildOutputFolder',
  'subpatchLibraryPath'
] as const
export type PathSettingKey = (typeof PATH_SETTING_KEYS)[number]

export interface AxolotiIpcApi {
  system: {
    ping(message: string): Promise<PingResult>
    /** `app.getVersion()` -- for the About dialog's title (AboutModal.tsx). */
    getAppVersion(): Promise<string>
    /** Reveals a file or folder in the OS file manager (Finder) with it selected/highlighted -- Electron's `shell.showItemInFolder`. Used by BuildPanel.tsx's build-results list; works for both a built unit file and an exported project folder. */
    showItemInFolder(path: string): Promise<void>
    /** Titles of every tab with unsaved changes, pushed whenever that set changes -- main needs it synchronously to decide whether a window close/⌘Q must stop and ask (main/quitGuard.ts). */
    setUnsavedDocuments(titles: string[]): Promise<void>
    /** Closes the window after `app.saveAllAndClose` saved everything, skipping the unsaved-changes prompt. */
    closeWindowAfterSave(): Promise<void>
  }
  clipboard: {
    /** Writes plain text to the real OS clipboard -- backs canvas copy/cut (see patchDocHelpers.ts's serializeSelectionForClipboard). */
    writeText(text: string): Promise<void>
    /** Reads plain text off the real OS clipboard -- backs canvas paste. Whatever's actually on the clipboard (not necessarily this app's own patch XML) is returned as-is; the caller must handle non-patch content gracefully. */
    readText(): Promise<string>
  }
  patchFile: {
    /** Reads and parses a `.loguepatch`/`.loguesub` file at an explicit path -- used when the caller already knows the path (reopening a recent file, a subpatch instance opening its definition). */
    openPath(filePath: string): Promise<OpenPatchResult>
    save(filePath: string, doc: PatchDocument): Promise<void>
    /** Shows a native "Open" dialog offering `.loguepatch` and `.loguesub` files; resolves null if the user cancels. */
    openDialog(): Promise<OpenPatchResult | null>
    /**
     * Shows a native "Save As" dialog; resolves the chosen path, or null if the user cancels.
     * `currentFilePath`, when given, seeds the dialog's default filename -- omit it for a
     * brand-new, never-saved document (defaults to `untitled.loguepatch`, or for a subpatch
     * definition `untitled.loguesub` inside the subpatch library folder).
     */
    saveDialog(doc: PatchDocument, currentFilePath?: string): Promise<string | null>
    /** Recently opened or saved patches that still exist, newest first (the start screen's list). */
    listRecent(): Promise<string[]>
  }
  logueExport: {
    /**
     * Generates real NTS-1 mkII unit source for the document's module (`header.c`, `osc.h` or
     * `fx.h`, `unit.cc`, via `logue-codegen`'s `nts1mkii/projectFiles.ts`) and writes it
     * into a named subfolder (`<UnitName>-nts1mkii`, see main/config/buildResultNaming.ts) of
     * the user's configured build output folder.
     * Deliberately NOT a full build: this writes generated C++ source only, the same three
     * files the phase-1/2 verification staging scripts hand-wrote into `logue-sdk/platform/
     * nts-1_mkii/*` -- building/`websim`/upload orchestration is real future work, not
     * attempted here. A pre-existing folder at that exact destination is renamed aside first
     * (main/config/buildOutputFolder.ts's `makeRoomForDestination`), never overwritten. Rejects
     * with `BuildOutputFolderNotConfiguredError` if no output folder is configured yet, or with
     * the same typed errors the generators throw (`UnsupportedLogueNodeError`/
     * `InvalidLogueUnitNameError`/`InvalidLogueParamError`) when the graph/name/params are
     * invalid -- the renderer surfaces `err.message` the same way a failed Save does.
     */
    exportNts1MkiiUnit(
      doc: PatchDocument,
      unitName: string,
      /** Where the patch is saved: subpatches next to it take precedence. */
      patchFilePath: string | null
    ): Promise<{ folderPath: string }>
    /**
     * The minilogue xd sibling of `exportNts1MkiiUnit` -- generates `manifest.json`/
     * `project.mk`/`osc.cpp` or `fx.cpp` plus the fixed old-gen scaffold for the module
     * (`Makefile`/`tpl/_unit.c`/`ld/*`, embedded so the export is self-contained) via
     * `minilogue-xd/projectFiles.ts`, writing the whole buildable project into a named subfolder
     * (`<UnitName>-minilogue-xd`) of the configured build output folder. Same scope note and
     * rename-aside/error contract as `exportNts1MkiiUnit`.
     */
    exportMinilogueXdUnit(
      doc: PatchDocument,
      unitName: string,
      /** Where the patch is saved: subpatches next to it take precedence. */
      patchFilePath: string | null
    ): Promise<{ folderPath: string }>
  }
  settings: {
    /** Reads the persisted left/right sidebar widths (px), undefined on first run (caller falls back to main.css's own defaults). */
    getSidebarWidths(): Promise<{ left: number; right: number } | undefined>
    /** AppSettings.uploadAlwaysReplace -- false until the user ticks it in UploadUnitDialog.tsx. */
    getUploadAlwaysReplace(): Promise<boolean>
    setUploadAlwaysReplace(value: boolean): Promise<void>
    /** Persists both sidebar widths so they survive an app restart -- called once per drag gesture (on pointerup), not per pointermove. */
    setSidebarWidths(widths: { left: number; right: number }): Promise<void>
    /**
     * The folder settings (`PathSettingKey`), undefined until configured. Clear writes `''`,
     * which every reader treats like undefined.
     */
    getPath(key: PathSettingKey): Promise<string | undefined>
    /** Persists one folder setting; `subpatchLibraryPath` also re-points the library watcher. */
    setPath(key: PathSettingKey, path: string): Promise<void>
    /** A native folder picker titled for `key`; resolves null if the user cancels. */
    pickPath(key: PathSettingKey): Promise<string | null>
  }
  subpatchLibrary: {
    /**
     * The subpatches a patch at `patchFilePath` sees, freshly read from disk: the `.loguesub`
     * files at the top level of its folder, then every one under the configured library folder
     * whose type no local file already has (a local file overrides). No path (an unsaved patch):
     * the library only. Main also watches that folder from then on. The renderer re-lists on
     * every `subpatchLibrary.changed` event; Export/Build never go through this -- main reads the
     * same saved files itself, so unsaved edits can't leak in.
     */
    list(patchFilePath: string | null): Promise<SubpatchLibraryEntry[]>
  }
  logueBuild: {
    /**
     * The real, end-to-end sibling of `logueExport.exportMinilogueXdUnit`: generates the same
     * minilogue xd project source and stages it as a temporary subdirectory of the user's own
     * configured `logueSdkPath` checkout, then runs `make`/`make install` directly against a
     * local `arm-none-eabi-gcc` install (see `detectLocalArmToolchain`) -- built with whatever
     * compiler version is actually installed. On success copies the resulting `.mnlgxdunit` straight into the configured build
     * output folder as `<UnitName>.mnlgxdunit` -- no "Save As" dialog; a pre-existing file at
     * that exact path is renamed aside first (main/config/buildOutputFolder.ts's
     * `makeRoomForDestination`), never overwritten. The staging subdirectory is always removed
     * afterward, success or failure. Rejects with a clear, specific message (not a generic
     * wrapper) when `logueSdkPath`/the build output folder isn't configured, no local toolchain
     * is found, or the real build itself fails (the real captured
     * compiler/toolchain output is included).
     */
    buildMinilogueXdUnit(
      doc: PatchDocument,
      unitName: string,
      /** Where the patch is saved: subpatches next to it take precedence. */
      patchFilePath: string | null
    ): Promise<LogueBuildResult>
    /**
     * Real-hardware verification proved NTS-1 mkII units
     * built this way upload and run correctly (Kontrol Editor), so this is the same real,
     * end-to-end sibling of `logueExport.exportNts1MkiiUnit` -- generates the same source,
     * stages it alongside the real `dummy-<module>` template's own `Makefile`/`wasm.cc`
     * (copied, not regenerated -- this project's own generator has never produced NTS-1 mkII's
     * build scaffold the way it does minilogue xd's embedded one) in a temporary subdirectory of
     * `logueSdkPath`. Same staging-cleanup/
     * output-folder/error-surfacing contract as `buildMinilogueXdUnit` (destination file:
     * `<UnitName>.nts1mkiiunit`).
     */
    buildNts1MkiiUnit(
      doc: PatchDocument,
      unitName: string,
      /** Where the patch is saved: subpatches next to it take precedence. */
      patchFilePath: string | null
    ): Promise<LogueBuildResult>
    /**
     * Probes for a usable local `arm-none-eabi-gcc` install (an explicit `armToolchainPath`
     * override first, then a short list of known Homebrew/Arm-installer locations -- see
     * main/ipc/logueBuild.ts's `resolveArmToolchainBinDir`) without attempting a build. Returns
     * null if none is found. BuildPanel.tsx uses this to show whether Build is actually
     * available, and which compiler version it would use, before the user tries it.
     */
    detectLocalArmToolchain(): Promise<ArmToolchainInfo | null>
  }
  logueDevice: {
    /**
     * Reads a built unit file's raw bytes for a direct SysEx upload (the renderer owns Web MIDI
     * but is sandboxed from the filesystem). Only an existing `.mnlgxdunit`/`.nts1mkiiunit` file
     * of plausible size is accepted -- see main/ipc/logueDevice.ts.
     */
    readUnitFile(path: string): Promise<Uint8Array>
    /**
     * Writes a device backup (logue-codegen's `planBackup` output) as ONE new zip,
     * `<build output folder>/backups/<fileName>` (`backup-<timestamp>.<device>.zip`, see
     * `backupZipName`). Rejects if that file already exists. Resolves the zip's path.
     */
    writeBackup(fileName: string, files: DeviceBackupFile[]): Promise<string>
    /** Picker for a backup zip (or an older backup folder), defaulting to the backups folder; reads its index.json and every restore input (`*.body.bin`, `*.nts1mkiiunit`). Null if cancelled. */
    openBackup(): Promise<OpenedDeviceBackup | null>
  }
  /**
   * WAV import for `logue/osc/granular`. Main only reads the file (the sandboxed renderer can't);
   * decoding, resampling and mu-law encoding happen in the renderer via logue-codegen's
   * dependency-free `sample/importSample.ts`, so they stay unit-tested outside Electron.
   */
  sampleFile: {
    /** Picker for one .wav file. Null if cancelled. */
    pickWav(): Promise<PickedWavFile | null>
    /** Re-reads a previously imported file by path (for re-importing at another size). Only an
     *  existing `.wav` of plausible size is accepted -- see main/ipc/sampleFile.ts. */
    readWav(path: string): Promise<PickedWavFile>
  }
  /**
   * Raw MIDI through the native `logue-midi-helper` (main/midi/midiHelper.ts), replacing Web
   * MIDI: a real minilogue xd's long SysEx carries stray F7s that Chromium truncates at. Incoming
   * bytes arrive UNPARSED via the `logueMidi.data` event; reassembly is the renderer's job
   * (logue-codegen's RawSysexAssembler). Port ids are CoreMIDI uniqueIDs.
   */
  logueMidi: {
    listPorts(): Promise<{ sources: MidiPortInfo[]; destinations: MidiPortInfo[] }>
    /** Starts forwarding a source's bytes as `logueMidi.data` events (idempotent). */
    connect(sourceId: number): Promise<void>
    /** Stops forwarding a source (a no-op if it isn't connected). */
    disconnect(sourceId: number): Promise<void>
    /** Resolves once CoreMIDI has finished sending (large SysEx included). */
    send(destinationId: number, bytes: Uint8Array): Promise<void>
  }
  /** Subscriptions for AxolotiIpcEvents -- see AxolotiEventSubscriptions below. */
  events: AxolotiEventSubscriptions
}

/** Channel names for AxolotiIpcApi methods, namespace.method -> ipc channel string. */
export const IPC_CHANNELS = {
  'system.ping': 'axoloti:system.ping',
  'system.getAppVersion': 'axoloti:system.getAppVersion',
  'system.showItemInFolder': 'axoloti:system.showItemInFolder',
  'system.setUnsavedDocuments': 'axoloti:system.setUnsavedDocuments',
  'system.closeWindowAfterSave': 'axoloti:system.closeWindowAfterSave',
  'clipboard.writeText': 'axoloti:clipboard.writeText',
  'clipboard.readText': 'axoloti:clipboard.readText',
  'settings.getSidebarWidths': 'axoloti:settings.getSidebarWidths',
  'settings.getUploadAlwaysReplace': 'axoloti:settings.getUploadAlwaysReplace',
  'settings.setUploadAlwaysReplace': 'axoloti:settings.setUploadAlwaysReplace',
  'settings.setSidebarWidths': 'axoloti:settings.setSidebarWidths',
  'settings.getPath': 'axoloti:settings.getPath',
  'settings.setPath': 'axoloti:settings.setPath',
  'settings.pickPath': 'axoloti:settings.pickPath',
  'subpatchLibrary.list': 'axoloti:subpatchLibrary.list',
  'patchFile.openPath': 'axoloti:patchFile.openPath',
  'patchFile.save': 'axoloti:patchFile.save',
  'patchFile.openDialog': 'axoloti:patchFile.openDialog',
  'patchFile.saveDialog': 'axoloti:patchFile.saveDialog',
  'patchFile.listRecent': 'axoloti:patchFile.listRecent',
  'logueExport.exportNts1MkiiUnit': 'axoloti:logueExport.exportNts1MkiiUnit',
  'logueExport.exportMinilogueXdUnit': 'axoloti:logueExport.exportMinilogueXdUnit',
  'logueBuild.buildMinilogueXdUnit': 'axoloti:logueBuild.buildMinilogueXdUnit',
  'logueBuild.buildNts1MkiiUnit': 'axoloti:logueBuild.buildNts1MkiiUnit',
  'logueBuild.detectLocalArmToolchain': 'axoloti:logueBuild.detectLocalArmToolchain',
  'logueDevice.readUnitFile': 'axoloti:logueDevice.readUnitFile',
  'logueDevice.writeBackup': 'axoloti:logueDevice.writeBackup',
  'logueDevice.openBackup': 'axoloti:logueDevice.openBackup',
  'sampleFile.pickWav': 'axoloti:sampleFile.pickWav',
  'sampleFile.readWav': 'axoloti:sampleFile.readWav',
  'logueMidi.listPorts': 'axoloti:logueMidi.listPorts',
  'logueMidi.connect': 'axoloti:logueMidi.connect',
  'logueMidi.disconnect': 'axoloti:logueMidi.disconnect',
  'logueMidi.send': 'axoloti:logueMidi.send'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

/**
 * Main -> renderer push events -- the old Axoloti USB/SD push events (`usb.*`/`sd.uploadProgress`)
 * were removed along with the hardware code they served. A *logue unit upload doesn't need any:
 * it runs over Web MIDI entirely inside the renderer (`logue-codegen/src/sysex/`).
 */
export interface AxolotiIpcEvents {
  /**
   * Native File-menu actions (main/index.ts's Menu.buildFromTemplate) -- the menu has no
   * access to renderer/zustand state, so a click just forwards intent here and the renderer
   * runs the exact same handler its old toolbar button used to call.
   */
  /** "New Logue Oscillator" -- creates an ordinary new patch tab with `PatchSettings.logueTarget`
   *  pre-set (`{module: 'osc'}`). Used to be two
   *  separate platform-specific menu items/channels (NTS-1 mkII / minilogue xd) -- collapsed to
   *  one once a document itself stopped committing to a
   *  platform at all; which platform to target is now decided at Export/Build time instead. */
  'menu.newLogueOsc'(): void
  /** "New Mod/Delay/Reverb Effect" -- the same, with an effect module (`docs/PLAN-effects.md`). */
  'menu.newLogueEffect'(module: LogueEffectModule): void
  /** "New Subpatch" -- an untitled subpatch definition tab (`settings.subpatch`), seeded with one inlet and one outlet. */
  'menu.newSubpatch'(): void
  'menu.openPatch'(): void
  'menu.savePatch'(): void
  'menu.savePatchAs'(): void
  /** A file picked from the native "Open Recent" submenu (role: 'recentDocuments') or the Dock icon, via app.on('open-file'). */
  'menu.openRecentFile'(filePath: string): void
  /** The app menu's "About" item -- overridden from its default `role: 'about'` (native panel) to open AboutModal.tsx instead, since the native panel can't show a library/license list. */
  'menu.openAbout'(): void
  /** Build and Device menus -- all handled in BuildPanel.tsx (always mounted, and it owns the
   *  build-target selector and the device dialogs). The menu itself is stateless, so it can never
   *  disagree with the panel's selected platform. */
  'menu.exportUnitSource'(): void
  'menu.buildUnit'(): void
  'menu.buildAndUploadUnit'(): void
  'menu.openParamMatrix'(): void
  'menu.deviceBackup'(): void
  'menu.deviceRestore'(): void
  /** Edit menu's Undo/Redo: a focused text field gets its native undo (App.tsx), anything else
   *  the active patch's (PatchWorkspace.tsx). */
  'menu.undo'(): void
  'menu.redo'(): void
  /** App and Help menus -- App.tsx opens the modal. */
  'menu.openSettings'(): void
  'menu.openHelp'(): void
  /** View menu: fit the active tab's canvas to its nodes (PatchCanvas.tsx). */
  'menu.zoomToFit'(): void
  /** View menu's arrange items -- handled by PatchWorkspace.tsx against the active tab. */
  'menu.arrangeByFlow'(): void
  'menu.spreadOutNodes'(): void
  /** The user picked "Save" in the unsaved-changes prompt on window close/⌘Q: save every dirty tab, then call `system.closeWindowAfterSave` (or do nothing if a save was cancelled/failed). */
  'app.saveAllAndClose'(): void
  /** Raw, unparsed bytes from a connected MIDI source (realtime bytes already dropped by the helper). */
  'logueMidi.data'(sourceId: number, bytes: Uint8Array): void
  /** CoreMIDI ports appeared or disappeared (a device was plugged/unplugged). */
  'logueMidi.setupChanged'(): void
  /** Something in the subpatch library folder changed on disk (or the folder setting did) -- re-list it. */
  'subpatchLibrary.changed'(): void
}

/** Channel names for AxolotiIpcEvents, namespace.event -> ipc channel string. */
export const IPC_EVENT_CHANNELS = {
  'menu.newLogueOsc': 'axoloti:event:menu.newLogueOsc',
  'menu.newLogueEffect': 'axoloti:event:menu.newLogueEffect',
  'menu.newSubpatch': 'axoloti:event:menu.newSubpatch',
  'menu.openPatch': 'axoloti:event:menu.openPatch',
  'menu.savePatch': 'axoloti:event:menu.savePatch',
  'menu.savePatchAs': 'axoloti:event:menu.savePatchAs',
  'menu.openRecentFile': 'axoloti:event:menu.openRecentFile',
  'menu.openAbout': 'axoloti:event:menu.openAbout',
  'menu.exportUnitSource': 'axoloti:event:menu.exportUnitSource',
  'menu.buildUnit': 'axoloti:event:menu.buildUnit',
  'menu.buildAndUploadUnit': 'axoloti:event:menu.buildAndUploadUnit',
  'menu.openParamMatrix': 'axoloti:event:menu.openParamMatrix',
  'menu.deviceBackup': 'axoloti:event:menu.deviceBackup',
  'menu.deviceRestore': 'axoloti:event:menu.deviceRestore',
  'menu.undo': 'axoloti:event:menu.undo',
  'menu.redo': 'axoloti:event:menu.redo',
  'menu.openSettings': 'axoloti:event:menu.openSettings',
  'menu.openHelp': 'axoloti:event:menu.openHelp',
  'menu.zoomToFit': 'axoloti:event:menu.zoomToFit',
  'menu.arrangeByFlow': 'axoloti:event:menu.arrangeByFlow',
  'menu.spreadOutNodes': 'axoloti:event:menu.spreadOutNodes',
  'app.saveAllAndClose': 'axoloti:event:app.saveAllAndClose',
  'logueMidi.data': 'axoloti:event:logueMidi.data',
  'logueMidi.setupChanged': 'axoloti:event:logueMidi.setupChanged',
  'subpatchLibrary.changed': 'axoloti:event:subpatchLibrary.changed'
} as const

/** The renderer-facing subscription surface for AxolotiIpcEvents -- each returns an unsubscribe function, matching DOM `addEventListener`/cleanup conventions React effects expect. */
export interface AxolotiEventSubscriptions {
  onMenuNewLogueOsc(cb: () => void): () => void
  onMenuNewLogueEffect(cb: (module: LogueEffectModule) => void): () => void
  onMenuNewSubpatch(cb: () => void): () => void
  onMenuOpenPatch(cb: () => void): () => void
  onMenuSavePatch(cb: () => void): () => void
  onMenuSavePatchAs(cb: () => void): () => void
  onMenuOpenRecentFile(cb: (filePath: string) => void): () => void
  onMenuOpenAbout(cb: () => void): () => void
  onMenuExportUnitSource(cb: () => void): () => void
  onMenuBuildUnit(cb: () => void): () => void
  onMenuBuildAndUploadUnit(cb: () => void): () => void
  onMenuOpenParamMatrix(cb: () => void): () => void
  onMenuDeviceBackup(cb: () => void): () => void
  onMenuDeviceRestore(cb: () => void): () => void
  onMenuUndo(cb: () => void): () => void
  onMenuRedo(cb: () => void): () => void
  onMenuOpenSettings(cb: () => void): () => void
  onMenuOpenHelp(cb: () => void): () => void
  onMenuZoomToFit(cb: () => void): () => void
  onMenuArrangeByFlow(cb: () => void): () => void
  onMenuSpreadOutNodes(cb: () => void): () => void
  onSaveAllAndClose(cb: () => void): () => void
  onLogueMidiData(cb: (sourceId: number, bytes: Uint8Array) => void): () => void
  onLogueMidiSetupChanged(cb: () => void): () => void
  onSubpatchLibraryChanged(cb: () => void): () => void
}

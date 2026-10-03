import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  IPC_EVENT_CHANNELS,
  type AxolotiIpcApi,
  type PathSettingKey,
  type PingResult
} from '../shared/ipc/contract'

/** `ipcRenderer.on` callbacks always receive the event object as their first arg -- this drops it so subscribers only see their actual payload args. */
function subscribe<Args extends unknown[]>(
  channel: string,
  cb: (...args: Args) => void
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: Args): void => cb(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// Sandboxed preload scripts (webPreferences.sandbox: true) run in a restricted loader that
// cannot require() arbitrary node_modules -- only this file's own bundled code is available.
// Keep this file's dependency graph self-contained.
const axolotiApi: AxolotiIpcApi = {
  system: {
    ping: (message: string): Promise<PingResult> =>
      ipcRenderer.invoke(IPC_CHANNELS['system.ping'], message),
    getAppVersion: () => ipcRenderer.invoke(IPC_CHANNELS['system.getAppVersion']),
    showItemInFolder: (path: string) =>
      ipcRenderer.invoke(IPC_CHANNELS['system.showItemInFolder'], path),
    setUnsavedDocuments: (titles: string[]) =>
      ipcRenderer.invoke(IPC_CHANNELS['system.setUnsavedDocuments'], titles),
    closeWindowAfterSave: () => ipcRenderer.invoke(IPC_CHANNELS['system.closeWindowAfterSave'])
  },
  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke(IPC_CHANNELS['clipboard.writeText'], text),
    readText: () => ipcRenderer.invoke(IPC_CHANNELS['clipboard.readText'])
  },
  settings: {
    getSidebarWidths: () => ipcRenderer.invoke(IPC_CHANNELS['settings.getSidebarWidths']),
    getUploadAlwaysReplace: () =>
      ipcRenderer.invoke(IPC_CHANNELS['settings.getUploadAlwaysReplace']),
    setUploadAlwaysReplace: (value: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS['settings.setUploadAlwaysReplace'], value),
    setSidebarWidths: (widths: { left: number; right: number }) =>
      ipcRenderer.invoke(IPC_CHANNELS['settings.setSidebarWidths'], widths),
    getPath: (key: PathSettingKey) => ipcRenderer.invoke(IPC_CHANNELS['settings.getPath'], key),
    setPath: (key: PathSettingKey, path: string) =>
      ipcRenderer.invoke(IPC_CHANNELS['settings.setPath'], key, path),
    pickPath: (key: PathSettingKey) => ipcRenderer.invoke(IPC_CHANNELS['settings.pickPath'], key)
  },
  subpatchLibrary: {
    list: (patchFilePath) => ipcRenderer.invoke(IPC_CHANNELS['subpatchLibrary.list'], patchFilePath)
  },
  patchFile: {
    openPath: (filePath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS['patchFile.openPath'], filePath),
    save: (filePath: string, doc) =>
      ipcRenderer.invoke(IPC_CHANNELS['patchFile.save'], filePath, doc),
    openDialog: () => ipcRenderer.invoke(IPC_CHANNELS['patchFile.openDialog']),
    saveDialog: (doc, currentFilePath) =>
      ipcRenderer.invoke(IPC_CHANNELS['patchFile.saveDialog'], doc, currentFilePath),
    listRecent: () => ipcRenderer.invoke(IPC_CHANNELS['patchFile.listRecent'])
  },
  logueExport: {
    exportNts1MkiiUnit: (doc, unitName, patchFilePath) =>
      ipcRenderer.invoke(
        IPC_CHANNELS['logueExport.exportNts1MkiiUnit'],
        doc,
        unitName,
        patchFilePath
      ),
    exportMinilogueXdUnit: (doc, unitName, patchFilePath) =>
      ipcRenderer.invoke(
        IPC_CHANNELS['logueExport.exportMinilogueXdUnit'],
        doc,
        unitName,
        patchFilePath
      )
  },
  logueBuild: {
    buildMinilogueXdUnit: (doc, unitName, patchFilePath) =>
      ipcRenderer.invoke(
        IPC_CHANNELS['logueBuild.buildMinilogueXdUnit'],
        doc,
        unitName,
        patchFilePath
      ),
    buildNts1MkiiUnit: (doc, unitName, patchFilePath) =>
      ipcRenderer.invoke(
        IPC_CHANNELS['logueBuild.buildNts1MkiiUnit'],
        doc,
        unitName,
        patchFilePath
      ),
    detectLocalArmToolchain: () =>
      ipcRenderer.invoke(IPC_CHANNELS['logueBuild.detectLocalArmToolchain'])
  },
  logueMidi: {
    listPorts: () => ipcRenderer.invoke(IPC_CHANNELS['logueMidi.listPorts']),
    connect: (sourceId: number) => ipcRenderer.invoke(IPC_CHANNELS['logueMidi.connect'], sourceId),
    disconnect: (sourceId: number) =>
      ipcRenderer.invoke(IPC_CHANNELS['logueMidi.disconnect'], sourceId),
    send: (destinationId: number, bytes: Uint8Array) =>
      ipcRenderer.invoke(IPC_CHANNELS['logueMidi.send'], destinationId, bytes)
  },
  sampleFile: {
    pickWav: () => ipcRenderer.invoke(IPC_CHANNELS['sampleFile.pickWav']),
    readWav: (path: string) => ipcRenderer.invoke(IPC_CHANNELS['sampleFile.readWav'], path)
  },
  logueDevice: {
    readUnitFile: (path: string) =>
      ipcRenderer.invoke(IPC_CHANNELS['logueDevice.readUnitFile'], path),
    writeBackup: (fileName, files) =>
      ipcRenderer.invoke(IPC_CHANNELS['logueDevice.writeBackup'], fileName, files),
    openBackup: () => ipcRenderer.invoke(IPC_CHANNELS['logueDevice.openBackup'])
  },
  events: {
    onMenuNewLogueOsc: (cb) => subscribe(IPC_EVENT_CHANNELS['menu.newLogueOsc'], cb),
    onMenuNewLogueEffect: (cb) => subscribe(IPC_EVENT_CHANNELS['menu.newLogueEffect'], cb),
    onMenuNewSubpatch: (cb) => subscribe(IPC_EVENT_CHANNELS['menu.newSubpatch'], cb),
    onMenuOpenPatch: (cb) => subscribe(IPC_EVENT_CHANNELS['menu.openPatch'], cb),
    onMenuSavePatch: (cb) => subscribe(IPC_EVENT_CHANNELS['menu.savePatch'], cb),
    onMenuSavePatchAs: (cb) => subscribe(IPC_EVENT_CHANNELS['menu.savePatchAs'], cb),
    onMenuOpenRecentFile: (cb) => subscribe(IPC_EVENT_CHANNELS['menu.openRecentFile'], cb),
    onMenuOpenAbout: (cb) => subscribe(IPC_EVENT_CHANNELS['menu.openAbout'], cb),
    onMenuExportUnitSource: (cb) => subscribe(IPC_EVENT_CHANNELS['menu.exportUnitSource'], cb),
    onMenuBuildUnit: (cb) => subscribe(IPC_EVENT_CHANNELS['menu.buildUnit'], cb),
    onMenuBuildAndUploadUnit: (cb) => subscribe(IPC_EVENT_CHANNELS['menu.buildAndUploadUnit'], cb),
    onMenuOpenParamMatrix: (cb) => subscribe(IPC_EVENT_CHANNELS['menu.openParamMatrix'], cb),
    onMenuDeviceBackup: (cb) => subscribe(IPC_EVENT_CHANNELS['menu.deviceBackup'], cb),
    onMenuDeviceRestore: (cb) => subscribe(IPC_EVENT_CHANNELS['menu.deviceRestore'], cb),
    onMenuUndo: (cb) => subscribe(IPC_EVENT_CHANNELS['menu.undo'], cb),
    onMenuRedo: (cb) => subscribe(IPC_EVENT_CHANNELS['menu.redo'], cb),
    onMenuOpenSettings: (cb) => subscribe(IPC_EVENT_CHANNELS['menu.openSettings'], cb),
    onMenuOpenHelp: (cb) => subscribe(IPC_EVENT_CHANNELS['menu.openHelp'], cb),
    onMenuZoomToFit: (cb) => subscribe(IPC_EVENT_CHANNELS['menu.zoomToFit'], cb),
    onMenuArrangeByFlow: (cb) => subscribe(IPC_EVENT_CHANNELS['menu.arrangeByFlow'], cb),
    onMenuSpreadOutNodes: (cb) => subscribe(IPC_EVENT_CHANNELS['menu.spreadOutNodes'], cb),
    onSaveAllAndClose: (cb) => subscribe(IPC_EVENT_CHANNELS['app.saveAllAndClose'], cb),
    onLogueMidiData: (cb) => subscribe(IPC_EVENT_CHANNELS['logueMidi.data'], cb),
    onLogueMidiSetupChanged: (cb) => subscribe(IPC_EVENT_CHANNELS['logueMidi.setupChanged'], cb),
    onSubpatchLibraryChanged: (cb) => subscribe(IPC_EVENT_CHANNELS['subpatchLibrary.changed'], cb)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('axoloti', axolotiApi)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.axoloti = axolotiApi
}

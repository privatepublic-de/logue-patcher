import { dirname } from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS, IPC_EVENT_CHANNELS } from '../../shared/ipc/contract'
import { appHomeDir } from '../config/appHome'
import { loadAppSettings } from '../config/appSettings'
import {
  listSubpatchesFor,
  loadSubpatchDefinitions,
  watchSubpatchLibrary
} from '../config/subpatchLibrary'

let closeWatcher: (() => void) | undefined
let closeLocalWatcher: (() => void) | undefined
let watchedPatchDir: string | undefined

function notifyChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC_EVENT_CHANNELS['subpatchLibrary.changed'])
  }
}

export function currentSubpatchLibraryPath(): string | undefined {
  return loadAppSettings(appHomeDir()).subpatchLibraryPath
}

/** The saved definitions Export/Build flatten against, read at click time: the patch's own
 *  folder first, then the library. */
export function loadCurrentSubpatchDefinitions(
  patchFilePath: string | null
): ReturnType<typeof loadSubpatchDefinitions> {
  return loadSubpatchDefinitions(patchFilePath, currentSubpatchLibraryPath())
}

/** The renderer lists for one patch at a time (the active tab), so one local watcher suffices. */
function watchPatchFolder(patchFilePath: string | null): void {
  const dir = patchFilePath ? dirname(patchFilePath) : undefined
  if (dir === watchedPatchDir) return
  closeLocalWatcher?.()
  watchedPatchDir = dir
  closeLocalWatcher = dir ? watchSubpatchLibrary(dir, notifyChanged, true) : undefined
}

/** (Re)points the watcher at the configured folder and tells every window to re-list it. */
export function restartSubpatchLibraryWatcher(): void {
  closeWatcher?.()
  const dir = currentSubpatchLibraryPath()
  closeWatcher = dir ? watchSubpatchLibrary(dir, notifyChanged) : undefined
  notifyChanged()
}

export function registerSubpatchLibraryIpc(): void {
  ipcMain.handle(IPC_CHANNELS['subpatchLibrary.list'], (_event, patchFilePath: string | null) => {
    watchPatchFolder(patchFilePath ?? null)
    return listSubpatchesFor(patchFilePath ?? null, currentSubpatchLibraryPath())
  })
  restartSubpatchLibraryWatcher()
}

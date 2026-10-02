import { app, ipcMain, dialog } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC_CHANNELS, type OpenPatchResult } from '../../shared/ipc/contract'
import type { PatchDocument } from '../../shared/domain/patch'
import { parsePatchFile, serializePatchFile } from '../../shared/json/patchCodec'
import { LOGUESUB_EXTENSION } from '../config/subpatchLibrary'
import { currentSubpatchLibraryPath } from './subpatchLibrary'
import { appHomeDir } from '../config/appHome'
import { loadAppSettings, updateAppSettings } from '../config/appSettings'
import { withRecentFile } from '../config/recentFiles'

/** macOS's Open Recent menu plus the app's own list, which the start screen reads. */
function rememberRecent(filePath: string): void {
  app.addRecentDocument(filePath)
  const home = appHomeDir()
  updateAppSettings(home, {
    recentFiles: withRecentFile(loadAppSettings(home).recentFiles, filePath)
  })
}

/** A root patch -- plain JSON (see `shared/json/patchCodec.ts`). */
export const LOGUEPATCH_FILTER = { name: 'Logue Patcher Document', extensions: ['loguepatch'] }
/** A subpatch definition -- the same JSON codec, marked `settings.subpatch` (see `PatchSettings.subpatch`). */
export const LOGUESUB_FILTER = { name: 'Logue Subpatch', extensions: [LOGUESUB_EXTENSION] }
/** Open offers both at once; Save picks the one matching the document being saved. */
export const OPEN_DIALOG_FILTERS = [
  { name: 'Logue Patcher Documents', extensions: ['loguepatch', LOGUESUB_EXTENSION] }
]

/** Save/Save As for a subpatch defaults into the library folder, so it shows up in the palette. */
export function saveDialogOptionsFor(
  doc: PatchDocument,
  currentFilePath: string | undefined,
  libraryDir: string | undefined
): { filters: (typeof LOGUEPATCH_FILTER)[]; defaultPath: string } {
  if (doc.settings.subpatch) {
    const untitled = `untitled.${LOGUESUB_EXTENSION}`
    return {
      filters: [LOGUESUB_FILTER],
      defaultPath: currentFilePath ?? (libraryDir ? join(libraryDir, untitled) : untitled)
    }
  }
  return {
    filters: [LOGUEPATCH_FILTER],
    defaultPath: currentFilePath ?? `untitled.${LOGUEPATCH_FILTER.extensions[0]}`
  }
}

export function registerPatchFileIpc(): void {
  ipcMain.handle(IPC_CHANNELS['patchFile.listRecent'], (): string[] =>
    (loadAppSettings(appHomeDir()).recentFiles ?? []).filter((p) => existsSync(p))
  )

  ipcMain.handle(
    IPC_CHANNELS['patchFile.openPath'],
    (_event, filePath: string): OpenPatchResult => {
      const text = readFileSync(filePath, 'utf-8')
      rememberRecent(filePath)
      return { filePath, doc: parsePatchFile(text) }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS['patchFile.save'],
    (_event, filePath: string, doc: PatchDocument): void => {
      writeFileSync(filePath, serializePatchFile(doc), 'utf-8')
      rememberRecent(filePath)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS['patchFile.openDialog'],
    async (): Promise<OpenPatchResult | null> => {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Open Patch',
        filters: OPEN_DIALOG_FILTERS,
        properties: ['openFile']
      })
      if (canceled || filePaths.length === 0) return null
      const filePath = filePaths[0]
      const text = readFileSync(filePath, 'utf-8')
      rememberRecent(filePath)
      return { filePath, doc: parsePatchFile(text) }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS['patchFile.saveDialog'],
    async (_event, doc: PatchDocument, currentFilePath?: string): Promise<string | null> => {
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: doc.settings.subpatch ? 'Save Subpatch' : 'Save Patch',
        ...saveDialogOptionsFor(doc, currentFilePath, currentSubpatchLibraryPath())
      })
      if (canceled || !filePath) return null
      writeFileSync(filePath, serializePatchFile(doc), 'utf-8')
      rememberRecent(filePath)
      return filePath
    }
  )
}

import { ipcMain } from 'electron'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { IPC_CHANNELS } from '../../shared/ipc/contract'
import type { PatchDocument } from '../../shared/domain/patch'
import { generateNts1MkiiProject } from '@logue-codegen/nts1mkii/projectFiles'
import { generateMinilogueXdProject } from '@logue-codegen/minilogue-xd/projectFiles'
import { resolveBuildOutputFolder, makeRoomForDestination } from '../config/buildOutputFolder'
import { deriveExportFolderName } from '../config/buildResultNaming'
import { loadCurrentSubpatchDefinitions } from './subpatchLibrary'
import { appHomeDir } from '../config/appHome'

/**
 * Writes real, buildable NTS-1 mkII / minilogue xd unit source (oscillator or effect) (not a compiled
 * `.nts1mkiiunit`/`.mnlgxdunit`)
 * generated from a logue-target `PatchDocument` into a named subfolder of the user's configured
 * build output folder (see main/config/buildOutputFolder.ts) -- no per-click folder-picker
 * dialog. Rejects with `BuildOutputFolderNotConfiguredError` if no output folder is configured
 * yet. Each generator's own validation errors (UnsupportedLogueNodeError/InvalidLogueUnitNameError/
 * InvalidLogueParamError) propagate naturally through `ipcMain.handle`'s promise rejection --
 * deliberately not caught here, so the renderer sees the same clear, specific message the
 * `logue-generateOscUnit.spec.ts`/`logue-generateOldGenOscUnit.spec.ts` suites already test,
 * not a generic wrapper.
 */
export function registerLogueExportIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS['logueExport.exportNts1MkiiUnit'],
    async (
      _event,
      doc: PatchDocument,
      unitName: string,
      patchFilePath: string | null
    ): Promise<{ folderPath: string }> => {
      const outputFolder = resolveBuildOutputFolder(appHomeDir())
      const folderPath = join(outputFolder, deriveExportFolderName(unitName, 'nts1mkii'))
      makeRoomForDestination(folderPath)

      const { files } = generateNts1MkiiProject(
        doc,
        unitName,
        loadCurrentSubpatchDefinitions(patchFilePath ?? null)
      )
      mkdirSync(folderPath, { recursive: true })
      for (const [name, text] of Object.entries(files)) {
        writeFileSync(join(folderPath, name), text, 'utf-8')
      }

      return { folderPath }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS['logueExport.exportMinilogueXdUnit'],
    async (
      _event,
      doc: PatchDocument,
      unitName: string,
      patchFilePath: string | null
    ): Promise<{ folderPath: string }> => {
      const outputFolder = resolveBuildOutputFolder(appHomeDir())
      const folderPath = join(outputFolder, deriveExportFolderName(unitName, 'minilogue-xd'))
      makeRoomForDestination(folderPath)

      const { files } = generateMinilogueXdProject(
        doc,
        unitName,
        loadCurrentSubpatchDefinitions(patchFilePath ?? null)
      )
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(folderPath, path)), { recursive: true })
        writeFileSync(join(folderPath, path), text, 'utf-8')
      }

      return { folderPath }
    }
  )
}

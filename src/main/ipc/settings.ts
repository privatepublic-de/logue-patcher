import { dialog, ipcMain } from 'electron'
import { IPC_CHANNELS, PATH_SETTING_KEYS, type PathSettingKey } from '../../shared/ipc/contract'
import { loadAppSettings, updateAppSettings } from '../config/appSettings'
import { appHomeDir } from '../config/appHome'
import { restartSubpatchLibraryWatcher } from './subpatchLibrary'

/** `mayCreate`: the folder may not exist yet (an output or library folder, not a checkout). */
const PATH_PICKERS: Record<PathSettingKey, { title: string; mayCreate: boolean }> = {
  logueSdkPath: { title: 'Locate logue-sdk', mayCreate: false },
  armToolchainPath: { title: 'Locate ARM toolchain bin directory', mayCreate: false },
  buildOutputFolder: { title: 'Choose Build Output Folder', mayCreate: true },
  subpatchLibraryPath: { title: 'Choose Subpatch Library Folder', mayCreate: true }
}

function pathSettingKey(key: unknown): PathSettingKey {
  if (!PATH_SETTING_KEYS.includes(key as PathSettingKey)) {
    throw new Error(`unknown path setting ${JSON.stringify(key)}`)
  }
  return key as PathSettingKey
}

export function registerSettingsIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS['settings.getUploadAlwaysReplace'],
    (): boolean => loadAppSettings(appHomeDir()).uploadAlwaysReplace === true
  )

  ipcMain.handle(IPC_CHANNELS['settings.setUploadAlwaysReplace'], (_event, value: boolean) => {
    updateAppSettings(appHomeDir(), { uploadAlwaysReplace: value === true })
  })

  ipcMain.handle(
    IPC_CHANNELS['settings.getSidebarWidths'],
    (): { left: number; right: number } | undefined => {
      return loadAppSettings(appHomeDir()).sidebarWidths
    }
  )

  ipcMain.handle(
    IPC_CHANNELS['settings.setSidebarWidths'],
    (_event, widths: { left: number; right: number }): void => {
      updateAppSettings(appHomeDir(), { sidebarWidths: widths })
    }
  )

  ipcMain.handle(IPC_CHANNELS['settings.getPath'], (_event, key: unknown): string | undefined => {
    return loadAppSettings(appHomeDir())[pathSettingKey(key)]
  })

  ipcMain.handle(IPC_CHANNELS['settings.setPath'], (_event, key: unknown, path: string): void => {
    const k = pathSettingKey(key)
    updateAppSettings(appHomeDir(), { [k]: path })
    if (k === 'subpatchLibraryPath') restartSubpatchLibraryWatcher()
  })

  ipcMain.handle(
    IPC_CHANNELS['settings.pickPath'],
    async (_event, key: unknown): Promise<string | null> => {
      const { title, mayCreate } = PATH_PICKERS[pathSettingKey(key)]
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title,
        buttonLabel: 'Choose',
        properties: mayCreate ? ['openDirectory', 'createDirectory'] : ['openDirectory']
      })
      if (canceled || filePaths.length === 0) return null
      return filePaths[0]
    }
  )
}

import { app, ipcMain, shell } from 'electron'
import { IPC_CHANNELS, type PingResult } from '../../shared/ipc/contract'

export function registerSystemIpc(): void {
  ipcMain.handle(IPC_CHANNELS['system.ping'], (_event, message: string): PingResult => {
    return {
      message,
      appVersion: app.getVersion(),
      respondedAt: Date.now()
    }
  })

  ipcMain.handle(IPC_CHANNELS['system.getAppVersion'], (): string => {
    return app.getVersion()
  })

  /** Reveals the build-results list's own entries in Finder -- see BuildPanel.tsx. */
  ipcMain.handle(IPC_CHANNELS['system.showItemInFolder'], (_event, path: string): void => {
    shell.showItemInFolder(path)
  })
}

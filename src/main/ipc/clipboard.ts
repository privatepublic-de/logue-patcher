import { clipboard, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/contract'

/** Real OS clipboard access -- backs canvas copy/cut/paste (see contract.ts's `clipboard` namespace). */
export function registerClipboardIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS['clipboard.writeText'],
    async (_event, text: string): Promise<void> => {
      clipboard.writeText(text)
    }
  )
  ipcMain.handle(IPC_CHANNELS['clipboard.readText'], async (): Promise<string> => {
    return clipboard.readText()
  })
}

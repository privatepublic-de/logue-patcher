import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC_CHANNELS, IPC_EVENT_CHANNELS } from '../shared/ipc/contract'

/**
 * Stops a window close (red button, ⌘W, and ⌘Q -- which closes every window before quitting)
 * while any tab has unsaved changes. The dirty list is pushed from the renderer ahead of time
 * rather than asked for at close time: `close` must be decided synchronously, and a hung
 * renderer must never be able to block quitting when nothing is actually unsaved.
 */
const unsavedByWindow = new WeakMap<BrowserWindow, string[]>()
const closeConfirmed = new WeakSet<BrowserWindow>()

export function registerQuitGuardIpc(): void {
  ipcMain.handle(IPC_CHANNELS['system.setUnsavedDocuments'], (event, titles: string[]): void => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    unsavedByWindow.set(win, titles)
    win.setDocumentEdited(titles.length > 0)
  })

  ipcMain.handle(IPC_CHANNELS['system.closeWindowAfterSave'], (event): void => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    closeConfirmed.add(win)
    win.close()
  })
}

export function guardWindowClose(win: BrowserWindow): void {
  win.on('close', (event) => {
    const unsaved = unsavedByWindow.get(win) ?? []
    if (unsaved.length === 0 || closeConfirmed.has(win)) return
    event.preventDefault()
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Save', 'Cancel', "Don't Save"],
      defaultId: 0,
      cancelId: 1,
      message:
        unsaved.length === 1
          ? `Do you want to save the changes you made to "${unsaved[0]}"?`
          : `You have unsaved changes in ${unsaved.length} documents. Do you want to save them?`,
      detail:
        (unsaved.length > 1 ? unsaved.map((t) => `• ${t}`).join('\n') + '\n\n' : '') +
        "Your changes will be lost if you don't save them."
    })
    if (choice === 0) {
      win.webContents.send(IPC_EVENT_CHANNELS['app.saveAllAndClose'])
    } else if (choice === 2) {
      closeConfirmed.add(win)
      win.close()
    }
  })
}

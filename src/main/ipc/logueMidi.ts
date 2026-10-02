import { app, BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS, IPC_EVENT_CHANNELS } from '../../shared/ipc/contract'
import { MidiHelper } from '../midi/midiHelper'

/** The renderer's whole MIDI transport: raw bytes through the native helper, no Web MIDI. */
export function registerLogueMidiIpc(): void {
  const broadcast = (channel: string, ...args: unknown[]): void =>
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, ...args))
  const helper = new MidiHelper(
    (source, bytes) => broadcast(IPC_EVENT_CHANNELS['logueMidi.data'], source, bytes),
    () => broadcast(IPC_EVENT_CHANNELS['logueMidi.setupChanged'])
  )
  app.on('will-quit', () => helper.dispose())

  ipcMain.handle(IPC_CHANNELS['logueMidi.listPorts'], () => helper.listPorts())
  ipcMain.handle(IPC_CHANNELS['logueMidi.connect'], (_e, source: number) => helper.connect(source))
  ipcMain.handle(IPC_CHANNELS['logueMidi.disconnect'], (_e, source: number) =>
    helper.disconnect(source)
  )
  ipcMain.handle(IPC_CHANNELS['logueMidi.send'], (_e, dest: number, bytes: Uint8Array) =>
    helper.send(dest, bytes)
  )
}

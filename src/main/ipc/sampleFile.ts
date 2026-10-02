import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { IPC_CHANNELS, type PickedWavFile } from '../../shared/ipc/contract'

// A few minutes of stereo 48k/24-bit -- far more than ever survives the import's fit-to-size step,
// so only a wrong file trips it.
const MAX_WAV_FILE_BYTES = 256 * 1024 * 1024

function readWavFile(path: string): PickedWavFile {
  if (extname(path).toLowerCase() !== '.wav') throw new Error(`Not a .wav file: ${path}`)
  const st = statSync(path)
  if (!st.isFile() || st.size > MAX_WAV_FILE_BYTES) {
    throw new Error(`Not a readable .wav file (${st.size} bytes): ${path}`)
  }
  return { name: basename(path), path, bytes: new Uint8Array(readFileSync(path)) }
}

/** Narrow on purpose, like `logueDevice.readUnitFile`: a picker plus a `.wav`-only read, never a
 *  general file-read channel. */
export function registerSampleFileIpc(): void {
  ipcMain.handle(IPC_CHANNELS['sampleFile.pickWav'], async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts = {
      title: 'Choose a sample (.wav)',
      properties: ['openFile' as const],
      filters: [{ name: 'WAV audio', extensions: ['wav'] }]
    }
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (picked.canceled || picked.filePaths.length === 0) return null
    return readWavFile(picked.filePaths[0])
  })

  ipcMain.handle(IPC_CHANNELS['sampleFile.readWav'], (_event, path: string) => readWavFile(path))
}

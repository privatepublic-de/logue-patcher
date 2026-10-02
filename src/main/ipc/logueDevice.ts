import { BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import {
  IPC_CHANNELS,
  type DeviceBackupFile,
  type OpenedDeviceBackup
} from '../../shared/ipc/contract'
import { appHomeDir } from '../config/appHome'
import { resolveBuildOutputFolder } from '../config/buildOutputFolder'
import { backupZip, readBackupZip } from '@logue-codegen/sysex/unitBackup'

const UNIT_EXTENSIONS = new Set(['.mnlgxdunit', '.nts1mkiiunit'])
// Far above either platform's own storage limits (tens of KB), so only a wrong file trips it.
const MAX_UNIT_FILE_BYTES = 1024 * 1024

/**
 * The sandboxed renderer can't read files itself, but the device session (and so the actual
 * upload) lives there. This is the one narrow read it gets: only an existing unit file, by
 * extension and size -- not a general file-read channel.
 */
export function registerLogueDeviceIpc(): void {
  ipcMain.handle(IPC_CHANNELS['logueDevice.readUnitFile'], (_event, path: string): Uint8Array => {
    if (!UNIT_EXTENSIONS.has(extname(path).toLowerCase())) {
      throw new Error(`Not a unit file: ${path}`)
    }
    const st = statSync(path)
    if (!st.isFile() || st.size > MAX_UNIT_FILE_BYTES) {
      throw new Error(`Not a readable unit file (${st.size} bytes): ${path}`)
    }
    return new Uint8Array(readFileSync(path))
  })

  ipcMain.handle(
    IPC_CHANNELS['logueDevice.writeBackup'],
    (_event, fileName: string, files: DeviceBackupFile[]): string => {
      const root = backupsRoot()
      const path = join(root, safeSegment(fileName))
      if (!path.endsWith('.zip')) throw new Error(`Backup file name must end in .zip: ${fileName}`)
      // One fresh archive per backup, named by timestamp: never overwrite an older one.
      if (existsSync(path)) throw new Error(`A backup named "${fileName}" already exists.`)
      files.forEach((f) => safeSegment(f.name))
      mkdirSync(root, { recursive: true })
      writeFileSync(path, backupZip(files))
      return path
    }
  )

  ipcMain.handle(
    IPC_CHANNELS['logueDevice.openBackup'],
    async (event): Promise<OpenedDeviceBackup | null> => {
      const root = backupsRoot()
      const win = BrowserWindow.fromWebContents(event.sender)
      // A backup is a `backup-*.<device>.zip` now; older ones were plain folders of the same files,
      // and stay restorable.
      const opts = {
        title: 'Choose a device backup (.zip, or an older backup folder)',
        defaultPath: existsSync(root) ? root : undefined,
        properties: ['openFile' as const, 'openDirectory' as const],
        filters: [{ name: 'Device backups', extensions: ['zip'] }]
      }
      const picked = win
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts)
      if (picked.canceled || picked.filePaths.length === 0) return null
      const source = picked.filePaths[0]
      if (statSync(source).isFile()) {
        if (!source.endsWith('.zip')) throw new Error(`Not a backup zip: ${source}`)
        return { folder: source, ...(await readBackupZip(new Uint8Array(readFileSync(source)))) }
      }
      const indexPath = join(source, 'index.json')
      if (!existsSync(indexPath)) {
        throw new Error(`No index.json in ${source} -- not a device backup.`)
      }
      const bodies: Record<string, Uint8Array> = {}
      for (const name of readdirSync(source)) {
        // An xd backup's restore input is `<unit>.body.bin`; an NTS-1 mkII's is the unit file itself.
        if (name.endsWith('.body.bin') || name.endsWith('.nts1mkiiunit')) {
          bodies[name] = new Uint8Array(readFileSync(join(source, name)))
        }
      }
      return { folder: source, indexJson: readFileSync(indexPath, 'utf-8'), bodies }
    }
  )
}

function backupsRoot(): string {
  return join(resolveBuildOutputFolder(appHomeDir()), 'backups')
}

/** One plain path segment -- the renderer names files, but never gets to point outside the backup folder. */
function safeSegment(name: string): string {
  const seg = basename(name)
  if (seg !== name || seg === '' || seg === '.' || seg === '..')
    throw new Error(`Bad backup file name: ${name}`)
  return seg
}

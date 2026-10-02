/**
 * Device backup/restore file format (TS port of `logue-codegen/harness/sysex-emu/
 * backup_from_dump.py`, which produced and verified the first real backup). A real minilogue xd
 * stores a unit's upload body verbatim and hands it back byte-identically on download, so:
 *   - `<module>-<NN>-<name>.body.bin` IS the restore input: uploaded as-is, nothing reconstructed.
 *   - `<module>-<NN>-<name>.<ext>` is a convenience unit package (Korg Librarian/logue-cli), written
 *     ONLY when re-encoding its reconstructed manifest+payload reproduces the body exactly, so it can
 *     never silently differ from what was on the device.
 *   - `index.json` records every slot, including empty ones, and each check's result.
 */
import { crc32 } from './crc32'
import type { LoguePlatform } from '../primitives'
import {
  LOGUE_UNIT_MODULE_IDS,
  unitHeaderStatus,
  type LogueUnitModule,
  type SlotStatus
} from './korgUserUnitMessages'
import { buildOldGenUnitBody, OLD_GEN_PLATFORM_IDS } from './minilogueXdUnitBody'
import { readZipEntries, type OldGenUnitManifest } from './unitArchive'

export const BACKUP_FORMAT = 'logue-patcher-device-backup/1'

const UNIT_EXTENSIONS: Record<string, string> = {
  prologue: '.prlgunit',
  'minilogue-xd': '.mnlgxdunit',
  'nutekt-digital': '.ntkdigunit'
}
const PARAM_UNITS: Record<number, string> = { 0: '%', 1: '%', 2: '' }
const MODULE_BY_ID = new Map(
  Object.entries(LOGUE_UNIT_MODULE_IDS).map(([m, id]) => [id, m as LogueUnitModule])
)
const PLATFORM_BY_ID = new Map(Object.entries(OLD_GEN_PLATFORM_IDS).map(([p, id]) => [id, p]))

export interface BackupSlotEntry {
  module: LogueUnitModule
  slot: number
  empty: boolean
  name?: string
  platform?: string
  size?: number
  body?: string
  unitFile?: string | null
  note?: string
}

export interface BackupIndex {
  format: typeof BACKUP_FORMAT
  device: string
  createdAt: string
  slots: BackupSlotEntry[]
}

export interface BackupFile {
  name: string
  bytes: Uint8Array
}

const u32 = (b: Uint8Array, o: number): number =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
const semver = (v: number): string => `${v >>> 16}.${(v >>> 8) & 0xff}-${v & 0xff}`
const cstr = (b: Uint8Array): string => {
  const nul = b.indexOf(0)
  return String.fromCharCode(...(nul < 0 ? b : b.subarray(0, nul)))
}

/** Reads a stored body's own 1024-byte header back into the manifest it was built from. */
export function describeStoredBody(body: Uint8Array): {
  module?: LogueUnitModule
  platform?: string
  manifest?: OldGenUnitManifest
  payload: Uint8Array
} {
  const module = MODULE_BY_ID.get(body[0])
  const platform = PLATFORM_BY_ID.get(body[1])
  const payloadLength = u32(body, 1020)
  const payload = body.subarray(1024, 1024 + payloadLength)
  if (!module || !platform) return { module, platform, payload }
  const numParam = u32(body, 0x20)
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const params: [string, number, number, string][] = []
  for (let i = 0; i < numParam && i < 6; i++) {
    const o = 0x24 + i * 16
    params.push([
      cstr(body.subarray(o + 3, o + 16)),
      view.getInt8(o),
      view.getInt8(o + 1),
      PARAM_UNITS[body[o + 2]] ?? '?'
    ])
  }
  const manifest: OldGenUnitManifest = {
    header: {
      platform,
      module,
      api: semver(u32(body, 2)),
      dev_id: u32(body, 6),
      prg_id: u32(body, 10),
      version: semver(u32(body, 14)),
      name: cstr(body.subarray(0x12, 0x20)),
      num_param: numParam,
      params
    }
  }
  return { module, platform, manifest, payload }
}

export interface DownloadedSlot {
  module: LogueUnitModule
  slot: number
  /** Undefined for an empty slot. */
  body?: Uint8Array
}

/**
 * An NTS-1 mkII unit's header, read from its ELF's `.unit_header` section (the same bytes the device
 * reports as slot status). Undefined if the file isn't a well-formed ELF with that section.
 */
export function readNts1mkiiUnitHeader(elf: Uint8Array): SlotStatus | undefined {
  if (elf.length < 52 || elf[0] !== 0x7f || elf[1] !== 0x45 || elf[2] !== 0x4c || elf[3] !== 0x46) {
    return undefined
  }
  const v = new DataView(elf.buffer, elf.byteOffset, elf.byteLength)
  const shoff = v.getUint32(0x20, true)
  const shentsize = v.getUint16(0x2e, true)
  const shnum = v.getUint16(0x30, true)
  const shstrndx = v.getUint16(0x32, true)
  if (shoff + shnum * shentsize > elf.length || shstrndx >= shnum) return undefined
  const section = (i: number): { name: number; offset: number; size: number } => ({
    name: v.getUint32(shoff + i * shentsize, true),
    offset: v.getUint32(shoff + i * shentsize + 16, true),
    size: v.getUint32(shoff + i * shentsize + 20, true)
  })
  const strtab = section(shstrndx).offset
  for (let i = 0; i < shnum; i++) {
    const s = section(i)
    const end = elf.indexOf(0, strtab + s.name)
    if (String.fromCharCode(...elf.subarray(strtab + s.name, end)) !== '.unit_header') continue
    if (s.size < 44 || s.offset + s.size > elf.length) return undefined
    return unitHeaderStatus(elf.subarray(s.offset, s.offset + s.size))
  }
  return undefined
}

export function planBackup(
  device: string,
  slots: DownloadedSlot[],
  createdAt: Date,
  devicePlatform: LoguePlatform = 'minilogue-xd'
): { files: BackupFile[]; index: BackupIndex } {
  const files: BackupFile[] = []
  const entries: BackupSlotEntry[] = slots.map(({ module, slot, body }) => {
    if (!body) return { module, slot, empty: true }
    if (devicePlatform === 'nts1mkii') {
      // The stored body IS the .nts1mkiiunit file (verified byte-identical on a real device), so
      // there's nothing to reconstruct: one file is both the unit and the restore input.
      const name = readNts1mkiiUnitHeader(body)?.name ?? ''
      const safe = name.replace(/[^A-Za-z0-9_-]/g, '_') || 'unnamed'
      const file = `${module}-${String(slot + 1).padStart(2, '0')}-${safe}.nts1mkiiunit`
      files.push({ name: file, bytes: body })
      return {
        module,
        slot,
        empty: false,
        name,
        platform: devicePlatform,
        size: body.length,
        body: file,
        unitFile: file
      }
    }
    const { platform, manifest, payload } = describeStoredBody(body)
    const name = manifest?.header.name ?? ''
    const safe = name.replace(/[^A-Za-z0-9_-]/g, '_') || 'unnamed'
    const stem = `${module}-${String(slot + 1).padStart(2, '0')}-${safe}`
    files.push({ name: `${stem}.body.bin`, bytes: body })
    const entry: BackupSlotEntry = {
      module,
      slot,
      empty: false,
      name,
      platform,
      size: body.length,
      body: `${stem}.body.bin`,
      unitFile: null
    }
    let rebuilt: Uint8Array | undefined
    try {
      rebuilt = manifest ? buildOldGenUnitBody(manifest, payload) : undefined
    } catch {
      rebuilt = undefined
    }
    if (manifest && platform && rebuilt && equalBytes(rebuilt, body)) {
      const unitFile = `${stem}${UNIT_EXTENSIONS[platform]}`
      files.push({ name: unitFile, bytes: unitPackage(module, manifest, payload) })
      entry.unitFile = unitFile
    } else {
      entry.note = "Header didn't re-encode to the exact stored body; restore from the .body.bin."
    }
    return entry
  })
  const index: BackupIndex = {
    format: BACKUP_FORMAT,
    device,
    createdAt: createdAt.toISOString(),
    slots: entries
  }
  files.push({
    name: 'index.json',
    bytes: new TextEncoder().encode(JSON.stringify(index, null, 2) + '\n')
  })
  return { files, index }
}

/** `backup-YYYYMMDD-HHMMSS.<platform>.zip`, local time -- the device kind sits right before `.zip`. */
export function backupZipName(platform: LoguePlatform, at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp =
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-` +
    `${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  return `backup-${stamp}.${platform}.zip`
}

/** One backup as a single archive: `planBackup`'s files, flat, store-only. */
export function backupZip(files: BackupFile[]): Uint8Array {
  return zipStored(files)
}

/**
 * The restore side of `backupZip`: its index plus every restore input it names. Older backups
 * were plain folders with the same files; `main/ipc/logueDevice.ts` reads those itself.
 */
export async function readBackupZip(
  zip: Uint8Array
): Promise<{ indexJson: string; bodies: Record<string, Uint8Array> }> {
  const entries = await readZipEntries(zip)
  const index = entries.get('index.json')
  if (!index) throw new Error('This zip has no index.json -- not a device backup.')
  const bodies: Record<string, Uint8Array> = {}
  for (const [name, bytes] of entries) {
    if (name.endsWith('.body.bin') || name.endsWith('.nts1mkiiunit')) bodies[name] = bytes
  }
  return { indexJson: new TextDecoder().decode(index), bodies }
}

export function parseBackupIndex(json: string): BackupIndex {
  const index = JSON.parse(json) as BackupIndex
  if (index.format !== BACKUP_FORMAT || !Array.isArray(index.slots)) {
    throw new Error("This folder's index.json isn't a logue-patcher device backup.")
  }
  return index
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function unitPackage(
  module: LogueUnitModule,
  manifest: OldGenUnitManifest,
  payload: Uint8Array
): Uint8Array {
  return zipStored([
    {
      name: `${module}/manifest.json`,
      bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 4) + '\n')
    },
    { name: `${module}/payload.bin`, bytes: payload }
  ])
}

/**
 * Minimal store-only (uncompressed) zip writer: a unit package is two small files, and every zip
 * reader -- including `unitArchive.ts`'s own and logue-cli's -- accepts method 0.
 */
export function zipStored(entries: BackupFile[]): Uint8Array {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const name = enc.encode(e.name)
    const crc = crc32(e.bytes)
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, e.bytes.length, true)
    lv.setUint32(22, e.bytes.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    const cd = new Uint8Array(46 + name.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, e.bytes.length, true)
    cv.setUint32(24, e.bytes.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    cd.set(name, 46)
    chunks.push(local, e.bytes)
    central.push(cd)
    offset += local.length + e.bytes.length
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  const all = [...chunks, ...central, eocd]
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0))
  let p = 0
  for (const c of all) {
    out.set(c, p)
    p += c.length
  }
  return out
}

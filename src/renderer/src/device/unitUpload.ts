import { readOldGenUnitArchive } from '@logue-codegen/sysex/unitArchive'
import { buildMinilogueXdUnitBody } from '@logue-codegen/sysex/minilogueXdUnitBody'
import { readNts1mkiiUnitHeader } from '@logue-codegen/sysex/unitBackup'
import { LOGUE_UNIT_MODULE_IDS } from '@logue-codegen/sysex/korgUserUnitMessages'
import type { LogueUnitModule } from '@logue-codegen/sysex/korgUserUnitMessages'
import { LogueDeviceSession } from '@logue-codegen/sysex/deviceSession'
import type { BuildResultEntry, UploadTarget } from '../state/buildResultsStore'
import { DEVICE_LABEL, NAME_MAX, holdsUnit } from './slotChoice'
import { findLogueDevices, linkFor, type FoundDevice } from './midiLink'

export interface PreparedUnit {
  module: LogueUnitModule
  name: string
  body: Uint8Array
  /** logue-cli (and so presumably the device) silently cuts a longer name to 13 characters. */
  truncatedName?: string
}

async function prepareXd(bytes: Uint8Array): Promise<PreparedUnit> {
  const archive = await readOldGenUnitArchive(bytes)
  const name = archive.manifest.header.name
  return {
    module: archive.module,
    name,
    body: buildMinilogueXdUnitBody(archive.manifest, archive.payload),
    truncatedName: name.length > NAME_MAX ? name.slice(0, NAME_MAX) : undefined
  }
}

/**
 * The NTS-1 mkII stores and receives the `.nts1mkiiunit` ELF verbatim (captured from Kontrol
 * Editor), so the file IS the upload body; its own `.unit_header` says which module it's for.
 */
function prepareNts1mkii(bytes: Uint8Array): PreparedUnit {
  const h = readNts1mkiiUnitHeader(bytes)
  if (!h) throw new Error('not an NTS-1 mkII unit (no ELF .unit_header).')
  const platformId = (h.target >> 8) & 0x7f
  if (platformId !== 5) throw new Error(`built for platform ${platformId}, not the NTS-1 mkII (5).`)
  const module = (Object.keys(LOGUE_UNIT_MODULE_IDS) as LogueUnitModule[]).find(
    (m) => LOGUE_UNIT_MODULE_IDS[m] === (h.target & 0xff)
  )
  if (!module) throw new Error(`unknown module id ${h.target & 0xff}.`)
  return { module, name: h.name, body: bytes }
}

export async function prepareUnit(entry: BuildResultEntry): Promise<PreparedUnit> {
  const bytes = await window.axoloti.logueDevice.readUnitFile(entry.path)
  return entry.platform === 'nts1mkii' ? prepareNts1mkii(bytes) : prepareXd(bytes)
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export type QuickUploadResult =
  | { kind: 'uploaded'; slot: number; device: string }
  /** Nothing to go on without asking: the dialog takes over, `reason` says why. */
  | { kind: 'ask'; reason: string }

/**
 * Build & Upload's dialog-free path. Uploads only where the answer is unambiguous: the slot this
 * unit was last uploaded to (re-read first: it must still hold this unit or be empty), else the
 * one slot already holding a unit of this name. Anything else -- no device, two candidates, a
 * slot taken over by another unit -- is handed to the dialog rather than guessed.
 */
export async function quickUpload(
  entry: BuildResultEntry,
  remembered: UploadTarget | undefined,
  onProgress: (message: string) => void
): Promise<QuickUploadResult & { module?: LogueUnitModule }> {
  const unit = await prepareUnit(entry)
  onProgress(`Looking for a ${DEVICE_LABEL[entry.platform]}…`)
  const found = (await findLogueDevices()).filter((d) => d.platform === entry.platform)
  if (found.length === 0) return { kind: 'ask', reason: 'no device answered' }
  const device: FoundDevice = found.find((d) => d.outputName === remembered?.device) ?? found[0]
  const session = new LogueDeviceSession(
    linkFor(device.inputId, device.outputId),
    entry.platform,
    device.channel
  )
  await session.apiVersion()
  const info = await session.moduleInfo(unit.module)
  if (unit.body.length > info.maxPayloadSize) {
    return { kind: 'ask', reason: 'the unit is larger than the device accepts' }
  }

  let slot: number | undefined
  if (remembered?.module === unit.module && remembered.slot < info.slotCount) {
    onProgress(`Checking slot ${remembered.slot + 1}…`)
    const st = await session.slotStatus(unit.module, remembered.slot)
    if (!st.empty && !holdsUnit(st, unit.name)) {
      return {
        kind: 'ask',
        reason: `slot ${remembered.slot + 1} now holds "${st.name || '(unnamed)'}"`
      }
    }
    slot = remembered.slot
  } else {
    const matches: number[] = []
    for (let i = 0; i < info.slotCount; i++) {
      onProgress(`Reading slots ${i + 1}/${info.slotCount}…`)
      if (holdsUnit(await session.slotStatus(unit.module, i), unit.name)) matches.push(i)
    }
    if (matches.length !== 1) {
      return {
        kind: 'ask',
        reason: matches.length === 0 ? 'first upload of this unit' : 'several slots hold this name'
      }
    }
    slot = matches[0]
  }

  onProgress(`Uploading to slot ${slot + 1}…`)
  await session.upload(unit.module, slot, unit.body)
  return { kind: 'uploaded', slot, device: device.outputName, module: unit.module }
}

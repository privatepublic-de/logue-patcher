import type { SlotStatus } from '@logue-codegen/sysex/korgUserUnitMessages'
import type { LoguePlatform } from '@shared/domain/patch'
import type { UploadTarget } from '../state/buildResultsStore'

// Which slot an upload goes to -- pure, so it's testable without the MIDI layer (`unitUpload.ts`).

export const NAME_MAX = 13

export const DEVICE_LABEL: Record<LoguePlatform, string> = {
  'minilogue-xd': 'minilogue xd',
  nts1mkii: 'NTS-1 mkII'
}

/** The name a slot holding this unit reports. */
export const nameOnDevice = (name: string): string => name.slice(0, NAME_MAX)

/** Whether `slot` already holds this unit (by the name the device shows), so replacing it is a
 *  re-upload rather than an overwrite. */
export const holdsUnit = (slot: SlotStatus | undefined, unitName: string): boolean =>
  slot !== undefined && !slot.empty && slot.name === nameOnDevice(unitName)

/**
 * The slot an upload starts on: where this unit went last time (still holding it, or emptied
 * since), else a slot already holding a unit of this name, else the first empty one -- so a
 * rebuild goes back where it came from instead of into the next free slot.
 */
export function initialSlot(
  slots: SlotStatus[],
  unitName: string,
  remembered?: UploadTarget
): number {
  if (remembered && remembered.slot < slots.length) {
    const st = slots[remembered.slot]
    if (st.empty || holdsUnit(st, unitName)) return remembered.slot
  }
  const byName = slots.findIndex((st) => holdsUnit(st, unitName))
  if (byName >= 0) return byName
  const firstEmpty = slots.findIndex((st) => st.empty)
  return firstEmpty >= 0 ? firstEmpty : 0
}

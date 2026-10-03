import { describe, expect, it } from 'vitest'
import type { SlotStatus } from '@logue-codegen/sysex/korgUserUnitMessages'
import { holdsUnit, initialSlot } from '../src/renderer/src/device/slotChoice'
import {
  groupResultsByPath,
  type BuildResultEntry,
  type UploadTarget
} from '../src/renderer/src/state/buildResultsStore'

function slot(name?: string): SlotStatus {
  return {
    empty: name === undefined,
    target: 0,
    api: { major: 0, minor: 0, patch: 0 },
    devId: 0,
    programId: 0,
    version: { major: 0, minor: 0, patch: 0 },
    name: name ?? ''
  } as SlotStatus
}

const remembered = (s: number): UploadTarget => ({ device: 'x', module: 'modfx', slot: s, at: 0 })

describe('initialSlot (where an upload starts)', () => {
  const slots = [slot('Chorus'), slot(), slot('Radio'), slot()]

  it('goes back to the slot this unit was uploaded to', () => {
    expect(initialSlot(slots, 'Radio', remembered(2))).toBe(2)
    // ... also once that slot was emptied on the device
    expect(initialSlot(slots, 'Radio', remembered(3))).toBe(3)
  })

  it("doesn't go back to a remembered slot another unit took over", () => {
    expect(initialSlot(slots, 'Radio', remembered(0))).toBe(2)
  })

  it('else finds a slot holding this name, else the first empty one', () => {
    expect(initialSlot(slots, 'Radio')).toBe(2)
    expect(initialSlot(slots, 'Flanger')).toBe(1)
    expect(initialSlot([slot('A'), slot('B')], 'Flanger')).toBe(0)
  })

  it('matches a long name as the device shows it (13 characters)', () => {
    expect(holdsUnit(slot('BadRadioRecep'), 'BadRadioReception')).toBe(true)
    expect(initialSlot([slot(), slot('BadRadioRecep')], 'BadRadioReception')).toBe(1)
  })
})

describe('groupResultsByPath (one result row per unit file)', () => {
  const entry = (id: string, path: string): BuildResultEntry => ({
    id,
    kind: 'build',
    platform: 'nts1mkii',
    unitName: path,
    path,
    createdAt: 0
  })

  it('keeps the newest of each path, in newest-first order, with a count', () => {
    // The store keeps newest first.
    const groups = groupResultsByPath([
      entry('3', 'Radio.nts1mkiiunit'),
      entry('2', 'Chorus.nts1mkiiunit'),
      entry('1', 'Radio.nts1mkiiunit')
    ])
    expect(groups.map((g) => [g.latest.id, g.count])).toEqual([
      ['3', 2],
      ['2', 1]
    ])
  })
})

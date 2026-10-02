import { describe, it, expect } from 'vitest'
import { findUnitKind, UNIT_KINDS } from '../logue-codegen/src/unitKinds'
import { generateOscUnit } from '../logue-codegen/src/nts1mkii/generateOscUnit'
import { generateOldGenOscUnit } from '../logue-codegen/src/minilogue-xd/generateOscUnit'
import { estimateOscCpuCost } from '../logue-codegen/src/estimateOscCpuCost'
import { LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import type { LogueModule, PatchDocument } from '../src/shared/domain/patch'

function sineDoc(module?: LogueModule): PatchDocument {
  return {
    nodes: [
      { kind: 'obj', type: 'logue/osc/sine', name: 's', x: 0, y: 0, params: [] },
      { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
    ],
    nets: [{ sources: [{ obj: 's', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
    settings: module ? { logueTarget: { module } } : {},
    notes: ''
  }
}

describe('unitKinds', () => {
  it('has exactly one entry per (platform, module)', () => {
    const keys = UNIT_KINDS.map((k) => `${k.platform}:${k.module}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('keeps every reserved slot inside the param limit, on a knob the kind has', () => {
    for (const kind of UNIT_KINDS) {
      for (const slot of kind.reservedSlots) {
        expect(slot.index).toBeLessThan(kind.maxParams)
        expect(kind.knobs).toContain(slot.knob)
      }
    }
  })

  it('has effect entries on both platforms', () => {
    for (const module of ['modfx', 'delfx', 'revfx'] as const) {
      expect(findUnitKind('nts1mkii', module)).toBeDefined()
      expect(findUnitKind('minilogue-xd', module)).toBeDefined()
    }
  })

  it("gives the xd's effects only their panel knobs: no menu params, Shift+Depth off modfx", () => {
    for (const module of ['modfx', 'delfx', 'revfx'] as const) {
      const kind = findUnitKind('minilogue-xd', module)!
      expect(kind.maxParams).toBe(0)
      expect(kind.reservedSlots).toEqual([])
      expect(kind.knobs).toEqual(module === 'modfx' ? ['time', 'depth'] : ['time', 'depth', 'mix'])
    }
    expect(findUnitKind('minilogue-xd', 'modfx')).toMatchObject({
      ramBytes: 6 * 1024,
      sdramBytes: 128 * 1024
    })
    expect(findUnitKind('minilogue-xd', 'revfx')).toMatchObject({
      ramBytes: 12 * 1024,
      sdramBytes: 2432 * 1024
    })
  })

  it('gives delay/reverb the MIX row Korg ships, and modfx none', () => {
    const mix = findUnitKind('nts1mkii', 'delfx')!.reservedSlots[2]
    expect(mix).toMatchObject({ index: 2, knob: 'mix', name: 'MIX' })
    expect(mix.device).toMatchObject({
      min: -1000,
      max: 1000,
      type: 'drywet',
      frac: 1,
      fracMode: 1
    })
    expect(findUnitKind('nts1mkii', 'modfx')!.reservedSlots.map((s) => s.name)).toEqual([
      'TIME',
      'DPTH'
    ])
  })
})

describe('building a document by its module', () => {
  it('builds an explicit osc document the same as one without a target', () => {
    expect(generateOscUnit(sineDoc('osc'), { name: 't' })).toEqual(
      generateOscUnit(sineDoc(), { name: 't' })
    )
    expect(generateOldGenOscUnit(sineDoc('osc'), { name: 't' })).toEqual(
      generateOldGenOscUnit(sineDoc(), { name: 't' })
    )
  })

  it.each(['modfx', 'delfx', 'revfx'] as const)(
    'never builds a %s document as an oscillator',
    (module) => {
      expect(() => generateOscUnit(sineDoc(module), { name: 't' })).toThrow(
        /effect patch -- it builds with generateFxUnit/
      )
      expect(() => generateOldGenOscUnit(sineDoc(module), { name: 't' })).toThrow(
        /effect patch -- it builds with generateOldGenFxUnit/
      )
      expect(estimateOscCpuCost(sineDoc(module), new Map(), 'minilogue-xd').status).toBe(
        'incomplete'
      )
    }
  )
})

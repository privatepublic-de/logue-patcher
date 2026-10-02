import { describe, it, expect } from 'vitest'
import { normalizeRenamedFields } from '../logue-codegen/src/renamedFields'
import { generateOscUnit } from '../logue-codegen/src/nts1mkii/generateOscUnit'
import { generateOldGenOscUnit } from '../logue-codegen/src/minilogue-xd/generateOscUnit'
import { listUnboundDeviceControls } from '../logue-codegen/src/deviceControls'
import { formerPrimitiveIds } from '../logue-codegen/src/primitives'
import { LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import {
  LOGUE_SUBPATCH_OUTLET_TYPE,
  type SubpatchDefinitions
} from '../logue-codegen/src/subpatches'
import { listInsertablePrimitives } from '../src/renderer/src/browser/loguePrimitiveCatalog'
import type { Net, ObjNode, PatchDocument } from '../src/shared/domain/patch'
import type { ParamValue } from '../src/shared/domain/paramValueTypes'

const CONTROL = 'logue/sense/control'

function node(type: string, name: string, params: ParamValue[] = []): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params }
}
function net(from: string, outlet: string, to: string, inlet: string): Net {
  return { sources: [{ obj: from, outlet }], dests: [{ obj: to, inlet }] }
}

/** saw -> vca `a` -> out, with `ctl` (of `type`) into the VCA's gain. */
function gainFrom(type: string, params: ParamValue[] = [], outlet = 'unipolar'): PatchDocument {
  return {
    nodes: [
      node('logue/osc/saw', 's'),
      node(type, 'ctl', params),
      node('logue/gain/vca', 'a'),
      node(LOGUE_AUDIO_OUT_TYPE, 'out')
    ],
    nets: [
      net('s', 'out', 'a', 'in'),
      net('ctl', outlet, 'a', 'gain'),
      net('a', 'out', 'out', 'in')
    ],
    settings: {},
    notes: ''
  }
}

const ctlOf = (d: PatchDocument): ObjNode => d.nodes[1] as ObjNode

describe('migrating the superseded sense primitives', () => {
  it('turns a Shape reader into a control bound to Shape on both platforms, wires kept', () => {
    const before = gainFrom('logue/sense/shape', [], 'bipolar')
    const after = normalizeRenamedFields(before)
    expect(ctlOf(after)).toMatchObject({
      type: CONTROL,
      params: [
        { name: 'VALUE', value: '0', logueKnob: { 'minilogue-xd': 'shape', nts1mkii: 'shape' } }
      ]
    })
    expect(after.nets).toEqual(before.nets)
  })

  it('follows an old id through its rename first (shift-shape -> shape-2 -> control)', () => {
    const after = normalizeRenamedFields(gainFrom('logue/sense/shift-shape'))
    expect(ctlOf(after).params[0].logueKnob).toEqual({
      'minilogue-xd': 'shape-2',
      nts1mkii: 'shape-2'
    })
  })

  it('turns the xd filter readers into unbound controls (the knobs never reach a unit)', () => {
    for (const old of ['logue/sense/cutoff', 'logue/sense/resonance']) {
      const ctl = ctlOf(normalizeRenamedFields(gainFrom(old)))
      expect(ctl.type).toBe(CONTROL)
      expect(ctl.params.some((p) => p.logueKnob)).toBe(false)
    }
  })

  it("keeps a menu param's value, label and slot", () => {
    const value: ParamValue = {
      name: 'VALUE',
      value: '70',
      label: 'Depth',
      logueParamIndex: { 'minilogue-xd': 2 }
    }
    const after = normalizeRenamedFields(gainFrom('logue/sense/param', [value]))
    expect(ctlOf(after)).toMatchObject({ type: CONTROL, params: [value] })
  })

  it('leaves pitch, gate and velocity alone', () => {
    for (const type of ['logue/sense/pitch', 'logue/sense/gate', 'logue/sense/velocity']) {
      const before = gainFrom(type, [], type === 'logue/sense/gate' ? 'out' : 'unipolar')
      expect(normalizeRenamedFields(before)).toBe(before)
    }
  })

  it('reads the same knob after migration, on both platforms', () => {
    const migrated = normalizeRenamedFields(gainFrom('logue/sense/shape'))
    const xd = generateOldGenOscUnit(migrated, { name: 'T' }).oscCpp
    const nts = generateOscUnit(migrated, { name: 'T' }).oscH
    for (const src of [xd, nts]) {
      expect(src).toContain('sense_ctl = (0.f + shape01_ * 100.f) * 0.01f;')
      expect(src).toContain('float y_ctl_unipolar = sense_ctl;')
    }
    // The old node still builds unchanged in a document that was never re-opened.
    expect(generateOldGenOscUnit(gainFrom('logue/sense/shape'), { name: 'T' }).oscCpp).toContain(
      'float y_ctl_unipolar = shape01_;'
    )
  })
})

describe('logue/sense/control', () => {
  it('is a menu param on NTS-1 mkII too (sense/param was xd-only)', () => {
    const unit = generateOscUnit(
      gainFrom(CONTROL, [
        { name: 'VALUE', value: '30', label: 'Amt', logueParamIndex: { nts1mkii: 2 } }
      ]),
      { name: 'T' }
    )
    expect(unit.headerC).toContain('{0, 100, 0, 30, k_unit_param_type_none, 0, 0, 0, {"Amt"}}')
    expect(unit.oscH).toContain('case 2: sense_ctl = value * 0.01f; break;')
  })

  it('needs no label on a knob', () => {
    const d = gainFrom(CONTROL, [
      { name: 'VALUE', value: '30', logueKnob: { nts1mkii: 'shape-2' } }
    ])
    expect(() => generateOscUnit(d, { name: 'T' })).not.toThrow()
  })

  it('builds unassigned as its constant VALUE, and is listed as unbound for that platform', () => {
    const d = gainFrom(CONTROL, [
      { name: 'VALUE', value: '30', logueKnob: { 'minilogue-xd': 'cutoff' } }
    ])
    expect(generateOscUnit(d, { name: 'T' }).oscH).toContain('sense_ctl = 30 * 0.01f;')
    expect(listUnboundDeviceControls(d, new Map(), 'nts1mkii')).toEqual([
      { nodeName: 'ctl', value: 30 }
    ])
    expect(listUnboundDeviceControls(d, new Map(), 'minilogue-xd')).toEqual([])
  })

  it("isn't listed as unbound when it never reaches the output, or the graph can't build", () => {
    const d = gainFrom(CONTROL)
    d.nets = d.nets.filter((n) => n.sources[0].obj !== 'ctl')
    expect(listUnboundDeviceControls(d, new Map(), 'nts1mkii')).toEqual([])
    d.nets = []
    expect(listUnboundDeviceControls(d, new Map(), 'nts1mkii')).toEqual([])
  })
})

describe('knob bindings inside a subpatch definition', () => {
  const def: PatchDocument = {
    nodes: [
      node(CONTROL, 'k', [
        {
          name: 'VALUE',
          value: '0',
          logueKnob: { nts1mkii: 'shape' },
          logueParamIndex: { nts1mkii: 3 }
        }
      ]),
      node(LOGUE_SUBPATCH_OUTLET_TYPE, 'out')
    ],
    nets: [net('k', 'unipolar', 'out', 'in')],
    settings: { subpatch: true },
    notes: ''
  }
  const defs: SubpatchDefinitions = new Map([['sub/knob', def]])

  it('keeps a knob binding (shared hardware) but drops a menu slot (one owner per unit)', () => {
    const root = gainFrom('sub/knob', [], 'out')
    const unit = generateOscUnit(root, { name: 'T' }, defs)
    expect(unit.oscH).toContain('sense_ctl_k = (0.f + shape01_ * 100.f) * 0.01f;')
    expect(unit.headerC).toContain('.num_params = 2,')
    expect(unit.oscH).not.toMatch(/case 3:/)
  })
})

describe('palette', () => {
  const ids = listInsertablePrimitives().map((e) => e.id)

  it('offers the control, not the superseded readers', () => {
    expect(ids).toContain(CONTROL)
    for (const old of ['shape', 'shape-2', 'cutoff', 'resonance', 'param']) {
      expect(ids).not.toContain(`logue/sense/${old}`)
    }
    expect(ids).toContain('logue/sense/pitch')
  })

  it('still finds it by the old names', () => {
    expect(formerPrimitiveIds(CONTROL)).toEqual(
      expect.arrayContaining(['logue/sense/shape', 'logue/sense/shape-2', 'logue/sense/param'])
    )
  })
})

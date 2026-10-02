import { describe, it, expect } from 'vitest'
import { generateOscUnit } from '../logue-codegen/src/nts1mkii/generateOscUnit'
import { generateOldGenOscUnit } from '../logue-codegen/src/minilogue-xd/generateOscUnit'
import { InvalidLogueParamError } from '../logue-codegen/src/oscParams'
import { estimateOscCpuCost } from '../logue-codegen/src/estimateOscCpuCost'
import { LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import {
  LOGUE_SUBPATCH_INLET_TYPE,
  LOGUE_SUBPATCH_OUTLET_TYPE,
  type SubpatchDefinitions
} from '../logue-codegen/src/subpatches'
import { parsePatchFile, serializePatchFile } from '../src/shared/json/patchCodec'
import type { Net, ObjNode, PatchDocument } from '../src/shared/domain/patch'
import type { ParamValue } from '../src/shared/domain/paramValueTypes'

function node(type: string, name: string, params: ParamValue[] = [], y = 0): ObjNode {
  return { kind: 'obj', type, name, x: 0, y, params }
}
function net(from: string, outlet: string, to: string, inlet: string): Net {
  return { sources: [{ obj: from, outlet }], dests: [{ obj: to, inlet }] }
}
function doc(nodes: ObjNode[], nets: Net[]): PatchDocument {
  return { nodes: [...nodes, node(LOGUE_AUDIO_OUT_TYPE, 'out')], nets, settings: {}, notes: '' }
}

/** saw -> vca `a` -> out, with the given params on the VCA. */
function sawVca(
  vcaParams: ParamValue[],
  extra: ObjNode[] = [],
  extraNets: Net[] = []
): PatchDocument {
  return doc(
    [node('logue/osc/saw', 's'), node('logue/gain/vca', 'a', vcaParams), ...extra],
    [net('s', 'out', 'a', 'in'), net('a', 'out', 'out', 'in'), ...extraNets]
  )
}

const xd = (d: PatchDocument, defs?: SubpatchDefinitions): string =>
  generateOldGenOscUnit(d, { name: 'T' }, defs).oscCpp
const nts = (d: PatchDocument, defs?: SubpatchDefinitions): ReturnType<typeof generateOscUnit> =>
  generateOscUnit(d, { name: 'T' }, defs)

/** The generated `process()` from its signature up to the sample loop. */
function blockPrologue(src: string): string {
  const start = src.indexOf('void process(')
  return src.slice(start, src.indexOf('for (uint32_t i = 0', start))
}
function initBody(src: string): string {
  const start = src.search(/void init\((float \*)?\)/)
  return src.slice(start, src.indexOf('\n  }\n', start))
}

describe('fixed-knob bindings', () => {
  const gainOnShape: ParamValue = {
    name: 'GAIN',
    value: '25',
    logueKnob: { 'minilogue-xd': 'shape', nts1mkii: 'shape' }
  }

  it('sets a bound param from the knob before every block, over its whole range (xd)', () => {
    const src = xd(sawVca([gainOnShape]))
    expect(blockPrologue(src)).toContain('gain_a = (0.f + shape01_ * 100.f) * 0.04f;')
    // Starts where the patch was authored: GAIN 25 of 0..100.
    expect(initBody(src)).toContain('shapeParam01_ = 0.25f;')
    expect(initBody(src)).toContain('shape01_ = 0.25f;')
    // No menu row: the xd's Shape knob isn't one of its 6 params.
    expect(
      JSON.parse(generateOldGenOscUnit(sawVca([gainOnShape]), { name: 'T' }).manifestJson).header
        .num_param
    ).toBe(0)
  })

  it('sets a bound param from the knob on NTS-1 mkII, and starts the knob row there', () => {
    const unit = nts(sawVca([gainOnShape]))
    expect(blockPrologue(unit.oscH)).toContain('gain_a = (0.f + shape01_ * 100.f) * 0.04f;')
    expect(initBody(unit.oscH)).toContain('shapeParam01_ = 0.25f;')
    expect(unit.headerC).toContain('{0, 1023, 0, 256, k_unit_param_type_none, 0, 0, 0, {"SHPE"}}')
    expect(unit.headerC).toContain('{0, 1023, 0, 0, k_unit_param_type_none, 0, 0, 0, {"ALT"}}')
  })

  it('runs before the block constants that read the param', () => {
    const d = doc(
      [
        node('logue/osc/saw', 's'),
        node('logue/filter/svf', 'f', [
          { name: 'CUTOFF', value: '50', logueKnob: { 'minilogue-xd': 'shape-2' } }
        ])
      ],
      [net('s', 'out', 'f', 'in'), net('f', 'lp', 'out', 'in')]
    )
    const prologue = blockPrologue(xd(d))
    const knob = prologue.indexOf('shape2_01_ * 100.f')
    expect(knob).toBeGreaterThan(-1)
    const firstConstant = prologue.indexOf('const float blk')
    if (firstConstant !== -1) expect(knob).toBeLessThan(firstConstant)
    expect(initBody(xd(d))).toContain('shape2_01_ = 0.5f;')
  })

  it('splits a select into equal zones and a checkbox at half travel', () => {
    const d = doc(
      [
        node('logue/osc/saw', 's'),
        node('logue/env/multistage', 'm', [
          { name: 'MODE', value: '2', logueKnob: { 'minilogue-xd': 'shape' } }
        ]),
        node('logue/filter/svf', 'f', [
          { name: 'TRACK', value: '100', logueKnob: { 'minilogue-xd': 'shape-2' } }
        ]),
        node('logue/gain/vca', 'a')
      ],
      [
        net('s', 'out', 'f', 'in'),
        net('f', 'lp', 'a', 'in'),
        net('m', 'env', 'a', 'gain'),
        net('a', 'out', 'out', 'in')
      ]
    )
    const src = xd(d)
    expect(blockPrologue(src)).toContain(
      '{ int32_t k = (int32_t)(shape01_ * 4.f); if (k > 3) k = 3; mode_m = ((float)k * 1.f); }'
    )
    expect(blockPrologue(src)).toMatch(/= \(shape2_01_ >= 0\.5f \? 100\.f : 0\.f\)/)
    // MODE 2 of 4 sits in the middle of the third zone; TRACK on in the upper half.
    expect(initBody(src)).toContain('shapeParam01_ = 0.625f;')
    expect(initBody(src)).toContain('shape2_01_ = 0.75f;')
  })

  it('rounds a stepped param to its step', () => {
    const d = doc(
      [
        node('logue/osc/sine', 'o', [
          { name: 'COARSE', value: '0', logueKnob: { nts1mkii: 'shape' } }
        ])
      ],
      [net('o', 'out', 'out', 'in')]
    )
    expect(blockPrologue(nts(d).oscH)).toContain(
      'coarse_o = (-24.f + (float)(int32_t)(shape01_ * 48.f + 0.5f) * 1.f);'
    )
  })

  it('lets several params follow one knob; the first one sets where the knob starts', () => {
    const d = sawVca(
      [gainOnShape],
      [
        node('logue/filter/lowpass-cheap', 'lp', [
          { name: 'CUTOFF', value: '80', logueKnob: { 'minilogue-xd': 'shape' } }
        ])
      ]
    )
    d.nets = [
      net('s', 'out', 'lp', 'in'),
      net('lp', 'out', 'a', 'in'),
      net('a', 'out', 'out', 'in')
    ]
    const src = xd(d)
    expect(blockPrologue(src)).toContain('cutoff_lp = (0.f + shape01_ * 100.f) * 0.01f;')
    expect(blockPrologue(src)).toContain('gain_a = (0.f + shape01_ * 100.f) * 0.04f;')
    expect(initBody(src)).toContain('shapeParam01_ = 0.8f;')
  })

  it("refuses the filter knobs on either platform: the xd's never reach an oscillator", () => {
    const onCutoff = (platform: 'minilogue-xd' | 'nts1mkii'): PatchDocument =>
      sawVca([{ name: 'GAIN', value: '25', logueKnob: { [platform]: 'cutoff' } }])
    expect(() => xd(onCutoff('minilogue-xd'))).toThrow(InvalidLogueParamError)
    expect(() => nts(onCutoff('nts1mkii'))).toThrow(InvalidLogueParamError)
  })

  it('only applies on the platform it was bound for', () => {
    const d = sawVca([{ name: 'GAIN', value: '25', logueKnob: { nts1mkii: 'shape' } }])
    expect(blockPrologue(xd(d))).not.toContain('shape01_')
    expect(initBody(xd(d))).not.toContain('shapeParam01_ = 0.25f')
  })

  it('rejects a param with two device controls on one platform', () => {
    const both = sawVca([
      {
        name: 'GAIN',
        value: '25',
        logueKnob: { nts1mkii: 'shape' },
        logueParamIndex: { nts1mkii: 2 }
      }
    ])
    expect(() => nts(both)).toThrow(/only one device control/)
    const slotAndFollow = sawVca([
      { name: 'GAIN', value: '25', logueParamIndex: { nts1mkii: 2 }, logueFollow: { nts1mkii: 3 } }
    ])
    expect(() => nts(slotAndFollow)).toThrow(/only one device control/)
  })

  it('rejects a knob binding on a node that never reaches the output', () => {
    const d = sawVca(
      [],
      [
        node('logue/filter/lowpass-cheap', 'lp', [
          { name: 'CUTOFF', value: '80', logueKnob: { nts1mkii: 'shape' } }
        ])
      ]
    )
    expect(() => nts(d)).toThrow(/shape knob binding/)
  })

  it('leaves an unbound patch byte-identical', () => {
    const plain = sawVca([{ name: 'GAIN', value: '25' }])
    const src = xd(plain)
    expect(src).not.toContain('shape01_ *')
    expect(initBody(src)).not.toMatch(/shapeParam01_ = 0\.[1-9]/)
  })
})

describe('menu-slot followers', () => {
  /** A bipolar constant owns slot 0 and feeds the VCA gain; the VCA's GAIN follows it too. */
  function leadAndFollower(platform: 'minilogue-xd' | 'nts1mkii', slot: number): PatchDocument {
    return sawVca(
      [{ name: 'GAIN', value: '25', logueFollow: { [platform]: slot } }],
      [
        node('logue/util/constant', 'c', [
          { name: 'VALUE', value: '0', logueParamIndex: { [platform]: slot } }
        ]),
        node('logue/filter/lowpass-cheap', 'lp')
      ],
      []
    )
  }

  it("sets a follower from the lead's device position, inside the lead's case (xd)", () => {
    const d = leadAndFollower('minilogue-xd', 0)
    d.nets = [
      net('s', 'out', 'lp', 'in'),
      net('c', 'out', 'lp', 'cutoff'),
      net('lp', 'out', 'a', 'in'),
      net('a', 'out', 'out', 'in')
    ]
    const src = xd(d)
    // The xd's OSC_PARAM has already shifted a bipolar value to -100..100.
    expect(src).toMatch(
      /case 0: .*\{ const float p = \(float\)\(value \+ 100\) \* \(1\.f \/ 200\.f\); gain_a = \(0\.f \+ p \* 100\.f\) \* 0\.04f; \} break;/
    )
    const manifest = JSON.parse(generateOldGenOscUnit(d, { name: 'T' }).manifestJson)
    expect(manifest.header.num_param).toBe(1)
  })

  it('works the same on NTS-1 mkII', () => {
    const d = leadAndFollower('nts1mkii', 2)
    d.nets = [
      net('s', 'out', 'lp', 'in'),
      net('c', 'out', 'lp', 'cutoff'),
      net('lp', 'out', 'a', 'in'),
      net('a', 'out', 'out', 'in')
    ]
    expect(nts(d).oscH).toMatch(
      /case 2: .*const float p = \(float\)\(value \+ 100\) \* \(1\.f \/ 200\.f\);/
    )
  })

  it('rejects a follower of a slot nobody owns, and points NTS-1 mkII slots 0/1 at the knob', () => {
    expect(() =>
      nts(sawVca([{ name: 'GAIN', value: '25', logueFollow: { nts1mkii: 4 } }]))
    ).toThrow(/no param is exposed at that slot/)
    expect(() =>
      nts(sawVca([{ name: 'GAIN', value: '25', logueFollow: { nts1mkii: 0 } }]))
    ).toThrow(/fixed shape knob -- bind it to that knob/)
  })
})

describe('bindings through a subpatch', () => {
  const def: PatchDocument = {
    nodes: [
      node(LOGUE_SUBPATCH_INLET_TYPE, 'in'),
      node('logue/filter/lowpass-cheap', 'lp', [
        // A definition never owns a device control; this one must be dropped.
        {
          name: 'CUTOFF',
          value: '40',
          subpatchExpose: { outerName: 'Cutoff' },
          logueKnob: { nts1mkii: 'shape-2' }
        }
      ]),
      node(LOGUE_SUBPATCH_OUTLET_TYPE, 'out')
    ],
    nets: [net('in', 'out', 'lp', 'in'), net('lp', 'out', 'out', 'in')],
    settings: { subpatch: true },
    notes: ''
  }
  const defs: SubpatchDefinitions = new Map([['sub/filt', def]])

  it("carries the instance's knob binding onto the promoted leaf param", () => {
    const root = doc(
      [
        node('logue/osc/saw', 's'),
        node('sub/filt', 'f1', [{ name: 'Cutoff', value: '40', logueKnob: { nts1mkii: 'shape' } }])
      ],
      [net('s', 'out', 'f1', 'in'), net('f1', 'out', 'out', 'in')]
    )
    const prologue = blockPrologue(nts(root, defs).oscH)
    expect(prologue).toContain('cutoff_f1_lp = (0.f + shape01_ * 100.f) * 0.01f;')
    expect(prologue).not.toContain('shape2_01_')
  })
})

describe('CPU estimate', () => {
  it('counts a knob-bound checkbox as reachable in either position', () => {
    const trackOn = (params: ParamValue[]): PatchDocument =>
      doc(
        [node('logue/osc/saw', 's'), node('logue/filter/svf', 'f', params)],
        [net('s', 'out', 'f', 'in'), net('f', 'lp', 'out', 'in')]
      )
    const fixed = estimateOscCpuCost(trackOn([{ name: 'TRACK', value: '0' }]))
    const bound = estimateOscCpuCost(
      trackOn([{ name: 'TRACK', value: '0', logueKnob: { 'minilogue-xd': 'shape' } }])
    )
    expect(fixed.status === 'ok' && bound.status === 'ok').toBe(true)
    if (fixed.status !== 'ok' || bound.status !== 'ok') return
    expect(bound.estimate.cyclesPerVoice).toBe(fixed.estimate.cyclesPerVoice)
    expect(bound.estimate.maxCyclesPerVoice).toBeGreaterThan(fixed.estimate.maxCyclesPerVoice)
  })
})

describe('.loguepatch codec', () => {
  it('round-trips knob and follower bindings', () => {
    const d = sawVca([
      {
        name: 'GAIN',
        value: '25',
        logueKnob: { 'minilogue-xd': 'shift-shape' as never, nts1mkii: 'shape' },
        logueFollow: { 'minilogue-xd': 1 }
      }
    ])
    expect(() => parsePatchFile(serializePatchFile(d))).toThrow(/logueKnob/)
    const gain = d.nodes[1] as ObjNode
    gain.params[0].logueKnob = { 'minilogue-xd': 'resonance', nts1mkii: 'shape-2' }
    const back = parsePatchFile(serializePatchFile(d)).nodes[1] as ObjNode
    expect(back.params[0].logueKnob).toEqual({ 'minilogue-xd': 'resonance', nts1mkii: 'shape-2' })
    expect(back.params[0].logueFollow).toEqual({ 'minilogue-xd': 1 })
  })
})

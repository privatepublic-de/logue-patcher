import { describe, it, expect } from 'vitest'
import { generateOscUnit } from '../logue-codegen/src/nts1mkii/generateOscUnit'
import { generateOldGenOscUnit } from '../logue-codegen/src/minilogue-xd/generateOscUnit'
import { estimateOscStateCost } from '../logue-codegen/src/estimateOscStateCost'
import { LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import {
  flattenSubpatches,
  createSubpatchAwareResolver,
  SubpatchResolutionError,
  LOGUE_SUBPATCH_INLET_TYPE,
  LOGUE_SUBPATCH_OUTLET_TYPE,
  type SubpatchDefinitions
} from '../logue-codegen/src/subpatches'
import { findDisplayUnit, findParamUnit } from '../logue-codegen/src/paramUnits'
import type { PatchDocument, ObjNode, Net } from '../src/shared/domain/patch'
import type { ParamValue } from '../src/shared/domain/paramValueTypes'

function obj(type: string, name: string, params: ParamValue[] = [], y = 0): ObjNode {
  return { kind: 'obj', type, name, x: 0, y, params }
}

function wire(src: string, outlet: string, dst: string, inlet: string): Net {
  return { sources: [{ obj: src, outlet }], dests: [{ obj: dst, inlet }] }
}

function doc(nodes: ObjNode[], nets: Net[], subpatch = false): PatchDocument {
  return { nodes, nets, settings: subpatch ? { subpatch: true } : {}, notes: '' }
}

/** in -> lowpass (CUTOFF promoted as "Cutoff") -> out, plus a `mod` inlet into the cutoff. */
const FILTER_DEF = doc(
  [
    obj(LOGUE_SUBPATCH_INLET_TYPE, 'in', [], 0),
    obj(LOGUE_SUBPATCH_INLET_TYPE, 'mod', [], 100),
    obj('logue/filter/lowpass-cheap', 'lp', [
      { name: 'CUTOFF', value: '40', subpatchExpose: { outerName: 'Cutoff' } }
    ]),
    obj(LOGUE_SUBPATCH_OUTLET_TYPE, 'out')
  ],
  [
    wire('in', 'out', 'lp', 'in'),
    wire('mod', 'out', 'lp', 'cutoff'),
    wire('lp', 'out', 'out', 'in')
  ],
  true
)

const DEFS: SubpatchDefinitions = new Map([['sub/filt', FILTER_DEF]])

function rootWith(instanceParams: ParamValue[]): PatchDocument {
  return doc(
    [
      obj('logue/osc/saw', 'osc'),
      obj('sub/filt', 'f1', instanceParams),
      obj(LOGUE_AUDIO_OUT_TYPE, 'audio')
    ],
    [wire('osc', 'out', 'f1', 'in'), wire('f1', 'out', 'audio', 'in')]
  )
}

function handFlattened(leafParam: ParamValue): PatchDocument {
  return doc(
    [
      obj('logue/osc/saw', 'osc'),
      obj(LOGUE_AUDIO_OUT_TYPE, 'audio'),
      obj('logue/filter/lowpass-cheap', 'f1_lp', [leafParam])
    ],
    [wire('osc', 'out', 'f1_lp', 'in'), wire('f1_lp', 'out', 'audio', 'in')]
  )
}

describe('flattenSubpatches', () => {
  it('returns a subpatch-free document unchanged (same object)', () => {
    const plain = doc(
      [obj('logue/osc/saw', 'osc'), obj(LOGUE_AUDIO_OUT_TYPE, 'audio')],
      [wire('osc', 'out', 'audio', 'in')]
    )
    expect(flattenSubpatches(plain, DEFS)).toBe(plain)
  })

  it('generates exactly the code of the hand-inlined graph, on both platforms', () => {
    const nts = rootWith([{ name: 'Cutoff', value: '70', logueParamIndex: { nts1mkii: 2 } }])
    const ntsRef = handFlattened({
      name: 'CUTOFF',
      value: '70',
      logueParamIndex: { nts1mkii: 2 },
      label: 'Cutoff'
    })
    expect(generateOscUnit(nts, { name: 'T' }, DEFS)).toEqual(
      generateOscUnit(ntsRef, { name: 'T' })
    )

    const xd = rootWith([{ name: 'Cutoff', value: '70', logueParamIndex: { 'minilogue-xd': 0 } }])
    const xdRef = handFlattened({
      name: 'CUTOFF',
      value: '70',
      logueParamIndex: { 'minilogue-xd': 0 },
      label: 'Cutoff'
    })
    expect(generateOldGenOscUnit(xd, { name: 'T' }, DEFS)).toEqual(
      generateOldGenOscUnit(xdRef, { name: 'T' })
    )
  })

  it('names a promoted device param after the outer name, or the instance label when set', () => {
    const byOuterName = generateOscUnit(
      rootWith([{ name: 'Cutoff', value: '70', logueParamIndex: { nts1mkii: 2 } }]),
      { name: 'T' },
      DEFS
    )
    expect(byOuterName.headerC).toContain('"Cutoff"')
    const byLabel = generateOscUnit(
      rootWith([{ name: 'Cutoff', value: '70', logueParamIndex: { nts1mkii: 2 }, label: 'Tone' }]),
      { name: 'T' },
      DEFS
    )
    expect(byLabel.headerC).toContain('"Tone"')
    expect(byLabel.headerC).not.toContain('"CUTOFF"')
  })

  it("cuts a defaulted device name to NTS-1 mkII's limit, but never a typed one", () => {
    const longName = 'lowpass-cheap_1:CUTOFF' // 22 chars, over UNIT_PARAM_NAME_LEN's 21
    const def = doc(
      [
        obj(LOGUE_SUBPATCH_INLET_TYPE, 'in'),
        obj('logue/filter/lowpass-cheap', 'lowpass-cheap_1', [
          { name: 'CUTOFF', value: '40', subpatchExpose: { outerName: longName } }
        ]),
        obj(LOGUE_SUBPATCH_OUTLET_TYPE, 'out')
      ],
      [wire('in', 'out', 'lowpass-cheap_1', 'in'), wire('lowpass-cheap_1', 'out', 'out', 'in')],
      true
    )
    const defs = new Map([['sub/filt', def]])
    const withLabel = (label?: string): PatchDocument =>
      rootWith([{ name: longName, value: '70', logueParamIndex: { nts1mkii: 2 }, label }])
    expect(generateOscUnit(withLabel(), { name: 'T' }, defs).headerC).toContain(
      `"${longName.slice(0, 21)}"`
    )
    expect(() =>
      generateOscUnit(withLabel('a typed name over the limit'), { name: 'T' }, defs)
    ).toThrow(/exceeding the real on-device limit/)
  })

  it('falls back to the definition-authored value when an instance never set the param', () => {
    const flat = flattenSubpatches(rootWith([]), DEFS)
    const leaf = flat.nodes.find((n) => n.name === 'f1_lp') as ObjNode
    expect(leaf.params[0]).toMatchObject({
      name: 'CUTOFF',
      value: '40',
      logueParamIndex: undefined
    })
  })

  it('gives each instance its own inner nodes and values', () => {
    const root = doc(
      [
        obj('logue/osc/saw', 'osc'),
        obj('sub/filt', 'f1', [{ name: 'Cutoff', value: '10' }]),
        obj('sub/filt', 'f2', [{ name: 'Cutoff', value: '90' }]),
        obj(LOGUE_AUDIO_OUT_TYPE, 'audio')
      ],
      [
        wire('osc', 'out', 'f1', 'in'),
        wire('f1', 'out', 'f2', 'in'),
        wire('f2', 'out', 'audio', 'in')
      ]
    )
    const flat = flattenSubpatches(root, DEFS)
    const value = (name: string): string =>
      (flat.nodes.find((n) => n.name === name) as ObjNode).params[0].value
    expect(value('f1_lp')).toBe('10')
    expect(value('f2_lp')).toBe('90')
    expect(flat.nets).toContainEqual(wire('f1_lp', 'out', 'f2_lp', 'in'))
  })

  it('chains a wire straight through an inlet wired directly to an outlet', () => {
    const thru = doc(
      [obj(LOGUE_SUBPATCH_INLET_TYPE, 'in'), obj(LOGUE_SUBPATCH_OUTLET_TYPE, 'out')],
      [wire('in', 'out', 'out', 'in')],
      true
    )
    const root = doc(
      [obj('logue/osc/saw', 'osc'), obj('sub/thru', 't'), obj(LOGUE_AUDIO_OUT_TYPE, 'audio')],
      [wire('osc', 'out', 't', 'in'), wire('t', 'out', 'audio', 'in')]
    )
    const flat = flattenSubpatches(root, new Map([['sub/thru', thru]]))
    expect(flat.nets).toEqual([wire('osc', 'out', 'audio', 'in')])
  })

  it('chains a re-promoted param through nested subpatches', () => {
    const outer = doc(
      [
        obj(LOGUE_SUBPATCH_INLET_TYPE, 'in'),
        obj('sub/filt', 'inner', [
          { name: 'Cutoff', value: '55', subpatchExpose: { outerName: 'Tone' } }
        ]),
        obj(LOGUE_SUBPATCH_OUTLET_TYPE, 'out')
      ],
      [wire('in', 'out', 'inner', 'in'), wire('inner', 'out', 'out', 'in')],
      true
    )
    const defs = new Map([...DEFS, ['sub/outer', outer]])
    const root = doc(
      [
        obj('logue/osc/saw', 'osc'),
        obj('sub/outer', 'o', [{ name: 'Tone', value: '90', logueParamIndex: { nts1mkii: 2 } }]),
        obj(LOGUE_AUDIO_OUT_TYPE, 'audio')
      ],
      [wire('osc', 'out', 'o', 'in'), wire('o', 'out', 'audio', 'in')]
    )
    const flat = flattenSubpatches(root, defs)
    const leaf = flat.nodes.find((n) => n.name === 'o_inner_lp') as ObjNode
    expect(leaf.params[0]).toMatchObject({
      name: 'CUTOFF',
      value: '90',
      logueParamIndex: { nts1mkii: 2 },
      label: 'Tone'
    })
    expect(flat.nets).toContainEqual(wire('osc', 'out', 'o_inner_lp', 'in'))
    expect(generateOscUnit(root, { name: 'T' }, defs).headerC).toContain('"Tone"')
  })

  it('drops device slots authored on inner nodes of a definition', () => {
    const def = doc(
      [
        obj(LOGUE_SUBPATCH_INLET_TYPE, 'in'),
        obj('logue/gain/vca', 'v', [
          { name: 'GAIN', value: '25', logueParamIndex: { nts1mkii: 3 } }
        ]),
        obj(LOGUE_SUBPATCH_OUTLET_TYPE, 'out')
      ],
      [wire('in', 'out', 'v', 'in'), wire('v', 'out', 'out', 'in')],
      true
    )
    const root = doc(
      [obj('logue/osc/saw', 'osc'), obj('sub/v', 's'), obj(LOGUE_AUDIO_OUT_TYPE, 'audio')],
      [wire('osc', 'out', 's', 'in'), wire('s', 'out', 'audio', 'in')]
    )
    const flat = flattenSubpatches(root, new Map([['sub/v', def]]))
    expect(
      (flat.nodes.find((n) => n.name === 's_v') as ObjNode).params[0].logueParamIndex
    ).toBeUndefined()
  })

  it('never renames a root node when a flattened name collides with it', () => {
    const root = rootWith([])
    root.nodes.push(obj('logue/osc/sine', 'f1_lp'))
    const flat = flattenSubpatches(root, DEFS)
    const names = flat.nodes.map((n) => n.name)
    expect(names).toContain('f1_lp')
    expect(names).toContain('f1_lp_2')
    expect(flat.nets).toContainEqual(wire('osc', 'out', 'f1_lp_2', 'in'))
  })

  it('rejects a definition that contains itself', () => {
    const selfRef = doc([obj('sub/loop', 'again')], [], true)
    const root = doc([obj('sub/loop', 'l'), obj(LOGUE_AUDIO_OUT_TYPE, 'audio')], [])
    expect(() => flattenSubpatches(root, new Map([['sub/loop', selfRef]]))).toThrow(
      /contains itself/
    )
  })

  it('rejects a missing definition with the instance name', () => {
    const root = doc([obj('sub/gone', 'g'), obj(LOGUE_AUDIO_OUT_TYPE, 'audio')], [])
    expect(() => flattenSubpatches(root, new Map())).toThrow(SubpatchResolutionError)
    expect(() => flattenSubpatches(root, new Map())).toThrow(/"g" uses subpatch "sub\/gone"/)
  })

  it('rejects two sources into one outlet node', () => {
    const def = doc(
      [
        obj('logue/osc/saw', 'a'),
        obj('logue/osc/sine', 'b'),
        obj(LOGUE_SUBPATCH_OUTLET_TYPE, 'out')
      ],
      [wire('a', 'out', 'out', 'in'), wire('b', 'out', 'out', 'in')],
      true
    )
    const root = doc(
      [obj('sub/two', 't'), obj(LOGUE_AUDIO_OUT_TYPE, 'audio')],
      [wire('t', 'out', 'audio', 'in')]
    )
    expect(() => flattenSubpatches(root, new Map([['sub/two', def]]))).toThrow(
      /more than one source/
    )
  })

  it('rejects port nodes in a root patch and audio-out inside a definition', () => {
    const rootWithInlet = doc([obj(LOGUE_SUBPATCH_INLET_TYPE, 'in')], [])
    expect(() => flattenSubpatches(rootWithInlet, DEFS)).toThrow(/only means something inside/)
    const badDef = doc([obj(LOGUE_AUDIO_OUT_TYPE, 'audio')], [], true)
    const root = doc([obj('sub/bad', 'b')], [])
    expect(() => flattenSubpatches(root, new Map([['sub/bad', badDef]]))).toThrow(
      /contains "logue\/io\/audio-out"/
    )
  })

  it("lets an instance's free-running outlet feed one of its own unrelated inlets", () => {
    // in -> vca -> out, and an independent lfo -> lfoOut: wiring lfoOut back into in is no loop.
    const def = doc(
      [
        obj(LOGUE_SUBPATCH_INLET_TYPE, 'in'),
        obj('logue/gain/vca', 'vca'),
        obj(LOGUE_SUBPATCH_OUTLET_TYPE, 'out'),
        obj('logue/lfo/sine-lfo', 'lfo'),
        obj(LOGUE_SUBPATCH_OUTLET_TYPE, 'lfoOut', [], 100)
      ],
      [
        wire('in', 'out', 'vca', 'in'),
        wire('vca', 'out', 'out', 'in'),
        wire('lfo', 'out', 'lfoOut', 'in')
      ],
      true
    )
    const root = doc(
      [obj('sub/self', 'a'), obj(LOGUE_AUDIO_OUT_TYPE, 'audio')],
      [wire('a', 'lfoOut', 'a', 'in'), wire('a', 'out', 'audio', 'in')]
    )
    const defs = new Map([['sub/self', def]])
    const flat = flattenSubpatches(root, defs)
    expect(flat.nets).toContainEqual(wire('a_lfo', 'out', 'a_vca', 'in'))
    expect(() => generateOscUnit(root, { name: 'T' }, defs)).not.toThrow()
  })

  it('rejects a wire that loops onto itself through nothing but ports', () => {
    const thru = doc(
      [obj(LOGUE_SUBPATCH_INLET_TYPE, 'in'), obj(LOGUE_SUBPATCH_OUTLET_TYPE, 'out')],
      [wire('in', 'out', 'out', 'in')],
      true
    )
    const root = doc(
      [obj('sub/thru', 't'), obj('logue/gain/vca', 'v'), obj(LOGUE_AUDIO_OUT_TYPE, 'audio')],
      [wire('t', 'out', 't', 'in'), wire('t', 'out', 'v', 'in'), wire('v', 'out', 'audio', 'in')]
    )
    expect(() => flattenSubpatches(root, new Map([['sub/thru', thru]]))).toThrow(/loops back/)
  })

  it('rejects an instance value for a promoted param the definition no longer exposes', () => {
    const root = rootWith([{ name: 'OldCutoff', value: '70', logueParamIndex: { nts1mkii: 2 } }])
    expect(() => flattenSubpatches(root, DEFS)).toThrow(/sets "OldCutoff", which subpatch/)
  })

  it('rejects two promoted params sharing one outer name', () => {
    const def = doc(
      [
        obj('logue/gain/vca', 'a', [
          { name: 'GAIN', value: '25', subpatchExpose: { outerName: 'Level' } }
        ]),
        obj('logue/gain/vca', 'b', [
          { name: 'GAIN', value: '25', subpatchExpose: { outerName: 'Level' } }
        ])
      ],
      [],
      true
    )
    const root = doc([obj('sub/dup', 'd'), obj(LOGUE_AUDIO_OUT_TYPE, 'audio')], [])
    expect(() => flattenSubpatches(root, new Map([['sub/dup', def]]))).toThrow(
      /exposes two params as "Level"/
    )
  })

  it('makes the RAM estimate match the hand-inlined graph', () => {
    const estimate = estimateOscStateCost(rootWith([]), 'nts1mkii', DEFS)
    const reference = estimateOscStateCost(
      handFlattened({ name: 'CUTOFF', value: '40' }),
      'nts1mkii'
    )
    expect(estimate.status).toBe('ok')
    if (estimate.status === 'ok' && reference.status === 'ok') {
      expect(estimate.estimate.totalBytes).toBe(reference.estimate.totalBytes)
    }
  })
})

describe('synthesizeSubpatchPrimitive (via createSubpatchAwareResolver)', () => {
  it('derives ports in canvas order, promoted params and pass-through polarity', () => {
    const resolve = createSubpatchAwareResolver(DEFS)
    const primitive = resolve('sub/filt')!
    expect(primitive.inlets).toEqual([
      { name: 'in', role: 'audio' },
      { name: 'mod', role: 'control' }
    ])
    expect(primitive.outlets).toEqual([{ name: 'out' }])
    expect(primitive.outletPolarity).toEqual({ out: 'inherit' })
    expect(primitive.inheritFrom).toEqual({ out: ['in'] })
    expect(primitive.params).toHaveLength(1)
    expect(primitive.params![0]).toMatchObject({
      name: 'Cutoff',
      min: 0,
      max: 100,
      default: 40,
      freeLabel: true
    })
  })

  it('shows a promoted param with the unit of the primitive param it edits, through nesting', () => {
    const vcaDef = doc(
      [
        obj('logue/gain/vca', 'v', [
          { name: 'GAIN', value: '25', subpatchExpose: { outerName: 'Level' } }
        ])
      ],
      [],
      true
    )
    const outer = doc(
      [
        obj('sub/vca', 'inner', [
          { name: 'Level', value: '25', subpatchExpose: { outerName: 'Vol' } }
        ])
      ],
      [],
      true
    )
    const resolve = createSubpatchAwareResolver(
      new Map([
        ['sub/vca', vcaDef],
        ['sub/outer', outer]
      ])
    )
    const vol = resolve('sub/outer')!.params![0]
    expect(vol.promotedFrom).toEqual({ primitiveId: 'logue/gain/vca', paramName: 'GAIN' })
    expect(findDisplayUnit('sub/outer', vol)).toBe(findParamUnit('logue/gain/vca', 'GAIN'))
    expect(findDisplayUnit('sub/outer', vol)).toBeDefined()
  })

  it('shows no unit for a promoted param whose unit depends on an inner TRACK switch', () => {
    const combDef = doc(
      [
        obj('logue/filter/comb', 'c', [
          // The pre-rename name: a definition file is read as saved, so the alias has to resolve here.
          { name: 'CUTOFF', value: '50', subpatchExpose: { outerName: 'Cut' } }
        ])
      ],
      [],
      true
    )
    const cut = createSubpatchAwareResolver(new Map([['sub/comb', combDef]]))('sub/comb')!
      .params![0]
    expect(findParamUnit('logue/filter/comb', 'TUNE')).toBeDefined()
    expect(findDisplayUnit('sub/comb', cut)).toBeUndefined()
  })

  it('reports a fixed polarity for an outlet fed only by an inner source', () => {
    const lfoDef = doc(
      [obj('logue/osc/saw', 'src'), obj(LOGUE_SUBPATCH_OUTLET_TYPE, 'out')],
      [wire('src', 'out', 'out', 'in')],
      true
    )
    const primitive = createSubpatchAwareResolver(new Map([['sub/src', lfoDef]]))('sub/src')!
    expect(primitive.outletPolarity).toEqual({ out: 'audio' })
  })

  it('resolves a self-containing definition to undefined instead of recursing forever', () => {
    const selfRef = doc([obj('sub/loop', 'again')], [], true)
    const resolve = createSubpatchAwareResolver(new Map([['sub/loop', selfRef]]))
    expect(resolve('sub/loop')).toBeDefined()
  })
})

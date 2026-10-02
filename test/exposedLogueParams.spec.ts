import { describe, it, expect } from 'vitest'
import {
  computeCrossPlatformExposureWarnings,
  describeExposedSlots,
  listKnobAssignments,
  listParamMatrixRows,
  slotsForOrder,
  deviceLayout
} from '../src/renderer/src/state/exposedLogueParams'
import { LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import type { PatchDocument, ObjNode } from '../src/shared/domain/patch'
import { useSubpatchLibraryStore } from '../src/renderer/src/state/subpatchLibraryStore'

/**
 * `computeCrossPlatformExposureWarnings` is the new
 * advisory scan surfacing a param exposed on one platform but not the one about to be built for,
 * which `resolveExposedParams` itself has no error for at all (an unset index for the target
 * platform is the ordinary, silent "not exposed" case). Direct unit tests since this is pure,
 * graph-resolution-adjacent logic with no UI dependency, matching this project's own
 * "fixture-based tests over hand-verification" convention.
 */

function pulseNode(
  name: string,
  logueParamIndex?: { nts1mkii?: number; 'minilogue-xd'?: number }
): ObjNode {
  return {
    kind: 'obj',
    type: 'logue/osc/pulse',
    name,
    x: 0,
    y: 0,
    params: logueParamIndex === undefined ? [] : [{ name: 'WIDTH', value: '50', logueParamIndex }]
  }
}

/** `logue/gain/vca` declares exactly ONE param (GAIN, default 25) -- used wherever a test needs
 *  a predictable, single-row-per-node primitive (`logue/osc/pulse` has four: WIDTH/COARSE/
 *  FINE/FM_DEPTH, which would make a row-count/order assertion depend on all four independently). */
function vcaNode(
  name: string,
  logueParamIndex?: { nts1mkii?: number; 'minilogue-xd'?: number }
): ObjNode {
  return {
    kind: 'obj',
    type: 'logue/gain/vca',
    name,
    x: 0,
    y: 0,
    params: logueParamIndex === undefined ? [] : [{ name: 'GAIN', value: '25', logueParamIndex }]
  }
}

function audioOutNode(): ObjNode {
  return { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
}

function docWith(nodes: ObjNode[], wireFirstToOut = true): PatchDocument {
  const out = audioOutNode()
  return {
    nodes: [...nodes, out],
    nets:
      wireFirstToOut && nodes.length > 0
        ? [
            {
              sources: [{ obj: nodes[0].name!, outlet: 'out' }],
              dests: [{ obj: 'out', inlet: 'in' }]
            }
          ]
        : [],
    settings: {},
    notes: ''
  }
}

describe('computeCrossPlatformExposureWarnings', () => {
  it('returns nothing when no param is exposed at all', () => {
    const doc = docWith([pulseNode('pulse1')])
    expect(computeCrossPlatformExposureWarnings(doc, 'nts1mkii')).toEqual([])
  })

  it('returns nothing when the param is already exposed for the target platform', () => {
    const doc = docWith([pulseNode('pulse1', { nts1mkii: 2 })])
    expect(computeCrossPlatformExposureWarnings(doc, 'nts1mkii')).toEqual([])
  })

  it('warns when a param is exposed on the OTHER platform but not the target', () => {
    const doc = docWith([pulseNode('pulse1', { 'minilogue-xd': 0 })])
    const warnings = computeCrossPlatformExposureWarnings(doc, 'nts1mkii')
    expect(warnings).toEqual([
      { nodeName: 'pulse1', displayName: 'WIDTH', otherPlatform: 'minilogue-xd' }
    ])
  })

  it('warns in the other direction too (nts1mkii-only, building for minilogue-xd)', () => {
    const doc = docWith([pulseNode('pulse1', { nts1mkii: 5 })])
    const warnings = computeCrossPlatformExposureWarnings(doc, 'minilogue-xd')
    expect(warnings).toEqual([
      { nodeName: 'pulse1', displayName: 'WIDTH', otherPlatform: 'nts1mkii' }
    ])
  })

  it('returns nothing when the param is exposed on BOTH platforms', () => {
    const doc = docWith([pulseNode('pulse1', { nts1mkii: 2, 'minilogue-xd': 0 })])
    expect(computeCrossPlatformExposureWarnings(doc, 'nts1mkii')).toEqual([])
  })

  it('ignores a param exposed on an INACTIVE (unwired) instance', () => {
    const doc = docWith([pulseNode('wired'), pulseNode('unwired', { 'minilogue-xd': 0 })], true)
    // only 'wired' is actually connected to audio-out; 'unwired' is a real, valid, inert node
    expect(computeCrossPlatformExposureWarnings(doc, 'nts1mkii')).toEqual([])
  })

  it('returns nothing (rather than throwing) when the graph itself is invalid', () => {
    // no logue/io/audio-out at all -- resolveAudioGraph itself would throw
    const doc: PatchDocument = {
      nodes: [pulseNode('pulse1', { 'minilogue-xd': 0 })],
      nets: [],
      settings: {},
      notes: ''
    }
    expect(computeCrossPlatformExposureWarnings(doc, 'nts1mkii')).toEqual([])
  })

  it('uses the authored label, not the internal spec name, for a freeLabel param', () => {
    const senseParam: ObjNode = {
      kind: 'obj',
      type: 'logue/sense/param',
      name: 'sense1',
      x: 0,
      y: 0,
      params: [
        { name: 'VALUE', value: '50', logueParamIndex: { 'minilogue-xd': 0 }, label: 'Wave Blend' }
      ]
    }
    const doc = docWith([senseParam])
    const warnings = computeCrossPlatformExposureWarnings(doc, 'nts1mkii')
    expect(warnings).toEqual([
      { nodeName: 'sense1', displayName: 'Wave Blend', otherPlatform: 'minilogue-xd' }
    ])
  })
})

describe('computeCrossPlatformExposureWarnings with knobs and followers', () => {
  it('warns for a param on a knob on the other platform only', () => {
    const osc: ObjNode = {
      ...pulseNode('p'),
      params: [{ name: 'WIDTH', value: '50', logueKnob: { 'minilogue-xd': 'shape' } }]
    }
    expect(computeCrossPlatformExposureWarnings(docWith([osc]), 'nts1mkii')).toEqual([
      { nodeName: 'p', displayName: 'WIDTH', otherPlatform: 'minilogue-xd' }
    ])
    osc.params[0].logueFollow = { nts1mkii: 2 }
    expect(computeCrossPlatformExposureWarnings(docWith([osc]), 'nts1mkii')).toEqual([])
  })

  it('leaves a device control to its own unassigned warning', () => {
    const ctl: ObjNode = {
      kind: 'obj',
      type: 'logue/sense/control',
      name: 'c',
      x: 0,
      y: 0,
      params: [{ name: 'VALUE', value: '0', logueKnob: { 'minilogue-xd': 'shape' } }]
    }
    const doc = docWith([ctl])
    doc.nets[0].sources[0].outlet = 'unipolar'
    expect(computeCrossPlatformExposureWarnings(doc, 'nts1mkii')).toEqual([])
  })
})

describe('listParamMatrixRows', () => {
  it('includes a row for every param of every placed primitive, not just exposed ones', () => {
    const doc = docWith([vcaNode('vca1')])
    const rows = listParamMatrixRows(doc)
    expect(rows).toEqual([
      {
        nodeId: 'vca1',
        nodeName: 'vca1',
        paramName: 'GAIN',
        displayName: 'GAIN',
        freeLabel: false,
        requiresLabel: false,
        platforms: undefined,
        currentValue: '25',
        currentLabel: undefined,
        currentSlot: undefined
      }
    ])
  })

  it('includes a row for an INACTIVE (unwired) node too -- the matrix is a configuration tool, not a build-time view', () => {
    const doc = docWith([vcaNode('wired'), vcaNode('unwired')], true)
    const rows = listParamMatrixRows(doc)
    expect(rows.map((r) => r.nodeId).sort()).toEqual(['unwired', 'wired'])
  })

  it('sorts exposed-on-either-platform rows first, then alphabetically within each group', () => {
    const doc = docWith([
      vcaNode('zzz-exposed', { nts1mkii: 3 }),
      vcaNode('aaa-unexposed'),
      vcaNode('bbb-exposed', { 'minilogue-xd': 1 })
    ])
    const rows = listParamMatrixRows(doc)
    expect(rows.map((r) => r.nodeId)).toEqual(['bbb-exposed', 'zzz-exposed', 'aaa-unexposed'])
  })

  it('carries the current slot map, value, and label through for an already-configured param', () => {
    const senseParam: ObjNode = {
      kind: 'obj',
      type: 'logue/sense/param',
      name: 'sense1',
      x: 0,
      y: 0,
      params: [
        {
          name: 'VALUE',
          value: '75',
          logueParamIndex: { nts1mkii: 4, 'minilogue-xd': 2 },
          label: 'Wave Blend'
        }
      ]
    }
    const doc = docWith([senseParam])
    const rows = listParamMatrixRows(doc)
    expect(rows).toEqual([
      {
        nodeId: 'sense1',
        nodeName: 'sense1',
        paramName: 'VALUE',
        displayName: 'Wave Blend',
        freeLabel: true,
        requiresLabel: true,
        platforms: ['minilogue-xd'],
        currentValue: '75',
        currentLabel: 'Wave Blend',
        currentSlot: { nts1mkii: 4, 'minilogue-xd': 2 }
      }
    ])
  })
})

describe('slotsForOrder', () => {
  it('starts at Param 1 on minilogue-xd and stops at its 6 slots', () => {
    expect(slotsForOrder('minilogue-xd', 'osc', 3)).toEqual([0, 1, 2])
    expect(slotsForOrder('minilogue-xd', 'osc', 9)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it("steps over an effect's TIME/DEPTH (and MIX) rows", () => {
    expect(slotsForOrder('nts1mkii', 'modfx', 2)).toEqual([2, 3])
    expect(slotsForOrder('nts1mkii', 'delfx', 2)).toEqual([3, 4])
    expect(slotsForOrder('nts1mkii', 'delfx', 20)).toHaveLength(8)
  })

  it('has no menu slots on an xd effect, only its knobs, and every knob in a definition', () => {
    expect(deviceLayout('minilogue-xd', 'delfx')).toMatchObject({
      buildable: true,
      maxSlots: 0,
      knobs: ['time', 'depth', 'mix']
    })
    expect(deviceLayout('minilogue-xd', 'delfx').reserved.size).toBe(0)
    expect(slotsForOrder('minilogue-xd', 'modfx', 3)).toEqual([])
    expect(deviceLayout('minilogue-xd', undefined).knobs).toEqual([
      'shape',
      'shape-2',
      'time',
      'depth',
      'mix'
    ])
    expect(deviceLayout('nts1mkii', undefined).knobs).toEqual([
      'shape',
      'shape-2',
      'time',
      'depth',
      'mix'
    ])
  })

  it("steps over nts1mkii's reserved Shape/Alt-Shape pair", () => {
    expect(slotsForOrder('nts1mkii', 'osc', 2)).toEqual([2, 3])
    expect(slotsForOrder('nts1mkii', 'osc', 20)).toEqual([2, 3, 4, 5, 6, 7, 8, 9])
  })
})

// The shared phrasing ParamDial.tsx's tooltip and
// Inspector.tsx's matrix-button tooltip both now use, once there's no single "currently viewed
// platform" left to describe a slot map with instead.
describe('describeExposedSlots', () => {
  it('describes a slot exposed on both platforms, comma-joined', () => {
    expect(describeExposedSlots({ logueParamIndex: { nts1mkii: 2, 'minilogue-xd': 0 } })).toBe(
      'Param 3 on NTS-1 mkII, Param 1 on minilogue xd'
    )
  })

  it('describes a slot exposed on only one platform', () => {
    expect(describeExposedSlots({ logueParamIndex: { 'minilogue-xd': 4 } })).toBe(
      'Param 5 on minilogue xd'
    )
  })

  it('describes a knob and a follower in the same phrasing', () => {
    expect(
      describeExposedSlots({
        logueKnob: { 'minilogue-xd': 'shape-2' },
        logueFollow: { nts1mkii: 3 }
      })
    ).toBe('follows Param 4 on NTS-1 mkII, SHIFT+SHAPE knob on minilogue xd')
  })

  it('returns an empty string for an unexposed (undefined) slot', () => {
    expect(describeExposedSlots(undefined)).toBe('')
  })

  it('returns an empty string for an exposed-nowhere (empty) slot map', () => {
    expect(describeExposedSlots({ logueParamIndex: {} })).toBe('')
  })
})

describe('listKnobAssignments', () => {
  const obj = (name: string, type: string, params: ObjNode['params'] = []): ObjNode => ({
    kind: 'obj',
    type,
    name,
    x: 0,
    y: 0,
    params
  })

  it("lists each knob's bound params on the platform, with a control's wires", () => {
    const doc: PatchDocument = {
      nodes: [
        obj('c1', 'logue/sense/control', [
          { name: 'VALUE', value: '0', logueKnob: { 'minilogue-xd': 'shape', nts1mkii: 'shape-2' } }
        ]),
        obj('osc', 'logue/osc/pulse', [
          { name: 'WIDTH', value: '50', logueKnob: { 'minilogue-xd': 'shape' } }
        ]),
        obj('lp', 'logue/filter/lowpass-cheap', [
          { name: 'CUTOFF', value: '50', logueKnob: { 'minilogue-xd': 'cutoff' } }
        ])
      ],
      nets: [
        {
          sources: [{ obj: 'c1', outlet: 'bipolar' }],
          dests: [{ obj: 'lp', inlet: 'cutoff' }]
        }
      ],
      settings: {},
      notes: ''
    }
    const xd = listKnobAssignments(doc, 'minilogue-xd')
    expect(xd.shape).toEqual([
      { nodeId: 'c1', nodeName: 'c1', paramName: 'VALUE', wiredTo: ['lp · cutoff'] },
      { nodeId: 'osc', nodeName: 'osc', paramName: 'WIDTH', wiredTo: undefined }
    ])
    expect(xd.cutoff.map((a) => a.nodeName)).toEqual(['lp'])
    const nts = listKnobAssignments(doc, 'nts1mkii')
    expect(nts.shape).toEqual([])
    expect(nts['shape-2'].map((a) => a.nodeName)).toEqual(['c1'])
  })

  it('still lists a superseded reader (by its old id too) as a legacy entry', () => {
    const doc = {
      nodes: [obj('s2', 'logue/sense/shift-shape')],
      nets: [{ sources: [{ obj: 's2', outlet: 'unipolar' }], dests: [{ obj: 'x', inlet: 'in' }] }],
      settings: {},
      notes: ''
    } as unknown as PatchDocument
    expect(listKnobAssignments(doc, 'nts1mkii')['shape-2']).toEqual([
      { nodeId: 's2', nodeName: 's2', paramName: undefined, legacy: true, wiredTo: ['x · in'] }
    ])
  })

  it('lists a subpatch instance whose definition binds a knob at any depth', () => {
    const inner = {
      nodes: [
        obj('k', 'logue/sense/control', [
          { name: 'VALUE', value: '0', logueKnob: { nts1mkii: 'shape-2' } }
        ]),
        obj('old', 'logue/sense/shape')
      ],
      nets: [],
      settings: { subpatch: true },
      notes: ''
    } as unknown as PatchDocument
    const outer = {
      nodes: [obj('nested', 'sub/inner')],
      nets: [],
      settings: { subpatch: true },
      notes: ''
    } as unknown as PatchDocument
    useSubpatchLibraryStore.getState().setEntries([
      { type: 'sub/inner', filePath: '/lib/inner.loguesub', source: 'library', doc: inner },
      { type: 'sub/outer', filePath: '/lib/outer.loguesub', source: 'library', doc: outer }
    ])
    try {
      const doc = {
        nodes: [obj('f1', 'sub/outer')],
        nets: [],
        settings: {},
        notes: ''
      } as unknown as PatchDocument
      const nts = listKnobAssignments(doc, 'nts1mkii')
      expect(nts['shape-2']).toEqual([{ nodeId: 'f1', nodeName: 'f1', insideSubpatch: true }])
      expect(nts.shape).toEqual([{ nodeId: 'f1', nodeName: 'f1', insideSubpatch: true }])
      expect(listKnobAssignments(doc, 'minilogue-xd')['shape-2']).toEqual([])
    } finally {
      useSubpatchLibraryStore.getState().setEntries([])
    }
  })

  it("skips a definition's promoted param (each instance binds that one)", () => {
    const def: PatchDocument = {
      nodes: [
        obj('k', 'logue/sense/control', [
          {
            name: 'VALUE',
            value: '0',
            logueKnob: { nts1mkii: 'shape' },
            subpatchExpose: { outerName: 'k:VALUE' }
          }
        ])
      ],
      nets: [],
      settings: { subpatch: true },
      notes: ''
    }
    expect(listKnobAssignments(def, 'nts1mkii').shape).toEqual([])
  })
})

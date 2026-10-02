import { describe, it, expect } from 'vitest'
import { estimateOscStateCost } from '../logue-codegen/src/estimateOscStateCost'
import { findLoguePrimitive } from '../logue-codegen/src/primitives'
import { LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import type { Net, PatchDocument, ObjNode } from '../src/shared/domain/patch'
import { CODE_SIZE_TABLE } from '../logue-codegen/src/codeSizeTable'
import { findUnitKind, requireUnitKind } from '../logue-codegen/src/unitKinds'

const XD_OSC = requireUnitKind('minilogue-xd', 'osc')
const NTS1MKII_OSC = requireUnitKind('nts1mkii', 'osc')

/**
 * `estimateOscStateCost` is the exact/state-only half of the deferred size-estimator request
 * (see the `project_cost_estimator_deferred` memory) -- these pin the two things most worth
 * regression-testing: that an unreachable node costs zero (the same guarantee
 * `resolveAudioGraph` already makes for codegen itself), and that `logue/filter/comb`'s real
 * 2KB buffer is the dominant, budget-relevant term.
 */

function sine(name: string): ObjNode {
  return { kind: 'obj', type: 'logue/osc/sine', name, x: 0, y: 0, params: [] }
}

function audioOut(name = 'out'): ObjNode {
  return { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name, x: 0, y: 0, params: [] }
}

describe('estimateOscStateCost', () => {
  it('logue/io/audio-out itself never appears in perInstance -- it has no LoguePrimitive registry entry at all (resolvePrimitiveInstances skips it), so estimateOscStateCost must never call findLoguePrimitive on it', () => {
    expect(findLoguePrimitive(LOGUE_AUDIO_OUT_TYPE)).toBeUndefined()
    const doc: PatchDocument = {
      nodes: [sine('a'), audioOut('out')],
      nets: [{ sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
      settings: {},
      notes: ''
    }
    const result = estimateOscStateCost(doc, 'nts1mkii')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.estimate.perInstance.some((i) => i.primitiveId === LOGUE_AUDIO_OUT_TYPE)).toBe(
      false
    )
  })

  it('sums stateBytesPerInstance over only the output-reachable instances, in bytes', () => {
    const doc: PatchDocument = {
      nodes: [sine('a'), audioOut('out')],
      nets: [{ sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
      settings: {},
      notes: ''
    }
    const result = estimateOscStateCost(doc, 'nts1mkii')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.estimate.perInstance).toEqual([
      {
        nodeName: 'a',
        primitiveId: 'logue/osc/sine',
        bytes: findLoguePrimitive('logue/osc/sine')!.stateBytesPerInstance
      }
    ])
    expect(result.estimate.baselineBytes).toBe(NTS1MKII_OSC.fixedBaselineBytes)
    expect(result.estimate.stateBytes).toBe(NTS1MKII_OSC.fixedBaselineBytes + 16)
  })

  it('an unreachable node costs zero -- matches resolveAudioGraph\'s own "no codegen at all" guarantee', () => {
    const doc: PatchDocument = {
      nodes: [sine('reachable'), sine('unreachable'), audioOut('out')],
      nets: [
        { sources: [{ obj: 'reachable', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    }
    const result = estimateOscStateCost(doc, 'nts1mkii')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.estimate.perInstance).toHaveLength(1)
    expect(result.estimate.perInstance[0].nodeName).toBe('reachable')
    expect(result.estimate.stateBytes).toBe(NTS1MKII_OSC.fixedBaselineBytes + 16)
  })

  it("logue/filter/comb's buf_[512] dominates the estimate, matching its real memberDecls output", () => {
    const doc: PatchDocument = {
      nodes: [
        { kind: 'obj', type: 'logue/filter/comb', name: 'c', x: 0, y: 0, params: [] },
        audioOut('out')
      ],
      nets: [{ sources: [{ obj: 'c', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
      settings: {},
      notes: ''
    }
    const result = estimateOscStateCost(doc, 'minilogue-xd')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    // buf_[512] (2048 bytes) + 10 scalar members (40 bytes) + the platform's fixed baseline.
    expect(result.estimate.stateBytes).toBe(XD_OSC.fixedBaselineBytes + 2088)
  })

  it("a graph with a single stateless, helper-less primitive (logue/math/multiply) still has the platform's fixed baseline as its real floor, not zero", () => {
    const doc: PatchDocument = {
      nodes: [
        { kind: 'obj', type: 'logue/math/multiply', name: 'r', x: 0, y: 0, params: [] },
        audioOut('out')
      ],
      nets: [{ sources: [{ obj: 'r', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
      settings: {},
      notes: ''
    }
    const nts1 = estimateOscStateCost(doc, 'nts1mkii')
    expect(nts1.status).toBe('ok')
    if (nts1.status === 'ok') {
      expect(nts1.estimate.perInstance).toEqual([
        { nodeName: 'r', primitiveId: 'logue/math/multiply', bytes: 0 }
      ])
      expect(nts1.estimate.sharedHelpers).toEqual([])
      expect(nts1.estimate.stateBytes).toBe(NTS1MKII_OSC.fixedBaselineBytes)
    }
    const mlxd = estimateOscStateCost(doc, 'minilogue-xd')
    expect(mlxd.status).toBe('ok')
    if (mlxd.status === 'ok') {
      expect(mlxd.estimate.stateBytes).toBe(XD_OSC.fixedBaselineBytes)
    }
  })

  it('reports the real embedded SRAM budget on minilogue xd', () => {
    const doc: PatchDocument = {
      nodes: [sine('a'), audioOut('out')],
      nets: [{ sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
      settings: {},
      notes: ''
    }
    const result = estimateOscStateCost(doc, 'minilogue-xd')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.estimate.budgetBytes).toBe(XD_OSC.ramBytes)
  })

  it('reports the real published "Max RAM Load Size" budget on NTS-1 mkII -- platform/nts-1_mkii/README.md\'s own Supported Modules table, not an embedded linker-script constant (this platform has none)', () => {
    const doc: PatchDocument = {
      nodes: [sine('a'), audioOut('out')],
      nets: [{ sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
      settings: {},
      notes: ''
    }
    const result = estimateOscStateCost(doc, 'nts1mkii')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.estimate.budgetBytes).toBe(NTS1MKII_OSC.ramBytes)
    expect(result.estimate.budgetBytes).toBe(48 * 1024)
  })

  it('reports "incomplete" (not a thrown error) for a graph resolveAudioGraph itself rejects', () => {
    const doc: PatchDocument = {
      nodes: [sine('a')],
      nets: [],
      settings: {},
      notes: ''
    }
    const result = estimateOscStateCost(doc, 'nts1mkii')
    expect(result.status).toBe('incomplete')
    if (result.status !== 'incomplete') return
    expect(result.reason).toMatch(/no ".*audio-out" node/)
  })

  it("logue/osc/additive's baked wavetable bank is counted as a SHARED, one-time cost -- a real, user-caught gap: the earlier version of this estimator only looked at memberDecls and silently missed the whole table", () => {
    const doc: PatchDocument = {
      nodes: [
        { kind: 'obj', type: 'logue/osc/additive', name: 'add1', x: 0, y: 0, params: [] },
        audioOut('out')
      ],
      nets: [{ sources: [{ obj: 'add1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
      settings: {},
      notes: ''
    }
    const result = estimateOscStateCost(doc, 'minilogue-xd')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.estimate.sharedHelpers).toEqual([
      { helperKey: 'additive_step', bytes: 6 * 512 * 4 + 6 * 4 }
    ])
    // fixed baseline + 16 bytes of per-instance scalars (phase_/coarse_/fine_/timbrePercent_) +
    // the shared table.
    expect(result.estimate.stateBytes).toBe(XD_OSC.fixedBaselineBytes + 16 + (6 * 512 * 4 + 6 * 4))
  })

  it('a shared helper table is counted exactly ONCE regardless of how many active instances reference it -- proves the estimator dedups the same way oscBody.ts itself does', () => {
    const doc: PatchDocument = {
      nodes: [
        { kind: 'obj', type: 'logue/osc/additive', name: 'add1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/osc/additive', name: 'add2', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/mix/mix2', name: 'mixer', x: 0, y: 0, params: [] },
        audioOut('out')
      ],
      nets: [
        { sources: [{ obj: 'add1', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in1' }] },
        { sources: [{ obj: 'add2', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in2' }] },
        { sources: [{ obj: 'mixer', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    }
    const result = estimateOscStateCost(doc, 'minilogue-xd')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.estimate.sharedHelpers).toEqual([
      { helperKey: 'additive_step', bytes: 6 * 512 * 4 + 6 * 4 }
    ])
    // fixed baseline + 2 additive instances (16B each) + 1 mixer (8B) + the shared table ONCE,
    // not twice.
    expect(result.estimate.stateBytes).toBe(
      XD_OSC.fixedBaselineBytes + 16 * 2 + 8 + (6 * 512 * 4 + 6 * 4)
    )
  })

  it('reports "incomplete" for a primitive unsupported on the selected platform', () => {
    const doc: PatchDocument = {
      nodes: [
        { kind: 'obj', type: 'logue/sense/cutoff', name: 's', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/gain/vca', name: 'v', x: 0, y: 0, params: [] },
        audioOut('out')
      ],
      nets: [
        { sources: [{ obj: 's', outlet: 'out' }], dests: [{ obj: 'v', inlet: 'gain' }] },
        { sources: [{ obj: 'v', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    }
    // logue/sense/cutoff is minilogue-xd-only.
    const result = estimateOscStateCost(doc, 'nts1mkii')
    expect(result.status).toBe('incomplete')
    if (result.status !== 'incomplete') return
    expect(result.reason).toMatch(/isn't supported on NTS-1 mkII/)
  })
})

describe('estimateOscStateCost code', () => {
  function oscDoc(nodes: ObjNode[], nets: Net[]): PatchDocument {
    return { nodes: [...nodes, obj(LOGUE_AUDIO_OUT_TYPE, 'out')], nets, settings: {}, notes: '' }
  }
  function obj(type: string, name: string): ObjNode {
    return { kind: 'obj', type, name, x: 0, y: 0, params: [] }
  }
  function wire(from: string, outlet: string, to: string, inlet: string): Net {
    return { sources: [{ obj: from, outlet }], dests: [{ obj: to, inlet }] }
  }

  it('counts a primitive first, then extra, and a shared helper once', () => {
    const one = oscDoc([obj('logue/osc/saw', 'a')], [wire('a', 'out', 'out', 'in')])
    const two = oscDoc(
      [obj('logue/osc/saw', 'a'), obj('logue/osc/saw', 'b'), obj('logue/mix/mix2', 'm')],
      [wire('a', 'out', 'm', 'in1'), wire('b', 'out', 'm', 'in2'), wire('m', 'out', 'out', 'in')]
    )
    const e1 = estimateOscStateCost(one, 'minilogue-xd')
    const e2 = estimateOscStateCost(two, 'minilogue-xd')
    if (e1.status !== 'ok' || e2.status !== 'ok') throw new Error('incomplete')
    const saw = CODE_SIZE_TABLE['minilogue-xd:osc']['logue/osc/saw']
    const unwired = saw.unwired ?? saw
    expect(e1.estimate.code.perInstance[0].bytes).toBe(unwired.first)
    expect(e2.estimate.code.perInstance.map((i) => i.bytes).slice(0, 2)).toEqual([
      unwired.first,
      unwired.extra
    ])
    expect(e2.estimate.code.helpers.map((h) => h.helperKey)).toEqual(unwired.helpers)
    expect(e1.estimate.totalBytes).toBe(e1.estimate.stateBytes + e1.estimate.codeBytes)
    expect(e1.estimate.codeBaselineBytes).toBe(findUnitKind('minilogue-xd', 'osc')!.fixedCodeBytes)
  })

  it('scales between the unwired and the wired measurement by the share of inlets wired', () => {
    const lp = CODE_SIZE_TABLE['nts1mkii:osc']['logue/filter/svf']
    const d = oscDoc(
      [obj('logue/osc/saw', 's'), obj('logue/filter/svf', 'f')],
      [wire('s', 'out', 'f', 'in'), wire('f', 'lp', 'out', 'in')]
    )
    const est = estimateOscStateCost(d, 'nts1mkii')
    if (est.status !== 'ok') throw new Error(est.reason)
    const inlets = findLoguePrimitive('logue/filter/svf')!.inlets!.length
    const low = lp.unwired!.first
    expect(est.estimate.code.perInstance[1].bytes).toBe(Math.round(low + (lp.first - low) / inlets))
  })
})

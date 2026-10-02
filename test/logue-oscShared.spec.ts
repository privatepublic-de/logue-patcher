import { describe, it, expect } from 'vitest'
import {
  resolveAudioGraph,
  resolvePrimitiveInstances,
  LOGUE_AUDIO_OUT_TYPE,
  UnsupportedLogueNodeError
} from '../logue-codegen/src/oscInstances'
import {
  resolveExposedParams,
  rejectExposedParamsOnInactiveInstances,
  InvalidLogueParamError
} from '../logue-codegen/src/oscParams'
import { buildOscBodyPieces } from '../logue-codegen/src/oscBody'
import type { PatchDocument, ObjNode } from '../src/shared/domain/patch'

/**
 * Direct unit tests of the shared graph/param/body-piece machinery both platform generators
 * call into (`nts1mkii/generateOscUnit.ts`, `minilogue-xd/generateOscUnit.ts`) -- covers
 * behavior that no longer has a reachable scenario through either full generator now that
 * `resolveAudioGraph` resolves to exactly one active instance per export (see
 * `test/logue-generateOscUnit.spec.ts`'s comment on the removed "shared helper, both placed"
 * test, and its rescoped duplicate-index test).
 */

// Platform choice here is arbitrary (this suite exercises the shared, platform-agnostic
// machinery both generators call into) -- 'nts1mkii' picked consistently throughout.
function pulseNode(name: string, logueParamIndex?: number): ObjNode {
  return {
    kind: 'obj',
    type: 'logue/osc/pulse',
    name,
    x: 0,
    y: 0,
    params:
      logueParamIndex === undefined
        ? []
        : [{ name: 'WIDTH', value: '50', logueParamIndex: { nts1mkii: logueParamIndex } }]
  }
}

describe('resolveAudioGraph', () => {
  it('rejects more than one logue/io/audio-out node', () => {
    const doc: PatchDocument = {
      nodes: [
        { kind: 'obj', type: 'logue/osc/sine', name: 'sine1', x: 0, y: 0, params: [] },
        {
          kind: 'obj',
          type: LOGUE_AUDIO_OUT_TYPE,
          name: 'out1',
          x: 0,
          y: 0,
          params: []
        },
        {
          kind: 'obj',
          type: LOGUE_AUDIO_OUT_TYPE,
          name: 'out2',
          x: 0,
          y: 0,
          params: []
        }
      ],
      nets: [{ sources: [{ obj: 'sine1' }], dests: [{ obj: 'out1' }] }],
      settings: {},
      notes: ''
    }
    expect(() => resolveAudioGraph(doc)).toThrow(UnsupportedLogueNodeError)
    expect(() => resolveAudioGraph(doc)).toThrow(/exactly one real audio output/)
  })

  it('rejects fan-in -- two separate nets both feeding the same audio-out', () => {
    const doc: PatchDocument = {
      nodes: [
        { kind: 'obj', type: 'logue/osc/sine', name: 'a', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/osc/sine', name: 'b', x: 0, y: 0, params: [] },
        {
          kind: 'obj',
          type: LOGUE_AUDIO_OUT_TYPE,
          name: 'out',
          x: 0,
          y: 0,
          params: []
        }
      ],
      nets: [
        { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] },
        { sources: [{ obj: 'b', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    }
    expect(() => resolveAudioGraph(doc)).toThrow(/fed by more than one source/)
  })

  it("rejects a net whose source isn't a recognized primitive", () => {
    const doc: PatchDocument = {
      nodes: [
        {
          kind: 'obj',
          type: LOGUE_AUDIO_OUT_TYPE,
          name: 'out',
          x: 0,
          y: 0,
          params: []
        }
      ],
      nets: [
        { sources: [{ obj: 'nonexistent', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    }
    expect(() => resolveAudioGraph(doc)).toThrow(/isn't a recognized logue primitive/)
  })

  it('resolvePrimitiveInstances skips logue/io/audio-out rather than rejecting it as unrecognized', () => {
    const doc: PatchDocument = {
      nodes: [
        { kind: 'obj', type: 'logue/osc/sine', name: 'sine1', x: 0, y: 0, params: [] },
        {
          kind: 'obj',
          type: LOGUE_AUDIO_OUT_TYPE,
          name: 'out',
          x: 0,
          y: 0,
          params: []
        }
      ],
      nets: [],
      settings: {},
      notes: ''
    }
    const instances = resolvePrimitiveInstances(doc)
    expect(instances).toHaveLength(1)
    expect(instances[0].node.name).toBe('sine1')
  })
})

/**
 * `logue/filter/svf` was the first multi-outlet primitive, followed by `logue/mux/demux2` and,
 * later, every `logue/sense/*` primitive except `gate` (see `primitives.ts`'s own
 * `PrimitiveOutletSpec`/`renderOutletStatements`/`sensePitchPrimitive` doc comments) -- these
 * cover the net-resolution mechanics `oscInstances.ts`/`oscBody.ts` gained to support the
 * general mechanism: wiring two different outlets of the same source, a legacy/stale outlet name
 * on an ordinary single-outlet primitive, an unrecognized outlet name on a real multi-outlet one,
 * and a literal `'out'` outlet name (the implicit single-outlet primitive default `ports.ts`
 * stamps on every drawn wire) left over on a net from BEFORE its source primitive grew multiple
 * outlets.
 */
describe('multi-outlet resolution', () => {
  function svfNode(name: string): ObjNode {
    return { kind: 'obj', type: 'logue/filter/svf', name, x: 0, y: 0, params: [] }
  }
  function vcaNode(name: string): ObjNode {
    return { kind: 'obj', type: 'logue/gain/vca', name, x: 0, y: 0, params: [] }
  }
  function audioOutNode(name: string): ObjNode {
    return { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name, x: 0, y: 0, params: [] }
  }

  it('wires two different outlets of the same multi-outlet source into two different inlets', () => {
    const doc: PatchDocument = {
      nodes: [svfNode('svf1'), vcaNode('vca1'), audioOutNode('out')],
      nets: [
        { sources: [{ obj: 'svf1', outlet: 'lp' }], dests: [{ obj: 'vca1', inlet: 'in' }] },
        { sources: [{ obj: 'svf1', outlet: 'bp' }], dests: [{ obj: 'vca1', inlet: 'gain' }] },
        { sources: [{ obj: 'vca1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    }
    const graph = resolveAudioGraph(doc)
    const vca = graph.activeInstances.find((i) => i.suffix === 'vca1')!
    expect(vca.inletSources.in).toEqual({ suffix: 'svf1', outlet: 'lp' })
    expect(vca.inletSources.gain).toEqual({ suffix: 'svf1', outlet: 'bp' })
    expect(graph.sinkOutlet).toBe('out')
  })

  it('rejects two DIFFERENT outlets of the same source feeding one inlet as fan-in', () => {
    const doc: PatchDocument = {
      nodes: [svfNode('svf1'), vcaNode('vca1'), audioOutNode('out')],
      nets: [
        {
          sources: [
            { obj: 'svf1', outlet: 'lp' },
            { obj: 'svf1', outlet: 'bp' }
          ],
          dests: [{ obj: 'vca1', inlet: 'in' }]
        },
        { sources: [{ obj: 'vca1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    }
    expect(() => resolveAudioGraph(doc)).toThrow(/fed by more than one source/)
    expect(() => resolveAudioGraph(doc)).toThrow(/svf1\.lp, svf1\.bp/)
  })

  it('throws a named error for an outlet name a multi-outlet primitive does not declare', () => {
    const doc: PatchDocument = {
      nodes: [svfNode('svf1'), audioOutNode('out')],
      nets: [{ sources: [{ obj: 'svf1', outlet: 'notch' }], dests: [{ obj: 'out', inlet: 'in' }] }],
      settings: {},
      notes: ''
    }
    expect(() => resolveAudioGraph(doc)).toThrow(/doesn't declare \(has: lp, bp, hp\)/)
  })

  it('ignores a stale/legacy outlet name on an ordinary single-outlet source', () => {
    const doc: PatchDocument = {
      nodes: [
        { kind: 'obj', type: 'logue/osc/sine', name: 'sine1', x: 0, y: 0, params: [] },
        audioOutNode('out')
      ],
      nets: [
        {
          sources: [{ obj: 'sine1', outlet: 'someLegacyAxolotiOutletName' }],
          dests: [{ obj: 'out', inlet: 'in' }]
        }
      ],
      settings: {},
      notes: ''
    }
    const graph = resolveAudioGraph(doc)
    expect(graph.sinkOutlet).toBe('out')
  })

  it('resolves a net still carrying the legacy implicit "out" outlet name to the new primitive\'s first declared outlet, rather than throwing', () => {
    const doc: PatchDocument = {
      nodes: [
        { kind: 'obj', type: 'logue/sense/pitch', name: 'pitch1', x: 0, y: 0, params: [] },
        audioOutNode('out')
      ],
      nets: [{ sources: [{ obj: 'pitch1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
      settings: {},
      notes: ''
    }
    const graph = resolveAudioGraph(doc)
    expect(graph.sinkOutlet).toBe('unipolar')
  })

  it('computes both the unipolar and bipolar outlets of a sense primitive from one shared statement block', () => {
    const doc: PatchDocument = {
      nodes: [
        { kind: 'obj', type: 'logue/sense/pitch', name: 'pitch1', x: 0, y: 0, params: [] },
        vcaNode('vca1'),
        audioOutNode('out')
      ],
      nets: [
        { sources: [{ obj: 'pitch1', outlet: 'bipolar' }], dests: [{ obj: 'vca1', inlet: 'in' }] },
        { sources: [{ obj: 'vca1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    }
    const graph = resolveAudioGraph(doc)
    const pieces = buildOscBodyPieces(graph.activeInstances, new Map(), graph.sinkOutlet)
    expect(pieces.computeStatements).toContain('float y_pitch1_unipolar = note01_;')
    expect(pieces.computeStatements).toContain('float y_pitch1_bipolar = note01_ * 2.f - 1.f;')
    expect(pieces.computeStatements).toContain('((y_pitch1_bipolar) * (gain_vca1))')
  })

  it('emits every declared outlet from one shared statement block, and picks the right one per consumer', () => {
    const doc: PatchDocument = {
      nodes: [
        { kind: 'obj', type: 'logue/osc/noise', name: 'noise1', x: 0, y: 0, params: [] },
        svfNode('svf1'),
        vcaNode('vca1'),
        audioOutNode('out')
      ],
      nets: [
        { sources: [{ obj: 'noise1', outlet: 'out' }], dests: [{ obj: 'svf1', inlet: 'in' }] },
        { sources: [{ obj: 'svf1', outlet: 'hp' }], dests: [{ obj: 'vca1', inlet: 'in' }] },
        { sources: [{ obj: 'vca1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    }
    const graph = resolveAudioGraph(doc)
    const pieces = buildOscBodyPieces(graph.activeInstances, new Map(), graph.sinkOutlet)
    // The shared per-sample state update happens exactly once (a single svf_step call), not
    // once per outlet -- the whole reason this primitive needs renderOutletStatements at all.
    expect(pieces.computeStatements.match(/svf_step\(/g)).toHaveLength(1)
    expect(pieces.computeStatements).toContain('float y_svf1_lp, y_svf1_bp, y_svf1_hp;')
    // lp/bp are unwired here -- still computed (see the primitive's own doc comment on why this
    // doesn't bother pruning individual outlets), but (void)-cast so they never warn as unused.
    expect(pieces.computeStatements).toContain('(void)y_svf1_lp; (void)y_svf1_bp; (void)y_svf1_hp;')
    expect(pieces.computeStatements).toContain('((y_svf1_hp) * (gain_vca1))')
    expect(pieces.outputExpr).toBe('y_vca1')
  })
})

describe('rejectExposedParamsOnInactiveInstances', () => {
  it('throws when an unwired instance has an exposed param', () => {
    const active = { suffix: 'pulse1', id: 'logue/osc/pulse', node: pulseNode('pulse1') }
    const inactive = { suffix: 'pulse2', id: 'logue/osc/pulse', node: pulseNode('pulse2', 0) }
    expect(() =>
      rejectExposedParamsOnInactiveInstances([active, inactive], [active], 'nts1mkii')
    ).toThrow(InvalidLogueParamError)
    expect(() =>
      rejectExposedParamsOnInactiveInstances([active, inactive], [active], 'nts1mkii')
    ).toThrow(/isn't wired/)
  })

  it('passes when only the active instance has an exposed param', () => {
    const active = { suffix: 'pulse1', id: 'logue/osc/pulse', node: pulseNode('pulse1', 0) }
    const inactive = { suffix: 'pulse2', id: 'logue/osc/pulse', node: pulseNode('pulse2') }
    expect(() =>
      rejectExposedParamsOnInactiveInstances([active, inactive], [active], 'nts1mkii')
    ).not.toThrow()
  })
})

describe('resolveExposedParams duplicate-index rejection', () => {
  it('rejects two params (on two different instances passed in the same call) claiming the same logueParamIndex', () => {
    const a = { suffix: 'pulse1', id: 'logue/osc/pulse', node: pulseNode('pulse1', 0) }
    const b = { suffix: 'pulse2', id: 'logue/osc/pulse', node: pulseNode('pulse2', 0) }
    expect(() => resolveExposedParams([a, b], 'nts1mkii', 10)).toThrow(InvalidLogueParamError)
    expect(() => resolveExposedParams([a, b], 'nts1mkii', 10)).toThrow(/claimed by both/)
  })
})

describe('buildOscBodyPieces', () => {
  it('dedupes a shared transitive helper across multiple active instances, computing each in its own statement', () => {
    const saw = {
      suffix: 'saw1',
      id: 'logue/osc/saw',
      node: {
        kind: 'obj' as const,
        type: 'logue/osc/saw',
        name: 'saw1',
        x: 0,
        y: 0,
        params: []
      },
      inletSources: {}
    }
    const square = {
      suffix: 'sq1',
      id: 'logue/osc/square',
      node: {
        kind: 'obj' as const,
        type: 'logue/osc/square',
        name: 'sq1',
        x: 0,
        y: 0,
        params: []
      },
      inletSources: {}
    }
    // Order matters: activeInstances is topological, last = the one wired to audio-out. saw
    // first, square second -- square is "the output" here, matching resolveAudioGraph's own
    // "last entry is the sink" contract.
    const pieces = buildOscBodyPieces([saw, square], new Map())

    const occurrences =
      pieces.helperCode.split('static float polyblep(float t, float dt)').length - 1
    expect(occurrences).toBe(1)
    expect(pieces.helperCode).toContain('polyblep_saw')
    expect(pieces.helperCode).toContain('polyblep_square')
    expect(pieces.memberDecls).toContain('float phase_saw1;')
    expect(pieces.memberDecls).toContain('float phase_sq1;')
    // Both instances get their own compute statement (both cost cycles/state)...
    expect(pieces.computeStatements).toContain(
      'float y_saw1 = polyblep_saw(phase_saw1, note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_saw1 + fine_saw1));'
    )
    expect(pieces.computeStatements).toContain(
      'float y_sq1 = polyblep_square(phase_sq1, note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_sq1 + fine_sq1));'
    )
    // ...but outputExpr is ONLY the LAST (sink) instance's own computed variable, never a sum
    expect(pieces.outputExpr).toBe('y_sq1')
  })
})

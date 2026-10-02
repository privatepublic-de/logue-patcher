import { describe, expect, it } from 'vitest'
import {
  patchDocToFlow,
  type NetEdgeData,
  type ObjectNodeData
} from '../src/renderer/src/state/toFlowGraph'
import {
  brightenForWire,
  PORT_COLOR_AUDIO,
  PORT_COLOR_UNIPOLAR,
  PORT_COLOR_BIPOLAR,
  PORT_COLOR_GATE,
  PORT_COLOR_NEUTRAL,
  PORT_COLOR_BUFFER
} from '../src/renderer/src/canvas/portColors'
import { CATEGORY_COLORS } from '../src/renderer/src/browser/loguePrimitiveCatalog'
import type { ObjNode, PatchDocument } from '../src/shared/domain/patch'

function objNode(type: string, name: string): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params: [] }
}

function doc(nodes: ObjNode[], nets: PatchDocument['nets']): PatchDocument {
  return { nodes, nets, settings: {}, notes: '' }
}

function edgeColorFor(edges: ReturnType<typeof patchDocToFlow>['edges'], id: string): string {
  const edge = edges.find((e) => e.id === id)
  return (edge?.data as NetEdgeData).color
}

function inletColorsFor(
  nodes: ReturnType<typeof patchDocToFlow>['nodes'],
  id: string
): Record<string, string> {
  const node = nodes.find((n) => n.id === id)
  return (node?.data as ObjectNodeData).inletColors
}

function outletColorsFor(
  nodes: ReturnType<typeof patchDocToFlow>['nodes'],
  id: string
): Record<string, string> {
  const node = nodes.find((n) => n.id === id)
  return (node?.data as ObjectNodeData).outletColors
}

describe('brightenForWire', () => {
  it('produces a valid hex distinct from the muted category swatch it started from', () => {
    for (const color of Object.values(CATEGORY_COLORS)) {
      const brightened = brightenForWire(color)
      expect(brightened).toMatch(/^#[0-9a-f]{6}$/i)
      expect(brightened).not.toBe(color)
    }
  })
})

describe('patchDocToFlow wire colouring', () => {
  const osc = objNode('logue/osc/sine', 'osc1')
  const lfo = objNode('logue/lfo/sine-lfo', 'lfo1')
  const filter = objNode('logue/filter/lowpass-cheap', 'filter1')
  const out = objNode('logue/io/audio-out', 'out1')

  it('colours an audio-producing source wire the uniform audio colour', () => {
    const { edges } = patchDocToFlow(
      doc(
        [osc, filter, out],
        [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'filter1', inlet: 'in' }] },
          { sources: [{ obj: 'filter1', outlet: 'out' }], dests: [{ obj: 'out1', inlet: 'in' }] }
        ]
      )
    )
    expect(edgeColorFor(edges, 'net-0-s0-d0')).toBe(PORT_COLOR_AUDIO)
    expect(edgeColorFor(edges, 'net-1-s0-d0')).toBe(PORT_COLOR_AUDIO)
  })

  it("colours a wire by the source outlet's own fixed polarity bucket, matching the dot it leaves from", () => {
    const { edges } = patchDocToFlow(
      doc(
        [lfo, filter],
        [
          {
            sources: [{ obj: 'lfo1', outlet: 'out' }],
            dests: [{ obj: 'filter1', inlet: 'cutoff' }]
          }
        ]
      )
    )
    // An LFO is always bipolar, regardless of category -- see logue/lfo/*'s own outletPolarity.
    expect(edgeColorFor(edges, 'net-0-s0-d0')).toBe(PORT_COLOR_BIPOLAR)
  })

  // The exact real-world case a user reported: a sense reading routed through a generic
  // converter (declared `audio`-role, since it can carry either kind of signal -- see
  // unipolar-to-bipolar's own primitives.ts entry) into a filter's cutoff. Each leg now reads as
  // its own REAL value domain rather than a single "this came from a control-ish node" tint: the
  // sense reading's own `unipolar` outlet, then the converter's fixed `bipolar` output -- the
  // conversion itself becomes visible on canvas, not just "still control".
  it('colours each leg of a control chain by its own real polarity, not a shared source-category tint', () => {
    const shape = objNode('logue/sense/shape', 'shape')
    const converter = objNode('logue/util/unipolar-to-bipolar', 'conv')
    const { edges } = patchDocToFlow(
      doc(
        [shape, converter, filter],
        [
          { sources: [{ obj: 'shape', outlet: 'out' }], dests: [{ obj: 'conv', inlet: 'in' }] },
          {
            sources: [{ obj: 'conv', outlet: 'out' }],
            dests: [{ obj: 'filter1', inlet: 'cutoff' }]
          }
        ]
      )
    )
    // Legacy 'out' on a now-dual-outlet sense primitive resolves to the FIRST declared outlet
    // (see resolveDeclaredOutletName) -- 'unipolar', SENSE_OUTLETS' own first entry.
    expect(edgeColorFor(edges, 'net-0-s0-d0')).toBe(PORT_COLOR_UNIPOLAR)
    expect(edgeColorFor(edges, 'net-1-s0-d0')).toBe(PORT_COLOR_BIPOLAR)
  })

  // Real regression: `logue/sense/*` grew a second (`bipolar`) outlet, so a net authored before
  // that change still carries the old implicit `'out'` outlet name. Codegen already resolves this
  // gracefully (`resolveDeclaredOutletName`, shared with this exact function) -- this pins down
  // that the CANVAS agrees: the edge must render as valid, not a stale/broken dashed line, even
  // though `'out'` isn't a real outlet on `logue/sense/pitch` any more.
  it('resolves a net still wired to a sense primitive\'s legacy "out" outlet as a valid edge, not a broken one', () => {
    const pitch = objNode('logue/sense/pitch', 'pitch1')
    const { edges } = patchDocToFlow(
      doc(
        [pitch, filter],
        [
          {
            sources: [{ obj: 'pitch1', outlet: 'out' }],
            dests: [{ obj: 'filter1', inlet: 'cutoff' }]
          }
        ]
      )
    )
    const edge = edges.find((e) => e.id === 'net-0-s0-d0')
    expect((edge?.data as NetEdgeData).invalid).toBe(false)
    expect(edge?.sourceHandle).toBe('unipolar')
  })

  it('falls back to the neutral audio colour when the source has no resolvable logue category', () => {
    const legacySrc = objNode('axoloti/foo/bar', 'legacySrc')
    const { edges } = patchDocToFlow(
      doc(
        [legacySrc, filter],
        [
          {
            sources: [{ obj: 'legacySrc', outlet: 'out' }],
            dests: [{ obj: 'filter1', inlet: 'cutoff' }]
          }
        ]
      )
    )
    expect(edgeColorFor(edges, 'net-0-s0-d0')).toBe(PORT_COLOR_AUDIO)
  })
})

describe('patchDocToFlow inlet colour takeover', () => {
  const lfo = objNode('logue/lfo/sine-lfo', 'lfo1')
  const filter = objNode('logue/filter/lowpass-cheap', 'filter1')

  it("gives a wired inlet its wire's own colour", () => {
    const { nodes } = patchDocToFlow(
      doc(
        [lfo, filter],
        [
          {
            sources: [{ obj: 'lfo1', outlet: 'out' }],
            dests: [{ obj: 'filter1', inlet: 'cutoff' }]
          }
        ]
      )
    )
    expect(inletColorsFor(nodes, 'filter1')).toEqual({ cutoff: PORT_COLOR_BIPOLAR })
  })

  it('leaves an unwired inlet out of the map entirely', () => {
    const { nodes } = patchDocToFlow(doc([filter], []))
    expect(inletColorsFor(nodes, 'filter1')).toEqual({})
  })

  it('does not record a colour for an invalid (fan-in) net', () => {
    const osc2 = objNode('logue/osc/saw', 'osc2')
    const { nodes } = patchDocToFlow(
      doc(
        [lfo, osc2, filter],
        [
          {
            sources: [
              { obj: 'lfo1', outlet: 'out' },
              { obj: 'osc2', outlet: 'out' }
            ],
            dests: [{ obj: 'filter1', inlet: 'cutoff' }]
          }
        ]
      )
    )
    expect(inletColorsFor(nodes, 'filter1')).toEqual({})
  })
})

// The actual "pass-through dilemma" feature: a filter/VCA/mixer/math/mux node declares
// `outletPolarity: 'inherit'` rather than a fixed bucket, so its own outlet reads as whatever's
// ACTUALLY wired into its audio-role inlet(s) -- see wirePolarity.ts's own doc comment.
describe('patchDocToFlow pass-through outlet inheritance', () => {
  it("inherits a single-hop pass-through's outlet from its own audio-role inlet", () => {
    const env = objNode('logue/env/ad', 'env1')
    const scale = objNode('logue/math/scale', 'scale1')
    const { nodes } = patchDocToFlow(
      doc(
        [env, scale],
        [{ sources: [{ obj: 'env1', outlet: 'out' }], dests: [{ obj: 'scale1', inlet: 'in' }] }]
      )
    )
    expect(outletColorsFor(nodes, 'scale1')).toEqual({ out: PORT_COLOR_UNIPOLAR })
  })

  it('propagates through more than one pass-through hop, not just the immediate upstream one', () => {
    const lfo = objNode('logue/lfo/sine-lfo', 'lfo1')
    const glide = objNode('logue/util/glide', 'glide1')
    const vca = objNode('logue/gain/vca', 'vca1')
    const { nodes } = patchDocToFlow(
      doc(
        [lfo, glide, vca],
        [
          { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'glide1', inlet: 'in' }] },
          { sources: [{ obj: 'glide1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'in' }] }
        ]
      )
    )
    expect(outletColorsFor(nodes, 'glide1')).toEqual({ out: PORT_COLOR_BIPOLAR })
    expect(outletColorsFor(nodes, 'vca1')).toEqual({ out: PORT_COLOR_BIPOLAR })
  })

  it('defaults an unwired pass-through outlet to audio, not neutral -- these primitives are predominantly used for audio', () => {
    const vca = objNode('logue/gain/vca', 'vca1')
    const { nodes } = patchDocToFlow(doc([vca], []))
    expect(outletColorsFor(nodes, 'vca1')).toEqual({ out: PORT_COLOR_AUDIO })
  })

  it('propagates a combiner outlet when every wired audio-role inlet agrees', () => {
    const lfoA = objNode('logue/lfo/sine-lfo', 'lfoA')
    const lfoB = objNode('logue/lfo/triangle-lfo', 'lfoB')
    const add = objNode('logue/math/add', 'add1')
    const { nodes } = patchDocToFlow(
      doc(
        [lfoA, lfoB, add],
        [
          { sources: [{ obj: 'lfoA', outlet: 'out' }], dests: [{ obj: 'add1', inlet: 'a' }] },
          { sources: [{ obj: 'lfoB', outlet: 'out' }], dests: [{ obj: 'add1', inlet: 'b' }] }
        ]
      )
    )
    expect(outletColorsFor(nodes, 'add1')).toEqual({ out: PORT_COLOR_BIPOLAR })
  })

  it('falls back to neutral when a combiner is fed two disagreeing buckets, rather than guessing', () => {
    const lfo = objNode('logue/lfo/sine-lfo', 'lfo1')
    const osc = objNode('logue/osc/sine', 'osc1')
    const mix2 = objNode('logue/mix/mix2', 'mix1')
    const { nodes } = patchDocToFlow(
      doc(
        [lfo, osc, mix2],
        [
          { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'mix1', inlet: 'in1' }] },
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'mix1', inlet: 'in2' }] }
        ]
      )
    )
    expect(outletColorsFor(nodes, 'mix1')).toEqual({ out: PORT_COLOR_NEUTRAL })
  })

  it('resolves a genuine cycle to neutral instead of hanging', () => {
    const scaleA = objNode('logue/math/scale', 'scaleA')
    const scaleB = objNode('logue/math/scale', 'scaleB')
    const { nodes } = patchDocToFlow(
      doc(
        [scaleA, scaleB],
        [
          { sources: [{ obj: 'scaleB', outlet: 'out' }], dests: [{ obj: 'scaleA', inlet: 'in' }] },
          { sources: [{ obj: 'scaleA', outlet: 'out' }], dests: [{ obj: 'scaleB', inlet: 'in' }] }
        ]
      )
    )
    expect(outletColorsFor(nodes, 'scaleA')).toEqual({ out: PORT_COLOR_NEUTRAL })
    expect(outletColorsFor(nodes, 'scaleB')).toEqual({ out: PORT_COLOR_NEUTRAL })
  })
})

describe('patchDocToFlow fixed-polarity outlets', () => {
  // The exact gap an earlier, category-only version of this scheme had: both of a sense
  // primitive's outlets shared one colour (its owning node's category), even though they carry
  // genuinely different value domains.
  it("distinguishes a sense primitive's own unipolar and bipolar outlets from each other", () => {
    const shape = objNode('logue/sense/shape', 'shape1')
    const { nodes } = patchDocToFlow(doc([shape], []))
    expect(outletColorsFor(nodes, 'shape1')).toEqual({
      unipolar: PORT_COLOR_UNIPOLAR,
      bipolar: PORT_COLOR_BIPOLAR
    })
  })

  it('paints a logic primitive gate purple, not a shade of control', () => {
    const gt = objNode('logue/logic/greater-than', 'gt1')
    const { nodes } = patchDocToFlow(doc([gt], []))
    expect(outletColorsFor(nodes, 'gt1')).toEqual({ out: PORT_COLOR_GATE })
  })
})

describe('buffer wires on the canvas', () => {
  const effect = (nodes: ObjNode[], nets: PatchDocument['nets']): PatchDocument => ({
    nodes,
    nets,
    settings: { logueTarget: { module: 'delfx' } },
    notes: ''
  })
  const edge = (edges: ReturnType<typeof patchDocToFlow>['edges']): NetEdgeData =>
    edges[0].data as NetEdgeData

  it('colours a buffer wire rose and keeps it valid into a buffer inlet', () => {
    const { edges, nodes } = patchDocToFlow(
      effect(
        [objNode('logue/util/buffer', 'b'), objNode('logue/util/buffer-tap', 't')],
        [{ sources: [{ obj: 'b', outlet: 'buf' }], dests: [{ obj: 't', inlet: 'buf' }] }]
      )
    )
    expect(edge(edges)).toMatchObject({ color: PORT_COLOR_BUFFER, invalid: false })
    expect(outletColorsFor(nodes, 'b').buf).toBe(PORT_COLOR_BUFFER)
  })

  it('dashes a buffer wire into a signal inlet, and a signal into a buffer inlet', () => {
    const intoSignal = patchDocToFlow(
      effect(
        [objNode('logue/util/buffer', 'b'), objNode('logue/filter/lowpass-cheap', 'lp')],
        [{ sources: [{ obj: 'b', outlet: 'buf' }], dests: [{ obj: 'lp', inlet: 'in' }] }]
      )
    )
    expect(edge(intoSignal.edges).invalid).toBe(true)
    const intoBuffer = patchDocToFlow(
      effect(
        [objNode('logue/osc/sine', 's'), objNode('logue/util/buffer-tap', 't')],
        [{ sources: [{ obj: 's', outlet: 'out' }], dests: [{ obj: 't', inlet: 'buf' }] }]
      )
    )
    expect(edge(intoBuffer.edges).invalid).toBe(true)
  })

  it("lets a definition's inlet port feed a buffer inlet, coloured as a buffer", () => {
    const { edges } = patchDocToFlow({
      nodes: [objNode('logue/io/inlet', 'buf'), objNode('logue/util/buffer-tap', 't')],
      nets: [{ sources: [{ obj: 'buf', outlet: 'out' }], dests: [{ obj: 't', inlet: 'buf' }] }],
      settings: { subpatch: true },
      notes: ''
    })
    expect(edge(edges)).toMatchObject({ color: PORT_COLOR_BUFFER, invalid: false })
  })
})

describe('buffer wires and pass-through colouring', () => {
  it("doesn't pass a (wrongly wired) buffer on through a filter's outlet", () => {
    const { nodes } = patchDocToFlow({
      nodes: [objNode('logue/util/buffer', 'b'), objNode('logue/filter/lowpass-cheap', 'lp')],
      nets: [{ sources: [{ obj: 'b', outlet: 'buf' }], dests: [{ obj: 'lp', inlet: 'in' }] }],
      settings: { logueTarget: { module: 'delfx' } },
      notes: ''
    })
    expect(outletColorsFor(nodes, 'lp').out).toBe(PORT_COLOR_AUDIO)
  })
})

describe('patchDocToFlow wire warnings (InletExpectation.warnFrom)', () => {
  const wire = (from: string, outlet: string, to: string, inlet: string) => ({
    sources: [{ obj: from, outlet }],
    dests: [{ obj: to, inlet }]
  })
  const warningsOf = (d: PatchDocument) => {
    const { nodes, edges } = patchDocToFlow(d)
    return {
      edges: edges.map((e) => (e.data as NetEdgeData).warning).filter(Boolean),
      inlets: Object.fromEntries(
        nodes
          .filter((n) => n.type === 'object')
          .flatMap((n) => Object.entries((n.data as ObjectNodeData).inletWarnings))
      )
    }
  }

  it('flags a bipolar LFO into a VCA gain, on the wire and on the inlet', () => {
    const w = warningsOf(
      doc(
        [objNode('logue/lfo/sine-lfo', 'lfo'), objNode('logue/gain/vca', 'vca')],
        [wire('lfo', 'out', 'vca', 'gain')]
      )
    )
    expect(w.edges).toHaveLength(1)
    expect(w.edges[0]).toMatch(/ring modulation/)
    expect(w.inlets.gain).toBe(w.edges[0])
  })

  it('flags a unipolar or gate source into mux4 index, but not a bipolar one', () => {
    for (const [type, outlet, expected] of [
      ['logue/env/ad', 'out', 1],
      ['logue/sense/gate', 'out', 1],
      ['logue/lfo/sine-lfo', 'out', 0]
    ] as const) {
      const w = warningsOf(
        doc(
          [objNode(type, 'src'), objNode('logue/mux/mux4', 'mux')],
          [wire('src', outlet, 'mux', 'index')]
        )
      )
      expect(w.edges, type).toHaveLength(expected)
    }
  })

  it('leaves suitable wires, additive inlets and audio into a gain (a ring modulator) alone', () => {
    const w = warningsOf(
      doc(
        [
          objNode('logue/env/ad', 'env'),
          objNode('logue/lfo/sine-lfo', 'lfo'),
          objNode('logue/osc/sine', 'osc'),
          objNode('logue/gain/vca', 'vca'),
          objNode('logue/gain/vca', 'ring'),
          objNode('logue/filter/svf', 'f')
        ],
        [
          wire('env', 'out', 'vca', 'gain'),
          wire('osc', 'out', 'ring', 'gain'),
          wire('lfo', 'out', 'f', 'cutoff')
        ]
      )
    )
    expect(w.edges).toEqual([])
  })
})

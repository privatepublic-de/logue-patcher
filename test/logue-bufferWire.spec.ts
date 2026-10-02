import { describe, it, expect } from 'vitest'
import {
  resolveAudioGraph,
  LOGUE_AUDIO_IN_TYPE,
  LOGUE_AUDIO_OUT_TYPE
} from '../logue-codegen/src/oscInstances'
import { generateFxUnit } from '../logue-codegen/src/nts1mkii/generateFxUnit'
import { generateOldGenFxUnit } from '../logue-codegen/src/minilogue-xd/generateFxUnit'
import { estimateOscStateCost } from '../logue-codegen/src/estimateOscStateCost'
import { createSubpatchAwareResolver } from '../logue-codegen/src/subpatches'
import { isBufferOutlet } from '../logue-codegen/src/primitives'
import type { Net, ObjNode, PatchDocument } from '../src/shared/domain/patch'

function obj(type: string, name: string, params: ObjNode['params'] = []): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params }
}
function net(from: string, outlet: string, to: string, inlet: string): Net {
  return { sources: [{ obj: from, outlet }], dests: [{ obj: to, inlet }] }
}
function doc(nodes: ObjNode[], nets: Net[]): PatchDocument {
  return {
    nodes: [obj(LOGUE_AUDIO_IN_TYPE, 'in'), ...nodes, obj(LOGUE_AUDIO_OUT_TYPE, 'out')],
    nets,
    settings: { logueTarget: { module: 'delfx' } },
    notes: ''
  }
}

/** A tap fed back into its own buffer through a mixer: the grain-mill feedback shape. */
const echoLoop = doc(
  [obj('logue/util/buffer', 'b'), obj('logue/util/buffer-tap', 't'), obj('logue/mix/mix2', 'm')],
  [
    net('in', 'l', 'm', 'in1'),
    net('t', 'out', 'm', 'in2'),
    net('m', 'out', 'b', 'in'),
    net('b', 'buf', 't', 'buf'),
    net('t', 'out', 'out', 'l')
  ]
)

describe('buffer wires', () => {
  it('resolves a loop through a buffer without a sample-delay, reader before writer', () => {
    const graph = resolveAudioGraph(echoLoop)
    const order = graph.activeInstances.map((i) => i.node.name)
    expect(order.sort()).toEqual(['b', 'm', 't'])
    const t = graph.activeInstances.find((i) => i.node.name === 't')!
    expect(t.inletSources.buf).toEqual({ suffix: 'b', outlet: 'buf' })
  })

  it("gives the reader the writer's ring and stores after every read of the sample", () => {
    const { fxH } = generateFxUnit(echoLoop, { name: 'echo' })
    const loop = fxH.slice(fxH.indexOf('for (uint32_t i = 0; i < frames; ++i)'))
    const read = loop.indexOf(
      'buffer_tap_read(((const int16_t *)sdram_b), (bufLen_b - 1u), bufW_b,'
    )
    const store = loop.indexOf('buffer_write((int16_t *)sdram_b, bufLen_b - 1u, &bufW_b, y_m,')
    expect(read).toBeGreaterThan(0)
    expect(store).toBeGreaterThan(loop.indexOf('float y_m ='))
    expect(store).toBeGreaterThan(read)
    expect(generateOldGenFxUnit(echoLoop, { name: 'echo' }).fxCpp).toContain('buffer_write(')
  })

  it('emits a writer reached only through a buffer wire, sized by LENGTH in SDRAM', () => {
    const d = doc(
      [
        obj('logue/util/buffer', 'b', [{ name: 'LENGTH', value: '3' }]),
        obj('logue/util/buffer-tap', 't')
      ],
      [net('in', 'l', 'b', 'in'), net('b', 'buf', 't', 'buf'), net('t', 'out', 'out', 'l')]
    )
    const { fxH } = generateFxUnit(d, { name: 'len' })
    // 262144 int16 samples = 131072 floats = 512 KB.
    expect(fxH).toContain('getBufferSize() const override final { return 131072u; }')
    const cost = estimateOscStateCost(d, 'nts1mkii')
    expect(cost.status === 'ok' && cost.estimate.sdram?.usedBytes).toBe(512 * 1024)
  })

  it('shares one buffer between several readers', () => {
    const d = doc(
      [
        obj('logue/util/buffer', 'b'),
        obj('logue/util/buffer-tap', 't1'),
        obj('logue/util/buffer-tap', 't2')
      ],
      [
        net('in', 'l', 'b', 'in'),
        {
          sources: [{ obj: 'b', outlet: 'buf' }],
          dests: [
            { obj: 't1', inlet: 'buf' },
            { obj: 't2', inlet: 'buf' }
          ]
        },
        net('t1', 'out', 'out', 'l'),
        net('t2', 'out', 'out', 'r')
      ]
    )
    const graph = resolveAudioGraph(d)
    expect(graph.activeInstances.filter((i) => i.node.name === 'b')).toHaveLength(1)
    expect(generateFxUnit(d, { name: 'two' }).fxH.match(/buffer_write\(/g)).toHaveLength(2) // helper + call
  })

  it('refuses a buffer wire into a signal inlet, and a signal into a buffer inlet', () => {
    const toSignal = doc(
      [obj('logue/util/buffer', 'b'), obj('logue/filter/lowpass-cheap', 'lp')],
      [net('in', 'l', 'b', 'in'), net('b', 'buf', 'lp', 'in'), net('lp', 'out', 'out', 'l')]
    )
    expect(() => resolveAudioGraph(toSignal)).toThrow(/can only go to a buffer inlet/)
    const toOut = doc(
      [obj('logue/util/buffer', 'b')],
      [net('in', 'l', 'b', 'in'), net('b', 'buf', 'out', 'l')]
    )
    expect(() => resolveAudioGraph(toOut)).toThrow(/can only go to a buffer inlet/)
    const fromSignal = doc(
      [obj('logue/osc/sine', 's'), obj('logue/util/buffer-tap', 't')],
      [net('s', 'out', 't', 'buf'), net('t', 'out', 'out', 'l')]
    )
    expect(() => resolveAudioGraph(fromSignal)).toThrow(/takes a buffer wire/)
    const fromAudioIn = doc(
      [obj('logue/util/buffer-tap', 't')],
      [net('in', 'l', 't', 'buf'), net('t', 'out', 'out', 'l')]
    )
    expect(() => resolveAudioGraph(fromAudioIn)).toThrow(/takes a buffer wire/)
  })

  it('reads silence from an unwired buffer inlet', () => {
    const d = doc([obj('logue/util/buffer-tap', 't')], [net('t', 'out', 'out', 'l')])
    expect(generateFxUnit(d, { name: 'none' }).fxH).toContain('float y_t = 0.f;')
  })

  it('passes a buffer wire into and out of a subpatch', () => {
    const def = (nodes: ObjNode[], nets: Net[]): PatchDocument => ({
      nodes,
      nets,
      settings: { subpatch: true },
      notes: ''
    })
    // A reader voice: a buffer comes in, audio goes out.
    const voice = def(
      [
        obj('logue/io/inlet', 'buf'),
        obj('logue/util/buffer-tap', 't'),
        obj('logue/io/outlet', 'audio')
      ],
      [net('buf', 'out', 't', 'buf'), net('t', 'out', 'audio', 'in')]
    )
    // A recorder: audio in, its buffer out.
    const rec = def(
      [obj('logue/io/inlet', 'in'), obj('logue/util/buffer', 'b'), obj('logue/io/outlet', 'buf')],
      [net('in', 'out', 'b', 'in'), net('b', 'buf', 'buf', 'in')]
    )
    const defs = new Map([
      ['sub/voice', voice],
      ['sub/rec', rec]
    ])
    const resolve = createSubpatchAwareResolver(defs)
    expect(resolve('sub/voice')!.inlets).toEqual([{ name: 'buf', role: 'buffer' }])
    expect(isBufferOutlet(resolve('sub/rec')!, 'buf')).toBe(true)

    const root = doc(
      [obj('sub/rec', 'r'), obj('sub/voice', 'v1'), obj('sub/voice', 'v2')],
      [
        net('in', 'l', 'r', 'in'),
        {
          sources: [{ obj: 'r', outlet: 'buf' }],
          dests: [
            { obj: 'v1', inlet: 'buf' },
            { obj: 'v2', inlet: 'buf' }
          ]
        },
        net('v1', 'audio', 'out', 'l'),
        net('v2', 'audio', 'out', 'r')
      ]
    )
    const { fxH } = generateFxUnit(root, { name: 'subs' }, defs)
    expect(fxH).toContain('float y_v1_t = buffer_tap_read(((const int16_t *)sdram_r_b)')
    expect(fxH).toContain('float y_v2_t = buffer_tap_read(((const int16_t *)sdram_r_b)')
  })
})

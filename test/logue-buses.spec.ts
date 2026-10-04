import { describe, it, expect } from 'vitest'
import { generateOldGenOscUnit } from '../logue-codegen/src/minilogue-xd/generateOscUnit'
import { generateFxUnit } from '../logue-codegen/src/nts1mkii/generateFxUnit'
import { generateOscUnit } from '../logue-codegen/src/nts1mkii/generateOscUnit'
import { estimateOscStateCost } from '../logue-codegen/src/estimateOscStateCost'
import { LOGUE_AUDIO_IN_TYPE, LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import {
  BusResolutionError,
  LOGUE_BUS_RECEIVE_STEREO_TYPE,
  LOGUE_BUS_RECEIVE_TYPE,
  LOGUE_BUS_SEND_STEREO_TYPE,
  LOGUE_BUS_SEND_TYPE,
  resolveBuses
} from '../logue-codegen/src/buses'
import {
  createSubpatchAwareResolver,
  LOGUE_SUBPATCH_INLET_TYPE
} from '../logue-codegen/src/subpatches'
import { findLoguePrimitive } from '../logue-codegen/src/primitives'
import type { PatchDocument, ObjNode, Net } from '../src/shared/domain/patch'
import type { ParamValue } from '../src/shared/domain/paramValueTypes'

function obj(type: string, name: string, extra: Partial<ObjNode> = {}): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params: [], ...extra }
}
function send(name: string, bus: string, params: ParamValue[] = []): ObjNode {
  return obj(LOGUE_BUS_SEND_TYPE, name, { bus, params })
}
function receive(name: string, bus: string): ObjNode {
  return obj(LOGUE_BUS_RECEIVE_TYPE, name, { bus })
}
function wire(src: string, outlet: string, dst: string, inlet: string): Net {
  return { sources: [{ obj: src, outlet }], dests: [{ obj: dst, inlet }] }
}
function doc(
  nodes: ObjNode[],
  nets: Net[],
  settings: PatchDocument['settings'] = {}
): PatchDocument {
  return { nodes, nets, settings, notes: '' }
}
const xd = (d: PatchDocument, defs = new Map<string, PatchDocument>()): string =>
  generateOldGenOscUnit(d, { name: 'bus test' }, defs).oscCpp

/** Three oscillators onto bus "mix", received into the output. */
function threeSends(): PatchDocument {
  return doc(
    [
      obj('logue/osc/saw', 'a'),
      obj('logue/osc/square', 'b'),
      obj('logue/osc/sine', 'c'),
      send('s_b', 'mix'),
      send('s_a', 'mix', [{ name: 'GAIN', value: '50' }]),
      send('s_c', 'mix'),
      receive('rx', 'mix'),
      obj(LOGUE_AUDIO_OUT_TYPE, 'out')
    ],
    [
      wire('a', 'out', 's_a', 'in'),
      wire('b', 'out', 's_b', 'in'),
      wire('c', 'out', 's_c', 'in'),
      wire('rx', 'out', 'out', 'in')
    ]
  )
}

describe('buses', () => {
  it('chains the sends in name order and feeds every receive from the last one', () => {
    const cpp = xd(threeSends())
    expect(cpp).toContain('float y_s_a = (((y_a) * gain_s_a));')
    expect(cpp).toContain('float y_s_b = ((y_s_a) + ((y_b) * gain_s_b));')
    expect(cpp).toContain('float y_s_c = ((y_s_b) + ((y_c) * gain_s_c));')
    expect(cpp).toContain('float y_rx = (y_s_c);')
    expect(cpp).toContain('gain_s_a = 50 * 0.01f;')
    expect(cpp).toContain('gain_s_b = 100 * 0.01f;')
  })

  it('leaves a document without bus nodes as the same object', () => {
    const d = doc([obj('logue/osc/saw', 'a')], [])
    expect(resolveBuses(d)).toBe(d)
  })

  it('a receive with no sends is silence; a bus nobody receives costs nothing', () => {
    const d = doc(
      [
        obj('logue/osc/saw', 'a'),
        send('s', 'elsewhere'),
        receive('rx', 'empty'),
        obj(LOGUE_AUDIO_OUT_TYPE, 'out')
      ],
      [wire('a', 'out', 's', 'in'), wire('rx', 'out', 'out', 'in')]
    )
    const cpp = xd(d)
    expect(cpp).toContain('float y_rx = (0.f);')
    expect(cpp).not.toContain('y_s ')
    expect(cpp).not.toContain('y_a ')
  })

  it('fans out: two receives of one bus read the same sum', () => {
    const d = threeSends()
    d.nodes.push(receive('rx2', 'mix'), obj('logue/mix/mix2', 'm'))
    d.nets = d.nets.filter((n) => n.sources[0].obj !== 'rx')
    d.nets.push(
      wire('rx', 'out', 'm', 'in1'),
      wire('rx2', 'out', 'm', 'in2'),
      wire('m', 'out', 'out', 'in')
    )
    const cpp = xd(d)
    expect(cpp).toContain('float y_rx = (y_s_c);')
    expect(cpp).toContain('float y_rx2 = (y_s_c);')
  })

  it('reaches across subpatches: a send inside a definition feeds the root receive', () => {
    const def = doc(
      [obj(LOGUE_SUBPATCH_INLET_TYPE, 'in'), send('s', 'verb')],
      [wire('in', 'out', 's', 'in')],
      { subpatch: true }
    )
    const defs = new Map([['sub/to-verb', def]])
    const d = doc(
      [
        obj('logue/osc/saw', 'a'),
        obj('logue/osc/square', 'b'),
        obj('sub/to-verb', 'v1'),
        obj('sub/to-verb', 'v2'),
        receive('rx', 'verb'),
        obj(LOGUE_AUDIO_OUT_TYPE, 'out')
      ],
      [wire('a', 'out', 'v1', 'in'), wire('b', 'out', 'v2', 'in'), wire('rx', 'out', 'out', 'in')]
    )
    const cpp = xd(d, defs)
    expect(cpp).toContain('float y_v1_s = (((y_a) * gain_v1_s));')
    expect(cpp).toContain('float y_v2_s = ((y_v1_s) + ((y_b) * gain_v2_s));')
    expect(cpp).toContain('float y_rx = (y_v2_s);')
    // The gauges go through the same resolution as the build.
    expect(estimateOscStateCost(d, 'minilogue-xd', defs).status).toBe('ok')
  })

  it('rejects mono and stereo nodes on one bus', () => {
    const d = doc(
      [
        obj('logue/osc/saw', 'a'),
        send('s', 'mix'),
        obj(LOGUE_BUS_RECEIVE_STEREO_TYPE, 'rx', { bus: 'mix' }),
        obj(LOGUE_AUDIO_OUT_TYPE, 'out')
      ],
      [wire('a', 'out', 's', 'in'), wire('rx', 'l', 'out', 'in')]
    )
    expect(() => xd(d)).toThrow(BusResolutionError)
    expect(() => xd(d)).toThrow(/Bus "mix" has both mono and stereo nodes/)
  })

  it('names the bus when a loop closes through one', () => {
    const d = doc(
      [
        obj('logue/osc/saw', 'a'),
        obj('logue/mix/mix2', 'm'),
        send('s', 'fb'),
        receive('rx', 'fb'),
        obj(LOGUE_AUDIO_OUT_TYPE, 'out')
      ],
      [
        wire('a', 'out', 'm', 'in1'),
        wire('rx', 'out', 'm', 'in2'),
        wire('m', 'out', 's', 'in'),
        wire('m', 'out', 'out', 'in')
      ]
    )
    expect(() => xd(d)).toThrow(/feedback loop.*sample-delay.*A bus counts as a wire/s)
  })

  it('a loop through a bus is fine with a sample-delay in it', () => {
    const d = doc(
      [
        obj('logue/osc/saw', 'a'),
        obj('logue/mix/mix2', 'm'),
        obj('logue/util/sample-delay', 'z'),
        send('s', 'fb'),
        receive('rx', 'fb'),
        obj(LOGUE_AUDIO_OUT_TYPE, 'out')
      ],
      [
        wire('a', 'out', 'm', 'in1'),
        wire('rx', 'out', 'z', 'in'),
        wire('z', 'out', 'm', 'in2'),
        wire('m', 'out', 's', 'in'),
        wire('m', 'out', 'out', 'in')
      ]
    )
    expect(xd(d)).toContain('float y_rx = (y_s);')
  })

  it('stereo buses in an effect: sends chain per side', () => {
    const d = doc(
      [
        obj(LOGUE_AUDIO_IN_TYPE, 'audio-in'),
        obj('logue/mix/pan', 'p'),
        obj(LOGUE_BUS_SEND_STEREO_TYPE, 'dry', { bus: 'out' }),
        obj(LOGUE_BUS_SEND_STEREO_TYPE, 'wet', { bus: 'out' }),
        obj(LOGUE_BUS_RECEIVE_STEREO_TYPE, 'rx', { bus: 'out' }),
        obj(LOGUE_AUDIO_OUT_TYPE, 'audio-out')
      ],
      [
        wire('audio-in', 'l', 'dry', 'l'),
        wire('audio-in', 'r', 'dry', 'r'),
        wire('audio-in', 'mono', 'p', 'in'),
        wire('p', 'l', 'wet', 'l'),
        wire('p', 'r', 'wet', 'r'),
        wire('rx', 'l', 'audio-out', 'l'),
        wire('rx', 'r', 'audio-out', 'r')
      ],
      { logueTarget: { module: 'modfx' } }
    )
    const unit = generateFxUnit(d, { name: 'bus fx' }).fxH
    expect(unit).toMatch(/float y_wet_l = \(y_dry_l\) \+ \(\(y_p_l\) \* gain_wet\);/)
    expect(unit).toMatch(/float y_rx_r = y_wet_r;/)
  })

  it("a send's GAIN can be a menu param (xd) or follow a knob (NTS-1 mkII)", () => {
    const d = threeSends()
    const sa = d.nodes.find((n) => n.name === 's_a') as ObjNode
    sa.params = [
      {
        name: 'GAIN',
        value: '50',
        logueParamIndex: { 'minilogue-xd': 0 },
        logueKnob: { nts1mkii: 'shape' }
      }
    ]
    const xdUnit = generateOldGenOscUnit(d, { name: 'bus test' })
    expect(xdUnit.manifestJson).toMatch(/"GAIN"/)
    expect(xdUnit.oscCpp).toMatch(/gain_s_a = /)
    const nts1 = generateOscUnit(d, { name: 'bus test' })
    expect(nts1.unitCc + nts1.oscH).toMatch(/gain_s_a = .*shape01_/)
  })

  it('a mixer with a bus set sends its own output there, no send node', () => {
    const d = doc(
      [
        obj('logue/osc/saw', 'a'),
        obj('logue/osc/square', 'b'),
        obj('logue/osc/sine', 'c'),
        obj('logue/mix/mix2', 'm', { bus: 'mix' }),
        send('s_c', 'mix'),
        receive('rx', 'mix'),
        obj(LOGUE_AUDIO_OUT_TYPE, 'out')
      ],
      [
        wire('a', 'out', 'm', 'in1'),
        wire('b', 'out', 'm', 'in2'),
        wire('c', 'out', 's_c', 'in'),
        wire('rx', 'out', 'out', 'in')
      ]
    )
    const cpp = xd(d)
    expect(cpp).toContain('float y_m = (((y_a) * gain1_m) + ((y_b) * gain2_m));')
    expect(cpp).toContain('float y_m__bus = (((y_m) * gain_m__bus));')
    expect(cpp).toContain('gain_m__bus = 100 * 0.01f;')
    expect(cpp).toContain('float y_s_c = ((y_m__bus) + ((y_c) * gain_s_c));')
    expect(cpp).toContain('float y_rx = (y_s_c);')
  })

  it('a stereo mixer sends both sides; a mono one on a stereo bus is an error', () => {
    const stereo = doc(
      [
        obj('logue/osc/saw', 'a'),
        obj('logue/mix/pan', 'p', { bus: 'out' }),
        obj(LOGUE_BUS_RECEIVE_STEREO_TYPE, 'rx', { bus: 'out' }),
        obj('logue/mix/mix2', 'r_only'),
        obj(LOGUE_AUDIO_OUT_TYPE, 'out')
      ],
      [
        wire('a', 'out', 'p', 'in'),
        wire('rx', 'r', 'r_only', 'in1'),
        wire('r_only', 'out', 'out', 'in')
      ]
    )
    const cpp = xd(stereo)
    expect(cpp).toMatch(/float y_p__bus_r = \(\(y_p_r\) \* gain_p__bus\);/)
    expect(cpp).toContain('float y_rx_r = y_p__bus_r;')
    stereo.nodes.push(obj('logue/mix/crossfader', 'xf', { bus: 'out' }))
    expect(() => xd(stereo)).toThrow(/Bus "out" has both mono and stereo nodes/)
  })

  it('a bus field on a node that cannot send is ignored', () => {
    const d = doc(
      [obj('logue/osc/saw', 'a', { bus: 'mix' }), obj(LOGUE_AUDIO_OUT_TYPE, 'out')],
      [wire('a', 'out', 'out', 'in')]
    )
    expect(resolveBuses(d)).toBe(d)
  })

  it('the canvas resolves the placed bus types to stand-ins the registry never lists', () => {
    const resolve = createSubpatchAwareResolver(new Map())
    expect(resolve(LOGUE_BUS_SEND_TYPE)?.params?.map((p) => p.name)).toEqual(['GAIN'])
    expect(resolve(LOGUE_BUS_SEND_TYPE)?.outlets).toEqual([])
    expect(resolve(LOGUE_BUS_RECEIVE_TYPE)?.inlets).toEqual([])
    expect(findLoguePrimitive(LOGUE_BUS_SEND_TYPE)).toBeUndefined()
    expect(findLoguePrimitive('logue/mix/bus-send')?.internal).toBe(true)
  })
})

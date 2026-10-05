/**
 * NTS-1 mkII effect test units that were measured on a real device with the CPU probe
 * (`stageFxUnits.ts` stages them), plus the small document builders they use.
 */
import { LOGUE_AUDIO_IN_TYPE, LOGUE_AUDIO_OUT_TYPE } from '../src/oscInstances'
import type { LogueModule, Net, ObjNode, PatchDocument } from '../../src/shared/domain/patch'
import type { ParamValue } from '../../src/shared/domain/paramValueTypes'

export function obj(name: string, type: string, params: ParamValue[] = []): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params }
}
export function wire(from: string, outlet: string, to: string, inlet: string): Net {
  return { sources: [{ obj: from, outlet }], dests: [{ obj: to, inlet }] }
}
export function doc(module: LogueModule, nodes: ObjNode[], nets: Net[]): PatchDocument {
  return { nodes, nets, settings: { logueTarget: { module } }, notes: '' }
}
export const IN = obj('in', LOGUE_AUDIO_IN_TYPE)
export const OUT = obj('out', LOGUE_AUDIO_OUT_TYPE)

export const onKnob = (knob: 'time' | 'depth' | 'mix'): Pick<ParamValue, 'logueKnob'> => ({
  logueKnob: { nts1mkii: knob }
})

/**
 * grain-mill phase 1 (docs/PLAN-grain-mill.md): a 2.7 s util/buffer of the mono input read by
 * `taps` buffer-taps. TIME = the first tap's position (0..100 % of the buffer), the others fixed at
 * 25/50/75 %; DEPTH past 95 % freezes the buffer (a sense/control into logic/greater-than); MIX =
 * dry/wet on both sides. With the CPU probe: buf4 - buf1 is three taps.
 */
export function bufferTest(taps: 1 | 4): PatchDocument {
  const tapNames = Array.from({ length: taps }, (_, i) => `t${i + 1}`)
  const [left, right] =
    taps === 1
      ? [
          { obj: 't1', outlet: 'out' },
          { obj: 't1', outlet: 'out' }
        ]
      : [
          { obj: 'ml', outlet: 'out' },
          { obj: 'mr', outlet: 'out' }
        ]
  return doc(
    'delfx',
    [
      IN,
      obj('b', 'logue/util/buffer', [{ name: 'LENGTH', value: '2' }]),
      obj('d', 'logue/sense/control', [{ name: 'VALUE', value: '0', ...onKnob('depth') }]),
      obj('frz', 'logue/logic/greater-than', [{ name: 'THRESHOLD', value: '95' }]),
      ...tapNames.map((n, i) =>
        obj(
          n,
          'logue/util/buffer-tap',
          i === 0
            ? [{ name: 'TIME', value: '20', ...onKnob('time') }]
            : [{ name: 'TIME', value: String(25 * i) }]
        )
      ),
      ...(taps === 4 ? [obj('ml', 'logue/mix/mix2'), obj('mr', 'logue/mix/mix2')] : []),
      ...['xl', 'xr'].map((n) =>
        obj(n, 'logue/mix/crossfader', [{ name: 'FADE', value: '50', ...onKnob('mix') }])
      ),
      OUT
    ],
    [
      wire('in', 'mono', 'b', 'in'),
      wire('d', 'unipolar', 'frz', 'a'),
      wire('frz', 'out', 'b', 'freeze'),
      ...tapNames.map((n) => wire('b', 'buf', n, 'buf')),
      ...(taps === 4
        ? [
            wire('t1', 'out', 'ml', 'in1'),
            wire('t2', 'out', 'ml', 'in2'),
            wire('t3', 'out', 'mr', 'in1'),
            wire('t4', 'out', 'mr', 'in2')
          ]
        : []),
      wire('in', 'l', 'xl', 'in1'),
      wire(left.obj, left.outlet, 'xl', 'in2'),
      wire('in', 'r', 'xr', 'in1'),
      wire(right.obj, right.outlet, 'xr', 'in2'),
      wire('xl', 'out', 'out', 'l'),
      wire('xr', 'out', 'out', 'r')
    ]
  )
}
/**
 * grain-mill phase 2: one util/grain on a 2.7 s buffer of the mono input, retriggered by a square
 * LFO. TIME = the LFO's RATE (0.1..20 Hz, so a new grain up to 20 times a second), DEPTH = SIZE
 * (10 ms..1.4 s) and, past 95 %, freeze; MIX = dry/wet; menu: POSITION (Param 4), FADE (Param 5),
 * then the CPU probe.
 */
export const GRAIN_TEST = doc(
  'delfx',
  [
    IN,
    obj('b', 'logue/util/buffer', [{ name: 'LENGTH', value: '2' }]),
    obj('d', 'logue/sense/control', [{ name: 'VALUE', value: '50', ...onKnob('depth') }]),
    obj('frz', 'logue/logic/greater-than', [{ name: 'THRESHOLD', value: '95' }]),
    obj('clk', 'logue/lfo/square-lfo', [{ name: 'RATE', value: '40', ...onKnob('time') }]),
    obj('g', 'logue/util/grain', [
      { name: 'SIZE', value: '50', ...onKnob('depth') },
      { name: 'POSITION', value: '20', logueParamIndex: { nts1mkii: 3 } },
      { name: 'FADE', value: '10', logueParamIndex: { nts1mkii: 4 } }
    ]),
    ...['xl', 'xr'].map((n) =>
      obj(n, 'logue/mix/crossfader', [{ name: 'FADE', value: '100', ...onKnob('mix') }])
    ),
    OUT
  ],
  [
    wire('in', 'mono', 'b', 'in'),
    wire('d', 'unipolar', 'frz', 'a'),
    wire('frz', 'out', 'b', 'freeze'),
    wire('b', 'buf', 'g', 'buf'),
    wire('clk', 'out', 'g', 'trig'),
    wire('in', 'l', 'xl', 'in1'),
    wire('g', 'out', 'xl', 'in2'),
    wire('in', 'r', 'xr', 'in1'),
    wire('g', 'out', 'xr', 'in2'),
    wire('xl', 'out', 'out', 'l'),
    wire('xr', 'out', 'out', 'r')
  ]
)

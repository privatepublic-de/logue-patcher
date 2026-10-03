/**
 * Writes the example effect patches (phase 6 of "effect patches", 2026-09-30) into
 * examples/effects/, as ordinary .loguepatch files to open in the app:
 * - stereo-reverb (revfx): a Freeverb-style reverb from primitives. Per side 4 damped feedback
 *   combs (logue/util/long-delay, RANGE 0.34 s, MIX 100) averaged, then 2 allpass diffusers
 *   (logue/filter/allpass) in series, then a crossfader against the dry side. Delay lengths are
 *   Freeverb's (1116/1277/1422/1557 comb, 556/441 allpass samples at 44.1 kHz) scaled to 48 kHz,
 *   the right side 23 samples longer (Freeverb's stereo spread). TIME = decay (every comb's
 *   FEEDBACK), DEPTH = damping (every comb's DAMPING), MIX = dry/wet.
 * - auto-wah (modfx): the input's level (logue/env/follower) opens an svf lowpass; TIME = the
 *   filter's resonance, DEPTH = the follower's gain.
 * - tempo-swell (modfx): each beat division (logue/sense/tempo) fades the input in (a VCA on
 *   the tempo ramp); TIME picks the division.
 * - freq-shifter (modfx): a stereo Bode frequency shifter (logue/util/freq-shift per side).
 *   TIME = SHIFT (through zero at the middle), DEPTH = FEEDBACK. The right output crossfades
 *   from its own shifted signal to the mirror (SPREAD): 0 shifts both sides the same way, 100
 *   moves them apart, 50 is both sidebands at once (ring modulation). NTS-1 mkII menu: MIX
 *   (the right side's follows it) and SPREAD; on the xd both stay at their authored values.
 *
 * - grain-mill (delfx, NTS-1 mkII): the user's Axoloti grain-mill from buffer/grain primitives,
 *   with its voice as grain-voice.loguesub next to it (a patch folder's own subpatches come
 *   first); see grainMill().
 *
 * - reverse-wash (delfx, NTS-1 mkII; builds for both) and reverse-wash-xd (delfx, the xd's lighter
 *   version): a stereo reverse delay from logue/util/reverse-tap; see reverseWash().
 *
 * Usage: npx tsx logue-codegen/scripts/writeEffectExamples.ts
 */
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { serializePatchFile } from '../../src/shared/json/patchCodec'
import type { LogueModule, Net, ObjNode, PatchDocument } from '../../src/shared/domain/patch'
import type { LogueKnob, ParamValue } from '../../src/shared/domain/paramValueTypes'

const outDir = join(dirname(new URL(import.meta.url).pathname), '..', '..', 'examples', 'effects')

function obj(name: string, type: string, x: number, y: number, params: ParamValue[] = []): ObjNode {
  return { kind: 'obj', type, name, x, y, params }
}
function wire(from: string, outlet: string, to: string, inlet: string): Net {
  return { sources: [{ obj: from, outlet }], dests: [{ obj: to, inlet }] }
}
// The same knob on both devices (the xd's `mix` is Shift+Depth).
const onKnob = (knob: LogueKnob): Pick<ParamValue, 'logueKnob'> => ({
  logueKnob: { nts1mkii: knob, 'minilogue-xd': knob }
})
function doc(
  module: LogueModule,
  unitName: string,
  nodes: ObjNode[],
  nets: Net[],
  notes: string
): PatchDocument {
  return { nodes, nets, settings: { logueTarget: { module }, unitName }, notes }
}

const at48k = (samples44k: number): number => Math.round((samples44k * 48000) / 44100)
// logue/util/long-delay at RANGE 0 (16384 floats): delay = 1 + TIME% * (16384 - 3).
const combTime = (samples: number): string => (((samples - 1) / 16381) * 100).toFixed(4)
// logue/filter/allpass: delay = (0.5 + 99.5 * t^2) ms, rounded to whole samples.
const allpassTime = (samples: number): string =>
  (Math.sqrt((samples / 48 - 0.5) / 99.5) * 100).toFixed(4)

function reverb(): PatchDocument {
  // A long-delay node is ~430 px tall on the canvas (seven params), an allpass ~220, a mix ~170.
  const nodes: ObjNode[] = [obj('audio-in', 'logue/io/audio-in', 0, 1880)]
  const nets: Net[] = []
  const sides = [
    ['l', 0, 0],
    ['r', 23, 2000]
  ] as const
  const combs = sides.map(([side, spread, y0]) =>
    [1116, 1277, 1422, 1557].map((len, i) => {
      const name = `comb_${side}${i + 1}`
      nodes.push(
        obj(name, 'logue/util/long-delay', 320, y0 + i * 480, [
          { name: 'RANGE', value: '0' },
          { name: 'TIME', value: combTime(at48k(len + spread)) },
          { name: 'FEEDBACK', value: '84', ...onKnob('time') },
          { name: 'DAMPING', value: '50', ...onKnob('depth') },
          { name: 'MIX', value: '100' }
        ])
      )
      nets.push(wire('audio-in', side, name, 'in'))
      return name
    })
  )
  nodes.push(
    obj('sum_a', 'logue/mix/stereo-mix2', 720, 1380),
    obj('sum_b', 'logue/mix/stereo-mix2', 720, 2340),
    obj('sum', 'logue/mix/stereo-mix2', 960, 1860)
  )
  for (const [k, [side]] of sides.entries()) {
    nets.push(
      wire(combs[k][0], 'out', 'sum_a', `${side}1`),
      wire(combs[k][1], 'out', 'sum_a', `${side}2`),
      wire(combs[k][2], 'out', 'sum_b', `${side}1`),
      wire(combs[k][3], 'out', 'sum_b', `${side}2`),
      wire('sum_a', side, 'sum', `${side}1`),
      wire('sum_b', side, 'sum', `${side}2`)
    )
  }
  for (const [side, spread, y0] of sides) {
    const ap1 = `diffuse_${side}1`
    const ap2 = `diffuse_${side}2`
    nodes.push(
      obj(ap1, 'logue/filter/allpass', 1200, y0 + 620, [
        { name: 'TIME', value: allpassTime(at48k(556 + spread)) },
        { name: 'GAIN', value: '55.6' }
      ]),
      obj(ap2, 'logue/filter/allpass', 1200, y0 + 900, [
        { name: 'TIME', value: allpassTime(at48k(441 + spread)) },
        { name: 'GAIN', value: '55.6' }
      ])
    )
    nets.push(
      wire('sum', side, ap1, 'in'),
      wire(ap1, 'out', ap2, 'in'),
      wire('audio-in', side, 'mix', `${side}1`),
      wire(ap2, 'out', 'mix', `${side}2`),
      wire('mix', side, 'audio-out', side)
    )
  }
  nodes.push(
    obj('mix', 'logue/mix/stereo-crossfader', 1480, 1820, [
      { name: 'FADE', value: '35', ...onKnob('mix') }
    ])
  )
  nodes.push(obj('audio-out', 'logue/io/audio-out', 1760, 1880))
  return doc(
    'revfx',
    'LP Reverb',
    nodes,
    nets,
    'Freeverb-style stereo reverb from primitives: 4 damped combs and 2 allpasses per side. TIME = decay, DEPTH = damping, MIX = dry/wet.'
  )
}

function autoWah(): PatchDocument {
  return doc(
    'modfx',
    'LP AutoWah',
    [
      obj('audio-in', 'logue/io/audio-in', 0, 200),
      obj('level', 'logue/env/follower', 260, 40, [
        { name: 'ATTACK', value: '20' },
        { name: 'RELEASE', value: '30' },
        { name: 'GAIN', value: '60', ...onKnob('depth') }
      ]),
      obj('wah', 'logue/filter/svf', 560, 160, [
        { name: 'CUTOFF', value: '0' },
        { name: 'RESONANCE', value: '70', ...onKnob('time') }
      ]),
      obj('audio-out', 'logue/io/audio-out', 860, 200)
    ],
    [
      wire('audio-in', 'mono', 'level', 'in'),
      wire('level', 'out', 'wah', 'cutoff'),
      wire('audio-in', 'mono', 'wah', 'in'),
      wire('wah', 'lp', 'audio-out', 'l')
    ],
    "The input's level opens a resonant lowpass. TIME = resonance, DEPTH = sensitivity."
  )
}

function tempoSwell(): PatchDocument {
  return doc(
    'modfx',
    'LP Swell',
    [
      obj('audio-in', 'logue/io/audio-in', 0, 200),
      obj('beat', 'logue/sense/tempo', 240, 40, [
        { name: 'DIVISION', value: '2', ...onKnob('time') }
      ]),
      obj('amp_l', 'logue/gain/vca', 520, 120),
      obj('amp_r', 'logue/gain/vca', 520, 320),
      obj('audio-out', 'logue/io/audio-out', 800, 200)
    ],
    [
      wire('beat', 'ramp', 'amp_l', 'gain'),
      wire('beat', 'ramp', 'amp_r', 'gain'),
      wire('audio-in', 'l', 'amp_l', 'in'),
      wire('audio-in', 'r', 'amp_r', 'in'),
      wire('amp_l', 'out', 'audio-out', 'l'),
      wire('amp_r', 'out', 'audio-out', 'r')
    ],
    'Each beat division fades the input in, at the device tempo. TIME = the division.'
  )
}

function freqShifter(): PatchDocument {
  const shift = (name: string, y: number, mix: Partial<ParamValue>): ObjNode =>
    obj(name, 'logue/util/freq-shift', 260, y, [
      { name: 'SHIFT', value: '15', ...onKnob('time') },
      { name: 'FEEDBACK', value: '0', ...onKnob('depth') },
      { name: 'MIX', value: '100', ...mix }
    ])
  return doc(
    'modfx',
    'LP FreqShift',
    [
      obj('audio-in', 'logue/io/audio-in', 0, 200),
      shift('shift_l', 20, { logueParamIndex: { nts1mkii: 2 } }),
      shift('shift_r', 300, { logueFollow: { nts1mkii: 2 } }),
      obj('spread', 'logue/mix/crossfader', 560, 320, [
        { name: 'FADE', value: '100', label: 'SPREAD', logueParamIndex: { nts1mkii: 3 } }
      ]),
      obj('audio-out', 'logue/io/audio-out', 820, 200)
    ],
    [
      wire('audio-in', 'l', 'shift_l', 'in'),
      wire('audio-in', 'r', 'shift_r', 'in'),
      wire('shift_l', 'shifted', 'audio-out', 'l'),
      wire('shift_r', 'shifted', 'spread', 'in1'),
      wire('shift_r', 'mirror', 'spread', 'in2'),
      wire('spread', 'out', 'audio-out', 'r')
    ],
    'A stereo frequency shifter: every partial moves by the same number of Hz, for metallic, inharmonic sounds. TIME = shift (zero at the middle), DEPTH = feedback. SPREAD sends the right side the other way (50 = ring modulation). A few Hz at MIX 50 is a barber-pole phaser.'
  )
}

/** NTS-1 mkII only for now: its knobs and menu slots (the xd variant is a later phase). */
const ntsKnob = (knob: LogueKnob): Pick<ParamValue, 'logueKnob'> => ({
  logueKnob: { nts1mkii: knob }
})
const ntsSlot = (slot: number, label: string): Pick<ParamValue, 'logueParamIndex' | 'label'> => ({
  logueParamIndex: { nts1mkii: slot },
  label
})
const ntsFollow = (slot: number): Pick<ParamValue, 'logueFollow'> => ({
  logueFollow: { nts1mkii: slot }
})

/** One grain voice: grain -> AD envelope (exponential decay) -> VCA -> pan onto the bus. */
function grainVoice(): PatchDocument {
  return {
    nodes: [
      obj('buf', 'logue/io/inlet', 0, 0),
      obj('trig', 'logue/io/inlet', 0, 120),
      obj('position', 'logue/io/inlet', 0, 240),
      obj('bus-l', 'logue/io/inlet', 0, 360),
      obj('bus-r', 'logue/io/inlet', 0, 480),
      // Attack and decay as signals (0..2 = 0..100 %, the envelope's inlets add 50 per unit),
      // so one ENV knob can trade one for the other (see grainMill).
      obj('attack', 'logue/io/inlet', 0, 600),
      obj('decay', 'logue/io/inlet', 0, 720),
      // Added to SIZE (the xd variants: Depth there scales 50..100, not the knob's whole range).
      obj('size', 'logue/io/inlet', 0, 840),
      obj('grain', 'logue/util/grain', 260, 0, [
        // Per instance: where each voice reads from (the xd variants' fixed offsets); the
        // position inlet adds the motion on top (the NTS-1 mkII example).
        { name: 'POSITION', value: '0', subpatchExpose: { outerName: 'POSITION' } },
        // Every voice's SIZE on the NTS-1 mkII's DEPTH knob: a knob binding inside a definition
        // is shared. The xd variants feed the size inlet instead.
        { name: 'SIZE', value: '50', ...ntsKnob('depth') },
        { name: 'FADE', value: '10' }
      ]),
      obj('env', 'logue/env/ad', 260, 380, [
        { name: 'ATTACK', value: '0' },
        { name: 'DECAY', value: '0' },
        { name: 'EXP', value: '100' }
      ]),
      obj('vca', 'logue/gain/vca', 520, 120),
      obj('pan', 'logue/mix/pan', 740, 240, [
        { name: 'PAN', value: '0', subpatchExpose: { outerName: 'PAN' } }
      ]),
      obj('l', 'logue/io/outlet', 980, 200),
      obj('r', 'logue/io/outlet', 980, 320)
    ],
    nets: [
      wire('buf', 'out', 'grain', 'buf'),
      wire('trig', 'out', 'grain', 'trig'),
      wire('trig', 'out', 'env', 'trig'),
      wire('position', 'out', 'grain', 'position'),
      wire('size', 'out', 'grain', 'size'),
      wire('attack', 'out', 'env', 'attack'),
      wire('decay', 'out', 'env', 'decay'),
      wire('grain', 'out', 'vca', 'in'),
      wire('env', 'out', 'vca', 'gain'),
      wire('vca', 'out', 'pan', 'in'),
      wire('bus-l', 'out', 'pan', 'l'),
      wire('bus-r', 'out', 'pan', 'r'),
      wire('pan', 'l', 'l', 'in'),
      wire('pan', 'r', 'r', 'in')
    ],
    settings: { subpatch: true },
    notes:
      'One grain-mill voice: a looping grain from the buffer, an AD envelope with exponential decay, panned onto the stereo bus coming in on bus-l/bus-r.'
  }
}

/**
 * The grain envelope's attack and decay from one 0..1 signal t (see grainMill's ENV): nodes
 * env-attack / env-decay carry them, in the envelope's inlet units.
 */
function envCurve(t: { obj: string; outlet: string }): { nodes: ObjNode[]; nets: Net[] } {
  return {
    nodes: [
      obj('env-one', 'logue/util/constant', 500, 1220, [{ name: 'VALUE', value: '100' }]),
      obj('env-short', 'logue/util/constant', 500, 1340, [{ name: 'VALUE', value: '20' }]),
      obj('env-1-t', 'logue/math/subtract', 740, 1220),
      obj('env-t(1-t)', 'logue/math/multiply', 980, 1220),
      obj('env-2x', 'logue/math/add', 1220, 1220),
      obj('env-bump', 'logue/math/add', 1460, 1220),
      obj('env-0.8', 'logue/math/scale', 1700, 1220, [{ name: 'FACTOR', value: '80' }]),
      obj('env-1.8', 'logue/math/add', 1940, 1220),
      obj('env-length', 'logue/math/add', 2180, 1220),
      obj('env-attack', 'logue/math/multiply', 2420, 1100),
      obj('env-decay', 'logue/math/multiply', 2420, 1340)
    ],
    nets: [
      wire('env-one', 'out', 'env-1-t', 'a'),
      wire(t.obj, t.outlet, 'env-1-t', 'b'),
      wire(t.obj, t.outlet, 'env-t(1-t)', 'in1'),
      wire('env-1-t', 'out', 'env-t(1-t)', 'in2'),
      wire('env-t(1-t)', 'out', 'env-2x', 'a'),
      wire('env-t(1-t)', 'out', 'env-2x', 'b'),
      wire('env-2x', 'out', 'env-bump', 'a'),
      wire('env-2x', 'out', 'env-bump', 'b'),
      wire('env-bump', 'out', 'env-0.8', 'in'),
      wire('env-bump', 'out', 'env-1.8', 'a'),
      wire('env-0.8', 'out', 'env-1.8', 'b'),
      wire('env-1.8', 'out', 'env-length', 'a'),
      wire('env-short', 'out', 'env-length', 'b'),
      wire(t.obj, t.outlet, 'env-attack', 'in1'),
      wire('env-length', 'out', 'env-attack', 'in2'),
      wire('env-1-t', 'out', 'env-decay', 'in1'),
      wire('env-length', 'out', 'env-decay', 'in2')
    ]
  }
}

// The NTS-1 mkII delay's menu slots (0-2 are TIME/DEPTH/MIX).
const SLOT = {
  motAmt: 3,
  motSpd: 4,
  motTyp: 5,
  feedback: 6,
  width: 7,
  env: 8,
  chance: 9,
  mode: 10
}
const VOICES = 8
/** On a real xd (user, 2026-10-01), with the factory mod and reverb running too: 4 and 3 voices
 *  crackled, 2 stayed clean. The effects MCU is shared by all three slots. */
const XD_VOICES = 2

/**
 * grain-mill (after the user's Axoloti patch, docs/PLAN-grain-mill.md): the input (plus feedback)
 * records into a 5.5 s buffer; a clock (free, tempo, or either thinned to half its ticks) hands
 * each tick to the next of 8 looping grain voices, which grab SIZE of the buffer from a position a
 * motion LFO wanders over, alternately left and right.
 */
function grainMill(): PatchDocument {
  const nodes: ObjNode[] = [
    obj('audio-in', 'logue/io/audio-in', 0, 700),
    obj('in+fb', 'logue/math/add', 260, 700),
    obj('buffer', 'logue/util/buffer', 500, 700, [{ name: 'LENGTH', value: '3' }]),
    obj('depth', 'logue/sense/control', 0, 1000, [
      { name: 'VALUE', value: '50', ...ntsKnob('depth') }
    ]),
    obj('freeze', 'logue/logic/greater-than', 260, 1000, [{ name: 'THRESHOLD', value: '95' }]),
    // Clock: TIME is the free rate and, synced, the tempo division.
    // The nodes feeding the two selectors (MODE, MOT TYP) are named for their device choice
    // strings: a mux's choices show the names of the nodes wired into it (`_` as a space).
    obj('FREE', 'logue/lfo/square-lfo', 0, 0, [{ name: 'RATE', value: '40', ...ntsKnob('time') }]),
    obj('SYNC', 'logue/sense/tempo', 0, 220, [
      { name: 'DIVISION', value: '2', ...ntsKnob('time') }
    ]),
    // CHANCE: how many ticks the random modes keep (the Axoloti patch's fixed 50 %).
    obj('RND', 'logue/logic/chance', 260, 0, [
      { name: 'CHANCE', value: '50', ...ntsSlot(SLOT.chance, 'CHANCE') }
    ]),
    obj('RND_SYN', 'logue/logic/chance', 260, 220, [
      { name: 'CHANCE', value: '50', ...ntsFollow(SLOT.chance) }
    ]),
    obj('mode', 'logue/mux/mux4', 500, 60, [
      { name: 'INDEX', value: '0', ...ntsSlot(SLOT.mode, 'MODE') }
    ]),
    obj('voices', 'logue/logic/round-robin', 740, 60, [{ name: 'VOICES', value: String(VOICES) }]),
    // Motion: saw down / saw up / triangle / random, at one speed, scaled by the amount.
    obj('SAW_DN', 'logue/lfo/ramp-down', 0, 400, [
      { name: 'RATE', value: '20', ...ntsSlot(SLOT.motSpd, 'MOT SPD') }
    ]),
    ...(
      [
        ['SAW_UP', 'logue/lfo/ramp-up', 520],
        ['TRI', 'logue/lfo/triangle-lfo', 640],
        ['RANDOM', 'logue/lfo/random-steps', 760]
      ] as const
    ).map(([name, type, y]) =>
      obj(name, type, 0, y, [{ name: 'RATE', value: '20', ...ntsFollow(SLOT.motSpd) }])
    ),
    obj('motion', 'logue/mux/mux4', 260, 400, [
      { name: 'INDEX', value: '0', ...ntsSlot(SLOT.motTyp, 'MOT TYP') }
    ]),
    obj('motion-01', 'logue/util/bipolar-to-unipolar', 500, 400),
    obj('amount', 'logue/sense/control', 500, 520, [
      { name: 'VALUE', value: '30', ...ntsSlot(SLOT.motAmt, 'MOT AMT') }
    ]),
    obj('position', 'logue/math/multiply', 740, 400),
    // ENV (t = 0..1) morphs the grain envelope and its length together: |\ short and harsh at 0,
    // /\ long and smooth at 50, /| short again at 100 (user's call). length = 0.2 + 1.8 *
    // 4t(1-t), attack = t * length, decay = (1-t) * length, in the envelope's inlet units (1 =
    // 50 %): a 10 % (~200 ms) stage at either end, 50 % (~1 s) each in the middle.
    obj('env', 'logue/sense/control', 500, 1100, [
      { name: 'VALUE', value: '25', ...ntsSlot(SLOT.env, 'ENV') }
    ]),
    ...envCurve({ obj: 'env', outlet: 'unipolar' }).nodes
  ]
  const nets: Net[] = [
    wire('audio-in', 'mono', 'in+fb', 'a'),
    wire('in+fb', 'out', 'buffer', 'in'),
    wire('depth', 'unipolar', 'freeze', 'a'),
    wire('freeze', 'out', 'buffer', 'freeze'),
    wire('FREE', 'out', 'RND', 'trig'),
    wire('SYNC', 'clock', 'RND_SYN', 'trig'),
    wire('FREE', 'out', 'mode', 'i1'),
    wire('SYNC', 'clock', 'mode', 'i2'),
    wire('RND', 'out', 'mode', 'i3'),
    wire('RND_SYN', 'out', 'mode', 'i4'),
    wire('mode', 'out', 'voices', 'trig'),
    wire('SAW_DN', 'out', 'motion', 'i1'),
    wire('SAW_UP', 'out', 'motion', 'i2'),
    wire('TRI', 'out', 'motion', 'i3'),
    wire('RANDOM', 'out', 'motion', 'i4'),
    wire('motion', 'out', 'motion-01', 'in'),
    wire('motion-01', 'out', 'position', 'in1'),
    wire('amount', 'unipolar', 'position', 'in2'),
    ...envCurve({ obj: 'env', outlet: 'unipolar' }).nets
  ]
  // Eight voices on one bus, alternately hard left and right.
  for (let k = 1; k <= VOICES; k++) {
    const name = `voice${k}`
    nodes.push(
      obj(name, 'sub/grain-voice', 1000 + (k - 1) * 240, 200 + (k % 2) * 60, [
        { name: 'PAN', value: k % 2 ? '-100' : '100' }
      ])
    )
    nets.push(
      wire('buffer', 'buf', name, 'buf'),
      wire('voices', `o${k}`, name, 'trig'),
      wire('position', 'out', name, 'position'),
      wire('env-attack', 'out', name, 'attack'),
      wire('env-decay', 'out', name, 'decay')
    )
    if (k > 1)
      nets.push(
        wire(`voice${k - 1}`, 'l', name, 'bus-l'),
        wire(`voice${k - 1}`, 'r', name, 'bus-r')
      )
  }
  const last = `voice${VOICES}`
  const x = 1000 + VOICES * 240
  nodes.push(
    // Feedback: both sides (half their sum), a ~50 Hz highpass, the FEEDBACK amount, a soft clip (eight
    // voices summed can run away: without it FEEDBK 60+ ended in a clipped noise wall), into
    // the buffer.
    obj('fb-sum', 'logue/mix/mix2', x, 700, [
      // Half the sum: FEEDBK 100 = the summed voices (the Axoloti patch's +_2) at 50, where the
      // loop just starts to build up -- the full sum at 100 was too loud (user, a real NTS-1 mkII).
      { name: 'GAIN1', value: '50' },
      { name: 'GAIN2', value: '50' }
    ]),
    obj('fb-hp', 'logue/filter/highpass-cheap', x + 240, 700, [{ name: 'CUTOFF', value: '19' }]),
    // FEEDBK 0..100 (the original's 0..1): a control times the signal, not math/scale, whose
    // FACTOR is bipolar.
    obj('feedback', 'logue/sense/control', x + 480, 860, [
      { name: 'VALUE', value: '30', ...ntsSlot(SLOT.feedback, 'FEEDBK') }
    ]),
    obj('fb-amt', 'logue/math/multiply', x + 480, 700),
    obj('fb-sat', 'logue/shape/soft-clip', x + 720, 700),
    obj('width', 'logue/mix/width', x, 200, [
      { name: 'WIDTH', value: '100', ...ntsSlot(SLOT.width, 'WIDTH') }
    ]),
    obj('mix', 'logue/mix/stereo-crossfader', x + 480, 140, [
      { name: 'FADE', value: '50', ...ntsKnob('mix') }
    ]),
    obj('audio-out', 'logue/io/audio-out', x + 720, 200)
  )
  nets.push(
    wire(last, 'l', 'fb-sum', 'in1'),
    wire(last, 'r', 'fb-sum', 'in2'),
    wire('fb-sum', 'out', 'fb-hp', 'in'),
    wire('fb-hp', 'out', 'fb-amt', 'in1'),
    wire('feedback', 'unipolar', 'fb-amt', 'in2'),
    wire('fb-amt', 'out', 'fb-sat', 'in'),
    wire('fb-sat', 'out', 'in+fb', 'b'),
    wire(last, 'l', 'width', 'l'),
    wire(last, 'r', 'width', 'r'),
    wire('audio-in', 'l', 'mix', 'l1'),
    wire('audio-in', 'r', 'mix', 'r1'),
    wire('width', 'l', 'mix', 'l2'),
    wire('width', 'r', 'mix', 'r2'),
    wire('mix', 'l', 'audio-out', 'l'),
    wire('mix', 'r', 'audio-out', 'r')
  )
  return doc(
    'delfx',
    'Grain Mill',
    nodes,
    nets,
    'grain-mill, after the Axoloti patch: 8 looping grain voices from a 5.5 s buffer. TIME = clock rate (tempo division when MODE syncs), DEPTH = grain size (full travel freezes the buffer), MIX = dry/wet. Menu: MOT AMT/SPD/TYP (how far back grains come from, how fast, saw down/up/triangle/random), FEEDBK, WIDTH, ENV (grain envelope: short |\\ -> long /\\ -> short /|), CHANCE (random modes), MODE (free, sync, random, random sync). NTS-1 mkII; the voice is grain-voice.loguesub next to this file.'
  )
}

type XdMode = 'free' | 'sync' | 'rnd' | 'rndsync'
const XD_MODE_NAME: Record<XdMode, string> = {
  free: 'Grain Free',
  sync: 'Grain Sync',
  rnd: 'Grain Rnd',
  rndsync: 'Grain RndSyn'
}
/**
 * Where voice k (1-based) reads from, in % of the 5.5 s buffer: 4 + (k-1) * 15. Wider spacing
 * won an A/B against 4 % steps (user, a real xd, 2026-10-01); the 4 % base keeps voice 1's
 * jitter (below) off the "now" edge.
 */
const XD_POSITION_BASE = 4
const XD_POSITION_STEP = 15

/**
 * grain-mill for the minilogue xd (user's mapping, 2026-10-01): no menu params there, so one unit
 * per clock mode, and the three controls are macros. Time = the clock (rate, or the tempo
 * division; free: ~1-12 Hz) and ENV 0 -> 50 with it (slow = harsh); Depth = grain size, feedback (Depth squared, 0 -> 100, times 1 - 0.6 Time), and
 * freeze at full travel; grain size 180 ms .. 1.4 s; Shift+Depth = dry/wet. No motion LFOs: each
 * voice reads from its own offset (POSITION 4 + (k-1) * 15 %) with a slight random jitter. WIDTH
 * fixed at 100 (no width node), CHANCE fixed at 50.
 */
function grainMillXd(mode: XdMode, voices: number): PatchDocument {
  const synced = mode === 'sync' || mode === 'rndsync'
  const random = mode === 'rnd' || mode === 'rndsync'
  const xdKnob = (knob: LogueKnob): Pick<ParamValue, 'logueKnob'> => ({
    logueKnob: { 'minilogue-xd': knob }
  })
  const env = envCurve({ obj: 'env-t', outlet: 'out' })
  const nodes: ObjNode[] = [
    obj('audio-in', 'logue/io/audio-in', 0, 700),
    obj('in+fb', 'logue/math/add', 260, 700),
    obj('buffer', 'logue/util/buffer', 500, 700, [{ name: 'LENGTH', value: '3' }]),
    obj('depth', 'logue/sense/control', 0, 1000, [
      { name: 'VALUE', value: '50', ...xdKnob('depth') }
    ]),
    obj('freeze', 'logue/logic/greater-than', 260, 1000, [{ name: 'THRESHOLD', value: '95' }]),
    synced
      ? obj('clock', 'logue/sense/tempo', 0, 0, [
          { name: 'DIVISION', value: '2', ...xdKnob('time') }
        ])
      : // Time moves the rate ~1 -> ~12 Hz (RATE 35 + up to 50 through the rate inlet), not the
        // dial's whole 0.1 -> 20 Hz: at 0.1 Hz with ENV at its shortest the knob's bottom was
        // silence -- one short grain every 10-20 s (user, a real xd, 2026-10-01).
        obj('clock', 'logue/lfo/square-lfo', 0, 0, [{ name: 'RATE', value: '35' }]),
    ...(random
      ? [obj('chance', 'logue/logic/chance', 260, 0, [{ name: 'CHANCE', value: '50' }])]
      : []),
    obj('voices', 'logue/logic/round-robin', 500, 60, [{ name: 'VOICES', value: String(voices) }]),
    // ENV follows Time from 0 to 50.
    obj('time', 'logue/sense/control', 0, 1100, [
      { name: 'VALUE', value: '40', ...xdKnob('time') }
    ]),
    obj('env-t', 'logue/math/scale', 260, 1100, [{ name: 'FACTOR', value: '50' }]),
    ...env.nodes,
    // A slight random position jitter (the xd's stand-in for the motion LFOs; fixed offsets
    // repeated too much, user): a new value ~8 times a second, +-0.08 into the voices' additive
    // position inlets = +-4 % of the buffer (+-0.2 s), latched per grain. Voice 2 gets it inverted,
    // so the voices drift apart rather than together.
    obj('jitter', 'logue/lfo/random-steps', 0, 1300, [{ name: 'RATE', value: '75' }]),
    obj('jitter-amt', 'logue/math/scale', 260, 1300, [{ name: 'FACTOR', value: '8' }]),
    obj('jitter-inv', 'logue/math/negate', 500, 1300)
  ]
  const clockOut = synced ? 'clock' : 'out'
  const nets: Net[] = [
    wire('audio-in', 'mono', 'in+fb', 'a'),
    wire('in+fb', 'out', 'buffer', 'in'),
    wire('depth', 'unipolar', 'freeze', 'a'),
    wire('freeze', 'out', 'buffer', 'freeze'),
    ...(random
      ? [wire('clock', clockOut, 'chance', 'trig'), wire('chance', 'out', 'voices', 'trig')]
      : [wire('clock', clockOut, 'voices', 'trig')]),
    wire('time', 'unipolar', 'env-t', 'in'),
    ...(synced ? [] : [wire('time', 'unipolar', 'clock', 'rate')]),
    ...env.nets,
    wire('jitter', 'out', 'jitter-amt', 'in'),
    wire('jitter-amt', 'out', 'jitter-inv', 'in')
  ]
  for (let k = 1; k <= voices; k++) {
    const name = `voice${k}`
    nodes.push(
      obj(name, 'sub/grain-voice', 1000 + (k - 1) * 240, 200 + (k % 2) * 60, [
        { name: 'PAN', value: k % 2 ? '-100' : '100' },
        { name: 'POSITION', value: String(XD_POSITION_BASE + (k - 1) * XD_POSITION_STEP) }
      ])
    )
    nets.push(
      wire('buffer', 'buf', name, 'buf'),
      wire('voices', `o${k}`, name, 'trig'),
      wire('env-attack', 'out', name, 'attack'),
      wire('env-decay', 'out', name, 'decay'),
      wire(k % 2 ? 'jitter-amt' : 'jitter-inv', 'out', name, 'position'),
      // Depth scales SIZE 50..100 (~180 ms .. 1.4 s): its whole range started at 10-20 ms
      // grains, shrieky repeats at low Depth (user, a real xd, 2026-10-01).
      wire('depth', 'unipolar', name, 'size')
    )
    if (k > 1)
      nets.push(
        wire(`voice${k - 1}`, 'l', name, 'bus-l'),
        wire(`voice${k - 1}`, 'r', name, 'bus-r')
      )
  }
  const last = `voice${voices}`
  const x = 1000 + voices * 240
  nodes.push(
    // The full sum: with two voices the NTS-1 mkII's half sum (tuned for eight) kept the loop gain
    // near 0.4 even at high Depth, so feedback faded within a few repeats.
    obj('fb-sum', 'logue/mix/mix2', x, 700, [
      { name: 'GAIN1', value: '100' },
      { name: 'GAIN2', value: '100' }
    ]),
    obj('fb-hp', 'logue/filter/highpass-cheap', x + 240, 700, [{ name: 'CUTOFF', value: '19' }]),
    // Feedback rides Depth squared, up to the NTS-1 mkII's FEEDBK 100 just before the freeze: a
    // linear rise capped at 40 hardly built up with two voices (user, a real xd, 2026-10-01).
    obj('fb-curve', 'logue/math/multiply', x + 240, 860),
    // ...and backs off as Time rises (x 1 - 0.6 Time): a fast clock with ENV's long grains sends
    // far more round the loop, which built up and got frozen in (user, a real xd, 2026-10-01).
    obj('fb-t', 'logue/math/scale', x + 240, 980, [{ name: 'FACTOR', value: '60' }]),
    obj('fb-tcomp', 'logue/math/subtract', x + 480, 980),
    obj('fb-level', 'logue/math/multiply', x + 480, 860),
    obj('fb-amt', 'logue/math/multiply', x + 480, 700),
    obj('fb-sat', 'logue/shape/soft-clip', x + 720, 700),
    obj('mix', 'logue/mix/stereo-crossfader', x + 480, 140, [
      { name: 'FADE', value: '50', ...xdKnob('mix') }
    ]),
    obj('audio-out', 'logue/io/audio-out', x + 720, 200)
  )
  nets.push(
    wire(last, 'l', 'fb-sum', 'in1'),
    wire(last, 'r', 'fb-sum', 'in2'),
    wire('fb-sum', 'out', 'fb-hp', 'in'),
    wire('depth', 'unipolar', 'fb-curve', 'in1'),
    wire('depth', 'unipolar', 'fb-curve', 'in2'),
    wire('fb-hp', 'out', 'fb-amt', 'in1'),
    wire('time', 'unipolar', 'fb-t', 'in'),
    wire('env-one', 'out', 'fb-tcomp', 'a'),
    wire('fb-t', 'out', 'fb-tcomp', 'b'),
    wire('fb-curve', 'out', 'fb-level', 'in1'),
    wire('fb-tcomp', 'out', 'fb-level', 'in2'),
    wire('fb-level', 'out', 'fb-amt', 'in2'),
    wire('fb-amt', 'out', 'fb-sat', 'in'),
    wire('fb-sat', 'out', 'in+fb', 'b'),
    wire('audio-in', 'l', 'mix', 'l1'),
    wire('audio-in', 'r', 'mix', 'r1'),
    wire(last, 'l', 'mix', 'l2'),
    wire(last, 'r', 'mix', 'r2'),
    wire('mix', 'l', 'audio-out', 'l'),
    wire('mix', 'r', 'audio-out', 'r')
  )
  const clockText = synced ? 'the tempo division' : 'the grain clock rate'
  return doc(
    'delfx',
    XD_MODE_NAME[mode],
    nodes,
    nets,
    `grain-mill for the minilogue xd, ${mode === 'free' ? 'free clock' : mode === 'sync' ? 'tempo-synced clock' : mode === 'rnd' ? 'free clock, half its ticks at random' : 'tempo clock, half its ticks at random'}: ${voices} looping grain voices from a 5.5 s buffer, each reading from its own fixed distance back. Time = ${clockText} and the grain envelope from short and harsh to long and smooth; Depth = grain size and feedback (full travel freezes the buffer); Shift+Depth = dry/wet. The voice is grain-voice.loguesub next to this file.`
  )
}

// reverse-wash's NTS-1 mkII menu slots (0-2 are TIME/DEPTH/MIX).
const RW_SLOT = {
  spread: 3,
  motAmt: 4,
  motSpd: 5,
  soften: 6,
  diffuse: 7,
  tone: 8,
  window: 9,
  width: 10
}

/**
 * reverse-wash (docs/PLAN-reverse-delay.md): the input's mono sum, its attacks ducked (SOFTEN)
 * so a reversed pluck fades out instead of stopping on its loudest moment, records into a 2.7 s
 * buffer with the feedback. Two reverse-taps play it backwards, the second's segments ~1.31x the
 * first's, so their seams drift apart; each of the four heads pans across the field as its
 * segment plays (SPREAD, alternate directions) and wanders with one of two slow LFOs (MOTION).
 * Two allpasses per side diffuse the stop of each segment into a tail, and the diffused sum
 * feeds back. Device knobs: TIME = segment length, DEPTH = feedback, MIX = dry/wet; on the
 * NTS-1 mkII the rest is in the menu.
 *
 * `xd`: the minilogue xd's version, cut to fit its CPU (xd emulator, penalty 8, 2026-10-01: the
 * full patch is ~970 cycles/sample, past the ~750 that stayed clean beside the factory effects):
 * one reverse line (two heads) and one allpass per side, ~670. Its own reverb slot can add to the
 * wash.
 */
function reverseWash(xd = false): PatchDocument {
  const nodes: ObjNode[] = [
    obj('audio-in', 'logue/io/audio-in', 0, 600),
    // SOFTEN, an attack detector: a fast follower (0.1 ms up, 46 ms down) minus 1.6x a slow one
    // (100 ms up, 200 ms down) is ~1 at an attack and back to 0 within ~150 ms; held material
    // stays at 0, since the slow one's 1.6x tops the fast one's ripple. The input's gain is 1
    // minus SOFTEN times that, so the first ~150 ms after each attack are turned down --
    // reversed, the end of the swell. Tuned in a simulation of the follower math (2026-10-01:
    // at SOFTEN 80 a pluck peaking at 0.18 dips to 0.25 and is back by 150 ms; steady noise or
    // a saw stay at 1.00). Harness: at SOFTEN 100 a reversed pluck's last 5 ms are ~10 dB below
    // its loudest, against 0 dB (stopping on its loudest moment) without it.
    obj('att-fast', 'logue/env/follower', 260, 0, [
      { name: 'ATTACK', value: '0' },
      { name: 'RELEASE', value: '15' },
      { name: 'GAIN', value: '40' }
    ]),
    obj('att-slow', 'logue/env/follower', 260, 240, [
      { name: 'ATTACK', value: '100' },
      { name: 'RELEASE', value: '31.55' },
      { name: 'GAIN', value: '40' }
    ]),
    obj('att-slow-x1.6', 'logue/gain/vca', 520, 240, [{ name: 'GAIN', value: '40' }]),
    obj('attack', 'logue/math/subtract', 760, 120),
    obj('attack-0..1', 'logue/math/clamp', 1000, 120, [
      { name: 'LO', value: '0' },
      { name: 'HI', value: '100' }
    ]),
    obj('soften', 'logue/math/scale', 1000, 120, [
      { name: 'FACTOR', value: '100', ...ntsSlot(RW_SLOT.soften, 'SOFTEN') }
    ]),
    obj('one', 'logue/util/constant', 1000, 320, [{ name: 'VALUE', value: '100' }]),
    obj('duck-gain', 'logue/math/subtract', 1240, 200),
    obj('duck', 'logue/gain/vca', 1480, 480),
    obj('in+fb', 'logue/math/add', 1720, 600),
    // Each pass through the loop gets darker.
    obj('tone', 'logue/filter/lowpass-cheap', 1960, 600, [
      { name: 'CUTOFF', value: '70', ...ntsSlot(RW_SLOT.tone, 'TONE') }
    ]),
    obj('buffer', 'logue/util/buffer', 2200, 600, [{ name: 'LENGTH', value: '2' }]),
    // TIME: both lines' segment length. The second line's SIZE is 1.144x the first's (lengths
    // go with SIZE squared, so ~1.31x), so it reaches half the buffer when the first is at
    // 0.76 of it and the two don't lock together at the top. (At the bottom both reach the
    // 40 ms minimum: the ratio goes from 1 there to ~1.31 from the middle up.)
    obj('time', 'logue/sense/control', 1960, 900, [
      { name: 'VALUE', value: '50', ...onKnob('time') }
    ]),
    // One line alone gets the whole range.
    obj('size-1', 'logue/gain/vca', 2200, 860, [{ name: 'GAIN', value: xd ? '50' : '43.7' }]),
    obj('size-2', 'logue/gain/vca', 2200, 1060, [{ name: 'GAIN', value: '50' }]),
    obj('rev-1', 'logue/util/reverse-tap', 2460, 600, [
      { name: 'SIZE', value: '0' },
      { name: 'WINDOW', value: '100', ...ntsSlot(RW_SLOT.window, 'WINDOW') }
    ]),
    obj('rev-2', 'logue/util/reverse-tap', 2460, 1000, [
      { name: 'SIZE', value: '0' },
      { name: 'WINDOW', value: '100', ...ntsFollow(RW_SLOT.window) }
    ]),
    obj('motion-1', 'logue/lfo/sine-lfo', 2460, 1500, [
      { name: 'RATE', value: '15', ...ntsSlot(RW_SLOT.motSpd, 'MOTION SPEED') }
    ]),
    // The second motion LFO runs 5 RATE points faster (0.1 x the rate inlet's 50).
    obj('motion-2-offset', 'logue/util/constant', 2200, 1700, [{ name: 'VALUE', value: '10' }]),
    obj('motion-2', 'logue/lfo/sine-lfo', 2460, 1700, [
      { name: 'RATE', value: '15', ...ntsFollow(RW_SLOT.motSpd) }
    ]),
    obj('motion-amt-1', 'logue/math/scale', 2720, 1500, [
      { name: 'FACTOR', value: '30', ...ntsSlot(RW_SLOT.motAmt, 'MOTION') }
    ]),
    obj('motion-amt-2', 'logue/math/scale', 2720, 1700, [
      { name: 'FACTOR', value: '30', ...ntsFollow(RW_SLOT.motAmt) }
    ])
  ]
  const nets: Net[] = [
    wire('audio-in', 'mono', 'att-fast', 'in'),
    wire('audio-in', 'mono', 'att-slow', 'in'),
    wire('att-fast', 'out', 'attack', 'a'),
    wire('att-slow', 'out', 'att-slow-x1.6', 'in'),
    wire('att-slow-x1.6', 'out', 'attack', 'b'),
    wire('attack', 'out', 'attack-0..1', 'in'),
    wire('attack-0..1', 'out', 'soften', 'in'),
    wire('one', 'out', 'duck-gain', 'a'),
    wire('soften', 'out', 'duck-gain', 'b'),
    wire('audio-in', 'mono', 'duck', 'in'),
    wire('duck-gain', 'out', 'duck', 'gain'),
    wire('duck', 'out', 'in+fb', 'a'),
    wire('in+fb', 'out', 'tone', 'in'),
    wire('tone', 'out', 'buffer', 'in'),
    wire('time', 'unipolar', 'size-1', 'in'),
    wire('time', 'unipolar', 'size-2', 'in'),
    wire('size-1', 'out', 'rev-1', 'size'),
    wire('size-2', 'out', 'rev-2', 'size'),
    wire('buffer', 'buf', 'rev-1', 'buf'),
    wire('buffer', 'buf', 'rev-2', 'buf'),
    wire('motion-2-offset', 'out', 'motion-2', 'rate'),
    wire('motion-1', 'out', 'motion-amt-1', 'in'),
    wire('motion-2', 'out', 'motion-amt-2', 'in')
  ]
  // The four heads, chained onto one stereo bus. Each one's pan sweeps across the field over its
  // segment (phase 0..1 -> -1..1, times SPREAD), the two heads of a line in opposite directions,
  // plus one of the two motion LFOs.
  const heads = [
    { rev: 'rev-1', head: 'a', flip: false, motion: 'motion-amt-1' },
    { rev: 'rev-1', head: 'b', flip: true, motion: 'motion-amt-2' },
    { rev: 'rev-2', head: 'a', flip: true, motion: 'motion-amt-1' },
    { rev: 'rev-2', head: 'b', flip: false, motion: 'motion-amt-2' }
  ].slice(0, xd ? 2 : 4)
  let bus: string | undefined
  heads.forEach((h, i) => {
    const id = `${h.rev.slice(4)}${h.head}`
    const y = i * 360
    const phase = h.head === 'a' ? 'phaseA' : 'phaseB'
    const swing = `swing-${id}`
    const spread = `spread-${id}`
    const flip = `flip-${id}`
    const panTo = `pan-to-${id}`
    const pan = `pan-${id}`
    nodes.push(
      obj(swing, 'logue/util/unipolar-to-bipolar', 2980, y),
      obj(spread, 'logue/math/scale', 3220, y, [
        {
          name: 'FACTOR',
          value: '70',
          ...(i === 0 ? ntsSlot(RW_SLOT.spread, 'SPREAD') : ntsFollow(RW_SLOT.spread))
        }
      ]),
      ...(h.flip ? [obj(flip, 'logue/math/negate', 3460, y)] : []),
      obj(panTo, 'logue/math/add', 3700, y),
      obj(pan, 'logue/mix/pan', 3940, y, [{ name: 'PAN', value: '0' }])
    )
    nets.push(
      wire(h.rev, phase, swing, 'in'),
      wire(swing, 'out', spread, 'in'),
      ...(h.flip
        ? [wire(spread, 'out', flip, 'in'), wire(flip, 'out', panTo, 'a')]
        : [wire(spread, 'out', panTo, 'a')]),
      wire(h.motion, 'out', panTo, 'b'),
      wire(panTo, 'out', pan, 'pan'),
      wire(h.rev, h.head, pan, 'in'),
      ...(bus ? [wire(bus, 'l', pan, 'l'), wire(bus, 'r', pan, 'r')] : [])
    )
    bus = pan
  })
  // Diffusion: each segment's stop smears into a short tail, and the loop gets denser per pass.
  const allpassTimes = xd ? { l: [13], r: [17] } : { l: [13, 29], r: [17, 37] }
  const diffused = (side: 'l' | 'r'): string => `diffuse-${side}${allpassTimes[side].length}`
  for (const [side, y0] of [
    ['l', 200],
    ['r', 760]
  ] as const) {
    allpassTimes[side].forEach((ms, i) => {
      const name = `diffuse-${side}${i + 1}`
      nodes.push(
        obj(name, 'logue/filter/allpass', 4200 + i * 260, y0, [
          { name: 'TIME', value: (Math.sqrt((ms - 0.5) / 99.5) * 100).toFixed(4) },
          {
            name: 'GAIN',
            value: '60',
            ...(side === 'l' && i === 0
              ? ntsSlot(RW_SLOT.diffuse, 'DIFFUSE')
              : ntsFollow(RW_SLOT.diffuse))
          }
        ])
      )
      nets.push(wire(i === 0 ? bus! : `diffuse-${side}1`, i === 0 ? side : 'out', name, 'in'))
    })
  }
  nodes.push(
    // One line is 3 dB quieter than two: made up after the feedback tap, so the loop is the same.
    ...(xd
      ? [
          obj('level-l', 'logue/gain/vca', 4600, 200, [{ name: 'GAIN', value: '35.3' }]),
          obj('level-r', 'logue/gain/vca', 4600, 760, [{ name: 'GAIN', value: '35.3' }])
        ]
      : []),
    obj('width', 'logue/mix/width', 4720, 480, [
      { name: 'WIDTH', value: '100', ...ntsSlot(RW_SLOT.width, 'WIDTH') }
    ]),
    obj('mix', 'logue/mix/stereo-crossfader', 4980, 300, [
      { name: 'FADE', value: '50', ...onKnob('mix') }
    ]),
    obj('audio-out', 'logue/io/audio-out', 5240, 480),
    // Feedback: the diffused sum, rumble-free and soft-clipped, back into the buffer. The top of
    // DEPTH is just under a loop gain of 1 (harness: full DEPTH still dies away, the NTS-1 mkII
    // version with its menu at the worst -- every head centred, TONE open). L + R of equal-power
    // pans depends on where the heads are, so the four-head version needs the smaller range.
    obj('fb-sum', 'logue/math/add', 4720, 1100),
    obj('fb-dc', 'logue/filter/highpass-cheap', 4980, 1100, [{ name: 'CUTOFF', value: '15' }]),
    obj('fb-clip', 'logue/shape/soft-clip', 5240, 1100),
    obj('depth', 'logue/sense/control', 4720, 1400, [
      { name: 'VALUE', value: '40', ...onKnob('depth') }
    ]),
    obj('fb-range', 'logue/math/scale', 4980, 1400, [{ name: 'FACTOR', value: xd ? '65' : '32' }]),
    obj('feedback', 'logue/gain/vca', 5500, 1100)
  )
  nets.push(
    ...(['l', 'r'] as const).map((side) =>
      xd ? wire(`level-${side}`, 'out', 'width', side) : wire(diffused(side), 'out', 'width', side)
    ),
    ...(xd
      ? (['l', 'r'] as const).map((side) => wire(diffused(side), 'out', `level-${side}`, 'in'))
      : []),
    wire('audio-in', 'l', 'mix', 'l1'),
    wire('audio-in', 'r', 'mix', 'r1'),
    wire('width', 'l', 'mix', 'l2'),
    wire('width', 'r', 'mix', 'r2'),
    wire('mix', 'l', 'audio-out', 'l'),
    wire('mix', 'r', 'audio-out', 'r'),
    wire(diffused('l'), 'out', 'fb-sum', 'a'),
    wire(diffused('r'), 'out', 'fb-sum', 'b'),
    wire('fb-sum', 'out', 'fb-dc', 'in'),
    wire('fb-dc', 'out', 'fb-clip', 'in'),
    wire('depth', 'unipolar', 'fb-range', 'in'),
    wire('fb-clip', 'out', 'feedback', 'in'),
    wire('fb-range', 'out', 'feedback', 'gain'),
    wire('feedback', 'out', 'in+fb', 'b')
  )
  const dropped = new Set(xd ? ['size-2', 'rev-2'] : [])
  const kept = (name: string): boolean => !dropped.has(name)
  return doc(
    'delfx',
    xd ? 'LP RevWash XD' : 'LP RevWash',
    nodes.filter((n) => n.kind !== 'obj' || kept(n.name ?? '')),
    nets.filter((n) => kept(n.sources[0].obj) && n.dests.every((d) => kept(d.obj))),
    xd
      ? "A stereo reverse delay for the minilogue xd: the input plays back backwards in overlapping segments, each sweeping across the stereo field as it swells, lightly diffused (the xd's own reverb can add more). Time = segment length, Depth = feedback, Shift+Depth = dry/wet. Attacks are turned down before they are reversed, so a reversed pluck fades out instead of stopping dead. A lighter version of reverse-wash, to fit the xd's CPU."
      : 'A stereo reverse delay: the input plays back backwards in overlapping segments, each sweeping across the stereo field as it swells, diffused into a wash. TIME = segment length, DEPTH = feedback, MIX = dry/wet. SOFTEN turns down the attacks before they are reversed, so a reversed pluck fades out instead of stopping dead. NTS-1 mkII menu: SPREAD, MOTION, MOTION SPEED, SOFTEN, DIFFUSE, TONE, WINDOW, WIDTH. For the minilogue xd use reverse-wash-xd: this one is too heavy for its CPU.'
  )
}

mkdirSync(outDir, { recursive: true })
for (const [file, d] of [
  ['stereo-reverb.loguepatch', reverb()],
  ['auto-wah.loguepatch', autoWah()],
  ['tempo-swell.loguepatch', tempoSwell()],
  ['freq-shifter.loguepatch', freqShifter()],
  ['grain-mill.loguepatch', grainMill()],
  ['reverse-wash.loguepatch', reverseWash()],
  ['reverse-wash-xd.loguepatch', reverseWash(true)],
  ['grain-voice.loguesub', grainVoice()],
  ...(['free', 'sync', 'rnd', 'rndsync'] as const).map(
    (mode) => [`grain-mill-xd-${mode}.loguepatch`, grainMillXd(mode, XD_VOICES)] as const
  )
] as const) {
  writeFileSync(join(outDir, file), serializePatchFile(d))
  console.log(join(outDir, file))
}

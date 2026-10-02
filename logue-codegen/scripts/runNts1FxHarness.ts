/**
 * Runs generated NTS-1 mkII effect units natively (harness/nts1mkii-fx/ stand-ins for the SDK's
 * unit_*fx.h, plus the SDK's own processor.h and utils/float_math.h) under ASan/UBSan, and checks
 * behaviour the golden source can't show (phase 3 of "effect patches", 2026-09-30):
 * - pass: bit-exact L/R pass-through, with separate buffers and with in == out;
 * - lpmix: MIX at +1000 gives the (closed) lowpass, at -1000 the dry input; R copies L;
 * - ring: a sine at COARSE 0 in an effect runs at middle C (the fixed note, and the
 *   osc_w0f_for_note stand-in);
 * - haas: L untouched, R delayed by the DEPTH-bound TIME.
 * - allpass: flat magnitude; follower: its attack and release times; tempo: its clock spacing.
 * - long-delay: TIME linear over its RANGE, SYNC at the device tempo, MIX 0 dry, a bounded
 *   FEEDBACK 100 -- all starting from NaN-filled SDRAM, which init() must clear.
 * - buffer + buffer-tap: two taps at their delays, an echo loop through the buffer (no
 *   sample-delay), FREEZE looping the content bit-exactly while the input goes on.
 * - pan: a chain places each input exactly; width: 0 is the mid on both sides, 100 the pair;
 *   chance: CHANCE 0/50/100 of the gates pass; round-robin: gates go to o1..oN in turn; env/ad
 *   EXP: DECAY is its time constant, silent after ~4.6x it.
 * - the grain-mill example (with its voice subpatch): finite, and its grains still sound a second
 *   after the input stops (they loop what the buffer holds).
 * - grain: records the buffer exactly at its POSITION, loops it bit-exactly at SIZE, a retrigger
 *   without a click, and an unwired trig retriggering itself.
 * - reverse-tap: each head plays its segments backwards sample-exactly (also while SIZE moves),
 *   b half a segment after a, and a + b constant at WINDOW 100.
 * - hilbert: i and q equally loud and 90 degrees apart; freq-shift: a tone moves by SHIFT (up on
 *   shifted, down on mirror, swapped for a negative SHIFT) with the wrong sideband far down, MIX 0
 *   dry, FEEDBACK 100 bounded.
 * Every run must be finite and sanitizer-clean.
 *
 * Usage: npx tsx logue-codegen/scripts/runNts1FxHarness.ts
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { parsePatchFile } from '../../src/shared/json/patchCodec'
import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'
import { generateFxUnit } from '../src/nts1mkii/generateFxUnit'
import { LOGUE_AUDIO_IN_TYPE, LOGUE_AUDIO_OUT_TYPE } from '../src/oscInstances'
import type { LogueModule, Net, ObjNode, PatchDocument } from '../../src/shared/domain/patch'
import type { ParamValue } from '../../src/shared/domain/paramValueTypes'
import { exampleSubpatches, examplesDir } from './exampleSubpatches'

const harnessDir = join(dirname(new URL(import.meta.url).pathname), '..', 'harness', 'nts1mkii-fx')
const sdkCommon = join(
  process.env.LOGUE_SDK ?? join(homedir(), 'Documents/GitHub/logue-sdk'),
  'platform/nts-1_mkii/common'
)

function obj(name: string, type: string, params: ParamValue[] = []): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params }
}
function wire(from: string, outlet: string, to: string, inlet: string): Net {
  return { sources: [{ obj: from, outlet }], dests: [{ obj: to, inlet }] }
}
function doc(module: LogueModule, nodes: ObjNode[], nets: Net[]): PatchDocument {
  return { nodes, nets, settings: { logueTarget: { module } }, notes: '' }
}
const IN = obj('in', LOGUE_AUDIO_IN_TYPE)
const OUT = obj('out', LOGUE_AUDIO_OUT_TYPE)

const PASS = doc('delfx', [IN, OUT], [wire('in', 'l', 'out', 'l'), wire('in', 'r', 'out', 'r')])
const LPMIX = doc(
  'delfx',
  [
    IN,
    obj('lp', 'logue/filter/lowpass-cheap', [
      { name: 'CUTOFF', value: '100', logueKnob: { nts1mkii: 'time' } }
    ]),
    obj('x', 'logue/mix/crossfader', [
      { name: 'FADE', value: '50', logueKnob: { nts1mkii: 'mix' } }
    ]),
    OUT
  ],
  [
    wire('in', 'l', 'x', 'in1'),
    wire('in', 'l', 'lp', 'in'),
    wire('lp', 'out', 'x', 'in2'),
    wire('x', 'out', 'out', 'l')
  ]
)
const RING = doc(
  'modfx',
  [
    IN,
    obj('s', 'logue/osc/sine', [{ name: 'COARSE', value: '0', logueKnob: { nts1mkii: 'time' } }]),
    obj('m', 'logue/math/multiply'),
    obj('x', 'logue/mix/crossfader', [
      { name: 'FADE', value: '0', logueKnob: { nts1mkii: 'depth' } }
    ]),
    OUT
  ],
  [
    wire('in', 'mono', 'm', 'in1'),
    wire('s', 'out', 'm', 'in2'),
    wire('in', 'mono', 'x', 'in1'),
    wire('m', 'out', 'x', 'in2'),
    wire('x', 'out', 'out', 'l')
  ]
)
const HAAS = doc(
  'revfx',
  [
    IN,
    obj('d', 'logue/util/delay', [
      { name: 'TIME', value: '50', logueKnob: { nts1mkii: 'depth' } },
      { name: 'MIX', value: '100' }
    ]),
    OUT
  ],
  [wire('in', 'l', 'out', 'l'), wire('in', 'r', 'd', 'in'), wire('d', 'out', 'out', 'r')]
)

interface Run {
  inL: Float32Array
  inR: Float32Array
  outL: Float32Array
  outR: Float32Array
}

const FRAMES = 48000

/** Debugging: GM_PROBE_L/GM_PROBE_R name generated variables (`y_...`) to write out instead. */
function probeOutputs(fxH: string): string {
  const [l, r] = [process.env.GM_PROBE_L, process.env.GM_PROBE_R]
  if (!l || !r) return fxH
  return fxH
    .replace(/out\[2 \* i\] = [^;]*;/, `out[2 * i] = ${l};`)
    .replace(/out\[2 \* i \+ 1\] = [^;]*;/, `out[2 * i + 1] = ${r};`)
}

/** Renders `FRAMES` frames of `input` through `d` with `params` set first ([slot, value]). */
function render(
  d: PatchDocument,
  params: Array<[number, number]>,
  // A number is a pure tone at that many Hz, 0.3 peak on both channels.
  input:
    | 'sines'
    | 'dc'
    | 'small-dc'
    | 'noise'
    | 'impulse'
    | 'loud-noise'
    | 'burst'
    | 'noise-burst'
    | 'noise-freeze'
    | 'noise-trig'
    | 'sine-trig'
    | 'pulses'
    | 'plucks'
    | number,
  aliased = false,
  tempo?: number,
  resetAtFrame?: number,
  frames = FRAMES,
  subpatches = new Map<string, PatchDocument>()
): Run {
  const FRAMES = frames
  const dir = mkdtempSync(join(tmpdir(), 'lp-fx-harness-'))
  writeFileSync(
    join(dir, 'fx.h'),
    subpatches.size
      ? probeOutputs(generateFxUnit(d, { name: 'harness' }, subpatches).fxH)
      : generateFxUnit(d, { name: 'harness' }).fxH
  )
  const signal =
    typeof input === 'number'
      ? `const float l = (float)(0.3 * sin(6.283185307179586 * ${input} * (double)n / 48000.0)), r = l;`
      : input === 'dc'
        ? 'const float l = 0.5f, r = 0.5f;'
        : input === 'small-dc'
          ? 'const float l = 0.1f, r = 0.1f;'
          : input === 'noise' || input === 'loud-noise'
            ? `seed = seed * 1664525u + 1013904223u; const float l = 0.f, r = (float)(int32_t)seed * (${input === 'noise' ? '0.3f' : '1.f'} / 2147483648.f);`
            : input === 'impulse'
              ? 'const float l = 0.f, r = n == 100 ? 0.5f : 0.f;'
              : input === 'burst'
                ? 'const float l = 0.f, r = n < 24000 ? 0.5f : 0.f;'
                : input === 'noise-burst'
                  ? 'seed = seed * 1664525u + 1013904223u; const float r = n < 24000 ? (float)(int32_t)seed * (0.18f / 2147483648.f) : 0.f, l = r;'
                  : input === 'noise-freeze'
                    ? // r: noise; l: a gate that opens at n = 40000.
                      'seed = seed * 1664525u + 1013904223u; const float r = (float)(int32_t)seed * (0.3f / 2147483648.f), l = n >= 40000 ? 1.f : 0.f;'
                    : input === 'noise-trig' || input === 'sine-trig'
                      ? // r: noise or a 200 Hz sine; l: one-sample trigger pulses at n = 1000 and 30011.
                        `seed = seed * 1664525u + 1013904223u; const float r = ${input === 'noise-trig' ? '(float)(int32_t)seed * (0.3f / 2147483648.f)' : '0.3f * sinf(6.2831853f * 200.f * n / 48000.f)'}, l = (n == 1000 || n == 30011) ? 1.f : 0.f;`
                      : input === 'pulses'
                        ? // one-sample gates every 100 samples on both channels
                          'const float l = n % 100u == 0u ? 1.f : 0.f, r = l;'
                        : input === 'plucks'
                          ? // a noise pluck (0.2 peak, an effect's input level; a 150 ms decay) every second, mono
                            'seed = seed * 1664525u + 1013904223u; const float r = (float)(int32_t)seed * (0.2f / 2147483648.f) * expf(-(float)(n % 48000u) / 7200.f), l = r;'
                          : 'const float l = 0.5f * sinf(6.2831853f * 440.f * n / 48000.f), r = 0.3f * sinf(6.2831853f * 330.f * n / 48000.f);'
  writeFileSync(
    join(dir, 'main.cpp'),
    `#include <cmath>
#include <cstdio>
#include <cstring>
#include "fx.h"
int main(int, char **argv) {
  static Fx fx;
  // The device hands SDRAM over dirty: start from NaNs, which init() must clear.
  const uint32_t sdramFloats = fx.getBufferSize();
  float *sdram = sdramFloats ? new float[sdramFloats] : nullptr;
  if (sdram) memset(sdram, 0xff, sdramFloats * sizeof(float));
  fx.init(sdram);
${
  tempo !== undefined
    ? `  fx.setTempo(${tempo}.f);
`
    : ''
}${params.map(([i, v]) => `  fx.setParameter(${i}, ${v});\n`).join('')}  static float in[128], out[128];
  uint32_t seed = 1;
  (void)seed;
  FILE *raw = fopen(argv[1], "wb");
  for (unsigned done = 0; done < ${FRAMES}; done += 64) {
    for (unsigned i = 0; i < 64; ++i) {
      const unsigned n = done + i;
      ${signal}
      in[2 * i] = l;
      in[2 * i + 1] = r;
    }
${resetAtFrame !== undefined ? `    if (done == ${Math.floor(resetAtFrame / 64) * 64}u) fx.reset();\n` : ''}${aliased ? '    memcpy(out, in, sizeof in);\n    fx.process(out, out, 64);\n' : '    fx.process(in, out, 64);\n'}    fwrite(in, sizeof(float), 128, raw);
    fwrite(out, sizeof(float), 128, raw);
  }
  fclose(raw);
  return 0;
}
`
  )
  const exe = join(dir, 'fx')
  execFileSync('clang++', [
    '-std=c++17',
    '-O1',
    '-g',
    '-fsanitize=address,undefined',
    '-fno-sanitize-recover=all',
    '-Wno-unknown-attributes',
    `-I${harnessDir}`,
    `-I${sdkCommon}`,
    join(dir, 'main.cpp'),
    '-o',
    exe
  ])
  const rawPath = join(dir, 'out.raw')
  execFileSync(exe, [rawPath])
  const buf = readFileSync(rawPath)
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  const run: Run = {
    inL: new Float32Array(FRAMES),
    inR: new Float32Array(FRAMES),
    outL: new Float32Array(FRAMES),
    outR: new Float32Array(FRAMES)
  }
  for (let block = 0; block < FRAMES / 64; block++) {
    for (let i = 0; i < 64; i++) {
      const n = block * 64 + i
      const base = block * 256
      run.inL[n] = all[base + 2 * i]
      run.inR[n] = all[base + 2 * i + 1]
      run.outL[n] = all[base + 128 + 2 * i]
      run.outR[n] = all[base + 128 + 2 * i + 1]
    }
  }
  return run
}

const maxAbsDiff = (a: Float32Array, b: Float32Array, from = 0): number => {
  let m = 0
  for (let i = from; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]))
  return m
}
const allFinite = (r: Run): boolean =>
  [r.outL, r.outR].every((ch) => ch.every((v) => Number.isFinite(v)))
const rms = (a: Float32Array, from = 0): number => {
  let s = 0
  for (let i = from; i < a.length; i++) s += a[i] * a[i]
  return Math.sqrt(s / (a.length - from))
}

let failed = 0
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} (${detail})`)
  if (!ok) failed++
}

for (const aliased of [false, true]) {
  const r = render(PASS, [], 'sines', aliased)
  const d = Math.max(maxAbsDiff(r.inL, r.outL), maxAbsDiff(r.inR, r.outR))
  check(
    `pass is bit-exact${aliased ? ', in == out' : ''}`,
    d === 0 && allFinite(r),
    `max diff ${d}`
  )
}

{
  const wet = render(
    LPMIX,
    [
      [0, 0],
      [2, 1000]
    ],
    'sines'
  )
  const dry = render(
    LPMIX,
    [
      [0, 0],
      [2, -1000]
    ],
    'sines'
  )
  // Not exactly 0: FADE 100 * 0.01f is a hair under 1, and its square root lets ~1.5e-4 of the
  // dry side through (-76 dB) -- the crossfader's own rounding, the same in an oscillator.
  check(
    'lpmix: MIX +1000 is the closed lowpass (below -60 dB)',
    rms(wet.outL) < 1e-3 * rms(dry.inL),
    `rms ${rms(wet.outL)}`
  )
  check(
    'lpmix: MIX -1000 is the dry left input',
    maxAbsDiff(dry.outL, dry.inL) < 1e-6,
    `max diff ${maxAbsDiff(dry.outL, dry.inL)}`
  )
  check(
    'lpmix: an unwired R copies L',
    maxAbsDiff(dry.outL, dry.outR) === 0 && allFinite(dry) && allFinite(wet),
    `max diff ${maxAbsDiff(dry.outL, dry.outR)}`
  )
}

{
  const r = render(
    RING,
    [
      [0, 512],
      [1, 1023]
    ],
    'dc'
  )
  let crossings = 0
  for (let i = 1; i < FRAMES; i++) if (r.outL[i - 1] < 0 && r.outL[i] >= 0) crossings++
  const hz = crossings * (48000 / FRAMES)
  check('ring: a sine in an effect sits at middle C', Math.abs(hz - 261.63) < 2, `${hz} Hz`)
  check('ring: output finite', allFinite(r), `peak ${Math.max(...r.outL.map(Math.abs))}`)
}

{
  // Noise, not a sine: a periodic input can't tell a delay from one a period longer.
  const r = render(HAAS, [[1, 512]], 'noise')
  check(
    'haas: L untouched',
    maxAbsDiff(r.outL, r.inL) === 0,
    `max diff ${maxAbsDiff(r.outL, r.inL)}`
  )
  let best = 0
  let bestLag = 0
  for (let lag = 0; lag < 1200; lag++) {
    let c = 0
    for (let i = 2000; i < FRAMES; i++) c += r.outR[i] * r.inR[i - lag]
    if (c > best) {
      best = c
      bestLag = lag
    }
  }
  check(
    'haas: R is the right input, 5.08 ms late',
    // DEPTH 512 = TIME 50%: 0.1 + 19.9 * 0.5^2 ms = 5.075 ms = 243.6 samples.
    Math.abs(bestLag - 243.6) < 2 && rms(r.outR, 2000) > 0.1 && allFinite(r),
    `lag ${bestLag} samples (${((bestLag / 48000) * 1000).toFixed(2)} ms), rms ${rms(r.outR, 2000).toFixed(3)}`
  )
}

function longDelay(module: LogueModule, params: ParamValue[]): PatchDocument {
  return doc(
    module,
    [IN, obj('d', 'logue/util/long-delay', params), OUT],
    [wire('in', 'r', 'd', 'in'), wire('d', 'out', 'out', 'l')]
  )
}
const WET_ONLY: ParamValue[] = [
  { name: 'FEEDBACK', value: '0' },
  { name: 'DAMPING', value: '0' },
  { name: 'MIX', value: '100' }
]
/** The echo's position: the |output|-weighted mean index after the impulse (at n = 100). */
function echoAt(r: Run): number {
  let sum = 0
  let weight = 0
  for (let i = 101; i < FRAMES; i++) {
    sum += i * Math.abs(r.outL[i])
    weight += Math.abs(r.outL[i])
  }
  return sum / weight - 100
}

{
  // RANGE 0 is 16384 floats: TIME 50 = 1 + 0.5 * (16384 - 3) = 8191.5 samples.
  const r = render(
    longDelay('delfx', [{ name: 'RANGE', value: '0' }, { name: 'TIME', value: '50' }, ...WET_ONLY]),
    [],
    'impulse'
  )
  const at = echoAt(r)
  check(
    'long-delay: TIME is linear over the RANGE',
    Math.abs(at - 8191.5) < 0.01,
    `echo at ${at.toFixed(3)}`
  )
  check(
    'long-delay: dirty SDRAM is cleared (silence before the echo)',
    allFinite(r) && Math.max(...r.outL.slice(0, 8000).map(Math.abs)) === 0,
    'max before echo 0'
  )
}

{
  // The impulse (n = 100) is in the line when unit_reset comes (n = 4096): its echo must not come.
  const r = render(
    longDelay('delfx', [{ name: 'RANGE', value: '0' }, { name: 'TIME', value: '50' }, ...WET_ONLY]),
    [],
    'impulse',
    false,
    undefined,
    4096
  )
  const after = Math.max(...r.outL.slice(4096).map(Math.abs))
  check(
    'long-delay: reset() clears a pending echo',
    after === 0 && allFinite(r),
    `max after reset ${after}`
  )
}

{
  // A quarter note at 100 BPM = 0.6 s = 28800 samples.
  const r = render(
    longDelay('delfx', [
      { name: 'SYNC', value: '100' },
      { name: 'DIVISION', value: '5' },
      ...WET_ONLY
    ]),
    [],
    'impulse',
    false,
    100
  )
  const at = echoAt(r)
  check(
    'long-delay: SYNC follows the device tempo',
    Math.abs(at - 28800) < 0.01,
    `echo at ${at.toFixed(3)} at 100 BPM`
  )
}

{
  const r = render(longDelay('delfx', [{ name: 'MIX', value: '0' }]), [], 'noise')
  check(
    'long-delay: MIX 0 is the dry input',
    maxAbsDiff(r.outL, r.inR) === 0,
    `max diff ${maxAbsDiff(r.outL, r.inR)}`
  )
}

{
  const r = render(
    longDelay('modfx', [
      { name: 'RANGE', value: '0' },
      { name: 'TIME', value: '5' },
      { name: 'FEEDBACK', value: '100' },
      { name: 'DAMPING', value: '0' },
      { name: 'MIX', value: '100' }
    ]),
    [],
    'loud-noise'
  )
  const peak = Math.max(...r.outL.map(Math.abs))
  check(
    'long-delay: FEEDBACK 100 on full-scale noise stays finite and in range',
    allFinite(r) && peak < 2.5,
    `peak ${peak.toFixed(3)}`
  )
}

function throughOne(
  module: LogueModule,
  type: string,
  params: ParamValue[],
  outlet = 'out'
): PatchDocument {
  return doc(
    module,
    [IN, obj('p', type, params), OUT],
    [wire('in', 'r', 'p', 'in'), wire('p', outlet, 'out', 'l')]
  )
}

{
  // An allpass keeps the impulse's energy (flat magnitude): 0.5^2 in, 0.5^2 out, spread in time.
  // TIME 40 = 0.5 + 99.5 * 0.16 ms = 788.2 samples, rounded to 788.
  const r = render(throughOne('revfx', 'logue/filter/allpass', []), [], 'impulse')
  let energy = 0
  for (const v of r.outL) energy += v * v
  check(
    'allpass: flat magnitude (impulse energy kept)',
    Math.abs(energy / 0.25 - 1) < 0.01 && allFinite(r),
    `energy ratio ${(energy / 0.25).toFixed(4)}`
  )
  check(
    'allpass: the direct path is -g',
    Math.abs(r.outL[100] + 0.45 * 0.5) < 1e-6,
    `first sample ${r.outL[100]}`
  )
}

{
  // ATTACK 0 (0.1 ms) up to 0.5; RELEASE 35 = 1 + 1999 * 0.35^2 = 245.9 ms -> e^-1 of the way.
  const params: ParamValue[] = [
    { name: 'ATTACK', value: '0' },
    { name: 'RELEASE', value: '35' },
    { name: 'GAIN', value: '0' }
  ]
  const r = render(
    doc(
      'delfx',
      [IN, obj('p', 'logue/env/follower', params), OUT],
      [wire('in', 'r', 'p', 'in'), wire('p', 'out', 'out', 'l')]
    ),
    [],
    'burst'
  )
  const tau = Math.round(245.9 * 48)
  const released = r.outL[24000 + tau] / 0.5
  check(
    'follower: attack reaches the level within 1 ms',
    Math.abs(r.outL[48] - 0.5) < 0.005,
    `at 1 ms ${r.outL[48].toFixed(4)}`
  )
  check(
    'follower: RELEASE is its time constant',
    Math.abs(released - Math.exp(-1)) < 0.01,
    `after tau ${released.toFixed(4)} (e^-1 = 0.3679)`
  )
}

{
  // 1/8 at 100 BPM = 0.3 s = 14400 samples between clocks.
  const r = render(
    doc(
      'modfx',
      [IN, obj('t', 'logue/sense/tempo', [{ name: 'DIVISION', value: '2' }]), OUT],
      [wire('t', 'clock', 'out', 'l')]
    ),
    [],
    'dc',
    false,
    100
  )
  const clocks: number[] = []
  r.outL.forEach((v, i) => v === 1 && clocks.push(i))
  const gaps = clocks.slice(1).map((c, i) => c - clocks[i])
  check(
    'tempo: a clock every DIVISION at the device tempo',
    clocks.length === 3 && gaps.every((g) => g === 14400),
    `clocks at ${clocks.join(', ')}`
  )
}

{
  // The example reverb at the effect input's real level (a saw peaks near 0.18 on the NTS-1
  // mkII): 0.5 s of noise, then silence, at its authored decay and with TIME fully up.
  const reverbDoc = parsePatchFile(
    readFileSync(
      join(harnessDir, '..', '..', '..', 'examples', 'effects', 'stereo-reverb.loguepatch'),
      'utf-8'
    )
  )
  for (const [label, time] of [
    ['authored decay', undefined],
    ['TIME fully up', 1023]
  ] as const) {
    const r = render(
      reverbDoc,
      [[2, 1000], ...(time === undefined ? [] : [[0, time] as [number, number]])],
      'noise-burst'
    )
    const peak = Math.max(...r.outL.slice(0, 24000).map(Math.abs))
    const windows = [0, 1, 2, 3].map((k) =>
      rms(r.outL.slice(24000 + k * 4800, 24000 + (k + 1) * 4800))
    )
    const decaying = windows.every((w, k) => k === 0 || w < windows[k - 1])
    check(
      `reverb example (${label}): wet peak stays under the combs' soft knee, the tail decays`,
      peak < 0.6 && decaying && allFinite(r),
      `peak ${peak.toFixed(3)}, tail rms ${windows.map((w) => w.toFixed(4)).join(' > ')}`
    )
  }
}

{
  // One comb on its own (what it writes back is its output), TIME fully up: the input level is
  // meant to keep it off the soft knee, which would saturate the tail.
  const reverbDoc = parsePatchFile(
    readFileSync(
      join(harnessDir, '..', '..', '..', 'examples', 'effects', 'stereo-reverb.loguepatch'),
      'utf-8'
    )
  )
  // Without its knob bindings (the other nodes are left unwired), at FEEDBACK 100 = TIME's top.
  const combOnly: PatchDocument = {
    ...reverbDoc,
    nodes: reverbDoc.nodes.map((n) =>
      n.kind !== 'obj'
        ? n
        : {
            ...n,
            params: n.params.map((p) => ({
              ...p,
              logueKnob: undefined,
              value: p.name === 'FEEDBACK' ? '100' : p.value
            }))
          }
    ),
    nets: [
      ...reverbDoc.nets.filter((n) => n.dests[0].obj !== 'audio-out'),
      wire('comb_l1', 'out', 'audio-out', 'l')
    ]
  }
  const r = render(combOnly, [], 'noise-burst')
  const peak = Math.max(...r.outL.map(Math.abs))
  check(
    'reverb example: a single comb stays under its soft knee (0.6)',
    peak < 0.6,
    `comb_l1 peak ${peak.toFixed(3)}`
  )
}

/** Amplitude and phase (degrees, of a cosine) of the `hz` component from `from`, Blackman-Harris
 *  windowed: its ~-92 dB sidelobes let a line 7 Hz away be measured without leakage. */
function tone(a: Float32Array, hz: number, from = 4800): { amp: number; deg: number } {
  let re = 0
  let im = 0
  let wsum = 0
  const len = a.length - from
  for (let k = 0; k < len; k++) {
    const x = (2 * Math.PI * k) / (len - 1)
    const w =
      0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x)
    const t = (2 * Math.PI * hz * (from + k)) / 48000
    re += a[from + k] * w * Math.cos(t)
    im -= a[from + k] * w * Math.sin(t)
    wsum += w
  }
  return { amp: (2 * Math.hypot(re, im)) / wsum, deg: (Math.atan2(im, re) * 180) / Math.PI }
}
const db = (x: number, ref: number): number => 20 * Math.log10(x / ref)
/** SHIFT's raw value for `hz` (`2000 * s^3`). */
const shiftRaw = (hz: number): string => String((Math.cbrt(hz / 2000) * 100).toFixed(4))

{
  const hilbert = doc(
    'modfx',
    [IN, obj('h', 'logue/filter/hilbert'), OUT],
    [wire('in', 'r', 'h', 'in'), wire('h', 'i', 'out', 'l'), wire('h', 'q', 'out', 'r')]
  )
  for (const hz of [30, 100, 1000, 10000, 20000]) {
    const r = render(hilbert, [], hz)
    const i = tone(r.outL, hz)
    const q = tone(r.outR, hz)
    const lag = ((((i.deg - q.deg) % 360) + 540) % 360) - 180
    check(
      `hilbert at ${hz} Hz: i and q equally loud, q 90 degrees behind`,
      Math.abs(db(q.amp, i.amp)) < 0.05 &&
        Math.abs(i.amp - 0.3) < 0.003 &&
        Math.abs(lag - 90) < 1 &&
        allFinite(r),
      `i ${i.amp.toFixed(4)}, q ${db(q.amp, i.amp).toFixed(3)} dB, lag ${lag.toFixed(2)} deg`
    )
  }
}

function shifter(params: ParamValue[]): PatchDocument {
  return doc(
    'modfx',
    [IN, obj('f', 'logue/util/freq-shift', params), OUT],
    [wire('in', 'r', 'f', 'in'), wire('f', 'shifted', 'out', 'l'), wire('f', 'mirror', 'out', 'r')]
  )
}

for (const [inHz, shiftHz, minDb] of [
  [1000, 100, 40],
  [1000, -100, 40],
  [440, 7, 40],
  [5000, 1500, 40],
  [50, 200, 40],
  [30, 200, 35],
  [20, 200, 30]
] as const) {
  const r = render(shifter([{ name: 'SHIFT', value: shiftRaw(shiftHz) }]), [], inHz)
  const wanted = tone(r.outL, inHz + shiftHz).amp
  const wrong = tone(r.outL, Math.abs(inHz - shiftHz)).amp
  const mirrorWanted = tone(r.outR, Math.abs(inHz - shiftHz)).amp
  const mirrorWrong = tone(r.outR, inHz + shiftHz).amp
  const carrier = Math.max(tone(r.outL, inHz).amp, tone(r.outR, inHz).amp)
  check(
    `freq-shift ${inHz} Hz by ${shiftHz > 0 ? '+' : ''}${shiftHz} Hz: shifted to ${inHz + shiftHz}, mirror to ${Math.abs(inHz - shiftHz)}, other sideband below -${minDb} dB`,
    Math.abs(db(wanted, 0.3)) < 0.1 &&
      Math.abs(db(mirrorWanted, 0.3)) < 0.1 &&
      db(wrong, wanted) < -minDb &&
      db(mirrorWrong, mirrorWanted) < -minDb &&
      db(carrier, 0.3) < -60 &&
      allFinite(r),
    `shifted ${db(wanted, 0.3).toFixed(2)} dB, wrong ${db(wrong, wanted).toFixed(1)} dB; mirror wrong ${db(mirrorWrong, mirrorWanted).toFixed(1)} dB; input left ${db(carrier, 0.3).toFixed(1)} dB`
  )
}

{
  const r = render(
    shifter([
      { name: 'MIX', value: '0' },
      { name: 'FEEDBACK', value: '100' }
    ]),
    [],
    'noise'
  )
  check(
    'freq-shift: MIX 0 is the dry input (FEEDBACK 100 too)',
    maxAbsDiff(r.outL, r.inR) === 0 && maxAbsDiff(r.outR, r.inR) === 0,
    `max diff ${Math.max(maxAbsDiff(r.outL, r.inR), maxAbsDiff(r.outR, r.inR))}`
  )
}

/** The shifter behind a 0.25x VCA on each output: the unit clips at +-1, which would hide how
 *  far the feedback loop really goes. */
function attenuatedShifter(params: ParamValue[]): PatchDocument {
  const quarter = (name: string): ObjNode =>
    obj(name, 'logue/gain/vca', [{ name: 'GAIN', value: '6.25' }])
  return doc(
    'modfx',
    [IN, obj('f', 'logue/util/freq-shift', params), quarter('al'), quarter('ar'), OUT],
    [
      wire('in', 'r', 'f', 'in'),
      wire('f', 'shifted', 'al', 'in'),
      wire('f', 'mirror', 'ar', 'in'),
      wire('al', 'out', 'out', 'l'),
      wire('ar', 'out', 'out', 'r')
    ]
  )
}

for (const [input, shift, limit] of [
  // Full-scale noise (an effect's input is ~0.18): bounded, not small.
  ['loud-noise', '25', 4],
  ['loud-noise', '-3', 4],
  ['impulse', '8', 1],
  // A DC offset at SHIFT 0 (the TIME knob's middle): the pair passes DC at +1, so without the
  // blocker on the fed-back term FEEDBACK 90% would park it near 10x. It must stay the input's.
  ['small-dc', '0', 0.12],
  ['small-dc', '1', 0.12],
  ['small-dc', '-1', 0.12],
  ['dc', '0', 0.6],
  ['dc', '2', 0.6]
] as const) {
  for (const feedback of ['100', '-100']) {
    const r = render(
      attenuatedShifter([
        { name: 'SHIFT', value: shift },
        { name: 'FEEDBACK', value: feedback }
      ]),
      [],
      input
    )
    // Real level (x4), after the first half second.
    const settled = (a: Float32Array): number => 4 * Math.max(...a.slice(24000).map(Math.abs))
    const peak = 4 * Math.max(...r.outL.map(Math.abs), ...r.outR.map(Math.abs))
    const late = Math.max(settled(r.outL), settled(r.outR))
    check(
      `freq-shift: FEEDBACK ${feedback} on ${input}, SHIFT ${shift}: settles under ${limit}`,
      allFinite(r) && late < limit && peak < 5,
      `peak ${peak.toFixed(3)}, settled ${late.toFixed(3)}`
    )
  }
}

function bufferPatch(taps: ParamValue[][], feedback: boolean, freeze = false): PatchDocument {
  const nodes = [IN, obj('b', 'logue/util/buffer', [{ name: 'LENGTH', value: '0' }]), OUT]
  const nets = [
    wire('t0', 'out', 'out', 'l'),
    ...(taps.length > 1 ? [wire('t1', 'out', 'out', 'r')] : [])
  ]
  taps.forEach((params, i) => {
    nodes.push(obj(`t${i}`, 'logue/util/buffer-tap', params))
    nets.push(wire('b', 'buf', `t${i}`, 'buf'))
  })
  if (feedback) {
    nodes.push(obj('m', 'logue/mix/mix2'))
    nets.push(
      wire('in', 'r', 'm', 'in1'),
      wire('t0', 'out', 'm', 'in2'),
      wire('m', 'out', 'b', 'in')
    )
  } else {
    nets.push(wire('in', 'r', 'b', 'in'))
  }
  if (freeze) nets.push(wire('in', 'l', 'b', 'freeze'))
  return doc('delfx', nodes, nets)
}
/** The |x|-weighted mean index of a window, less `origin`. */
function peakAt(a: Float32Array, from: number, to: number, origin: number): number {
  let sum = 0
  let weight = 0
  for (let i = from; i < to; i++) {
    sum += i * Math.abs(a[i])
    weight += Math.abs(a[i])
  }
  return sum / weight - origin
}
const windowPeak = (a: Float32Array, from: number, to: number): number => {
  let m = 0
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i]))
  return m
}

{
  // LENGTH 0 is 32768 samples: TIME 0 = 3 samples, TIME 50 = 3 + 0.5 * (32767 - 4) = 16384.5.
  const r = render(
    bufferPatch([[{ name: 'TIME', value: '0' }], [{ name: 'TIME', value: '50' }]], false),
    [],
    'impulse'
  )
  const near = peakAt(r.outL, 0, 1000, 100)
  const far = peakAt(r.outR, 1000, FRAMES, 100)
  check('buffer-tap: TIME 0 is 3 samples', Math.abs(near - 3) < 1e-3 && allFinite(r), `at ${near}`)
  check('buffer-tap: TIME 50 is half the buffer', Math.abs(far - 16384.5) < 0.05, `at ${far}`)
  check(
    'buffer: dirty SDRAM is cleared (silence before the far tap)',
    windowPeak(r.outR, 0, 16000) === 0,
    `max ${windowPeak(r.outR, 0, 16000)}`
  )
}

{
  // in -> mix2 (the average) -> buffer, the tap back into mix2: echoes at D and 2D, halving.
  const r = render(bufferPatch([[{ name: 'TIME', value: '50' }]], true), [], 'impulse')
  // Sums, not peaks: a half-sample read smears the impulse, but interpolation keeps its sum.
  const sum = (from: number, to: number): number =>
    r.outL.slice(from, to).reduce((a, b) => a + b, 0)
  const first = sum(16000, 17000)
  const second = sum(32000, 34000)
  const at2 = peakAt(r.outL, 32000, 34000, 100)
  check(
    'buffer: a tap fed back into its own buffer echoes (no sample-delay needed)',
    Math.abs(at2 - 2 * 16384.5) < 0.1 && Math.abs(second / first - 0.5) < 1e-3 && allFinite(r),
    `second echo at ${at2.toFixed(3)}, ${(second / first).toFixed(4)} of the first`
  )
}

{
  // Recording noise; the freeze gate opens at 40000. From one ring length (+ the ~50 ms glide)
  // later, the tap must repeat itself exactly with the ring's period while the input goes on.
  const r = render(
    bufferPatch([[{ name: 'TIME', value: '0' }]], false, true),
    [],
    'noise-freeze',
    false,
    undefined,
    undefined,
    96000
  )
  let loopDiff = 0
  for (let n = 40000 + 32768 + 4000; n < 96000; n++)
    loopDiff = Math.max(loopDiff, Math.abs(r.outL[n] - r.outL[n - 32768]))
  let recDiff = 0
  for (let n = 1000; n < 40000; n++) recDiff = Math.max(recDiff, Math.abs(r.outL[n] - r.inR[n - 3]))
  check(
    'buffer: recording is the input, 16-bit (before the freeze)',
    recDiff < 1e-4 && allFinite(r),
    `max diff ${recDiff}`
  )
  check('buffer: FREEZE loops the content bit-exactly', loopDiff === 0, `max diff ${loopDiff}`)
  check(
    'buffer: frozen content is not silence',
    rms(r.outL, 80000) > 0.1,
    `rms ${rms(r.outL, 80000).toFixed(3)}`
  )
}

function grainPatch(params: ParamValue[], trig: boolean): PatchDocument {
  return doc(
    'delfx',
    [
      IN,
      obj('b', 'logue/util/buffer', [{ name: 'LENGTH', value: '0' }]),
      obj('g', 'logue/util/grain', params),
      OUT
    ],
    [
      wire('in', 'r', 'b', 'in'),
      wire('b', 'buf', 'g', 'buf'),
      ...(trig ? [wire('in', 'l', 'g', 'trig')] : []),
      wire('g', 'out', 'out', 'l')
    ]
  )
}
// MAXLEN 0 and SIZE 100: a 16384-sample grain. FADE 0: 16-sample ramps.
const GRAIN_FULL: ParamValue[] = [
  { name: 'MAXLEN', value: '0' },
  { name: 'SIZE', value: '100' },
  { name: 'FADE', value: '0' }
]

{
  // Triggered at n = 1000 with POSITION 0 (delay 1): it records the input from n = 999 on.
  const r = render(grainPatch(GRAIN_FULL, true), [], 'noise-trig')
  let capDiff = 0
  for (let i = 16; i < 16384 - 16; i++)
    capDiff = Math.max(capDiff, Math.abs(r.outL[1000 + i] - r.inR[999 + i]))
  let loopDiff = 0
  for (let n = 1000 + 16384 + 16; n < 30011; n++)
    loopDiff = Math.max(loopDiff, Math.abs(r.outL[n] - r.outL[n - 16384]))
  // The end of the first pass and the start of the second.
  const seam = Math.max(Math.abs(r.outL[1000 + 16384]), Math.abs(r.outL[1000 + 16384 - 1]))
  check(
    'grain: records the buffer at its position (16-bit)',
    capDiff < 1e-4 && allFinite(r) && windowPeak(r.outL, 0, 1000) === 0,
    `max diff ${capDiff}, silent before the trigger`
  )
  check('grain: loops its table bit-exactly at SIZE', loopDiff === 0, `max diff ${loopDiff}`)
  check('grain: the loop seam is faded to ~0', seam < 0.03, `|x| at the seam ${seam.toFixed(4)}`)
}

{
  // POSITION 50 of a 32768 ring: delay 1 + 0.5 * 32767 = 16384.
  const r = render(
    grainPatch([...GRAIN_FULL, { name: 'POSITION', value: '50' }], true),
    [],
    'noise-trig'
  )
  let diff = 0
  for (let i = 16; i < 1000; i++)
    diff = Math.max(diff, Math.abs(r.outL[30011 + i] - r.inR[30011 + i - 16384]))
  check('grain: POSITION 50 reads half the buffer back', diff < 1e-4, `max diff ${diff}`)
}

{
  // A sine: its largest step is 0.3 * 2 pi 200 / 48000 = 0.008; a retrigger (n = 30011, in the
  // middle of a loop) must not add a jump bigger than the ramps' own slope.
  const r = render(
    grainPatch(
      [
        { name: 'MAXLEN', value: '0' },
        { name: 'SIZE', value: '40' },
        { name: 'FADE', value: '10' }
      ],
      true
    ),
    [],
    'sine-trig'
  )
  let jump = 0
  for (let n = 29900; n < 31000; n++) jump = Math.max(jump, Math.abs(r.outL[n] - r.outL[n - 1]))
  check(
    'grain: a retrigger mid-loop does not click',
    jump < 0.02 && rms(r.outL, 31000) > 0.05 && allFinite(r),
    `largest step ${jump.toFixed(4)}`
  )
}

{
  // Unwired trig: a fresh grain every pass, so it follows the input (a delayed, windowed copy).
  const r = render(grainPatch([{ name: 'SIZE', value: '30' }], false), [], 'noise')
  check(
    'grain: an unwired trig retriggers itself',
    rms(r.outL, 24000) > 0.1 && allFinite(r),
    `rms ${rms(r.outL, 24000).toFixed(3)}`
  )
}

{
  // in.l hard left, then in.r hard right onto the same bus: the two channels come back exactly.
  const hard = render(
    doc(
      'delfx',
      [
        IN,
        obj('p1', 'logue/mix/pan', [{ name: 'PAN', value: '-100' }]),
        obj('p2', 'logue/mix/pan', [{ name: 'PAN', value: '100' }]),
        OUT
      ],
      [
        wire('in', 'l', 'p1', 'in'),
        wire('in', 'r', 'p2', 'in'),
        wire('p1', 'l', 'p2', 'l'),
        wire('p1', 'r', 'p2', 'r'),
        wire('p2', 'l', 'out', 'l'),
        wire('p2', 'r', 'out', 'r')
      ]
    ),
    [],
    'sines'
  )
  const d = Math.max(maxAbsDiff(hard.outL, hard.inL), maxAbsDiff(hard.outR, hard.inR))
  check('pan: a chain puts each input hard left / right', d === 0, `max diff ${d}`)
  const center = render(
    doc(
      'delfx',
      [IN, obj('p', 'logue/mix/pan'), OUT],
      [wire('in', 'l', 'p', 'in'), wire('p', 'l', 'out', 'l'), wire('p', 'r', 'out', 'r')]
    ),
    [],
    'sines'
  )
  const ratio = rms(center.outL) / rms(center.inL)
  check(
    'pan: centre is -3 dB on both sides',
    Math.abs(ratio - Math.SQRT1_2) < 1e-4 && maxAbsDiff(center.outL, center.outR) === 0,
    `gain ${ratio.toFixed(5)}`
  )
}

{
  // A wired pan (control rate, ramped): DC into a pan swept by a sine LFO over the whole field.
  // Equal power must hold throughout, the gains must not step, and the sweep must reach both sides.
  const r = render(
    doc(
      'delfx',
      [
        IN,
        obj('lfo', 'logue/lfo/sine-lfo', [{ name: 'RATE', value: '60' }]),
        obj('p', 'logue/mix/pan', [{ name: 'PAN', value: '0' }]),
        OUT
      ],
      [
        wire('in', 'r', 'p', 'in'),
        wire('lfo', 'out', 'p', 'pan'),
        wire('p', 'l', 'out', 'l'),
        wire('p', 'r', 'out', 'r')
      ]
    ),
    [],
    'dc'
  )
  let powerDev = 0
  let step = 0
  for (let n = 64; n < r.outL.length; n++) {
    powerDev = Math.max(powerDev, Math.abs(r.outL[n] ** 2 + r.outR[n] ** 2 - 0.25) / 0.25)
    step = Math.max(step, Math.abs(r.outL[n] - r.outL[n - 1]), Math.abs(r.outR[n] - r.outR[n - 1]))
  }
  const reach = Math.min(
    windowPeak(r.outL, 64, r.outL.length),
    windowPeak(r.outR, 64, r.outR.length)
  )
  check(
    'pan: a wired sweep keeps equal power, without steps, across the field',
    powerDev < 0.01 && step < 1e-3 && reach > 0.49 && allFinite(r),
    `power within ${(powerDev * 100).toFixed(3)} %, largest step ${step.toExponential(2)}, peaks ${reach.toFixed(3)}`
  )
}

{
  const width = (value: string): Run =>
    render(
      doc(
        'delfx',
        [IN, obj('w', 'logue/mix/width', [{ name: 'WIDTH', value }]), OUT],
        [
          wire('in', 'l', 'w', 'l'),
          wire('in', 'r', 'w', 'r'),
          wire('w', 'l', 'out', 'l'),
          wire('w', 'r', 'out', 'r')
        ]
      ),
      [],
      'sines'
    )
  const mono = width('0')
  let midDiff = 0
  for (let i = 0; i < FRAMES; i++)
    midDiff = Math.max(midDiff, Math.abs(mono.outL[i] - (mono.inL[i] + mono.inR[i]) / 2))
  check(
    'width: 0 is the mid on both sides',
    midDiff < 1e-6 && maxAbsDiff(mono.outL, mono.outR) === 0,
    `max diff ${midDiff}`
  )
  const full = width('100')
  const d = Math.max(maxAbsDiff(full.outL, full.inL), maxAbsDiff(full.outR, full.inR))
  check('width: 100 leaves the pair as it is', d < 1e-6, `max diff ${d}`)
}

{
  const passed = (chance: string): number => {
    const r = render(
      doc(
        'delfx',
        [IN, obj('c', 'logue/logic/chance', [{ name: 'CHANCE', value: chance }]), OUT],
        [wire('in', 'l', 'c', 'trig'), wire('c', 'out', 'out', 'l')]
      ),
      [],
      'pulses'
    )
    return r.outL.filter((v) => v === 1).length / r.inL.filter((v) => v === 1).length
  }
  const [none, half, all] = [passed('0'), passed('50'), passed('100')]
  check(
    'chance: CHANCE 0 / 50 / 100 let none / about half / all of the gates through',
    none === 0 && Math.abs(half - 0.5) < 0.07 && all === 1,
    `${none}, ${half.toFixed(3)}, ${all}`
  )
}

{
  const r = render(
    doc(
      'delfx',
      [IN, obj('rr', 'logue/logic/round-robin', [{ name: 'VOICES', value: '3' }]), OUT],
      [wire('in', 'l', 'rr', 'trig'), wire('rr', 'o1', 'out', 'l'), wire('rr', 'o2', 'out', 'r')]
    ),
    [],
    'pulses'
  )
  // Gates at 0, 100, 200, ...: o1 takes gates 0, 3, 6, ..., o2 gates 1, 4, 7, ...
  let ok = true
  for (let k = 0; k < FRAMES / 100; k++) {
    ok &&= r.outL[k * 100] === (k % 3 === 0 ? 1 : 0) && r.outR[k * 100] === (k % 3 === 1 ? 1 : 0)
  }
  const stray = r.outL.filter((v, i) => v !== 0 && i % 100 !== 0).length
  check('round-robin: VOICES 3 hands gates to o1, o2, o3 in turn', ok && stray === 0, `${ok}`)
}

{
  // DECAY 5 = 5 + 0.05 * 1995 = 104.75 ms = 5028 samples, the time constant; ATTACK 0 = 5 ms =
  // 240 samples; the trigger (0.5) is at n = 100, so the decay starts at ~n = 340. With the
  // hundredth linear floor the level is 1.01 e^(-t/T) - 0.01: 0.3616 at T, 0 by ~4.6 T.
  const r = render(
    doc(
      'delfx',
      [
        IN,
        obj('e', 'logue/env/ad', [
          { name: 'ATTACK', value: '0' },
          { name: 'DECAY', value: '5' },
          { name: 'EXP', value: '100' }
        ]),
        OUT
      ],
      [wire('in', 'r', 'e', 'trig'), wire('e', 'out', 'out', 'l')]
    ),
    [],
    'impulse'
  )
  const atT = r.outL[340 + 5028]
  const at3T = r.outL[340 + 3 * 5028]
  const after = windowPeak(r.outL, 340 + 5 * 5028, r.outL.length)
  check(
    'env/ad EXP: DECAY is the time constant (-8.7 dB at T), then 0 after ~4.6 T',
    Math.abs(atT - 0.3616) < 0.005 &&
      Math.abs(at3T - 0.0403) < 0.003 &&
      after === 0 &&
      allFinite(r),
    `${atT.toFixed(4)} at T, ${at3T.toFixed(4)} at 3T`
  )
}

/**
 * in.r -> buffer (LENGTH 0, 32768) -> reverse-tap; `l`/`r` name the tap's outlets sent to the
 * output. `sweep` wires a sine LFO into `size`, so the segment length keeps changing.
 */
function reversePatch(params: ParamValue[], l: string, r: string, sweep: boolean): PatchDocument {
  return doc(
    'delfx',
    [
      IN,
      obj('b', 'logue/util/buffer', [{ name: 'LENGTH', value: '0' }]),
      obj('rv', 'logue/util/reverse-tap', params),
      ...(sweep ? [obj('lfo', 'logue/lfo/sine-lfo', [{ name: 'RATE', value: '40' }])] : []),
      OUT
    ],
    [
      wire('in', 'r', 'b', 'in'),
      wire('b', 'buf', 'rv', 'buf'),
      ...(sweep ? [wire('lfo', 'out', 'rv', 'size')] : []),
      wire('rv', l, 'out', 'l'),
      wire('rv', r, 'out', 'r')
    ]
  )
}

/**
 * Checks one head from a render of its audio (L) and its phase (R): each segment starts where
 * the phase is 0, and inside its flat part (WINDOW 0: past the 240-sample fades) sample c must
 * be the input from c + 1 samples before the segment began -- played backwards at exactly the
 * recorded speed. Returns the segment lengths and the largest mismatch.
 */
function reverseSegments(r: Run): { lengths: number[]; starts: number[]; diff: number } {
  const starts: number[] = []
  // A segment's first sample has phase 0 and its second more (b's phase is also 0 before b starts).
  for (let n = 0; n + 1 < r.outR.length; n++)
    if (r.outR[n] === 0 && r.outR[n + 1] > 0) starts.push(n)
  const lengths: number[] = []
  let diff = 0
  for (let k = 0; k + 1 < starts.length; k++) {
    const s0 = starts[k]
    const len = starts[k + 1] - s0
    lengths.push(len)
    for (let c = 240; c < len - 240; c++) {
      const want = s0 - c - 1 >= 0 ? r.inR[s0 - c - 1] : 0
      diff = Math.max(diff, Math.abs(r.outL[s0 + c] - want))
    }
  }
  return { lengths, starts, diff }
}

{
  // SIZE 0 = 1920-sample segments; head b's start half a segment after a's.
  const a = render(
    reversePatch(
      [
        { name: 'SIZE', value: '0' },
        { name: 'WINDOW', value: '0' }
      ],
      'a',
      'phaseA',
      false
    ),
    [],
    'noise'
  )
  const b = render(
    reversePatch(
      [
        { name: 'SIZE', value: '0' },
        { name: 'WINDOW', value: '0' }
      ],
      'b',
      'phaseB',
      false
    ),
    [],
    'noise'
  )
  const sa = reverseSegments(a)
  const sb = reverseSegments(b)
  check(
    'reverse-tap: head a plays each 1920-sample segment backwards, sample-exact',
    sa.lengths.every((n) => n === 1920) && sa.diff < 1e-4 && allFinite(a),
    `${sa.lengths.length} segments, max diff ${sa.diff}`
  )
  check(
    'reverse-tap: head b the same, starting half a segment later',
    sb.lengths.every((n) => n === 1920) && sb.diff < 1e-4 && sb.starts[0] === 960 && allFinite(b),
    `first start ${sb.starts[0]}, max diff ${sb.diff}`
  )
  check(
    'reverse-tap: dirty SDRAM is cleared (silence until there is something to reverse)',
    windowPeak(a.outL, 0, 1920) === 0,
    `max ${windowPeak(a.outL, 0, 1920)}`
  )
}

{
  // SIZE swept by an LFO (40 % +- 50, so it hits both ends): every segment must still be an
  // exact reversal, with even lengths that really changed.
  const a = render(
    reversePatch([{ name: 'WINDOW', value: '0' }], 'a', 'phaseA', true),
    [],
    'noise',
    false,
    undefined,
    undefined,
    192000
  )
  const b = render(
    reversePatch([{ name: 'WINDOW', value: '0' }], 'b', 'phaseB', true),
    [],
    'noise',
    false,
    undefined,
    undefined,
    192000
  )
  const sa = reverseSegments(a)
  const sb = reverseSegments(b)
  const lens = [...sa.lengths, ...sb.lengths]
  check(
    'reverse-tap: a moving SIZE keeps every segment an exact reversal (no pitch error)',
    sa.diff < 1e-4 &&
      sb.diff < 1e-4 &&
      Math.min(...lens) < 4000 &&
      Math.max(...lens) > 12000 &&
      allFinite(a) &&
      allFinite(b),
    `${lens.length} segments, ${Math.min(...lens)}..${Math.max(...lens)} samples, max diff ${Math.max(sa.diff, sb.diff)}`
  )
}

{
  // WINDOW 100 on DC: a + b must be the DC exactly once both heads read recorded audio, with
  // SIZE fixed and while it moves (the fades of the two heads must stay matched).
  for (const sweep of [false, true]) {
    const d = reversePatch([], 'a', 'b', sweep)
    const r = render(d, [], 'dc', false, undefined, undefined, 192000)
    let dev = 0
    for (let n = 40000; n < r.outL.length; n++)
      dev = Math.max(dev, Math.abs(r.outL[n] + r.outR[n] - 0.5))
    check(
      `reverse-tap: WINDOW 100, a + b is constant gain${sweep ? ' while SIZE moves' : ''}`,
      dev < 1e-3 && allFinite(r),
      `max deviation ${dev.toExponential(2)}`
    )
  }
}

/**
 * For each reversed pluck one head plays (`a` on L, `phaseA` on R; plucks start every 48000
 * samples), the level in the 5 ms before the head reaches the attack -- where a reversed pluck
 * stops -- in dB below the loudest 5 ms of that segment. 0 dB: it stops on its loudest moment.
 */
function reversedPluckEnds(r: Run): number[] {
  const rmsOf = (from: number, to: number): number => {
    let e = 0
    for (let i = from; i < to; i++) e += r.outL[i] ** 2
    return Math.sqrt(e / (to - from))
  }
  const ends: number[] = []
  for (let s0 = 1; s0 + 1 < r.outR.length; s0++) {
    if (!(r.outR[s0] === 0 && r.outR[s0 + 1] > 0)) continue
    let n = s0 + 1
    while (n < r.outR.length && r.outR[n] > 0) n++
    // The head reads in[s0 - c - 1] at s0 + c: the pluck at t0 is reached at c = s0 - t0 - 1.
    const t0 = Math.floor((s0 - 1) / 48000) * 48000
    const c = s0 - t0 - 1
    if (t0 === 0 || c < 2400 || c >= n - s0) continue
    let loudest = 0
    for (let k = s0; k + 240 <= s0 + c; k += 120) loudest = Math.max(loudest, rmsOf(k, k + 240))
    ends.push(20 * Math.log10(rmsOf(s0 + c - 240, s0 + c) / loudest))
  }
  return ends
}

for (const file of ['reverse-wash.loguepatch', 'reverse-wash-xd.loguepatch']) {
  const d = parsePatchFile(readFileSync(join(examplesDir, file), 'utf-8'))
  // SOFTEN on its own: the first line's head a straight out (L), its phase on R, WINDOW 0
  // (slot 9; the xd version's is authored, so it is given 0 here), no feedback. SOFTEN (slot 6)
  // off and at 100, its authored value (the xd version is checked at that only).
  const oneHead: PatchDocument = {
    ...d,
    // The rest of the patch is now unwired, so only SOFTEN, TIME and DEPTH keep their controls.
    nodes: d.nodes.map((n) =>
      n.kind !== 'obj'
        ? n
        : {
            ...n,
            params: n.params?.map((p) =>
              n.name === 'rev-1' && p.name === 'WINDOW'
                ? { name: p.name, value: '0' }
                : ['soften', 'time', 'depth'].includes(n.name ?? '')
                  ? p
                  : { name: p.name, value: p.value }
            )
          }
    ),
    nets: [
      ...d.nets.filter((n) => !n.dests.some((x) => x.obj === 'audio-out')),
      wire('rev-1', 'a', 'audio-out', 'l'),
      wire('rev-1', 'phaseA', 'audio-out', 'r')
    ]
  }
  const ends = (soften: number): number[] =>
    reversedPluckEnds(
      render(
        oneHead,
        [
          [0, 512],
          [1, 0],
          [6, soften]
        ],
        'plucks',
        false,
        undefined,
        undefined,
        240000
      )
    )
  const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length
  const soft = ends(100)
  if (file === 'reverse-wash.loguepatch') {
    const hard = ends(0)
    check(
      'reverse-wash: SOFTEN 100 turns a reversed pluck down before it stops',
      hard.length >= 3 && mean(hard) > -3 && mean(soft) < mean(hard) - 8,
      `the last 5 ms vs the loudest: ${mean(hard).toFixed(1)} dB at SOFTEN 0, ${mean(soft).toFixed(1)} dB at 100 (${hard.length} plucks)`
    )
  } else
    check(
      'reverse-wash-xd: its SOFTEN turns a reversed pluck down before it stops',
      soft.length >= 3 && mean(soft) < -8,
      `the last 5 ms vs the loudest: ${mean(soft).toFixed(1)} dB (${soft.length} plucks)`
    )
  // Steady noise, fully wet: L and R must differ (the heads pan apart), at a level near the mono
  // input's (half the noise on R; TONE's lowpass takes ~7 dB off white noise), no ducking.
  const wet = render(
    d,
    [
      [0, 512],
      [1, 0],
      [2, 1000]
    ],
    'noise',
    false,
    undefined,
    undefined,
    144000
  )
  let lr = 0
  let ll = 0
  let rr = 0
  for (let n = 48000; n < wet.outL.length; n++) {
    lr += wet.outL[n] * wet.outR[n]
    ll += wet.outL[n] ** 2
    rr += wet.outR[n] ** 2
  }
  const corr = lr / Math.sqrt(ll * rr)
  const level =
    20 *
    Math.log10(Math.sqrt((ll + rr) / 2 / (wet.outL.length - 48000)) / (0.5 * rms(wet.inR, 48000)))
  check(
    `${file}: a stereo image (L/R correlation under 0.9), wet level within 10 dB of the mono input`,
    corr < 0.9 && level > -10 && allFinite(wet),
    `correlation ${corr.toFixed(3)}, wet ${level.toFixed(1)} dB`
  )
  // DEPTH fully up on noise for 0.5 s, then 9.5 s of silence: the wash must die away, not hold
  // or build up. On the NTS-1 mkII version with the menu at its loop gain's worst -- SPREAD and
  // MOTION 0 (every head centred, the largest L + R) and TONE open -- the xd version (no menu)
  // as authored.
  const worst: Array<[number, number]> =
    file === 'reverse-wash.loguepatch'
      ? [
          [3, 0],
          [4, 0],
          [8, 100]
        ]
      : []
  const fb = render(
    d,
    [[0, 700], [1, 1023], [2, 1000], ...worst],
    'noise-burst',
    false,
    undefined,
    undefined,
    480000
  )
  const peak = Math.max(
    windowPeak(fb.outL, 0, fb.outL.length),
    windowPeak(fb.outR, 0, fb.outR.length)
  )
  const second = (k: number): number => {
    let e = 0
    for (let n = k * 48000; n < (k + 1) * 48000; n++) e += fb.outL[n] ** 2 + fb.outR[n] ** 2
    return Math.sqrt(e / 96000)
  }
  const tail = [2, 3, 4, 5, 6, 7, 8, 9].map(second)
  check(
    `${file}: full feedback stays bounded and dies away after the input stops`,
    allFinite(fb) &&
      peak < 1.5 &&
      tail[0] > 0.001 &&
      tail.every((x, k) => k === 0 || x <= 1.05 * tail[k - 1]) &&
      tail[7] < 0.2 * tail[0],
    `peak ${peak.toFixed(3)}, rms per second from 2 s ${tail.map((x) => x.toFixed(4)).join(' ')}`
  )
}

{
  // Noise, MIX fully wet, TIME at 70 % (a ~6 Hz clock): every voice has fired within 1.3 s,
  // most of them late enough to find noise up to 0.8 s back, so both sides loop grains of it.
  const d = parsePatchFile(readFileSync(join(examplesDir, 'grain-mill.loguepatch'), 'utf-8'))
  // GM_PARAMS=slot:value,... / GM_INPUT: to explore the example by ear-less numbers.
  const gmParams: Array<[number, number]> = process.env.GM_PARAMS
    ? process.env.GM_PARAMS.split(',').map((kv) => kv.split(':').map(Number) as [number, number])
    : [
        [0, 700],
        [2, 1000]
      ]
  const r = render(
    d,
    gmParams,
    (process.env.GM_INPUT as 'noise' | undefined) ?? 'noise',
    false,
    undefined,
    undefined,
    Number(process.env.GM_FRAMES ?? 96000),
    exampleSubpatches()
  )
  if (process.env.GM_PROBE_L) {
    console.log(
      process.env.GM_PROBE_L,
      Math.max(...r.outL.map(Math.abs)).toFixed(4),
      rms(r.outL).toFixed(4),
      '|',
      process.env.GM_PROBE_R,
      Math.max(...r.outR.map(Math.abs)).toFixed(4),
      rms(r.outR).toFixed(4)
    )
  }
  if (process.env.GM_PARAMS) {
    const w = (from: number): string => ((rms(r.outL, from) + rms(r.outR, from)) / 2).toFixed(4)
    console.log(
      `GM ${process.env.GM_PARAMS} in ${rms(r.inR).toFixed(3)} out ` +
        [0, 0.5, 1, 1.5, 3, 5]
          .filter((t) => t * 48000 < r.outL.length)
          .map((t) => `${t}s+ ${w(t * 48000)}`)
          .join(' ') +
        ` peak ${windowPeak(r.outL, 0, r.outL.length).toFixed(3)}`
    )
  }
  const late = Math.min(rms(r.outL, 72000), rms(r.outR, 72000))
  const peak = Math.max(windowPeak(r.outL, 0, r.outL.length), windowPeak(r.outR, 0, r.outR.length))
  check(
    'grain-mill example: finite, and both sides sound once the voices have fired',
    allFinite(r) && late > 0.005,
    `rms after 1.5 s L/R ${rms(r.outL, 72000).toFixed(3)}/${rms(r.outR, 72000).toFixed(3)}, peak ${peak.toFixed(3)}`
  )
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)

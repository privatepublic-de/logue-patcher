/**
 * One-off verification for `logue/filter/eq-band`, `logue/filter/tilt` and `svf`'s `notch`/`ap`
 * outlets (2026-10-05): renders them into the xd output under ASan/UBSan
 * (`harness/minilogue-xd/`).
 * - Response: quiet white noise through the filter against the same noise unfiltered, the
 *   transfer function (Welch cross-spectrum, Hann, 16K segments) at a set of frequencies, next to
 *   the bilinear prototype's exact response for the coefficients the C computes (in double, with
 *   g = tan(pi*f0/fs) and `exp` for exp_approx). Also the design targets: a bell's GAIN at FREQ,
 *   a shelf's two plateaus and its half-gain point, notch depth, tilt's pivot and extremes, the
 *   svf allpass's flatness.
 * - Pass-through: GAIN 0 (bell/shelves) and TILT 0 equal an unfiltered render bit for bit.
 * - Moving paths: `freq`/`gain`/`q`/`tilt`/`center` fed from `sense/gate` x a constant (per
 *   sample to codegen, constant once the note is on) must match the dial at the same value.
 * - Sweep: a sine through a +18 dB, Q 8 bell whose FREQ an LFO sweeps fast: the largest
 *   sample-to-sample step, against a 1-sample-update reference, shows any zipper/click.
 * - Fuzz: noise with LFOs into every inlet, every TYPE, extreme settings: finite.
 *
 * Usage: npx tsx logue-codegen/scripts/runEqHarness.ts
 */
import { execFileSync } from 'child_process'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const SR = 48000
const harnessDir = join(dirname(new URL(import.meta.url).pathname), '..', 'harness', 'minilogue-xd')

type Params = Record<string, number>
type Node = PatchDocument['nodes'][number]
type Net = PatchDocument['nets'][number]
const obj = (type: string, name: string, params: Params = {}): Node => ({
  kind: 'obj',
  type,
  name,
  x: 0,
  y: 0,
  params: Object.entries(params).map(([n, v]) => ({ name: n, value: String(v) }))
})
const net = (from: string, outlet: string, to: string, inlet: string): Net => ({
  sources: [{ obj: from, outlet }],
  dests: [{ obj: to, inlet }]
})

/** Quiet white noise (LEVEL 50: -24 dB, peak ~0.063) -> `type` -> out. */
function doc(
  type: string | undefined,
  params: Params,
  extra: { nodes?: Node[]; nets?: Net[]; outlet?: string; source?: Node } = {}
): PatchDocument {
  const source = extra.source ?? obj('logue/osc/noise', 'n', { LEVEL: 50 })
  const nodes = [source, obj('logue/io/audio-out', 'out'), ...(extra.nodes ?? [])]
  const nets = [...(extra.nets ?? [])]
  if (!type) nets.push(net(source.name!, 'out', 'out', 'in'))
  else {
    nodes.push(obj(type, 'f', params))
    nets.push(net(source.name!, 'out', 'f', 'in'), net('f', extra.outlet ?? 'out', 'out', 'in'))
  }
  return { nodes, nets, settings: {}, notes: '' }
}

function render(d: PatchDocument, samples: number, note = 60): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), 'lp-eq-harness-'))
  copyFileSync(join(harnessDir, 'userosc.h'), join(dir, 'userosc.h'))
  writeFileSync(join(dir, 'osc_real.cpp'), generateOldGenOscUnit(d, { name: 'harness' }).oscCpp)
  writeFileSync(
    join(dir, 'main.cpp'),
    `#include <cmath>
#include <cstdio>
#include <cstring>
#include "osc_real.cpp"
int main() {
  user_osc_param_t p;
  memset(&p, 0, sizeof(p));
  p.pitch = (${note} << 8);
  OSC_INIT(0, 0);
  OSC_NOTEON(&p);
  static int32_t buf[64];
  FILE *raw = fopen("out.raw", "wb");
  for (unsigned done = 0; done < ${samples}; done += 64) {
    OSC_CYCLE(&p, buf, 64);
    for (unsigned i = 0; i < 64; i++) { float f = q31_to_f32(buf[i]); fwrite(&f, 4, 1, raw); }
  }
  fclose(raw);
}
`
  )
  execFileSync(
    'c++',
    [
      '-std=c++17',
      '-O1',
      '-fsanitize=address,undefined',
      '-fno-sanitize-recover=all',
      '-I.',
      'main.cpp',
      '-o',
      'harness'
    ],
    { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] }
  )
  execFileSync(join(dir, 'harness'), [], { cwd: dir, stdio: 'inherit' })
  const b = readFileSync(join(dir, 'out.raw'))
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)
}

let failures = 0
const check = (ok: boolean, what: string): void => {
  if (!ok) {
    failures++
    console.log(`  FAIL: ${what}`)
  }
}
const dB = (g: number): number => 20 * Math.log10(g)
const fmt = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`

const N = 16 * SR
const SEG = 16384
/** |H(f)| from input x and output y: Welch cross-spectrum over Hann-windowed segments. */
function response(x: Float32Array, y: Float32Array, f: number): number {
  let sxyRe = 0
  let sxyIm = 0
  let sxx = 0
  const w = (2 * Math.PI * f) / SR
  for (let start = SEG; start + SEG <= x.length; start += SEG / 2) {
    let xr = 0
    let xi = 0
    let yr = 0
    let yi = 0
    for (let i = 0; i < SEG; i++) {
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / SEG)
      const c = Math.cos(w * i) * win
      const s = -Math.sin(w * i) * win
      xr += x[start + i] * c
      xi += x[start + i] * s
      yr += y[start + i] * c
      yi += y[start + i] * s
    }
    // conj(X) * Y
    sxyRe += xr * yr + xi * yi
    sxyIm += xr * yi - xi * yr
    sxx += xr * xr + xi * xi
  }
  return Math.hypot(sxyRe, sxyIm) / sxx
}

const noteHz = (note: number): number => 440 * 2 ** ((note - 69) / 12)
/** The ladder scale: FREQ/CENTER percent -> Hz. */
const pctHz = (p: number): number => noteHz(15.5 + 1.2 * p)
const hzPct = (hz: number): number => (69 + 12 * Math.log2(hz / 440) - 15.5) / 1.2

interface Cx {
  re: number
  im: number
}
const cx = (re: number, im = 0): Cx => ({ re, im })
const add = (a: Cx, b: Cx): Cx => cx(a.re + b.re, a.im + b.im)
const mul = (a: Cx, b: Cx): Cx => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re)
const div = (a: Cx, b: Cx): Cx => {
  const d = b.re * b.re + b.im * b.im
  return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d)
}
const abs = (a: Cx): number => Math.hypot(a.re, a.im)
/** s = j*tan(pi f/fs)/g: the bilinear prototype's frequency variable. */
const sOf = (f: number, g: number): Cx => cx(0, Math.tan((Math.PI * f) / SR) / g)

/** eq-band's exact magnitude (double) for TYPE/FREQ/GAIN/Q, as the C computes its coefficients. */
function eqExpected(type: number, freq: number, gain: number, qPct: number, f: number): number {
  const w0 = Math.min(pctHz(freq) / SR, 0.45)
  const t = Math.tan(Math.PI * w0)
  const r = 10 ** ((gain * 0.18) / 80)
  const A = r * r
  const q = 0.25 * 2 ** ((qPct * 6) / 100)
  const g = type === 1 ? t / r : type === 2 ? t * r : t
  const k = type === 0 ? 1 / (q * A) : 1 / q
  const m0 = type === 2 ? A * A : 1
  const m1 =
    type === 0 ? k * (A * A - 1) : type === 1 ? k * (A - 1) : type === 2 ? k * (1 - A) * A : -k
  const m2 = type === 1 ? A * A - 1 : type === 2 ? 1 - A * A : 0
  const s = sOf(f, g)
  const den = add(add(mul(s, s), mul(cx(k), s)), cx(1))
  const bp = div(s, den)
  const lp = div(cx(1), den)
  return abs(add(add(cx(m0), mul(cx(m1), bp)), mul(cx(m2), lp)))
}

function tiltExpected(tilt: number, center: number, f: number): number {
  const w0 = Math.min(pctHz(center) / SR, 0.45)
  const G = 10 ** ((tilt * 0.09) / 20)
  const g = Math.tan(Math.PI * w0) * G
  const lp = div(cx(1), add(sOf(f, g), cx(1)))
  return abs(add(cx(G), mul(cx(1 / G - G), lp)))
}

const FREQS = [40, 100, 250, 640, 1500, 4000, 10000, 18000]

console.log('rendering the unfiltered noise')
const dry = render(doc(undefined, {}), N)

function compareResponse(
  label: string,
  wet: Float32Array,
  expected: (f: number) => number,
  freqs = FREQS
): void {
  let worst = 0
  const row: string[] = []
  for (const f of freqs) {
    const got = dB(response(dry, wet, f))
    const want = dB(expected(f))
    // In and near a notch the reading is the window's leakage, not the filter's: a notch's depth
    // is checked with a sine below.
    if (want > -10) worst = Math.max(worst, Math.abs(got - want))
    row.push(`${f >= 1000 ? `${f / 1000}k` : f}:${fmt(got)}`)
  }
  check(worst < 0.1, `${label}: worst ${worst.toFixed(3)} dB off the prototype`)
  console.log(`  ${label.padEnd(34)} ${row.join(' ')}  (worst ${worst.toFixed(3)} dB)`)
}

console.log('\npass-through: GAIN 0 / TILT 0 equal the unfiltered noise bit for bit')
for (const type of [0, 1, 2]) {
  const wet = render(doc('logue/filter/eq-band', { TYPE: type, GAIN: 0, Q: 60, FREQ: 30 }), SR)
  let same = true
  for (let i = 0; i < wet.length; i++) if (wet[i] !== dry[i]) same = false
  check(same, `TYPE ${type} GAIN 0 is not bit-exact`)
  console.log(`  eq-band TYPE ${type}: ${same ? 'bit-exact' : 'differs'}`)
}
{
  const wet = render(doc('logue/filter/tilt', { TILT: 0, CENTER: 70 }), SR)
  let same = true
  for (let i = 0; i < wet.length; i++) if (wet[i] !== dry[i]) same = false
  check(same, 'TILT 0 is not bit-exact')
  console.log(`  tilt: ${same ? 'bit-exact' : 'differs'}`)
}

console.log('\neq-band response vs the prototype (dB at Hz)')
const f1k = hzPct(1000)
const cases: [string, number, number, number, number][] = [
  ['bell +18 @1k Q0.71', 0, f1k, 100, 25],
  ['bell -18 @1k Q0.71', 0, f1k, -100, 25],
  ['bell +9 @250 Q4', 0, hzPct(250), 50, 58.33],
  ['bell +12 @18k Q1', 0, hzPct(18000), 66.67, 33.33],
  ['low shelf +12 @250', 1, hzPct(250), 66.67, 25],
  ['low shelf -18 @640 Q2', 1, hzPct(640), -100, 41.67],
  ['high shelf +12 @4k', 2, hzPct(4000), 66.67, 25],
  ['high shelf -18 @1k Q2', 2, f1k, -100, 41.67],
  ['notch @C5 Q0.71', 3, hzPct(noteHz(72)), 0, 25],
  ['notch @B3 Q8', 3, hzPct(noteHz(59)), 50, 83.33]
]
for (const [label, type, freq, gain, q] of cases) {
  const wet = render(doc('logue/filter/eq-band', { TYPE: type, FREQ: freq, GAIN: gain, Q: q }), N)
  compareResponse(label, wet, (f) => eqExpected(type, freq, gain, q, f))
  const f0 = pctHz(freq)
  const atF0 = dB(response(dry, wet, f0))
  const gainDb = gain * 0.18
  if (type === 0) {
    check(Math.abs(atF0 - gainDb) < 0.05, `${label}: ${atF0} dB at FREQ, want ${gainDb}`)
    console.log(`    at FREQ ${atF0.toFixed(3)} dB (GAIN ${gainDb.toFixed(2)})`)
  } else if (type === 1 || type === 2) {
    const lo = dB(response(dry, wet, 20))
    const hi = dB(response(dry, wet, 20000))
    // Exactly half the gain at FREQ only with Q 0.71 (the bump shifts it otherwise).
    console.log(
      `    20 Hz ${lo.toFixed(2)}, at FREQ ${atF0.toFixed(2)}, 20 kHz ${hi.toFixed(2)} dB (GAIN ${gainDb.toFixed(2)})`
    )
    if (q === 25) check(Math.abs(atF0 - gainDb / 2) < 0.1, `${label}: ${atF0} at FREQ, want half`)
  } else {
    // A sine on FREQ's note, filtered against unfiltered.
    const note = Math.round(15.5 + 1.2 * freq)
    const sine = { source: obj('logue/osc/sine', 's') }
    const rms = (y: Float32Array): number => {
      let e = 0
      for (let i = SR / 2; i < y.length; i++) e += y[i] * y[i]
      return Math.sqrt(e / (y.length - SR / 2))
    }
    const depth = dB(
      rms(
        render(
          doc('logue/filter/eq-band', { TYPE: type, FREQ: freq, GAIN: gain, Q: q }, sine),
          2 * SR,
          note
        )
      ) / rms(render(doc(undefined, {}, sine), 2 * SR, note))
    )
    // note_w0 truncates the fraction to 1/255 st, so FREQ can sit up to 0.4 ct off the note:
    // ~-49 dB for a sine on a Q 8 notch.
    console.log(`    a sine at FREQ (note ${note}) comes out ${depth.toFixed(1)} dB`)
    check(depth < -40, `${label}: notch only ${depth} dB deep`)
  }
}

console.log('\ntilt response vs the prototype')
for (const [tilt, centerHz] of [
  [100, 640],
  [-100, 640],
  [50, 3000],
  [-70, 150]
] as const) {
  const center = hzPct(centerHz)
  const wet = render(doc('logue/filter/tilt', { TILT: tilt, CENTER: center }), N)
  compareResponse(`tilt ${tilt} @${centerHz}`, wet, (f) => tiltExpected(tilt, center, f))
  const pivot = dB(response(dry, wet, centerHz))
  const lo = dB(response(dry, wet, 20))
  const hi = dB(response(dry, wet, 20000))
  check(Math.abs(pivot) < 0.05, `tilt ${tilt}: pivot ${pivot} dB`)
  console.log(
    `    pivot ${pivot.toFixed(3)} dB, 20 Hz ${lo.toFixed(2)}, 20 kHz ${hi.toFixed(2)} (plateaus +-${(Math.abs(tilt) * 0.09).toFixed(2)})`
  )
}

console.log('\nsvf notch / ap outlets')
for (const [res, cutoff] of [
  [0, 50],
  [60, 70]
] as const) {
  const ap = render(
    doc('logue/filter/svf', { RESONANCE: res, CUTOFF: cutoff }, { outlet: 'ap' }),
    N
  )
  let worst = 0
  for (const f of FREQS) worst = Math.max(worst, Math.abs(dB(response(dry, ap, f))))
  check(worst < 0.02, `svf ap RES ${res}: ${worst} dB off flat`)
  const notch = render(
    doc('logue/filter/svf', { RESONANCE: res, CUTOFF: cutoff }, { outlet: 'notch' }),
    N
  )
  // svf's free cutoff: g = (CUTOFF/100)^3 * 8, so the notch sits at atan(g)*fs/pi.
  const g = (cutoff / 100) ** 3 * 8
  const fn = (Math.atan(g) * SR) / Math.PI
  const depth = dB(response(dry, notch, fn))
  check(depth < -40, `svf notch RES ${res}: ${depth} dB at ${fn}`)
  console.log(
    `  RES ${res} CUTOFF ${cutoff}: ap within ${worst.toFixed(4)} dB of flat, notch ${depth.toFixed(1)} dB at ${fn.toFixed(0)} Hz`
  )
}

console.log('\nmoving paths: gate x constant into an inlet matches the dial at the same value')
const gated = (inlet: string, value: number): { nodes: Node[]; nets: Net[] } => ({
  nodes: [
    obj('logue/sense/gate', 'g'),
    obj('logue/util/constant', 'k', { VALUE: value * 100 }),
    obj('logue/math/multiply', 'm')
  ],
  nets: [net('g', 'out', 'm', 'in1'), net('k', 'out', 'm', 'in2'), net('m', 'out', 'f', inlet)]
})
for (const [type, inlet, dial, value, param, depth] of [
  ['logue/filter/eq-band', 'freq', { TYPE: 0, FREQ: 40, GAIN: 60, Q: 50 }, 0.3, 'FREQ', 100],
  ['logue/filter/eq-band', 'gain', { TYPE: 1, FREQ: 40, GAIN: 20, Q: 30 }, -0.5, 'GAIN', 100],
  ['logue/filter/eq-band', 'q', { TYPE: 2, FREQ: 60, GAIN: -50, Q: 30 }, 0.6, 'Q', 50],
  ['logue/filter/eq-band', 'q', { TYPE: 3, FREQ: 60, GAIN: 0, Q: 30 }, 0.6, 'Q', 50],
  ['logue/filter/tilt', 'tilt', { TILT: 20, CENTER: 50 }, 0.5, 'TILT', 100],
  ['logue/filter/tilt', 'center', { TILT: -60, CENTER: 30 }, 0.25, 'CENTER', 100]
] as const) {
  const moving = render(doc(type, dial, gated(inlet, value)), SR)
  const d2 = dial as Params
  const lo = param === 'GAIN' || param === 'TILT' ? -100 : 0
  const still = render(
    doc(type, { ...d2, [param]: Math.max(lo, Math.min(100, d2[param] + value * depth)) }),
    SR
  )
  let diff = 0
  for (let i = 0; i < still.length; i++) diff = Math.max(diff, Math.abs(moving[i] - still[i]))
  check(diff < 1e-5, `${type} ${inlet}: max diff ${diff}`)
  console.log(`  ${type.split('/')[2]} ${inlet}: max |moving - dial| = ${diff.toExponential(2)}`)
}

/** Energy of the 8th difference (a steep highpass, 1 at Nyquist) relative to the signal: zipper
 *  noise from stepped coefficients lands there, a smooth sweep of a sine doesn't. */
function zipperDb(y: Float32Array): number {
  const c = [1, -8, 28, -56, 70, -56, 28, -8, 1]
  let e = 0
  let p = 0
  for (let i = SR / 2; i < y.length; i++) {
    let d = 0
    for (let j = 0; j < 9; j++) d += c[j] * y[i - j]
    e += (d / 256) ** 2
    p += y[i] * y[i]
  }
  return 10 * Math.log10(e / p)
}

console.log(
  '\nsweep: a sine through a Q 8 bell on its note, GAIN or FREQ swept by a sine LFO: zipper'
)
for (const [inlet, rate] of [
  ['gain', 40],
  ['gain', 80],
  ['freq', 40]
] as const) {
  const note = 84
  const nodes = [
    obj('logue/osc/sine', 's'),
    obj('logue/gain/vca', 'v', { GAIN: 2.5 }),
    obj('logue/io/audio-out', 'out'),
    obj('logue/lfo/sine-lfo', 'l', { RATE: rate }),
    obj('logue/math/scale', 'sc', { FACTOR: inlet === 'freq' ? 10 : 100 })
  ]
  const base = [net('s', 'out', 'v', 'in'), net('l', 'out', 'sc', 'in')]
  const eq = obj('logue/filter/eq-band', 'f', {
    TYPE: 0,
    FREQ: hzPct(noteHz(note)),
    GAIN: 0,
    Q: 75
  })
  const wet = render(
    {
      nodes: [...nodes, eq],
      nets: [
        ...base,
        net('v', 'out', 'f', 'in'),
        net('f', 'out', 'out', 'in'),
        net('sc', 'out', 'f', inlet)
      ],
      settings: {},
      notes: ''
    },
    2 * SR,
    note
  )
  const z = zipperDb(wet)
  check(z < -90, `${inlet} sweep at RATE ${rate}: zipper ${z.toFixed(1)} dB`)
  console.log(`  ${inlet} at RATE ${rate}: high-band energy ${z.toFixed(1)} dB re signal`)
}

console.log('\nfuzz: noise, LFOs into every inlet, every TYPE and extremes: finite')
for (const [type, params, inlets] of [
  ['logue/filter/eq-band', { TYPE: 0, FREQ: 100, GAIN: 100, Q: 100 }, ['freq', 'gain', 'q']],
  ['logue/filter/eq-band', { TYPE: 1, FREQ: 0, GAIN: -100, Q: 100 }, ['freq', 'gain', 'q']],
  ['logue/filter/eq-band', { TYPE: 2, FREQ: 100, GAIN: 100, Q: 0 }, ['freq', 'gain', 'q']],
  ['logue/filter/eq-band', { TYPE: 3, FREQ: 50, GAIN: 0, Q: 100 }, ['freq', 'gain', 'q']],
  ['logue/filter/tilt', { TILT: 100, CENTER: 100 }, ['tilt', 'center']],
  ['logue/filter/tilt', { TILT: -100, CENTER: 0 }, ['tilt', 'center']]
] as const) {
  const lfos = inlets.map((_, i) => obj('logue/lfo/sine-lfo', `l${i}`, { RATE: 30 + 25 * i }))
  const y = render(
    doc(type, params, {
      source: obj('logue/osc/noise', 'n', { LEVEL: 70 }),
      nodes: lfos,
      nets: inlets.map((inlet, i) => net(`l${i}`, 'out', 'f', inlet))
    }),
    2 * SR,
    90
  )
  let bad = 0
  let peak = 0
  for (const v of y) {
    if (!Number.isFinite(v)) bad++
    peak = Math.max(peak, Math.abs(v))
  }
  check(bad === 0, `${type} ${JSON.stringify(params)}: ${bad} non-finite`)
  console.log(
    `  ${type.split('/')[2]} ${JSON.stringify(params)}: peak ${peak.toFixed(3)}, non-finite ${bad}`
  )
}

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed')
process.exitCode = failures ? 1 : 0

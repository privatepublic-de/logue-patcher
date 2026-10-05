/**
 * One-off verification for `logue/shape/drive` (2026-10-05): renders it into the xd output under
 * ASan/UBSan (`harness/minilogue-xd/`).
 * - Curve: a constant into DRIVE 0..100 settles at clip(c * h^2) / h (h = 10^(DRIVE dB / 40),
 *   the cubic soft clip), checked against that formula in double; TONE 50 must be flat.
 * - Tone: a quiet sine (no clipping) at three notes, its gain against the input's at every TONE,
 *   next to the one-pole tilt's exact response.
 * - Moving paths: `drive` / `tone` fed from `sense/gate` x a constant (per sample, so codegen
 *   takes drive_step_h / drive_step_t, but the value is fixed once the note is on) must match the
 *   dial set to the same value.
 * - Fuzz: noise at full DRIVE with sine LFOs into both inlets, all LEVELs: finite and bounded.
 *
 * Usage: npx tsx logue-codegen/scripts/runDriveHarness.ts
 */
import { execFileSync } from 'child_process'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const SR = 48000
const harnessDir = join(dirname(new URL(import.meta.url).pathname), '..', 'harness', 'minilogue-xd')
/** The xd shell's output headroom (`clip1m1f(x) * 0.999f`). */
const OUT = 0.999
const TONE_A = 1 - Math.exp((-2 * Math.PI * 800) / SR)

type Params = Record<string, number>
type Node = PatchDocument['nodes'][number]
const obj = (type: string, name: string, params: Params = {}): Node => ({
  kind: 'obj',
  type,
  name,
  x: 0,
  y: 0,
  params: Object.entries(params).map(([n, v]) => ({ name: n, value: String(v) }))
})
const net = (
  from: string,
  outlet: string,
  to: string,
  inlet: string
): PatchDocument['nets'][number] => ({
  sources: [{ obj: from, outlet }],
  dests: [{ obj: to, inlet }]
})

/** `source` (a node with an `out`) -> drive -> out, plus extra nodes/nets. */
function driveDoc(
  drive: Params,
  source: Node[],
  extra: { nodes?: Node[]; nets?: PatchDocument['nets'] } = {},
  bypass = false
): PatchDocument {
  const src = source[source.length - 1].name!
  const nodes = [...source, obj('logue/io/audio-out', 'out'), ...(extra.nodes ?? [])]
  const nets = [...(extra.nets ?? [])]
  if (bypass) nets.push(net(src, 'out', 'out', 'in'))
  else {
    nodes.push(obj('logue/shape/drive', 'dr', drive))
    nets.push(net(src, 'out', 'dr', 'in'), net('dr', 'out', 'out', 'in'))
  }
  return { nodes, nets, settings: {}, notes: '' }
}

function render(doc: PatchDocument, samples: number, note = 60): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), 'lp-drive-harness-'))
  copyFileSync(join(harnessDir, 'userosc.h'), join(dir, 'userosc.h'))
  writeFileSync(join(dir, 'osc_real.cpp'), generateOldGenOscUnit(doc, { name: 'harness' }).oscCpp)
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

const clip = (x: number): number => {
  const c = Math.max(-1.5, Math.min(1.5, x))
  return c - (4 / 27) * c * c * c
}
const hOf = (drive: number): number => 10 ** ((drive * 0.36) / 40)
const db = (g: number): string => `${(20 * Math.log10(g)).toFixed(3)} dB`
let failures = 0
const check = (ok: boolean, what: string): void => {
  if (!ok) {
    failures++
    console.log(`  FAIL: ${what}`)
  }
}

console.log('curve: a constant c settles at clip(c*h^2)/h (TONE 50)')
let worstCurve = 0
let worstGainDb = 0
for (const c of [0.05, 0.18, 0.5, -0.9]) {
  for (const drive of [0, 25, 50, 75, 100]) {
    const y = render(
      driveDoc({ DRIVE: drive }, [obj('logue/util/constant', 'c', { VALUE: c * 100 })]),
      4096
    )
    const got = y[y.length - 1] / OUT
    const h = hOf(drive)
    const want = clip(c * h * h) / h
    worstCurve = Math.max(worstCurve, Math.abs(got - want))
    if (Math.abs(c * h * h) < 0.05)
      worstGainDb = Math.max(worstGainDb, Math.abs(20 * Math.log10(got / want)))
    check(
      Math.abs(got - want) < 2e-5 * Math.max(1, Math.abs(want) * 10),
      `c ${c} DRIVE ${drive}: ${got} vs ${want}`
    )
  }
}
console.log(
  `  worst |error| ${worstCurve.toExponential(2)} (exp_approx included), small-signal gain error ${worstGainDb.toFixed(4)} dB`
)

console.log('\ntone: a quiet sine (0.05 peak, DRIVE 0) through every TONE, gain vs the exact tilt')
const sineSrc = (): Node[] => [
  obj('logue/osc/sine', 's'),
  obj('logue/math/scale', 'q', { FACTOR: 5 })
]
const sineNets = [net('s', 'out', 'q', 'in')]
const N = 48000
const amp = (y: Float32Array, f: number): number => {
  let re = 0
  let im = 0
  const from = 8192
  for (let i = from; i < y.length; i++) {
    re += y[i] * Math.cos((2 * Math.PI * f * i) / SR)
    im += y[i] * Math.sin((2 * Math.PI * f * i) / SR)
  }
  return Math.hypot(re, im)
}
let worstTone = 0
for (const note of [36, 79, 108]) {
  const f = 440 * 2 ** ((note - 69) / 12)
  const ref = amp(render(driveDoc({}, sineSrc(), { nets: sineNets }, true), N, note), f)
  const w = (2 * Math.PI * f) / SR
  // H_lp = a / (1 - (1 - a) e^-jw)
  const dr = 1 - (1 - TONE_A) * Math.cos(w)
  const di = (1 - TONE_A) * Math.sin(w)
  const lpRe = (TONE_A * dr) / (dr * dr + di * di)
  const lpIm = (-TONE_A * di) / (dr * dr + di * di)
  const row: string[] = []
  for (const tone of [0, 25, 50, 75, 100]) {
    const y = render(driveDoc({ DRIVE: 0, TONE: tone }, sineSrc(), { nets: sineNets }), N, note)
    const hi = tone < 50 ? tone * 0.02 : 1
    const lo = tone > 50 ? (100 - tone) * 0.02 : 1
    const d = lo - hi
    // The clip's own small-signal gain at 0.05 peak (x - 4x^3/27): 3/4 * 4/27 * A^2 off.
    const k = 1 - 0.75 * (4 / 27) * 0.05 * 0.05
    const want = k * Math.hypot(hi + d * lpRe, d * lpIm)
    const got = amp(y, f) / ref
    const err = Math.abs(20 * Math.log10(got / want))
    worstTone = Math.max(worstTone, err)
    check(err < 0.05, `note ${note} TONE ${tone}: ${db(got)} vs ${db(want)}`)
    row.push(`${tone}: ${db(got)}`)
  }
  console.log(`  ${f.toFixed(0).padStart(5)} Hz  ${row.join('  ')}`)
}
console.log(`  worst error ${worstTone.toFixed(4)} dB`)

console.log('\nmoving paths: gate x constant into drive / tone matches the dial at the same value')
const noise = (): Node[] => [obj('logue/osc/noise', 'n')]
for (const [inlet, dial, wiredValue] of [
  ['drive', { DRIVE: 30, TONE: 30 }, 0.4],
  ['tone', { DRIVE: 60, TONE: 20 }, 0.9],
  ['tone', { DRIVE: 60, TONE: 80 }, -0.5]
] as const) {
  const param = inlet === 'drive' ? 'DRIVE' : 'TONE'
  const moving = render(
    driveDoc(dial, noise(), {
      nodes: [
        obj('logue/sense/gate', 'g'),
        obj('logue/util/constant', 'k', { VALUE: wiredValue * 100 }),
        obj('logue/math/multiply', 'm')
      ],
      nets: [net('g', 'out', 'm', 'in1'), net('k', 'out', 'm', 'in2'), net('m', 'out', 'dr', inlet)]
    }),
    SR
  )
  const still = render(
    driveDoc(
      { ...dial, [param]: Math.max(0, Math.min(100, dial[param] + wiredValue * 50)) },
      noise()
    ),
    SR
  )
  let diff = 0
  for (let i = 0; i < still.length; i++) diff = Math.max(diff, Math.abs(moving[i] - still[i]))
  check(diff < 1e-5, `${inlet}: max diff ${diff}`)
  console.log(
    `  ${inlet} ${param} ${dial[param]} + ${wiredValue}: max |moving - dial| = ${diff.toExponential(2)}`
  )
}

console.log('\nfuzz: noise at DRIVE 100, sine LFOs into drive and tone, every LEVEL')
for (const level of [100, 50, 1, 0]) {
  const y = render(
    driveDoc({ DRIVE: 100, TONE: 50, LEVEL: level }, noise(), {
      nodes: [
        obj('logue/lfo/sine-lfo', 'l1', { RATE: 70 }),
        obj('logue/lfo/sine-lfo', 'l2', { RATE: 40 })
      ],
      nets: [net('l1', 'out', 'dr', 'drive'), net('l2', 'out', 'dr', 'tone')]
    }),
    2 * SR
  )
  let peak = 0
  let bad = 0
  for (const v of y) {
    if (!Number.isFinite(v)) bad++
    peak = Math.max(peak, Math.abs(v))
  }
  check(bad === 0, `LEVEL ${level}: ${bad} non-finite samples`)
  check(level !== 0 || peak === 0, `LEVEL 0 not silent: ${peak}`)
  console.log(`  LEVEL ${level}: peak ${peak.toFixed(4)}, non-finite ${bad}`)
}

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed')
process.exitCode = failures ? 1 : 0

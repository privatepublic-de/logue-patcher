/**
 * One-off verification for `logue/osc/wavetable` (docs/PLAN-wavetable.md, phase 2): renders
 * generated minilogue xd units under ASan/UBSan (`harness/minilogue-xd/`, exact equal-tempered
 * note table) and checks
 *  - the generated unit matches the TypeScript reference read (`sample/wavetableRead.ts`)
 *    sample by sample, at several notes, positions and both MORPH settings;
 *  - the criterion this primitive exists for: with a triangle LFO scanning POSITION over every
 *    frame, the pitch stays at the note (autocorrelation peak per 40 ms window, not zero
 *    crossings) -- on the fixture table and, with WAVETABLE_WAV=<file>, a real import;
 *  - off-harmonic energy (aliases) with the brightest frame, every note 48..120;
 *  - a crossfade's midpoint level against its two frames (real import only: the fixture's
 *    frames are a smooth blend by construction);
 *  - fuzz: extreme notes and COARSE, `pitch`/`harmonic`/`position` from noise, 2- and 64-frame
 *    tables, 128- and 512-point frames: no non-finite samples, no sanitizer report.
 * With WAVETABLE_DEMO=<dir> as well, writes the same scan as the wavetable and as granular SYNC.
 *
 * Usage: npx tsx logue-codegen/scripts/runWavetableHarness.ts   [WAVETABLE_WAV=file.wav]
 */
import { execFileSync } from 'child_process'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import { importWavSample } from '../src/sample/importSample'
import { importWavetable } from '../src/sample/importWavetable'
import { wavetablePyramid, wavetableShapeOf } from '../src/sample/wavetablePyramid'
import { renderWavetable } from '../src/sample/wavetableRead'
import type { PatchDocument, SampleAsset } from '../../src/shared/domain/patch'
import { wavetableFixture } from './wavetableFixture'

const SR = 48000
const harnessDir = join(dirname(new URL(import.meta.url).pathname), '..', 'harness', 'minilogue-xd')
let failures = 0

function check(ok: boolean, label: string, detail: string): void {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(52)} ${detail}`)
}

const hzOf = (note: number): number => 440 * 2 ** ((note - 69) / 12)

interface Wiring {
  /** An LFO into `position` at this RATE (percent): a triangle, or a ramp (one direction). */
  scan?: number
  scanShape?: 'triangle-lfo' | 'ramp-up'
  /** Noise into every inlet. */
  noise?: boolean
}

/** `exposed` names the param put on menu Param 1, so `render`'s `param0` can set it. */
function wtDoc(
  sample: SampleAsset,
  params: Record<string, number>,
  wiring: Wiring = {},
  exposed?: string,
  type = 'logue/osc/wavetable'
): PatchDocument {
  const nodes: PatchDocument['nodes'] = [
    {
      kind: 'obj',
      type,
      name: 'w',
      x: 0,
      y: 0,
      params: Object.entries(params).map(([name, v]) => ({
        name,
        value: String(v),
        ...(name === exposed ? { logueParamIndex: { 'minilogue-xd': 0 } } : {})
      })),
      sample
    },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ]
  const nets: PatchDocument['nets'] = [
    { sources: [{ obj: 'w', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ]
  if (wiring.scan !== undefined) {
    nodes.push({
      kind: 'obj',
      type: `logue/lfo/${wiring.scanShape ?? 'triangle-lfo'}`,
      name: 'lfo',
      x: 0,
      y: 0,
      params: [{ name: 'RATE', value: String(wiring.scan) }]
    })
    nets.push({
      sources: [{ obj: 'lfo', outlet: 'out' }],
      dests: [{ obj: 'w', inlet: 'position' }]
    })
  }
  if (wiring.noise) {
    nodes.push({ kind: 'obj', type: 'logue/osc/noise', name: 'nz', x: 0, y: 0, params: [] })
    nets.push({
      sources: [{ obj: 'nz', outlet: 'out' }],
      dests: ['pitch', 'harmonic', 'position'].map((inlet) => ({ obj: 'w', inlet }))
    })
  }
  return { nodes, nets, settings: {}, notes: '' }
}

const builds = new Map<string, string>()

/**
 * Renders `samples` at `note`; `param0` sets the unit's menu Param 1 (whatever the doc exposes at
 * xd slot 0) through OSC_PARAM before the note. Each distinct doc is compiled once.
 */
function render(doc: PatchDocument, note: number, samples: number, param0?: number): Float32Array {
  const source = generateOldGenOscUnit(doc, { name: 'harness' }).oscCpp
  let dir = builds.get(source)
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(), 'lp-wavetable-harness-'))
    copyFileSync(join(harnessDir, 'userosc.h'), join(dir, 'userosc.h'))
    writeFileSync(join(dir, 'osc_real.cpp'), source)
    writeFileSync(
      join(dir, 'main.cpp'),
      `#include <cstdio>
#include <cstdlib>
#include <cstring>
#include "osc_real.cpp"
int main(int argc, char **argv) {
  int note = atoi(argv[1]);
  unsigned samples = (unsigned)atoi(argv[2]);
  user_osc_param_t p;
  memset(&p, 0, sizeof(p));
  p.pitch = (uint16_t)(note << 8);
  OSC_INIT(0, 0);
  if (argc > 3) OSC_PARAM(k_user_osc_param_id1, (uint16_t)atoi(argv[3]));
  OSC_NOTEON(&p);
  static int32_t buf[64];
  FILE *raw = fopen("out.raw", "wb");
  for (unsigned done = 0; done < samples; done += 64) {
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
    builds.set(source, dir)
  }
  const args = [String(note), String(samples), ...(param0 === undefined ? [] : [String(param0)])]
  execFileSync(join(dir, 'harness'), args, { cwd: dir, stdio: 'inherit' })
  const b = readFileSync(join(dir, 'out.raw'))
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}

/**
 * Frequency error of the FUNDAMENTAL, in cents: its phase at the note's frequency in each window
 * (half-window hop) and how far it turns between windows. `mean` is the sustained offset over the
 * whole render (what scanning granular SYNC shows: a Doppler shift); `worst` the largest
 * window-to-window wobble, which fast timbre changes cause on their own -- a frame's harmonics
 * changing level hundreds of times a second spread energy next to the fundamental. (Autocorrelation
 * read a few cents off at note 36 even on the fixture, whose fundamental is identical in every
 * frame; at least 8 periods under Blackman-Harris keep the 2nd harmonic out.)
 */
function fundamentalDrift(y: Float32Array, note: number): { mean: number; worst: number } {
  const hz = hzOf(note)
  const win = Math.round(Math.max(0.04 * SR, (8 * SR) / hz))
  const hop = Math.round(win / 2)
  const phases: number[] = []
  for (let s = SR / 20; s + win < y.length; s += hop) {
    let re = 0
    let im = 0
    for (let i = 0; i < win; i++) {
      const t = (2 * Math.PI * i) / win
      const w =
        0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t)
      const a = (2 * Math.PI * hz * (s + i)) / SR
      re += w * y[s + i] * Math.cos(a)
      im -= w * y[s + i] * Math.sin(a)
    }
    phases.push(Math.atan2(im, re))
  }
  const cents = (d: number): number => 1200 * Math.log2((hz + (d * SR) / (2 * Math.PI * hop)) / hz)
  let worst = 0
  let total = 0
  for (let k = 1; k < phases.length; k++) {
    let d = phases[k] - phases[k - 1]
    d -= 2 * Math.PI * Math.round(d / (2 * Math.PI))
    total += d
    worst = Math.max(worst, Math.abs(cents(d)))
  }
  return { mean: cents(total / (phases.length - 1)), worst }
}

const N_FFT = 16384
/** Energy off the note's harmonics as a share of the total, dB (Blackman-Harris, +-6 bins: a
 *  Hann window's own leakage floor was ~-58 dB, this one's ~-90). */
function offHarmonicDb(y: Float32Array, note: number): number {
  const re = new Float64Array(N_FFT)
  const im = new Float64Array(N_FFT)
  const start = y.length - N_FFT
  for (let i = 0; i < N_FFT; i++) {
    const t = (2 * Math.PI * i) / N_FFT
    re[i] =
      y[start + i] *
      (0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t))
  }
  for (let i = 1, j = 0; i < N_FFT; i++) {
    let bit = N_FFT >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= N_FFT; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    for (let i = 0; i < N_FFT; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k)
        const wi = Math.sin(ang * k)
        const a = i + k
        const b = a + len / 2
        const tr = re[b] * wr - im[b] * wi
        const ti = re[b] * wi + im[b] * wr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
      }
    }
  }
  const binHz = SR / N_FFT
  const on = new Uint8Array(N_FFT / 2)
  for (let h = 1; h * hzOf(note) < SR / 2; h++) {
    const c = Math.round((h * hzOf(note)) / binHz)
    for (let b = c - 6; b <= c + 6; b++) if (b >= 0 && b < on.length) on[b] = 1
  }
  let total = 0
  let off = 0
  for (let b = 3; b < N_FFT / 2; b++) {
    const p = re[b] * re[b] + im[b] * im[b]
    total += p
    if (!on[b]) off += p
  }
  return 10 * Math.log10(Math.max(off / total, 1e-15))
}

/** 16-bit mono WAV at 48 kHz, at half level (the renders peak near full scale). */
function wavFile(y: Float32Array): Buffer {
  const b = Buffer.alloc(44 + y.length * 2)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + y.length * 2, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(SR, 24)
  b.writeUInt32LE(SR * 2, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(y.length * 2, 40)
  y.forEach((v, i) =>
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v * 0.5)) * 32767), 44 + 2 * i)
  )
  return b
}

function rms(y: Float32Array, from = 4096): number {
  let s = 0
  for (let i = from; i < y.length; i++) s += y[i] * y[i]
  return Math.sqrt(s / (y.length - from))
}

function nonFinite(y: Float32Array): number {
  return y.reduce((n, v) => (Number.isFinite(v) ? n : n + 1), 0)
}

const fixture = wavetableFixture()
const tables: { name: string; asset: SampleAsset }[] = [{ name: 'fixture 32x256', asset: fixture }]
if (process.env.WAVETABLE_WAV) {
  const path = process.env.WAVETABLE_WAV
  const imported = importWavetable(new Uint8Array(readFileSync(path)), 'wav', 32, 256)
  tables.push({ name: 'import 32x256', asset: imported.asset })
}

// 1. The generated unit against the TypeScript reference.
{
  const shape = wavetableShapeOf(fixture)
  const pyramid = new Int8Array(wavetablePyramid(fixture).buffer)
  let worst = 0
  for (const note of [24, 60, 96, 120]) {
    for (const pos of [0, 37, 100]) {
      for (const morph of [0, 1]) {
        const y = render(
          wtDoc(fixture, { POSITION: 0, MORPH: morph }, {}, 'POSITION'),
          note,
          1024,
          pos
        )
        // The harness's osc_w0f_for_note, in single precision (the phases still drift apart by
        // an ulp now and then, hence only the first 1024 samples).
        const w0 = Math.fround(
          Math.fround(440 * Math.fround(2 ** Math.fround((note - 69) / 12))) / SR
        )
        const ref = renderWavetable(pyramid, shape, w0, pos / 100, morph === 1, 1024)
        for (let i = 0; i < y.length; i++)
          worst = Math.max(worst, Math.abs(y[i] - Math.fround(ref[i] * 0.999)))
      }
    }
  }
  check(
    worst < 1e-5,
    'unit matches the TypeScript reference',
    `worst |diff| ${worst.toExponential(1)}`
  )
}

// 2. The point of it all: no sustained pitch offset while POSITION scans one way (a ramp LFO
// over every frame), and the window-to-window wobble reported. With a real import, granular SYNC
// on the same file and scan is shown for comparison.
const granularFrom = process.env.WAVETABLE_WAV
  ? importWavSample(new Uint8Array(readFileSync(process.env.WAVETABLE_WAV)), 'wav', 16384).asset
  : undefined
for (const { name, asset } of tables) {
  for (const note of [36, 60, 84]) {
    for (const [rate, hz] of [
      [36, '1 Hz'],
      [63, '5 Hz']
    ] as const) {
      const scan: Wiring = { scan: rate, scanShape: 'ramp-up' }
      const d = fundamentalDrift(render(wtDoc(asset, { POSITION: 50 }, scan), note, SR * 2), note)
      let compare = ''
      if (granularFrom && asset !== fixture) {
        const g = fundamentalDrift(
          render(
            wtDoc(granularFrom, { POSITION: 50 }, scan, undefined, 'logue/osc/granular'),
            note,
            SR * 2
          ),
          note
        )
        compare = `; granular SYNC: mean ${g.mean.toFixed(1)} ct`
      }
      check(
        Math.abs(d.mean) < 0.5,
        `${name}: pitch while scanning, note ${note}, ${hz}`,
        `mean ${d.mean.toFixed(2)} ct, wobble ${d.worst.toFixed(1)} ct${compare}`
      )
    }
  }
}

// 3. Aliasing: the brightest (saw) frame, every note.
{
  let worst = -Infinity
  let worstNote = 0
  const rows: string[] = []
  for (let note = 48; note <= 120; note++) {
    const y = render(wtDoc(fixture, { POSITION: 100 }), note, N_FFT + 8192)
    const db = offHarmonicDb(y, note)
    if (note % 12 === 0) rows.push(`${note}:${db.toFixed(0)}`)
    if (db > worst) {
      worst = db
      worstNote = note
    }
  }
  // The saw is the brightest frame there can be (64 harmonics at 1/k); what's left is linear
  // interpolation's images at 4 points per cycle of each level's top harmonic.
  check(
    worst < -38,
    'off-harmonic energy, saw frame, notes 48..120',
    `worst ${worst.toFixed(1)} dB at ${worstNote} (${rows.join(' ')})`
  )
}

// 3b. The same on a real import's frames (reported, not checked: it depends on the material).
for (const { name, asset } of tables.slice(1)) {
  const rows: string[] = []
  for (const pos of [0, 50, 100]) {
    let worst = -Infinity
    for (let note = 48; note <= 120; note += 6) {
      worst = Math.max(
        worst,
        offHarmonicDb(
          render(wtDoc(asset, { POSITION: 0 }, {}, 'POSITION'), note, N_FFT + 8192, pos),
          note
        )
      )
    }
    rows.push(`POSITION ${pos}: ${worst.toFixed(1)} dB`)
  }
  console.log(`     ${name}: worst off-harmonic energy, notes 48..120: ${rows.join(', ')}`)
}

// 4. A crossfade's midpoint against its two frames (a real import). Read through the TypeScript
// reference, which check 1 holds to the unit: a menu param can't reach fractional positions.
for (const { name, asset } of tables.slice(1)) {
  const shape = wavetableShapeOf(asset)
  const pyramid = new Int8Array(wavetablePyramid(asset).buffer)
  const w0 = Math.fround(hzOf(48) / SR)
  const at = (framePos: number): number =>
    rms(renderWavetable(pyramid, shape, w0, framePos / (shape.frameCount - 1), false, 8192), 0)
  let worst = 0
  for (let i = 0; i + 1 < shape.frameCount; i++) {
    worst = Math.min(worst, 20 * Math.log10(at(i + 0.5) / ((at(i) + at(i + 1)) / 2)))
  }
  check(worst > -1, `${name}: crossfade midpoint level`, `worst ${worst.toFixed(2)} dB`)
}

// 5. Fuzz.
{
  let bad = 0
  let peak = 0
  const shapes: [number, number][] = [
    [2, 128],
    [64, 256],
    [8, 512]
  ]
  for (const [frames, len] of shapes) {
    const asset = wavetableFixture(frames, len)
    for (const note of [0, 60, 127]) {
      for (const coarse of [-24, 24]) {
        for (const morph of [0, 1]) {
          const y = render(
            wtDoc(asset, { COARSE: coarse, MORPH: morph }, { noise: true }),
            note,
            8192
          )
          bad += nonFinite(y)
          for (const v of y) peak = Math.max(peak, Math.abs(v))
        }
      }
    }
  }
  check(
    bad === 0 && peak <= 1,
    'fuzz: noise into every inlet, extreme notes/shapes',
    `non-finite ${bad}, peak ${peak.toFixed(3)}`
  )
}

// 6. With WAVETABLE_DEMO=<dir> (and a WAVETABLE_WAV): 4 s at note 48 with a ramp LFO scanning
// POSITION, as the wavetable and as granular SYNC, for listening.
if (process.env.WAVETABLE_DEMO && granularFrom && tables[1]) {
  const scan: Wiring = { scan: 36, scanShape: 'ramp-up' }
  const renders: [string, Float32Array][] = [
    ['wavetable', render(wtDoc(tables[1].asset, { POSITION: 50 }, scan), 48, SR * 4)],
    [
      'granular-sync',
      render(
        wtDoc(granularFrom, { POSITION: 50 }, scan, undefined, 'logue/osc/granular'),
        48,
        SR * 4
      )
    ]
  ]
  for (const [name, y] of renders) {
    const path = join(process.env.WAVETABLE_DEMO, `scan-note48-${name}.wav`)
    writeFileSync(path, wavFile(y))
    console.log(`     wrote ${path}`)
  }
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)

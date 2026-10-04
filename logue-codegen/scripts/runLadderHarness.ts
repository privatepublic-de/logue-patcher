/**
 * One-off verification for `logue/filter/ladder` (2026-10-04): renders it through the xd output
 * under ASan/UBSan (`harness/minilogue-xd/`) and measures
 *  - the response to quiet noise (output spectrum / input spectrum, Welch): DC gain, the level at
 *    the cutoff, the slope above it, and the passband loss as RESONANCE rises;
 *  - with TRACK, where the resonant peak sits against the played note (cents);
 *  - self-oscillation with no input: from which RESONANCE, its pitch against the note, level;
 *  - FB_DRIVE: self-oscillation level, pitch and odd harmonics, and a saw at high RESONANCE;
 *  - peaks with a full-scale saw at RESONANCE/DRIVE 100, and a fuzz with every inlet moving.
 *
 * Usage: npx tsx logue-codegen/scripts/runLadderHarness.ts
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

/** `source` (or nothing) -> ladder -> out, plus extra nodes wired into ladder inlets. */
function ladderDoc(
  ladder: Params | null,
  source: Node | null,
  extra: Array<{ node: Node; inlet: string }> = []
): PatchDocument {
  const nodes: Node[] = [obj('logue/io/audio-out', 'out')]
  const nets: PatchDocument['nets'] = []
  if (ladder === null) {
    nodes.push(source!)
    nets.push(net(source!.name!, 'out', 'out', 'in'))
  } else {
    nodes.push(obj('logue/filter/ladder', 'lad', ladder))
    nets.push(net('lad', 'out', 'out', 'in'))
    if (source) {
      nodes.push(source)
      nets.push(net(source.name!, 'out', 'lad', 'in'))
    }
  }
  for (const e of extra) {
    nodes.push(e.node)
    nets.push(net(e.node.name!, 'out', 'lad', e.inlet))
  }
  return { nodes, nets, settings: {}, notes: '' }
}

function render(doc: PatchDocument, samples: number, note = 60): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), 'lp-ladder-harness-'))
  copyFileSync(join(harnessDir, 'userosc.h'), join(dir, 'userosc.h'))
  writeFileSync(join(dir, 'osc_real.cpp'), generateOldGenOscUnit(doc, { name: 'harness' }).oscCpp)
  writeFileSync(
    join(dir, 'main.cpp'),
    `#include <cstdio>
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
  for (unsigned done = 0; done < ${samples}u; done += 64) {
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
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4).map((v) => v / 0.999)
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k)
        const wi = Math.sin(ang * k)
        const xr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi
        const xi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr
        re[i + k + len / 2] = re[i + k] - xr
        im[i + k + len / 2] = im[i + k] - xi
        re[i + k] += xr
        im[i + k] += xi
      }
    }
  }
}

function spectrum(y: Float32Array, n: number): Float64Array {
  const power = new Float64Array(n / 2)
  let count = 0
  for (let start = 0; start + n <= y.length; start += n / 2) {
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    for (let i = 0; i < n; i++) re[i] = y[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n))
    fft(re, im)
    for (let k = 0; k < n / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k]
    count++
  }
  return power.map((p) => p / count)
}

const noteHz = (n: number): number => 440 * 2 ** ((n - 69) / 12)
/** The CUTOFF raw value whose free cutoff is `hz` (LADDER_NOTE_LO 15.5, 1.2 st per percent). */
const cutoffFor = (hz: number): number => (69 + 12 * Math.log2(hz / 440) - 15.5) / 1.2
const db = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(2)} dB`

/** Noise at LEVEL 30 (about -34 dB): quiet enough that the saturator stays linear. */
const quietNoise = (): Node => obj('logue/osc/noise', 'nz', { LEVEL: 30 })
const N_FFT = 65536
const NOISE_SAMPLES = 20 * SR
let noiseRef: Float64Array | undefined
function response(ladder: Params, note = 60): (hz: number) => number {
  noiseRef ??= spectrum(render(ladderDoc(null, quietNoise()), NOISE_SAMPLES), N_FFT)
  const out = spectrum(render(ladderDoc(ladder, quietNoise()), NOISE_SAMPLES, note), N_FFT)
  const h = out.map((p, k) => p / noiseRef![k])
  return (hz: number) => {
    // A third of an octave around hz, so the noise's own variance averages out.
    const k0 = Math.round((hz * 2 ** (-1 / 12) * N_FFT) / SR)
    const k1 = Math.max(k0 + 1, Math.round((hz * 2 ** (1 / 12) * N_FFT) / SR))
    let s = 0
    for (let k = k0; k < k1; k++) s += h[k]
    return 10 * Math.log10(s / (k1 - k0))
  }
}
function peakHz(ladder: Params, note: number): number {
  noiseRef ??= spectrum(render(ladderDoc(null, quietNoise()), NOISE_SAMPLES), N_FFT)
  const out = spectrum(render(ladderDoc(ladder, quietNoise()), NOISE_SAMPLES, note), N_FFT)
  let best = 1
  for (let k = 2; k < N_FFT / 2 - 1; k++)
    if (out[k] / noiseRef[k] > out[best] / noiseRef[best]) best = k
  const [a, b, c] = [best - 1, best, best + 1].map((k) => Math.log(out[k] / noiseRef![k]))
  return ((best + (0.5 * (a - c)) / (a - 2 * b + c)) * SR) / N_FFT
}

/** The strongest frequency within +-60 cents of `expectHz` (Hann-windowed DFT, 0.1-cent steps). */
function pitchHz(y: Float32Array, expectHz: number): number {
  const seg = y.subarray(y.length - 48000)
  const n = seg.length
  let best = expectHz
  let bestMag = -1
  for (let c = -60; c <= 60; c += 0.1) {
    const f = expectHz * 2 ** (c / 1200)
    const w = (2 * Math.PI * f) / SR
    let re = 0
    let im = 0
    for (let i = 0; i < n; i++) {
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
      re += seg[i] * win * Math.cos(w * i)
      im -= seg[i] * win * Math.sin(w * i)
    }
    if (re * re + im * im > bestMag) {
      bestMag = re * re + im * im
      best = f
    }
  }
  return best
}

function stats(y: Float32Array, from = 0): { rms: number; peak: number; nonFinite: number } {
  let sq = 0
  let peak = 0
  let nonFinite = 0
  for (let i = from; i < y.length; i++) {
    const v = y[i]
    if (!Number.isFinite(v)) nonFinite++
    else {
      sq += v * v
      peak = Math.max(peak, Math.abs(v))
    }
  }
  return { rms: Math.sqrt(sq / (y.length - from)), peak, nonFinite }
}
const cents = (hz: number, ref: number): string => `${(1200 * Math.log2(hz / ref)).toFixed(2)} ct`

console.log(
  'response to quiet noise, free CUTOFF at 1 kHz (expected: 0 dB low, -12 dB at fc, -24 dB/oct)'
)
for (const reso of [0, 50, 80]) {
  const h = response({ CUTOFF: cutoffFor(1000), RESONANCE: reso })
  const at = [50, 250, 1000, 2000, 4000, 8000, 16000].map((f) => `${f}: ${db(h(f))}`).join('  ')
  console.log(`RESONANCE ${reso}: ${at}  slope 4k->8k ${db(h(8000) - h(4000))}/oct`)
}

console.log('\nresonant peak with TRACK, RESONANCE 75 (peak vs note)')
for (const note of [36, 48, 60, 72, 84, 96]) {
  const hz = peakHz({ RESONANCE: 75, TRACK: 100 }, note)
  console.log(
    `note ${note} (${noteHz(note).toFixed(2)} Hz): peak ${hz.toFixed(2)} Hz, ${cents(hz, noteHz(note))}`
  )
}

console.log('\nself-oscillation, no input, TRACK on, note 60: level after 2 s by RESONANCE')
for (const reso of [80, 82, 83, 84, 86, 90, 100]) {
  const y = render(ladderDoc({ RESONANCE: reso, TRACK: 100 }, null), 3 * SR)
  const s = stats(y, 2 * SR)
  console.log(`RESONANCE ${reso}: rms ${s.rms.toExponential(3)} peak ${s.peak.toFixed(4)}`)
}

console.log('\nself-oscillation pitch, RESONANCE 100, TRACK on, no input')
for (const note of [24, 36, 48, 60, 72, 84, 96, 108]) {
  const y = render(ladderDoc({ RESONANCE: 100, TRACK: 100 }, null), 4 * SR, note)
  let onset = 0
  while (onset < y.length && Math.abs(y[onset]) < 0.05) onset++
  const s = stats(y, 2 * SR)
  const hz = pitchHz(y, noteHz(note))
  console.log(
    `note ${note}: ${hz.toFixed(2)} Hz (${cents(hz, noteHz(note))}), rms ${s.rms.toFixed(4)} peak ${s.peak.toFixed(4)}, |y| > 0.05 after ${((onset / SR) * 1000).toFixed(1)} ms`
  )
}

/** Power of the k-th harmonic of `hz` relative to the fundamental, in dB (Goertzel over the tail). */
function harmonicDb(y: Float32Array, hz: number, k: number): number {
  const seg = y.subarray(y.length - 48000)
  const mag = (f: number): number => {
    const w = (2 * Math.PI * f) / SR
    let re = 0
    let im = 0
    for (let i = 0; i < seg.length; i++) {
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / seg.length)
      re += seg[i] * win * Math.cos(w * i)
      im -= seg[i] * win * Math.sin(w * i)
    }
    return re * re + im * im
  }
  return 10 * Math.log10(mag(hz * k) / mag(hz))
}

console.log('\nFB_DRIVE: self-oscillation (RESONANCE 100, TRACK, note 60, no input)')
for (const fb of [0, 25, 50, 75, 100]) {
  const y = render(ladderDoc({ RESONANCE: 100, TRACK: 100, FB_DRIVE: fb }, null), 3 * SR)
  const s = stats(y, 2 * SR)
  const hz = pitchHz(y, noteHz(60))
  console.log(
    `FB_DRIVE ${fb}: ${hz.toFixed(2)} Hz (${cents(hz, noteHz(60))}), rms ${s.rms.toFixed(4)} peak ${s.peak.toFixed(4)}, 3rd ${db(harmonicDb(y, hz, 3))} 5th ${db(harmonicDb(y, hz, 5))}`
  )
}

/** Harmonic h of `hz` in the last second, in dB relative to the whole tail's rms. */
function harmonicRe(y: Float32Array, hz: number, h: number, tot: number): number {
  const seg = y.subarray(y.length - SR)
  const w = (2 * Math.PI * hz * h) / SR
  let re = 0
  let im = 0
  for (let i = 0; i < seg.length; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / seg.length)
    re += seg[i] * win * Math.cos(w * i)
    im -= seg[i] * win * Math.sin(w * i)
  }
  return 20 * Math.log10((4 * Math.sqrt(re * re + im * im)) / seg.length / tot)
}

for (const reso of [90, 0]) {
  console.log(
    `\nFB_DRIVE: full-scale saw (note 48, 130.81 Hz), CUTOFF 50 (~740 Hz), RESONANCE ${reso}: harmonics in dB re the rms`
  )
  for (const fb of [0, 25, 50, 75, 100]) {
    const y = render(
      ladderDoc({ CUTOFF: 50, RESONANCE: reso, FB_DRIVE: fb }, obj('logue/osc/saw', 'saw')),
      2 * SR,
      48
    )
    const s = stats(y, SR)
    const hs = [1, 3, 5, 6, 8, 12, 20].map(
      (h) => `h${h} ${harmonicRe(y, noteHz(48), h, s.rms).toFixed(1)}`
    )
    console.log(
      `FB_DRIVE ${fb}: rms ${s.rms.toFixed(3)} peak ${s.peak.toFixed(3)}  ${hs.join('  ')}`
    )
  }
}

console.log('\nfull-scale saw (note 48) through the ladder: level and peak')
for (const [cutoff, reso, drive] of [
  [100, 0, 0],
  [50, 0, 0],
  [50, 50, 0],
  [50, 90, 0],
  [50, 100, 0],
  [50, 100, 100],
  [50, 0, 100],
  [80, 100, 100],
  [20, 100, 100]
]) {
  const y = render(
    ladderDoc({ CUTOFF: cutoff, RESONANCE: reso, DRIVE: drive }, obj('logue/osc/saw', 'saw')),
    2 * SR,
    48
  )
  const s = stats(y, SR / 2)
  console.log(
    `CUTOFF ${cutoff} RESONANCE ${reso} DRIVE ${drive}: rms ${s.rms.toFixed(4)} peak ${s.peak.toFixed(4)} nonfinite ${s.nonFinite}`
  )
}

console.log('\nfuzz: every inlet moving, TRACK off/on, extreme notes')
for (const track of [0, 100]) {
  for (const note of [0, 30, 60, 100, 127]) {
    const y = render(
      ladderDoc(
        { CUTOFF: 50, RESONANCE: 90, DRIVE: 50, TRACK: track },
        obj('logue/osc/saw', 'saw'),
        [
          { node: obj('logue/lfo/sine-lfo', 'l1', { RATE: 90 }), inlet: 'cutoff' },
          { node: obj('logue/osc/noise', 'l2'), inlet: 'resonance' },
          { node: obj('logue/lfo/triangle-lfo', 'l3', { RATE: 70 }), inlet: 'drive' },
          { node: obj('logue/lfo/ramp-up', 'l4', { RATE: 80 }), inlet: 'pitch' },
          { node: obj('logue/lfo/square-lfo', 'l5', { RATE: 75 }), inlet: 'fbDrive' }
        ]
      ),
      2 * SR,
      note
    )
    const s = stats(y)
    console.log(
      `TRACK ${track} note ${note}: rms ${s.rms.toFixed(4)} peak ${s.peak.toFixed(4)} nonfinite ${s.nonFinite}`
    )
  }
}

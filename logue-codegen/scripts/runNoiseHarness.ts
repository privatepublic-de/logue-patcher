/**
 * One-off verification for `logue/osc/noise`'s COLOR and `logue/osc/lfsr` (2026-10-03): renders
 * each through the xd output under ASan/UBSan (`harness/minilogue-xd/`) and measures
 *  - noise: RMS, peak, the share of samples at the clip, and the spectral slope (Welch average,
 *    octave bands) against the colour's nominal 0 / -3 / -6 / +6 dB per octave;
 *  - lfsr Short: the pitch (autocorrelation peak, parabolic) against the note, tracked and free;
 *  - lfsr Long: with a clock past the sample rate (one step a sample) the output repeats after
 *    exactly 32767 samples and after none of its divisors (7, 31, 151).
 *
 * Usage: npx tsx logue-codegen/scripts/runNoiseHarness.ts
 */
import { execFileSync } from 'child_process'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const SR = 48000
const harnessDir = join(dirname(new URL(import.meta.url).pathname), '..', 'harness', 'minilogue-xd')

function unitDoc(type: string, params: Record<string, number>, lfoToPitch = false): PatchDocument {
  const nodes: PatchDocument['nodes'] = [
    {
      kind: 'obj',
      type,
      name: 'n1',
      x: 0,
      y: 0,
      params: Object.entries(params).map(([name, v]) => ({ name, value: String(v) }))
    },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ]
  const nets: PatchDocument['nets'] = [
    { sources: [{ obj: 'n1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ]
  if (lfoToPitch) {
    nodes.push({ kind: 'obj', type: 'logue/lfo/sine-lfo', name: 'lfo1', x: 0, y: 0, params: [] })
    nets.push({ sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'n1', inlet: 'pitch' }] })
  }
  return { nodes, nets, settings: {}, notes: '' }
}

function render(doc: PatchDocument, samples: number, note = 60): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), 'lp-noise-harness-'))
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
  // The output stage scales by 0.999 (see the generated OSC_CYCLE); undo it for level readings.
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

/** Welch power spectrum (Hann, 50 % overlap). */
function spectrum(y: Float32Array, n = 8192): Float64Array {
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

/** dB per octave: a least-squares line through octave-band power densities from lo to hi, and
 *  the largest band's distance from that line (the ripple). */
function slope(y: Float32Array, lo: number, hi: number): string {
  const n = 8192
  const p = spectrum(y, n)
  const xs: number[] = []
  const ys: number[] = []
  for (let f = lo; f < hi; f *= 2) {
    const k0 = Math.round((f * n) / SR)
    const k1 = Math.round((2 * f * n) / SR)
    let sum = 0
    for (let k = k0; k < k1; k++) sum += p[k]
    xs.push(Math.log2(f))
    ys.push(10 * Math.log10(sum / (k1 - k0)))
  }
  const mx = xs.reduce((a, b) => a + b) / xs.length
  const my = ys.reduce((a, b) => a + b) / ys.length
  let num = 0
  let den = 0
  xs.forEach((x, i) => {
    num += (x - mx) * (ys[i] - my)
    den += (x - mx) ** 2
  })
  const k = num / den
  const ripple = Math.max(...xs.map((x, i) => Math.abs(ys[i] - (my + k * (x - mx)))))
  return `${k.toFixed(2)} (ripple ${ripple.toFixed(2)} dB)`
}

function levels(y: Float32Array): string {
  let sq = 0
  let peak = 0
  let clipped = 0
  let nonFinite = 0
  let sum = 0
  for (const v of y) {
    if (!Number.isFinite(v)) nonFinite++
    sq += v * v
    sum += v
    peak = Math.max(peak, Math.abs(v))
    if (Math.abs(v) >= 0.9999) clipped++
  }
  return `rms ${Math.sqrt(sq / y.length).toFixed(4)}  peak ${peak.toFixed(3)}  at ±1 ${((100 * clipped) / y.length).toFixed(3)}%  mean ${(sum / y.length).toFixed(5)}  nonfinite ${nonFinite}`
}

/** Fundamental: the peak of a Hann-windowed DFT scanned in 0.05-cent steps within +-15 cents of
 *  the expected pitch (two seconds: the autocorrelation of an aliased 1-bit wave was off by ~5
 *  cents at 2 kHz). */
function pitchHz(y: Float32Array, expectHz: number): number {
  const seg = y.subarray(4096)
  const n = seg.length
  const win = new Float64Array(n).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n))
  let best = expectHz
  let bestMag = -1
  for (let c = -15; c <= 15; c += 0.05) {
    const f = expectHz * 2 ** (c / 1200)
    const w = (2 * Math.PI * f) / SR
    let re = 0
    let im = 0
    for (let i = 0; i < n; i++) {
      re += seg[i] * win[i] * Math.cos(w * i)
      im -= seg[i] * win[i] * Math.sin(w * i)
    }
    const mag = re * re + im * im
    if (mag > bestMag) {
      bestMag = mag
      best = f
    }
  }
  return best
}

const cents = (f: number, ref: number): string => `${(1200 * Math.log2(f / ref)).toFixed(2)} ct`
const noteHz = (n: number): number => 440 * 2 ** ((n - 69) / 12)

console.log('noise COLOR (nominal slope: White 0, Pink -3, Brown -6, Violet +6 dB/oct)')
const NAMES = ['White', 'Pink', 'Brown', 'Violet']
NAMES.forEach((name, color) => {
  const y = render(unitDoc('logue/osc/noise', { COLOR: color }), SR * 20)
  console.log(
    `${name.padEnd(7)} ${levels(y)}  slope 25-12800 Hz ${slope(y, 25, 12800)}  100-6400 Hz ${slope(y, 100, 6400)}  50-1600 Hz ${slope(y, 50, 1600)}`
  )
})

console.log('\nlfsr Short, TRACK on (pitch vs the note)')
for (const note of [33, 45, 60, 69, 84, 96]) {
  const y = render(unitDoc('logue/osc/lfsr', { MODE: 1 }), SR * 2, note)
  const f = pitchHz(y, noteHz(note))
  console.log(
    `note ${note}  ${f.toFixed(3)} Hz vs ${noteHz(note).toFixed(3)}  ${cents(f, noteHz(note))}  ${levels(y)}`
  )
}

console.log('\nlfsr Short, TRACK off (RATE 0.1 Hz + t^4 * 1999.9)')
for (const rate of [40, 60, 80, 100]) {
  const hz = 0.1 + (rate / 100) ** 4 * 1999.9
  if (hz < 30) continue
  const y = render(unitDoc('logue/osc/lfsr', { MODE: 1, TRACK: 0, RATE: rate }), SR * 2)
  const f = pitchHz(y, hz)
  console.log(`RATE ${rate}  ${f.toFixed(3)} Hz vs ${hz.toFixed(3)}  ${cents(f, hz)}`)
}

console.log('\nlfsr Long, clock past the sample rate (note 120): period')
{
  const y = render(unitDoc('logue/osc/lfsr', { MODE: 0 }), 32767 * 3, 120)
  const repeats = (lag: number): number => {
    let same = 0
    for (let i = 0; i + lag < y.length; i++) if (y[i] === y[i + lag]) same++
    return same / (y.length - lag)
  }
  for (const lag of [32767, 32767 / 7, 32767 / 31, 32767 / 151, 32766]) {
    console.log(`lag ${lag}: ${(100 * repeats(lag)).toFixed(2)}% equal`)
  }
  console.log(`levels ${levels(y)}`)
}

console.log('\nlfsr Long at notes 36/60/84 (spectrum gets brighter with the clock)')
for (const note of [36, 60, 84]) {
  const y = render(unitDoc('logue/osc/lfsr', { MODE: 0 }), SR * 4, note)
  const p = spectrum(y)
  let total = 0
  let above = 0
  p.forEach((v, k) => {
    total += v
    if ((k * SR) / 8192 > 4000) above += v
  })
  console.log(
    `note ${note}  share above 4 kHz ${((100 * above) / total).toFixed(1)}%  ${levels(y)}`
  )
}

console.log('\nwired: pitch from a sine LFO, both modes (ASan/UBSan, finite)')
for (const mode of [0, 1]) {
  console.log(
    `MODE ${mode}  ${levels(render(unitDoc('logue/osc/lfsr', { MODE: mode }, true), SR * 2))}`
  )
}
console.log(
  'extreme notes, Short: ' +
    [0, 127]
      .map((n) =>
        levels(render(unitDoc('logue/osc/lfsr', { MODE: 1, COARSE: n ? 24 : -24 }), SR, n))
      )
      .join(' | ')
)

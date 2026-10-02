/**
 * One-off verification for `logue/osc/phase-dist` (2026-10-02): renders the oscillator through
 * the xd output under ASan/UBSan (`harness/minilogue-xd/`), behind a 0.25x VCA so peaks above
 * full scale survive the output clip, and measures per wave:
 *   - peak / RMS (for the output level),
 *   - DCW 0 is a pure sine (energy outside the fundamental),
 *   - the pitch: energy off the note's harmonics, which also catches a sub-octave from WAVE2,
 *   - aliasing at high notes with the bend limit on and off (the generated C++ patched),
 *   - brightness (harmonic centroid) against DCW, for the dial curve,
 *   - non-finite samples with every inlet wired from moving sources, at extreme notes.
 *
 * Usage: npx tsx logue-codegen/scripts/runPhaseDistHarness.ts
 */
import { execFileSync } from 'child_process'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import { PD_WAVE_NAMES } from '../src/paramPresentation'
import type { PatchDocument } from '../../src/shared/domain/patch'

const SR = 48000
const N_FFT = 32768
const SETTLE = SR / 2
const harnessDir = join(dirname(new URL(import.meta.url).pathname), '..', 'harness', 'minilogue-xd')

type Node = PatchDocument['nodes'][number]
const obj = (type: string, name: string, params: Record<string, number> = {}): Node => ({
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

function pdDoc(params: Record<string, number>, moving = false): PatchDocument {
  const nodes = [
    obj('logue/osc/phase-dist', 'pd', params),
    obj('logue/gain/vca', 'vca', { GAIN: 6.25 }),
    obj('logue/io/audio-out', 'out')
  ]
  const nets = [net('pd', 'out', 'vca', 'in'), net('vca', 'out', 'out', 'in')]
  if (moving) {
    nodes.push(
      obj('logue/lfo/sine-lfo', 'lfo1', { RATE: 70 }),
      obj('logue/lfo/triangle-lfo', 'lfo2', { RATE: 40 }),
      obj('logue/osc/noise', 'noise')
    )
    nets.push(
      net('lfo1', 'out', 'pd', 'dcw'),
      net('lfo2', 'out', 'pd', 'pitch'),
      net('lfo1', 'out', 'pd', 'harmonic'),
      net('noise', 'out', 'pd', 'fm'),
      net('lfo2', 'out', 'pd', 'fmDepth')
    )
  }
  return { nodes, nets, settings: {}, notes: '' }
}

function render(
  doc: PatchDocument,
  note: number,
  samples: number,
  patch?: (cpp: string) => string
): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), 'lp-pd-harness-'))
  copyFileSync(join(harnessDir, 'userosc.h'), join(dir, 'userosc.h'))
  let cpp = generateOldGenOscUnit(doc, { name: 'harness' }).oscCpp
  if (patch) {
    const before = cpp
    cpp = patch(cpp)
    if (cpp === before) throw new Error('patch did not apply')
  }
  writeFileSync(join(dir, 'osc_real.cpp'), cpp)
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
    for (unsigned i = 0; i < 64; i++) { float f = q31_to_f32(buf[i]) * 4.f; fwrite(&f, 4, 1, raw); }
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

/** Power spectrum of a Hann-windowed stretch (radix-2, in place). */
function spectrum(x: Float32Array): Float64Array {
  const re = new Float64Array(N_FFT)
  const im = new Float64Array(N_FFT)
  for (let i = 0; i < N_FFT; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT))
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
  const p = new Float64Array(N_FFT / 2)
  for (let i = 0; i < N_FFT / 2; i++) p[i] = re[i] * re[i] + im[i] * im[i]
  return p
}

interface Analysis {
  /** Energy per harmonic, [0] = the fundamental. */
  harmonics: number[]
  /** Energy not on a harmonic (aliases, a sub-octave), as a share of the total, dB. */
  offDb: number
  /** Everything but the fundamental against it, dB. */
  thdDb: number
  centroid: number
}

function analyse(y: Float32Array, f0: number): Analysis {
  const p = spectrum(y.subarray(SETTLE, SETTLE + N_FFT))
  const binHz = SR / N_FFT
  const on = new Uint8Array(p.length)
  const harmonics: number[] = []
  for (let h = 1; h * f0 < SR / 2 - 4 * binHz; h++) {
    const c = Math.round((h * f0) / binHz)
    let e = 0
    for (let b = c - 4; b <= c + 4; b++) {
      if (b > 2 && b < p.length && !on[b]) {
        e += p[b]
        on[b] = 1
      }
    }
    harmonics.push(e)
  }
  let total = 0
  let off = 0
  for (let b = 3; b < p.length; b++) {
    total += p[b]
    if (!on[b]) off += p[b]
  }
  const harmonicSum = harmonics.reduce((a, b) => a + b, 0)
  const centroid = harmonics.reduce((a, e, i) => a + (i + 1) * e, 0) / harmonicSum
  const db = (r: number): number => 10 * Math.log10(Math.max(r, 1e-15))
  return {
    harmonics,
    offDb: db(off / total),
    thdDb: db((total - harmonics[0]) / harmonics[0]),
    centroid
  }
}

function stats(y: Float32Array): { peak: number; rms: number; nonFinite: number } {
  let peak = 0
  let sq = 0
  let nonFinite = 0
  for (let i = SETTLE; i < y.length; i++) {
    const v = y[i]
    if (!Number.isFinite(v)) {
      nonFinite++
      continue
    }
    peak = Math.max(peak, Math.abs(v))
    sq += v * v
  }
  return { peak, rms: Math.sqrt(sq / (y.length - SETTLE)), nonFinite }
}

const hz = (note: number): number => 440 * Math.pow(2, (note - 69) / 12)
const len = SETTLE + N_FFT
/** The generated C++ with other bend-limit constants (0 = no limit: a 1e-6 floor, since k = 0
 *  would divide by zero), for comparing them. */
const withLimits =
  (localRate: number, resoRate: number) =>
  (cpp: string): string => {
    const reso = `${(resoRate > 0 ? resoRate : 1e9).toFixed(6)}f`
    return cpp
      .replace(
        'float lo = rate * 8.f;',
        localRate > 0 ? `float lo = rate * ${(1 / localRate).toFixed(6)}f;` : 'float lo = 1e-6f;'
      )
      .replace('if (r * rate <= 0.25f)', `if (r * rate <= ${reso})`)
      .replace(
        'return rate >= 0.25f ? 1.f : 0.25f / rate;',
        `return rate >= ${reso} ? 1.f : ${reso} / rate;`
      )
  }
const limitOff = withLimits(0, 0)

if (process.argv.includes('--sweep-limits')) {
  for (const [local, reso] of [
    [0.25, 0.4],
    [0.125, 0.25],
    [0.0625, 0.15]
  ] as const) {
    console.log(`local ${local}, reso ${reso}: off-harmonic dB at DCW 100, then centroid`)
    for (const note of [48, 72, 96]) {
      const row = PD_WAVE_NAMES.map((_, w) => {
        const a = analyse(
          render(pdDoc({ WAVE: w, DCW: 100 }), note, len, withLimits(local, reso)),
          hz(note)
        )
        return `${a.offDb.toFixed(0)}/${a.centroid.toFixed(1)}`
      })
      console.log(`  note ${note}: ${row.join('  ')}`)
    }
  }
  process.exit(0)
}

console.log('DCW 0 (note 60): energy outside the fundamental, dB')
PD_WAVE_NAMES.forEach((name, w) => {
  const a = analyse(render(pdDoc({ WAVE: w, DCW: 0 }), 60, len), hz(60))
  console.log(`  ${name.padEnd(8)} ${a.thdDb.toFixed(1)}`)
})

console.log('\nlevel and pitch (note 48): peak / rms, off-harmonic dB, per DCW')
for (let w2 = 0; w2 <= 8; w2 += 8) {
  PD_WAVE_NAMES.forEach((name, w) => {
    const row = [0, 50, 100].map((dcw) => {
      const y = render(
        pdDoc({ WAVE: w, WAVE2: w2 === 0 ? 0 : ((w + 3) % 8) + 1, DCW: dcw }),
        48,
        len
      )
      const s = stats(y)
      const a = analyse(y, hz(48))
      return `${s.peak.toFixed(2)}/${s.rms.toFixed(2)} ${a.offDb.toFixed(0)}dB`
    })
    const label = w2 === 0 ? name : `${name}+${PD_WAVE_NAMES[(w + 3) % 8]}`
    console.log(`  ${label.padEnd(16)} ${row.join('   ')}`)
  })
}

console.log('\naliasing at DCW 100: off-harmonic dB, limit on / off')
for (const note of [72, 84, 96, 108]) {
  const row = PD_WAVE_NAMES.map((_, w) => {
    const on = analyse(render(pdDoc({ WAVE: w, DCW: 100 }), note, len), hz(note)).offDb
    const off = analyse(render(pdDoc({ WAVE: w, DCW: 100 }), note, len, limitOff), hz(note)).offDb
    return `${on.toFixed(0)}/${off.toFixed(0)}`
  })
  console.log(`  note ${note}: ${row.join('  ')}`)
}

console.log('\nbrightness against DCW (note 48, harmonic centroid)')
for (const w of [0, 2, 5]) {
  const row = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((dcw) =>
    analyse(render(pdDoc({ WAVE: w, DCW: dcw }), 48, len), hz(48)).centroid.toFixed(1)
  )
  console.log(`  ${PD_WAVE_NAMES[w].padEnd(8)} ${row.join(' ')}`)
}

console.log('\nevery inlet wired from moving sources: non-finite samples, peak')
for (const note of [0, 60, 127]) {
  for (let w = 0; w < 8; w++) {
    const s = stats(render(pdDoc({ WAVE: w, WAVE2: 8 - w, DCW: 50, FM_DEPTH: 60 }, true), note, SR))
    if (s.nonFinite > 0 || s.peak > 4)
      console.log(`  note ${note} wave ${w}: nonfinite ${s.nonFinite} peak ${s.peak.toFixed(2)}`)
  }
}
console.log('  done')

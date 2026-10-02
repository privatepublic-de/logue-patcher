/**
 * One-off verification for `logue/osc/sample` (docs/PLAN-sample.md, phase 2): renders generated
 * minilogue xd units under ASan/UBSan (`harness/minilogue-xd/`'s userosc.h, whose note table is
 * exact equal temperament) and checks
 *  - playing ROOT from a 48 kHz sample reproduces the stored bytes exactly (both INTERP settings),
 *    and a one-shot then holds exact silence;
 *  - pitch within 1 ct over +-24 st at several stored rates (rising zero crossings of a looped
 *    sine, interpolated, over 2 s), also with COARSE and TRACK off;
 *  - a loop's seam is no bigger a step than the material's own;
 *  - START 50 begins at the middle;
 *  - a rising trig restarts a finished one-shot;
 *  - REVERSE and ping-pong (alone and together) play the exact expected sample order at ROOT,
 *    and their seams stay within the material's own steps off ROOT;
 *  - a wired pitch (control-rate path), extreme notes/COARSE (the speed cap) and START 100 on a
 *    32-sample loop run clean (no non-finite samples, no sanitizer report).
 *
 * Usage: npx tsx logue-codegen/scripts/runSampleHarness.ts
 */
import { execFileSync } from 'child_process'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import { bytesToBase64 } from '../src/sample/base64'
import { mulawEncode } from '../src/sample/mulaw'
import type { PatchDocument, SampleAsset } from '../../src/shared/domain/patch'

const SR = 48000
const harnessDir = join(dirname(new URL(import.meta.url).pathname), '..', 'harness', 'minilogue-xd')
let failures = 0

function check(ok: boolean, label: string, detail: string): void {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(44)} ${detail}`)
}

function pcm8(values: number[], rate: number, loop?: [number, number]): SampleAsset {
  const bytes = Uint8Array.from(values, (v) => Math.max(-127, Math.min(127, Math.round(v))) & 0xff)
  const asset: SampleAsset = {
    sourceName: 'h.wav',
    rate,
    encoding: 'pcm8',
    data: bytesToBase64(bytes)
  }
  if (loop) [asset.loopStart, asset.loopEnd] = loop
  return asset
}

/** `cycles` periods of a sine over `length` samples, at 8-bit full scale. */
function sineValues(length: number, cycles: number): number[] {
  return Array.from({ length }, (_, i) => 120 * Math.sin((2 * Math.PI * cycles * i) / length))
}

function signedOf(asset: SampleAsset): number[] {
  return Array.from(Buffer.from(asset.data, 'base64'), (b) => (b >= 128 ? b - 256 : b))
}

interface Extra {
  pitchFromLfo?: boolean
  trigFromSquare?: number
}

function sampleDoc(
  sample: SampleAsset,
  params: Record<string, number>,
  extra: Extra = {}
): PatchDocument {
  const nodes: PatchDocument['nodes'] = [
    {
      kind: 'obj',
      type: 'logue/osc/sample',
      name: 's',
      x: 0,
      y: 0,
      params: Object.entries(params).map(([name, v]) => ({ name, value: String(v) })),
      sample
    },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ]
  const nets: PatchDocument['nets'] = [
    { sources: [{ obj: 's', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ]
  if (extra.pitchFromLfo) {
    nodes.push({
      kind: 'obj',
      type: 'logue/lfo/sine-lfo',
      name: 'lfo',
      x: 0,
      y: 0,
      params: [{ name: 'RATE', value: '70' }]
    })
    nets.push({ sources: [{ obj: 'lfo', outlet: 'out' }], dests: [{ obj: 's', inlet: 'pitch' }] })
  }
  if (extra.trigFromSquare !== undefined) {
    nodes.push({
      kind: 'obj',
      type: 'logue/lfo/square-lfo',
      name: 'clk',
      x: 0,
      y: 0,
      params: [{ name: 'RATE', value: String(extra.trigFromSquare) }]
    })
    nets.push({ sources: [{ obj: 'clk', outlet: 'out' }], dests: [{ obj: 's', inlet: 'trig' }] })
  }
  return { nodes, nets, settings: {}, notes: '' }
}

function render(doc: PatchDocument, note: number, samples: number): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), 'lp-sample-harness-'))
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
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}

/** Mean frequency from linearly interpolated rising zero crossings, skipping the first 100 ms. */
function measureHz(y: Float32Array): number {
  const crossings: number[] = []
  for (let i = SR / 10; i < y.length; i++) {
    if (y[i - 1] < 0 && y[i] >= 0) crossings.push(i - 1 + -y[i - 1] / (y[i] - y[i - 1]))
  }
  return ((crossings.length - 1) * SR) / (crossings[crossings.length - 1] - crossings[0])
}

const cents = (hz: number, expected: number): number => 1200 * Math.log2(hz / expected)

function stats(y: Float32Array): { nonFinite: number; peak: number } {
  let nonFinite = 0
  let peak = 0
  for (const v of y) {
    if (!Number.isFinite(v)) nonFinite++
    else peak = Math.max(peak, Math.abs(v))
  }
  return { nonFinite, peak }
}

// 1. Bit-exact at ROOT, one-shot, then silence.
{
  const values = Array.from({ length: 1000 }, (_, i) => ((i * 37) % 255) - 127)
  const sample = pcm8(values, SR)
  const stored = signedOf(sample)
  for (const interp of [0, 1]) {
    const y = render(sampleDoc(sample, { ROOT: 60, INTERP: interp }), 60, 1280)
    let worst = 0
    for (let i = 0; i < stored.length; i++)
      worst = Math.max(worst, Math.abs(y[i] - (stored[i] / 128) * 0.999))
    let tail = 0
    for (let i = stored.length; i < y.length; i++) tail = Math.max(tail, Math.abs(y[i]))
    check(
      worst < 1e-6,
      `bit-exact at ROOT, INTERP ${interp ? 'None' : 'Linear'}`,
      `worst error ${worst.toExponential(2)}`
    )
    check(
      tail === 0,
      `one-shot ends in silence, INTERP ${interp ? 'None' : 'Linear'}`,
      `tail peak ${tail}`
    )
  }
}

// 2. Pitch: a looped sine, 4 cycles in 256 samples.
{
  const values = sineValues(256, 4)
  for (const rate of [22050, 32000, 48000]) {
    const sample = pcm8(values, rate)
    const base = (rate * 4) / 256
    let worst = 0
    for (const offset of [-24, -12, -5, 0, 7, 12, 24]) {
      const y = render(sampleDoc(sample, { ROOT: 60, LOOP: 1 }), 60 + offset, 2 * SR)
      worst = Math.max(worst, Math.abs(cents(measureHz(y), base * 2 ** (offset / 12))))
    }
    check(worst < 1, `pitch over +-24 st at ${rate} Hz`, `worst ${worst.toFixed(3)} ct`)
  }
  const sample = pcm8(values, 32000)
  const base = (32000 * 4) / 256
  const coarse = render(sampleDoc(sample, { ROOT: 60, LOOP: 1, COARSE: -7, FINE: 25 }), 64, 2 * SR)
  const cc = cents(measureHz(coarse), base * 2 ** ((4 - 7 + 0.25) / 12))
  check(Math.abs(cc) < 1, 'COARSE -7, FINE +25 on note 64', `${cc.toFixed(3)} ct`)
  const untracked = render(
    sampleDoc(sample, { ROOT: 60, LOOP: 1, TRACK: 0, COARSE: 12 }),
    40,
    2 * SR
  )
  const ut = cents(measureHz(untracked), base * 2)
  check(Math.abs(ut) < 1, 'TRACK off: every key is ROOT (+COARSE 12)', `${ut.toFixed(3)} ct`)
}

// 3. Loop seam: one-shot attack then a loop over whole cycles of a sine.
{
  const values = [
    ...Array.from({ length: 300 }, (_, i) => (i % 2 ? 60 : -60)),
    ...sineValues(400, 5)
  ]
  const sample = pcm8(values, 30000, [300, 700])
  const stored = signedOf(sample)
  let materialStep = 0
  for (let i = 301; i < 700; i++)
    materialStep = Math.max(materialStep, Math.abs(stored[i] - stored[i - 1]) / 128)
  materialStep = Math.max(materialStep, Math.abs(stored[300] - stored[699]) / 128)
  const y = render(sampleDoc(sample, { ROOT: 60, LOOP: 1 }), 67, SR)
  let seamStep = 0
  for (let i = SR / 10; i < y.length; i++) seamStep = Math.max(seamStep, Math.abs(y[i] - y[i - 1]))
  const speed = (30000 / SR) * 2 ** (7 / 12)
  check(
    seamStep <= materialStep * Math.max(1, speed) + 1e-3,
    'looped steps within the material',
    `largest ${seamStep.toFixed(4)}, material ${materialStep.toFixed(4)} x speed ${speed.toFixed(3)}`
  )
}

// 4. START 50.
{
  const values = Array.from({ length: 1001 }, (_, i) => (i % 2 ? 1 : -1) * (10 + (i % 100)))
  const sample = pcm8(values, SR)
  const stored = signedOf(sample)
  const y = render(sampleDoc(sample, { ROOT: 60, START: 50 }), 60, 640)
  const ok =
    Math.abs(y[0] - (stored[500] / 128) * 0.999) < 1e-6 &&
    Math.abs(y[1] - (stored[501] / 128) * 0.999) < 1e-6
  check(
    ok,
    'START 50 begins at sample 500 of 1001',
    `first ${y[0].toFixed(4)} vs ${((stored[500] / 128) * 0.999).toFixed(4)}`
  )
}

// 5. trig restarts a finished one-shot: count silences (64+ zero samples) that end.
{
  const sample = pcm8(sineValues(480, 6), SR)
  const y = render(sampleDoc(sample, { ROOT: 60 }, { trigFromSquare: 70 }), 60, 2 * SR)
  let restarts = 0
  let zeros = 0
  for (const v of y) {
    if (v === 0) zeros++
    else {
      if (zeros >= 64) restarts++
      zeros = 0
    }
  }
  check(restarts >= 2, 'a rising trig restarts the one-shot', `${restarts} restarts in 2 s`)
}

// 6. REVERSE and ping-pong: the exact index sequence at speed 1 (ROOT from a 48 kHz sample).
{
  const values = Array.from({ length: 600 }, (_, i) => ((i * 37) % 255) - 127)
  const looped = pcm8(values, SR, [200, 400])
  const stored = signedOf(looped)
  const expectIndices = (indices: number[], y: Float32Array): number => {
    let worst = 0
    indices.forEach((idx, k) => {
      const want = idx < 0 ? 0 : (stored[idx] / 128) * 0.999
      worst = Math.max(worst, Math.abs(y[k] - want))
    })
    return worst
  }
  const range = (from: number, to: number): number[] => {
    const out: number[] = []
    for (let i = from; from <= to ? i <= to : i >= to; i += from <= to ? 1 : -1) out.push(i)
    return out
  }
  const cases: [string, Record<string, number>, number[]][] = [
    // One-shot backwards from the end, then silence.
    ['REVERSE one-shot', { REVERSE: 100 }, [...range(599, 0), ...Array(40).fill(-1)]],
    // START 50 from the end: (599 - 0) * 0.5 -> index 599 - 299 = 300.
    ['REVERSE START 50', { REVERSE: 100, START: 50 }, range(300, 0)],
    // Backwards through the tail into the loop, then the loop backwards: ..200, 399..200, 399..
    [
      'REVERSE + Forward loop',
      { REVERSE: 100, LOOP: 1 },
      [...range(599, 200), ...range(399, 200), ...range(399, 200)]
    ],
    // Forwards to the loop's last sample, back to its first, forwards again.
    [
      'Ping-pong',
      { LOOP: 2 },
      [...range(0, 399), ...range(398, 200), ...range(201, 399), ...range(398, 300)]
    ],
    // Backwards from the end, bounce at the loop start, then back and forth inside the loop.
    [
      'REVERSE + ping-pong',
      { REVERSE: 100, LOOP: 2 },
      [...range(599, 200), ...range(201, 399), ...range(398, 200)]
    ]
  ]
  for (const [label, params, indices] of cases) {
    for (const interp of [0, 1]) {
      const y = render(
        sampleDoc(looped, { ROOT: 60, INTERP: interp, ...params }),
        60,
        Math.ceil(indices.length / 64) * 64
      )
      const worst = expectIndices(indices, y)
      check(
        worst < 1e-6,
        `${label}, INTERP ${interp ? 'None' : 'Linear'}`,
        `worst error ${worst.toExponential(2)} over ${indices.length} samples`
      )
    }
  }
  // Off ROOT the loop seams stay within the material's own steps.
  const smooth = pcm8(sineValues(400, 5), 30000, [80, 320])
  const smoothStored = signedOf(smooth)
  let material = 0
  for (let i = 1; i < 400; i++)
    material = Math.max(material, Math.abs(smoothStored[i] - smoothStored[i - 1]) / 128)
  for (const [label, params] of [
    ['ping-pong seams', { LOOP: 2 }],
    ['REVERSE loop seams', { LOOP: 1, REVERSE: 100 }]
  ] as const) {
    const y = render(sampleDoc(smooth, { ROOT: 60, ...params }), 67, SR)
    let step = 0
    for (let i = SR / 10; i < y.length; i++) step = Math.max(step, Math.abs(y[i] - y[i - 1]))
    const speed = (30000 / SR) * 2 ** (7 / 12)
    check(
      step <= material * Math.max(1, speed) + 1e-3,
      label,
      `largest ${step.toFixed(4)}, material ${material.toFixed(4)}`
    )
  }
}

// 7. Wired pitch, extremes, START 100 on a minimum loop, a mu-law sample converted.
{
  const loopSample = pcm8(sineValues(64, 2), 44100, [32, 64])
  const cases: [string, PatchDocument, number][] = [
    [
      'pitch from a sine LFO (control rate)',
      sampleDoc(pcm8(sineValues(256, 4), 32000), { LOOP: 1 }, { pitchFromLfo: true }),
      60
    ],
    [
      'note 127 + COARSE 24 + LFO (speed cap)',
      sampleDoc(
        pcm8(sineValues(256, 4), SR),
        { LOOP: 1, COARSE: 24, ROOT: 0 },
        { pitchFromLfo: true }
      ),
      127
    ],
    [
      'note 0, COARSE -24',
      sampleDoc(pcm8(sineValues(256, 4), 8000), { LOOP: 1, COARSE: -24, ROOT: 127 }),
      0
    ],
    ['START 100 on a 32-sample loop', sampleDoc(loopSample, { LOOP: 1, START: 100 }), 72],
    ['one-shot START 100', sampleDoc(loopSample, { START: 100 }), 72],
    [
      'ping-pong + REVERSE, 32-sample loop, LFO + cap',
      sampleDoc(loopSample, { LOOP: 2, REVERSE: 100, COARSE: 24, ROOT: 0 }, { pitchFromLfo: true }),
      127
    ],
    [
      'REVERSE one-shot START 90, trig',
      sampleDoc(loopSample, { REVERSE: 100, START: 90 }, { trigFromSquare: 70 }),
      60
    ]
  ]
  for (const [label, doc, note] of cases) {
    const y = render(doc, note, SR)
    const s = stats(y)
    check(
      s.nonFinite === 0 && s.peak <= 1,
      label,
      `peak ${s.peak.toFixed(4)}, non-finite ${s.nonFinite}`
    )
  }
  const mulaw: SampleAsset = {
    sourceName: 'm.wav',
    rate: 24000,
    encoding: 'mulaw8',
    data: bytesToBase64(Uint8Array.from(sineValues(256, 4), (v) => mulawEncode(v / 128)))
  }
  const y = render(sampleDoc(mulaw, { LOOP: 1 }), 60, 2 * SR)
  const mc = cents(measureHz(y), (24000 * 4) / 256)
  check(
    Math.abs(mc) < 1 && stats(y).peak > 0.8,
    'a mu-law sample plays (converted)',
    `${mc.toFixed(3)} ct, peak ${stats(y).peak.toFixed(3)}`
  )
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0

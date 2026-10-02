/**
 * One-off verification for `logue/env/adsr` and `logue/env/one-knob-adsr` (2026-10-02): renders
 * the envelope straight into the xd output under ASan/UBSan (`harness/minilogue-xd/`), with a
 * note held for HOLD seconds and then released, and measures each stage against what the
 * station table says: attack time (to 1), the level reached before note-off (the sustain), the
 * decay time (to within 1 % of the sustain) and the release time (to 0). Also runs SHAPE wired
 * from an LFO (the control-rate path), a wired gate, and a note shorter than its block.
 *
 * Usage: npx tsx logue-codegen/scripts/runAdsrHarness.ts
 */
import { execFileSync } from 'child_process'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import { KNOB_ENV_SHAPE_NAMES } from '../src/paramPresentation'
import type { PatchDocument } from '../../src/shared/domain/patch'

const SR = 48000
const HOLD_S = 9
const RELEASE_S = 9
const harnessDir = join(dirname(new URL(import.meta.url).pathname), '..', 'harness', 'minilogue-xd')

/** Must match KNOB_ENV_STATIONS in primitives/env.ts (A ms, D ms, S, R ms). */
const STATIONS: [number, number, number, number][] = [
  [1, 40, 0, 40],
  [1, 250, 0, 200],
  [1, 600, 0, 600],
  [2, 2000, 0, 300],
  [2, 800, 0.4, 400],
  [2, 300, 1, 10],
  [2, 300, 1, 300],
  [40, 300, 0.7, 150],
  [250, 500, 1, 600],
  [800, 1000, 0.8, 1000],
  [2000, 1500, 0, 1500],
  [2000, 2000, 0.7, 3000],
  [5000, 3000, 1, 8000]
]

function envDoc(
  type: string,
  params: Record<string, number>,
  extra?: { lfoToShape?: boolean; gateFromSquare?: boolean }
): PatchDocument {
  const nodes: PatchDocument['nodes'] = [
    {
      kind: 'obj',
      type,
      name: 'env1',
      x: 0,
      y: 0,
      params: Object.entries(params).map(([name, v]) => ({ name, value: String(v) }))
    },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ]
  const nets: PatchDocument['nets'] = [
    { sources: [{ obj: 'env1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ]
  if (extra?.lfoToShape) {
    nodes.push({
      kind: 'obj',
      type: 'logue/lfo/sine-lfo',
      name: 'lfo1',
      x: 0,
      y: 0,
      params: [{ name: 'RATE', value: '60' }]
    })
    nets.push({
      sources: [{ obj: 'lfo1', outlet: 'out' }],
      dests: [{ obj: 'env1', inlet: 'shape' }]
    })
  }
  if (extra?.gateFromSquare) {
    nodes.push({
      kind: 'obj',
      type: 'logue/lfo/square-lfo',
      name: 'clk',
      x: 0,
      y: 0,
      params: [{ name: 'RATE', value: '20' }]
    })
    nets.push({ sources: [{ obj: 'clk', outlet: 'out' }], dests: [{ obj: 'env1', inlet: 'gate' }] })
  }
  return { nodes, nets, settings: {}, notes: '' }
}

function render(doc: PatchDocument, holdSamples: number, releaseSamples: number): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), 'lp-adsr-harness-'))
  copyFileSync(join(harnessDir, 'userosc.h'), join(dir, 'userosc.h'))
  writeFileSync(join(dir, 'osc_real.cpp'), generateOldGenOscUnit(doc, { name: 'harness' }).oscCpp)
  // holdSamples 0: note-on and note-off before the first block (a note shorter than a block).
  writeFileSync(
    join(dir, 'main.cpp'),
    `#include <cmath>
#include <cstdio>
#include <cstring>
#include "osc_real.cpp"
int main() {
  user_osc_param_t p;
  memset(&p, 0, sizeof(p));
  p.pitch = (60 << 8);
  OSC_INIT(0, 0);
  OSC_NOTEON(&p);
  const unsigned hold = ${holdSamples}, total = ${holdSamples + releaseSamples}, block = 64;
  static int32_t buf[64];
  FILE *raw = fopen("out.raw", "wb");
  bool off = false;
  for (unsigned done = 0; done < total; done += block) {
    if (!off && done >= hold) { OSC_NOTEOFF(&p); off = true; }
    OSC_CYCLE(&p, buf, block);
    for (unsigned i = 0; i < block; i++) { float f = q31_to_f32(buf[i]); fwrite(&f, 4, 1, raw); }
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

interface Measured {
  attackMs: number
  decayMs: number
  sustain: number
  releaseMs: number
  nonFinite: number
  max: number
}

function measure(y: Float32Array, hold: number, sustain: number): Measured {
  let nonFinite = 0
  let max = 0
  for (const v of y) {
    if (!Number.isFinite(v)) nonFinite++
    if (v > max) max = v
  }
  let peak = 0
  while (peak < hold && y[peak] < 0.999) peak++
  let settled = peak
  const tol = 0.0101 * (1 - sustain) + 1e-4
  while (settled < hold && Math.abs(y[settled] - sustain) > tol) settled++
  let end = hold
  while (end < y.length && y[end] > 0) end++
  return {
    attackMs: (peak / SR) * 1000,
    decayMs: ((settled - peak) / SR) * 1000,
    sustain: y[hold - 1],
    releaseMs: ((end - hold) / SR) * 1000,
    nonFinite,
    max
  }
}

const fmt = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`

const hold = HOLD_S * SR
const release = RELEASE_S * SR
console.log('one-knob-adsr stations (expected -> measured)')
STATIONS.forEach(([a, d, s, r], k) => {
  const shape = Math.round((k * 100) / (STATIONS.length - 1))
  const m = measure(
    render(envDoc('logue/env/one-knob-adsr', { SHAPE: shape }), hold, release),
    hold,
    s
  )
  console.log(
    `${KNOB_ENV_SHAPE_NAMES[k].padEnd(8)} SHAPE ${String(shape).padStart(3)}  A ${fmt(a)}->${fmt(m.attackMs)}  D ${fmt(d)}->${fmt(m.decayMs)}  S ${s}->${m.sustain.toFixed(4)}  R ${fmt(r)}->${fmt(m.releaseMs)}  max ${m.max.toFixed(4)} nonfinite ${m.nonFinite}`
  )
})

console.log('\nbetween stations')
for (const shape of [4, 13, 29, 46, 63, 79, 96]) {
  const m = measure(
    render(envDoc('logue/env/one-knob-adsr', { SHAPE: shape }), hold, release),
    hold,
    0
  )
  console.log(
    `SHAPE ${String(shape).padStart(3)}  A ${fmt(m.attackMs)}  S ${m.sustain.toFixed(4)}  R ${fmt(m.releaseMs)}  nonfinite ${m.nonFinite}`
  )
}

console.log('\nTIME 0 / 100 on Pluck (expect 0.1x / 10x of 250 ms decay)')
for (const time of [0, 100]) {
  const m = measure(
    render(envDoc('logue/env/one-knob-adsr', { SHAPE: 8, TIME: time }), hold, release),
    hold,
    0
  )
  console.log(`TIME ${time}  A ${fmt(m.attackMs)}  D ${fmt(m.decayMs)}  R ${fmt(m.releaseMs)}`)
}

console.log('\nadsr defaults (A 8 ms, D 512 ms, S 0.7, R 343 ms) and A0/S100/R100')
for (const params of [{}, { ATTACK: 0, SUSTAIN: 100, RELEASE: 100 }] as Record<string, number>[]) {
  const sustain = 'SUSTAIN' in params ? 1 : 0.7
  const m = measure(render(envDoc('logue/env/adsr', params), hold, release), hold, sustain)
  console.log(
    `${JSON.stringify(params)}  A ${fmt(m.attackMs)}  D ${fmt(m.decayMs)}  S ${m.sustain.toFixed(4)}  R ${fmt(m.releaseMs)}  nonfinite ${m.nonFinite}`
  )
}

console.log(
  '\nwired: SHAPE from a sine LFO (control-rate path), gate from a square LFO, a note inside one block'
)
const wired: [string, PatchDocument, number][] = [
  ['lfo->shape', envDoc('logue/env/one-knob-adsr', { SHAPE: 50 }, { lfoToShape: true }), hold],
  [
    'square->gate',
    envDoc('logue/env/one-knob-adsr', { SHAPE: 33 }, { gateFromSquare: true }),
    hold
  ],
  ['square->gate adsr', envDoc('logue/env/adsr', {}, { gateFromSquare: true }), hold],
  ['note inside a block', envDoc('logue/env/one-knob-adsr', { SHAPE: 50 }), 0]
]
for (const [name, doc, h] of wired) {
  const y = render(doc, h, release)
  let nonFinite = 0
  let min = Infinity
  let max = -Infinity
  let tailMax = 0
  for (let i = 0; i < y.length; i++) {
    if (!Number.isFinite(y[i])) nonFinite++
    min = Math.min(min, y[i])
    max = Math.max(max, y[i])
    if (i > y.length - SR) tailMax = Math.max(tailMax, y[i])
  }
  console.log(
    `${name.padEnd(20)} min ${min.toFixed(4)} max ${max.toFixed(4)} last-second max ${tailMax.toFixed(4)} nonfinite ${nonFinite}`
  )
}

console.log('\nrelease mid-decay (zero-sustain stations, note-off after 200 ms)')
for (const k of [0, 1, 2, 3, 10]) {
  const [, , , r] = STATIONS[k]
  const shape = Math.round((k * 100) / (STATIONS.length - 1))
  const h = Math.round(0.2 * SR)
  const y = render(envDoc('logue/env/one-knob-adsr', { SHAPE: shape }), h, release)
  const level = y[h - 1]
  let end = h
  while (end < y.length && y[end] > 0) end++
  const expected = (r * Math.log(1 + level / 0.01)) / Math.log(101)
  console.log(
    `${KNOB_ENV_SHAPE_NAMES[k].padEnd(8)} level at note-off ${level.toFixed(4)}  release ${fmt(((end - h) / SR) * 1000)} (expected ${fmt(expected)})`
  )
}

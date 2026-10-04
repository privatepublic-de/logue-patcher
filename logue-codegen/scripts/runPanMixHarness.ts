/**
 * One-off verification for `logue/mix/pan-mix2` (2026-10-04): renders its `l` and `r` outlets
 * (one per run) through the xd output under ASan/UBSan (`harness/minilogue-xd/`), with constant
 * inputs so every gain is read off directly:
 *  - each input's gains against GAIN * sqrt((100 -+ PAN) / 200), hard left/right exact;
 *  - two inputs panned apart land on their own sides only;
 *  - a sine LFO into `pan1` (the control-rate path): l^2 + r^2 stays GAIN^2 * in^2, no jumps.
 *
 * Usage: npx tsx logue-codegen/scripts/runPanMixHarness.ts
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

/** Constant `in1` (and `in2` if given) -> pan-mix2 -> `side` -> out. */
function mixDoc(
  mix: Params,
  side: 'l' | 'r',
  in1: number,
  in2?: number,
  lfoIntoPan1 = false
): PatchDocument {
  const nodes: Node[] = [
    obj('logue/mix/pan-mix2', 'pm', mix),
    obj('logue/io/audio-out', 'out'),
    obj('logue/util/constant', 'c1', { VALUE: in1 * 100 })
  ]
  const nets = [net('pm', side, 'out', 'in'), net('c1', 'out', 'pm', 'in1')]
  if (in2 !== undefined) {
    nodes.push(obj('logue/util/constant', 'c2', { VALUE: in2 * 100 }))
    nets.push(net('c2', 'out', 'pm', 'in2'))
  }
  if (lfoIntoPan1) {
    nodes.push(obj('logue/lfo/sine-lfo', 'lfo', { RATE: 70 }))
    nets.push(net('lfo', 'out', 'pm', 'pan1'))
  }
  return { nodes, nets, settings: {}, notes: '' }
}

function render(doc: PatchDocument, samples: number): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), 'lp-panmix-harness-'))
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
  p.pitch = (60 << 8);
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

const last = (y: Float32Array): number => y[y.length - 1]
const fmt = (x: number): string => x.toFixed(6)

console.log('one input (0.5): measured l / r against GAIN * sqrt((100 -+ PAN) / 200) * 0.5')
let worst = 0
for (const gain of [100, 70, 25, 0]) {
  for (const pan of [-100, -50, 0, 37, 100]) {
    const l = last(render(mixDoc({ GAIN1: gain, PAN1: pan }, 'l', 0.5), 256))
    const r = last(render(mixDoc({ GAIN1: gain, PAN1: pan }, 'r', 0.5), 256))
    const el = (gain / 100) * Math.sqrt((100 - pan) / 200) * 0.5
    const er = (gain / 100) * Math.sqrt((100 + pan) / 200) * 0.5
    worst = Math.max(worst, Math.abs(l - el), Math.abs(r - er))
    console.log(`GAIN ${gain} PAN ${pan}: l ${fmt(l)} (${fmt(el)})  r ${fmt(r)} (${fmt(er)})`)
  }
}
console.log(
  `largest error ${worst.toExponential(2)} (q31 output step ${(2 ** -31).toExponential(2)})`
)

console.log('\ntwo inputs panned apart: in1 0.5 hard left, in2 0.3 hard right, GAIN1 100, GAIN2 50')
const both = { GAIN1: 100, PAN1: -100, GAIN2: 50, PAN2: 100 }
console.log(
  `l ${fmt(last(render(mixDoc(both, 'l', 0.5, 0.3), 256)))} (0.5)  r ${fmt(last(render(mixDoc(both, 'r', 0.5, 0.3), 256)))} (0.15)`
)
const center = { GAIN1: 70, PAN1: 0, GAIN2: 70, PAN2: 0 }
console.log(
  `both full scale (1.0) at the center, GAIN 70: l ${fmt(last(render(mixDoc(center, 'l', 1, 1), 256)))} r ${fmt(last(render(mixDoc(center, 'r', 1, 1), 256)))}`
)

console.log('\nsine LFO into pan1 (control rate), in1 0.5, GAIN1 100: equal power and smoothness')
const N = 4 * SR
const l = render(mixDoc({ GAIN1: 100 }, 'l', 0.5, undefined, true), N)
const r = render(mixDoc({ GAIN1: 100 }, 'r', 0.5, undefined, true), N)
let powerErr = 0
let maxStep = 0
let minL = Infinity
let maxL = -Infinity
let nonFinite = 0
for (let i = 64; i < N; i++) {
  if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) nonFinite++
  powerErr = Math.max(powerErr, Math.abs(l[i] * l[i] + r[i] * r[i] - 0.25) / 0.25)
  maxStep = Math.max(maxStep, Math.abs(l[i] - l[i - 1]), Math.abs(r[i] - r[i - 1]))
  minL = Math.min(minL, l[i])
  maxL = Math.max(maxL, l[i])
}
console.log(
  `l range ${fmt(minL)}..${fmt(maxL)}, power error ${(powerErr * 100).toFixed(4)} %, largest step ${maxStep.toExponential(2)}, nonfinite ${nonFinite}`
)

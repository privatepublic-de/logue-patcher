/**
 * One-off verification for `logue/util/slew` (2026-10-04): renders it straight into the xd output
 * under ASan/UBSan (`harness/minilogue-xd/`). The input is `sense/gate` (0 -> 1 at note-on,
 * 1 -> 0 at note-off) times a constant, so the jump size is known. Measures how long each jump
 * takes against RISE/FALL on the 8000*t^3 ms curve, in both modes; that RISE/FALL 0 passes a saw
 * through bit-exactly; and a sine LFO into `rise`/`fall` (the control-rate path).
 *
 * Usage: npx tsx logue-codegen/scripts/runSlewHarness.ts
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
const obj = (type: string, name: string, params: Params = {}): PatchDocument['nodes'][number] => ({
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

/** gate x VALUE/100 -> slew -> out; `source` replaces the gate chain with another node's out. */
function slewDoc(
  slew: Params,
  opts: { jump?: number; source?: PatchDocument['nodes'][number]; lfoInto?: 'rise' | 'fall' } = {}
): PatchDocument {
  const nodes = [obj('logue/util/slew', 'sl', slew), obj('logue/io/audio-out', 'out')]
  const nets = [net('sl', 'out', 'out', 'in')]
  if (opts.source) {
    nodes.push(opts.source)
    nets.push(net(opts.source.name!, 'out', 'sl', 'in'))
  } else {
    nodes.push(
      obj('logue/sense/gate', 'g'),
      obj('logue/util/constant', 'c', { VALUE: (opts.jump ?? 1) * 100 }),
      obj('logue/math/multiply', 'm')
    )
    nets.push(net('g', 'out', 'm', 'in1'), net('c', 'out', 'm', 'in2'), net('m', 'out', 'sl', 'in'))
  }
  if (opts.lfoInto) {
    nodes.push(obj('logue/lfo/sine-lfo', 'lfo', { RATE: 60 }))
    nets.push(net('lfo', 'out', 'sl', opts.lfoInto))
  }
  return { nodes, nets, settings: {}, notes: '' }
}

function render(doc: PatchDocument, holdSamples: number, releaseSamples: number): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), 'lp-slew-harness-'))
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

const curveMs = (p: number): number => 8000 * Math.pow(p / 100, 3)
const fmt = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(3)}s` : `${ms.toFixed(1)}ms`

/** Samples from `start` until |y - target| <= tol (the q31 output's own resolution included). */
function settle(y: Float32Array, start: number, target: number, tol: number): number {
  let i = start
  while (i < y.length && Math.abs(y[i] - target) > tol) i++
  return i - start
}

/** The xd shell's output headroom (`clip1m1f(x) * 0.999f`). */
const OUT = 0.999
const HOLD = 6 * SR
const REL = 6 * SR

console.log('jump times (expected -> measured); linear: to the target, exponential: to within 1 %')
for (const mode of [0, 1]) {
  for (const [rise, fall, jump] of [
    [50, 30, 1],
    [50, 30, 0.5],
    [70, 20, 0.25],
    [10, 60, 1]
  ]) {
    const y = render(slewDoc({ RISE: rise, FALL: fall, MODE: mode }, { jump }), HOLD, REL)
    const tol = (mode === 0 ? 1e-6 : 0.01 * jump) * OUT
    const up = (settle(y, 0, jump * OUT, tol) / SR) * 1000
    const down = (settle(y, HOLD, 0, tol) / SR) * 1000
    const k = mode === 0 ? jump : 1
    console.log(
      `${mode === 0 ? 'linear' : 'exp   '} RISE ${rise} FALL ${fall} jump ${jump}:  up ${fmt(curveMs(rise) * k)} -> ${fmt(up)}  down ${fmt(curveMs(fall) * k)} -> ${fmt(down)}  held ${y[HOLD - 1].toFixed(6)} end ${y[y.length - 1].toFixed(6)}`
    )
  }
}

console.log('\nRISE/FALL 0: a saw passes through unchanged (both modes)')
const saw = obj('logue/osc/saw', 'src')
const plain = render(
  {
    nodes: [{ ...saw }, obj('logue/io/audio-out', 'out')],
    nets: [net('src', 'out', 'out', 'in')],
    settings: {},
    notes: ''
  },
  SR,
  0
)
for (const mode of [0, 1]) {
  const y = render(slewDoc({ RISE: 0, FALL: 0, MODE: mode }, { source: { ...saw } }), SR, 0)
  let diff = 0
  for (let i = 0; i < y.length; i++) diff = Math.max(diff, Math.abs(y[i] - plain[i]))
  console.log(`MODE ${mode}: max |slew - saw| = ${diff}`)
}

console.log('\nsine LFO into rise / fall (control-rate path), both modes')
for (const mode of [0, 1]) {
  for (const into of ['rise', 'fall'] as const) {
    const y = render(slewDoc({ RISE: 40, FALL: 40, MODE: mode }, { lfoInto: into }), HOLD, REL)
    let nonFinite = 0
    let min = Infinity
    let max = -Infinity
    for (const v of y) {
      if (!Number.isFinite(v)) nonFinite++
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    console.log(
      `MODE ${mode} lfo->${into}: min ${min.toFixed(6)} max ${max.toFixed(6)} held ${y[HOLD - 1].toFixed(6)} end ${y[y.length - 1].toFixed(6)} nonfinite ${nonFinite}`
    )
  }
}

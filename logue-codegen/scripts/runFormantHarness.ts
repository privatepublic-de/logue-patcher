/**
 * One-off verification for `logue/filter/formant`'s per-block coefficients (2026-10-06): renders
 * it into the xd output under ASan/UBSan (`harness/minilogue-xd/`) and compares against renders
 * saved from an earlier build of the generator.
 * - Still: every setting unwired, or wired from per-block values (`sense/control`, hoisted), must
 *   equal the saved render (the per-sample version) to float rounding.
 * - Moving: LFOs into `vowel`/`shift`/`resonance`/`character` (control-rate now): the difference
 *   to the saved per-sample render, in dB below its level, and the largest sample-to-sample step
 *   against the saved one's (a zipper would show there).
 * - Fuzz: noise into every inlet at extreme notes and settings: finite.
 *
 * Usage: npx tsx logue-codegen/scripts/runFormantHarness.ts --save <dir>   (reference)
 *        npx tsx logue-codegen/scripts/runFormantHarness.ts --compare <dir>
 */
import { execFileSync } from 'child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

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

const INLETS = ['vowel', 'shift', 'resonance', 'character'] as const

/** A saw (or noise) -> formant -> out, with `drive` sources wired into formant inlets. */
function doc(
  params: Params,
  drive: Partial<Record<(typeof INLETS)[number], Node>> = {},
  source: Node = obj('logue/osc/saw', 'src')
): PatchDocument {
  const nodes: Node[] = [
    source,
    obj('logue/io/audio-out', 'out'),
    obj('logue/filter/formant', 'f', params)
  ]
  const nets: Net[] = [net(source.name!, 'out', 'f', 'in'), net('f', 'out', 'out', 'in')]
  for (const [inlet, node] of Object.entries(drive)) {
    nodes.push(node)
    const outlet = node.type === 'logue/sense/control' ? 'bipolar' : 'out'
    nets.push(net(node.name!, outlet, 'f', inlet))
  }
  return { nodes, nets, settings: {}, notes: '' }
}

function render(d: PatchDocument, samples: number, note: number): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), 'lp-formant-harness-'))
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
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}

interface Case {
  name: string
  doc: PatchDocument
  note: number
  kind: 'still' | 'moving' | 'zipper' | 'fuzz'
}

const lfo = (name: string, rate: number, type = 'logue/lfo/sine-lfo'): Node =>
  obj(type, name, { RATE: rate })
const knob = (name: string, value: number): Node =>
  obj('logue/sense/control', name, { VALUE: value })

const cases: Case[] = []
for (const [v, c, s, r] of [
  [50, 50, 0, 60],
  [0, 0, 0, 60],
  [37, 0, 0, 60],
  [100, 100, 0, 60],
  [63, 25, 13, 100],
  [12, 80, -24, 0],
  [88, 50, 24, 30]
]) {
  for (const note of [36, 60, 84]) {
    cases.push({
      name: `still v${v} c${c} s${s} r${r} n${note}`,
      doc: doc({ VOWEL: v, CHARACTER: c, SHIFT: s, RESONANCE: r }),
      note,
      kind: 'still'
    })
  }
}
// The user's formant patch: VOWEL/CHARACTER from knob readings (per-block once hoisted).
cases.push({
  name: 'still knobs into vowel/character',
  doc: doc(
    { VOWEL: 50, CHARACTER: 50, SHIFT: 0, RESONANCE: 60 },
    {
      vowel: knob('k1', 65),
      character: knob('k2', 20)
    }
  ),
  note: 48,
  kind: 'still'
})
cases.push({
  name: 'still knobs into all four',
  doc: doc(
    { VOWEL: 50, CHARACTER: 50, SHIFT: 0, RESONANCE: 60 },
    {
      vowel: knob('k1', 65),
      character: knob('k2', 20),
      shift: knob('k3', 70),
      resonance: knob('k4', 35)
    }
  ),
  note: 48,
  kind: 'still'
})
for (const [inlet, rate] of [
  ['vowel', 40],
  ['vowel', 90],
  ['shift', 40],
  ['resonance', 40],
  ['character', 40]
] as const) {
  cases.push({
    name: `moving ${inlet} LFO RATE ${rate}`,
    doc: doc({ VOWEL: 50, CHARACTER: 50, SHIFT: 0, RESONANCE: 60 }, { [inlet]: lfo('l', rate) }),
    note: 48,
    kind: 'moving'
  })
}
cases.push({
  name: 'moving all four',
  doc: doc(
    { VOWEL: 50, CHARACTER: 50, SHIFT: 0, RESONANCE: 80 },
    {
      vowel: lfo('l1', 60),
      shift: lfo('l2', 30, 'logue/lfo/triangle-lfo'),
      resonance: lfo('l3', 45),
      character: lfo('l4', 20)
    }
  ),
  note: 48,
  kind: 'moving'
})
// A 220 Hz sine through a moving formant: what it should hear stays below ~1.5 kHz (the sine and
// its modulation sidebands); stepping coefficients every 16 samples would add images around
// multiples of 3 kHz. Compared with the per-sample render's energy up there.
for (const [inlet, rate] of [
  ['vowel', 90],
  ['shift', 90],
  ['resonance', 90],
  ['character', 90]
] as const) {
  cases.push({
    name: `zipper sine, ${inlet} LFO RATE ${rate}`,
    doc: doc(
      { VOWEL: 50, CHARACTER: 50, SHIFT: 0, RESONANCE: 90 },
      { [inlet]: lfo('l', rate) },
      obj('logue/osc/sine', 'src')
    ),
    note: 57,
    kind: 'zipper'
  })
}
for (const note of [0, 127]) {
  cases.push({
    name: `fuzz noise into every inlet n${note}`,
    doc: doc(
      { VOWEL: 100, CHARACTER: 100, SHIFT: 24, RESONANCE: 100 },
      {
        vowel: obj('logue/osc/noise', 'z1'),
        shift: obj('logue/osc/noise', 'z2'),
        resonance: obj('logue/osc/noise', 'z3'),
        character: obj('logue/osc/noise', 'z4')
      },
      obj('logue/osc/noise', 'src')
    ),
    note,
    kind: 'fuzz'
  })
}

const N = 48000
const rms = (x: Float32Array): number => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length)
const maxStep = (x: Float32Array): number => {
  let m = 0
  for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]))
  return m
}
/** Energy above `hz` over the total, from a Hann-windowed DFT of the last 8192 samples. */
function highShare(x: Float32Array, hz: number): number {
  const L = 8192
  const seg = x.subarray(x.length - L)
  const w = seg.map((v, i) => v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / L)))
  let hi = 0
  let all = 0
  for (let k = 1; k < L / 2; k++) {
    let re = 0
    let im = 0
    const step = (2 * Math.PI * k) / L
    for (let i = 0; i < L; i++) {
      re += w[i] * Math.cos(step * i)
      im -= w[i] * Math.sin(step * i)
    }
    const p = re * re + im * im
    all += p
    if ((k * 48000) / L > hz) hi += p
  }
  return Math.sqrt(hi / all)
}
const dB = (g: number): string => (g === 0 ? '-inf' : (20 * Math.log10(g)).toFixed(1))

const [mode, dir] = process.argv.slice(2)
if ((mode !== '--save' && mode !== '--compare') || !dir) {
  console.error('usage: runFormantHarness.ts --save|--compare <dir>')
  process.exit(2)
}
mkdirSync(dir, { recursive: true })
let failures = 0
cases.forEach((c, i) => {
  const y = render(c.doc, N, c.note)
  const finite = y.every(Number.isFinite)
  const file = join(dir, `case${i}.f32`)
  if (mode === '--save') {
    writeFileSync(file, Buffer.from(y.buffer))
    console.log(`saved ${c.name}: rms ${dB(rms(y))} dB${finite ? '' : ' NON-FINITE'}`)
    return
  }
  if (!finite) {
    failures++
    console.log(`FAIL ${c.name}: non-finite output`)
    return
  }
  if (c.kind === 'fuzz') {
    console.log(`ok   ${c.name}: finite, peak ${Math.max(...y.map(Math.abs)).toFixed(2)}`)
    return
  }
  const b = readFileSync(file)
  const ref = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
  const diff = y.map((v, j) => v - ref[j])
  const rel = rms(diff) / rms(ref)
  const peakDiff = Math.max(...diff.map(Math.abs))
  if (c.kind === 'still') {
    const ok = rel < 1e-5
    if (!ok) failures++
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${c.name}: diff ${dB(rel)} dB re rms, peak ${peakDiff.toExponential(2)}`
    )
  } else if (c.kind === 'zipper') {
    const mine = highShare(y, 1500)
    const theirs = highShare(ref, 1500)
    const ok = mine < theirs * 1.12 || mine < 1e-3
    if (!ok) failures++
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${c.name}: above 1.5 kHz ${dB(mine)} dB (per-sample ${dB(theirs)}), diff ${dB(rel)} dB`
    )
  } else {
    const steps = `max step ${maxStep(y).toFixed(4)} (ref ${maxStep(ref).toFixed(4)})`
    const ok = maxStep(y) < maxStep(ref) * 1.1
    if (!ok) failures++
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: diff ${dB(rel)} dB re rms, ${steps}`)
  }
})
if (mode === '--compare') {
  console.log(failures ? `${failures} FAILED` : 'all passed')
  process.exit(failures ? 1 : 0)
}

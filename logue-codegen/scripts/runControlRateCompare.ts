/**
 * One-off verification for moving inputs taken to control rate (2026-10-06: `shape/drive`'s
 * `drive_ctl`, `osc/bass-support`'s `bass_ctl`): renders each case into the xd output under
 * ASan/UBSan and either saves it (`--save <dir>`, run with the per-sample version checked out)
 * or compares against the saved one (`--compare <dir>`):
 * - third-octave band levels (phase-blind: a pitch that follows an LFO 16 samples late shifts
 *   the waveform, not the spectrum) -- what an ear would hear differ;
 * - the sample difference re rms, and its energy above 1.5 kHz (where a zipper lands);
 * - `fuzz *` cases: noise into every inlet at extreme settings and notes, finite and bounded.
 * Result: every band within 0.22 dB (drive, a fast LFO on DRIVE) / 0.13 dB (bass-support).
 *
 * Usage: npx tsx logue-codegen/scripts/runControlRateCompare.ts --save|--compare <dir> [filter ...]
 */
import { execFileSync } from 'child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'
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
function render(d: PatchDocument, samples: number, note: number): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), 'lp-zip-'))
  copyFileSync(join(harnessDir, 'userosc.h'), join(dir, 'userosc.h'))
  writeFileSync(join(dir, 'osc_real.cpp'), generateOldGenOscUnit(d, { name: 'h' }).oscCpp)
  writeFileSync(
    join(dir, 'main.cpp'),
    `#include <cstdio>
#include <cstring>
#include "osc_real.cpp"
int main() { user_osc_param_t p; memset(&p, 0, sizeof(p)); p.pitch = (${note} << 8);
  OSC_INIT(0, 0); OSC_NOTEON(&p); static int32_t buf[64]; FILE *raw = fopen("out.raw", "wb");
  for (unsigned done = 0; done < ${samples}; done += 64) { OSC_CYCLE(&p, buf, 64);
    for (unsigned i = 0; i < 64; i++) { float f = q31_to_f32(buf[i]); fwrite(&f, 4, 1, raw); } }
  fclose(raw); }
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
      'h'
    ],
    { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] }
  )
  execFileSync(join(dir, 'h'), [], { cwd: dir })
  const b = readFileSync(join(dir, 'out.raw'))
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}
/** source -> (vca) -> node; LFOs into inlets. */
function chain(source: Node, node: Node, lfos: [string, number][], pre?: Node): PatchDocument {
  const nodes = [source, node, obj('logue/io/audio-out', 'out')]
  const nets = []
  if (pre) {
    nodes.push(pre)
    nets.push(net(source.name!, 'out', pre.name!, 'in'), net(pre.name!, 'out', node.name!, 'in'))
  } else nets.push(net(source.name!, 'out', node.name!, 'in'))
  nets.push(net(node.name!, 'out', 'out', 'in'))
  lfos.forEach(([inlet, rate], k) => {
    nodes.push(obj('logue/lfo/sine-lfo', `l${k}`, { RATE: rate }))
    nets.push(net(`l${k}`, 'out', node.name!, inlet))
  })
  return { nodes, nets, settings: {}, notes: '' }
}
export const CASES: Record<string, { doc: PatchDocument; note: number }> = {
  'drive sine, drive LFO 90': {
    doc: chain(
      obj('logue/osc/sine', 's'),
      obj('logue/shape/drive', 'd', { DRIVE: 50 }),
      [['drive', 90]],
      obj('logue/gain/vca', 'v', { GAIN: 12.5 })
    ),
    note: 57
  },
  'drive sine, drive LFO 40': {
    doc: chain(
      obj('logue/osc/sine', 's'),
      obj('logue/shape/drive', 'd', { DRIVE: 50 }),
      [['drive', 40]],
      obj('logue/gain/vca', 'v', { GAIN: 12.5 })
    ),
    note: 57
  },
  'drive saw, drive+tone LFOs': {
    doc: chain(
      obj('logue/osc/saw', 's'),
      obj('logue/shape/drive', 'd', { DRIVE: 60, TONE: 40 }),
      [
        ['drive', 70],
        ['tone', 50]
      ],
      obj('logue/gain/vca', 'v', { GAIN: 12.5 })
    ),
    note: 45
  },
  'bass default': {
    doc: chain(obj('logue/osc/sine', 'q'), obj('logue/osc/bass-support', 'b'), []),
    note: 48
  },
  'bass pitch LFO 60': {
    doc: chain(obj('logue/osc/sine', 'q'), obj('logue/osc/bass-support', 'b'), [['pitch', 60]]),
    note: 48
  },
  'bass drive LFO 90': {
    doc: chain(obj('logue/osc/sine', 'q'), obj('logue/osc/bass-support', 'b', { DRIVE: 60 }), [
      ['drive', 90]
    ]),
    note: 48
  },
  'bass tone LFO 90': {
    doc: chain(obj('logue/osc/sine', 'q'), obj('logue/osc/bass-support', 'b', { TONE: 50 }), [
      ['tone', 90]
    ]),
    note: 48
  },
  'fuzz bass n0': {
    doc: {
      settings: {},
      notes: '',
      nodes: [
        obj('logue/osc/bass-support', 'b', { DRIVE: 100, TONE: 100 }),
        obj('logue/io/audio-out', 'out'),
        ...['pitch', 'drive', 'tone', 'shape'].map((i) => obj('logue/osc/noise', `z${i}`))
      ],
      nets: [
        net('b', 'out', 'out', 'in'),
        ...['pitch', 'drive', 'tone', 'shape'].map((i) => net(`z${i}`, 'out', 'b', i))
      ]
    },
    note: 0
  },
  'fuzz bass n127': {
    doc: {
      nodes: [
        obj('logue/osc/bass-support', 'b', { DRIVE: 100, TONE: 100, COARSE: 24 }),
        obj('logue/io/audio-out', 'out'),
        ...['pitch', 'drive', 'tone', 'shape'].map((i) => obj('logue/osc/noise', `z${i}`))
      ],
      nets: [
        net('b', 'out', 'out', 'in'),
        ...['pitch', 'drive', 'tone', 'shape'].map((i) => net(`z${i}`, 'out', 'b', i))
      ],
      settings: {},
      notes: ''
    },
    note: 127
  },
  'fuzz drive': {
    doc: {
      nodes: [
        obj('logue/osc/noise', 'src'),
        obj('logue/shape/drive', 'd', { DRIVE: 100, TONE: 0 }),
        obj('logue/io/audio-out', 'out'),
        obj('logue/osc/noise', 'z1'),
        obj('logue/osc/noise', 'z2')
      ],
      nets: [
        net('src', 'out', 'd', 'in'),
        net('d', 'out', 'out', 'in'),
        net('z1', 'out', 'd', 'drive'),
        net('z2', 'out', 'd', 'tone')
      ],
      settings: {},
      notes: ''
    },
    note: 60
  },
  'bass all three LFOs': {
    doc: chain(obj('logue/osc/sine', 'q'), obj('logue/osc/bass-support', 'b'), [
      ['pitch', 40],
      ['drive', 70],
      ['tone', 55]
    ]),
    note: 48
  }
}
const N = 48000
const rms = (x: Float32Array): number => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length)
function hiEnergy(x: Float32Array, hz: number): number {
  const L = 8192,
    seg = x.subarray(x.length - L)
  let hi = 0
  for (let k = Math.ceil((hz * L) / 48000); k < L / 2; k++) {
    let re = 0,
      im = 0
    const st = (2 * Math.PI * k) / L
    for (let i = 0; i < L; i++) {
      const w = seg[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / L))
      re += w * Math.cos(st * i)
      im -= w * Math.sin(st * i)
    }
    hi += re * re + im * im
  }
  return hi
}
function fullEnergy(x: Float32Array): number {
  const L = 8192,
    seg = x.subarray(x.length - L)
  let e = 0
  for (let i = 0; i < L; i++) {
    const w = seg[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / L))
    e += w * w
  }
  return (e * L) / 2
}
/** Third-octave levels (dB) of the whole render, Welch-averaged over 8192-point Hann segments. */
function bands(x: Float32Array): number[] {
  const L = 8192
  const power = new Float64Array(L / 2)
  for (let start = 0; start + L <= x.length; start += L / 2) {
    for (let k = 1; k < L / 2; k++) {
      let re = 0,
        im = 0
      const st = (2 * Math.PI * k) / L
      for (let i = 0; i < L; i++) {
        const w = x[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / L))
        re += w * Math.cos(st * i)
        im -= w * Math.sin(st * i)
      }
      power[k] += re * re + im * im
    }
  }
  const out: number[] = []
  for (let f = 50; f < 16000; f *= Math.pow(2, 1 / 3)) {
    let e = 0
    for (let k = 1; k < L / 2; k++) {
      const hz = (k * 48000) / L
      if (hz >= f / Math.pow(2, 1 / 6) && hz < f * Math.pow(2, 1 / 6)) e += power[k]
    }
    out.push(10 * Math.log10(e + 1e-30))
  }
  return out
}
const [mode, dir] = process.argv.slice(2)
mkdirSync(dir, { recursive: true })
const filter = process.argv.slice(4)
for (const [name, c] of Object.entries(CASES)) {
  if (filter.length && !filter.some((f) => name.includes(f))) continue
  const y = render(c.doc, N, c.note)
  const file = join(dir, name.replace(/[^a-z0-9]+/gi, '_') + '.f32')
  if (mode === '--save') {
    writeFileSync(file, Buffer.from(y.buffer))
    console.log(
      'saved',
      name,
      'finite',
      y.every(Number.isFinite),
      'peak',
      Math.max(...Array.from(y).map(Math.abs)).toFixed(3)
    )
    continue
  }
  const b = readFileSync(file)
  const ref = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
  const diff = y.map((v, i) => v - ref[i])
  const db = (v: number): string => (v === 0 ? '-inf' : (10 * Math.log10(v)).toFixed(1))
  const bn = bands(y),
    br = bands(ref),
    top = Math.max(...br)
  const bandDiffs = bn.map((v, i) => (br[i] > top - 60 ? Math.abs(v - br[i]) : 0))
  console.log(
    `${name}: third-octave bands within 60 dB of the top differ by at most ${Math.max(...bandDiffs).toFixed(2)} dB`
  )
  console.log(
    `${name}: diff ${db((rms(diff) / rms(ref)) ** 2)} dB re rms; diff above 1.5 kHz ${db(hiEnergy(diff, 1500) / fullEnergy(ref))} dB re signal; finite ${y.every(Number.isFinite)}`
  )
}

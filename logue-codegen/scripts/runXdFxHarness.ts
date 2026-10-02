/**
 * Runs generated minilogue xd effect units (`minilogue-xd/generateFxUnit.ts`) natively under
 * ASan/UBSan, through the same hooks the device calls (harness/minilogue-xd-fx/ stands in for
 * user*fx.h and fx_api.h; the SDK's own utils/float_math.h is used as it is). Phase 7 of "effect
 * patches", 2026-09-30. The DSP body is shared with NTS-1 mkII (runNts1FxHarness.ts checks it);
 * this checks the xd shell:
 * - pass: bit-exact in place (delfx) and with separate buffers (modfx, whose unused sub-timbre
 *   buffers are copied through);
 * - knob values as Q31: Shift+Depth (id 3) at 0 is exactly dry and at full is the closed
 *   lowpass; the value 1023 (what the spike wrongly took for full scale) is still near dry;
 * - ring: a sine at the Time knob's middle sits at middle C;
 * - long-delay: NaN-filled static SDRAM cleared in init, TIME exact, a resume clears a pending
 *   echo, SYNC follows fx_get_bpmf;
 * - sense/tempo clocks at fx_get_bpmf's tempo; the example reverb stays finite and decays.
 * - reverse-wash (both versions): both sides sound and differ; at full Depth the wash dies away.
 * - freq-shift: SHIFT on the Time knob (Q31) moves a tone by the Hz the knob's position gives,
 *   through the xd's own fx_sinf stand-in.
 *
 * Usage: npx tsx logue-codegen/scripts/runXdFxHarness.ts
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'
import { generateOldGenFxUnit } from '../src/minilogue-xd/generateFxUnit'
import { parsePatchFile } from '../../src/shared/json/patchCodec'
import { exampleSubpatches, examplesDir } from './exampleSubpatches'
import { LOGUE_AUDIO_IN_TYPE, LOGUE_AUDIO_OUT_TYPE } from '../src/oscInstances'
import type { LogueModule, Net, ObjNode, PatchDocument } from '../../src/shared/domain/patch'
import type { LogueKnob, ParamValue } from '../../src/shared/domain/paramValueTypes'

const harnessDir = join(
  dirname(new URL(import.meta.url).pathname),
  '..',
  'harness',
  'minilogue-xd-fx'
)
const sdkUtils = join(
  process.env.LOGUE_SDK ?? join(homedir(), 'Documents/GitHub/logue-sdk'),
  'platform/minilogue-xd/inc/utils'
)

function obj(name: string, type: string, params: ParamValue[] = []): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params }
}
function wire(from: string, outlet: string, to: string, inlet: string): Net {
  return { sources: [{ obj: from, outlet }], dests: [{ obj: to, inlet }] }
}
function doc(module: LogueModule, nodes: ObjNode[], nets: Net[]): PatchDocument {
  return { nodes, nets, settings: { logueTarget: { module } }, notes: '' }
}
const onKnob = (knob: LogueKnob): Pick<ParamValue, 'logueKnob'> => ({
  logueKnob: { 'minilogue-xd': knob }
})
const IN = obj('in', LOGUE_AUDIO_IN_TYPE)
const OUT = obj('out', LOGUE_AUDIO_OUT_TYPE)
const pass = (module: LogueModule): PatchDocument =>
  doc(module, [IN, OUT], [wire('in', 'l', 'out', 'l'), wire('in', 'r', 'out', 'r')])

const Q31_FULL = 0x7fffffff
const Q31_HALF = 0x40000000
const TIME = 0
const DEPTH = 1
const SHIFT_DEPTH = 3

interface Run {
  inL: Float32Array
  inR: Float32Array
  outL: Float32Array
  outR: Float32Array
  /** modfx only: did the sub-timbre output get the sub input, exactly? */
  subCopied: boolean
}

const FRAMES = 48000
const FRAMES_DEFAULT = FRAMES
type Input = 'sines' | 'dc' | 'noise' | 'impulse' | 'noise-burst'

function render(
  d: PatchDocument,
  params: Array<[number, number]>,
  input: Input,
  options: {
    bpm?: number
    resumeAtFrame?: number
    subpatches?: Map<string, PatchDocument>
    frames?: number
  } = {}
): Run {
  const FRAMES = options.frames ?? FRAMES_DEFAULT
  const module = d.settings.logueTarget!.module
  const prefix = module.toUpperCase()
  const dir = mkdtempSync(join(tmpdir(), 'lp-xdfx-harness-'))
  const { fxCpp } = generateOldGenFxUnit(d, { name: 'harness' }, options.subpatches)
  writeFileSync(join(dir, 'fx.cpp'), fxCpp)
  const signal =
    input === 'dc'
      ? 'const float l = 0.5f, r = 0.5f;'
      : input === 'noise'
        ? 'seed = seed * 1664525u + 1013904223u; const float l = 0.f, r = (float)(int32_t)seed * (0.3f / 2147483648.f);'
        : input === 'impulse'
          ? 'const float l = 0.f, r = n == 100 ? 0.5f : 0.f;'
          : input === 'noise-burst'
            ? 'seed = seed * 1664525u + 1013904223u; const float r = n < 24000 ? (float)(int32_t)seed * (0.18f / 2147483648.f) : 0.f, l = r;'
            : 'const float l = 0.5f * sinf(6.2831853f * 440.f * n / 48000.f), r = 0.3f * sinf(6.2831853f * 330.f * n / 48000.f);'
  const processCall =
    module === 'modfx'
      ? `    MODFX_PROCESS(in, out, sub_in, sub_out, 64);
    for (unsigned i = 0; i < 128; ++i) if (sub_out[i] != sub_in[i]) sub_ok = 0;
`
      : `    memcpy(out, in, sizeof in);
    ${prefix}_PROCESS(out, 64);
`
  writeFileSync(
    join(dir, 'main.cpp'),
    `#include <cmath>
#include <cstdio>
#include <cstring>
float g_bpm = ${options.bpm ?? 120}.f;
#include "fx.cpp"
int main(int, char **argv) {
${fxCpp.includes('s_sdram[') ? '  // NOLOAD on the device: whatever was there. init() must clear it.\n  memset(s_sdram, 0xff, sizeof s_sdram);\n' : ''}  ${prefix}_INIT(0, 0);
${params.map(([i, v]) => `  ${prefix}_PARAM(${i}, ${v});\n`).join('')}  static float in[128], out[128], sub_in[128], sub_out[128];
  int sub_ok = 1;
  uint32_t seed = 1;
  (void)seed; (void)sub_in; (void)sub_out;
  FILE *raw = fopen(argv[1], "wb");
  for (unsigned done = 0; done < ${FRAMES}; done += 64) {
    for (unsigned i = 0; i < 64; ++i) {
      const unsigned n = done + i;
      ${signal}
      in[2 * i] = l;
      in[2 * i + 1] = r;
      sub_in[2 * i] = 0.25f * l + 0.125f;
      sub_in[2 * i + 1] = -r;
    }
${options.resumeAtFrame !== undefined ? `    if (done == ${Math.floor(options.resumeAtFrame / 64) * 64}u) { ${prefix}_SUSPEND(); ${prefix}_RESUME(); }\n` : ''}${processCall}    fwrite(in, sizeof(float), 128, raw);
    fwrite(out, sizeof(float), 128, raw);
  }
  fclose(raw);
  printf("%d\\n", sub_ok);
  return 0;
}
`
  )
  const exe = join(dir, 'fx')
  execFileSync('clang++', [
    '-std=c++17',
    '-O1',
    '-g',
    '-fsanitize=address,undefined',
    '-fno-sanitize-recover=all',
    '-Wno-unknown-attributes',
    `-I${harnessDir}`,
    `-I${sdkUtils}`,
    `-I${dir}`,
    join(dir, 'main.cpp'),
    '-o',
    exe
  ])
  const rawPath = join(dir, 'out.raw')
  const subCopied = execFileSync(exe, [rawPath]).toString().trim() === '1'
  const buf = readFileSync(rawPath)
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  const run: Run = {
    inL: new Float32Array(FRAMES),
    inR: new Float32Array(FRAMES),
    outL: new Float32Array(FRAMES),
    outR: new Float32Array(FRAMES),
    subCopied
  }
  for (let block = 0; block < FRAMES / 64; block++) {
    for (let i = 0; i < 64; i++) {
      const n = block * 64 + i
      const base = block * 256
      run.inL[n] = all[base + 2 * i]
      run.inR[n] = all[base + 2 * i + 1]
      run.outL[n] = all[base + 128 + 2 * i]
      run.outR[n] = all[base + 128 + 2 * i + 1]
    }
  }
  return run
}

const maxAbsDiff = (a: Float32Array, b: Float32Array): number => {
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]))
  return m
}
const allFinite = (r: Run): boolean =>
  [r.outL, r.outR].every((ch) => ch.every((v) => Number.isFinite(v)))
const rms = (a: Float32Array): number => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length)
const peakOf = (a: Float32Array): number => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0)

let failed = 0
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} (${detail})`)
  if (!ok) failed++
}

for (const module of ['delfx', 'revfx', 'modfx'] as const) {
  const r = render(pass(module), [], 'sines')
  const d = Math.max(maxAbsDiff(r.inL, r.outL), maxAbsDiff(r.inR, r.outR))
  check(
    `pass (${module}${module === 'modfx' ? ', separate buffers' : ', in place'}) is bit-exact`,
    d === 0 && allFinite(r) && (module !== 'modfx' || r.subCopied),
    `max diff ${d}${module === 'modfx' ? `, sub copied ${r.subCopied}` : ''}`
  )
}

{
  const LPMIX = doc(
    'delfx',
    [
      IN,
      obj('lp', 'logue/filter/lowpass-cheap', [
        { name: 'CUTOFF', value: '100', ...onKnob('time') }
      ]),
      obj('x', 'logue/mix/crossfader', [{ name: 'FADE', value: '50', ...onKnob('mix') }]),
      OUT
    ],
    [
      wire('in', 'l', 'x', 'in1'),
      wire('in', 'l', 'lp', 'in'),
      wire('lp', 'out', 'x', 'in2'),
      wire('x', 'out', 'out', 'l')
    ]
  )
  const dry = render(
    LPMIX,
    [
      [TIME, 0],
      [SHIFT_DEPTH, 0]
    ],
    'sines'
  )
  const wet = render(
    LPMIX,
    [
      [TIME, 0],
      [SHIFT_DEPTH, Q31_FULL]
    ],
    'sines'
  )
  const nearlyDry = render(
    LPMIX,
    [
      [TIME, 0],
      [SHIFT_DEPTH, 1023]
    ],
    'sines'
  )
  check(
    'Shift+Depth at Q31 0 is the dry left input',
    maxAbsDiff(dry.outL, dry.inL) < 1e-6 && allFinite(dry),
    `max diff ${maxAbsDiff(dry.outL, dry.inL)}`
  )
  check(
    'Shift+Depth at Q31 full is the closed lowpass (below -60 dB)',
    rms(wet.outL) < 1e-3 * rms(dry.inL) && allFinite(wet),
    `rms ${rms(wet.outL)}`
  )
  check(
    'Shift+Depth at 1023 is still dry (Q31, not 10-bit)',
    maxAbsDiff(nearlyDry.outL, nearlyDry.inL) < 1e-3,
    `max diff ${maxAbsDiff(nearlyDry.outL, nearlyDry.inL)}`
  )
  check(
    'an unwired R copies L',
    maxAbsDiff(dry.outL, dry.outR) === 0,
    `max diff ${maxAbsDiff(dry.outL, dry.outR)}`
  )
}

{
  const RING = doc(
    'modfx',
    [
      IN,
      obj('s', 'logue/osc/sine', [{ name: 'COARSE', value: '0', ...onKnob('time') }]),
      obj('m', 'logue/math/multiply'),
      obj('x', 'logue/mix/crossfader', [{ name: 'FADE', value: '0', ...onKnob('depth') }]),
      OUT
    ],
    [
      wire('in', 'mono', 'm', 'in1'),
      wire('s', 'out', 'm', 'in2'),
      wire('in', 'mono', 'x', 'in1'),
      wire('m', 'out', 'x', 'in2'),
      wire('x', 'out', 'out', 'l')
    ]
  )
  const r = render(
    RING,
    [
      [TIME, Q31_HALF],
      [DEPTH, Q31_FULL]
    ],
    'dc'
  )
  let crossings = 0
  for (let i = 1; i < FRAMES; i++) if (r.outL[i - 1] < 0 && r.outL[i] >= 0) crossings++
  const hz = crossings * (48000 / FRAMES)
  check(
    'ring: Time at its middle is middle C',
    Math.abs(hz - 261.63) < 2 && allFinite(r),
    `${hz} Hz`
  )
}

const WET_ONLY: ParamValue[] = [
  { name: 'FEEDBACK', value: '0' },
  { name: 'DAMPING', value: '0' },
  { name: 'MIX', value: '100' }
]
function longDelay(params: ParamValue[]): PatchDocument {
  return doc(
    'delfx',
    [IN, obj('d', 'logue/util/long-delay', params), OUT],
    [wire('in', 'r', 'd', 'in'), wire('d', 'out', 'out', 'l')]
  )
}
function echoAt(r: Run): number {
  let sum = 0
  let weight = 0
  for (let i = 101; i < FRAMES; i++) {
    sum += i * Math.abs(r.outL[i])
    weight += Math.abs(r.outL[i])
  }
  return sum / weight - 100
}

{
  const d = longDelay([{ name: 'RANGE', value: '0' }, { name: 'TIME', value: '50' }, ...WET_ONLY])
  const r = render(d, [], 'impulse')
  check(
    'long-delay: TIME exact (8191.5)',
    Math.abs(echoAt(r) - 8191.5) < 0.01,
    `echo at ${echoAt(r).toFixed(3)}`
  )
  check(
    'long-delay: NaN-filled SDRAM is cleared in init',
    allFinite(r) && peakOf(r.outL.slice(0, 8000)) === 0,
    `max before echo ${peakOf(r.outL.slice(0, 8000))}`
  )
  const resumed = render(d, [], 'impulse', { resumeAtFrame: 4096 })
  check(
    'long-delay: a resume clears a pending echo',
    peakOf(resumed.outL.slice(4096)) === 0 && allFinite(resumed),
    `max after resume ${peakOf(resumed.outL.slice(4096))}`
  )
  const synced = render(
    longDelay([{ name: 'SYNC', value: '100' }, { name: 'DIVISION', value: '5' }, ...WET_ONLY]),
    [],
    'impulse',
    { bpm: 100 }
  )
  check(
    'long-delay: SYNC follows fx_get_bpmf (1/4 at 100 BPM = 28800)',
    Math.abs(echoAt(synced) - 28800) < 0.01,
    `echo at ${echoAt(synced).toFixed(3)}`
  )
}

{
  const r = render(
    doc(
      'modfx',
      [IN, obj('t', 'logue/sense/tempo', [{ name: 'DIVISION', value: '2' }]), OUT],
      [wire('t', 'clock', 'out', 'l')]
    ),
    [],
    'dc',
    { bpm: 100 }
  )
  const clocks: number[] = []
  r.outL.forEach((v, i) => v === 1 && clocks.push(i))
  const gaps = clocks.slice(1).map((c, i) => c - clocks[i])
  check(
    'tempo: clocks 1/8 apart at fx_get_bpmf (14400)',
    clocks.length === 3 && gaps.every((g) => g === 14400),
    `clocks at ${clocks.join(', ')}`
  )
}

{
  const reverbDoc = parsePatchFile(
    readFileSync(
      join(harnessDir, '..', '..', '..', 'examples', 'effects', 'stereo-reverb.loguepatch'),
      'utf-8'
    )
  )
  const r = render(reverbDoc, [[SHIFT_DEPTH, Q31_FULL]], 'noise-burst')
  const windows = [0, 1, 2, 3].map((k) =>
    rms(r.outL.slice(24000 + k * 4800, 24000 + (k + 1) * 4800))
  )
  check(
    'reverb example: wet (Shift+Depth full) is finite and its tail decays',
    allFinite(r) && peakOf(r.outL) < 0.6 && windows.every((w, k) => k === 0 || w < windows[k - 1]),
    `peak ${peakOf(r.outL).toFixed(3)}, tail rms ${windows.map((w) => w.toFixed(4)).join(' > ')}`
  )
}

/** Amplitude of the `hz` component from `from`, Blackman-Harris windowed (as in runNts1FxHarness). */
function toneAmp(a: Float32Array, hz: number, from = 4800): number {
  let re = 0
  let im = 0
  let wsum = 0
  const len = a.length - from
  for (let k = 0; k < len; k++) {
    const x = (2 * Math.PI * k) / (len - 1)
    const w =
      0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x)
    const t = (2 * Math.PI * hz * (from + k)) / 48000
    re += a[from + k] * w * Math.cos(t)
    im -= a[from + k] * w * Math.sin(t)
    wsum += w
  }
  return (2 * Math.hypot(re, im)) / wsum
}

{
  // Time at 3/4 = SHIFT 50 = 2000 * 0.5^3 = 250 Hz: the right input's 330 Hz goes to 580 Hz on
  // shifted and 80 Hz on mirror.
  const SHIFTER = doc(
    'modfx',
    [
      IN,
      obj('f', 'logue/util/freq-shift', [{ name: 'SHIFT', value: '0', ...onKnob('time') }]),
      OUT
    ],
    [wire('in', 'r', 'f', 'in'), wire('f', 'shifted', 'out', 'l'), wire('f', 'mirror', 'out', 'r')]
  )
  const r = render(SHIFTER, [[TIME, 0x60000000]], 'sines')
  const db = (x: number): number => 20 * Math.log10(x / 0.3)
  const up = toneAmp(r.outL, 580)
  const upWrong = toneAmp(r.outL, 80)
  const down = toneAmp(r.outR, 80)
  const downWrong = toneAmp(r.outR, 580)
  check(
    'freq-shift: Time at 3/4 shifts 330 Hz to 580 (shifted) and 80 (mirror)',
    Math.abs(db(up)) < 0.1 &&
      Math.abs(db(down)) < 0.1 &&
      db(upWrong) < -40 &&
      db(downWrong) < -40 &&
      allFinite(r),
    `shifted ${db(up).toFixed(2)} dB (other ${db(upWrong).toFixed(1)}), mirror ${db(down).toFixed(2)} dB (other ${db(downWrong).toFixed(1)})`
  )
}

// grain-mill's xd units (one per clock mode): finite, and both sides sound once grains have
// fired (voice 2, right, reads ~1 s back, hence the longer render). Free/random at full Time (20 Hz); the synced ones at Time 0 (a 1/16 at 120 BPM), since
// a whole bar wouldn't tick within the render.
for (const mode of ['free', 'sync', 'rnd', 'rndsync']) {
  const d = parsePatchFile(
    readFileSync(join(examplesDir, `grain-mill-xd-${mode}.loguepatch`), 'utf-8')
  )
  const synced = mode.endsWith('sync')
  const r = render(
    d,
    [
      [TIME, synced ? 0 : 0x7fffffff],
      [DEPTH, Math.round(0.75 * 0x7fffffff)],
      [SHIFT_DEPTH, 0x7fffffff]
    ],
    'noise',
    // Voice 2 reads ~1 s back: the render has to outlast that.
    { subpatches: exampleSubpatches(), frames: 120000 }
  )
  const [lateL, lateR] = [rms(r.outL.slice(72000)), rms(r.outR.slice(72000))]
  check(
    `grain-mill xd ${mode}: finite, both sides sound`,
    allFinite(r) && Math.min(lateL, lateR) > 0.005,
    `rms after 1.5 s L/R ${lateL.toFixed(3)}/${lateR.toFixed(3)}`
  )
}

{
  // Depth at 90 %, just below the freeze, mid Time (where the loop is strongest): a half-second
  // burst keeps sounding through the feedback, but never louder than it was -- a build-up there
  // gets frozen in at 95 % (user, a real xd).
  const d = parsePatchFile(
    readFileSync(join(examplesDir, 'grain-mill-xd-free.loguepatch'), 'utf-8')
  )
  const r = render(
    d,
    [
      [TIME, Math.round(0.5 * 0x7fffffff)],
      [DEPTH, Math.round(0.9 * 0x7fffffff)],
      [SHIFT_DEPTH, 0x7fffffff]
    ],
    'noise-burst',
    { subpatches: exampleSubpatches() }
  )
  const during = rms(r.outL.slice(12000, 24000))
  const after = rms(r.outL.slice(36000))
  check(
    'grain-mill xd free: high Depth sustains a burst through feedback, without building up',
    allFinite(r) && after > 0.01 && after < 0.5 * during && peakOf(r.outL) <= 1,
    `rms during ${during.toFixed(3)}, 0.25 s after ${after.toFixed(3)}`
  )
}

for (const file of ['reverse-wash.loguepatch', 'reverse-wash-xd.loguepatch']) {
  // Noise, fully wet, mid Time; then Depth fully up on a half-second burst. Both sides sound and
  // differ, and the full-feedback wash stays bounded and goes on after the input stops.
  const d = parsePatchFile(readFileSync(join(examplesDir, file), 'utf-8'))
  const wet = render(
    d,
    [
      [TIME, Q31_HALF],
      [DEPTH, 0],
      [SHIFT_DEPTH, 0x7fffffff]
    ],
    'noise',
    { frames: 96000 }
  )
  const [l, r] = [rms(wet.outL.slice(48000)), rms(wet.outR.slice(48000))]
  const diff = rms(wet.outL.slice(48000).map((x, i) => x - wet.outR[48000 + i]))
  check(
    `${file}: finite, both sides sound and differ`,
    allFinite(wet) && Math.min(l, r) > 0.02 && diff > 0.3 * l,
    `rms L/R ${l.toFixed(3)}/${r.toFixed(3)}, L-R ${diff.toFixed(3)}`
  )
  // Full Depth on a half-second burst, then silence: the wash must die away, not hold.
  const fb = render(
    d,
    [
      [TIME, Q31_HALF],
      [DEPTH, 0x7fffffff],
      [SHIFT_DEPTH, 0x7fffffff]
    ],
    'noise-burst',
    { frames: 480000 }
  )
  const tail = [2, 3, 4, 5, 6, 7, 8, 9].map((k) =>
    Math.hypot(
      rms(fb.outL.slice(k * 48000, (k + 1) * 48000)),
      rms(fb.outR.slice(k * 48000, (k + 1) * 48000))
    )
  )
  check(
    `${file}: full Depth stays bounded and dies away after the input stops`,
    allFinite(fb) &&
      peakOf(fb.outL) < 1 &&
      peakOf(fb.outR) < 1 &&
      tail[0] > 0.001 &&
      tail.every((x, k) => k === 0 || x <= 1.05 * tail[k - 1]) &&
      tail[7] < 0.2 * tail[0],
    `peak ${Math.max(peakOf(fb.outL), peakOf(fb.outR)).toFixed(3)}, rms per second from 2 s ${tail.map((x) => x.toFixed(4)).join(' ')}`
  )
}

// GM_SWEEP=1: grain-mill xd free's wet level after a burst, over Time, at Depth 90 %.
if (process.env.GM_SWEEP) {
  const d = parsePatchFile(
    readFileSync(join(examplesDir, 'grain-mill-xd-free.loguepatch'), 'utf-8')
  )
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const r = render(
      d,
      [
        [TIME, Math.round(t * 0x7fffffff)],
        [DEPTH, Math.round(0.9 * 0x7fffffff)],
        [SHIFT_DEPTH, 0x7fffffff]
      ],
      'noise-burst',
      { subpatches: exampleSubpatches() }
    )
    console.log(
      `GM time ${t}: during ${rms(r.outL.slice(12000, 24000)).toFixed(3)} after ${rms(r.outL.slice(36000)).toFixed(3)} peak ${peakOf(r.outL).toFixed(3)}`
    )
  }
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)

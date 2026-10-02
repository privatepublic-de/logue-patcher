/**
 * Measures every primitive's minilogue xd CPU cost on the emulator and writes
 * `src/cpuCostTable.ts`. A primitive's cost is its WORST variant -- alone, with every inlet wired
 * (one util/constant each), with each checkbox flipped, and for granular (two) and the multistage
 * envelope (one) their documented costliest settings -- minus a unit that's just one constant (the fixed per-unit overhead,
 * stored as the baseline). Each entry records a hash of the primitive's xd codegen snapshot, so
 * `logue-cpuCostTable.spec.ts` fails once the generated code changes without a re-measure.
 *
 * Usage (slow, ~1 build + emulator run per variant):
 *   EMU_PYTHON=<python with unicorn/capstone/pyelftools> npx tsx measureCpuCosts.ts [id ...]
 * With ids, only those entries are re-measured and the rest of the table is kept.
 */
import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { findLoguePrimitive, recognizedLoguePrimitiveIds } from '../src/primitives'
import { findBooleanWidget } from '../src/paramTrackGate'
import { LOGUE_AUDIO_OUT_TYPE } from '../src/oscInstances'
import { CPU_COST_TABLE, CPU_COST_BASELINE_CYCLES } from '../src/cpuCostTable'
import { measure as measureJob, type MeasureJob, type MeasureResult } from './measureXdCycles'
import { bytesToBase64 } from '../src/sample/base64'
import { mulawEncode } from '../src/sample/mulaw'
import type { Net, ObjNode, PatchDocument } from '../../src/shared/domain/patch'

const here = dirname(new URL(import.meta.url).pathname)

/** One reused staging folder, rather than a folder per variant in the user's SDK checkout. */
const measure = (job: MeasureJob): MeasureResult => measureJob({ ...job, dir: 'lp-measure-cpu' })
const repo = join(here, '..', '..')

export function snapshotHash(id: string): string {
  const file = join(
    repo,
    'test',
    '__snapshots__',
    'primitives',
    `${id.slice('logue/'.length).replace('/', '.')}.minilogue-xd.txt`
  )
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
}

/** 4K samples of noise at 16 kHz, stored the way the primitive's import stores it. */
function sample(kind: 'granular' | 'plain'): ObjNode['sample'] {
  const bytes = new Uint8Array(4096)
  let seed = 12345
  for (let i = 0; i < bytes.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const x = (seed / 0x7fffffff) * 1.6 - 0.8
    bytes[i] = kind === 'plain' ? Math.round(x * 127) & 0xff : mulawEncode(x)
  }
  if (kind === 'granular') {
    return { sourceName: 'noise', rate: 16000, encoding: 'mulaw8', data: bytesToBase64(bytes) }
  }
  // Looped (and played with LOOP on, see `unit`), so no variant can end up measuring a finished
  // one-shot's silence; a sustained loop is also the costlier, common case.
  return {
    sourceName: 'noise',
    rate: 16000,
    encoding: 'pcm8',
    data: bytesToBase64(bytes),
    loopStart: 0,
    loopEnd: bytes.length
  }
}

/** `audio`: wire only the audio-role inlets (a filter's input); `all`: every inlet. */
function unit(
  id: string,
  params: Array<{ name: string; value: string }>,
  wire: 'none' | 'audio' | 'all'
): PatchDocument {
  const p = findLoguePrimitive(id)!
  const node: ObjNode = { kind: 'obj', type: id, name: 'n', x: 0, y: 0, params }
  if (p.sampleImport) node.sample = sample(p.sampleImport)
  if (p.sampleImport === 'plain' && !params.some((v) => v.name === 'LOOP')) {
    node.params = [...params, { name: 'LOOP', value: '1' }]
  }
  const nets: Net[] = [
    {
      sources: [{ obj: 'n', outlet: p.outlets?.[0]?.name ?? 'out' }],
      dests: [{ obj: 'out', inlet: 'in' }]
    }
  ]
  const constants: ObjNode[] = []
  if (wire !== 'none') {
    for (const inlet of p.inlets ?? []) {
      if (wire === 'audio' && inlet.role !== 'audio') continue
      constants.push({
        kind: 'obj',
        type: 'logue/util/constant',
        name: `c_${inlet.name}`,
        x: 0,
        y: 0,
        params: [{ name: 'VALUE', value: '37' }]
      })
      nets.push({
        sources: [{ obj: `c_${inlet.name}`, outlet: 'out' }],
        dests: [{ obj: 'n', inlet: inlet.name }]
      })
    }
  }
  return {
    nodes: [
      node,
      ...constants,
      { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
    ],
    nets,
    settings: {},
    notes: ''
  }
}

/**
 * The variants the estimator picks between (keyed `base`, `control`, `<CHECKBOX>`,
 * `<CHECKBOX>+control`): audio inputs always wired, control inputs free or wired, each checkbox
 * at its default or flipped. `heavy-*` variants (granular's two documented costliest settings)
 * only feed the worst case.
 */
function variants(id: string): Array<MeasureJob & { key: string }> {
  const p = findLoguePrimitive(id)!
  const tag = id.replace(/\W/g, '_')
  const hasControl = (p.inlets ?? []).some((i) => i.role === 'control')
  const jobs: Array<MeasureJob & { key: string }> = [
    { key: 'base', name: `${tag}-base`, doc: unit(id, [], 'audio') }
  ]
  if (hasControl) jobs.push({ key: 'control', name: `${tag}-control`, doc: unit(id, [], 'all') })
  for (const spec of p.params ?? []) {
    if (!findBooleanWidget(id, spec.name)) continue
    const flipped = [{ name: spec.name, value: spec.default >= 50 ? '0' : '100' }]
    jobs.push({ key: spec.name, name: `${tag}-${spec.name}`, doc: unit(id, flipped, 'audio') })
    if (hasControl) {
      jobs.push({
        key: `${spec.name}+control`,
        name: `${tag}-${spec.name}-control`,
        doc: unit(id, flipped, 'all')
      })
    }
  }
  if (id === 'logue/util/quantize') {
    // A fast-moving input (noise) misses the fast path and searches the scale every sample.
    const doc = unit(id, [], 'none')
    doc.nodes.push({ kind: 'obj', type: 'logue/osc/noise', name: 'src', x: 0, y: 0, params: [] })
    doc.nets.push({ sources: [{ obj: 'src', outlet: 'out' }], dests: [{ obj: 'n', inlet: 'in' }] })
    jobs.push({ key: 'heavy-moving-input', name: `${tag}-moving`, doc })
  }
  if (id === 'logue/osc/phase-dist') {
    // WAVE/WAVE2 are selects, which `variants` doesn't vary: a resonance wave at full DCW, line
    // 1+2, and DCW and the pitch from a moving source (the per-sample coefficient path, LFO
    // included) with line 1+2 on.
    const reso = [
      { name: 'WAVE', value: '7' },
      { name: 'DCW', value: '100' }
    ]
    jobs.push({ key: 'heavy-reso', name: `${tag}-reso`, doc: unit(id, reso, 'audio') })
    const line = [...reso, { name: 'WAVE2', value: '1' }]
    jobs.push({ key: 'heavy-wave2', name: `${tag}-wave2`, doc: unit(id, line, 'audio') })
    const doc = unit(id, line, 'audio')
    doc.nodes.push({ kind: 'obj', type: 'logue/lfo/sine-lfo', name: 'src', x: 0, y: 0, params: [] })
    doc.nets.push({
      sources: [{ obj: 'src', outlet: 'out' }],
      dests: [
        { obj: 'n', inlet: 'dcw' },
        { obj: 'n', inlet: 'pitch' }
      ]
    })
    jobs.push({ key: 'heavy-moving-dcw', name: `${tag}-moving`, doc })
  }
  if (id === 'logue/env/one-knob-adsr') {
    // SHAPE from a moving source takes the control-rate path (knob_env_step_ctl) -- a constant
    // wired in is hoisted to a block value and doesn't. The LFO's own cost is included.
    const doc = unit(id, [], 'none')
    doc.nodes.push({ kind: 'obj', type: 'logue/lfo/sine-lfo', name: 'src', x: 0, y: 0, params: [] })
    doc.nets.push({
      sources: [{ obj: 'src', outlet: 'out' }],
      dests: [{ obj: 'n', inlet: 'shape' }]
    })
    jobs.push({ key: 'heavy-moving-shape', name: `${tag}-moving`, doc })
  }
  if (id === 'logue/env/multistage') {
    // Cycle mode with short stages: always running, and a stage change every few ms.
    const cycling = [
      { name: 'MODE', value: '3' },
      { name: 'HOLD', value: '5' },
      ...[1, 2, 3, 4, 5, 6].map((n) => ({ name: `T${n}`, value: '8' }))
    ]
    jobs.push({ key: 'heavy-cycle', name: `${tag}-cycle`, doc: unit(id, cycling, 'all') })
  }
  if (id === 'logue/osc/sample') {
    const bouncing = [
      { name: 'LOOP', value: '2' },
      { name: 'REVERSE', value: '100' }
    ]
    jobs.push({
      key: 'heavy-pingpong-reverse',
      name: `${tag}-pingpong-reverse`,
      doc: unit(id, bouncing, 'all')
    })
  }
  if (id === 'logue/osc/granular') {
    const sizeWindow = [
      { name: 'SIZE', value: '100' },
      { name: 'WINDOW', value: '100' }
    ]
    jobs.push({
      key: 'heavy-size-window-100',
      name: `${tag}-size-window-100`,
      doc: unit(id, sizeWindow, 'all')
    })
    const freeDense = [
      { name: 'SYNC', value: '0' },
      { name: 'DENSITY', value: '100' },
      { name: 'SIZE', value: '100' }
    ]
    jobs.push({
      key: 'heavy-sync-off-density-100',
      name: `${tag}-sync-off-density-100`,
      doc: unit(id, freeDense, 'all')
    })
  }
  return jobs
}

const only = process.argv.slice(2)
const baseline = measure({
  name: 'baseline-constant',
  doc: unit('logue/util/constant', [], 'none')
}).cyclesPerSample
console.log(`baseline ${baseline.toFixed(0)}`)
type Entry = { variants: Record<string, number>; worst: number; snapshotHash: string }
const table: Record<string, Entry> = only.length ? { ...CPU_COST_TABLE } : {}
const failures: string[] = []
for (const id of recognizedLoguePrimitiveIds()) {
  if (only.length && !only.includes(id)) continue
  const p = findLoguePrimitive(id)!
  if (p.platforms && !p.platforms.includes('minilogue-xd')) continue
  if (p.modules && !p.modules.includes('osc')) continue
  const measured: Record<string, number> = {}
  for (const job of variants(id)) {
    try {
      measured[job.key] = Math.max(0, Math.round(measure(job).cyclesPerSample - baseline))
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? String(err)
      const why = /undefined reference to `(\w+)'/.exec(stderr)?.[1]
      failures.push(`${job.name}: ${why ? `link error, undefined ${why}` : stderr.split('\n')[0]}`)
    }
  }
  if (Object.keys(measured).length === 0) continue
  table[id] = {
    variants: measured,
    worst: Math.max(...Object.values(measured)),
    snapshotHash: snapshotHash(id)
  }
  console.log(`${id.padEnd(32)} ${JSON.stringify(measured)}`)
}

const out = join(here, '..', 'src', 'cpuCostTable.ts')
const base = only.length && existsSync(out) ? CPU_COST_BASELINE_CYCLES : Math.round(baseline)
const body = Object.keys(table)
  .sort()
  .map(
    (id) =>
      `  '${id}': ${JSON.stringify(table[id])
        .replace(/"(\w+)":/g, '$1: ')
        .replace(/"/g, "'")}`
  )
  .join(',\n')
writeFileSync(
  out,
  `// GENERATED by scripts/measureCpuCosts.ts -- do not edit by hand; re-run it instead.
// Emulator estimates (scripts/emulateXdCycles.py) of minilogue xd cycles per voice-sample, on the
// emulator's own scale -- not hardware measurements. See estimateOscCpuCost.ts.

/** The fixed per-unit overhead: a unit that's just one util/constant. */
export const CPU_COST_BASELINE_CYCLES = ${base}

/**
 * Cycles per voice-sample above the baseline, per primitive (xd only), per measured variant:
 * \`base\` (audio inputs wired, control inputs free), \`control\` (every inlet wired), \`<CHECKBOX>\`
 * and \`<CHECKBOX>+control\` (that checkbox flipped); \`heavy-*\` are extra worst-case settings.
 * \`worst\` is the largest of them.
 */
export const CPU_COST_TABLE: Record<
  string,
  { variants: Record<string, number>; worst: number; snapshotHash: string }
> = {
${body}
}
`
)
console.log(`wrote ${out}`)
if (failures.length) {
  console.log(`\n${failures.length} variant(s) failed to build:\n  ${failures.join('\n  ')}`)
  process.exitCode = 1
}

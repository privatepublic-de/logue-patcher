/**
 * What the CPU measuring scripts share: the measured variants of a primitive (`measureCpuCosts.ts`
 * for oscillators, `measureXdFxCpuCosts.ts` for effects), each built by the caller's own unit
 * shape, and the snapshot hash that marks an entry stale.
 */
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { findLoguePrimitive } from '../src/primitives'
import { findBooleanWidget } from '../src/paramTrackGate'
import { LOGUE_AUDIO_OUT_TYPE } from '../src/oscInstances'
import type { MeasureJob } from './measureXdCycles'
import { bytesToBase64 } from '../src/sample/base64'
import { mulawEncode } from '../src/sample/mulaw'
import type { Net, ObjNode, PatchDocument } from '../../src/shared/domain/patch'

const here = dirname(new URL(import.meta.url).pathname)
const repo = join(here, '..', '..')

/** A one-primitive unit around node `n`: `audio` wires only its audio-role inlets, `all` every
 *  inlet, `none` nothing. */
export type UnitBuilder = (
  id: string,
  params: Array<{ name: string; value: string }>,
  wire: 'none' | 'audio' | 'all'
) => PatchDocument

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
export function sample(kind: 'granular' | 'plain'): ObjNode['sample'] {
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
export function oscUnit(
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
export function variants(id: string, unit: UnitBuilder): Array<MeasureJob & { key: string }> {
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
  if (id === 'logue/osc/noise') {
    // COLOR is a select: White is `base`, each coloured noise its own heavy case.
    ;['pink', 'brown', 'violet'].forEach((name, k) => {
      const color = [{ name: 'COLOR', value: String(k + 1) }]
      jobs.push({ key: `heavy-${name}`, name: `${tag}-${name}`, doc: unit(id, color, 'audio') })
    })
  }
  if (id === 'logue/osc/lfsr') {
    // MODE Short (a select) reads the table instead of stepping the register.
    const short = [{ name: 'MODE', value: '1' }]
    jobs.push({ key: 'heavy-short', name: `${tag}-short`, doc: unit(id, short, 'audio') })
    jobs.push({
      key: 'heavy-short-control',
      name: `${tag}-short-control`,
      doc: unit(id, short, 'all')
    })
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
  if (id === 'logue/util/grain') {
    // Capturing all the time (a buffer read and a table write a sample, against looping's one
    // read): the longest grain, retriggered while the last is still recording -- what
    // grain-mill's busy voices do. With every inlet wired, the effect script's slow clock
    // triggers it once and its 1.4 s capture lasts the whole measured window.
    jobs.push({
      key: 'heavy-capturing',
      name: `${tag}-capturing`,
      doc: unit(id, [{ name: 'SIZE', value: '100' }], 'all')
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

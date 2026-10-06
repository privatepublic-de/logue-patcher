/**
 * Measures every effect-usable primitive's minilogue xd CPU cost in an EFFECT unit on the emulator
 * (`emulateXdFxCycles.py`) and writes `src/fxCpuCostTable.ts` -- the effect counterpart of
 * `measureCpuCosts.ts`, with the same variants (`cpuVariants.ts`).
 *
 * What differs from the oscillator table:
 * - Each unit is a delfx: audio-in's mono into the primitive's audio inlets, all its outlets
 *   summed to L (R copies it): an unread outlet is dead code. modfx/delfx/revfx differ only in the shell, so the per-module baselines are
 *   measured separately (the same graph without the primitive).
 * - Control inlets are wired from audio-in's mono too, not from a util/constant: a constant is
 *   per-block, so the reader's hoisted path would be measured instead of the per-sample one a
 *   moving source (an LFO, a follower) takes. `control-still` measures that hoisted path too
 *   (constants into the control inlets), for a reader fed by a knob or knob-only math.
 * - Every variant is stored as `cycles` at SDRAM_PENALTY 0 plus `sdram`, the SDRAM accesses per
 *   sample: cycles at any penalty are `cycles + penalty * sdram`, so the unknown cost of an SDRAM
 *   access stays a constant of the estimator, not of the table.
 * - Every variant is measured with one, two and three instances: `first` (the one), `extra`
 *   (the third minus the second: what each further instance adds) and `shared` (the second's
 *   cost beyond an `extra`, paid once when a unit has two or more). GCC inlines code with one
 *   caller and shares it between several: a chain of util/long-delays cost 118 cycles for one,
 *   +179 for the second and ~147 for each after that. Counting only `first` read an 8-comb
 *   reverb 17 % low; counting the second's 179 for every further one read it 15 % high. The
 *   further instances share the first one's inputs (the clock, a test source, a buffer writer)
 *   and are summed by a math/add into R. Every node that is only there to measure (partners,
 *   the clock, the adds) is measured on its own and subtracted (`overhead`).
 * - Buffer primitives can't be built alone (a writer needs a reader, a reader a writer:
 *   `bufferPartners.ts`). The partners' own costs are measured first and subtracted, so a
 *   patch's buffer + tap counts each once: a tap's `extra` is a writer with two taps minus one
 *   with one, a writer's two independent pairs minus a writer with two taps; their `first`s
 *   only exist together (the pair), split in proportion to the `extra`s.
 * - A `trig`/`gate` inlet is fed a square LFO (subtracted the same way), since the test noise
 *   never reaches a gate's threshold.
 * - Cycles are per sample of the one unit: an effect runs once, not per voice.
 *
 * Usage (slow, 3 builds + emulator runs per variant):
 *   EMU_PYTHON=<python with unicorn/capstone/pyelftools> npx tsx measureXdFxCpuCosts.ts [id ...]
 * With ids, only those entries are re-measured and the rest of the table is kept.
 * Env: as `measureXdFxCycles.ts`.
 */
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import {
  findLoguePrimitive,
  isBufferOutlet,
  recognizedLoguePrimitiveIds,
  type LoguePrimitive
} from '../src/primitives'
import { LOGUE_AUDIO_IN_TYPE, LOGUE_AUDIO_OUT_TYPE } from '../src/oscInstances'
import type { LogueEffectModule, Net, ObjNode, PatchDocument } from '../../src/shared/domain/patch'
import { FX_CPU_COST_TABLE, FX_CPU_DOES_NOT_FIT } from '../src/fxCpuCostTable'
import { bufferPartners } from './bufferPartners'
import { sample, snapshotHash, variants, type UnitBuilder } from './cpuVariants'
import { measureXdFx, TooBigError, type FxCycles } from './measureXdFxCycles'

const here = dirname(new URL(import.meta.url).pathname)
const repo = join(here, '..', '..')

type Cost = FxCycles

function obj(name: string, type: string, params: ObjNode['params'] = []): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params }
}
function wire(from: { obj: string; outlet: string }, to: string, inlet: string): Net {
  return { sources: [from], dests: [{ obj: to, inlet }] }
}
const MONO = { obj: 'in', outlet: 'mono' }

function fxDoc(module: LogueEffectModule, nodes: ObjNode[], nets: Net[]): PatchDocument {
  return {
    nodes: [obj('in', LOGUE_AUDIO_IN_TYPE), ...nodes, obj('out', LOGUE_AUDIO_OUT_TYPE)],
    nets,
    settings: { logueTarget: { module } },
    notes: ''
  }
}

/** The shell alone: audio-in's mono to L, like every measured unit around its primitive. */
const baselineDoc = (module: LogueEffectModule): PatchDocument =>
  fxDoc(module, [], [wire(MONO, 'out', 'l')])

/**
 * A gate inlet (`trig`/`gate`) fed the emulator's +-0.3 noise would never read high (>= 0.5), so
 * a util/grain would sit idle and an envelope closed: in `all` they get a square LFO instead,
 * whose own cost is taken off like a buffer partner's.
 */
const GATE_INLETS = new Set(['trig', 'gate'])
const CLOCK = 'clk'

const fxUnit: UnitBuilder = (id, params, wireMode) => {
  const p = findLoguePrimitive(id)!
  const node = obj('n', id, params)
  if (p.sampleImport) node.sample = sample(p.sampleImport)
  if (p.sampleImport === 'plain' && !params.some((v) => v.name === 'LOOP')) {
    node.params = [...params, { name: 'LOOP', value: '1' }]
  }
  const partners = bufferPartners(p, 'n', MONO)
  const nodes = [node]
  const nets: Net[] = []
  for (const inlet of p.inlets ?? []) {
    // A buffer inlet is always fed: without its writer the unit doesn't build.
    const wanted =
      inlet.role === 'buffer' ||
      (wireMode === 'audio' && inlet.role === 'audio') ||
      wireMode === 'all' ||
      wireMode === 'still'
    if (!wanted) continue
    if (wireMode === 'still' && inlet.role === 'control') {
      // A per-block value, as a knob or knob-only math feeds it (hoisted: no per-sample cost).
      const name = `c_${inlet.name}`
      nodes.push(obj(name, 'logue/util/constant', [{ name: 'VALUE', value: '37' }]))
      nets.push(wire({ obj: name, outlet: 'out' }, 'n', inlet.name))
    } else if (inlet.role === 'control' && GATE_INLETS.has(inlet.name)) {
      if (!nodes.some((n) => n.name === CLOCK)) nodes.push(obj(CLOCK, 'logue/lfo/square-lfo'))
      nets.push(wire({ obj: CLOCK, outlet: 'out' }, 'n', inlet.name))
    } else {
      nets.push(wire(partners.sourceFor(inlet), 'n', inlet.name))
    }
  }
  const allNodes = [...nodes, ...partners.nodes]
  const allNets = [...partners.nets, ...nets]
  const output = outputOf(p, 'n', partners.output, allNodes, allNets)
  return fxDoc('delfx', allNodes, [...allNets, wire(output, 'out', 'l')])
}

type Endpoint = { obj: string; outlet: string }
const ADD_PREFIX = 'o_'

/**
 * Instance `name`'s outlets summed into one endpoint (math/adds named `o_<name>_<k>`), its first
 * one being `first`. Every outlet is read: one left unread is dead code to GCC -- util/reverse-tap
 * measured on head `a` alone lost head `b`'s buffer read and window, ~37 cycles of reverse-wash.
 */
function outputOf(
  p: LoguePrimitive,
  name: string,
  first: Endpoint,
  nodes: PatchDocument['nodes'],
  nets: Net[]
): Endpoint {
  let sum = first
  for (const [k, outlet] of (p.outlets ?? []).slice(1).entries()) {
    const add = `${ADD_PREFIX}${name}_${k}`
    nodes.push(obj(add, 'logue/math/add'))
    nets.push(wire(sum, add, 'a'))
    nets.push(wire({ obj: name, outlet: outlet.name }, add, 'b'))
    sum = { obj: add, outlet: 'out' }
  }
  return sum
}

/**
 * `doc` with `count` instances of its node `n`: `n2`, `n3` take the same inlets from the same
 * sources, and their outputs (`outputOf`, the first through its own tap when that's a buffer
 * outlet) are summed into R -- `n2` twice when it's the only one, so two and three instances
 * differ by one instance and nothing else.
 */
function withInstances(doc: PatchDocument, id: string, count: 2 | 3): PatchDocument {
  const p = findLoguePrimitive(id)!
  const n = doc.nodes.find((node) => node.name === 'n') as ObjNode
  const added = count === 2 ? ['n2'] : ['n2', 'n3']
  const nets: Net[] = doc.nets.map((net) => ({
    ...net,
    dests: [
      ...net.dests,
      ...added.flatMap((name) =>
        net.dests.filter((d) => d.obj === 'n').map((d) => ({ obj: name, inlet: d.inlet }))
      )
    ]
  }))
  const nodes = [...doc.nodes, ...added.map((name) => ({ ...structuredClone(n), name }))]
  const outlet = p.outlets?.[0]?.name ?? 'out'
  const outputs = added.map((name) => {
    let first: Endpoint = { obj: name, outlet }
    if (isBufferOutlet(p, outlet)) {
      nodes.push(obj(`${name}${TAP_SUFFIX}`, 'logue/util/buffer-tap'))
      nets.push(wire(first, `${name}${TAP_SUFFIX}`, 'buf'))
      first = { obj: `${name}${TAP_SUFFIX}`, outlet: 'out' }
    }
    return outputOf(p, name, first, nodes, nets)
  })
  nodes.push(obj(SUM, 'logue/math/add'))
  nets.push(wire(outputs[0], SUM, 'a'))
  nets.push(wire(outputs[outputs.length - 1], SUM, 'b'))
  nets.push(wire({ obj: SUM, outlet: 'out' }, 'out', 'r'))
  return { ...doc, nodes, nets }
}
const TAP_SUFFIX = '_tap'
const SUM = 'sum'

/** One reused staging folder, rather than a folder per variant in the user's SDK checkout. */
const measure = (doc: PatchDocument): Cost => measureXdFx(doc, 'lp-measure-fxcpu')

const minus = (a: Cost, ...b: Cost[]): Cost => ({
  cycles: b.reduce((sum, c) => sum - c.cycles, a.cycles),
  sdram: b.reduce((sum, c) => sum - c.sdram, a.sdram)
})
const scaled = (c: Cost, cycles: number, sdram: number): Cost => ({
  cycles: c.cycles * cycles,
  sdram: c.sdram * sdram
})
const rounded = (c: Cost): Cost => ({
  cycles: Math.max(0, Math.round(c.cycles)),
  sdram: Math.max(0, Math.round(c.sdram * 10) / 10)
})
/** For `shared`, which a few cycles of noise can make slightly negative. */
const signedRounded = (c: Cost): Cost => ({
  cycles: Math.round(c.cycles),
  sdram: Math.round(c.sdram * 10) / 10
})

/** The unit shell the table was measured in (the xd fx goldens), as `measureCodeSizes.ts`. */
function fxShellHash(): string {
  const fx = join(repo, 'test', '__snapshots__', 'fx')
  const hash = createHash('sha256')
  for (const f of readdirSync(fx)
    .filter((f) => f.endsWith('.minilogue-xd.txt'))
    .sort())
    hash.update(readFileSync(join(fx, f)))
  return hash.digest('hex').slice(0, 16)
}

type Variant = { first: Cost; shared: Cost; extra: Cost }
type Entry = { variants: Record<string, Variant>; snapshotHash: string }
const out = join(here, '..', 'src', 'fxCpuCostTable.ts')
const only = process.argv.slice(2)
const previous: Record<string, Entry> = only.length ? FX_CPU_COST_TABLE : {}

const baselines = {} as Record<LogueEffectModule, Cost>
for (const module of ['modfx', 'delfx', 'revfx'] as const) {
  baselines[module] = measure(baselineDoc(module))
  console.log(`baseline ${module.padEnd(6)} ${JSON.stringify(rounded(baselines[module]))}`)
}
const shell = baselines.delfx

/** `pairs` writers, each with `taps` taps; the first pair's tap to L, every other one to R. */
const writerTaps = (pairs: number, taps: number): PatchDocument => {
  const nodes: ObjNode[] = []
  const nets: Net[] = []
  for (let w = 0; w < pairs; w++) {
    nodes.push(obj(`w${w}`, 'logue/util/buffer'))
    nets.push(wire(MONO, `w${w}`, 'in'))
    for (let t = 0; t < taps; t++) {
      nodes.push(obj(`w${w}t${t}`, 'logue/util/buffer-tap'))
      nets.push(wire({ obj: `w${w}`, outlet: 'buf' }, `w${w}t${t}`, 'buf'))
      nets.push(wire({ obj: `w${w}t${t}`, outlet: 'out' }, 'out', w + t === 0 ? 'l' : 'r'))
    }
  }
  return fxDoc('delfx', nodes, nets)
}
const pair = measure(writerTaps(1, 1))
const writerTwoTaps = measure(writerTaps(1, 2))
const tapExtra = minus(writerTwoTaps, pair)
const writerExtra = minus(measure(writerTaps(2, 1)), writerTwoTaps)
const pairFirst = minus(pair, shell)
const share = (tap: number, writer: number): number =>
  tap + writer > 0 ? tap / (tap + writer) : 0.5
const tapFirst = scaled(
  pairFirst,
  share(tapExtra.cycles, writerExtra.cycles),
  share(tapExtra.sdram, writerExtra.sdram)
)
const partners = {
  tap: { first: tapFirst, extra: tapExtra },
  writer: { first: minus(pairFirst, tapFirst), extra: writerExtra },
  clock: {
    first: minus(
      measure(
        fxDoc(
          'delfx',
          [obj(CLOCK, 'logue/lfo/square-lfo')],
          [wire({ obj: CLOCK, outlet: 'out' }, 'out', 'l')]
        )
      ),
      shell
    )
  }
}
for (const [name, cost] of Object.entries(partners)) {
  console.log(
    `partner ${name.padEnd(6)} first ${JSON.stringify(rounded(cost.first))}` +
      ('extra' in cost ? ` extra ${JSON.stringify(rounded(cost.extra))}` : '')
  )
}
/** The math/add that sums the further instances into R, measured as one in the same place. */
const sumCost = minus(
  measure(
    fxDoc(
      'delfx',
      [obj(SUM, 'logue/math/add')],
      [
        wire(MONO, 'out', 'l'),
        wire(MONO, SUM, 'a'),
        wire(MONO, SUM, 'b'),
        wire({ obj: SUM, outlet: 'out' }, 'out', 'r')
      ]
    )
  ),
  shell
)
/** One of `outputOf`'s adds, between a value and the output. */
const addCost = minus(
  measure(
    fxDoc(
      'delfx',
      [obj(`${ADD_PREFIX}x`, 'logue/math/add')],
      [
        wire(MONO, `${ADD_PREFIX}x`, 'a'),
        wire(MONO, `${ADD_PREFIX}x`, 'b'),
        wire({ obj: `${ADD_PREFIX}x`, outlet: 'out' }, 'out', 'l')
      ]
    )
  ),
  shell
)
console.log(`sum            ${JSON.stringify(rounded(sumCost))}`)
console.log(`output add     ${JSON.stringify(rounded(addCost))}`)

/** What a measured unit spends on nodes that are there only to measure (`fxUnit`'s partners and
 *  clock, `outputOf`'s adds, `withInstances`' taps and sum). */
function overhead(doc: PatchDocument): Cost {
  const costs = doc.nodes.flatMap((node): Cost[] => {
    const name = node.name ?? ''
    if (name === 'n_buf') return [partners.writer.first]
    if (name === 'n_tap') return [partners.tap.first]
    if (name.endsWith(TAP_SUFFIX)) return [partners.tap.extra]
    if (name === CLOCK) return [partners.clock.first]
    if (name === SUM) return [sumCost]
    if (name.startsWith(ADD_PREFIX)) return [addCost]
    return []
  })
  return costs.reduce((sum, c) => ({ cycles: sum.cycles + c.cycles, sdram: sum.sdram + c.sdram }), {
    cycles: 0,
    sdram: 0
  })
}
console.log(`sum            ${JSON.stringify(rounded(sumCost))}`)

const table: Record<string, Entry> = { ...previous }
const doesNotFit: Record<string, string> = only.length ? { ...FX_CPU_DOES_NOT_FIT } : {}
const failures: string[] = []
const tooBig: string[] = []
for (const id of recognizedLoguePrimitiveIds()) {
  if (only.length && !only.includes(id)) continue
  const p = findLoguePrimitive(id)!
  if (p.supersededBy) continue
  if (p.platforms && !p.platforms.includes('minilogue-xd')) continue
  if (p.modules && !p.modules.includes('delfx')) continue
  const measured: Record<string, Variant> = {}
  let overflowed = false
  for (const job of variants(id, fxUnit, { still: true })) {
    try {
      const twoDoc = withInstances(job.doc, id, 2)
      const threeDoc = withInstances(job.doc, id, 3)
      const [one, two, three] = [job.doc, twoDoc, threeDoc].map((d) =>
        minus(measure(d), overhead(d))
      )
      const extra = minus(three, two)
      measured[job.key] = {
        first: rounded(minus(one, shell)),
        shared: signedRounded(minus(two, one, extra)),
        extra: rounded(extra)
      }
    } catch (err) {
      if (err instanceof TooBigError) {
        tooBig.push(`${job.name}: ${err.message}`)
        overflowed = true
        continue
      }
      failures.push(`${job.name}: ${(err as Error).message}`)
    }
  }
  if (Object.keys(measured).length === 0) {
    if (overflowed) {
      doesNotFit[id] = snapshotHash(id)
      delete table[id]
    }
    continue
  }
  delete doesNotFit[id]
  table[id] = { variants: measured, snapshotHash: snapshotHash(id) }
  console.log(`${id.padEnd(32)} ${JSON.stringify(measured)}`)
}
rmSync(
  join(
    process.env.LOGUE_SDK ?? join(homedir(), 'Documents/GitHub/logue-sdk'),
    'platform',
    'minilogue-xd',
    'lp-measure-fxcpu'
  ),
  { recursive: true, force: true }
)

const literal = (v: unknown): string =>
  JSON.stringify(v)
    .replace(/"([\w+-]+)":/g, (_, k: string) => (/^\w+$/.test(k) ? `${k}: ` : `'${k}': `))
    .replace(/"/g, "'")
const body = Object.keys(table)
  .sort()
  .map((id) => `  '${id}': ${literal(table[id])}`)
  .join(',\n')
writeFileSync(
  out,
  `// GENERATED by scripts/measureXdFxCpuCosts.ts -- do not edit by hand; re-run it instead.
// Emulator estimates (scripts/emulateXdFxCycles.py) of minilogue xd EFFECT cycles per sample, on
// the emulator's own scale -- not hardware measurements.

/** Cycles per sample at SDRAM_PENALTY 0, plus the SDRAM accesses per sample: at a penalty of p
 *  cycles per access the cost is \`cycles + p * sdram\`. */
export interface FxCpuCost {
  cycles: number
  sdram: number
}

/** The unit shell alone (audio-in's mono to the output), per effect module. */
export const FX_CPU_BASELINE: Record<'modfx' | 'delfx' | 'revfx', FxCpuCost> = ${literal(
    Object.fromEntries(Object.entries(baselines).map(([k, v]) => [k, rounded(v)]))
  )}

/** The xd fx goldens the table was measured against (\`fxShellHash\`). */
export const FX_CPU_SHELL_HASH = '${fxShellHash()}'

/** Primitives no delfx can hold (its SRAM overflowed in every variant), with the snapshot hash
 *  they were built from: they have no entry, and a codegen change may make them fit. */
export const FX_CPU_DOES_NOT_FIT: Record<string, string> = ${literal(
    Object.fromEntries(
      Object.keys(doesNotFit)
        .sort()
        .map((id) => [id, doesNotFit[id]])
    )
  )}

/**
 * Per primitive, above the delfx baseline, per measured variant (\`cpuVariants.ts\`: \`base\`,
 * \`control\` -- control inlets fed a moving signal --, \`<CHECKBOX>\`, \`<CHECKBOX>+control\`,
 * \`heavy-*\`): \`first\` for a unit's first instance of the primitive, \`extra\` for each further
 * one, and \`shared\` once when there are two or more (GCC inlines code with one caller and
 * shares it between several). A buffer writer's or reader's partner (\`bufferPartners.ts\`) is
 * subtracted.
 */
export const FX_CPU_COST_TABLE: Record<
  string,
  {
    variants: Record<string, { first: FxCpuCost; shared: FxCpuCost; extra: FxCpuCost }>
    snapshotHash: string
  }
> = {
${body}
}
`
)
execFileSync('npx', ['prettier', '--write', out], { cwd: repo, stdio: 'ignore' })
console.log(`wrote ${out}`)
if (tooBig.length) {
  console.log(`\n${tooBig.length} variant(s) don't fit a delfx's SRAM:\n  ${tooBig.join('\n  ')}`)
}
if (failures.length) {
  console.log(`\n${failures.length} variant(s) failed:\n  ${failures.join('\n  ')}`)
  process.exitCode = 1
}

/**
 * Measures every primitive's code size in real ARM builds and writes `src/codeSizeTable.ts`
 * (2026-09-30, for the RAM estimate: code shares the unit's memory with state on both devices,
 * and on a minilogue xd effect it is most of it).
 *
 * Per context (platform x oscillator/effect -- the effect shell compiles pitch-reading primitives
 * differently, `fxShared.ts`' stand-ins), three builds, each summed through one `math/add` into
 * the output so every instance stays active:
 *   base: add(src, src);   one: add(p1, src);   two: add(p1, p2)
 * where every inlet of each instance is wired from `src` (a `util/constant` in an oscillator,
 * `audio-in`'s mono outlet in a delay effect). `first` = one - base and `extra` = two - one, in
 * code bytes (text + rodata + data), minus the tables the estimate already counts
 * (`HelperBlock.sharedBytes`, read through `estimateOscStateCost` so it's the same number). The
 * bss deltas are checked against `stateBytesPerInstance`. Every kind's `fixedCodeBytes` baseline
 * is measured too: a constant into the output (oscillators), a pass-through (effects).
 *
 * A buffer primitive is measured with its partner (`bufferPartners.ts`: a writer with a tap
 * reading it, a buffer inlet fed by a writer), so a writer and a tap together are counted about
 * twice -- a few hundred bytes over, the safe side.
 *
 * The xd builds link with an enlarged SRAM region, so a primitive bigger than the real one can
 * still be sized (additive's tables in an xd effect).
 *
 * Usage: npx tsx logue-codegen/scripts/measureCodeSizes.ts   (~5 min, parallel builds)
 */
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { findLoguePrimitive, recognizedLoguePrimitiveIds } from '../src/primitives'
import { LOGUE_AUDIO_IN_TYPE, LOGUE_AUDIO_OUT_TYPE } from '../src/oscInstances'
import { build, gccBin, platformRoot } from './codeSizeBuild'
import { bufferPartners } from './bufferPartners'
import { estimateOscStateCost } from '../src/estimateOscStateCost'
import { UNIT_KINDS } from '../src/unitKinds'
import { bytesToBase64 } from '../src/sample/base64'
import { mulawEncode } from '../src/sample/mulaw'
import type {
  LogueModule,
  LoguePlatform,
  Net,
  ObjNode,
  PatchDocument
} from '../../src/shared/domain/patch'

const here = dirname(new URL(import.meta.url).pathname)
const repo = join(here, '..', '..')
const WORKERS = 8

/** The unit's own methods and hooks: present in the base unit, but GCC may inline one there
 *  and emit it out of line once a primitive makes it bigger -- that growth is the primitive's. */
const SHELL_METHOD =
  /^(Osc|Fx)::(init|reset|process|setParameter|noteOn|noteOff|setKnob|setPitch|setTempo|setSenseInputs|setShapeParam|setShape2Sense|updateShapeSense|getBufferSize|teardown|resume|suspend)\b|^(unit_|_hook_|OSC_|MODFX_|DELFX_|REVFX_)/

type Context = 'minilogue-xd:osc' | 'minilogue-xd:fx' | 'nts1mkii:osc' | 'nts1mkii:fx'
const CONTEXTS: Context[] = ['minilogue-xd:osc', 'minilogue-xd:fx', 'nts1mkii:osc', 'nts1mkii:fx']
const platformOf = (c: Context): LoguePlatform => c.split(':')[0] as LoguePlatform
/** Effects are measured in a delay: modfx/delfx/revfx differ only in the shell. */
const moduleOf = (c: Context): LogueModule => (c.endsWith(':fx') ? 'delfx' : 'osc')

function node(type: string, name: string, params: ObjNode['params'] = []): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params }
}
function wire(from: string, outlet: string, to: string, inlet: string): Net {
  return { sources: [{ obj: from, outlet }], dests: [{ obj: to, inlet }] }
}

/** 4K samples of noise at 16 kHz, stored the way the primitive's import stores it; at note 60
 *  `logue/osc/sample` reads a third of a stored sample per output sample, so it keeps playing. */
function sample(kind: 'granular' | 'plain'): ObjNode['sample'] {
  const bytes = new Uint8Array(4096)
  let seed = 12345
  for (let i = 0; i < bytes.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const x = (seed / 0x7fffffff) * 1.6 - 0.8
    bytes[i] = kind === 'plain' ? Math.round(x * 127) & 0xff : mulawEncode(x)
  }
  const encoding = kind === 'plain' ? 'pcm8' : 'mulaw8'
  return { sourceName: 'noise', rate: 16000, encoding, data: bytesToBase64(bytes) }
}

/** `count` instances of `id` (0 = the base build), summed into the output. */
function measuredDoc(
  context: Context,
  id: string | undefined,
  count: 0 | 1 | 2,
  wired = true
): PatchDocument {
  const module = moduleOf(context)
  const fx = module !== 'osc'
  const nodes: ObjNode[] = [
    fx
      ? node(LOGUE_AUDIO_IN_TYPE, 'src')
      : node('logue/util/constant', 'src', [{ name: 'VALUE', value: '37' }]),
    node('logue/math/add', 'sum'),
    node(LOGUE_AUDIO_OUT_TYPE, 'out')
  ]
  const srcOutlet = fx ? 'mono' : 'out'
  const nets: Net[] = [wire('sum', 'out', 'out', fx ? 'l' : 'in')]
  const sumInlets = ['a', 'b']
  for (let i = 0; i < 2; i++) {
    if (i >= count || !id) {
      nets.push(wire('src', srcOutlet, 'sum', sumInlets[i]))
      continue
    }
    const p = findLoguePrimitive(id)!
    const name = `p${i + 1}`
    const n = node(id, name)
    if (p.sampleImport) n.sample = sample(p.sampleImport)
    const partners = bufferPartners(p, name, { obj: 'src', outlet: srcOutlet })
    if (wired)
      for (const inlet of p.inlets ?? []) {
        const from = partners.sourceFor(inlet)
        nets.push(wire(from.obj, from.outlet, name, inlet.name))
      }
    nodes.push(n, ...partners.nodes)
    nets.push(...partners.nets)
    nets.push(wire(partners.output.obj, partners.output.outlet, 'sum', sumInlets[i]))
  }
  return { nodes, nets, settings: { logueTarget: { module } }, notes: '' }
}

function passDoc(module: LogueModule): PatchDocument {
  if (module === 'osc') {
    return {
      nodes: [node('logue/util/constant', 'c'), node(LOGUE_AUDIO_OUT_TYPE, 'out')],
      nets: [wire('c', 'out', 'out', 'in')],
      settings: { logueTarget: { module } },
      notes: ''
    }
  }
  return {
    nodes: [node(LOGUE_AUDIO_IN_TYPE, 'in'), node(LOGUE_AUDIO_OUT_TYPE, 'out')],
    nets: [wire('in', 'l', 'out', 'l'), wire('in', 'r', 'out', 'r')],
    settings: { logueTarget: { module } },
    notes: ''
  }
}

/** What the estimate already counts as tables for this document. */
function tableBytes(context: Context, d: PatchDocument): number {
  const est = estimateOscStateCost(d, platformOf(context))
  if (est.status !== 'ok') throw new Error(est.reason)
  return est.estimate.sharedHelpers.reduce((sum, h) => sum + h.bytes, 0)
}

function snapshotHash(id: string, platform: LoguePlatform): string {
  const file = join(
    repo,
    'test',
    '__snapshots__',
    'primitives',
    `${id.slice('logue/'.length).replace('/', '.')}.${platform}.txt`
  )
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
}

/**
 * The unit shell each context was measured in: the fx goldens for an effect, util/constant's
 * (a whole oscillator around one trivial node) for an oscillator. A per-primitive hash can't see
 * a shell change, which moves every entry of the context. Same rule as the spec's.
 */
export function shellHash(context: Context): string {
  const platform = platformOf(context)
  const snapshots = join(repo, 'test', '__snapshots__')
  const files = context.endsWith(':fx')
    ? readdirSync(join(snapshots, 'fx'))
        .filter((f) => f.endsWith(`.${platform}.txt`))
        .sort()
        .map((f) => join(snapshots, 'fx', f))
    : [join(snapshots, 'primitives', `util.constant.${platform}.txt`)]
  const hash = createHash('sha256')
  for (const file of files) hash.update(readFileSync(file))
  return hash.digest('hex').slice(0, 16)
}

function usable(id: string, context: Context): boolean {
  const p = findLoguePrimitive(id)!
  const platform = platformOf(context)
  const module = moduleOf(context)
  if (p.platforms && !p.platforms.includes(platform)) return false
  return !p.modules || p.modules.includes(module)
}

/** Runs `jobs` with `WORKERS` builds at a time, each worker in its own staging folder. */
async function runAll<T>(jobs: Array<(dir: string) => Promise<T>>): Promise<T[]> {
  const results: T[] = new Array(jobs.length)
  let next = 0
  const dirs = Array.from({ length: WORKERS }, (_, i) =>
    join(platformRoot, 'PLATFORM', `lp-measure-code-${i}`)
  )
  await Promise.all(
    dirs.map(async (template) => {
      while (next < jobs.length) {
        const i = next++
        results[i] = await jobs[i](template)
      }
    })
  )
  return results
}

interface Job {
  context: Context
  id?: string
  count: 0 | 1 | 2
  wired: boolean
}

const jobs: Job[] = []
for (const context of CONTEXTS) {
  jobs.push({ context, count: 0, wired: true })
  for (const id of recognizedLoguePrimitiveIds()) {
    if (!usable(id, context)) continue
    jobs.push({ context, id, count: 1, wired: true }, { context, id, count: 2, wired: true })
    if (findLoguePrimitive(id)!.inlets?.length) {
      jobs.push({ context, id, count: 1, wired: false }, { context, id, count: 2, wired: false })
    }
  }
}
const kinds = UNIT_KINDS.map((k) => ({ platform: k.platform, module: k.module }))

interface Variant {
  first: number
  extra: number
  helpers: string[]
}
interface Built {
  code: number
  bss: number
  tables: number
  functions: Map<string, number>
}

const problems: string[] = []
const helperBytes: Record<string, Record<string, number>> = {}

function measureVariant(
  context: Context,
  id: string,
  base: Built,
  one: Built,
  two: Built,
  wired: boolean
): Variant {
  // Functions this primitive brings that the base unit lacks: out-of-line helpers (and libm
  // routines), shared with any other primitive calling them -- tabled once, not in `first`.
  const helpers = [...one.functions.entries()].filter(
    ([name]) => !base.functions.has(name) && !SHELL_METHOD.test(name)
  )
  helperBytes[context] ??= {}
  for (const [name, bytes] of helpers) {
    helperBytes[context][name] = Math.max(helperBytes[context][name] ?? 0, bytes)
  }
  const first =
    one.code -
    one.tables -
    (base.code - base.tables) -
    helpers.reduce((sum, [, bytes]) => sum + bytes, 0)
  const extra = two.code - two.tables - (one.code - one.tables)
  const tag = `${context} ${id}${wired ? '' : ' unwired'}`
  if (first < 0 || extra < 0) problems.push(`${tag}: negative code (${first}, ${extra})`)
  // A buffer partner's own state comes along (`bufferPartners`).
  const p = findLoguePrimitive(id)!
  const partners = bufferPartners(p, 'p', { obj: 'src', outlet: 'out' })
  if (wired) for (const inlet of p.inlets ?? []) partners.sourceFor(inlet)
  const state = [p, ...partners.nodes.map((n) => findLoguePrimitive(n.type)!)].reduce(
    (sum, q) => sum + q.stateBytesPerInstance,
    0
  )
  const bss1 = one.bss - base.bss
  const bss2 = two.bss - one.bss
  // bss rounds to 8-byte alignment on the xd; flag only a clear disagreement.
  if (Math.abs(bss1 - state) > 8 || Math.abs(bss2 - state) > 8) {
    problems.push(`${tag}: bss +${bss1}/+${bss2} vs stateBytesPerInstance ${state}`)
  }
  return {
    first: Math.max(0, first),
    extra: Math.max(0, extra),
    helpers: helpers.map(([name]) => name).sort()
  }
}

async function main(): Promise<void> {
  const started = Date.now()
  const sized = await runAll(
    jobs.map((job) => async (template: string) => {
      const platform = platformOf(job.context)
      const dir = template.replace(
        'PLATFORM',
        platform === 'nts1mkii' ? 'nts-1_mkii' : 'minilogue-xd'
      )
      const d = measuredDoc(job.context, job.id, job.count, job.wired)
      try {
        const size = await build(dir, platform, d)
        return { ...size, tables: tableBytes(job.context, d) }
      } catch (e) {
        const out = [
          (e as { stdout?: string }).stdout,
          (e as { stderr?: string }).stderr,
          String(e)
        ]
          .filter(Boolean)
          .join('\n')
        return {
          error:
            out
              .split('\n')
              .filter((l) => /error/i.test(l))
              .slice(0, 2)
              .join(' | ') || out.slice(0, 300)
        }
      }
    })
  )
  const baselines = await runAll(
    kinds.map((k) => async (template: string) => {
      const dir = template.replace(
        'PLATFORM',
        k.platform === 'nts1mkii' ? 'nts-1_mkii' : 'minilogue-xd'
      )
      const size = await build(dir, k.platform, passDoc(k.module))
      return size.code + size.bss
    })
  )
  for (const platform of ['nts-1_mkii', 'minilogue-xd']) {
    for (let i = 0; i < WORKERS; i++) {
      rmSync(join(platformRoot, platform, `lp-measure-code-${i}`), { recursive: true, force: true })
    }
  }

  type Sized =
    | { code: number; bss: number; tables: number; functions: Map<string, number> }
    | { error: string }
  const byKey = new Map<string, Sized>()
  jobs.forEach((job, i) =>
    byKey.set(`${job.context}|${job.id ?? ''}|${job.count}|${job.wired}`, sized[i])
  )
  const table: Record<
    string,
    Record<string, Variant & { unwired?: Variant; snapshotHash: string }>
  > = {}
  for (const context of CONTEXTS) {
    table[context] = {}
    helperBytes[context] ??= {}
    const base = byKey.get(`${context}||0|true`)!
    if ('error' in base) throw new Error(`${context} base build failed: ${base.error}`)
    for (const id of recognizedLoguePrimitiveIds()) {
      if (!usable(id, context)) continue
      const variant = (wired: boolean): Variant | undefined => {
        const one = byKey.get(`${context}|${id}|1|${wired}`)
        const two = byKey.get(`${context}|${id}|2|${wired}`)
        if (!one || !two) return undefined
        if ('error' in one || 'error' in two) {
          const error = 'error' in one ? one.error : (two as { error: string }).error
          problems.push(`${context} ${id}${wired ? '' : ' unwired'}: ${error}`)
          return undefined
        }
        return measureVariant(context, id, base as Built, one, two, wired)
      }
      const wiredVariant = variant(true)
      if (!wiredVariant) continue
      const unwiredVariant = variant(false)
      table[context][id] = {
        ...wiredVariant,
        ...(unwiredVariant ? { unwired: unwiredVariant } : {}),
        snapshotHash: snapshotHash(id, platformOf(context))
      }
    }
  }

  const gccVersion = execFileSync(join(gccBin, 'arm-none-eabi-gcc'), ['-dumpversion'])
    .toString()
    .trim()
  const baselineLines = kinds
    .map((k, i) => `  '${k.platform}:${k.module}': ${baselines[i]},`)
    .join('\n')
  const entries = CONTEXTS.map(
    (context) =>
      `  '${context}': {\n` +
      Object.entries(table[context])
        .map(
          ([id, e]) =>
            `    '${id}': { first: ${e.first}, extra: ${e.extra}, helpers: ${JSON.stringify(e.helpers)}${e.unwired ? `, unwired: ${JSON.stringify(e.unwired)}` : ''}, snapshotHash: '${e.snapshotHash}' },`
        )
        .join('\n') +
      '\n  },'
  ).join('\n')
  const helperEntries = CONTEXTS.map(
    (context) =>
      `  '${context}': {\n` +
      Object.entries(helperBytes[context])
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, bytes]) => `    ${JSON.stringify(name)}: ${bytes},`)
        .join('\n') +
      '\n  },'
  ).join('\n')

  const out = `// GENERATED by scripts/measureCodeSizes.ts -- do not edit by hand; re-run it instead.
// Measured with arm-none-eabi-gcc ${gccVersion} (-Os): another compiler version gives other sizes.

/** What an otherwise empty unit of each kind loads (code + data + bss): a constant into the
 *  output for an oscillator, a pass-through for an effect. */
export const CODE_BASELINE_BYTES: Record<string, number> = {
${baselineLines}
}

export interface CodeSize {
  first: number
  extra: number
  helpers: string[]
}

export type CodeSizeContext = 'minilogue-xd:osc' | 'minilogue-xd:fx' | 'nts1mkii:osc' | 'nts1mkii:fx'

/**
 * Code bytes (text + rodata + data; tables the estimate counts as \`sharedBytes\` excluded) per
 * primitive and context, all inlets wired (\`unwired\`: none, where it has inlets): \`first\` for the first instance, \`extra\` for each
 * further one, and the out-of-line functions it brings (\`helpers\`, sized in
 * \`CODE_HELPER_BYTES\`), which a unit carries once however many primitives call them.
 */
export const CODE_SIZE_TABLE: Record<
  CodeSizeContext,
  Record<string, CodeSize & { unwired?: CodeSize; snapshotHash: string }>
> = {
${entries}
}

/** The unit shell each context was measured in (\`shellHash\`, measureCodeSizes.ts). */
export const CODE_SHELL_HASH: Record<CodeSizeContext, string> = {
${CONTEXTS.map((c) => `  '${c}': '${shellHash(c)}',`).join('\n')}
}

/** Bytes of each out-of-line function (demangled name) per context. */
export const CODE_HELPER_BYTES: Record<CodeSizeContext, Record<string, number>> = {
${helperEntries}
}
`
  const outPath = join(here, '..', 'src', 'codeSizeTable.ts')
  writeFileSync(outPath, out)
  execFileSync('npx', ['prettier', '--write', outPath], { cwd: repo, stdio: 'ignore' })
  console.log(
    `${jobs.length + kinds.length} builds in ${Math.round((Date.now() - started) / 1000)} s`
  )
  console.log(kinds.map((k, i) => `${k.platform}:${k.module} ${baselines[i]}`).join('\n'))
  console.log(problems.length ? `\nproblems:\n${problems.join('\n')}` : '\nno problems')
}

void main()

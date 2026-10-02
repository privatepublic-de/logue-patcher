import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findLoguePrimitive, recognizedLoguePrimitiveIds } from '../logue-codegen/src/primitives'
import {
  CODE_BASELINE_BYTES,
  CODE_HELPER_BYTES,
  CODE_SHELL_HASH,
  CODE_SIZE_TABLE,
  type CodeSizeContext
} from '../logue-codegen/src/codeSizeTable'
import { UNIT_KINDS } from '../logue-codegen/src/unitKinds'
import type { LoguePlatform } from '../src/shared/domain/patch'

const RE_MEASURE = 'npx tsx logue-codegen/scripts/measureCodeSizes.ts'
const CONTEXTS: CodeSizeContext[] = [
  'minilogue-xd:osc',
  'minilogue-xd:fx',
  'nts1mkii:osc',
  'nts1mkii:fx'
]

function snapshotHash(id: string, platform: LoguePlatform): string {
  const file = join(
    import.meta.dirname,
    '__snapshots__',
    'primitives',
    `${id.slice('logue/'.length).replace('/', '.')}.${platform}.txt`
  )
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
}

/** measureCodeSizes.ts' `shellHash`: the unit shell a context was measured in. */
function shellHash(context: CodeSizeContext): string {
  const platform = context.split(':')[0]
  const snapshots = join(import.meta.dirname, '__snapshots__')
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

function usableIn(id: string, context: CodeSizeContext): boolean {
  const p = findLoguePrimitive(id)!
  const [platform, where] = context.split(':') as [LoguePlatform, 'osc' | 'fx']
  if (p.platforms && !p.platforms.includes(platform)) return false
  return !p.modules || p.modules.includes(where === 'osc' ? 'osc' : 'delfx')
}

/** Like the CPU table: re-measuring needs the ARM toolchain and a logue-sdk checkout, and
 *  `npm run build` runs these tests, so a stale entry warns; `CODE_SIZE_STRICT=1` fails. */
function reportTableProblem(what: string, items: string[]): void {
  if (items.length === 0) return
  const message = `Code size table: ${what}: ${items.join(', ')} -- re-measure with: ${RE_MEASURE}`
  if (process.env.CODE_SIZE_STRICT === '1') throw new Error(message)
  console.warn(message)
}

describe('code size table', () => {
  it('has an entry for every primitive in every context it can build in (warns if not)', () => {
    const missing = CONTEXTS.flatMap((context) =>
      recognizedLoguePrimitiveIds()
        .filter((id) => usableIn(id, context) && !CODE_SIZE_TABLE[context][id])
        .map((id) => `${id} (${context})`)
    )
    reportTableProblem('no entry for', missing)
  })

  it('was measured against the current generated code (warns if not)', () => {
    const stale = CONTEXTS.flatMap((context) =>
      Object.entries(CODE_SIZE_TABLE[context])
        .filter(
          ([id, e]) =>
            findLoguePrimitive(id) &&
            e.snapshotHash !== snapshotHash(id, context.split(':')[0] as LoguePlatform)
        )
        .map(([id]) => `${id} (${context})`)
    )
    reportTableProblem('measured against older generated code', [...new Set(stale)])
  })

  it('was measured in the current unit shells (warns if not)', () => {
    reportTableProblem(
      'measured in an older unit shell, context',
      CONTEXTS.filter((context) => CODE_SHELL_HASH[context] !== shellHash(context))
    )
  })

  it('sizes every helper it names, and has a baseline for every unit kind', () => {
    for (const context of CONTEXTS) {
      for (const entry of Object.values(CODE_SIZE_TABLE[context])) {
        for (const helper of [...entry.helpers, ...(entry.unwired?.helpers ?? [])]) {
          expect(CODE_HELPER_BYTES[context][helper], `${context} ${helper}`).toBeGreaterThan(0)
        }
      }
    }
    for (const kind of UNIT_KINDS) {
      expect(CODE_BASELINE_BYTES[`${kind.platform}:${kind.module}`]).toBeGreaterThan(
        kind.fixedBaselineBytes
      )
    }
  })
})

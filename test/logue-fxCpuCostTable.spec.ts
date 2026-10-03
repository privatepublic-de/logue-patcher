import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { findLoguePrimitive, recognizedLoguePrimitiveIds } from '../logue-codegen/src/primitives'
import {
  FX_CPU_BASELINE,
  FX_CPU_COST_TABLE,
  FX_CPU_DOES_NOT_FIT,
  FX_CPU_SHELL_HASH
} from '../logue-codegen/src/fxCpuCostTable'

const MEASURE = 'EMU_PYTHON=<venv python> npx tsx logue-codegen/scripts/measureXdFxCpuCosts.ts'

function xdSnapshotHash(id: string): string {
  const file = join(
    import.meta.dirname,
    '__snapshots__',
    'primitives',
    `${id.slice('logue/'.length).replace('/', '.')}.minilogue-xd.txt`
  )
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
}

/** measureXdFxCpuCosts.ts' `fxShellHash`: the xd fx goldens the table was measured in. */
function fxShellHash(): string {
  const fx = join(import.meta.dirname, '__snapshots__', 'fx')
  const hash = createHash('sha256')
  for (const f of readdirSync(fx)
    .filter((f) => f.endsWith('.minilogue-xd.txt'))
    .sort())
    hash.update(readFileSync(join(fx, f)))
  return hash.digest('hex').slice(0, 16)
}

/** The ids measureXdFxCpuCosts.ts measures: every current primitive an xd delay effect can use. */
const fxIds = recognizedLoguePrimitiveIds().filter((id) => {
  const p = findLoguePrimitive(id)!
  if (p.supersededBy) return false
  if (p.platforms && !p.platforms.includes('minilogue-xd')) return false
  return !p.modules || p.modules.includes('delfx')
})

/**
 * Like the oscillator table's spec: a missing or stale entry only warns, since re-measuring needs
 * the ARM toolchain, a logue-sdk checkout and the emulator venv, and `npm run build` runs these
 * tests. `CPU_COST_STRICT=1` (the same switch) makes them fail.
 */
function reportTableProblem(message: string | undefined): void {
  if (message === undefined) return
  if (process.env.CPU_COST_STRICT === '1') throw new Error(`Effect CPU table: ${message}`)
  console.warn(`Effect CPU table: ${message}`)
}

const forIds = (what: string, ids: string[]): string | undefined =>
  ids.length ? `${what}: ${ids.join(', ')} -- re-measure with: ${MEASURE} <id>` : undefined

describe('effect CPU cost table', () => {
  it('has an entry (or a "does not fit") for every primitive an xd effect can use (warns if not)', () => {
    reportTableProblem(
      forIds(
        'no entry for',
        fxIds.filter((id) => !FX_CPU_COST_TABLE[id] && !FX_CPU_DOES_NOT_FIT[id])
      )
    )
    expect(FX_CPU_BASELINE.delfx.cycles).toBeGreaterThan(0)
  })

  it('was measured against the current generated code (warns if not)', () => {
    reportTableProblem(
      forIds(
        'measured against older generated code',
        fxIds.filter((id) => {
          const hash = FX_CPU_COST_TABLE[id]?.snapshotHash ?? FX_CPU_DOES_NOT_FIT[id]
          return hash !== undefined && hash !== xdSnapshotHash(id)
        })
      )
    )
  })

  it('was measured in the current effect shell (warns if not)', () => {
    // A shell change moves every entry, which no per-primitive hash sees.
    reportTableProblem(
      FX_CPU_SHELL_HASH === fxShellHash()
        ? undefined
        : `measured in an older effect shell (the xd fx goldens changed) -- re-measure the whole table: ${MEASURE}`
    )
  })

  it('has no entry for a primitive an xd effect cannot use', () => {
    const usable = new Set(fxIds)
    expect(
      [...Object.keys(FX_CPU_COST_TABLE), ...Object.keys(FX_CPU_DOES_NOT_FIT)].filter(
        (id) => !usable.has(id)
      )
    ).toEqual([])
  })

  it('stores every variant as first/shared/extra, with SDRAM accesses never negative', () => {
    for (const [id, entry] of Object.entries(FX_CPU_COST_TABLE)) {
      for (const [key, v] of Object.entries(entry.variants)) {
        for (const part of [v.first, v.extra]) {
          expect(part.cycles, `${id} ${key}`).toBeGreaterThanOrEqual(0)
          expect(part.sdram, `${id} ${key}`).toBeGreaterThanOrEqual(0)
        }
        expect(Number.isFinite(v.shared.cycles), `${id} ${key}`).toBe(true)
      }
    }
  })
})

/**
 * `fxCpuCostTable.ts` against whole units: every example effect built for the minilogue xd and run
 * on the emulator, next to the table's sum for the same patch (`estimateFxCpuCost`). Prints both at
 * SDRAM_PENALTY 0 and 8, the SDRAM accesses, `max` (moving inputs at their heavy cases) and the
 * error band. A miss to chase goes to `profileFxUnit.ts`.
 *
 * Usage: EMU_PYTHON=<python with unicorn/capstone/pyelftools> npx tsx checkFxCpuEstimate.ts
 */
import { readFileSync, readdirSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { FxCpuCost } from '../src/fxCpuCostTable'
import { parsePatchFile } from '../../src/shared/json/patchCodec'
import { estimateFxCpuCost, fxCycles } from '../src/estimateFxCpuCost'
import { exampleSubpatches, examplesDir } from './exampleSubpatches'
import { measureXdFx, TooBigError } from './measureXdFxCycles'

const DIR = 'lp-measure-fxcheck'

const subpatches = exampleSubpatches()
const errors: number[] = []
console.log(
  `${'example'.padEnd(30)} ${'whole p0'.padStart(8)} ${'table p0'.padStart(8)} ${'whole p8'.padStart(8)} ${'table p8'.padStart(8)} ${'max p8'.padStart(7)}  sdram whole/table/max  error p8`
)
for (const file of readdirSync(examplesDir)
  .filter((f) => f.endsWith('.loguepatch'))
  .sort()) {
  const doc = parsePatchFile(readFileSync(join(examplesDir, file), 'utf-8'))
  let whole: FxCpuCost
  try {
    whole = measureXdFx(doc, DIR, subpatches)
  } catch (err) {
    console.log(
      `${file.padEnd(30)} ${err instanceof TooBigError ? `doesn't fit (${err.message})` : (err as Error).message}`
    )
    continue
  }
  const result = estimateFxCpuCost(doc, subpatches)
  if (result.status !== 'ok') {
    console.log(`${file.padEnd(30)} ${result.reason}`)
    continue
  }
  const { sum, max, unmeasured: missing } = result.estimate
  const error = fxCycles(sum, 8) / fxCycles(whole, 8) - 1
  errors.push(error)
  const n = (v: number, w: number): string => v.toFixed(0).padStart(w)
  console.log(
    `${file.padEnd(30)} ${n(fxCycles(whole, 0), 8)} ${n(fxCycles(sum, 0), 8)} ${n(fxCycles(whole, 8), 8)} ${n(fxCycles(sum, 8), 8)} ${n(fxCycles(max, 8), 7)}  ` +
      `${[whole, sum, max]
        .map((c) => c.sdram.toFixed(1))
        .join(' / ')
        .padEnd(21)} ${(error * 100).toFixed(0).padStart(4)} %` +
      (missing.length ? `  (not in table: ${missing.join(', ')})` : '')
  )
}
rmSync(
  join(
    process.env.LOGUE_SDK ?? join(homedir(), 'Documents/GitHub/logue-sdk'),
    'platform',
    'minilogue-xd',
    DIR
  ),
  { recursive: true, force: true }
)
if (errors.length) {
  const pct = (e: number): string => `${e >= 0 ? '+' : ''}${(e * 100).toFixed(0)}%`
  console.log(`\nband at penalty 8: ${pct(Math.min(...errors))}..${pct(Math.max(...errors))}`)
}

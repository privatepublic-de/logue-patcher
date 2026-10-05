/**
 * `estimateFxCpuCost`'s NTS-1 mkII scale against readings on a real device
 * (`NTS1MKII_FX_PROBE_READINGS`): each unit's estimate next to its reading, and the scale and
 * SDRAM cost a fresh fit would pick (relative error, no intercept), without the device. Re-run
 * after a re-measured `fxCpuCostTable.ts`; new readings come from `hwtest/calibrateFx.ts`, and
 * `logue-estimateFxCpuCost.spec.ts` checks the band.
 *
 * Usage: npx tsx logue-codegen/scripts/checkNts1FxCpuEstimate.ts
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { parsePatchFile } from '../../src/shared/json/patchCodec'
import { estimateFxCpuCost } from '../src/estimateFxCpuCost'
import { exampleSubpatches, examplesDir } from './exampleSubpatches'
import { NTS1MKII_FX_PROBE_READINGS } from './nts1FxProbeUnits'

const subpatches = exampleSubpatches()
const rows: { c: number; s: number; m: number }[] = []
for (const r of NTS1MKII_FX_PROBE_READINGS) {
  const doc = r.doc ?? parsePatchFile(readFileSync(join(examplesDir, r.example!), 'utf-8'))
  const result = estimateFxCpuCost(doc, subpatches, 'nts1mkii')
  if (result.status !== 'ok') throw new Error(`${r.name}: ${result.reason}`)
  const { sum, cyclesPerSample } = result.estimate
  rows.push({ c: sum.cycles, s: sum.sdram, m: r.cycles })
  const error = cyclesPerSample / r.cycles - 1
  console.log(
    `${r.name.padEnd(22)} ${r.date}  device ${String(r.cycles).padStart(5)}  estimate ${String(cyclesPerSample).padStart(5)}  ` +
      `${error >= 0 ? '+' : ''}${(error * 100).toFixed(0).padStart(3)} %  (xd cycles ${sum.cycles}, SDRAM ${sum.sdram})`
  )
}
// Least squares on (k*c + p*s)/m = 1.
let a11 = 0,
  a12 = 0,
  a22 = 0,
  b1 = 0,
  b2 = 0
for (const { c, s, m } of rows) {
  const x = c / m,
    z = s / m
  a11 += x * x
  a12 += x * z
  a22 += z * z
  b1 += x
  b2 += z
}
const det = a11 * a22 - a12 * a12
const k = (b1 * a22 - b2 * a12) / det
const p = (a11 * b2 - a12 * b1) / det
console.log(`\nfresh fit: scale ${k.toFixed(2)}, ${p.toFixed(1)} cycles per SDRAM access`)

import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { parsePatchFile } from '../src/shared/json/patchCodec'
import { loadSubpatchDefinitions } from '../src/main/config/subpatchLibrary'
import { generateFxUnit } from '../logue-codegen/src/nts1mkii/generateFxUnit'
import { generateOldGenFxUnit } from '../logue-codegen/src/minilogue-xd/generateFxUnit'
import { estimateOscStateCost } from '../logue-codegen/src/estimateOscStateCost'

/**
 * The grain-mill example (docs/PLAN-grain-mill.md) as Export/Build see it: its voice subpatch is
 * found next to it, not in any library.
 */
const path = join(__dirname, '..', 'examples', 'effects', 'grain-mill.loguepatch')
const doc = parsePatchFile(readFileSync(path, 'utf-8'))
const defs = loadSubpatchDefinitions(path, undefined)

describe('the grain-mill example', () => {
  it('finds its voice next to it and builds an NTS-1 mkII delay with the planned menu', () => {
    expect([...defs.keys()]).toEqual(['sub/grain-voice'])
    const { headerC, fxH } = generateFxUnit(doc, { name: 'Grain Mill' }, defs)
    const names = [...headerC.matchAll(/\{"([^"]*)"\}\}/g)].map((m) => m[1]).filter(Boolean)
    expect(names).toEqual([
      'TIME',
      'DPTH',
      'MIX',
      'MOT AMT',
      'MOT SPD',
      'MOT TYP',
      'FEEDBK',
      'WIDTH',
      'ENV',
      'CHANCE',
      'MODE'
    ])
    expect(fxH.match(/= grain_step\(/g)).toHaveLength(8)
  })

  it('fits the delay slot: 5.5 s buffer + 8 x 1.4 s grain tables in SDRAM', () => {
    const est = estimateOscStateCost(doc, 'nts1mkii', defs)
    if (est.status !== 'ok') throw new Error(est.reason)
    expect(est.estimate.sdram?.usedBytes).toBe(512 * 1024 + 8 * 128 * 1024)
    expect(est.estimate.totalBytes).toBeLessThan(est.estimate.budgetBytes)
  })

  it('has a minilogue xd unit per clock mode: 2 voices on the three knobs, fitting the delay', () => {
    for (const mode of ['free', 'sync', 'rnd', 'rndsync']) {
      const xdPath = join(
        __dirname,
        '..',
        'examples',
        'effects',
        `grain-mill-xd-${mode}.loguepatch`
      )
      const xd = parsePatchFile(readFileSync(xdPath, 'utf-8'))
      const xdDefs = loadSubpatchDefinitions(xdPath, undefined)
      const { fxCpp } = generateOldGenFxUnit(xd, { name: 'Grain' }, xdDefs)
      expect(fxCpp.match(/= grain_step\(/g), mode).toHaveLength(2)
      const est = estimateOscStateCost(xd, 'minilogue-xd', xdDefs)
      if (est.status !== 'ok') throw new Error(est.reason)
      expect(est.estimate.sdram?.usedBytes, mode).toBe(512 * 1024 + 2 * 128 * 1024)
      expect(est.estimate.totalBytes, mode).toBeLessThan(est.estimate.budgetBytes)
    }
  })
})

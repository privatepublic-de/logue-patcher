import { describe, expect, it } from 'vitest'
import { LFSR_SHORT_STEPS, lfsrShortSequence } from '../logue-codegen/src/primitives/osc'
import { generateOldGenOscUnit } from '../logue-codegen/src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../src/shared/domain/patch'

function unit(type: string, params: Record<string, string>): string {
  const doc: PatchDocument = {
    nodes: [
      {
        kind: 'obj',
        type,
        name: 'n1',
        x: 0,
        y: 0,
        params: Object.entries(params).map(([name, value]) => ({ name, value }))
      },
      { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
    ],
    nets: [{ sources: [{ obj: 'n1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
    settings: {},
    notes: ''
  }
  return generateOldGenOscUnit(doc, { name: 'noise' }).oscCpp
}

describe('logue/osc/lfsr', () => {
  it('bakes the Game Boy 7-bit loop: 127 steps, no shorter period, 64 ones', () => {
    const seq = lfsrShortSequence()
    expect(seq).toHaveLength(LFSR_SHORT_STEPS)
    expect(seq.filter((b) => b === 1)).toHaveLength(64)
    for (let d = 1; d < LFSR_SHORT_STEPS; d++) {
      expect(seq.every((b, i) => b === seq[(i + d) % LFSR_SHORT_STEPS])).toBe(false)
    }
  })

  it('stores MODE as an int and the clock as a fixed-point block constant', () => {
    const cpp = unit('logue/osc/lfsr', { MODE: '1' })
    expect(cpp).toContain('lfsrMode_n1 = (int32_t)((1) + 0.5f);')
    expect(cpp).toMatch(
      /const float blkLfsrSteps_n1 = clampf\(.* \* 2130706432\.f, 0\.f, 1073741824\.f\);/
    )
    expect(cpp).toContain('lfsr_step(&lfsrReg_n1, &lfsrPos_n1, blkLfsrSteps_n1, lfsrMode_n1)')
  })
})

describe('logue/osc/noise COLOR', () => {
  it('stores COLOR as an int, White on the plain LCG path', () => {
    const cpp = unit('logue/osc/noise', { COLOR: '2' })
    expect(cpp).toContain('noiseColor_n1 = (int32_t)((2) + 0.5f);')
    expect(cpp).toContain('(noiseColor_n1 == 0 ? noise_step(&seed_n1) : noise_color_step(')
  })
})

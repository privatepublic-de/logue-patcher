import { describe, it, expect } from 'vitest'
import {
  directHelpersOf,
  recognizedLoguePrimitiveIds,
  resolveHelperChain
} from '../logue-codegen/src/primitives'
import { testSampleAsset } from './support/testSample'

/**
 * `HelperBlock.sharedBytes` is hand-counted (or, better, derived from the same constants the
 * embedded table is actually built from -- see `ADDITIVE_STEP_HELPER`/`FORMANT_STEP_HELPER`'s
 * own doc comments in `primitives.ts`), not parsed out of `code` at build time. Same gap
 * `test/logue-stateBytesPerInstance.spec.ts` already closes for `stateBytesPerInstance`: nothing
 * stops a future edit to a helper's embedded table from silently leaving `sharedBytes` stale.
 * This test closes it the same way -- a small, deliberately dumb parser re-derives each helper's
 * real embedded-table size straight from its own `code` string (every `static const <type> <name>
 * [a][b]...` declaration, sized by its element type) and asserts it matches the declared
 * `sharedBytes`. Node-aware helpers (`instanceHelpers`) are covered too, via a placed test sample.
 */
const ELEMENT_BYTES: Record<string, number> = { float: 4, int32_t: 4, uint32_t: 4, uint8_t: 1, int8_t: 1 }

function parsedSharedBytes(code: string): number {
  const declRe = /static const (\w+) \w+((?:\[\d+\])+)\s*=/g
  let total = 0
  let match: RegExpExecArray | null
  while ((match = declRe.exec(code))) {
    const elementBytes = ELEMENT_BYTES[match[1]]
    if (elementBytes === undefined) throw new Error(`unknown table element type ${match[1]}`)
    const dims = [...match[2].matchAll(/\[(\d+)\]/g)].map((d) => Number(d[1]))
    total += dims.reduce((product, dim) => product * dim, elementBytes)
  }
  return total
}

describe('HelperBlock.sharedBytes', () => {
  // The full deduped helper universe (including transitive `dependsOn` chains) across every
  // primitive in the registry -- the same `resolveHelperChain` call `oscBody.ts`/
  // `estimateOscStateCost.ts` themselves use, so this test covers exactly what could actually be
  // emitted, not a hand-picked subset.
  const allDirectHelpers = directHelpersOf(
    recognizedLoguePrimitiveIds().map((id) => ({ id, node: { sample: testSampleAsset(100) } }))
  )
  const allHelpers = resolveHelperChain(allDirectHelpers)

  it.each(allHelpers.map((h) => [h.key, h] as const))(
    'matches embedded tables for %s',
    (_key, helper) => {
      expect(helper.sharedBytes ?? 0).toBe(parsedSharedBytes(helper.code))
    }
  )

  it('at least one helper actually declares a non-zero sharedBytes -- a sanity check that this test can fail at all, not just vacuously pass if every helper happened to have none', () => {
    expect(allHelpers.some((h) => (h.sharedBytes ?? 0) > 0)).toBe(true)
  })
})

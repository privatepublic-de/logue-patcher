import { describe, it, expect } from 'vitest'
import { generateOscUnit as generateNts1MkiiOscUnit } from '../logue-codegen/src/nts1mkii/generateOscUnit'
import { generateOldGenOscUnit as generateMinilogueXdOscUnit } from '../logue-codegen/src/minilogue-xd/generateOscUnit'
import { LOGUE_AUDIO_IN_TYPE, LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import { generateFxUnit } from '../logue-codegen/src/nts1mkii/generateFxUnit'
import { generateOldGenFxUnit } from '../logue-codegen/src/minilogue-xd/generateFxUnit'
import { findUnitKind, requireUnitKind } from '../logue-codegen/src/unitKinds'
import type { PatchDocument } from '../src/shared/domain/patch'

const XD_OSC = requireUnitKind('minilogue-xd', 'osc')
const NTS1MKII_OSC = requireUnitKind('nts1mkii', 'osc')

/**
 * `{PLATFORM}_OSC_FIXED_BASELINE_BYTES` is hand-counted, not derived from the generated class
 * body at build time (see each constant's own doc comment). Same "hand-counted but unenforced"
 * gap `logue-stateBytesPerInstance.spec.ts`/`logue-helperSharedBytes.spec.ts` already close for
 * the other two cost tiers -- this closes it for the baseline tier by generating a REAL minimal
 * unit (one stateless, helper-less primitive, `logue/math/multiply`, wired straight to
 * `logue/io/audio-out`) and counting the scalar member declarations that appear in its own
 * generated class body BEFORE any per-instance/helper content -- there is none here, since
 * multiply contributes neither -- so every declared `float`/`int`/`uint32_t` member found is
 * necessarily part of the fixed baseline, not a hand-typed duplicate of it.
 */
function countDeclaredScalarMembers(classBody: string): number {
  const memberRe = /^\s*(?:float|int|uint32_t)\s+\w+;\s*$/gm
  return (classBody.match(memberRe) ?? []).length
}

const minimalRingmodDoc: PatchDocument = {
  nodes: [
    { kind: 'obj', type: 'logue/math/multiply', name: 'r', x: 0, y: 0, params: [] },
    { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [{ sources: [{ obj: 'r', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
  settings: {},
  notes: ''
}

describe('UnitKind.fixedBaselineBytes', () => {
  it('matches the real generated NTS-1 mkII class body for a stateless, helper-less minimal graph', () => {
    const source = generateNts1MkiiOscUnit(minimalRingmodDoc, { name: 'x' })
    const scalarCount = countDeclaredScalarMembers(source.oscH)
    expect(NTS1MKII_OSC.fixedBaselineBytes).toBe(scalarCount * 4)
  })

  it('matches the real generated minilogue xd class body for a stateless, helper-less minimal graph', () => {
    const source = generateMinilogueXdOscUnit(minimalRingmodDoc, { name: 'x' })
    const scalarCount = countDeclaredScalarMembers(source.oscCpp)
    expect(XD_OSC.fixedBaselineBytes).toBe(scalarCount * 4)
  })

  it.each(['modfx', 'delfx', 'revfx'] as const)(
    'matches the real generated %s class body on both platforms for an input-to-output multiply',
    (module) => {
      const fxDoc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: LOGUE_AUDIO_IN_TYPE, name: 'in', x: 0, y: 0, params: [] },
          ...minimalRingmodDoc.nodes
        ],
        nets: [
          { sources: [{ obj: 'in', outlet: 'l' }], dests: [{ obj: 'r', inlet: 'in1' }] },
          { sources: [{ obj: 'r', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'l' }] }
        ],
        settings: { logueTarget: { module } },
        notes: ''
      }
      const scalarCount = countDeclaredScalarMembers(generateFxUnit(fxDoc, { name: 'x' }).fxH)
      expect(findUnitKind('nts1mkii', module)!.fixedBaselineBytes).toBe(scalarCount * 4)
      const xdCount = countDeclaredScalarMembers(generateOldGenFxUnit(fxDoc, { name: 'x' }).fxCpp)
      expect(findUnitKind('minilogue-xd', module)!.fixedBaselineBytes).toBe(xdCount * 4)
    }
  )

  it('is well under 1% of either platform\'s own budget -- negligible in practice, still counted for "exact, not estimated"', () => {
    expect(NTS1MKII_OSC.fixedBaselineBytes / NTS1MKII_OSC.ramBytes).toBeLessThan(0.01)
    expect(XD_OSC.fixedBaselineBytes / XD_OSC.ramBytes).toBeLessThan(0.01)
  })
})

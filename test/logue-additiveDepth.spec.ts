import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findLoguePrimitive, recognizedLoguePrimitiveIds } from '@logue-codegen/primitives'
import { additiveDepthOf } from '@logue-codegen/paramPresentation'

// `ParamModulation.depth` is display metadata (the canvas's knob dead-zone warning reads it), so
// nothing would notice it drifting from what codegen really adds. The golden "wired" render of
// every primitive wires each inlet from a constant `y_c_<inlet>`; its depth is either a literal
// multiplier, `(y_c_x) * 50.f`, or -- for a dial stored as a 0..1 fraction (`* 0.01f`) -- the wire
// added raw, which is the whole range.
describe('additive inlet depth metadata matches codegen', () => {
  const ids = recognizedLoguePrimitiveIds().filter((id) => !findLoguePrimitive(id)!.supersededBy)
  for (const id of ids) {
    const primitive = findLoguePrimitive(id)!
    for (const spec of primitive.params ?? []) {
      const m = spec.modulatedBy
      if (m?.shape !== 'additive' || m.unclamped) continue
      it(`${id} ${spec.name} (${m.inlet})`, () => {
        const file = join(
          import.meta.dirname,
          '__snapshots__/primitives',
          `${id.slice('logue/'.length).replace('/', '.')}.nts1mkii.txt`
        )
        expect(existsSync(file)).toBe(true)
        const text = readFileSync(file, 'utf8')
        const depth = additiveDepthOf(spec)
        const multipliers = [
          ...text.matchAll(new RegExp(`\\(y_c_${m.inlet}\\) \\* ([0-9.]+)f`, 'g'))
        ].map((match) => Number(match[1]))
        const addedRaw = new RegExp(`\\+ \\(y_c_${m.inlet}\\)(?! \\*)`).test(text)
        expect(multipliers.length > 0 || addedRaw, 'the wired inlet appears in codegen').toBe(true)
        for (const found of multipliers) expect(found).toBe(depth)
        if (addedRaw) expect(depth).toBe(spec.max - spec.min)
      })
    }
  }
})

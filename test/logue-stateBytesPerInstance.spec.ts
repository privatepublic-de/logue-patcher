import { describe, it, expect } from 'vitest'
import { findLoguePrimitive, recognizedLoguePrimitiveIds } from '../logue-codegen/src/primitives'

/**
 * `LoguePrimitive.stateBytesPerInstance` is hand-counted, not derived from `memberDecls` at
 * build time (see that field's own doc comment for why: parsing generated C++ text back out
 * would be more fragile than writing the number down once). That means nothing stops a future
 * `memberDecls` edit -- adding, removing, or resizing a member -- from silently leaving the byte
 * count stale, the exact "make it a compile error, not a silent wrong value" gap this registry
 * otherwise avoids (`PrimitiveInletSpec.role`'s own precedent). This test closes it: a small,
 * deliberately dumb parser re-derives each primitive's real byte count straight from its own
 * `memberDecls('x')` output (every member here is a 4-byte `float`/`int`/`uint32_t` scalar,
 * except an array like `buf_[512]`, and `int16_t` elements are 2 bytes) and asserts it matches the declared constant -- a stale
 * `stateBytesPerInstance` now fails a test instead of silently drifting.
 */
function parsedStateBytes(memberDecls: string): number {
  return memberDecls
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0)
    .reduce((total, stmt) => {
      const arrayMatch = stmt.match(/\[(\d+)\]\s*$/)
      const elementBytes = /^int16_t\b/.test(stmt) ? 2 : 4
      return total + (arrayMatch ? elementBytes * Number(arrayMatch[1]) : elementBytes)
    }, 0)
}

describe('LoguePrimitive.stateBytesPerInstance', () => {
  it.each(recognizedLoguePrimitiveIds())(
    "matches memberDecls's own declared fields for %s",
    (id) => {
      const primitive = findLoguePrimitive(id)!
      expect(primitive.stateBytesPerInstance).toBe(parsedStateBytes(primitive.memberDecls('x')))
    }
  )
})

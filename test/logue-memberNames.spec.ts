import { describe, expect, it } from 'vitest'
import { findLoguePrimitive, recognizedLoguePrimitiveIds } from '@logue-codegen/primitives'

describe('primitive member names', () => {
  // Codegen names each instance's per-sample output `y_<suffix>` (and `y_<suffix>_<outlet>`), a
  // local inside the sample loop. A member of that name is shadowed there: `util/slew`'s first
  // version stepped an uninitialised local and its output fell to ~0 once an input was wired.
  it('never declare y_<suffix>, the name of an instance output', () => {
    for (const id of recognizedLoguePrimitiveIds()) {
      const decls = findLoguePrimitive(id)!.memberDecls('sfx')
      expect(decls, id).not.toMatch(/\by_sfx\b|\by_sfx_\w/)
    }
  })
})

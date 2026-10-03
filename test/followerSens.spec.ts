import { describe, expect, it } from 'vitest'
import { normalizeRenamedFields } from '@logue-codegen/renamedFields'
import { FOLLOWER_SENS_DB } from '@logue-codegen/paramPresentation'
import type { ObjNode, PatchDocument } from '../src/shared/domain/patch'

describe('env/follower SENS (GAIN until 2026-10-03)', () => {
  it('opens an old GAIN as SENS, value and device slot kept', () => {
    const doc: PatchDocument = {
      nodes: [
        {
          kind: 'obj',
          type: 'logue/env/follower',
          name: 'f',
          x: 0,
          y: 0,
          params: [{ name: 'GAIN', value: '60', logueParamIndex: { nts1mkii: 3 } }]
        }
      ],
      nets: [],
      settings: { logueTarget: { module: 'modfx' } },
      notes: ''
    }
    const node = normalizeRenamedFields(doc).nodes[0] as ObjNode
    expect(node.params).toEqual([{ name: 'SENS', value: '60', logueParamIndex: { nts1mkii: 3 } }])
  })

  it('shows the input level that reaches full output, and reads it back', () => {
    expect(FOLLOWER_SENS_DB.toDisplay(0)).toBe('full at 0.0 dB')
    // The default: a gain of 8.5x (+18.6 dB).
    expect(FOLLOWER_SENS_DB.toDisplay(50)).toBe('full at -18.6 dB')
    expect(FOLLOWER_SENS_DB.toDisplay(100)).toBe('full at -24.1 dB')
    for (const text of ['-18.6', '18.6', 'full at -18.6 dB']) {
      expect(FOLLOWER_SENS_DB.parseInput(text)).toBeCloseTo(50, 0)
    }
  })
})

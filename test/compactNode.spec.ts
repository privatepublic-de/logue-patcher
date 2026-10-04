import { describe, expect, it } from 'vitest'
import { recognizedLoguePrimitiveIds, findLoguePrimitive } from '@logue-codegen/primitives'
import type { ObjNode } from '@shared/domain/patch'
import { headerTypeLabel, isCompactPrimitive } from '../src/renderer/src/canvas/compactNode'
import { estimateNodeSize } from '../src/renderer/src/canvas/autoArrange'

describe('compact nodes', () => {
  it('are the param-less one-in/one-out primitives', () => {
    const compact = recognizedLoguePrimitiveIds().filter(isCompactPrimitive).sort()
    expect(compact).toEqual(
      [
        'logue/logic/edge',
        'logue/math/abs',
        'logue/math/negate',
        'logue/math/one-minus',
        'logue/sense/gate',
        'logue/util/bipolar-to-unipolar',
        'logue/util/sample-delay',
        'logue/util/unipolar-to-bipolar'
      ].sort()
    )
  })

  it('never include a subpatch instance, io node or two-inlet operator', () => {
    expect(isCompactPrimitive('sub/anything')).toBe(false)
    expect(isCompactPrimitive('logue/io/audio-out')).toBe(false)
    expect(isCompactPrimitive('logue/math/add')).toBe(false)
  })

  it('every shortLabel is short and every defaultName a valid node name', () => {
    for (const id of recognizedLoguePrimitiveIds()) {
      const p = findLoguePrimitive(id)!
      if (p.shortLabel !== undefined) expect(p.shortLabel.length).toBeLessThanOrEqual(8)
      if (p.defaultName !== undefined) expect(p.defaultName).toMatch(/^[a-zA-Z0-9_]+$/)
    }
  })

  it('the header shows the shortLabel, else the id without logue/', () => {
    expect(headerTypeLabel('logue/util/bipolar-to-unipolar')).toBe('bi→uni')
    expect(headerTypeLabel('logue/osc/saw')).toBe('osc/saw')
    expect(headerTypeLabel('sub/bass/pluck')).toBe('sub/bass/pluck')
  })

  it('are estimated as one narrow row for arranging', () => {
    const node: ObjNode = {
      kind: 'obj',
      type: 'logue/util/bipolar-to-unipolar',
      name: 'b2u',
      x: 0,
      y: 0,
      params: []
    }
    const size = estimateNodeSize(node, 'b2u', [])
    expect(size.width).toBeLessThan(100)
    expect(size.height).toBeLessThan(35)
  })
})

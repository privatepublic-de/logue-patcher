import { describe, it, expect } from 'vitest'
import type { PatchDocument } from '@shared/domain/patch'
import { differsOnlyInPositions } from '../src/renderer/src/state/positionFreeDoc'

function doc(): PatchDocument {
  return {
    nodes: [
      { kind: 'obj', type: 'logue/osc/sine', name: 'a', x: 0, y: 0, params: [] },
      { kind: 'comment', type: 'patch/comment', text: 'hi', x: 10, y: 10 }
    ],
    nets: [],
    settings: {},
    notes: ''
  }
}

describe('differsOnlyInPositions', () => {
  it('ignores a moved node', () => {
    const before = doc()
    const after = { ...before, nodes: [{ ...before.nodes[0], x: 99, y: 42 }, before.nodes[1]] }
    expect(differsOnlyInPositions(before, after)).toBe(true)
  })

  it('sees a param, nets or settings change', () => {
    const before = doc()
    const obj = before.nodes[0] as Extract<PatchDocument['nodes'][number], { kind: 'obj' }>
    const paramChanged = {
      ...before,
      nodes: [{ ...obj, params: [{ name: 'FINE', value: '3' }] }, before.nodes[1]]
    }
    expect(differsOnlyInPositions(before, paramChanged)).toBe(false)
    expect(differsOnlyInPositions(before, { ...before, nets: [] })).toBe(false)
    expect(differsOnlyInPositions(before, { ...before, settings: {} })).toBe(false)
  })

  it('sees an added node or a renamed one', () => {
    const before = doc()
    expect(differsOnlyInPositions(before, { ...before, nodes: before.nodes.slice(0, 1) })).toBe(
      false
    )
    const renamed = { ...before, nodes: [{ ...before.nodes[0], name: 'b' }, before.nodes[1]] }
    expect(differsOnlyInPositions(before, renamed)).toBe(false)
  })
})

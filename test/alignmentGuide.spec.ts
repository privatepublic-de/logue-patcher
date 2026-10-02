import { describe, expect, it } from 'vitest'
import type { Node } from '@xyflow/react'
import {
  computeYSnap,
  candidateSnapYs,
  computeXSnap,
  candidateSnapXs,
  SNAP_CAPTURE_PX,
  SNAP_RELEASE_PX
} from '../src/renderer/src/canvas/alignmentGuide'

function node(id: string, y: number, type: string = 'object'): Node {
  return { id, type, position: { x: 0, y }, data: {} }
}

function nodeAtX(id: string, x: number, type: string = 'object'): Node {
  return { id, type, position: { x, y: 0 }, data: {} }
}

describe('computeYSnap', () => {
  it('returns null when no candidate is within capture range', () => {
    expect(computeYSnap(100, [100 + SNAP_CAPTURE_PX + 1, 300], null)).toBeNull()
  })

  it('snaps to the nearest candidate within capture range', () => {
    expect(computeYSnap(100, [100 + SNAP_CAPTURE_PX, 300], null)).toBe(100 + SNAP_CAPTURE_PX)
    expect(computeYSnap(200, [50, 199, 500], null)).toBe(199)
  })

  it('picks whichever candidate is numerically closest when several are in range', () => {
    expect(computeYSnap(100, [100 - 2, 100 + 5], null)).toBe(98)
  })

  it('stays snapped (hysteresis) until the raw Y moves past the release distance', () => {
    const snappedTo = 100
    expect(computeYSnap(100 + SNAP_RELEASE_PX, [snappedTo], snappedTo)).toBe(snappedTo)
    expect(computeYSnap(100 + SNAP_RELEASE_PX + 1, [snappedTo], snappedTo)).toBeNull()
  })

  it('ignores a stale snapped target no longer present among candidates', () => {
    expect(computeYSnap(101, [300], 100)).toBeNull()
  })

  it('returns null with no candidates at all', () => {
    expect(computeYSnap(100, [], null)).toBeNull()
  })
})

describe('candidateSnapYs', () => {
  it('excludes comment nodes -- not a meaningful codegen-order alignment target', () => {
    const nodes = [node('a', 10), node('c', 20, 'comment')]
    expect(candidateSnapYs(nodes, new Set())).toEqual([10])
  })

  it('excludes nodes currently being dragged (a node cannot snap to itself or a co-dragged sibling)', () => {
    const nodes = [node('a', 10), node('b', 20), node('c', 30)]
    expect(candidateSnapYs(nodes, new Set(['a', 'b']))).toEqual([30])
  })
})

describe('computeXSnap', () => {
  it('returns null when no candidate is within capture range', () => {
    expect(computeXSnap(100, [100 + SNAP_CAPTURE_PX + 1, 300], null)).toBeNull()
  })

  it('snaps to the nearest candidate within capture range', () => {
    expect(computeXSnap(100, [100 + SNAP_CAPTURE_PX, 300], null)).toBe(100 + SNAP_CAPTURE_PX)
    expect(computeXSnap(200, [50, 199, 500], null)).toBe(199)
  })

  it('stays snapped (hysteresis) until the raw X moves past the release distance', () => {
    const snappedTo = 100
    expect(computeXSnap(100 + SNAP_RELEASE_PX, [snappedTo], snappedTo)).toBe(snappedTo)
    expect(computeXSnap(100 + SNAP_RELEASE_PX + 1, [snappedTo], snappedTo)).toBeNull()
  })

  it('ignores a stale snapped target no longer present among candidates', () => {
    expect(computeXSnap(101, [300], 100)).toBeNull()
  })
})

describe('candidateSnapXs', () => {
  it('excludes comment nodes -- not a meaningful codegen-order alignment target', () => {
    const nodes = [nodeAtX('a', 10), nodeAtX('c', 20, 'comment')]
    expect(candidateSnapXs(nodes, new Set())).toEqual([10])
  })

  it('excludes nodes currently being dragged (a node cannot snap to itself or a co-dragged sibling)', () => {
    const nodes = [nodeAtX('a', 10), nodeAtX('b', 20), nodeAtX('c', 30)]
    expect(candidateSnapXs(nodes, new Set(['a', 'b']))).toEqual([30])
  })
})

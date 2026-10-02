import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  autoArrangeNodes,
  autoArrangeDocumentTree,
  estimateNodeSize,
  comparePosition
} from '../src/renderer/src/canvas/autoArrange'
import { nodeId } from '../src/renderer/src/state/nodeId'
import type { PatchDocument, PatchNode } from '../src/shared/domain/patch'

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures')

/** These json fixtures were originally converted from real Axoloti .axp files (back when this
 *  app still read that format) purely for their realistic, messy/overlapping node layouts.
 *  Nothing here exercises format-specific behavior. */
function readFixture(name: string): PatchDocument {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf-8'))
}

function rankedIds(nodes: PatchNode[]): string[] {
  return nodes
    .map((n, i) => ({ id: nodeId(n, i), n }))
    .sort((a, b) => comparePosition(a.n, b.n))
    .map((x) => x.id)
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

function assertNoOverlaps(doc: PatchDocument, arranged: PatchNode[]): void {
  const rects = arranged.map((n, i) => {
    const size = estimateNodeSize(n, nodeId(n, i), doc.nets)
    return { x: n.x, y: n.y, w: size.width, h: size.height }
  })
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      expect(rectsOverlap(rects[i], rects[j])).toBe(false)
    }
  }
}

describe('autoArrangeNodes', () => {
  it.each(['spilink.json', 'spilink_tdelta.json', 'hw-test.json', 'resonator.json'])(
    '%s: preserves position-sort rank and produces no overlapping nodes',
    (name) => {
      const doc = readFixture(name)
      const before = rankedIds(doc.nodes)

      const arranged = autoArrangeNodes(doc)

      expect(rankedIds(arranged)).toEqual(before)
      assertNoOverlaps(doc, arranged)
    }
  )

  it('leaves node identity, kind, and all non-position fields untouched', () => {
    const doc = readFixture('spilink.json')
    const arranged = autoArrangeNodes(doc)
    expect(arranged).toHaveLength(doc.nodes.length)
    arranged.forEach((n, i) => {
      const original = doc.nodes[i]
      expect({ ...n, x: original.x, y: original.y }).toEqual(original)
    })
  })

  it('prefers a real measured size over the text-length estimate, and still produces no overlap against the measured footprint', () => {
    const doc = readFixture('spilink.json')
    const ids = doc.nodes.map((n, i) => nodeId(n, i))

    // A deliberately much larger size than estimateNodeSize would ever guess for these nodes
    // (real long param values, wide port names, font metrics the estimate doesn't model) --
    // this is exactly the "estimate undershoots the real DOM box" scenario that let rearranged
    // nodes overlap on screen despite the existing estimate-only test above passing.
    const measuredSizes = new Map(ids.map((id) => [id, { width: 400, height: 200 }]))

    const arranged = autoArrangeNodes(doc, measuredSizes)

    const rects = arranged.map((n) => ({ x: n.x, y: n.y, w: 400, h: 200 }))
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(rectsOverlap(rects[i], rects[j])).toBe(false)
      }
    }
  })

  it('is idempotent once nothing overlaps -- a second pass leaves every position untouched', () => {
    const doc = readFixture('spilink.json')
    const arrangedOnce = autoArrangeNodes(doc)
    const arrangedTwice = autoArrangeNodes({ ...doc, nodes: arrangedOnce })
    arrangedTwice.forEach((n, i) => {
      expect(n.x).toBe(arrangedOnce[i].x)
      expect(n.y).toBe(arrangedOnce[i].y)
    })
  })

  it('separates nodes placed at the exact same position (e.g. paste-at-origin)', () => {
    const doc = readFixture('spilink.json')
    const coincident: PatchDocument = {
      ...doc,
      nodes: doc.nodes.map((n) => ({ ...n, x: 100, y: 100 }))
    }
    const before = rankedIds(coincident.nodes)

    const arranged = autoArrangeNodes(coincident)

    expect(rankedIds(arranged)).toEqual(before)
    assertNoOverlaps(coincident, arranged)
  })

  it('produces no overlap against a MIXED measured/estimated size map, not just a uniformly re-estimated one', () => {
    // Two comment nodes close enough together that the tiny text-length estimate sees no
    // overlap, but a real DOM measurement (much wider than the estimate could ever guess --
    // long wrapped text, real font metrics) would. Only the left node is "measured"; a
    // requiredGap bug that reads the WRONG node's size (or silently re-estimates instead of
    // using the supplied map) would let the right node's box collide with the measured one.
    const doc: PatchDocument = {
      nodes: [
        { kind: 'comment', type: 'patch/comment', x: 0, y: 0, text: 'a' },
        { kind: 'comment', type: 'patch/comment', x: 30, y: 0, text: 'b' }
      ],
      nets: [],
      settings: {},
      notes: ''
    }
    const ids = doc.nodes.map((n, i) => nodeId(n, i))
    const sizeById = new Map([
      [ids[0], { width: 300, height: 80 }],
      [ids[1], { width: 40, height: 40 }]
    ])

    const arranged = autoArrangeNodes(doc, sizeById)

    const rects = arranged.map((n, i) => {
      const size = sizeById.get(nodeId(n, i)) ?? estimateNodeSize(n, nodeId(n, i), doc.nets)
      return { x: n.x, y: n.y, w: size.width, h: size.height }
    })
    expect(rectsOverlap(rects[0], rects[1])).toBe(false)
  })

  it('keeps a visual column moving together instead of straddling it when one member needs more room', () => {
    // resonator.axp's 4 voices are each a `resobp_N` / `dial_N` / `*_N` trio whose original x
    // scatters by 20-60px (real hand-placed layout, not exactly aligned) -- a real DOM
    // measurement for `resobp` (wider than the plain estimate: real ports + params) forces
    // separation from its same-row neighbor and used to cascade only through the x-levels at
    // or above the push point, leaving column-mates below the threshold behind (e.g. `dial_2`
    // stayed put while `resobp_2`/`*_2` moved ~65px right) -- reproduced directly against the
    // pre-fix algorithm before this test was written.
    const doc = readFixture('resonator.json')
    const ids = doc.nodes.map((n, i) => nodeId(n, i))
    const measuredSizes = new Map(
      ids.filter((id) => id.startsWith('resobp_')).map((id) => [id, { width: 260, height: 160 }])
    )

    const arranged = autoArrangeNodes(doc, measuredSizes)
    const xById = new Map(arranged.map((n, i) => [nodeId(n, i), n.x]))

    for (const voice of [1, 2, 3, 4]) {
      const resobpX = xById.get(`resobp_${voice}`)
      const dialX = xById.get(`dial_${voice}`)
      const starX = xById.get(`*_${voice}`)
      expect(dialX).toBe(resobpX)
      expect(starX).toBe(resobpX)
    }
    assertNoOverlaps(doc, arranged)

    // Idempotency specifically for the case that actually exercises column clustering plus
    // a real push (the existing idempotency test below only covers spilink.axp with no
    // measured sizes, which barely moves anything) -- a tolerance that re-merges what the
    // first pass just separated would show up here as position drift on the second pass.
    const arrangedTwice = autoArrangeNodes({ ...doc, nodes: arranged }, measuredSizes)
    arrangedTwice.forEach((n, i) => {
      expect(n.x).toBe(arranged[i].x)
      expect(n.y).toBe(arranged[i].y)
    })
  })

  it('falls back to the estimate for a node with no measured size in the map', () => {
    const doc = readFixture('spilink.json')
    const ids = doc.nodes.map((n, i) => nodeId(n, i))

    // Only measure the first node -- every other node must still get a sane, estimate-based
    // size rather than e.g. collapsing to zero/undefined.
    const measuredSizes = new Map([[ids[0], { width: 500, height: 300 }]])

    const arranged = autoArrangeNodes(doc, measuredSizes)
    expect(rankedIds(arranged)).toEqual(rankedIds(doc.nodes))
    assertNoOverlaps(doc, arranged)
  })
})

describe('autoArrangeDocumentTree', () => {
  it('fixes root-level overlap the same way autoArrangeNodes does', () => {
    const doc = readFixture('spilink.json')
    const arranged = autoArrangeDocumentTree(doc)
    assertNoOverlaps(doc, arranged.nodes)
  })
})

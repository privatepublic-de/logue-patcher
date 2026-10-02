import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { layoutByFlow } from '../src/renderer/src/canvas/flowLayout'
import { autoArrangeNodes, estimateNodeSize } from '../src/renderer/src/canvas/autoArrange'
import { useSubpatchLibraryStore } from '../src/renderer/src/state/subpatchLibraryStore'
import { nodeId } from '../src/renderer/src/state/nodeId'
import { subpatchPortNodes } from '../logue-codegen/src/subpatches'
import { decodePatchDocument } from '../src/shared/json/patchCodec'
import type { PatchDocument, PatchNode } from '../src/shared/domain/patch'

const EXAMPLES = join(import.meta.dirname, '..', 'examples', 'effects')
function example(name: string): PatchDocument {
  return decodePatchDocument(JSON.parse(readFileSync(join(EXAMPLES, name), 'utf-8')))
}
const VOICE = example('grain-voice.loguesub')

// At load, not in a beforeEach: the layouts below are computed while the suite is collected.
useSubpatchLibraryStore
  .getState()
  .setEntries([
    { type: 'sub/grain-voice', filePath: '/x/grain-voice.loguesub', source: 'local', doc: VOICE }
  ])

function at(nodes: PatchNode[], name: string): PatchNode {
  return nodes.find((n) => n.name === name)!
}

function expectNoOverlaps(doc: PatchDocument, nodes: PatchNode[]): void {
  const boxes = nodes.map((n, i) => ({ n, ...estimateNodeSize(n, nodeId(n, i), doc.nets) }))
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [a, b] = [boxes[i], boxes[j]]
      const apart =
        a.n.x + a.width + 40 <= b.n.x ||
        b.n.x + b.width + 40 <= a.n.x ||
        a.n.y + a.height + 30 <= b.n.y ||
        b.n.y + b.height + 30 <= a.n.y
      expect(apart, `${a.n.name ?? 'comment'} / ${b.n.name ?? 'comment'}`).toBe(true)
    }
  }
}

describe('layout by signal flow', () => {
  const doc = example('grain-mill.loguepatch')
  const laid = layoutByFlow(doc)
  const x = (name: string): number => at(laid, name).x

  it('runs every wire left to right except the feedback return', () => {
    for (const net of doc.nets) {
      for (const d of net.dests) {
        const from = net.sources[0].obj
        if (from === 'fb-sat') continue
        expect(x(from), `${from} -> ${d.obj}`).toBeLessThan(x(d.obj))
      }
    }
    expect(x('fb-sat')).toBeGreaterThan(x('in+fb'))
  })

  it('puts a control chain right before what it drives and the output last', () => {
    expect(x('env-attack')).toBe(x('buffer'))
    expect(x('voices')).toBe(x('buffer'))
    expect(x('position')).toBe(x('buffer'))
    const maxX = Math.max(...laid.map((n) => n.x))
    expect(x('audio-out')).toBe(maxX)
  })

  it('leaves no overlaps, and nothing for the load-time pass to move', () => {
    expectNoOverlaps(doc, laid)
    expect(autoArrangeNodes({ ...doc, nodes: laid })).toEqual(laid)
  })

  it('is deterministic and stable when run again', () => {
    expect(layoutByFlow(doc)).toEqual(laid)
    expect(layoutByFlow({ ...doc, nodes: laid })).toEqual(laid)
  })

  it("keeps a definition's port order", () => {
    const after = layoutByFlow(VOICE)
    const names = (d: PatchDocument): string[][] => {
      const p = subpatchPortNodes(d)
      return [p.inlets.map((n) => n.name!), p.outlets.map((n) => n.name!)]
    }
    expect(names({ ...VOICE, nodes: after })).toEqual(names(VOICE))
    expectNoOverlaps(VOICE, after)
  })

  it('keeps the port order with a port left unwired', () => {
    const partial: PatchDocument = {
      ...VOICE,
      nets: VOICE.nets.filter(
        (net) =>
          !net.sources.some((s) => s.obj === 'bus-l') && !net.dests.some((d) => d.obj === 'l')
      )
    }
    const ports = (d: PatchDocument): string[] => {
      const p = subpatchPortNodes(d)
      return [...p.inlets, ...p.outlets].map((n) => n.name!)
    }
    const after = layoutByFlow(partial)
    expect(ports({ ...partial, nodes: after })).toEqual(ports(partial))
    expectNoOverlaps(partial, after)
  })

  it('keeps comments with their node and puts unwired nodes underneath', () => {
    const withExtras: PatchDocument = {
      ...doc,
      nodes: [
        ...doc.nodes,
        { kind: 'comment', type: 'patch/comment', x: 3640, y: 140, text: 'out' },
        { kind: 'obj', type: 'logue/util/constant', name: 'stray', x: 0, y: 0, params: [] }
      ]
    }
    const after = layoutByFlow(withExtras)
    const comment = after[after.length - 2]
    const out = at(after, 'audio-out')
    expect(Math.abs(comment.x - out.x)).toBeLessThan(100)
    expect(at(after, 'stray').y).toBeGreaterThan(Math.max(...laid.map((n) => n.y)))
    // A comment finds free space instead of pushing nodes aside.
    for (const n of laid) expect(at(after, n.name!), n.name).toMatchObject({ x: n.x, y: n.y })
  })
})

describe.each(
  readdirSync(EXAMPLES).filter((f) => f.endsWith('.loguepatch') || f.endsWith('.loguesub'))
)('layout by signal flow of %s', (file) => {
  const doc = example(file)
  const laid = layoutByFlow(doc)

  it('has no overlaps and nothing left for the load-time pass', () => {
    expectNoOverlaps(doc, laid)
    expect(autoArrangeNodes({ ...doc, nodes: laid })).toEqual(laid)
  })
})

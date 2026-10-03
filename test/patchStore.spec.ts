import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { createPatchStoreState, type PatchStoreState } from '../src/renderer/src/state/patchStore'
import { serializeSelectionForClipboard } from '../src/renderer/src/state/patchDocHelpers'
import { parsePatchFile, serializePatchFile } from '@shared/json/patchCodec'
import type { PatchDocument, PatchNode, Net } from '@shared/domain/patch'
import type { LogueParamSlot, ParamValue } from '@shared/domain/paramValueTypes'
import { nodeId } from '../src/renderer/src/state/nodeId'
import { estimateNodeSize, comparePosition } from '../src/renderer/src/canvas/autoArrange'
import { LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import { generateOldGenOscUnit } from '../logue-codegen/src/minilogue-xd/generateOscUnit'

// A realistic, messy node graph (originally converted from a real Axoloti .axp fixture, back
// when this app still read that format) used only for its overlap/
// naming shape, not for anything format-specific.
const FIXTURE: PatchDocument = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/spilink.json'), 'utf-8')
)

// A plain vanilla instance of one tab's store -- patchStore.ts's `usePatchStore` is now a
// React hook resolved through Context (see PatchStoreContext), not something with its own
// getState()/setState() to call directly outside a component; this test exercises the
// underlying store logic directly instead, exactly as tabRegistry.ts does per real tab.
const store = createStore<PatchStoreState>(createPatchStoreState)

function freshDoc(): PatchDocument {
  return structuredClone(FIXTURE)
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** Same shape as autoArrange.spec.ts's own helper -- kept local rather than shared, since a spec file's fixtures should stand on their own. */
function hasAnyOverlap(doc: PatchDocument, nodes: PatchNode[]): boolean {
  const rects = nodes.map((n, i) => {
    const size = estimateNodeSize(n, nodeId(n, i), doc.nets)
    return { x: n.x, y: n.y, w: size.width, h: size.height }
  })
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (rectsOverlap(rects[i], rects[j])) return true
    }
  }
  return false
}

function rankedIds(nodes: PatchNode[]): string[] {
  return nodes
    .map((n, i) => ({ id: nodeId(n, i), n }))
    .sort((a, b) => comparePosition(a.n, b.n))
    .map((x) => x.id)
}

beforeEach(() => {
  const doc = freshDoc()
  store.setState({
    rootDoc: doc,
    savedDoc: doc,
    filePath: '/tmp/fixture.axp',
    reloadNonce: 0,
    selectedNodeId: null,
    dirty: false,
    past: [],
    future: [],
    pendingUndo: null
  })
})

describe('patchStore.moveNode', () => {
  it("updates only the target node's position, leaving everything else untouched", () => {
    const before = store.getState().rootDoc!
    store.getState().moveNode('sine_1', 999, 888)
    const after = store.getState().rootDoc!

    const moved = after.nodes.find((n) => n.name === 'sine_1')
    expect(moved).toMatchObject({ x: 999, y: 888 })

    // every other node is unchanged
    const otherBefore = before.nodes.filter((n) => n.name !== 'sine_1')
    const otherAfter = after.nodes.filter((n) => n.name !== 'sine_1')
    expect(otherAfter).toEqual(otherBefore)
    expect(after.nets).toEqual(before.nets)
  })

  it('does not bump reloadNonce (drag must not remount the canvas)', () => {
    store.getState().moveNode('sine_1', 1, 1)
    expect(store.getState().reloadNonce).toBe(0)
  })
})

describe('patchStore.addNet', () => {
  it('creates a brand new net for a source with no existing net', () => {
    // out_2's "left" inlet is unwired in the fixture (only "right" is) -- a genuinely free dest.
    const before = store.getState().rootDoc!.nets.length
    store.getState().addNet({ obj: 'hex_1', outlet: 'out' }, { obj: 'out_2', inlet: 'left' })
    const after = store.getState().rootDoc!
    expect(after.nets).toHaveLength(before + 1)
    expect(after.nets.at(-1)).toEqual({
      sources: [{ obj: 'hex_1', outlet: 'out' }],
      dests: [{ obj: 'out_2', inlet: 'left' }]
    })
  })

  it('folds a second connection from the same outlet into the existing net as fan-out', () => {
    // sine_1's "wave" outlet already feeds *c_1 in the fixture -- connect it to a second,
    // otherwise-unwired dest too (out_2's "left" inlet -- see the test above).
    const beforeCount = store.getState().rootDoc!.nets.length
    store.getState().addNet({ obj: 'sine_1', outlet: 'wave' }, { obj: 'out_2', inlet: 'left' })
    const after = store.getState().rootDoc!
    expect(after.nets).toHaveLength(beforeCount) // no new net created
    const net = after.nets.find(
      (n) => n.sources[0]?.obj === 'sine_1' && n.sources[0]?.outlet === 'wave'
    )
    expect(net?.dests).toEqual([
      { obj: '*c_1', inlet: 'in' },
      { obj: 'out_2', inlet: 'left' }
    ])
  })

  it('bumps reloadNonce (structural change requires a canvas resync)', () => {
    store.getState().addNet({ obj: 'hex_1', outlet: 'out' }, { obj: 'out_1', inlet: 'left' })
    expect(store.getState().reloadNonce).toBe(1)
  })

  it('replaces an inlet already fed by another net, instead of stacking a second source', () => {
    // Fixture already wires dial_1/out -> nointerp_1/i as that net's only dest -- rewiring
    // nointerp_1's "i" inlet from a different outlet must drop it from dial_1's net (verified
    // against the real Java PatchController.addConnection()'s own disconnect(il)-before-connect
    // sequence -- an inlet can be the dest of at most one net at a time).
    const before = store.getState().rootDoc!
    expect(before.nets.find((n) => n.sources[0]?.obj === 'dial_1')?.dests).toEqual([
      { obj: 'nointerp_1', inlet: 'i' }
    ])

    store.getState().addNet({ obj: 'object_1', outlet: 'ch3' }, { obj: 'nointerp_1', inlet: 'i' })
    const after = store.getState().rootDoc!

    // dial_1's net had exactly one dest -- losing it empties the net, so the net is gone.
    expect(after.nets.find((n) => n.sources[0]?.obj === 'dial_1')).toBeUndefined()

    // object_1/ch3 already fed scope_1/in + *c_4/in -- the new connection fans into that same net.
    const net = after.nets.find(
      (n) => n.sources[0]?.obj === 'object_1' && n.sources[0]?.outlet === 'ch3'
    )
    expect(net?.dests).toEqual([
      { obj: 'scope_1', inlet: 'in' },
      { obj: '*c_4', inlet: 'in' },
      { obj: 'nointerp_1', inlet: 'i' }
    ])
  })
})

describe('patchStore.removeNetDests', () => {
  it('drops just the targeted dest, keeping the rest of a fan-out net intact', () => {
    const doc = store.getState().rootDoc!
    const netIndex = doc.nets.findIndex((n) => n.dests.length === 3)
    expect(netIndex).toBeGreaterThanOrEqual(0)
    const originalDests = doc.nets[netIndex].dests

    store.getState().removeNetDests([{ netIndex, destIndex: 1 }])

    const after = store.getState().rootDoc!
    expect(after.nets[netIndex].dests).toEqual([originalDests[0], originalDests[2]])
  })

  it('removes the whole net once its last dest is gone', () => {
    const doc = store.getState().rootDoc!
    const netIndex = doc.nets.findIndex((n) => n.dests.length === 1)
    expect(netIndex).toBeGreaterThanOrEqual(0)
    const beforeCount = doc.nets.length

    store.getState().removeNetDests([{ netIndex, destIndex: 0 }])

    expect(store.getState().rootDoc!.nets).toHaveLength(beforeCount - 1)
  })

  it('applies multiple pairs against the same pre-deletion snapshot, unaffected by index shifts', () => {
    const doc = store.getState().rootDoc!
    // pick two distinct single-dest nets; removing the earlier-indexed one first would shift
    // the later one's index if pairs were applied one at a time instead of as one commit.
    const singleDestNetIndices = doc.nets
      .map((n, i) => (n.dests.length === 1 ? i : -1))
      .filter((i) => i >= 0)
    expect(singleDestNetIndices.length).toBeGreaterThanOrEqual(2)
    const [a, b] = singleDestNetIndices
    const beforeCount = doc.nets.length

    store.getState().removeNetDests([
      { netIndex: a, destIndex: 0 },
      { netIndex: b, destIndex: 0 }
    ])

    expect(store.getState().rootDoc!.nets).toHaveLength(beforeCount - 2)
  })
})

describe('patchStore.removeNetEndpoint', () => {
  it('drops just the targeted dest, keeping a fan-out net alive with its other dest intact', () => {
    // fixture: object_1.ch3 -> {scope_1, *c_4} -- a real 2-dest fan-out net.
    const doc = store.getState().rootDoc!
    const netIndex = doc.nets.findIndex(
      (n) => n.sources[0]?.obj === 'object_1' && n.sources[0]?.outlet === 'ch3'
    )
    expect(netIndex).toBeGreaterThanOrEqual(0)
    const beforeCount = doc.nets.length

    store.getState().removeNetEndpoint(netIndex, 'dest', 'scope_1', 'in')

    const after = store.getState().rootDoc!
    expect(after.nets).toHaveLength(beforeCount)
    expect(after.nets[netIndex].dests).toEqual([{ obj: '*c_4', inlet: 'in' }])
  })

  it('removes the whole net once removing its one source leaves zero sources', () => {
    // fixture: sine_1.wave -> *c_1.in -- a single-source, single-dest net.
    const doc = store.getState().rootDoc!
    const netIndex = doc.nets.findIndex(
      (n) => n.sources[0]?.obj === 'sine_1' && n.sources[0]?.outlet === 'wave'
    )
    expect(netIndex).toBeGreaterThanOrEqual(0)
    const beforeCount = doc.nets.length

    store.getState().removeNetEndpoint(netIndex, 'source', 'sine_1', 'wave')

    expect(store.getState().rootDoc!.nets).toHaveLength(beforeCount - 1)
  })

  it('bumps reloadNonce (structural change requires a canvas resync)', () => {
    const doc = store.getState().rootDoc!
    const netIndex = doc.nets.findIndex(
      (n) => n.sources[0]?.obj === 'object_1' && n.sources[0]?.outlet === 'ch3'
    )
    store.getState().removeNetEndpoint(netIndex, 'dest', 'scope_1', 'in')
    expect(store.getState().reloadNonce).toBe(1)
  })
})

describe('patchStore.deleteNetAt', () => {
  it('removes the entire net regardless of how many dests it has', () => {
    const doc = store.getState().rootDoc!
    const netIndex = doc.nets.findIndex(
      (n) => n.sources[0]?.obj === 'object_1' && n.sources[0]?.outlet === 'ch3'
    )
    expect(netIndex).toBeGreaterThanOrEqual(0)
    const beforeCount = doc.nets.length

    store.getState().deleteNetAt(netIndex)

    expect(store.getState().rootDoc!.nets).toHaveLength(beforeCount - 1)
  })
})

describe('patchStore.insertComment', () => {
  it('places a nameless comment node and arms pendingEditNodeId/selectedNodeId with its synthetic id', () => {
    const before = store.getState().rootDoc!
    const expectedId = `__unnamed_${before.nodes.length}`

    store.getState().insertComment(100, 200)

    const after = store.getState().rootDoc!
    const inserted = after.nodes.at(-1)
    expect(inserted).toMatchObject({ kind: 'comment', text: '', x: 100, y: 200 })
    expect(inserted?.name).toBeUndefined()
    expect(store.getState().pendingEditNodeId).toBe(expectedId)
    expect(store.getState().selectedNodeId).toBe(expectedId)
    expect(store.getState().reloadNonce).toBe(1)
  })
})

describe('patchStore.deleteNodes', () => {
  it('removes the node and prunes any net that referenced it', () => {
    const doc = store.getState().rootDoc!
    const referencedBySine1 = doc.nets.filter(
      (n) => n.sources.some((s) => s.obj === 'sine_1') || n.dests.some((d) => d.obj === 'sine_1')
    )
    expect(referencedBySine1.length).toBeGreaterThan(0)

    store.getState().deleteNodes(['sine_1'])

    const after = store.getState().rootDoc!
    expect(after.nodes.find((n) => n.name === 'sine_1')).toBeUndefined()
    expect(
      after.nets.some(
        (n) => n.sources.some((s) => s.obj === 'sine_1') || n.dests.some((d) => d.obj === 'sine_1')
      )
    ).toBe(false)
  })

  it('clears selection when the selected node is deleted', () => {
    store.setState({ selectedNodeId: 'sine_1' })
    store.getState().deleteNodes(['sine_1'])
    expect(store.getState().selectedNodeId).toBeNull()
  })

  it('refuses to delete the fixed audio-out node, even alongside other, real deletions', () => {
    const doc: PatchDocument = {
      nodes: [
        { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/osc/sine', name: 'osc1', x: 0, y: 0, params: [] }
      ],
      nets: [],
      settings: { logueTarget: { module: 'osc' } },
      notes: ''
    }
    store.setState({ rootDoc: doc, past: [], future: [] })

    store.getState().deleteNodes(['out', 'osc1'])

    const after = store.getState().rootDoc!
    expect(after.nodes).toEqual([doc.nodes[0]])
  })

  it('is a total no-op (no undo entry) when only the fixed audio-out node was targeted', () => {
    const doc: PatchDocument = {
      nodes: [{ kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }],
      nets: [],
      settings: { logueTarget: { module: 'osc' } },
      notes: ''
    }
    store.setState({ rootDoc: doc, past: [], future: [] })

    store.getState().deleteNodes(['out'])

    expect(store.getState().rootDoc).toBe(doc)
    expect(store.getState().past).toEqual([])
  })
})

describe('patchStore.insertSpecialObject', () => {
  it('places a plain obj node with the given type/shortId-derived name', () => {
    store.getState().insertSpecialObject('logue/osc/sine', 'sine', 10, 20)
    const doc = store.getState().rootDoc!
    const inserted = doc.nodes.at(-1)
    expect(inserted).toMatchObject({ kind: 'obj', type: 'logue/osc/sine', x: 10, y: 20 })
    expect(inserted!.name).toBe('sine')
  })

  it('disambiguates when the derived name already exists', () => {
    store.getState().insertSpecialObject('logue/osc/sine', 'newosc', 0, 0)
    store.getState().insertSpecialObject('logue/osc/sine', 'newosc', 0, 0)
    const names = store
      .getState()
      .rootDoc!.nodes.slice(-2)
      .map((n) => n.name)
    expect(names).toEqual(['newosc', 'newosc_1'])
  })

  it('does not pre-expose a primitive with no freeLabel param -- stays params: []', () => {
    store.getState().insertSpecialObject('logue/osc/sine', 'plainSine', 0, 0)
    const node = store.getState().rootDoc!.nodes.find((n) => n.name === 'plainSine')
    expect(node).toMatchObject({ params: [] })
  })

  describe('placing a device control (logue/sense/control)', () => {
    function freshLogueDoc(subpatch = false): PatchDocument {
      return {
        nodes: [],
        nets: [],
        settings: { logueTarget: { module: 'osc' }, ...(subpatch && { subpatch: true }) },
        notes: ''
      }
    }

    it('starts with no device control in a root patch (assigned in the Param Matrix)', () => {
      store.setState({ rootDoc: freshLogueDoc() })
      store.getState().insertSpecialObject('logue/sense/control', 'ctl1', 0, 0)
      const node = store.getState().rootDoc!.nodes.find((n) => n.name === 'ctl1')
      expect((node as { params: ParamValue[] }).params).toEqual([{ name: 'VALUE', value: '50' }])
    })

    it('starts from a preset as given, even inside a definition (a knob is shared hardware)', () => {
      store.setState({ rootDoc: freshLogueDoc(true) })
      const preset: ParamValue[] = [
        { name: 'VALUE', value: '50', logueKnob: { nts1mkii: 'shape', 'minilogue-xd': 'shape' } }
      ]
      store.getState().insertSpecialObject('logue/sense/control', 'shape', 0, 0, preset)
      const node = store.getState().rootDoc!.nodes.find((n) => n.name === 'shape')
      expect((node as { params: ParamValue[] }).params).toEqual(preset)
    })

    it('is promoted instead inside a subpatch definition', () => {
      store.setState({ rootDoc: freshLogueDoc(true) })
      store.getState().insertSpecialObject('logue/sense/control', 'ctl1', 0, 0)
      const node = store.getState().rootDoc!.nodes.find((n) => n.name === 'ctl1')
      expect((node as { params: ParamValue[] }).params).toEqual([
        { name: 'VALUE', value: '50', subpatchExpose: { outerName: 'ctl1:VALUE' } }
      ])
    })
  })
})

describe('patchStore.loadDoc', () => {
  it("fixes node overlap from the file's raw Axoloti-native coordinates automatically", () => {
    // spilink.axp's own raw coordinates (tuned for the original Swing UI's tiny ~60x40px
    // frames) really do overlap against this app's much larger rendered node size -- see
    // autoArrange.ts's doc comment and the parametrized fixture test in autoArrange.spec.ts.
    // Confirm that here too, so this test would actually fail if loadDoc stopped fixing it.
    const raw = freshDoc()
    expect(hasAnyOverlap(raw, raw.nodes)).toBe(true)

    store.getState().loadDoc(freshDoc(), '/tmp/fixture.axp')
    const loaded = store.getState().rootDoc!
    expect(hasAnyOverlap(loaded, loaded.nodes)).toBe(false)
  })

  it('preserves position-sort rank (codegen execution order) despite moving nodes apart', () => {
    const beforeRank = rankedIds(freshDoc().nodes)
    store.getState().loadDoc(freshDoc(), '/tmp/fixture.axp')
    expect(rankedIds(store.getState().rootDoc!.nodes)).toEqual(beforeRank)
  })

  it('does not mark the freshly-loaded doc dirty', () => {
    store.getState().loadDoc(freshDoc(), '/tmp/fixture.axp')
    expect(store.getState().dirty).toBe(false)
  })
})

describe('no data loss: mutated documents still round-trip losslessly through the json codec', () => {
  it('move + addNet + insert + delete, then serialize -> parse -> deep-equal', () => {
    const actions = store.getState()
    actions.moveNode('sine_1', 42, 43)
    actions.addNet({ obj: 'hex_1', outlet: 'out' }, { obj: 'out_1', inlet: 'left' })
    actions.insertSpecialObject('osc/test', 'test', 5, 5)
    actions.deleteNodes(['button_1'])

    const mutated = store.getState().rootDoc!
    const roundTripped = parsePatchFile(serializePatchFile(mutated))

    expect(parsePatchFile(serializePatchFile(roundTripped))).toEqual(roundTripped)

    // and nothing was silently dropped: every node/net present in the mutated doc is still
    // present after round-tripping, just possibly reordered within its kind grouping.
    const byKindAndName = (doc: typeof mutated): Set<string> =>
      new Set(doc.nodes.map((n) => `${n.kind}:${n.name ?? ''}:${n.x}:${n.y}`))
    expect(byKindAndName(roundTripped)).toEqual(byKindAndName(mutated))
    expect(roundTripped.nets).toHaveLength(mutated.nets.length)
  })
})

describe('patchStore.setPatchSettings', () => {
  it('edits settings (e.g. logueTarget), leaving the rest of the document untouched', () => {
    store.getState().setPatchSettings({ logueTarget: { module: 'osc' } })
    expect(store.getState().rootDoc!.settings.logueTarget).toEqual({ module: 'osc' })
  })

  it("sets settings.unitName (BuildPanel.tsx's editable device-visible unit name)", () => {
    store.getState().setPatchSettings({ unitName: 'My Patch' })
    expect(store.getState().rootDoc!.settings.unitName).toBe('My Patch')
  })

  it('clears settings.unitName back to undefined (falls back to the file name)', () => {
    store.getState().setPatchSettings({ unitName: 'My Patch' })
    store.getState().setPatchSettings({ unitName: undefined })
    expect(store.getState().rootDoc!.settings.unitName).toBeUndefined()
  })
})

describe('patchStore.setLogueParam', () => {
  it('creates a ParamValue from scratch on a freshly placed primitive (params: [])', () => {
    store.getState().insertSpecialObject('logue/osc/pulse', 'pulse', 0, 0)
    const before = store.getState().rootDoc!.nodes.find((n) => n.name === 'pulse')
    expect(before).toMatchObject({ params: [] })

    store.getState().setLogueParam('pulse', 'WIDTH', '75', undefined)
    const after = store.getState().rootDoc!.nodes.find((n) => n.name === 'pulse')
    expect(after).toMatchObject({ params: [{ name: 'WIDTH', value: '75' }] })
    expect(
      (after as { params: Array<{ logueParamIndex?: LogueParamSlot }> }).params[0].logueParamIndex
    ).toBeUndefined()
  })

  it('updates an existing ParamValue in place rather than creating a duplicate', () => {
    store.getState().insertSpecialObject('logue/osc/pulse', 'pulse2', 0, 0)
    store.getState().setLogueParam('pulse2', 'WIDTH', '20', { nts1mkii: 0 })
    store.getState().setLogueParam('pulse2', 'WIDTH', '30', { nts1mkii: 0 })
    const doc = store.getState().rootDoc!
    const node = doc.nodes.find((n) => n.name === 'pulse2')
    expect(node).toMatchObject({
      params: [{ name: 'WIDTH', value: '30', logueParamIndex: { nts1mkii: 0 } }]
    })
    expect((node as { params: unknown[] }).params).toHaveLength(1)
  })

  it('clears logueParamIndex (unexposes) by passing undefined, without touching value', () => {
    store.getState().insertSpecialObject('logue/osc/pulse', 'pulse3', 0, 0)
    store.getState().setLogueParam('pulse3', 'WIDTH', '40', { nts1mkii: 3 })
    store.getState().setLogueParam('pulse3', 'WIDTH', '40', undefined)
    const node = store.getState().rootDoc!.nodes.find((n) => n.name === 'pulse3')
    expect(node).toMatchObject({ params: [{ name: 'WIDTH', value: '40' }] })
    expect(
      (node as { params: Array<{ logueParamIndex?: LogueParamSlot }> }).params[0].logueParamIndex
    ).toBeUndefined()
  })

  it('is a no-op for a non-obj node or an unresolvable id', () => {
    const before = store.getState().rootDoc
    store.getState().setLogueParam('this-id-does-not-exist', 'WIDTH', '1', { nts1mkii: 0 })
    expect(store.getState().rootDoc).toBe(before)
  })

  it('sets a freely-typed label as a 5th, optional field', () => {
    store.getState().insertSpecialObject('logue/sense/param', 'sense1', 0, 0)
    store.getState().setLogueParam('sense1', 'VALUE', '50', { nts1mkii: 0 }, 'Wave Blend')
    const node = store.getState().rootDoc!.nodes.find((n) => n.name === 'sense1')
    expect(node).toMatchObject({
      params: [
        { name: 'VALUE', value: '50', logueParamIndex: { nts1mkii: 0 }, label: 'Wave Blend' }
      ]
    })
  })

  it('is still a no-op when only the label is unchanged alongside an unchanged value/index', () => {
    store.getState().insertSpecialObject('logue/sense/param', 'sense2', 0, 0)
    store.getState().setLogueParam('sense2', 'VALUE', '50', { nts1mkii: 0 }, 'Blend')
    const before = store.getState().rootDoc
    store.getState().setLogueParam('sense2', 'VALUE', '50', { nts1mkii: 0 }, 'Blend')
    expect(store.getState().rootDoc).toBe(before)
  })

  // The actual new capability this pass adds: each param
  // remembers an INDEPENDENT slot per platform, not one shared slot the whole document commits
  // to. Assigning one platform's slot must never disturb the other's.
  describe('per-platform independence', () => {
    it('keeps each platform’s own slot independent on the same param', () => {
      store.getState().insertSpecialObject('logue/osc/pulse', 'both', 0, 0)
      store.getState().setLogueParam('both', 'WIDTH', '50', { nts1mkii: 4 })
      store.getState().setLogueParam('both', 'WIDTH', '50', { nts1mkii: 4, 'minilogue-xd': 1 })

      const node = store.getState().rootDoc!.nodes.find((n) => n.name === 'both')
      expect(node).toMatchObject({
        params: [
          { name: 'WIDTH', value: '50', logueParamIndex: { nts1mkii: 4, 'minilogue-xd': 1 } }
        ]
      })
    })

    it('clearing one platform’s slot leaves the other platform’s own slot on the same param untouched', () => {
      store.getState().insertSpecialObject('logue/osc/pulse', 'clearOne', 0, 0)
      store.getState().setLogueParam('clearOne', 'WIDTH', '50', { nts1mkii: 2, 'minilogue-xd': 5 })
      store.getState().setLogueParam('clearOne', 'WIDTH', '50', { 'minilogue-xd': 5 })

      const node = store.getState().rootDoc!.nodes.find((n) => n.name === 'clearOne')
      expect(node).toMatchObject({
        params: [{ name: 'WIDTH', value: '50', logueParamIndex: { 'minilogue-xd': 5 } }]
      })
    })
  })
})

describe('patchStore.setPlatformSlotOrder', () => {
  function slotOf(name: string, param = 'WIDTH'): LogueParamSlot | undefined {
    const node = store.getState().rootDoc!.nodes.find((n) => n.name === name)
    return (
      node as { params: Array<{ name: string; logueParamIndex?: LogueParamSlot }> }
    ).params.find((p) => p.name === param)?.logueParamIndex
  }
  const entry = (
    nodeId: string,
    paramName = 'WIDTH'
  ): { nodeId: string; paramName: string; value: string } => ({ nodeId, paramName, value: '50' })

  it('lays params out in list order, gap-free from Param 1 on minilogue-xd', () => {
    store.getState().insertSpecialObject('logue/osc/pulse', 'ordA', 0, 0)
    store.getState().insertSpecialObject('logue/osc/pulse', 'ordB', 0, 0)
    store.getState().setLogueParam('ordA', 'WIDTH', '10', { 'minilogue-xd': 0 })
    store.getState().setLogueParam('ordB', 'WIDTH', '20', { 'minilogue-xd': 4 })

    store.getState().setPlatformSlotOrder('minilogue-xd', [entry('ordB'), entry('ordA')])

    expect(slotOf('ordB')?.['minilogue-xd']).toBe(0)
    expect(slotOf('ordA')?.['minilogue-xd']).toBe(1)
  })

  it("clears the slot of a param left out, keeping its other platform's slot", () => {
    store.getState().insertSpecialObject('logue/osc/pulse', 'ordC', 0, 0)
    store.getState().setLogueParam('ordC', 'WIDTH', '10', { nts1mkii: 5, 'minilogue-xd': 0 })

    store.getState().setPlatformSlotOrder('minilogue-xd', [])

    expect(slotOf('ordC')).toEqual({ nts1mkii: 5 })
  })

  it("starts after nts1mkii's reserved knob pair", () => {
    store.getState().insertSpecialObject('logue/osc/pulse', 'ordD', 0, 0)
    store.getState().setPlatformSlotOrder('nts1mkii', [entry('ordD')])
    expect(slotOf('ordD')?.nts1mkii).toBe(2)
  })

  it('creates the ParamValue for a param still at its spec default', () => {
    store.getState().insertSpecialObject('logue/osc/pulse', 'ordE', 0, 0)
    store.getState().setPlatformSlotOrder('minilogue-xd', [entry('ordE', 'COARSE')])
    expect(slotOf('ordE', 'COARSE')).toEqual({ 'minilogue-xd': 0 })
  })

  it('is one undo step, and a no-op when nothing changes', () => {
    store.getState().insertSpecialObject('logue/osc/pulse', 'ordF', 0, 0)
    store.getState().insertSpecialObject('logue/osc/pulse', 'ordG', 0, 0)
    store.getState().setPlatformSlotOrder('minilogue-xd', [entry('ordF'), entry('ordG')])

    const pastLengthBefore = store.getState().past.length
    store.getState().setPlatformSlotOrder('minilogue-xd', [entry('ordG'), entry('ordF')])
    expect(store.getState().past.length).toBe(pastLengthBefore + 1)

    const before = store.getState().rootDoc
    store.getState().setPlatformSlotOrder('minilogue-xd', [entry('ordG'), entry('ordF')])
    expect(store.getState().rootDoc).toBe(before)

    store.getState().undo()
    expect(slotOf('ordF')?.['minilogue-xd']).toBe(0)
    expect(slotOf('ordG')?.['minilogue-xd']).toBe(1)
  })
})

describe('patchStore knob bindings and slot followers', () => {
  const ref = (nodeId: string, paramName = 'WIDTH'): DeviceRef => ({
    nodeId,
    paramName,
    value: '50'
  })
  type DeviceRef = { nodeId: string; paramName: string; value: string }
  const pv = (name: string, param = 'WIDTH'): ParamValue | undefined =>
    (
      store.getState().rootDoc!.nodes.find((n) => n.name === name) as { params: ParamValue[] }
    ).params.find((p) => p.name === param)

  function threePulses(): void {
    for (const n of ['kA', 'kB', 'kC'])
      store.getState().insertSpecialObject('logue/osc/pulse', n, 0, 0)
    store.getState().setPlatformSlotOrder('minilogue-xd', [ref('kA'), ref('kB'), ref('kC')])
  }

  it('moves a menu param onto a knob and closes the gap it leaves', () => {
    threePulses()
    store.getState().setKnobBinding('minilogue-xd', ref('kA'), 'shape')
    expect(pv('kA')?.logueParamIndex).toBeUndefined()
    expect(pv('kA')?.logueKnob).toEqual({ 'minilogue-xd': 'shape' })
    expect(pv('kB')?.logueParamIndex).toEqual({ 'minilogue-xd': 0 })
    expect(pv('kC')?.logueParamIndex).toEqual({ 'minilogue-xd': 1 })
  })

  it('lets several params share a knob, and unbinds one without touching the others', () => {
    threePulses()
    store.getState().setKnobBinding('minilogue-xd', ref('kA'), 'shape')
    store.getState().setKnobBinding('minilogue-xd', ref('kB'), 'shape')
    store.getState().setKnobBinding('minilogue-xd', ref('kA'), null)
    expect(pv('kA')?.logueKnob).toBeUndefined()
    expect(pv('kA')?.logueParamIndex).toBeUndefined()
    expect(pv('kB')?.logueKnob).toEqual({ 'minilogue-xd': 'shape' })
    expect(pv('kC')?.logueParamIndex).toEqual({ 'minilogue-xd': 0 })
  })

  it('keeps knob bindings through a reorder, and a follower moves with its lead', () => {
    threePulses()
    store.getState().setSlotFollow('minilogue-xd', ref('kC'), { nodeId: 'kA', paramName: 'WIDTH' })
    expect(pv('kC')?.logueFollow).toEqual({ 'minilogue-xd': 0 })
    expect(pv('kC')?.logueParamIndex).toBeUndefined()
    store.getState().insertSpecialObject('logue/osc/pulse', 'kD', 0, 0)
    store.getState().setKnobBinding('nts1mkii', ref('kD'), 'shape-2')

    store.getState().setPlatformSlotOrder('minilogue-xd', [ref('kB'), ref('kA')])
    expect(pv('kA')?.logueParamIndex).toEqual({ 'minilogue-xd': 1 })
    expect(pv('kC')?.logueFollow).toEqual({ 'minilogue-xd': 1 })
    expect(pv('kD')?.logueKnob).toEqual({ nts1mkii: 'shape-2' })
  })

  it('drops a follower when its lead leaves the device', () => {
    threePulses()
    store.getState().setSlotFollow('minilogue-xd', ref('kC'), { nodeId: 'kA', paramName: 'WIDTH' })
    store.getState().setPlatformSlotOrder('minilogue-xd', [ref('kB')])
    expect(pv('kC')?.logueFollow).toBeUndefined()
  })

  it('clears a follower when its lead node is deleted, so Export does not fail on it', () => {
    threePulses()
    store.getState().setSlotFollow('minilogue-xd', ref('kC'), { nodeId: 'kA', paramName: 'WIDTH' })
    store.getState().deleteNodes(['kA'])
    expect(pv('kC')?.logueFollow).toBeUndefined()
    // kB kept its slot; the xd gap it leaves is the Matrix's to close, as before.
    expect(pv('kB')?.logueParamIndex).toEqual({ 'minilogue-xd': 1 })
  })

  it('clears a follower when its lead param entry is removed', () => {
    threePulses()
    store.getState().setSlotFollow('minilogue-xd', ref('kC'), { nodeId: 'kA', paramName: 'WIDTH' })
    store.getState().removeParamValue('kA', 'WIDTH')
    expect(pv('kC')?.logueFollow).toBeUndefined()
  })

  it('creates the ParamValue for a param still at its default, and is one undo step', () => {
    store.getState().insertSpecialObject('logue/osc/pulse', 'kE', 0, 0)
    const before = store.getState().past.length
    store.getState().setKnobBinding('nts1mkii', ref('kE', 'COARSE'), 'shape')
    expect(pv('kE', 'COARSE')).toEqual({
      name: 'COARSE',
      value: '50',
      logueKnob: { nts1mkii: 'shape' }
    })
    expect(store.getState().past.length).toBe(before + 1)
    store.getState().undo()
    expect(pv('kE', 'COARSE')).toBeUndefined()
  })
})

describe('patchStore.setPlatformSlotOrder on a migrated knob reader', () => {
  it('ends the knob binding on that platform only, so the patch still builds', () => {
    const doc: PatchDocument = {
      nodes: [
        { kind: 'obj', type: 'logue/osc/saw', name: 's', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/sense/shape', name: 'k', x: 0, y: 100, params: [] },
        { kind: 'obj', type: 'logue/gain/vca', name: 'a', x: 200, y: 0, params: [] },
        { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 400, y: 0, params: [] }
      ],
      nets: [
        { sources: [{ obj: 's', outlet: 'out' }], dests: [{ obj: 'a', inlet: 'in' }] },
        { sources: [{ obj: 'k', outlet: 'unipolar' }], dests: [{ obj: 'a', inlet: 'gain' }] },
        { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: { logueTarget: { module: 'osc' } },
      notes: ''
    }
    store.getState().loadDoc(doc, null)
    const k = (): PatchNode => store.getState().rootDoc!.nodes.find((n) => n.name === 'k')!
    expect(k()).toMatchObject({ type: 'logue/sense/control' })

    store
      .getState()
      .setPlatformSlotOrder('minilogue-xd', [{ nodeId: 'k', paramName: 'VALUE', value: '0' }])

    const [value] = (k() as { params: ParamValue[] }).params
    expect(value.logueParamIndex).toEqual({ 'minilogue-xd': 0 })
    expect(value.logueKnob).toEqual({ nts1mkii: 'shape' })
    const withLabel = store.getState().rootDoc!
    ;(
      withLabel.nodes.find((n) => n.name === 'k') as { params: { label?: string }[] }
    ).params[0].label = 'Amt'
    expect(() => generateOldGenOscUnit(withLabel, { name: 'T' })).not.toThrow()
  })
})

describe('patchStore.replaceNode', () => {
  // No `platform` on `logueTarget` any more; every
  // test below that relies on a slot landing on minilogue-xd specifically does so because
  // `logue/sense/param` itself is minilogue-xd-only (`autoExposedSlots` loops over the PLACED
  // primitive's own `platforms`), not because of anything set here.
  function freshLogueDoc(nodes: PatchNode[], nets: Net[] = []): PatchDocument {
    return {
      nodes,
      nets,
      settings: { logueTarget: { module: 'osc' } },
      notes: ''
    }
  }

  it("keeps the node's name/position, and leaves nets untouched when the new primitive shares the same port names", () => {
    const doc = freshLogueDoc(
      [
        { kind: 'obj', type: 'logue/osc/saw', name: 'osc1', x: 10, y: 20, params: [] },
        { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
      ],
      [{ sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }]
    )
    store.setState({ rootDoc: doc })

    store.getState().replaceNode('osc1', 'logue/osc/triangle')

    const after = store.getState().rootDoc!
    expect(after.nodes.find((n) => n.name === 'osc1')).toMatchObject({
      type: 'logue/osc/triangle',
      name: 'osc1',
      x: 10,
      y: 20
    })
    // triangle shares saw's own 'out' outlet name -- nothing to remap
    expect(after.nets).toEqual(doc.nets)
  })

  it("carries over a same-named param's value/logueParamIndex to the new primitive", () => {
    const doc = freshLogueDoc([
      {
        kind: 'obj',
        type: 'logue/osc/saw',
        name: 'osc1',
        x: 0,
        y: 0,
        params: [{ name: 'COARSE', value: '5', logueParamIndex: { 'minilogue-xd': 2 } }]
      }
    ])
    store.setState({ rootDoc: doc })

    store.getState().replaceNode('osc1', 'logue/osc/triangle')

    const node = store.getState().rootDoc!.nodes.find((n) => n.name === 'osc1')
    expect(node).toMatchObject({
      type: 'logue/osc/triangle',
      params: expect.arrayContaining([
        expect.objectContaining({
          name: 'COARSE',
          value: '5',
          logueParamIndex: { 'minilogue-xd': 2 }
        })
      ])
    })
  })

  it('drops a param absent from the new primitive, releasing its exposed slot for real', () => {
    const doc = freshLogueDoc([
      {
        kind: 'obj',
        type: 'logue/osc/pulse',
        name: 'osc1',
        x: 0,
        y: 0,
        params: [{ name: 'WIDTH', value: '60', logueParamIndex: { 'minilogue-xd': 0 } }]
      }
    ])
    store.setState({ rootDoc: doc })

    store.getState().replaceNode('osc1', 'logue/osc/sine')

    const node = store.getState().rootDoc!.nodes.find((n) => n.name === 'osc1')
    expect(
      (node as { params: Array<{ name: string }> }).params.some((p) => p.name === 'WIDTH')
    ).toBe(false)
  })

  it("clamps a carried value into the new primitive's own param range", () => {
    // logue/util/constant's VALUE is -100..100; logue/sense/param's own VALUE is 0..100.
    const doc = freshLogueDoc([
      {
        kind: 'obj',
        type: 'logue/util/constant',
        name: 'const1',
        x: 0,
        y: 0,
        params: [{ name: 'VALUE', value: '-80' }]
      }
    ])
    store.setState({ rootDoc: doc })

    store.getState().replaceNode('const1', 'logue/sense/param')

    const node = store.getState().rootDoc!.nodes.find((n) => n.name === 'const1')
    expect(node).toMatchObject({ params: [{ name: 'VALUE', value: '0' }] })
  })

  it('starts a freeLabel param with no counterpart on the old primitive unassigned, mirroring insertSpecialObject', () => {
    const doc = freshLogueDoc([
      { kind: 'obj', type: 'logue/osc/sine', name: 'osc1', x: 0, y: 0, params: [] }
    ])
    store.setState({ rootDoc: doc })

    store.getState().replaceNode('osc1', 'logue/sense/control')

    const node = store.getState().rootDoc!.nodes.find((n) => n.name === 'osc1')
    expect((node as { params: ParamValue[] }).params).toEqual([{ name: 'VALUE', value: '50' }])
  })

  it('remaps an outlet reference absent from the new primitive to its first declared outlet (multi-outlet -> single-outlet)', () => {
    const doc = freshLogueDoc(
      [
        { kind: 'obj', type: 'logue/filter/svf', name: 'filt1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
      ],
      [{ sources: [{ obj: 'filt1', outlet: 'lp' }], dests: [{ obj: 'out', inlet: 'in' }] }]
    )
    store.setState({ rootDoc: doc })

    store.getState().replaceNode('filt1', 'logue/filter/lowpass-cheap')

    const net = store.getState().rootDoc!.nets.find((n) => n.dests[0]?.obj === 'out')
    expect(net?.sources).toEqual([{ obj: 'filt1', outlet: 'out' }])
  })

  it('remaps the reverse direction too (single-outlet -> multi-outlet) to the new first declared outlet', () => {
    const doc = freshLogueDoc(
      [
        { kind: 'obj', type: 'logue/filter/lowpass-cheap', name: 'filt1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
      ],
      [{ sources: [{ obj: 'filt1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }]
    )
    store.setState({ rootDoc: doc })

    store.getState().replaceNode('filt1', 'logue/filter/svf')

    const net = store.getState().rootDoc!.nets.find((n) => n.dests[0]?.obj === 'out')
    expect(net?.sources).toEqual([{ obj: 'filt1', outlet: 'lp' }])
  })

  it('leaves an inlet reference with no exact name match on the new primitive untouched, rather than pruning it', () => {
    const doc = freshLogueDoc(
      [
        { kind: 'obj', type: 'logue/filter/svf', name: 'filt1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/osc/sine', name: 'mod1', x: 0, y: 0, params: [] }
      ],
      [
        {
          sources: [{ obj: 'mod1', outlet: 'out' }],
          dests: [{ obj: 'filt1', inlet: 'resonance' }]
        }
      ]
    )
    store.setState({ rootDoc: doc })

    // lowpass-cheap has no 'resonance' inlet at all -- svf's own is the one being replaced away.
    store.getState().replaceNode('filt1', 'logue/filter/lowpass-cheap')

    expect(store.getState().rootDoc!.nets).toEqual(doc.nets)
  })

  it('is a no-op for the fixed audio-out node, an unresolvable newType, or an unchanged type', () => {
    const doc = freshLogueDoc([
      { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] },
      { kind: 'obj', type: 'logue/osc/sine', name: 'osc1', x: 0, y: 0, params: [] }
    ])
    store.setState({ rootDoc: doc })
    const before = store.getState().rootDoc

    store.getState().replaceNode('out', 'logue/osc/sine')
    expect(store.getState().rootDoc).toBe(before)

    store.getState().replaceNode('osc1', 'logue/does/not-exist')
    expect(store.getState().rootDoc).toBe(before)

    store.getState().replaceNode('osc1', 'logue/osc/sine')
    expect(store.getState().rootDoc).toBe(before)
  })

  it('bumps reloadNonce (structural change) and is undoable', () => {
    const doc = freshLogueDoc([
      { kind: 'obj', type: 'logue/osc/saw', name: 'osc1', x: 0, y: 0, params: [] }
    ])
    store.setState({ rootDoc: doc, reloadNonce: 0 })
    const before = store.getState().rootDoc

    store.getState().replaceNode('osc1', 'logue/osc/triangle')
    expect(store.getState().reloadNonce).toBe(1)

    store.getState().undo()
    expect(store.getState().rootDoc).toBe(before)
  })

  it('moves stereo wires onto the mono sibling, dropping an r wire that only repeats its l one', () => {
    const doc = freshLogueDoc(
      [
        { kind: 'obj', type: 'logue/osc/saw', name: 'a', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/osc/noise', name: 'n', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/osc/sine', name: 's', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/mix/stereo-mix2', name: 'mx', x: 0, y: 0, params: [] }
      ],
      [
        // l1 and r1 from the same source, l2 and r2 from two different ones
        {
          sources: [{ obj: 'a', outlet: 'out' }],
          dests: [
            { obj: 'mx', inlet: 'l1' },
            { obj: 'mx', inlet: 'r1' }
          ]
        },
        { sources: [{ obj: 's', outlet: 'out' }], dests: [{ obj: 'mx', inlet: 'r2' }] },
        { sources: [{ obj: 'n', outlet: 'out' }], dests: [{ obj: 'mx', inlet: 'l2' }] }
      ]
    )
    store.setState({ rootDoc: doc })

    store.getState().replaceNode('mx', 'logue/mix/mix2')

    expect(store.getState().rootDoc!.nets).toEqual([
      { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'mx', inlet: 'in1' }] },
      // lost to l2: stays as a visible stale wire, not guessed elsewhere
      { sources: [{ obj: 's', outlet: 'out' }], dests: [{ obj: 'mx', inlet: 'r2' }] },
      { sources: [{ obj: 'n', outlet: 'out' }], dests: [{ obj: 'mx', inlet: 'in2' }] }
    ])
  })

  it('feeds both sides of the stereo sibling from a mono wire', () => {
    const doc = freshLogueDoc(
      [
        { kind: 'obj', type: 'logue/osc/saw', name: 'a', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/mix/mix2', name: 'mx', x: 0, y: 0, params: [] }
      ],
      [{ sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'mx', inlet: 'in2' }] }]
    )
    store.setState({ rootDoc: doc })

    store.getState().replaceNode('mx', 'logue/mix/stereo-mix2')

    expect(store.getState().rootDoc!.nets).toEqual([
      {
        sources: [{ obj: 'a', outlet: 'out' }],
        dests: [
          { obj: 'mx', inlet: 'l2' },
          { obj: 'mx', inlet: 'r2' }
        ]
      }
    ])
  })
})

describe('patchStore undo/redo', () => {
  it('reverts and reapplies a single moveNode', () => {
    const before = store.getState().rootDoc!
    store.getState().moveNode('sine_1', 999, 888)
    expect(store.getState().rootDoc!.nodes.find((n) => n.name === 'sine_1')).toMatchObject({
      x: 999,
      y: 888
    })

    store.getState().undo()
    expect(store.getState().rootDoc).toBe(before)
    expect(store.getState().dirty).toBe(false)

    store.getState().redo()
    expect(store.getState().rootDoc!.nodes.find((n) => n.name === 'sine_1')).toMatchObject({
      x: 999,
      y: 888
    })
    expect(store.getState().dirty).toBe(true)
  })

  it('reads dirty against the last save, not the undo depth', () => {
    store.getState().moveNode('sine_1', 1, 1)
    store.getState().markSaved(store.getState().rootDoc!)
    expect(store.getState().dirty).toBe(false)

    store.getState().undo()
    expect(store.getState().dirty).toBe(true)
    store.getState().redo()
    expect(store.getState().dirty).toBe(false)

    store.getState().moveNode('sine_1', 2, 2)
    store.getState().undo()
    expect(store.getState().dirty).toBe(false)
  })

  it('keeps an edit made while a save was in flight dirty', () => {
    const written = store.getState().rootDoc!
    store.getState().moveNode('sine_1', 3, 3)
    store.getState().markSaved(written)
    expect(store.getState().dirty).toBe(true)
  })

  it('records nothing for a gesture that changed nothing', () => {
    store.getState().moveNode('sine_1', 1, 1)
    store.getState().undo()
    expect(store.getState().future).toHaveLength(1)

    store.getState().beginGesture()
    store.getState().endGesture()

    expect(store.getState().past).toHaveLength(0)
    expect(store.getState().future).toHaveLength(1)
    expect(store.getState().pendingUndo).toBeNull()
  })

  it('records nothing for a mutation that changed nothing', () => {
    const node = store.getState().rootDoc!.nodes.find((n) => n.name === 'sine_1')!
    const nonce = store.getState().reloadNonce

    store.getState().moveNode('sine_1', node.x, node.y)
    store.getState().removeNetEndpoint(9999, 'source', 'sine_1', 'out')

    expect(store.getState().past).toHaveLength(0)
    expect(store.getState().dirty).toBe(false)
    expect(store.getState().reloadNonce).toBe(nonce)
  })

  it('bumps reloadNonce on undo/redo (a structural change, same as delete/insert)', () => {
    store.getState().moveNode('sine_1', 1, 1)
    const nonceAfterMove = store.getState().reloadNonce
    store.getState().undo()
    expect(store.getState().reloadNonce).toBeGreaterThan(nonceAfterMove)
    const nonceAfterUndo = store.getState().reloadNonce
    store.getState().redo()
    expect(store.getState().reloadNonce).toBeGreaterThan(nonceAfterUndo)
  })

  it('is a no-op when there is nothing to undo/redo', () => {
    const before = store.getState().rootDoc
    store.getState().undo()
    expect(store.getState().rootDoc).toBe(before)
    store.getState().redo()
    expect(store.getState().rootDoc).toBe(before)
  })

  it('clears the redo stack on a new edit after an undo', () => {
    store.getState().moveNode('sine_1', 1, 1)
    store.getState().moveNode('sine_1', 2, 2)
    store.getState().undo()
    expect(store.getState().future.length).toBe(1)

    store.getState().moveNode('sine_1', 3, 3)
    expect(store.getState().future.length).toBe(0)
    store.getState().redo() // no-op, nothing to redo
    expect(store.getState().rootDoc!.nodes.find((n) => n.name === 'sine_1')).toMatchObject({
      x: 3,
      y: 3
    })
  })

  it('loadDoc and newDoc reset undo history', () => {
    store.getState().moveNode('sine_1', 1, 1)
    expect(store.getState().past.length).toBeGreaterThan(0)

    store.getState().newDoc()
    expect(store.getState().past).toEqual([])
    expect(store.getState().future).toEqual([])

    store.getState().loadDoc(freshDoc(), '/tmp/other.axp')
    expect(store.getState().past).toEqual([])
    expect(store.getState().future).toEqual([])
  })

  it('newDoc seeds a fresh logue-target document with exactly one fixed audio-out node', () => {
    store.getState().newDoc({ module: 'osc' })
    const nodes = store.getState().rootDoc!.nodes
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE })
  })

  it('newDoc with no logueTarget stays empty (the fixed sink only means anything for a logue document)', () => {
    store.getState().newDoc()
    expect(store.getState().rootDoc!.nodes).toEqual([])
  })

  it('a gesture (beginGesture/endGesture) collapses many moveNode calls into ONE undo entry', () => {
    const before = store.getState().rootDoc!
    store.getState().beginGesture()
    for (let i = 0; i < 20; i++) {
      store.getState().moveNode('sine_1', i, i)
    }
    store.getState().endGesture()

    expect(store.getState().past.length).toBe(1)
    store.getState().undo()
    expect(store.getState().rootDoc).toBe(before)
  })

  it('beginGesture is idempotent while a gesture is already pending (keeps the earliest snapshot)', () => {
    const before = store.getState().rootDoc!
    store.getState().beginGesture()
    store.getState().moveNode('sine_1', 1, 1)
    store.getState().beginGesture() // should no-op, not overwrite pendingUndo
    store.getState().moveNode('sine_1', 2, 2)
    store.getState().endGesture()

    expect(store.getState().past).toEqual([before])
  })

  it('endGesture without a pending gesture is a harmless no-op', () => {
    const pastBefore = store.getState().past
    store.getState().endGesture()
    expect(store.getState().past).toBe(pastBefore)
  })
})

describe('patchStore.renameNode', () => {
  it('renames the node and rewrites every net reference to it', () => {
    const before = store.getState().rootDoc!
    const netsReferencingSine1Before = before.nets.filter(
      (n) => n.sources.some((s) => s.obj === 'sine_1') || n.dests.some((d) => d.obj === 'sine_1')
    )
    expect(netsReferencingSine1Before.length).toBeGreaterThan(0)

    store.getState().renameNode('sine_1', 'osc1')

    const after = store.getState().rootDoc!
    expect(after.nodes.find((n) => n.name === 'sine_1')).toBeUndefined()
    expect(after.nodes.find((n) => n.name === 'osc1')).toBeDefined()
    expect(
      after.nets.some(
        (n) => n.sources.some((s) => s.obj === 'sine_1') || n.dests.some((d) => d.obj === 'sine_1')
      )
    ).toBe(false)
    const netsReferencingOsc1After = after.nets.filter(
      (n) => n.sources.some((s) => s.obj === 'osc1') || n.dests.some((d) => d.obj === 'osc1')
    )
    expect(netsReferencingOsc1After.length).toBe(netsReferencingSine1Before.length)
  })

  it('sanitizes illegal characters the same way insert does', () => {
    store.getState().renameNode('sine_1', 'my osc!')
    expect(store.getState().rootDoc!.nodes.find((n) => n.name === 'my_osc_')).toBeDefined()
  })

  it('disambiguates a collision with a different node', () => {
    store.getState().renameNode('sine_1', 'hex_1')
    const names = store.getState().rootDoc!.nodes.map((n) => n.name)
    expect(names).toContain('hex_1_1')
    expect(names).toContain('hex_1') // the original hex_1 is untouched
  })

  it('is a no-op when the new name is empty', () => {
    // Each illegal character sanitizes to a literal underscore (matching uniqueNodeName's own
    // convention), so this only ever produces an empty *sanitized* name when the input itself
    // was already empty -- there's no non-empty input that sanitizes down to nothing.
    const before = store.getState().rootDoc
    store.getState().renameNode('sine_1', '')
    expect(store.getState().rootDoc).toBe(before)
  })

  it('is a no-op when the name is unchanged', () => {
    const before = store.getState().rootDoc
    store.getState().renameNode('sine_1', 'sine_1')
    expect(store.getState().rootDoc).toBe(before)
    expect(store.getState().past).toEqual([])
  })

  it('follows selection to the new name', () => {
    store.setState({ selectedNodeId: 'sine_1' })
    store.getState().renameNode('sine_1', 'osc1')
    expect(store.getState().selectedNodeId).toBe('osc1')
  })

  it('is undoable', () => {
    const before = store.getState().rootDoc!
    store.getState().renameNode('sine_1', 'osc1')
    store.getState().undo()
    expect(store.getState().rootDoc).toBe(before)
  })
})

describe('patchStore.setCommentText', () => {
  function findComment(): { id: string; text: string } {
    const doc = store.getState().rootDoc!
    const index = doc.nodes.findIndex((n) => n.kind === 'comment')
    expect(index).toBeGreaterThanOrEqual(0)
    const node = doc.nodes[index]
    return { id: nodeId(node, index), text: node.kind === 'comment' ? node.text : '' }
  }

  it("edits the comment's text", () => {
    const { id } = findComment()
    store.getState().setCommentText(id, 'a real note')
    const doc = store.getState().rootDoc!
    const updated = doc.nodes.find((n, i) => nodeId(n, i) === id)
    expect(updated).toMatchObject({ kind: 'comment', text: 'a real note' })
  })

  it('is a no-op when the text is unchanged', () => {
    const { id, text } = findComment()
    const before = store.getState().rootDoc
    store.getState().setCommentText(id, text)
    expect(store.getState().rootDoc).toBe(before)
  })

  it('is undoable', () => {
    const { id } = findComment()
    const before = store.getState().rootDoc!
    store.getState().setCommentText(id, 'a real note')
    store.getState().undo()
    expect(store.getState().rootDoc).toBe(before)
  })
})

describe('serializeSelectionForClipboard', () => {
  it('includes only the selected nodes and only nets with both ends inside the selection', () => {
    // fixture: sine_1(42,56) --wave--> *c_1(140,56) --out--> object_1 (outside the selection)
    const doc = store.getState().rootDoc!
    const xml = serializeSelectionForClipboard(doc, ['sine_1', '*c_1'])
    const parsed = parsePatchFile(xml)

    expect(parsed.nodes.map((n) => n.name).sort()).toEqual(['*c_1', 'sine_1'])
    expect(parsed.nets).toEqual([
      { sources: [{ obj: 'sine_1', outlet: 'wave' }], dests: [{ obj: '*c_1', inlet: 'in' }] }
    ])
  })

  it('omits every net when nothing selected is wired to anything else selected', () => {
    const doc = store.getState().rootDoc!
    const xml = serializeSelectionForClipboard(doc, ['hex_1'])
    const parsed = parsePatchFile(xml)
    expect(parsed.nodes).toHaveLength(1)
    expect(parsed.nets).toEqual([])
  })
})

describe('patchStore.duplicateNodes', () => {
  it('copies nodes with their values and inner wires, dropping menu slots but keeping knobs', () => {
    const lfo: PatchNode = {
      kind: 'obj',
      type: 'logue/lfo/sine-lfo',
      name: 'lfo',
      x: 0,
      y: 0,
      params: [
        { name: 'RATE', value: '42', logueParamIndex: { nts1mkii: 3 } },
        { name: 'DEPTH', value: '7', logueKnob: { 'minilogue-xd': 'shape' } }
      ]
    }
    const vca: PatchNode = {
      kind: 'obj',
      type: 'logue/gain/vca',
      name: 'vca',
      x: 200,
      y: 0,
      params: [{ name: 'GAIN', value: '30', logueFollow: { nts1mkii: 3 } }]
    }
    const net: Net = {
      sources: [{ obj: 'lfo', outlet: 'out' }],
      dests: [{ obj: 'vca', inlet: 'gain' }]
    }
    store.setState({
      rootDoc: { nodes: [lfo, vca], nets: [net], settings: {}, notes: '' }
    })

    store.getState().duplicateNodes(['lfo', 'vca'], { x: 420, y: 0 })

    const after = store.getState().rootDoc!
    expect(after.nodes).toHaveLength(4)
    const lfoCopy = after.nodes.find((n) => n.name === 'lfo_1')!
    const vcaCopy = after.nodes.find((n) => n.name === 'vca_1')!
    expect(lfoCopy).toMatchObject({ x: 420, y: 0 })
    expect(lfoCopy.kind === 'obj' && lfoCopy.params).toEqual([
      { name: 'RATE', value: '42' },
      { name: 'DEPTH', value: '7', logueKnob: { 'minilogue-xd': 'shape' } }
    ])
    expect(vcaCopy.kind === 'obj' && vcaCopy.params).toEqual([{ name: 'GAIN', value: '30' }])
    // The originals keep their slots, and the copies are wired to each other, not to them.
    expect(after.nodes[0]).toEqual(lfo)
    expect(
      after.nets.some((n) => n.sources[0]?.obj === 'lfo_1' && n.dests[0]?.obj === 'vca_1')
    ).toBe(true)
  })
})

describe('patchStore.pasteFromClipboard', () => {
  it('renames on collision and rewires the pasted subgraph internally, snapping position to a grid offset from the cursor', () => {
    const doc = store.getState().rootDoc!
    const xml = serializeSelectionForClipboard(doc, ['sine_1', '*c_1'])

    store.getState().pasteFromClipboard(xml, { x: 500, y: 500 })

    const after = store.getState().rootDoc!
    // both original nodes untouched, collision renamed the pasted copies
    expect(after.nodes.some((n) => n.name === 'sine_1')).toBe(true)
    expect(after.nodes.some((n) => n.name === '*c_1')).toBe(true)
    const pastedSine = after.nodes.find((n) => n.name === 'sine_1_1')
    const pastedMul = after.nodes.find((n) => n.name === '*c_1_1')
    expect(pastedSine).toBeDefined()
    expect(pastedMul).toBeDefined()

    // original bbox top-left is (42,56) (both nodes share y=56); grid=14, cursor=(500,500)
    // offset = 14*round((500-42)/14) = 462 (x), 14*round((500-56)/14) = 448 (y)
    expect(pastedSine).toMatchObject({ x: 42 + 462, y: 56 + 448 })
    expect(pastedMul).toMatchObject({ x: 140 + 462, y: 56 + 448 })

    // internal wiring preserved, rewired to the new names -- and no dangling ref to the
    // original (unrenamed) nodes
    const pastedNet = after.nets.find(
      (n) => n.sources[0]?.obj === 'sine_1_1' && n.dests[0]?.obj === '*c_1_1'
    )
    expect(pastedNet).toBeDefined()
  })

  it('keeps names unchanged when pasting into a document with no collision', () => {
    store.setState({
      rootDoc: { nodes: [], nets: [], settings: {}, notes: '' },
      selectedNodeId: null
    })
    const sourceDoc = structuredClone(FIXTURE)
    const xml = serializeSelectionForClipboard(sourceDoc, ['sine_1', '*c_1'])

    store.getState().pasteFromClipboard(xml, null)

    const after = store.getState().rootDoc!
    expect(after.nodes.map((n) => n.name).sort()).toEqual(['*c_1', 'sine_1'])
    // no cursor position -> fixed one-grid-cell nudge from the copied originals
    expect(after.nodes.find((n) => n.name === 'sine_1')).toMatchObject({ x: 42 + 14, y: 56 + 14 })
  })

  it('drops pasted menu slots and follows but keeps knob bindings', () => {
    const node: PatchNode = {
      kind: 'obj',
      type: 'logue/util/constant',
      name: 'k',
      x: 0,
      y: 0,
      params: [
        { name: 'VALUE', value: '5', logueParamIndex: { 'minilogue-xd': 0 }, label: 'AMT' },
        {
          name: 'OTHER',
          value: '1',
          logueFollow: { nts1mkii: 2 },
          logueKnob: { nts1mkii: 'shape' }
        }
      ]
    }
    const source: PatchDocument = { nodes: [node], nets: [], settings: {}, notes: '' }
    store.setState({ rootDoc: { nodes: [], nets: [], settings: {}, notes: '' } })

    store.getState().pasteFromClipboard(serializeSelectionForClipboard(source, ['k']), null)

    const pasted = store.getState().rootDoc!.nodes[0]
    expect(pasted.kind === 'obj' && pasted.params).toEqual([
      { name: 'VALUE', value: '5', label: 'AMT' },
      { name: 'OTHER', value: '1', logueKnob: { nts1mkii: 'shape' } }
    ])
  })

  it('is a no-op for clipboard text that is not parseable patch XML', () => {
    const before = store.getState().rootDoc

    store.getState().pasteFromClipboard('not xml at all, just some copied text', null)

    expect(store.getState().rootDoc).toBe(before)
  })

  it('selects a single pasted unnamed node by its real index', () => {
    const comment: PatchNode = { kind: 'comment', type: 'patch/comment', text: 'hi', x: 0, y: 0 }
    const source: PatchDocument = { nodes: [comment], nets: [], settings: {}, notes: '' }
    const xml = serializeSelectionForClipboard(source, ['__unnamed_0'])
    const lengthBefore = store.getState().rootDoc!.nodes.length

    store.getState().pasteFromClipboard(xml, null)

    expect(store.getState().selectedNodeId).toBe(`__unnamed_${lengthBefore}`)
  })

  it('bumps reloadNonce and is undoable', () => {
    const doc = store.getState().rootDoc!
    const xml = serializeSelectionForClipboard(doc, ['sine_1', '*c_1'])
    const before = store.getState().rootDoc

    store.getState().pasteFromClipboard(xml, null)
    expect(store.getState().reloadNonce).toBe(1)

    store.getState().undo()
    expect(store.getState().rootDoc).toBe(before)
  })
})

describe('newDoc for an effect', () => {
  it('starts as a stereo pass-through that builds', async () => {
    const s = createStore<PatchStoreState>(createPatchStoreState)
    s.getState().newDoc({ module: 'delfx' })
    const doc = s.getState().rootDoc!
    expect(doc.nodes.map((n) => (n.kind === 'obj' ? n.type : n.kind))).toEqual([
      'logue/io/audio-in',
      LOGUE_AUDIO_OUT_TYPE
    ])
    expect(doc.nets).toEqual([
      { sources: [{ obj: 'audio-in', outlet: 'l' }], dests: [{ obj: 'audio-out', inlet: 'l' }] },
      { sources: [{ obj: 'audio-in', outlet: 'r' }], dests: [{ obj: 'audio-out', inlet: 'r' }] }
    ])
    const { generateFxUnit } = await import('../logue-codegen/src/nts1mkii/generateFxUnit')
    expect(() => generateFxUnit(doc, { name: 'new' })).not.toThrow()
  })

  it('never deletes or replaces its audio-in', () => {
    const s = createStore<PatchStoreState>(createPatchStoreState)
    s.getState().newDoc({ module: 'modfx' })
    s.getState().deleteNodes(['audio-in'])
    s.getState().replaceNode('audio-in', 'logue/osc/sine')
    expect(
      s.getState().rootDoc!.nodes.some((n) => n.kind === 'obj' && n.type === 'logue/io/audio-in')
    ).toBe(true)
  })

  it("lays menu params out after an effect's fixed rows", () => {
    const s = createStore<PatchStoreState>(createPatchStoreState)
    s.getState().newDoc({ module: 'delfx' })
    s.getState().insertSpecialObject('logue/util/long-delay', 'long-delay', 200, 180)
    const name =
      s.getState().rootDoc!.nodes[2].kind === 'obj' ? s.getState().rootDoc!.nodes[2].name! : ''
    s.getState().setPlatformSlotOrder('nts1mkii', [
      { nodeId: name, paramName: 'FEEDBACK', value: '35' }
    ])
    const node = s.getState().rootDoc!.nodes[2]
    const fb = node.kind === 'obj' ? node.params.find((p) => p.name === 'FEEDBACK') : undefined
    expect(fb?.logueParamIndex).toEqual({ nts1mkii: 3 })
  })
})

describe('setEffectModule', () => {
  function delayDoc(module: 'modfx' | 'delfx'): StoreApi<PatchStoreState> {
    const s = createStore<PatchStoreState>(createPatchStoreState)
    s.getState().newDoc({ module })
    s.getState().insertSpecialObject('logue/util/long-delay', 'long-delay', 200, 180)
    // In between audio-in's and audio-out's left sides (net 0 is the template's l -> l).
    const name = s.getState().rootDoc!.nodes[2].name!
    s.getState().deleteNetAt(0)
    s.getState().addNet({ obj: 'audio-in', outlet: 'l' }, { obj: name, inlet: 'in' })
    s.getState().addNet({ obj: name, outlet: 'out' }, { obj: 'audio-out', inlet: 'l' })
    return s
  }
  const delayParam = (s: StoreApi<PatchStoreState>, name: string): ParamValue | undefined => {
    const node = s
      .getState()
      .rootDoc!.nodes.find((n) => n.kind === 'obj' && n.type === 'logue/util/long-delay')
    return node?.kind === 'obj' ? node.params.find((p) => p.name === name) : undefined
  }
  const nodeName = (s: StoreApi<PatchStoreState>): string =>
    s.getState().rootDoc!.nodes.find((n) => n.kind === 'obj' && n.type === 'logue/util/long-delay')!
      .name!

  it('Mod -> Delay moves a menu param past the new MIX row, and it still builds', async () => {
    const s = delayDoc('modfx')
    s.getState().setPlatformSlotOrder('nts1mkii', [
      { nodeId: nodeName(s), paramName: 'FEEDBACK', value: '35' }
    ])
    expect(delayParam(s, 'FEEDBACK')?.logueParamIndex).toEqual({ nts1mkii: 2 })
    expect(s.getState().setEffectModule('delfx')).toEqual([])
    expect(delayParam(s, 'FEEDBACK')?.logueParamIndex).toEqual({ nts1mkii: 3 })
    const { generateFxUnit } = await import('../logue-codegen/src/nts1mkii/generateFxUnit')
    expect(() => generateFxUnit(s.getState().rootDoc!, { name: 'x' })).not.toThrow()
  })

  it('Delay -> Mod removes a MIX binding (reported), and undo brings it back', async () => {
    const s = delayDoc('delfx')
    s.getState().setKnobBinding(
      'nts1mkii',
      { nodeId: nodeName(s), paramName: 'MIX', value: '50' },
      'mix'
    )
    s.getState().setKnobBinding(
      'nts1mkii',
      { nodeId: nodeName(s), paramName: 'TIME', value: '25' },
      'time'
    )
    expect(s.getState().setEffectModule('modfx')).toEqual([`${nodeName(s)} · MIX`])
    expect(delayParam(s, 'MIX')?.logueKnob?.nts1mkii).toBeUndefined()
    expect(delayParam(s, 'TIME')?.logueKnob?.nts1mkii).toBe('time')
    expect(s.getState().rootDoc!.settings.logueTarget).toEqual({ module: 'modfx' })
    const { generateFxUnit } = await import('../logue-codegen/src/nts1mkii/generateFxUnit')
    expect(() => generateFxUnit(s.getState().rootDoc!, { name: 'x' })).not.toThrow()
    s.getState().undo()
    expect(s.getState().rootDoc!.settings.logueTarget).toEqual({ module: 'delfx' })
    expect(delayParam(s, 'MIX')?.logueKnob?.nts1mkii).toBe('mix')
  })

  it('removes a MIX binding on both devices, named once, and undo restores both', async () => {
    const s = delayDoc('delfx')
    // RANGE 0 (64 KB): the default 1.4 s line is more than an xd modfx's 128 KB of SDRAM.
    s.getState().setLogueParam(nodeName(s), 'RANGE', '0', undefined)
    const ref = { nodeId: nodeName(s), paramName: 'MIX', value: '50' }
    s.getState().setKnobBinding('nts1mkii', ref, 'mix')
    s.getState().setKnobBinding('minilogue-xd', ref, 'mix')
    expect(s.getState().setEffectModule('modfx')).toEqual([`${nodeName(s)} · MIX`])
    expect(delayParam(s, 'MIX')?.logueKnob).toBeUndefined()
    const { generateOldGenFxUnit } =
      await import('../logue-codegen/src/minilogue-xd/generateFxUnit')
    expect(() => generateOldGenFxUnit(s.getState().rootDoc!, { name: 'x' })).not.toThrow()
    s.getState().undo()
    expect(delayParam(s, 'MIX')?.logueKnob).toEqual({ nts1mkii: 'mix', 'minilogue-xd': 'mix' })
  })
})

describe('pasting the fixed io nodes', () => {
  it('leaves out audio-in/audio-out and their wires, keeping the rest', () => {
    const s = createStore<PatchStoreState>(createPatchStoreState)
    s.getState().newDoc({ module: 'delfx' })
    s.getState().insertSpecialObject('logue/util/long-delay', 'long-delay', 200, 180)
    const doc = s.getState().rootDoc!
    const all = doc.nodes.map((n, i) => nodeId(n, i))
    s.getState().pasteFromClipboard(serializeSelectionForClipboard(doc, all), null)
    const types = s.getState().rootDoc!.nodes.map((n) => (n.kind === 'obj' ? n.type : ''))
    expect(types.filter((t) => t === 'logue/io/audio-in')).toHaveLength(1)
    expect(types.filter((t) => t === LOGUE_AUDIO_OUT_TYPE)).toHaveLength(1)
    expect(types.filter((t) => t === 'logue/util/long-delay')).toHaveLength(2)
  })
})

describe('patchStore.removeNodeWires', () => {
  it("removes a node's stale wires by raw name, dropping a net left without dests", () => {
    const doc: PatchDocument = {
      nodes: [
        { kind: 'obj', type: 'logue/osc/saw', name: 'a', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/mix/mix2', name: 'mx', x: 0, y: 0, params: [] }
      ],
      nets: [
        {
          sources: [{ obj: 'a', outlet: 'out' }],
          dests: [
            { obj: 'mx', inlet: 'in1' },
            { obj: 'mx', inlet: 'l1' }
          ]
        },
        { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'mx', inlet: 'r2' }] }
      ],
      settings: { logueTarget: { module: 'modfx' } },
      notes: ''
    }
    store.setState({ rootDoc: doc })

    store.getState().removeNodeWires('mx', { inlets: ['l1', 'r2'] })

    expect(store.getState().rootDoc!.nets).toEqual([
      { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'mx', inlet: 'in1' }] }
    ])
  })
})

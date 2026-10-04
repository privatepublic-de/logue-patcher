import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createPatchStoreState, type PatchStoreState } from '../src/renderer/src/state/patchStore'
import { serializeSelectionForClipboard } from '../src/renderer/src/state/patchDocHelpers'
import { createWirePolarityResolver } from '../src/renderer/src/canvas/wirePolarity'
import { layoutByFlow } from '../src/renderer/src/canvas/flowLayout'
import { resolvePorts } from '../src/renderer/src/canvas/ports'
import {
  busPresetEntries,
  busPresetKey,
  insertArgsFor,
  listInsertablePrimitives,
  matchesFilter
} from '../src/renderer/src/browser/loguePrimitiveCatalog'
import {
  busProblems,
  defaultBusName,
  LOGUE_BUS_RECEIVE_STEREO_TYPE,
  LOGUE_BUS_RECEIVE_TYPE,
  LOGUE_BUS_SEND_STEREO_TYPE,
  LOGUE_BUS_SEND_TYPE
} from '../logue-codegen/src/buses'
import { flattenSubpatches, LOGUE_SUBPATCH_INLET_TYPE } from '../logue-codegen/src/subpatches'
import { LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import { parsePatchFile, serializePatchFile } from '@shared/json/patchCodec'
import type { ObjNode, PatchDocument, Net } from '@shared/domain/patch'

function obj(type: string, name: string, extra: Partial<ObjNode> = {}): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params: [], ...extra }
}
function wire(src: string, outlet: string, dst: string, inlet: string): Net {
  return { sources: [{ obj: src, outlet }], dests: [{ obj: dst, inlet }] }
}
function doc(nodes: ObjNode[], nets: Net[] = [], subpatch = false): PatchDocument {
  return {
    nodes,
    nets,
    settings: { logueTarget: { module: 'osc' }, ...(subpatch && { subpatch: true }) },
    notes: ''
  }
}
const busOf = (d: PatchDocument, name: string): string | undefined =>
  (d.nodes.find((n) => n.name === name) as ObjNode | undefined)?.bus

const store = createStore<PatchStoreState>(createPatchStoreState)
beforeEach(() => store.setState({ rootDoc: doc([]), past: [], future: [] }))

describe('placing and editing bus nodes', () => {
  it('a new send takes the last bus of its kind, else the first free busN', () => {
    store.getState().insertSpecialObject(LOGUE_BUS_SEND_TYPE, 'send', 0, 0)
    expect(busOf(store.getState().rootDoc!, 'send')).toBe('bus1')
    store.getState().setNodeBus('send', ' verb ')
    store.getState().insertSpecialObject(LOGUE_BUS_RECEIVE_TYPE, 'receive', 0, 0)
    expect(busOf(store.getState().rootDoc!, 'receive')).toBe('verb')
    // A stereo node doesn't join a mono bus.
    store.getState().insertSpecialObject(LOGUE_BUS_SEND_STEREO_TYPE, 'send-stereo', 0, 0)
    expect(busOf(store.getState().rootDoc!, 'send_stereo')).toBe('bus1')
  })

  it('a catalog preset names the bus', () => {
    const { type, shortId, bus } = insertArgsFor(`${LOGUE_BUS_SEND_TYPE}@drums`)
    expect({ type, shortId, bus }).toEqual({
      type: LOGUE_BUS_SEND_TYPE,
      shortId: 'send',
      bus: 'drums'
    })
    store.getState().insertSpecialObject(type, shortId, 0, 0, undefined, bus)
    expect(busOf(store.getState().rootDoc!, 'send')).toBe('drums')
  })

  it('setNodeBus is one undo step and ignores a non-bus node', () => {
    store.getState().insertSpecialObject(LOGUE_BUS_SEND_TYPE, 'send', 0, 0)
    store.getState().insertSpecialObject('logue/osc/saw', 'saw', 0, 0)
    const before = store.getState().past.length
    store.getState().setNodeBus('send', 'verb')
    store.getState().setNodeBus('saw', 'verb')
    expect(store.getState().past.length).toBe(before + 1)
    expect(busOf(store.getState().rootDoc!, 'saw')).toBeUndefined()
    store.getState().undo()
    expect(busOf(store.getState().rootDoc!, 'send')).toBe('bus1')
  })

  it('Replace with... keeps the bus among bus types and drops it otherwise', () => {
    store.getState().insertSpecialObject(LOGUE_BUS_SEND_TYPE, 'send', 0, 0, undefined, 'verb')
    store.getState().replaceNode('send', LOGUE_BUS_RECEIVE_TYPE)
    let d = store.getState().rootDoc!
    const n = d.nodes.find((x) => x.kind === 'obj' && x.type === LOGUE_BUS_RECEIVE_TYPE)!
    expect((n as ObjNode).bus).toBe('verb')
    store.getState().replaceNode(n.name!, 'logue/mix/mix2')
    d = store.getState().rootDoc!
    expect(d.nodes.some((x) => x.kind === 'obj' && 'bus' in x)).toBe(false)
  })

  it('Replace with... onto a send keeps its input and leaves its old output wire stale', () => {
    store.setState({
      rootDoc: doc(
        [obj('logue/osc/saw', 'saw'), obj('logue/gain/vca', 'v'), obj(LOGUE_AUDIO_OUT_TYPE, 'out')],
        [wire('saw', 'out', 'v', 'in'), wire('v', 'out', 'out', 'in')]
      ),
      past: [],
      future: []
    })
    store.getState().replaceNode('v', LOGUE_BUS_SEND_TYPE)
    const d = store.getState().rootDoc!
    const send = d.nodes.find((n) => n.kind === 'obj' && n.type === LOGUE_BUS_SEND_TYPE)!
    expect((send as ObjNode).bus).toBe('bus1')
    expect(d.nets).toHaveLength(2)
    expect(resolvePorts(send as ObjNode, send.name!, d.nets).outlets).toEqual([
      { name: 'out', stale: true }
    ])
  })

  it('paste keeps the bus (a second send to the same bus) and the file keeps it', () => {
    store.getState().insertSpecialObject(LOGUE_BUS_SEND_TYPE, 'send', 0, 0, undefined, 'verb')
    const text = serializeSelectionForClipboard(store.getState().rootDoc!, ['send'])
    store.getState().pasteFromClipboard(text, { x: 100, y: 100 })
    const d = store.getState().rootDoc!
    const sends = d.nodes.filter((n) => n.kind === 'obj' && n.type === LOGUE_BUS_SEND_TYPE)
    expect(sends.map((n) => (n as ObjNode).bus)).toEqual(['verb', 'verb'])
    const reread = parsePatchFile(serializePatchFile(d))
    expect(reread.nodes.map((n) => (n as ObjNode).bus)).toEqual(['verb', 'verb'])
  })
})

describe('bus nodes in the palette', () => {
  it('lists the four bus types under mix, found by "bus"', () => {
    const entries = listInsertablePrimitives('osc').filter((e) =>
      [LOGUE_BUS_SEND_TYPE, LOGUE_BUS_RECEIVE_TYPE].includes(e.id)
    )
    expect(entries.map((e) => e.category)).toEqual(['mix', 'mix'])
    expect(entries.every((e) => matchesFilter(e, 'bus'))).toBe(true)
    expect(listInsertablePrimitives('osc').some((e) => e.id.startsWith('logue/mix/bus-'))).toBe(
      false
    )
  })

  it('offers a send and a receive per bus already in the document', () => {
    const d = doc([
      obj(LOGUE_BUS_SEND_TYPE, 's1', { bus: 'verb' }),
      obj(LOGUE_BUS_SEND_TYPE, 's2', { bus: 'verb' }),
      obj(LOGUE_BUS_SEND_STEREO_TYPE, 's3', { bus: 'out' })
    ])
    const labels = busPresetEntries(JSON.parse(busPresetKey(d))).map((e) => e.label)
    expect(labels).toEqual(['send → verb', 'receive verb', 'send → out', 'receive out'])
  })
})

describe('bus nodes on the canvas', () => {
  it('a send has only its input, a receive only its output', () => {
    expect(resolvePorts(obj(LOGUE_BUS_SEND_TYPE, 's'), 's', []).outlets).toEqual([])
    expect(resolvePorts(obj(LOGUE_BUS_RECEIVE_STEREO_TYPE, 'r'), 'r', []).inlets).toEqual([])
  })

  it('a receive takes the colour of what its sends carry', () => {
    const d = doc(
      [
        obj('logue/lfo/sine-lfo', 'lfo'),
        obj(LOGUE_BUS_SEND_TYPE, 's', { bus: 'mod' }),
        obj(LOGUE_BUS_RECEIVE_TYPE, 'r', { bus: 'mod' }),
        obj(LOGUE_BUS_RECEIVE_TYPE, 'empty', { bus: 'nothing' })
      ],
      [wire('lfo', 'out', 's', 'in')]
    )
    const resolve = createWirePolarityResolver(d, new Map(d.nodes.map((n) => [n.name!, n.type])))
    expect(resolve('r', 'out')).toBe('bipolar')
    expect(resolve('empty', 'out')).toBe('audio')
  })

  it('warns about a receive with no send and a send nobody receives, counting subpatches', () => {
    const def = doc(
      [obj(LOGUE_SUBPATCH_INLET_TYPE, 'in'), obj(LOGUE_BUS_SEND_TYPE, 's', { bus: 'verb' })],
      [wire('in', 'out', 's', 'in')],
      true
    )
    const d = doc([
      obj('sub/voice', 'v'),
      obj(LOGUE_BUS_RECEIVE_TYPE, 'verb_rx', { bus: 'verb' }),
      obj(LOGUE_BUS_RECEIVE_TYPE, 'lonely', { bus: 'drums' }),
      obj(LOGUE_BUS_SEND_TYPE, 'unheard', { bus: 'fx' }),
      obj(LOGUE_AUDIO_OUT_TYPE, 'out')
    ])
    const flat = flattenSubpatches(d, new Map([['sub/voice', def]]))
    const problems = busProblems(d, flat.nodes)
    expect([...problems.keys()].sort()).toEqual(['lonely', 'unheard'])
    expect(problems.get('lonely')).toMatch(/Nothing sends to bus "drums"/)
    // Inside a definition the other end is in the patch using it.
    expect(busProblems(def, def.nodes).size).toBe(0)
  })

  it('flags mono and stereo nodes on one bus, also inside a definition', () => {
    const d = doc(
      [
        obj(LOGUE_BUS_SEND_TYPE, 'a', { bus: 'x' }),
        obj(LOGUE_BUS_SEND_STEREO_TYPE, 'b', { bus: 'x' })
      ],
      [],
      true
    )
    expect([...busProblems(d, d.nodes).keys()]).toEqual(['a', 'b'])
  })

  it('arrange by signal flow puts the sends upstream of their receive', () => {
    const d = doc(
      [
        obj(LOGUE_AUDIO_OUT_TYPE, 'out'),
        obj(LOGUE_BUS_RECEIVE_TYPE, 'rx', { bus: 'mix' }),
        obj(LOGUE_BUS_SEND_TYPE, 'sa', { bus: 'mix' }),
        obj(LOGUE_BUS_SEND_TYPE, 'sb', { bus: 'mix' }),
        obj('logue/osc/saw', 'a'),
        obj('logue/osc/square', 'b')
      ],
      [wire('a', 'out', 'sa', 'in'), wire('b', 'out', 'sb', 'in'), wire('rx', 'out', 'out', 'in')]
    )
    const laid = layoutByFlow(d)
    const x = (name: string): number => laid.find((n) => n.name === name)!.x
    expect(x('a')).toBeLessThan(x('sa'))
    expect(x('sa')).toBeLessThan(x('rx'))
    expect(x('sb')).toBeLessThan(x('rx'))
    expect(x('rx')).toBeLessThan(x('out'))
  })

  it('defaultBusName skips a name the other kind already uses', () => {
    const d = doc([obj(LOGUE_BUS_SEND_TYPE, 's', { bus: 'bus1' })])
    expect(defaultBusName(d, true)).toBe('bus2')
    expect(defaultBusName(d, false)).toBe('bus1')
  })
})

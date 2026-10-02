import { describe, it, expect, beforeEach } from 'vitest'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { resolvePorts } from '../src/renderer/src/canvas/ports'
import { patchDocToFlow } from '../src/renderer/src/state/toFlowGraph'
import { useSubpatchLibraryStore } from '../src/renderer/src/state/subpatchLibraryStore'
import {
  categoryForPrimitiveId,
  listSubpatchEntries,
  LOCAL_SUBPATCH_CATEGORY
} from '../src/renderer/src/browser/loguePrimitiveCatalog'
import { createPatchStoreState, type PatchStoreState } from '../src/renderer/src/state/patchStore'
import { newSubpatchDocument } from '../src/renderer/src/state/patchDocHelpers'
import { listParamMatrixRows } from '../src/renderer/src/state/exposedLogueParams'
import {
  LOGUE_SUBPATCH_INLET_TYPE,
  LOGUE_SUBPATCH_OUTLET_TYPE
} from '../logue-codegen/src/subpatches'
import type { PatchDocument, ObjNode } from '@shared/domain/patch'
import type { SubpatchLibraryEntry } from '@shared/ipc/contract'

function obj(type: string, name: string, params: ObjNode['params'] = [], y = 0): ObjNode {
  return { kind: 'obj', type, name, x: 0, y, params }
}

const FILTER_DEF: PatchDocument = {
  nodes: [
    obj(LOGUE_SUBPATCH_INLET_TYPE, 'in', [], 0),
    obj(LOGUE_SUBPATCH_INLET_TYPE, 'mod', [], 100),
    obj('logue/filter/lowpass-cheap', 'lp', [
      { name: 'CUTOFF', value: '40', subpatchExpose: { outerName: 'Cutoff' } }
    ]),
    obj(LOGUE_SUBPATCH_OUTLET_TYPE, 'out')
  ],
  nets: [
    { sources: [{ obj: 'in', outlet: 'out' }], dests: [{ obj: 'lp', inlet: 'in' }] },
    { sources: [{ obj: 'lp', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ],
  settings: { subpatch: true },
  notes: 'A soft lowpass.'
}

const LIBRARY: SubpatchLibraryEntry[] = [
  {
    type: 'sub/filters/soft',
    filePath: '/lib/filters/soft.loguesub',
    source: 'library',
    doc: FILTER_DEF
  },
  { type: 'sub/broken', filePath: '/lib/broken.loguesub', source: 'library', error: 'bad json' }
]

beforeEach(() => useSubpatchLibraryStore.getState().setEntries(LIBRARY))

describe('subpatch instances on the canvas', () => {
  it('get their ports from the definition, in canvas order', () => {
    const node = obj('sub/filters/soft', 'f1')
    expect(resolvePorts(node, 'f1', [])).toEqual({
      inlets: [
        { name: 'in', role: 'audio' },
        { name: 'mod', role: 'control' }
      ],
      outlets: [{ name: 'out' }]
    })
  })

  it('keep a wire to a port the definition dropped, drawn broken', () => {
    const root: PatchDocument = {
      nodes: [obj('logue/osc/saw', 'osc'), obj('sub/filters/soft', 'f1')],
      nets: [{ sources: [{ obj: 'osc', outlet: 'out' }], dests: [{ obj: 'f1', inlet: 'gone' }] }],
      settings: {},
      notes: ''
    }
    expect(resolvePorts(root.nodes[1], 'f1', root.nets).inlets).toContainEqual({
      name: 'gone',
      stale: true
    })
    const { edges, nodes } = patchDocToFlow(root)
    expect(edges[0].data?.invalid).toBe(true)
    const f1 = nodes.find((n) => n.id === 'f1')!
    expect(f1.type === 'object' && f1.data.unresolvedReferences).toEqual([
      expect.objectContaining({ kind: 'stale-inlet', rawName: 'gone' })
    ])
  })

  it('flag an instance whose definition is missing', () => {
    const root: PatchDocument = {
      nodes: [obj('sub/nowhere', 'n')],
      nets: [],
      settings: {},
      notes: ''
    }
    const node = patchDocToFlow(root).nodes[0]
    expect(node.type === 'object' && node.data.unresolvedReferences).toEqual([
      { kind: 'missing-subpatch', rawName: 'sub/nowhere' }
    ])
  })

  it('list promoted params in the Param Matrix, per instance', () => {
    const root: PatchDocument = {
      nodes: [obj('sub/filters/soft', 'f1'), obj('sub/filters/soft', 'f2')],
      nets: [],
      settings: {},
      notes: ''
    }
    const rows = listParamMatrixRows(root)
    expect(rows.map((r) => `${r.nodeName}:${r.paramName}`)).toEqual(['f1:Cutoff', 'f2:Cutoff'])
    expect(rows[0].currentValue).toBe('40')
    expect(listParamMatrixRows(FILTER_DEF)).toEqual([])
  })
})

describe('subpatch palette entries', () => {
  it('group by library subfolder under the subpatch category', () => {
    expect(categoryForPrimitiveId('sub/filters/soft')).toBe('subpatch/filters')
    expect(categoryForPrimitiveId('sub/top')).toBe('subpatch')
    const defs = useSubpatchLibraryStore.getState().defs
    expect(listSubpatchEntries(LIBRARY, defs)).toEqual([
      {
        id: 'sub/filters/soft',
        label: 'soft',
        category: 'subpatch/filters',
        description: 'A soft lowpass.'
      }
    ])
  })

  it("group the patch folder's own subpatches apart, whatever their path", () => {
    const local: SubpatchLibraryEntry[] = [{ ...LIBRARY[0], source: 'local' }]
    expect(
      listSubpatchEntries(local, useSubpatchLibraryStore.getState().defs).map((e) => e.category)
    ).toEqual([LOCAL_SUBPATCH_CATEGORY])
  })

  it('never offer a definition inside itself', () => {
    const defs = useSubpatchLibraryStore.getState().defs
    expect(listSubpatchEntries(LIBRARY, defs, 'sub/filters/soft')).toEqual([])
  })
})

describe('editing a subpatch definition', () => {
  let store: StoreApi<PatchStoreState>
  beforeEach(() => {
    store = createStore<PatchStoreState>(createPatchStoreState)
    store.getState().loadDoc(newSubpatchDocument(), null)
  })

  it('starts with one inlet and one outlet and no audio-out', () => {
    const types = store.getState().rootDoc!.nodes.map((n) => n.type)
    expect(types).toEqual([LOGUE_SUBPATCH_INLET_TYPE, LOGUE_SUBPATCH_OUTLET_TYPE])
    expect(store.getState().rootDoc!.settings.subpatch).toBe(true)
  })

  it('promotes and un-promotes an inner param', () => {
    store.getState().insertSpecialObject('logue/gain/vca', 'vca', 0, 0)
    store.getState().setSubpatchExpose('vca', 'GAIN', 'vca:GAIN')
    const vca = (): ObjNode =>
      store.getState().rootDoc!.nodes.find((n) => n.name === 'vca') as ObjNode
    expect(vca().params).toEqual([
      { name: 'GAIN', value: '25', subpatchExpose: { outerName: 'vca:GAIN' } }
    ])
    store.getState().setSubpatchExpose('vca', 'GAIN', null)
    expect(vca().params[0].subpatchExpose).toBeUndefined()
  })

  it('never lets two promoted params share an outer name', () => {
    store.getState().insertSpecialObject('logue/gain/vca', 'vca', 0, 0)
    store.getState().insertSpecialObject('logue/gain/vca', 'vca', 0, 0)
    store.getState().setSubpatchExpose('vca', 'GAIN', 'Level')
    store.getState().setSubpatchExpose('vca_1', 'GAIN', 'Level')
    const outerNames = store
      .getState()
      .rootDoc!.nodes.flatMap((n) => (n.kind === 'obj' ? n.params : []))
      .map((p) => p.subpatchExpose?.outerName)
    expect(outerNames).toEqual(['Level', 'Level 2'])
  })

  it('removes a stale param value', () => {
    store.getState().insertSpecialObject('logue/gain/vca', 'vca', 0, 0)
    store.getState().setSubpatchExpose('vca', 'GAIN', 'Level')
    store.getState().removeParamValue('vca', 'GAIN')
    const vca = store.getState().rootDoc!.nodes.find((n) => n.name === 'vca') as ObjNode
    expect(vca.params).toEqual([])
    expect(store.getState().dirty).toBe(true)
  })

  it('promotes a placed sense/param instead of giving it a device slot', () => {
    store.getState().insertSpecialObject('logue/sense/param', 'param', 0, 0)
    const param = store.getState().rootDoc!.nodes.find((n) => n.name === 'param') as ObjNode
    expect(param.params[0].logueParamIndex).toBeUndefined()
    expect(param.params[0].subpatchExpose).toEqual({ outerName: 'param:VALUE' })
  })

  it('never auto-exposes a placed subpatch instance', () => {
    const root = createStore<PatchStoreState>(createPatchStoreState)
    root.getState().newDoc({ module: 'osc' })
    root.getState().insertSpecialObject('sub/filters/soft', 'soft', 0, 0)
    const inst = root.getState().rootDoc!.nodes.find((n) => n.name === 'soft') as ObjNode
    expect(inst.params).toEqual([])
  })
})

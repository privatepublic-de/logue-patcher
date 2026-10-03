import { describe, expect, it } from 'vitest'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { createWirePolarityResolver } from '../src/renderer/src/canvas/wirePolarity'
import { patchDocToFlow, type NetEdgeData } from '../src/renderer/src/state/toFlowGraph'
import { createPatchStoreState, type PatchStoreState } from '../src/renderer/src/state/patchStore'
import type { ObjNode, PatchDocument } from '../src/shared/domain/patch'

// Sources with a known range: env/ad is unipolar, sine-lfo bipolar, sense/gate a gate, osc audio.
const SOURCES = {
  uni: 'logue/env/ad',
  bi: 'logue/lfo/sine-lfo',
  gate: 'logue/sense/gate',
  audio: 'logue/osc/sine'
} as const
type Source = keyof typeof SOURCES

function node(type: string, name: string, params: Record<string, number> = {}): ObjNode {
  const values = Object.entries(params).map(([p, v]) => ({ name: p, value: String(v) }))
  return { kind: 'obj', type, name, x: 0, y: 0, params: values }
}

/** The bucket of `math/<op>` fed `inputs` (inlet -> source kind; absent = unwired). */
function bucketOf(
  op: string,
  inputs: Record<string, Source>,
  params: Record<string, number> = {}
): string {
  const nodes = [node(`logue/math/${op}`, 'm', params)]
  const nets = Object.entries(inputs).map(([inlet, kind]) => {
    nodes.push(node(SOURCES[kind], `src_${inlet}`))
    return { sources: [{ obj: `src_${inlet}`, outlet: 'out' }], dests: [{ obj: 'm', inlet }] }
  })
  const doc: PatchDocument = { nodes, nets, settings: {}, notes: '' }
  const typeById = new Map(nodes.map((n) => [n.name!, n.type]))
  return createWirePolarityResolver(doc, typeById)('m', 'out')
}

describe('refinePolarity: what a math node does to its inputs range', () => {
  it('max with b unwired is a half-wave rectifier: unipolar', () => {
    expect(bucketOf('max', { a: 'bi' })).toBe('unipolar')
    expect(bucketOf('max', { a: 'bi', b: 'uni' })).toBe('unipolar')
    expect(bucketOf('max', { a: 'bi', b: 'bi' })).toBe('bipolar')
    expect(bucketOf('max', { a: 'gate', b: 'gate' })).toBe('gate')
    // Rectified audio is still audio.
    expect(bucketOf('max', { a: 'audio' })).toBe('audio')
  })

  it('min of two non-negative signals is unipolar; with an unwired side it is <= 0', () => {
    expect(bucketOf('min', { a: 'uni', b: 'gate' })).toBe('unipolar')
    expect(bucketOf('min', { a: 'uni' })).toBe('bipolar')
  })

  it('clamp follows LO and HI', () => {
    expect(bucketOf('clamp', { in: 'bi' }, { LO: 0 })).toBe('unipolar')
    expect(bucketOf('clamp', { in: 'bi' }, { LO: 20, HI: 80 })).toBe('unipolar')
    expect(bucketOf('clamp', { in: 'bi' })).toBe('bipolar') // default -100..100
    expect(bucketOf('clamp', { in: 'uni' }, { LO: -100, HI: 0 })).toBe('bipolar')
    expect(bucketOf('clamp', { in: 'gate' }, { LO: 0 })).toBe('gate')
  })

  it('abs, negate, one-minus', () => {
    expect(bucketOf('abs', { in: 'bi' })).toBe('unipolar')
    expect(bucketOf('abs', { in: 'audio' })).toBe('audio')
    expect(bucketOf('negate', { in: 'uni' })).toBe('bipolar')
    expect(bucketOf('negate', { in: 'bi' })).toBe('bipolar')
    expect(bucketOf('one-minus', { in: 'bi' })).toBe('unipolar')
    expect(bucketOf('one-minus', { in: 'uni' })).toBe('unipolar')
  })

  it('multiply, add, subtract and scale by the sign of what they combine', () => {
    expect(bucketOf('multiply', { in1: 'uni', in2: 'gate' })).toBe('unipolar')
    expect(bucketOf('multiply', { in1: 'uni', in2: 'bi' })).toBe('bipolar')
    expect(bucketOf('add', { a: 'uni', b: 'bi' })).toBe('bipolar')
    expect(bucketOf('add', { a: 'uni', b: 'gate' })).toBe('unipolar')
    expect(bucketOf('subtract', { a: 'uni', b: 'uni' })).toBe('bipolar')
    expect(bucketOf('subtract', { a: 'uni' })).toBe('unipolar')
    expect(bucketOf('scale', { in: 'uni' }, { FACTOR: -50 })).toBe('bipolar')
    expect(bucketOf('scale', { in: 'uni' }, { FACTOR: 50 })).toBe('unipolar')
  })
})

// The Radio patch's chain: a multistage envelope (bipolar levels) into a VCA's gain.
function envIntoVca(through?: { type: string; params?: Record<string, number> }): PatchDocument {
  const nodes = [node('logue/env/multistage', 'env'), node('logue/gain/vca', 'vca')]
  if (!through) {
    return {
      nodes,
      nets: [{ sources: [{ obj: 'env', outlet: 'env' }], dests: [{ obj: 'vca', inlet: 'gain' }] }],
      settings: {},
      notes: ''
    }
  }
  nodes.push(node(through.type, 'fix', through.params))
  const inlet = through.type === 'logue/math/max' ? 'a' : 'in'
  return {
    nodes,
    nets: [
      { sources: [{ obj: 'env', outlet: 'env' }], dests: [{ obj: 'fix', inlet }] },
      { sources: [{ obj: 'fix', outlet: 'out' }], dests: [{ obj: 'vca', inlet: 'gain' }] }
    ],
    settings: {},
    notes: ''
  }
}

const warnings = (d: PatchDocument): unknown[] =>
  patchDocToFlow(d)
    .edges.map((e) => (e.data as NetEdgeData).warning)
    .filter(Boolean)

describe('the VCA gain warning after a rectifier', () => {
  it('warns for the envelope straight in, not through max or clamp at LO 0', () => {
    expect(warnings(envIntoVca())).toHaveLength(1)
    expect(warnings(envIntoVca({ type: 'logue/math/max' }))).toEqual([])
    expect(warnings(envIntoVca({ type: 'logue/math/clamp', params: { LO: 0 } }))).toEqual([])
    expect(warnings(envIntoVca({ type: 'logue/math/clamp' }))).toHaveLength(1)
  })
})

describe('setLogueParam re-derives wires when a param moves a polarity', () => {
  function storeWith(d: PatchDocument): StoreApi<PatchStoreState> {
    const store = createStore<PatchStoreState>(createPatchStoreState)
    store.setState({ rootDoc: d })
    return store
  }

  it('remounts when clamp LO crosses 0, not for an edit that keeps the bucket', () => {
    const store = storeWith(envIntoVca({ type: 'logue/math/clamp' }))
    const nonce = (): number => store.getState().reloadNonce
    const start = nonce()
    store.getState().setLogueParam('fix', 'LO', '-50')
    expect(nonce()).toBe(start)
    store.getState().setLogueParam('fix', 'LO', '0')
    expect(nonce()).toBe(start + 1)
    store.getState().setLogueParam('fix', 'HI', '50')
    expect(nonce()).toBe(start + 1)
  })

  it('waits for the end of a dial drag, then remounts once', () => {
    const store = storeWith(envIntoVca({ type: 'logue/math/clamp' }))
    const start = store.getState().reloadNonce
    store.getState().beginGesture()
    store.getState().setLogueParam('fix', 'LO', '-1')
    store.getState().setLogueParam('fix', 'LO', '0')
    store.getState().setLogueParam('fix', 'LO', '3')
    expect(store.getState().reloadNonce).toBe(start)
    store.getState().endGesture()
    expect(store.getState().reloadNonce).toBe(start + 1)
  })

  it("doesn't remount after a drag that ends where it started", () => {
    const store = storeWith(envIntoVca({ type: 'logue/math/clamp', params: { LO: 10 } }))
    const start = store.getState().reloadNonce
    store.getState().beginGesture()
    store.getState().setLogueParam('fix', 'LO', '-10')
    store.getState().setLogueParam('fix', 'LO', '20')
    store.getState().endGesture()
    expect(store.getState().reloadNonce).toBe(start)
  })
})

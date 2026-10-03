import { describe, expect, it } from 'vitest'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { patchDocToFlow, type NetEdgeData } from '../src/renderer/src/state/toFlowGraph'
import { createPatchStoreState, type PatchStoreState } from '../src/renderer/src/state/patchStore'
import type { ObjNode, PatchDocument } from '../src/shared/domain/patch'
import type { ParamValue } from '../src/shared/domain/paramValueTypes'

const ON_DEPTH: Partial<ParamValue> = { logueKnob: { nts1mkii: 'depth' } }

function node(type: string, name: string, params: ParamValue[] = []): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params }
}

/** A source into `dest`'s `inlet`; the source is a knob-bound `sense/control` unless given. */
function patch(opts: {
  outlet: string
  destType: string
  inlet: string
  dial?: [string, number]
  source?: ObjNode
}): PatchDocument {
  const source =
    opts.source ??
    node('logue/sense/control', 'knob', [{ name: 'VALUE', value: '50', ...ON_DEPTH }])
  const dest = node(
    opts.destType,
    'dest',
    opts.dial ? [{ name: opts.dial[0], value: String(opts.dial[1]) }] : []
  )
  return {
    nodes: [source, dest],
    nets: [
      {
        sources: [{ obj: source.name!, outlet: opts.outlet }],
        dests: [{ obj: 'dest', inlet: opts.inlet }]
      }
    ],
    settings: { logueTarget: { module: 'modfx' } },
    notes: ''
  }
}

const warningOf = (d: PatchDocument): string | undefined =>
  (patchDocToFlow(d).edges[0].data as NetEdgeData).warning

describe('knob dead-zone warning (a knob reading into an additive inlet)', () => {
  it('flags the Radio wiring and says how to get the whole travel', () => {
    const w = warningOf(
      patch({
        outlet: 'bipolar',
        destType: 'logue/mix/crossfader',
        inlet: 'fade',
        dial: ['FADE', 50]
      })
    )
    expect(w).toMatch(/FADE stays at 0 for the first 25 % and at 100 for the last 25 %/)
    expect(w).toMatch(/wire the unipolar outlet and set FADE at 0/)
  })

  it('is quiet for the right wiring: unipolar outlet, FADE 0', () => {
    expect(
      warningOf(
        patch({
          outlet: 'unipolar',
          destType: 'logue/mix/crossfader',
          inlet: 'fade',
          dial: ['FADE', 0]
        })
      )
    ).toBeUndefined()
  })

  it('names the dial range for a half-range inlet', () => {
    // sine-lfo RATE: depth 50, so a unipolar knob from RATE 80 runs into 100 after 40 %.
    const w = warningOf(
      patch({
        outlet: 'unipolar',
        destType: 'logue/lfo/sine-lfo',
        inlet: 'rate',
        dial: ['RATE', 80]
      })
    )
    expect(w).toMatch(/RATE stays at 100 for the last 60 %/)
    expect(w).toMatch(/Set RATE between 0 and 50/)
    expect(
      warningOf(
        patch({
          outlet: 'unipolar',
          destType: 'logue/lfo/sine-lfo',
          inlet: 'rate',
          dial: ['RATE', 50]
        })
      )
    ).toBeUndefined()
  })

  it('leaves LFOs, unbound controls and unclamped operands alone', () => {
    const lfo = node('logue/lfo/sine-lfo', 'lfo')
    expect(
      warningOf(
        patch({
          outlet: 'out',
          destType: 'logue/filter/svf',
          inlet: 'cutoff',
          dial: ['CUTOFF', 50],
          source: lfo
        })
      )
    ).toBeUndefined()
    const unbound = node('logue/sense/control', 'k', [{ name: 'VALUE', value: '50' }])
    expect(
      warningOf(
        patch({
          outlet: 'bipolar',
          destType: 'logue/mix/crossfader',
          inlet: 'fade',
          source: unbound
        })
      )
    ).toBeUndefined()
    expect(
      warningOf(
        patch({
          outlet: 'bipolar',
          destType: 'logue/logic/greater-than',
          inlet: 'b',
          dial: ['THRESHOLD', 90]
        })
      )
    ).toBeUndefined()
  })
})

describe('the warning follows the dial live', () => {
  it('remounts when FADE opens or closes a dead zone', () => {
    const store: StoreApi<PatchStoreState> = createStore<PatchStoreState>(createPatchStoreState)
    store.setState({
      rootDoc: patch({
        outlet: 'unipolar',
        destType: 'logue/mix/crossfader',
        inlet: 'fade',
        dial: ['FADE', 0]
      })
    })
    const start = store.getState().reloadNonce
    store.getState().setLogueParam('dest', 'FADE', '40')
    expect(store.getState().reloadNonce).toBe(start + 1)
    store.getState().setLogueParam('dest', 'FADE', '60') // a different dead zone: new text
    expect(store.getState().reloadNonce).toBe(start + 2)
    store.getState().setLogueParam('dest', 'FADE', '0')
    expect(store.getState().reloadNonce).toBe(start + 3)
  })
})

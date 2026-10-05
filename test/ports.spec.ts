import { describe, expect, it } from 'vitest'
import { resolvePorts } from '../src/renderer/src/canvas/ports'
import {
  colorForRole,
  colorForBucket,
  outletShapeClassForBucket,
  PORT_COLOR_AUDIO,
  PORT_COLOR_UNIPOLAR,
  PORT_COLOR_BIPOLAR,
  PORT_COLOR_GATE,
  PORT_COLOR_NEUTRAL
} from '../src/renderer/src/canvas/portColors'
import { findLoguePrimitive, recognizedLoguePrimitiveIds } from '@logue-codegen/primitives'
import type { ObjNode, Net } from '../src/shared/domain/patch'

function objNode(type: string, name: string): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params: [] }
}

describe('resolvePorts inlet roles', () => {
  it('reads an inlet role straight off the primitive spec', () => {
    const ports = resolvePorts(objNode('logue/gain/vca', 'vca1'), 'vca1', [])
    expect(ports.inlets).toEqual([
      { name: 'in', role: 'audio' },
      { name: 'gain', role: 'control' }
    ])
  })

  // The one node with five inlets -- and the reason this distinction exists at all.
  it('distinguishes a five-inlet comb filter: one audio, four controls', () => {
    const ports = resolvePorts(objNode('logue/filter/comb', 'comb1'), 'comb1', [])
    expect(ports.inlets.map((i) => [i.name, i.role])).toEqual([
      ['in', 'audio'],
      ['tune', 'control'],
      ['feedback', 'control'],
      ['damping', 'control'],
      ['pitch', 'control']
    ])
  })

  it("gives an effect's audio-out L/R and its audio-in L/R/mono", () => {
    expect(resolvePorts(objNode('logue/io/audio-out', 'out'), 'out', [], 'delfx').inlets).toEqual([
      { name: 'l', role: 'audio' },
      { name: 'r', role: 'audio' }
    ])
    expect(resolvePorts(objNode('logue/io/audio-in', 'in'), 'in', [], 'delfx')).toEqual({
      inlets: [],
      outlets: [{ name: 'l' }, { name: 'r' }, { name: 'mono' }]
    })
  })

  it('treats the audio-out sink as audio', () => {
    const ports = resolvePorts(objNode('logue/io/audio-out', 'out'), 'out', [])
    expect(ports.inlets).toEqual([{ name: 'in', role: 'audio' }])
  })

  // A stale/hand-edited/legacy-Axoloti type has no spec to read a role from, so it must stay
  // neutral rather than guess -- the ports themselves are still inferred from real wiring.
  it('leaves the role undefined for a type inferred from wiring alone', () => {
    const nets: Net[] = [
      { sources: [{ obj: 'src', outlet: 'out' }], dests: [{ obj: 'legacy', inlet: 'whatever' }] }
    ]
    const ports = resolvePorts(objNode('axoloti/not/a/logue/primitive', 'legacy'), 'legacy', nets)
    expect(ports.inlets).toEqual([{ name: 'whatever' }])
    expect(ports.inlets[0].role).toBeUndefined()
  })

  it('never gives an outlet a role -- one source can feed both kinds of inlet', () => {
    const ports = resolvePorts(objNode('logue/env/ad', 'env1'), 'env1', [])
    expect(ports.outlets).toEqual([{ name: 'out' }])
  })

  // The one node with three outlets -- reads its outlet handles off the primitive's own
  // `outlets` spec (`logue/filter/svf` is the first/only multi-outlet primitive) rather than
  // the single hardcoded `{ name: 'out' }` every other primitive gets.
  it('exposes all five outlets of the SVF filter', () => {
    const ports = resolvePorts(objNode('logue/filter/svf', 'svf1'), 'svf1', [])
    expect(ports.outlets).toEqual([
      { name: 'lp' },
      { name: 'bp' },
      { name: 'hp' },
      { name: 'notch' },
      { name: 'ap' }
    ])
  })

  it('declares a role for every inlet in the registry', () => {
    for (const id of recognizedLoguePrimitiveIds()) {
      const primitive = findLoguePrimitive(id)!
      for (const inlet of primitive.inlets ?? []) {
        expect(inlet.role, `${primitive.id}.${inlet.name}`).toMatch(/^(audio|control|buffer)$/)
      }
    }
  })

  // Same "required, not optional" invariant `outletPolarity` itself establishes (see
  // `LoguePrimitive.outletPolarity`'s own doc comment) -- this pins down that every declared
  // value (plain, or one entry of a per-outlet Record) is actually one of the five real
  // possibilities (six with `buffer`), not a typo that would otherwise silently fall through `colorForBucket`'s own
  // `default` case.
  it('declares a valid outletPolarity for every primitive in the registry', () => {
    const valid = /^(audio|unipolar|bipolar|gate|buffer|inherit)$/
    for (const id of recognizedLoguePrimitiveIds()) {
      const primitive = findLoguePrimitive(id)!
      const declared = primitive.outletPolarity
      if (typeof declared === 'string') {
        expect(declared, primitive.id).toMatch(valid)
      } else {
        for (const [outletName, value] of Object.entries(declared)) {
          expect(value, `${primitive.id}.${outletName}`).toMatch(valid)
        }
      }
    }
  })

  // 'inherit' only means something if there's actually a signal inlet to inherit FROM -- a
  // primitive declaring 'inherit' with no `audio`-role inlet at all would always fall back to
  // the plain "nothing wired" default, silently identical to just declaring `'audio'` outright
  // (see `wirePolarity.ts`'s own resolver).
  it('only declares outletPolarity: inherit on a primitive with at least one audio-role inlet', () => {
    for (const id of recognizedLoguePrimitiveIds()) {
      const primitive = findLoguePrimitive(id)!
      const declared = primitive.outletPolarity
      const declaresInherit =
        declared === 'inherit' ||
        (typeof declared !== 'string' && Object.values(declared).includes('inherit'))
      if (!declaresInherit) continue
      const hasAudioInlet = (primitive.inlets ?? []).some((inlet) => inlet.role === 'audio')
      expect(hasAudioInlet, primitive.id).toBe(true)
    }
  })

  // Inspector.tsx shows this at the bottom of the panel -- a primitive with no description would
  // silently render nothing there instead of failing loudly, the same "declared but unchecked"
  // gap the role test above already guards against for inlets.
  it('declares a non-empty description for every primitive in the registry', () => {
    for (const id of recognizedLoguePrimitiveIds()) {
      const primitive = findLoguePrimitive(id)!
      expect(primitive.description.trim().length, primitive.id).toBeGreaterThan(0)
    }
  })
})

describe('colorForRole', () => {
  it('paints a control inlet neutral gray and everything else the uniform audio colour', () => {
    expect(colorForRole('control')).toBe(PORT_COLOR_NEUTRAL)
    expect(colorForRole('audio')).toBe(PORT_COLOR_AUDIO)
    expect(colorForRole(undefined)).toBe(PORT_COLOR_AUDIO)
  })
})

describe('colorForBucket', () => {
  it('paints each of the four fixed buckets its own distinct colour', () => {
    expect(colorForBucket('audio')).toBe(PORT_COLOR_AUDIO)
    expect(colorForBucket('unipolar')).toBe(PORT_COLOR_UNIPOLAR)
    expect(colorForBucket('bipolar')).toBe(PORT_COLOR_BIPOLAR)
    expect(colorForBucket('gate')).toBe(PORT_COLOR_GATE)
    const colors = new Set([
      PORT_COLOR_AUDIO,
      PORT_COLOR_UNIPOLAR,
      PORT_COLOR_BIPOLAR,
      PORT_COLOR_GATE
    ])
    expect(colors.size).toBe(4)
  })

  it('paints an indeterminate resolution neutral gray', () => {
    expect(colorForBucket('neutral')).toBe(PORT_COLOR_NEUTRAL)
  })
})

describe('outletShapeClassForBucket', () => {
  it('gives audio no shape class (round, the React Flow default)', () => {
    expect(outletShapeClassForBucket('audio')).toBe('')
  })

  it('gives both continuous control buckets, plus neutral, the square control class', () => {
    expect(outletShapeClassForBucket('unipolar')).toBe('patch-node__handle--control')
    expect(outletShapeClassForBucket('bipolar')).toBe('patch-node__handle--control')
    expect(outletShapeClassForBucket('neutral')).toBe('patch-node__handle--control')
  })

  it('gives gate its own diamond class, distinct from continuous control', () => {
    expect(outletShapeClassForBucket('gate')).toBe('patch-node__handle--gate')
  })
})

describe('resolvePorts stale ports', () => {
  it("keeps a wire into an inlet a primitive doesn't declare as a stale handle", () => {
    const nets: Net[] = [
      { sources: [{ obj: 'n', outlet: 'out' }], dests: [{ obj: 'mx', inlet: 'l2' }] },
      { sources: [{ obj: 'n', outlet: 'out' }], dests: [{ obj: 'mx', inlet: 'in2' }] }
    ]
    const ports = resolvePorts(objNode('logue/mix/mix2', 'mx'), 'mx', nets)
    expect(ports.inlets).toEqual([
      { name: 'in1', role: 'audio' },
      { name: 'in2', role: 'audio' },
      { name: 'thru', role: 'audio', label: 'in thru' },
      { name: 'l2', stale: true }
    ])
  })

  it('marks an unknown outlet stale only on a multi-outlet primitive (one outlet answers to any name)', () => {
    const nets: Net[] = [
      { sources: [{ obj: 'f', outlet: 'peak' }], dests: [{ obj: 'x', inlet: 'in' }] },
      { sources: [{ obj: 'v', outlet: 'l' }], dests: [{ obj: 'x', inlet: 'in' }] }
    ]
    expect(resolvePorts(objNode('logue/filter/svf', 'f'), 'f', nets).outlets).toContainEqual({
      name: 'peak',
      stale: true
    })
    expect(resolvePorts(objNode('logue/gain/vca', 'v'), 'v', nets).outlets).toEqual([
      { name: 'out' }
    ])
  })
})

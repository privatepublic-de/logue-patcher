import { describe, it, expect } from 'vitest'
import { findLoguePrimitive, recognizedLoguePrimitiveIds } from '../logue-codegen/src/primitives'
import { findInletModulation } from '../logue-codegen/src/paramModulation'

/**
 * Inlets that carry the signal or an operand rather than moving a dial: they need no
 * `modulatedBy`. Any other inlet must be named by one of its primitive's params -- the drift this
 * guards against is an inlet added without its dial showing that it's wired (string's
 * `structure`/`damping`/`decay`, exciter's `bow` and others went unmarked for a while).
 */
const SIGNAL_INLETS = new Set([
  'in',
  'in1',
  'in2',
  'a',
  'b',
  'i1',
  'i2',
  'i3',
  'i4',
  'fm',
  'harmonic',
  'gate',
  'trig',
  'freeze',
  'l',
  'r',
  'l1',
  'r1',
  'l2',
  'r2'
])

const primitives = recognizedLoguePrimitiveIds().map((id) => findLoguePrimitive(id)!)

describe('primitive presentation metadata', () => {
  it('links every control inlet to the param it moves', () => {
    const unlinked: string[] = []
    for (const p of primitives) {
      const named = new Set((p.params ?? []).map((s) => s.modulatedBy?.inlet))
      for (const inlet of p.inlets ?? []) {
        // A buffer wire is a reference to a ring, not a value any dial could take.
        if (inlet.role === 'buffer') continue
        if (!named.has(inlet.name) && !SIGNAL_INLETS.has(inlet.name)) {
          unlinked.push(`${p.id} ${inlet.name}`)
        }
      }
    }
    expect(unlinked).toEqual([])
  })

  it('only links params to inlets the primitive declares', () => {
    for (const p of primitives) {
      const inlets = new Set((p.inlets ?? []).map((i) => i.name))
      for (const spec of p.params ?? []) {
        if (spec.modulatedBy)
          expect(inlets, `${p.id} ${spec.name}`).toContain(spec.modulatedBy.inlet)
      }
    }
  })

  it('gates only on a checkbox param of the same primitive', () => {
    for (const p of primitives) {
      const gates = [
        ...(p.params ?? []).map((s) => [s.name, s.trackGate] as const),
        ...(p.inlets ?? []).map((i) => [i.name, i.trackGate] as const)
      ]
      for (const [name, gate] of gates) {
        if (!gate) continue
        const gateSpec = p.params?.find((s) => s.name === gate.gateParam)
        expect(gateSpec?.booleanWidget, `${p.id} ${name}`).toBeDefined()
        expect(gateSpec?.default, `${p.id} ${name}`).toBe(gate.gateDefault)
      }
    }
  })

  it('gives every COARSE/FINE its semitone/cent unit and device type', () => {
    for (const p of primitives) {
      for (const spec of p.params ?? []) {
        if (spec.name === 'COARSE') expect(spec.nts1mkiiType, p.id).toBe('semi')
        if (spec.name === 'FINE') expect(spec.nts1mkiiType, p.id).toBe('cents')
        if (spec.name === 'COARSE' || spec.name === 'FINE') expect(spec.unit, p.id).toBeDefined()
      }
    }
  })
})

describe('findInletModulation (the canvas inlet marker)', () => {
  it('names the dial an inlet drives and whether it adds to or replaces it', () => {
    const vca = findLoguePrimitive('logue/gain/vca')!
    expect(findInletModulation(vca, 'gain')).toMatchObject({
      paramName: 'GAIN',
      modulation: { shape: 'replace' }
    })
    const comb = findLoguePrimitive('logue/filter/comb')!
    expect(findInletModulation(comb, 'tune')).toMatchObject({
      paramName: 'TUNE',
      modulation: { shape: 'additive' }
    })
    expect(findInletModulation(comb, 'in')).toBeUndefined()
  })
})

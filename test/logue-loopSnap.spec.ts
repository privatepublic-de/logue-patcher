import { describe, it, expect } from 'vitest'
import { crossingDirection, seamCost, snapLoopPoint } from '../logue-codegen/src/sample/loopSnap'

const PERIOD = 100

/** A sine of PERIOD samples, quantized to 8 bits like a stored sample. */
function sine(length: number, phase = 0): Float32Array {
  return Float32Array.from(
    { length },
    (_, i) => Math.round(100 * Math.sin((2 * Math.PI * (i + phase)) / PERIOD)) / 128
  )
}

describe('snapLoopPoint', () => {
  it('snaps a dragged start onto a rising crossing a whole number of periods before the end', () => {
    const samples = sine(4000)
    // Rising crossings of sin(2 pi i / 100) are at multiples of 100; the end sits on one.
    const end = 3000
    for (const position of [1234, 1270, 1490, 1950]) {
      const start = snapLoopPoint({
        samples,
        moving: 'start',
        position,
        other: end,
        radius: 80,
        minLength: 32
      })
      expect((end - start) % PERIOD).toBe(0)
      expect(Math.abs(start - position)).toBeLessThanOrEqual(80)
      expect(seamCost(samples, start, end)).toBe(0)
    }
  })

  it('snaps a dragged end the same way', () => {
    const samples = sine(4000)
    const end = snapLoopPoint({
      samples,
      moving: 'end',
      position: 2861,
      other: 500,
      radius: 80,
      minLength: 32
    })
    expect(end).toBe(2900)
  })

  it('skips crossings going the wrong way, even the nearest one', () => {
    const samples = sine(4000)
    // Falling crossings are at 50 + multiples of 100: the pointer sits right on one.
    const start = snapLoopPoint({
      samples,
      moving: 'start',
      position: 1450,
      other: 3000,
      radius: 70,
      minLength: 32
    })
    expect(start % PERIOD).toBe(0)
    expect(crossingDirection(samples, start)).toBe(1)
  })

  it('judges direction on the averaged slope, so a noisy crossing still counts as rising', () => {
    // A ramp through zero (1 LSB per 3 samples) with an alternating 1-LSB wiggle: raw sign
    // changes of both kinds around the crossing.
    const samples = Float32Array.from({ length: 400 }, (_, i) => {
      const ramp = Math.round((i - 200) / 3) / 128
      return ramp + (i % 2 ? 1 : -1) / 128
    })
    const raw: number[] = []
    let falling = 0
    for (let i = 190; i < 210; i++) {
      const rises = samples[i - 1] < 0 && samples[i] >= 0
      const falls = samples[i - 1] >= 0 && samples[i] < 0
      if (rises || falls) raw.push(i)
      if (falls) falling++
    }
    expect(falling).toBeGreaterThan(0)
    for (const i of raw) expect(crossingDirection(samples, i)).toBe(1)
  })

  it("snaps to the other point's level when that point isn't on a zero crossing", () => {
    const samples = sine(4000)
    // The end sits a quarter period past a rising crossing, at the sine's peak region.
    const end = 3013
    const start = snapLoopPoint({
      samples,
      moving: 'start',
      position: 1490,
      other: end,
      radius: 80,
      minLength: 32
    })
    expect((end - start) % PERIOD).toBe(0)
    expect(seamCost(samples, start, end)).toBe(0)
  })

  it('keeps the raw position when no crossing is in reach', () => {
    const samples = Float32Array.from({ length: 1000 }, () => 0.5)
    expect(
      snapLoopPoint({
        samples,
        moving: 'start',
        position: 300.4,
        other: 900,
        radius: 50,
        minLength: 32
      })
    ).toBe(300)
  })

  it('never makes a loop shorter than the minimum, or leaves the sample', () => {
    const samples = sine(1000)
    expect(
      snapLoopPoint({
        samples,
        moving: 'start',
        position: 990,
        other: 1000,
        radius: 50,
        minLength: 32
      })
    ).toBeLessThanOrEqual(968)
    expect(
      snapLoopPoint({ samples, moving: 'end', position: 5000, other: 0, radius: 50, minLength: 32 })
    ).toBeLessThanOrEqual(1000)
    expect(
      snapLoopPoint({
        samples,
        moving: 'start',
        position: -40,
        other: 600,
        radius: 50,
        minLength: 32
      })
    ).toBeGreaterThanOrEqual(0)
  })
})

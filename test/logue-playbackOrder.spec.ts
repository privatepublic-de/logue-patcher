import { describe, it, expect } from 'vitest'
import { playbackOrder, type SampleLoopMode } from '../logue-codegen/src/sample/playbackOrder'

/** The order unrolled for `count` samples, cycling as the device does. */
function unrolled(length: number, mode: SampleLoopMode, reverse: boolean, count: number): number[] {
  const { indices, cycleFrom } = playbackOrder(length, mode, { start: 200, end: 400 }, reverse)
  const out: number[] = []
  for (let k = 0; out.length < count; k++) {
    if (k < indices.length) out.push(indices[k])
    else if (cycleFrom === undefined) break
    else out.push(indices[cycleFrom + ((k - indices.length) % (indices.length - cycleFrom))])
  }
  return out
}

function range(from: number, to: number): number[] {
  const out: number[] = []
  for (let i = from; from <= to ? i <= to : i >= to; i += from <= to ? 1 : -1) out.push(i)
  return out
}

// The same sequences `scripts/runSampleHarness.ts` checks the generated step against (600
// samples, loop 200..400).
describe('playbackOrder', () => {
  it('plays a one-shot forwards or backwards once', () => {
    expect(unrolled(600, 'off', false, 1000)).toEqual(range(0, 599))
    expect(unrolled(600, 'off', true, 1000)).toEqual(range(599, 0))
  })

  it('loops forwards, or mirrored with REVERSE', () => {
    expect(unrolled(600, 'forward', false, 800)).toEqual([
      ...range(0, 399),
      ...range(200, 399),
      ...range(200, 399)
    ])
    expect(unrolled(600, 'forward', true, 800)).toEqual(
      [...range(599, 200), ...range(399, 200), ...range(399, 200)].slice(0, 800)
    )
  })

  it('bounces between the loop ends, turning on each end sample once', () => {
    expect(unrolled(600, 'pingpong', false, 897)).toEqual([
      ...range(0, 399),
      ...range(398, 200),
      ...range(201, 399),
      ...range(398, 300)
    ])
    expect(unrolled(600, 'pingpong', true, 798)).toEqual([
      ...range(599, 200),
      ...range(201, 399),
      ...range(398, 200)
    ])
  })
})

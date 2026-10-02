/**
 * The order `logue/osc/sample` reads a sample in at ROOT from a 48 kHz sample (one stored sample
 * per output sample), as stored indices: a lead-in, then a cycle repeated for as long as the note
 * is held. The Inspector's preview plays exactly this, since Web Audio can only loop forwards --
 * the step's own order is pinned by `scripts/runSampleHarness.ts`, and `logue-playbackOrder.spec`
 * checks this against the same sequences.
 */

export type SampleLoopMode = 'off' | 'forward' | 'pingpong'

export interface PlaybackOrder {
  /** Stored indices in play order: the lead-in, then one pass of the cycle (if any). */
  indices: Int32Array
  /** Where the repeated cycle starts in `indices`; it runs to the end. Absent for a one-shot. */
  cycleFrom?: number
}

function run(from: number, to: number): number[] {
  const out: number[] = []
  if (from <= to) for (let i = from; i <= to; i++) out.push(i)
  else for (let i = from; i >= to; i--) out.push(i)
  return out
}

/** `loop` in stored samples, `end` exclusive; ignored with `mode` 'off'. */
export function playbackOrder(
  length: number,
  mode: SampleLoopMode,
  loop: { start: number; end: number },
  reverse: boolean
): PlaybackOrder {
  const { start, end } = loop
  if (mode === 'off') {
    return { indices: Int32Array.from(reverse ? run(length - 1, 0) : run(0, length - 1)) }
  }
  if (mode === 'forward') {
    // Forwards: up to the loop's end, the loop being the last stretch. Backwards: down from the
    // end to the loop start, the loop (backwards) being the last stretch.
    return reverse
      ? { indices: Int32Array.from(run(length - 1, start)), cycleFrom: length - end }
      : { indices: Int32Array.from(run(0, end - 1)), cycleFrom: start }
  }
  // Ping-pong turns on the loop's first and last samples, each played once per turn.
  if (!reverse) {
    return {
      indices: Int32Array.from([...run(0, end - 1), ...run(end - 2, start + 1)]),
      cycleFrom: start
    }
  }
  return {
    indices: Int32Array.from([
      ...run(length - 1, start),
      ...run(start + 1, end - 1),
      ...run(end - 2, start + 1)
    ]),
    cycleFrom: length - 1 - start
  }
}

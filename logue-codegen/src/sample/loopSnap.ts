/**
 * Snapping a dragged loop point (`logue/osc/sample`, the Inspector's waveform). The waveform is
 * drawn unzoomed -- one pixel is ~70 samples of a 16K sample -- so a hand-placed point is only a
 * rough position; this picks the sample near it that makes the cleanest wrap:
 *  - only crossings of the level the waveform has at the other loop point, so the seam doesn't
 *    jump: zero crossings once the other point sits on one, but a loop point that came from a
 *    file needn't (forcing zero there made the seam several times worse on a real test);
 *  - only crossings going the same way as at the other loop point, judged on a smoothed slope
 *    (the mean of a few samples after minus a few before) so 8-bit noise riding on a slow
 *    crossing can't flip it;
 *  - among those, the one whose surroundings best match the other point's: the loop plays
 *    x[end-1] then x[start], so the material just before `end` should continue like the material
 *    just before `start` does, and the material from `end` on like the material from `start` on.
 * Without a usable crossing nearby, the raw position is kept.
 */

/** Samples on each side averaged for a crossing's direction: long enough to see through a 1-LSB
 *  wiggle, short enough for a half period down to 8 samples (3 kHz at 48 kHz). */
const SLOPE_SPAN = 8
/** Samples on each side of the seam compared between the two points. */
const SEAM_WINDOW = 16

export interface LoopSnapInput {
  /** Decoded samples, -1..1. */
  samples: Float32Array
  /** Which point is being dragged. */
  moving: 'start' | 'end'
  /** Where the pointer is, in samples (an `end` is exclusive, like `SampleAsset.loopEnd`). */
  position: number
  /** The other point, fixed during this drag. */
  other: number
  /** How far from `position` to look, in samples (a few pixels' worth). */
  radius: number
  /** The shortest loop allowed (`MIN_LOOP_LENGTH`). */
  minLength: number
}

function at(samples: Float32Array, i: number): number {
  return i >= 0 && i < samples.length ? samples[i] : 0
}

/** The smoothed slope's sign at a seam position: + rising, - falling, 0 flat. */
export function crossingDirection(samples: Float32Array, i: number): number {
  let before = 0
  let after = 0
  for (let k = 1; k <= SLOPE_SPAN; k++) {
    before += at(samples, i - k)
    after += at(samples, i + k - 1)
  }
  const slope = after - before
  return slope > 1e-6 ? 1 : slope < -1e-6 ? -1 : 0
}

/** Squared difference around the two seam positions -- 0 for a perfect continuation. */
export function seamCost(samples: Float32Array, start: number, end: number): number {
  let cost = 0
  for (let k = -SEAM_WINDOW; k < SEAM_WINDOW; k++) {
    const d = at(samples, end + k) - at(samples, start + k)
    cost += d * d
  }
  return cost
}

/** The snapped position, clamped to keep the loop valid (`start < end`, at least `minLength`). */
export function snapLoopPoint(input: LoopSnapInput): number {
  const { samples, moving, other, minLength } = input
  const length = samples.length
  const lo = moving === 'start' ? 0 : other + minLength
  const hi = moving === 'start' ? other - minLength : length
  const clamp = (v: number): number => Math.max(lo, Math.min(hi, Math.round(v)))
  const raw = clamp(input.position)
  if (lo > hi) return raw

  const wanted = crossingDirection(samples, other)
  // The level between the two samples either side of the other point's seam.
  const level = (at(samples, other - 1) + at(samples, other)) / 2
  const from = clamp(input.position - input.radius)
  const to = clamp(input.position + input.radius)
  let best = raw
  let bestCost = Infinity
  for (let i = Math.max(from, 1); i <= to; i++) {
    const a = samples[i - 1]
    const b = i < length ? samples[i] : 0
    const crosses = (a < level && b >= level) || (a >= level && b < level)
    if (!crosses) continue
    const direction = crossingDirection(samples, i)
    if (wanted !== 0 && direction !== wanted) continue
    const cost = moving === 'start' ? seamCost(samples, i, other) : seamCost(samples, other, i)
    // A slight pull towards the pointer, so equally good crossings resolve to the nearest.
    const total = cost + 1e-4 * Math.abs(i - input.position)
    if (total < bestCost) {
      bestCost = total
      best = i
    }
  }
  return best
}

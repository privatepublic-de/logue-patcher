/** YIN's cumulative-mean-normalized difference must dip below this for a period to count --
 *  above it the material is treated as unpitched (noise, a drum hit, a breath). */
export const YIN_APERIODICITY_THRESHOLD = 0.2

/** YIN's difference function d(lag) = sum (x[i] - x[i+lag])^2 over `n` samples from `start`,
 *  for lags 0..maxLag (index 0 unused). */
export function yinDifference(
  samples: Float32Array,
  start: number,
  n: number,
  maxLag: number
): Float64Array {
  const diff = new Float64Array(maxLag + 1)
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0
    for (let i = 0; i < n; i++) {
      const d = samples[start + i] - samples[start + i + lag]
      sum += d * d
    }
    diff[lag] = sum
  }
  return diff
}

/**
 * The first lag at or above `minLag` whose cumulative-mean-normalized difference dips below
 * `threshold`, walked down to the difference function's local minimum (rather than taking the
 * first sub-threshold lag); undefined when nothing dips (unpitched material).
 */
export function yinFirstDip(
  diff: Float64Array,
  minLag: number,
  threshold: number
): number | undefined {
  const maxLag = diff.length - 1
  let running = 0
  for (let lag = 1; lag <= maxLag; lag++) {
    running += diff[lag]
    const cmnd = running > 0 ? (diff[lag] * lag) / running : 1
    if (lag >= minLag && cmnd < threshold) {
      let bestLag = lag
      while (bestLag + 1 <= maxLag && diff[bestLag + 1] < diff[bestLag]) bestLag++
      return bestLag
    }
  }
  return undefined
}

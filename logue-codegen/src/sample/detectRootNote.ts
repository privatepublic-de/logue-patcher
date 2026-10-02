const MIN_HZ = 40
const MAX_HZ = 2000
const WINDOW_SECONDS = 0.1
// YIN's cumulative-mean-normalized difference must dip below this for a period to count --
// above it the material is treated as unpitched (noise, a drum hit) and no root is proposed.
const APERIODICITY_THRESHOLD = 0.2

/**
 * A plain YIN estimate over the loudest ~100 ms of the source, rounded to the nearest MIDI note.
 * Only ever a proposal for the ROOT param, which stays user-editable -- so a nearest-note guess
 * is enough, no sub-semitone refinement.
 */
export function detectRootNote(samples: Float32Array, sampleRate: number): number | undefined {
  const windowLength = Math.min(samples.length, Math.round(WINDOW_SECONDS * sampleRate))
  const maxLag = Math.min(Math.floor(sampleRate / MIN_HZ), Math.floor(windowLength / 2))
  const minLag = Math.max(2, Math.floor(sampleRate / MAX_HZ))
  if (maxLag <= minLag) return undefined

  const start = loudestWindowStart(samples, windowLength + maxLag)
  const n = windowLength - maxLag
  if (n < minLag) return undefined
  const diff = new Float64Array(maxLag + 1)
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0
    for (let i = 0; i < n; i++) {
      const d = samples[start + i] - samples[start + i + lag]
      sum += d * d
    }
    diff[lag] = sum
  }
  let running = 0
  let bestLag = -1
  for (let lag = 1; lag <= maxLag; lag++) {
    running += diff[lag]
    const cmnd = running > 0 ? (diff[lag] * lag) / running : 1
    if (lag >= minLag && cmnd < APERIODICITY_THRESHOLD) {
      // Walk down to the local minimum rather than taking the first sub-threshold lag.
      bestLag = lag
      while (bestLag + 1 <= maxLag && diff[bestLag + 1] < diff[bestLag]) bestLag++
      break
    }
  }
  if (bestLag < 0) return undefined
  const hz = sampleRate / bestLag
  return Math.round(69 + 12 * Math.log2(hz / 440))
}

function loudestWindowStart(samples: Float32Array, span: number): number {
  if (samples.length <= span) return 0
  const hop = Math.max(1, Math.floor(span / 4))
  let best = 0
  let bestEnergy = -1
  for (let s = 0; s + span <= samples.length; s += hop) {
    let e = 0
    for (let i = s; i < s + span; i += 4) e += samples[i] * samples[i]
    if (e > bestEnergy) {
      bestEnergy = e
      best = s
    }
  }
  return best
}

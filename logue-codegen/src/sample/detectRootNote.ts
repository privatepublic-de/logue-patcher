import { yinDifference, yinFirstDip, YIN_APERIODICITY_THRESHOLD } from './yin'

const MIN_HZ = 40
const MAX_HZ = 2000
const WINDOW_SECONDS = 0.1

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
  const bestLag = yinFirstDip(
    yinDifference(samples, start, n, maxLag),
    minLag,
    YIN_APERIODICITY_THRESHOLD
  )
  if (bestLag === undefined) return undefined
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

import { resample } from './resample'
import { yinDifference, yinFirstDip, YIN_APERIODICITY_THRESHOLD } from './yin'

const MIN_HZ = 40
const MAX_HZ = 2000
/** Tracking runs on a copy at about this rate: YIN's cost is window x lags, both in samples, so
 *  a 48 kHz source would cost 16x as much for no better pitch (the sub-sample refinement below
 *  carries the precision, and the cycle analysis reads the full-rate source). */
const ANALYSIS_RATE = 12000
export const PITCH_TRACK_HOP_SECONDS = 0.005
/** A hop this far below the loudest one (-40 dB) is unvoiced whatever YIN says: on near-silence
 *  the normalized difference can dip on hum or reverb tails. */
const SILENT_HOP_RATIO = 0.01
/** Hops each side the median looks at; it removes single-hop octave jumps. */
const MEDIAN_RADIUS = 2

export interface PitchTrack {
  hopSeconds: number
  /** Fundamental per hop in Hz, 0 where unvoiced. Hop h is centred at `h * hopSeconds`. */
  f0: Float64Array
  /** RMS per hop, over YIN's window. */
  level: Float64Array
}

/** YIN per 5 ms hop with a parabolic sub-sample lag, an energy gate and a median over voiced
 *  neighbours. */
export function trackPitch(samples: Float32Array, sampleRate: number): PitchTrack {
  const rate = Math.min(sampleRate, ANALYSIS_RATE)
  const x = rate === sampleRate ? samples : resample(samples, sampleRate, rate)
  const maxLag = Math.floor(rate / MIN_HZ)
  const minLag = Math.max(2, Math.floor(rate / MAX_HZ))
  const n = maxLag
  const span = n + maxLag
  const hop = PITCH_TRACK_HOP_SECONDS * rate
  const hops = Math.max(0, Math.floor(x.length / hop) + 1)
  const raw = new Float64Array(hops)
  const energy = new Float64Array(hops)
  let loudest = 0
  for (let h = 0; h < hops; h++) {
    const start = Math.round(h * hop - span / 2)
    if (start < 0 || start + span > x.length) continue
    let e = 0
    for (let i = start; i < start + n; i++) e += x[i] * x[i]
    energy[h] = e
    loudest = Math.max(loudest, e)
    const diff = yinDifference(x, start, n, maxLag)
    const lag = yinFirstDip(diff, minLag, YIN_APERIODICITY_THRESHOLD)
    if (lag === undefined) continue
    raw[h] = rate / refineLag(x, h * hop, lag)
  }
  const gate = loudest * SILENT_HOP_RATIO * SILENT_HOP_RATIO
  for (let h = 0; h < hops; h++) if (energy[h] < gate) raw[h] = 0

  const f0 = new Float64Array(hops)
  const window: number[] = []
  for (let h = 0; h < hops; h++) {
    if (raw[h] === 0) continue
    window.length = 0
    for (let j = h - MEDIAN_RADIUS; j <= h + MEDIAN_RADIUS; j++) {
      if (j >= 0 && j < hops && raw[j] > 0) window.push(raw[j])
    }
    window.sort((a, b) => a - b)
    f0[h] = window[window.length >> 1]
  }
  const level = energy.map((e) => Math.sqrt(e / n))
  return { hopSeconds: PITCH_TRACK_HOP_SECONDS, f0, level }
}

/**
 * The lag near YIN's integer `lag`, re-measured over a short window CENTRED on the hop (two
 * periods; every compared pair straddles the centre equally) and refined by a parabola. The
 * detection window is long and sits mostly before the hop, which lagged a 6 Hz +-50 ct vibrato by
 * ~10 ms (13 ct rms error) -- enough to smear the upper harmonics in the cycle analysis.
 */
function refineLag(x: Float32Array, centre: number, lag: number): number {
  const n = 2 * lag
  const d = (l: number): number => {
    const start = Math.round(centre - (n + l) / 2)
    if (start < 0 || start + n + l > x.length) return NaN
    let sum = 0
    for (let i = start; i < start + n; i++) {
      const v = x[i] - x[i + l]
      sum += v * v
    }
    return sum
  }
  let best = lag
  let b = d(lag)
  // Walk to the local minimum (the short window can move it by a sample or two).
  for (let step = 0; step < 3; step++) {
    const lo = d(best - 1)
    const hi = d(best + 1)
    if (lo < b && lo <= hi) {
      best--
      b = lo
    } else if (hi < b) {
      best++
      b = hi
    } else break
  }
  const a = d(best - 1)
  const c = d(best + 1)
  const den = a - 2 * b + c
  if (!(den > 0)) return best
  return best + Math.max(-1, Math.min(1, (0.5 * (a - c)) / den))
}

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
/** Hops each side (200 ms) of the context a hop's pitch is checked against: a strong formant
 *  makes the waveform nearly a sine at one harmonic for tens of ms (YIN's first dip is then that
 *  harmonic's period), longer than the 5-hop median can outvote. */
const CONTEXT_RADIUS = 40
/** Further than this from the context (about 1.6 semitones) a hop is re-measured near it. A
 *  formant between two harmonics once locked at 9/8 of the pitch; a real step of a few semitones
 *  still finds its own clean dip in the re-measure's -15..+18 % window. */
const CONTEXT_RATIO = 1.1
/** A re-measured hop needs a dip this clean near the expected period, else it's unvoiced. */
const CONTEXT_APERIODICITY = 0.35

export interface PitchTrack {
  hopSeconds: number
  /** Fundamental per hop in Hz, 0 where unvoiced. Hop h is centred at `h * hopSeconds`. */
  f0: Float64Array
  /** RMS per hop, over YIN's window. */
  level: Float64Array
}

/**
 * YIN per 5 ms hop with a parabolic sub-sample lag, an energy gate, two checks for harmonic
 * locks (a much cleaner multiple of the period; a hop far from its 200 ms context) and a median
 * over voiced neighbours. Known miss: a narrow, strong formant between two harmonics over a weak
 * fundamental can repeat at (n+1)/n of the pitch for as long as it lasts (a synthetic 2.3 kHz
 * formant over 220 Hz did, at 10/9, for 0.55 s). Catching that means accepting any clearly
 * cleaner longer lag, which risks putting breathy material an octave low -- a whole table playing
 * an octave down is the worse failure.
 */
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
    raw[h] = rate / refineLag(x, h * hop, periodFromMultiples(diff, lag))
  }
  const gate = loudest * SILENT_HOP_RATIO * SILENT_HOP_RATIO
  for (let h = 0; h < hops; h++) if (energy[h] < gate) raw[h] = 0

  // Short harmonic locks that look clean (which the multiples check leaves alone): a hop far
  // from its 200 ms context is measured again near the context's period. Checked against the
  // uncorrected track, whose median a lock of up to ~200 ms can't move.
  const context = raw.map((_, h) => (raw[h] > 0 ? voicedMedian(raw, h, CONTEXT_RADIUS) : 0))
  for (let h = 0; h < hops; h++) {
    if (raw[h] === 0) continue
    const ratio = raw[h] / context[h]
    if (ratio < CONTEXT_RATIO && ratio > 1 / CONTEXT_RATIO) continue
    const expected = rate / context[h]
    const start = Math.round(h * hop - span / 2)
    const diff = yinDifference(x, start, n, maxLag)
    const lag = dipNear(diff, expected * 0.85, expected * 1.18, CONTEXT_APERIODICITY)
    raw[h] = lag === undefined ? 0 : rate / refineLag(x, h * hop, lag)
  }

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

/** YIN's period stands when it repeats this cleanly: a clean saw scored 0.02 at 12 kHz, and
 *  its own double 0.001 only because twice the period fell nearer a whole sample. */
const CLEAN_PERIOD = 0.1
/** A multiple has to repeat this much more cleanly to replace an unclean period: the 9th-harmonic
 *  lock below scored 0.18, the true period 0.11. */
const MULTIPLE_GAIN = 1.5

/**
 * YIN's first dip, or the smallest whole multiple of it that repeats far more cleanly. A strong
 * formant makes the waveform nearly a sine at one harmonic: its period dips under the threshold
 * first, though the true period (a multiple of it) repeats almost exactly -- a 2 kHz formant over
 * a 220 Hz voice locked onto the 9th harmonic.
 */
function periodFromMultiples(diff: Float64Array, lag: number): number {
  const maxLag = diff.length - 1
  const cmnd = new Float64Array(maxLag + 1).fill(1)
  let running = 0
  for (let l = 1; l <= maxLag; l++) {
    running += diff[l]
    cmnd[l] = running > 0 ? (diff[l] * l) / running : 1
  }
  // Each multiple's best value within a sample of k * lag (the lag itself is whole).
  const near = (l: number): { lag: number; value: number } => {
    let best = { lag: l, value: cmnd[l] }
    for (const c of [l - 1, l + 1])
      if (c <= maxLag && cmnd[c] < best.value) best = { lag: c, value: cmnd[c] }
    return best
  }
  const candidates: { lag: number; value: number }[] = []
  for (let k = 2; k * lag + 1 <= maxLag; k++) candidates.push(near(k * lag))
  if (cmnd[lag] < CLEAN_PERIOD) return lag
  // The smallest such multiple: larger ones include the true period's own multiples, and the
  // cleanest of all was twice the period (an octave low) once.
  return candidates.find((c) => c.value * MULTIPLE_GAIN < cmnd[lag])?.lag ?? lag
}

/** Median of the voiced values within `radius` of `h`. */
function voicedMedian(values: Float64Array, h: number, radius: number): number {
  const window: number[] = []
  for (let j = Math.max(0, h - radius); j <= Math.min(values.length - 1, h + radius); j++) {
    if (values[j] > 0) window.push(values[j])
  }
  window.sort((a, b) => a - b)
  return window[window.length >> 1]
}

/** The lag in [lo, hi] with the lowest cumulative-mean-normalized difference, if that is under
 *  `threshold`. */
function dipNear(
  diff: Float64Array,
  lo: number,
  hi: number,
  threshold: number
): number | undefined {
  const last = Math.min(diff.length - 1, Math.ceil(hi))
  let running = 0
  let best: number | undefined
  let bestValue = threshold
  for (let lag = 1; lag <= last; lag++) {
    running += diff[lag]
    if (lag < lo) continue
    const cmnd = running > 0 ? (diff[lag] * lag) / running : 1
    if (cmnd < bestValue) {
      bestValue = cmnd
      best = lag
    }
  }
  return best
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

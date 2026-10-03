import type { SampleAsset } from '../../../src/shared/domain/patch'
import { bytesToBase64 } from './base64'
import { trimSilence } from './importSample'
import { trackPitch, type PitchTrack } from './pitchTrack'
import { decodeWav } from './wav'

/** Frame-count choices: 32 x 256 fits the xd beside a small patch (with the codegen-baked mip
 *  levels 20 KB), 64 only the NTS-1 mkII. See docs/PLAN-wavetable.md's budget table. */
export const WAVETABLE_FRAME_COUNTS = [16, 32, 64] as const
export const DEFAULT_WAVETABLE_FRAME_COUNT = 32
/** Points per frame; a frame holds up to a quarter as many harmonics (4 points per cycle of the
 *  top one, for the player's linear interpolation). */
export const WAVETABLE_FRAME_LENGTHS = [256, 512] as const
export const DEFAULT_WAVETABLE_FRAME_LENGTH = 256
/** Less voiced material than this can't give distinct frames. */
export const MIN_VOICED_SECONDS = 0.1
/** Periods each analysis window spans: the Hann main lobe is then +-2/3 of the fundamental, so
 *  neighbouring harmonics fall outside it, while a vibrato moves little inside it. */
const ANALYSIS_PERIODS = 3
/** Harmonics stop below the source's own Nyquist, where its anti-alias filter already cuts. */
const SOURCE_BANDWIDTH = 0.45
/** Below this share of the strongest harmonic (-30 dB) the fundamental's phase is noise, so the
 *  frame is aligned to its predecessor instead. */
const WEAK_FUNDAMENTAL = 0.0316
/** "Even it out": quiet frames are raised to the loudest one's RMS by at most +12 dB, so a
 *  breathy frame isn't blown up into noise. */
const MAX_LEVEL_GAIN = 3.981
/** Pitched hops this far below the loudest (-20 dB) aren't used for frames: a sung note's decay
 *  or reverb tail stays pitched, but would come out a near-flat frame even after the +12 dB. */
const QUIET_HOP = 0.1
/** Only this much of a source is analysed: frames are spread over it, and the tracker's cost
 *  grows with the length (~0.2 s per 2 s of audio). */
export const MAX_ANALYSIS_SECONDS = 30

export interface ImportedWavetable {
  asset: SampleAsset
  sourceRate: number
  sourceSeconds: number
  /** Pitched material the frames came from, and what was skipped (breaths, consonants, gaps,
   *  quiet tails). */
  voicedSeconds: number
  skippedSeconds: number
  /** Range and median of the frames' pitches, as (fractional) MIDI notes. */
  lowestNote: number
  highestNote: number
  medianNote: number
  /** Harmonics a frame at the median pitch holds, and whether the source's rate (rather than the
   *  frame length) is what limits them. */
  harmonics: number
  harmonicsLimitedBySource: boolean
  /** Where each frame was measured, in seconds into the trimmed source. */
  frameSeconds: number[]
}

/** One cycle as harmonics: amplitude and phase (cosine convention) per k = 1..K. */
interface Harmonics {
  amp: Float64Array
  phase: Float64Array
}

/**
 * The wavetable import: track the pitch, spread `frameCount` positions evenly over the voiced
 * material, measure each position's harmonics over a few periods and rebuild ONE exact cycle
 * from them (periodic, band-limited, no DC), every frame turned so its fundamental starts at
 * phase 0 (aligned frames don't cancel when the player crossfades neighbours), levels evened
 * out, stored as signed 8-bit. See docs/PLAN-wavetable.md.
 */
export function importWavetable(
  wavBytes: Uint8Array,
  sourceName: string,
  frameCount: number,
  frameLength: number,
  sourcePath?: string
): ImportedWavetable {
  const wav = decodeWav(wavBytes)
  const rate = wav.sampleRate
  const trimmed = trimSilence(wav.samples)
  if (trimmed.length === 0) throw new Error(`"${sourceName}" is silent.`)
  const sourceSeconds = trimmed.length / rate
  const source = trimmed.subarray(0, Math.floor(MAX_ANALYSIS_SECONDS * rate))

  const track = trackPitch(source, rate)
  const loudest = track.level.reduce((a, b) => Math.max(a, b), 0)
  const voiced: number[] = []
  for (let h = 0; h < track.f0.length; h++) {
    if (track.f0[h] > 0 && track.level[h] >= loudest * QUIET_HOP) voiced.push(h)
  }
  const voicedSeconds = voiced.length * track.hopSeconds
  if (voicedSeconds < MIN_VOICED_SECONDS) {
    throw new Error(
      `"${sourceName}" has too little pitched material for a wavetable (${voicedSeconds.toFixed(2)} s; ` +
        `needs ${MIN_VOICED_SECONDS} s of a clear pitch).`
    )
  }

  const maxHarmonics = frameLength / 4
  const cycles: Harmonics[] = []
  const pitches: number[] = []
  const frameSeconds: number[] = []
  for (let i = 0; i < frameCount; i++) {
    const h = voiced[Math.floor(((i + 0.5) * voiced.length) / frameCount)]
    const f0 = track.f0[h]
    const period = rate / f0
    // The window's extent at the frame's own pitch, for the bounds check and the centre clamp.
    const half = (ANALYSIS_PERIODS / 2) * period
    if (2 * half + 2 > source.length) {
      throw new Error(
        `"${sourceName}" is shorter than ${ANALYSIS_PERIODS} periods of its own pitch.`
      )
    }
    const centre = Math.min(
      Math.max(h * track.hopSeconds * rate, half + 1),
      source.length - half - 2
    )
    const k = Math.max(1, Math.min(maxHarmonics, Math.floor((SOURCE_BANDWIDTH * rate) / f0)))
    const measured = measureHarmonics(source, centre, (n) => trackedHz(track, n / rate) / rate, k)
    cycles.push(alignCycle(measured, cycles[cycles.length - 1]))
    pitches.push(69 + 12 * Math.log2(f0 / 440))
    frameSeconds.push(centre / rate)
  }

  const frames = cycles.map((c) => synthesizeCycle(c, frameLength))
  evenOutLevels(frames, cycles)
  const stored = quantizeFrames(frames, frameLength)

  const asset: SampleAsset = {
    sourceName,
    rate,
    encoding: 'wt8',
    data: bytesToBase64(stored),
    frameLength,
    frameCount
  }
  if (sourcePath !== undefined) asset.sourcePath = sourcePath
  if (source.length < trimmed.length) asset.truncatedFromSeconds = sourceSeconds

  const sorted = [...pitches].sort((a, b) => a - b)
  const medianNote = sorted[sorted.length >> 1]
  const medianHz = 440 * 2 ** ((medianNote - 69) / 12)
  const sourceLimit = Math.floor((SOURCE_BANDWIDTH * rate) / medianHz)
  return {
    asset,
    sourceRate: rate,
    sourceSeconds,
    voicedSeconds,
    skippedSeconds: Math.max(0, source.length / rate - voicedSeconds),
    lowestNote: sorted[0],
    highestNote: sorted[sorted.length - 1],
    medianNote,
    harmonics: Math.max(1, Math.min(maxHarmonics, sourceLimit)),
    harmonicsLimitedBySource: sourceLimit < maxHarmonics,
    frameSeconds
  }
}

/**
 * Amplitude and phase of harmonics 1..K around `centre` (fractional), measured against the
 * tracked pitch rather than a constant one: theta(n) integrates `cyclesPerSample(n)` from
 * theta(centre) = 0, the window is a Hann over |theta| <= ANALYSIS_PERIODS/2 cycles, and
 * x ~ sum A_k cos(k theta(n) + phi_k). With a constant pitch a 6 Hz +-50 ct vibrato smeared the
 * upper harmonics out of the window's main lobe (-5 dB at the 25th, -15 dB past the 35th).
 */
function measureHarmonics(
  x: Float32Array,
  centre: number,
  cyclesPerSample: (n: number) => number,
  count: number
): Harmonics {
  const halfCycles = ANALYSIS_PERIODS / 2
  // theta in cycles at each integer sample, walked out from the centre both ways.
  const theta = new Map<number, number>()
  const c0 = Math.floor(centre)
  theta.set(c0, -(centre - c0) * cyclesPerSample(centre))
  for (let n = c0 + 1; n < x.length; n++) {
    const t = theta.get(n - 1)! + cyclesPerSample(n - 0.5)
    if (t > halfCycles) break
    theta.set(n, t)
  }
  for (let n = c0 - 1; n >= 0; n--) {
    const t = theta.get(n + 1)! - cyclesPerSample(n + 0.5)
    if (t < -halfCycles) break
    theta.set(n, t)
  }
  const re = new Float64Array(count + 1)
  const im = new Float64Array(count + 1)
  let winSum = 0
  for (const [n, t] of theta) {
    const w = 0.5 * (1 + Math.cos((Math.PI * t) / halfCycles))
    winSum += w
    const v = w * x[n]
    // e^{-i k 2 pi theta} for k = 1..K by repeated multiplication.
    const sr = Math.cos(-2 * Math.PI * t)
    const si = Math.sin(-2 * Math.PI * t)
    let zr = sr
    let zi = si
    for (let k = 1; k <= count; k++) {
      re[k] += v * zr
      im[k] += v * zi
      const r = zr * sr - zi * si
      zi = zr * si + zi * sr
      zr = r
    }
  }
  const amp = new Float64Array(count + 1)
  const phase = new Float64Array(count + 1)
  for (let k = 1; k <= count; k++) {
    amp[k] = (2 * Math.hypot(re[k], im[k])) / winSum
    phase[k] = Math.atan2(im[k], re[k])
  }
  return { amp, phase }
}

/** The tracked pitch at `seconds`, interpolated between hop centres; an unvoiced hop takes its
 *  nearest voiced neighbour's pitch (the window may reach a little past a voiced span). */
function trackedHz(track: PitchTrack, seconds: number): number {
  const f0 = track.f0
  const pos = Math.min(Math.max(seconds / track.hopSeconds, 0), f0.length - 1)
  const h = Math.floor(pos)
  const a = voicedNear(f0, h)
  const b = voicedNear(f0, Math.min(h + 1, f0.length - 1))
  return a + (b - a) * (pos - h)
}

function voicedNear(f0: Float64Array, h: number): number {
  for (let d = 0; d < f0.length; d++) {
    if (h - d >= 0 && f0[h - d] > 0) return f0[h - d]
    if (h + d < f0.length && f0[h + d] > 0) return f0[h + d]
  }
  return 0
}

/**
 * Turns a cycle so its fundamental is a sine starting at 0 (every harmonic k moved by k times
 * the fundamental's shift). With a weak fundamental the shift that best matches the previous
 * frame is used instead, searched over the frame's own resolution.
 */
function alignCycle(c: Harmonics, previous: Harmonics | undefined): Harmonics {
  const count = c.amp.length - 1
  let strongest = 0
  for (let k = 1; k <= count; k++) strongest = Math.max(strongest, c.amp[k])
  let shift = -Math.PI / 2 - c.phase[1]
  if (previous && c.amp[1] < WEAK_FUNDAMENTAL * strongest) {
    const shared = Math.min(count, previous.amp.length - 1)
    const steps = 1024
    let best = -Infinity
    for (let s = 0; s < steps; s++) {
      const tau = (2 * Math.PI * s) / steps
      let corr = 0
      for (let k = 1; k <= shared; k++) {
        corr += c.amp[k] * previous.amp[k] * Math.cos(c.phase[k] + k * tau - previous.phase[k])
      }
      if (corr > best) {
        best = corr
        shift = tau
      }
    }
  }
  const phase = new Float64Array(count + 1)
  for (let k = 1; k <= count; k++) phase[k] = c.phase[k] + k * shift
  return { amp: c.amp, phase }
}

function synthesizeCycle(c: Harmonics, length: number): Float64Array {
  const out = new Float64Array(length)
  for (let k = 1; k < c.amp.length; k++) {
    const a = c.amp[k]
    if (a === 0) continue
    for (let j = 0; j < length; j++)
      out[j] += a * Math.cos((2 * Math.PI * k * j) / length + c.phase[k])
  }
  return out
}

function evenOutLevels(frames: Float64Array[], cycles: Harmonics[]): void {
  const rms = cycles.map((c) => {
    let e = 0
    for (let k = 1; k < c.amp.length; k++) e += c.amp[k] * c.amp[k]
    return Math.sqrt(e / 2)
  })
  const target = Math.max(...rms)
  frames.forEach((frame, i) => {
    const gain = rms[i] > 0 ? Math.min(target / rms[i], MAX_LEVEL_GAIN) : 0
    for (let j = 0; j < frame.length; j++) frame[j] *= gain
  })
}

/** One peak normalization over all frames (so their evened-out levels stay), rounded to signed
 *  8-bit like the plain import -- no dither. */
function quantizeFrames(frames: Float64Array[], length: number): Uint8Array {
  let peak = 0
  for (const frame of frames) for (const v of frame) peak = Math.max(peak, Math.abs(v))
  const gain = peak > 0 ? 127 / peak : 0
  const out = new Uint8Array(frames.length * length)
  frames.forEach((frame, i) => {
    for (let j = 0; j < length; j++) {
      out[i * length + j] = Math.max(-127, Math.min(127, Math.round(frame[j] * gain))) & 0xff
    }
  })
  return out
}

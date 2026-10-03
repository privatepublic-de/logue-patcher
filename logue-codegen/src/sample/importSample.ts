import type { SampleAsset } from '../../../src/shared/domain/patch'
import { bytesToBase64, base64ToBytes } from './base64'
import { detectRootNote } from './detectRootNote'
import { mulawDecode, mulawEncode } from './mulaw'
import { resample } from './resample'
import { decodeWav, WAV_LOOP_FORWARD } from './wav'

/** The length choices offered at import, in stored samples (= bytes, at 1 byte per mu-law sample). */
export const SAMPLE_SIZE_CHOICES = [4096, 8192, 16384, 32768] as const
/** Half the xd's 32 KB SRAM, leaving the rest for code and other nodes -- the platform-agnostic default. */
export const DEFAULT_SAMPLE_SIZE = 16384
/** Never stored above the device's own output rate -- anything higher is only wasted bytes. */
export const MAX_SAMPLE_RATE = 48000
/** Below this the result is barely recognizable; a longer source is cut instead of going lower. */
export const MIN_SAMPLE_RATE = 2000
// -60 dB relative to the peak: only true silence at either end is trimmed, never quiet content.
const SILENCE_THRESHOLD = 0.001

export interface ImportedSample {
  asset: SampleAsset
  /** Proposed ROOT param value, or undefined when the material isn't clearly pitched. */
  rootNote?: number
  sourceSeconds: number
}

/**
 * The whole import: decode, mix to mono, trim silence at both ends, resample the rest so it fits
 * `size` samples (the rate follows from the length -- no crop step), normalize, mu-law encode.
 */
export function importWavSample(
  wavBytes: Uint8Array,
  sourceName: string,
  size: number,
  sourcePath?: string
): ImportedSample {
  const wav = decodeWav(wavBytes)
  const trimmed = trimSilence(wav.samples)
  if (trimmed.length === 0) throw new Error(`"${sourceName}" is silent.`)
  const sourceSeconds = trimmed.length / wav.sampleRate

  let rate = Math.floor(Math.min(wav.sampleRate, MAX_SAMPLE_RATE, size / sourceSeconds))
  let source = trimmed
  let truncatedFromSeconds: number | undefined
  if (rate < MIN_SAMPLE_RATE) {
    rate = MIN_SAMPLE_RATE
    source = trimmed.subarray(0, Math.floor((size / rate) * wav.sampleRate))
    truncatedFromSeconds = sourceSeconds
  }

  const resampled = resample(source, wav.sampleRate, rate).subarray(0, size)
  normalizePeak(resampled)
  const encoded = new Uint8Array(resampled.length)
  for (let i = 0; i < resampled.length; i++) encoded[i] = mulawEncode(resampled[i])

  const asset: SampleAsset = {
    sourceName,
    rate,
    encoding: 'mulaw8',
    data: bytesToBase64(encoded)
  }
  if (sourcePath !== undefined) asset.sourcePath = sourcePath
  if (truncatedFromSeconds !== undefined) asset.truncatedFromSeconds = truncatedFromSeconds
  return { asset, rootNote: detectRootNote(trimmed, wav.sampleRate), sourceSeconds }
}

export function sampleBytes(asset: Pick<SampleAsset, 'data'>): Uint8Array {
  return base64ToBytes(asset.data)
}

/** Decoded -1..1 values, for the Inspector's waveform preview. Only the bytes and their encoding
 *  matter, so a caller can key a memo on just those (a loop edit then keeps the decode). */
export function decodeSampleAsset(asset: Pick<SampleAsset, 'data' | 'encoding'>): Float32Array {
  const bytes = sampleBytes(asset)
  const out = new Float32Array(bytes.length)
  if (asset.encoding === 'pcm8' || asset.encoding === 'wt8') {
    for (let i = 0; i < bytes.length; i++) out[i] = pcm8Decode(bytes[i])
  } else {
    for (let i = 0; i < bytes.length; i++) out[i] = mulawDecode(bytes[i])
  }
  return out
}

/** FNV-1a over the stored bytes -- names the baked table, so identical samples dedupe to one.
 *  A wavetable's frame length is hashed too: the same bytes cut into other frames are another
 *  table (the other encodings' hashes are unchanged by it). */
export function sampleContentHash(asset: SampleAsset): string {
  let hash = 0x811c9dc5
  const mix = (byte: number): void => {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  if (asset.encoding === 'wt8' && asset.frameLength !== undefined) {
    for (let shift = 0; shift < 32; shift += 8) mix((asset.frameLength >>> shift) & 0xff)
  }
  const bytes = sampleBytes(asset)
  for (let i = 0; i < bytes.length; i++) mix(bytes[i])
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function trimSilence(samples: Float32Array): Float32Array {
  const [start, end] = silenceBounds(samples)
  return samples.subarray(start, end)
}

/** [start, end) of what's above the silence threshold; [0, 0) for true silence. */
function silenceBounds(samples: Float32Array): [number, number] {
  let peak = 0
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]))
  if (peak === 0) return [0, 0]
  const threshold = peak * SILENCE_THRESHOLD
  let start = 0
  while (start < samples.length && Math.abs(samples[start]) < threshold) start++
  let end = samples.length
  while (end > start && Math.abs(samples[end - 1]) < threshold) end--
  return [start, end]
}

function normalizePeak(samples: Float32Array): void {
  let peak = 0
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]))
  if (peak === 0) return
  const gain = 1 / peak
  for (let i = 0; i < samples.length; i++) samples[i] *= gain
}

// ---- the plain import (`logue/osc/sample`) -------------------------------------------------

/** The maximum-length choices for the plain import, in stored samples (= bytes). Measured
 *  `logue/osc/sample` units (`scripts/stageSample.ts`): xd 17 728 B with 16K (of 32 768), NTS-1
 *  mkII 46 378 B with 40K (of 49 152; 44K didn't fit). So 24K is about the xd's limit beside a
 *  small patch, 40K the NTS-1 mkII's for the sample alone; the RAM gauge decides. */
export const PLAIN_SAMPLE_MAX_LENGTHS = [8192, 16384, 24576, 32768, 40960] as const
export const DEFAULT_PLAIN_SAMPLE_MAX_LENGTH = 16384
/** A shorter loop could need more than one wrap per sample at the player's top speed. */
export const MIN_LOOP_LENGTH = 32

/** What happens to a source longer than the maximum: cut its tail, or downsample it to fit. */
export type PlainSampleFit = 'cut' | 'downsample'

export interface ImportedPlainSample {
  asset: SampleAsset
  /** Proposed ROOT, from the file's `smpl` chunk when it has one, else detected. */
  rootNote?: number
  rootSource?: 'smpl' | 'detected'
  /** The source's own rate and (trimmed) length, before any downsampling or cut. */
  sourceRate: number
  sourceSeconds: number
  /** True when the stored bytes are the file's own 8-bit values, untouched. */
  bitExact: boolean
  /** A loop in the file that couldn't be kept, and why. */
  droppedLoop?: { reason: 'type' | 'invalid' | 'short' | 'cut'; type?: number }
}

/** Linear signed 8-bit, two's complement -- the on-device decode is `(int8_t)b * (1.f/128.f)`. */
export function pcm8Decode(byte: number): number {
  return (byte >= 128 ? byte - 256 : byte) / 128
}

/**
 * The plain import: decode, mix to mono, trim silence (never inside the loop), keep the source's
 * own rate (48 kHz at most), fit into `maxLength` by `fit`, store as linear 8-bit. A mono 8-bit
 * source that needed no resampling is stored bit-exactly; anything else is peak-normalized and
 * rounded -- no dither, on purpose (the 8-bit grit is the point; see docs/PLAN-sample.md).
 */
export function importPlainSample(
  wavBytes: Uint8Array,
  sourceName: string,
  maxLength: number,
  fit: PlainSampleFit,
  sourcePath?: string
): ImportedPlainSample {
  const wav = decodeWav(wavBytes)
  const all = wav.samples
  let droppedLoop: ImportedPlainSample['droppedLoop']

  // The file's loop as [start, end) in source samples.
  let loop: { start: number; end: number } | undefined
  const fileLoop = wav.sampler?.loop
  if (fileLoop) {
    if (fileLoop.type !== WAV_LOOP_FORWARD) {
      droppedLoop = { reason: 'type', type: fileLoop.type }
    } else if (fileLoop.start > fileLoop.end || fileLoop.end >= all.length) {
      droppedLoop = { reason: 'invalid' }
    } else {
      loop = { start: fileLoop.start, end: fileLoop.end + 1 }
    }
  }

  const [trimStart, trimEnd] = silenceBounds(all)
  if (trimEnd <= trimStart) throw new Error(`"${sourceName}" is silent.`)
  const start = loop ? Math.min(trimStart, loop.start) : trimStart
  const end = loop ? Math.max(trimEnd, loop.end) : trimEnd
  let source = all.subarray(start, end)
  if (loop) loop = { start: loop.start - start, end: loop.end - start }
  const sourceSeconds = source.length / wav.sampleRate

  let rate = wav.sampleRate
  let resampledFromRate: number | undefined
  const resampleTo = (to: number): void => {
    const ratio = to / rate
    source = resample(source, rate, to)
    if (loop) loop = scaleLoop(loop, ratio, source.length)
    resampledFromRate = wav.sampleRate
    rate = to
  }
  if (rate > MAX_SAMPLE_RATE) resampleTo(MAX_SAMPLE_RATE)
  if (source.length > maxLength && fit === 'downsample') {
    const to = Math.max(MIN_SAMPLE_RATE, Math.floor((rate * maxLength) / source.length))
    if (to < rate) resampleTo(to)
  }

  let truncatedFromSeconds: number | undefined
  if (source.length > maxLength) {
    truncatedFromSeconds = sourceSeconds
    // A loop that fits keeps everything up to its end; past the loop only a one-shot plays.
    const cutAt = loop && loop.end <= maxLength ? loop.end : maxLength
    if (loop && loop.end > cutAt) {
      loop = undefined
      droppedLoop = { reason: 'cut' }
    }
    source = source.subarray(0, cutAt)
  }
  if (loop && loop.end - loop.start < MIN_LOOP_LENGTH) {
    loop = undefined
    droppedLoop = { reason: 'short' }
  }

  const bitExact =
    wav.bitsPerSample === 8 && !wav.isFloat && wav.channels === 1 && resampledFromRate === undefined
  const stored = new Uint8Array(source.length)
  if (bitExact) {
    // The decoder read (u - 128) / 128, so this recovers the file's byte exactly.
    for (let i = 0; i < source.length; i++) stored[i] = Math.round(source[i] * 128) & 0xff
  } else {
    let peak = 0
    for (let i = 0; i < source.length; i++) peak = Math.max(peak, Math.abs(source[i]))
    const gain = peak > 0 ? 127 / peak : 0
    for (let i = 0; i < source.length; i++) {
      const q = Math.max(-127, Math.min(127, Math.round(source[i] * gain)))
      stored[i] = q & 0xff
    }
  }

  const asset: SampleAsset = {
    sourceName,
    rate,
    encoding: 'pcm8',
    data: bytesToBase64(stored)
  }
  if (sourcePath !== undefined) asset.sourcePath = sourcePath
  if (truncatedFromSeconds !== undefined) asset.truncatedFromSeconds = truncatedFromSeconds
  if (resampledFromRate !== undefined) asset.resampledFromRate = resampledFromRate
  if (loop) {
    asset.loopStart = loop.start
    asset.loopEnd = loop.end
  }

  const result: ImportedPlainSample = {
    asset,
    sourceRate: wav.sampleRate,
    sourceSeconds,
    bitExact
  }
  if (wav.sampler) {
    result.rootNote = wav.sampler.unityNote
    result.rootSource = 'smpl'
  } else {
    const detected = detectRootNote(all.subarray(trimStart, trimEnd), wav.sampleRate)
    if (detected !== undefined) {
      result.rootNote = detected
      result.rootSource = 'detected'
    }
  }
  if (droppedLoop) result.droppedLoop = droppedLoop
  return result
}

function scaleLoop(
  loop: { start: number; end: number },
  ratio: number,
  length: number
): { start: number; end: number } {
  return {
    start: Math.min(length - 1, Math.round(loop.start * ratio)),
    end: Math.min(length, Math.round(loop.end * ratio))
  }
}

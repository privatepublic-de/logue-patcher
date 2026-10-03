import type { SampleAsset } from '../../../src/shared/domain/patch'
import { sampleBytes } from './importSample'

/** No level is shorter than this. The last levels carry only a few harmonics, and read from 8
 *  or 16 points, linear interpolation's images were the aliasing: the fixture saw was -26 dB off
 *  the harmonics at note 120 with 8 points, -52 dB with 64 (about 25 % more table). */
export const WAVETABLE_MIN_LEVEL_LENGTH = 64

export interface WavetableShape {
  frameCount: number
  frameLength: number
}

/** Mip levels for a frame length: each halves the harmonics (a quarter of the base length at
 *  level 0), down to 2 harmonics -- enough up to the top of the keyboard. */
export function wavetableLevelCount(frameLength: number): number {
  return Math.log2(frameLength / 8) + 1
}

/** Points per frame at a level: half the previous level's, but never under the minimum. */
export function wavetableLevelLength(frameLength: number, level: number): number {
  return Math.max(WAVETABLE_MIN_LEVEL_LENGTH, frameLength >> level)
}

/** Where each level starts in the pyramid (level-major, frames back to back within a level). */
export function wavetableLevelOffsets(shape: WavetableShape): number[] {
  const offsets: number[] = []
  let at = 0
  for (let level = 0; level < wavetableLevelCount(shape.frameLength); level++) {
    offsets.push(at)
    at += shape.frameCount * wavetableLevelLength(shape.frameLength, level)
  }
  return offsets
}

/** Bytes of the whole pyramid: every frame at every level. */
export function wavetablePyramidBytes(shape: WavetableShape): number {
  const levels = wavetableLevelCount(shape.frameLength)
  return (
    wavetableLevelOffsets(shape)[levels - 1] +
    shape.frameCount * wavetableLevelLength(shape.frameLength, levels - 1)
  )
}

/**
 * The band-limited copies the player crossfades between (docs/PLAN-wavetable.md), laid out
 * level-major (`wavetableLevelOffsets`). Level 0 is the stored frames byte for byte; level j
 * keeps harmonics up to `(L / 4) >> j`, resynthesized at `wavetableLevelLength` points from
 * level 0's exact DFT (a single cycle has exact bins). Signed 8-bit, as `int8_t` bytes.
 */
export function wavetablePyramid(asset: SampleAsset): Uint8Array {
  const shape = wavetableShapeOf(asset)
  const { frameCount, frameLength } = shape
  const base = sampleBytes(asset)
  const out = new Uint8Array(wavetablePyramidBytes(shape))
  out.set(base.subarray(0, frameCount * frameLength), 0)
  const signed = (b: number): number => (b >= 128 ? b - 256 : b)
  // Level 1's top harmonic: everything above it is only ever in level 0, copied as stored.
  const maxHarmonics = frameLength / 8
  // One cosine/sine table over the base length serves every level (k j / len is a whole number
  // of base steps), so the bake is fast enough to run on every RAM-estimate pass.
  const cos = Float64Array.from({ length: frameLength }, (_, i) =>
    Math.cos((2 * Math.PI * i) / frameLength)
  )
  const sin = Float64Array.from({ length: frameLength }, (_, i) =>
    Math.sin((2 * Math.PI * i) / frameLength)
  )
  const mask = frameLength - 1
  const offsets = wavetableLevelOffsets(shape)
  for (let f = 0; f < frameCount; f++) {
    const frame = Array.from(base.subarray(f * frameLength, (f + 1) * frameLength), signed)
    const re = new Float64Array(maxHarmonics + 1)
    const im = new Float64Array(maxHarmonics + 1)
    for (let k = 1; k <= maxHarmonics; k++) {
      for (let j = 0; j < frameLength; j++) {
        re[k] += frame[j] * cos[(k * j) & mask]
        im[k] -= frame[j] * sin[(k * j) & mask]
      }
      re[k] *= 2 / frameLength
      im[k] *= 2 / frameLength
    }
    let mean = 0
    for (const v of frame) mean += v
    mean /= frameLength
    for (let level = 1; level < offsets.length; level++) {
      const len = wavetableLevelLength(frameLength, level)
      const offset = offsets[level] + f * len
      const top = (frameLength / 4) >> level
      const step = frameLength / len
      for (let j = 0; j < len; j++) {
        let v = mean
        for (let k = 1; k <= top; k++) {
          const i = (k * j * step) & mask
          v += re[k] * cos[i] - im[k] * sin[i]
        }
        out[offset + j] = Math.max(-127, Math.min(127, Math.round(v))) & 0xff
      }
    }
  }
  return out
}

/** A `wt8` asset's shape, or a reason it has none a player could read. */
export function wavetableShapeProblem(asset: SampleAsset): string | undefined {
  if (asset.encoding !== 'wt8') return 'not a wavetable'
  const { frameCount, frameLength } = asset
  if (frameCount === undefined || frameLength === undefined) return 'no frame shape'
  if (!Number.isInteger(frameCount) || frameCount < 2 || frameCount > 64) {
    return `${frameCount} frames (2..64)`
  }
  if (![128, 256, 512].includes(frameLength)) return `frames of ${frameLength} points (128/256/512)`
  if (sampleBytes(asset).length !== frameCount * frameLength) return 'data length mismatch'
  return undefined
}

export function wavetableShapeOf(asset: SampleAsset): WavetableShape {
  const problem = wavetableShapeProblem(asset)
  if (problem !== undefined)
    throw new Error(`"${asset.sourceName}" can't be read as a wavetable: ${problem}`)
  return { frameCount: asset.frameCount!, frameLength: asset.frameLength! }
}

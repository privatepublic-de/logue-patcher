import type { SampleAsset } from '../../../src/shared/domain/patch'
import { pcm8Decode, sampleBytes } from './importSample'
import { wavetableShapeOf } from './wavetablePyramid'
import { wavetableFramePos } from './wavetableRead'

/** Every stored frame as -1..1 values: what the Inspector draws. */
export function wavetableFrames(asset: SampleAsset): Float32Array[] {
  const { frameCount, frameLength } = wavetableShapeOf(asset)
  const bytes = sampleBytes(asset)
  return Array.from({ length: frameCount }, (_, f) =>
    Float32Array.from(bytes.subarray(f * frameLength, (f + 1) * frameLength), pcm8Decode)
  )
}

/** The cycle the player reads at POSITION `pos01` (0..1): the two neighbouring frames blended
 *  like the device's level 0 (MORPH Smooth), or the nearest one (Step). */
export function wavetableFrameAt(
  frames: Float32Array[],
  pos01: number,
  step: boolean
): Float32Array {
  const shape = { frameCount: frames.length, frameLength: frames[0].length }
  const p = wavetableFramePos(Math.max(0, Math.min(1, pos01)), shape, step)
  let frame = Math.floor(p)
  let t = p - frame
  if (frame > frames.length - 2) {
    frame = frames.length - 2
    t = 1
  }
  const a = frames[frame]
  const b = frames[frame + 1]
  return a.map((v, i) => v + (b[i] - v) * t)
}

/**
 * A cycle's harmonics as Web Audio's `createPeriodicWave` takes them (`real` = cosine, `imag` =
 * sine terms, index 0 the DC, left 0): the preview plays the frame band-limited by the browser,
 * which sounds like the device's tables below their aliasing.
 */
export function cycleHarmonics(
  cycle: Float32Array,
  count: number
): { real: Float32Array; imag: Float32Array } {
  const n = cycle.length
  const real = new Float32Array(count + 1)
  const imag = new Float32Array(count + 1)
  for (let k = 1; k <= count; k++) {
    let re = 0
    let im = 0
    for (let j = 0; j < n; j++) {
      const a = (2 * Math.PI * k * j) / n
      re += cycle[j] * Math.cos(a)
      im += cycle[j] * Math.sin(a)
    }
    real[k] = (2 * re) / n
    imag[k] = (2 * im) / n
  }
  return { real, imag }
}

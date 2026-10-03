import type { ObjNode } from '../../src/shared/domain/patch'
import { bytesToBase64 } from '../src/sample/base64'

/**
 * A `wt8` table morphing from a sine (frame 0) to a band-limited saw (the last frame), aligned
 * like an import's frames: what the measurement and staging scripts place on a
 * `logue/osc/wavetable`. 32 x 256 by default, the import's default shape.
 */
export function wavetableFixture(
  frameCount = 32,
  frameLength = 256
): NonNullable<ObjNode['sample']> {
  const frames: number[][] = []
  let peak = 0
  for (let f = 0; f < frameCount; f++) {
    const blend = frameCount > 1 ? f / (frameCount - 1) : 1
    const frame: number[] = []
    for (let j = 0; j < frameLength; j++) {
      let v = 0
      for (let k = 1; k <= frameLength / 4; k++) {
        v += (k === 1 ? 1 : blend / k) * Math.sin((2 * Math.PI * k * j) / frameLength)
      }
      frame.push(v)
      peak = Math.max(peak, Math.abs(v))
    }
    frames.push(frame)
  }
  const bytes = new Uint8Array(frameCount * frameLength)
  frames.forEach((frame, f) =>
    frame.forEach((v, j) => (bytes[f * frameLength + j] = Math.round((v * 127) / peak) & 0xff))
  )
  return {
    sourceName: 'fixture',
    rate: 48000,
    encoding: 'wt8',
    data: bytesToBase64(bytes),
    frameLength,
    frameCount
  }
}

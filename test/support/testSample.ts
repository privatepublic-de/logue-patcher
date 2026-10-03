import type { SampleAsset } from '../../src/shared/domain/patch'
import type { LoguePrimitive } from '../../logue-codegen/src/primitives'
import { bytesToBase64 } from '../../logue-codegen/src/sample/base64'
import { mulawEncode } from '../../logue-codegen/src/sample/mulaw'

/** A small mu-law sine sample, so any node-aware primitive (`logue/osc/granular`) can be placed in
 *  a registry-wide test without a real import. `cycles` whole periods over `length` samples. */
export function testSampleAsset(length = 256, cycles = 4, rate = 24000): SampleAsset {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    bytes[i] = mulawEncode(0.8 * Math.sin((2 * Math.PI * cycles * i) / length))
  }
  return { sourceName: 'test.wav', rate, encoding: 'mulaw8', data: bytesToBase64(bytes) }
}

/** The linear 8-bit counterpart (`logue/osc/sample`'s import), with a loop over its second half. */
export function testPcm8SampleAsset(length = 256, cycles = 4, rate = 24000): SampleAsset {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    bytes[i] = Math.round(100 * Math.sin((2 * Math.PI * cycles * i) / length)) & 0xff
  }
  return {
    sourceName: 'test.wav',
    rate,
    encoding: 'pcm8',
    data: bytesToBase64(bytes),
    loopStart: length / 2,
    loopEnd: length
  }
}

/** A small `wt8` table (4 frames of 128: sine, then more saw each frame) for
 *  `logue/osc/wavetable`, in the shape `importWavetable` stores. */
export function testWavetableAsset(frameCount = 4, frameLength = 128): SampleAsset {
  const bytes = new Uint8Array(frameCount * frameLength)
  for (let f = 0; f < frameCount; f++) {
    for (let j = 0; j < frameLength; j++) {
      let v = 0
      for (let k = 1; k <= frameLength / 4; k++) {
        v +=
          (k === 1 ? 1 : f / (frameCount - 1) / k) * Math.sin((2 * Math.PI * k * j) / frameLength)
      }
      bytes[f * frameLength + j] = Math.max(-127, Math.min(127, Math.round(v * 60))) & 0xff
    }
  }
  return {
    sourceName: 'test.wav',
    rate: 48000,
    encoding: 'wt8',
    data: bytesToBase64(bytes),
    frameLength,
    frameCount
  }
}

/** The test sample a primitive's import kind expects, or undefined for one that reads none. */
export function testSampleFor(
  p: Pick<LoguePrimitive, 'sampleImport'> | undefined
): SampleAsset | undefined {
  if (p?.sampleImport === 'granular') return testSampleAsset()
  if (p?.sampleImport === 'plain') return testPcm8SampleAsset()
  if (p?.sampleImport === 'wavetable') return testWavetableAsset()
  return undefined
}

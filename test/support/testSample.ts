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

/** The test sample a primitive's import kind expects, or undefined for one that reads none. */
export function testSampleFor(
  p: Pick<LoguePrimitive, 'sampleImport'> | undefined
): SampleAsset | undefined {
  if (p?.sampleImport === 'granular') return testSampleAsset()
  if (p?.sampleImport === 'plain') return testPcm8SampleAsset()
  return undefined
}

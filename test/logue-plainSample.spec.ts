import { describe, it, expect } from 'vitest'
import { decodeWav } from '../logue-codegen/src/sample/wav'
import {
  decodeSampleAsset,
  importPlainSample,
  MIN_LOOP_LENGTH,
  pcm8Decode,
  sampleBytes
} from '../logue-codegen/src/sample/importSample'
import { findLoguePrimitive } from '../logue-codegen/src/primitives'
import { parsePatchFile, serializePatchFile } from '../src/shared/json/patchCodec'
import type { ObjNode, PatchDocument, SampleAsset } from '../src/shared/domain/patch'
import { wav, wav8Raw } from './support/wavWriter'

/** A non-silent ramp of unsigned bytes that never touches the silence threshold. */
function rampBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => 128 + 20 + (i % 80))
}

/** A cosine, so the first sample isn't trimmed as silence. */
function sine(length: number, rate: number, hz: number, amplitude = 0.5): number[][] {
  return Array.from({ length }, (_, i) => [amplitude * Math.cos((2 * Math.PI * hz * i) / rate)])
}

function signed(bytes: Uint8Array): number[] {
  return Array.from(bytes, (b) => (b >= 128 ? b - 256 : b))
}

describe('decodeWav smpl chunk', () => {
  it('reads the unity note and the first loop (end inclusive), after an odd-sized data chunk', () => {
    const decoded = decodeWav(
      wav8Raw(rampBytes(301), 22050, {
        unityNote: 57,
        loops: [
          { start: 100, end: 249 },
          { start: 0, end: 10 }
        ]
      })
    )
    expect(decoded.samples.length).toBe(301)
    expect(decoded.bitsPerSample).toBe(8)
    expect(decoded.channels).toBe(1)
    expect(decoded.sampler).toEqual({ unityNote: 57, loop: { type: 0, start: 100, end: 249 } })
  })

  it('has no loop for a smpl chunk with zero loops, and no sampler info without the chunk', () => {
    expect(decodeWav(wav8Raw(rampBytes(64), 22050, { unityNote: 60 })).sampler).toEqual({
      unityNote: 60
    })
    expect(decodeWav(wav8Raw(rampBytes(64), 22050)).sampler).toBeUndefined()
  })
})

describe('importPlainSample', () => {
  it('stores a mono 8-bit source at its own rate bit-exactly, loop and root from smpl', () => {
    const raw = rampBytes(4000)
    const result = importPlainSample(
      wav8Raw(raw, 27778, { unityNote: 48, loops: [{ start: 1000, end: 2999 }] }),
      'cmi.wav',
      16384,
      'cut'
    )
    expect(result.bitExact).toBe(true)
    expect(result.asset.encoding).toBe('pcm8')
    expect(result.asset.rate).toBe(27778)
    expect(signed(sampleBytes(result.asset))).toEqual(Array.from(raw, (b) => b - 128))
    expect([result.asset.loopStart, result.asset.loopEnd]).toEqual([1000, 3000])
    expect(result.rootNote).toBe(48)
    expect(result.rootSource).toBe('smpl')
    expect(result.asset.truncatedFromSeconds).toBeUndefined()
    expect(result.asset.resampledFromRate).toBeUndefined()
  })

  it('normalizes and rounds a 16-bit source to +-127, at its own rate', () => {
    const result = importPlainSample(
      wav(sine(8000, 44100, 441, 0.25), 44100, 'pcm16'),
      'a.wav',
      16384,
      'cut'
    )
    expect(result.bitExact).toBe(false)
    expect(result.asset.rate).toBe(44100)
    const values = signed(sampleBytes(result.asset))
    expect(Math.max(...values)).toBe(127)
    expect(Math.min(...values)).toBeGreaterThanOrEqual(-127)
    expect(result.rootNote).toBe(69)
    expect(result.rootSource).toBe('detected')
  })

  it('brings a source above 48 kHz down to 48 kHz', () => {
    const result = importPlainSample(
      wav(sine(9600, 96000, 1000), 96000, 'pcm16'),
      'a.wav',
      16384,
      'cut'
    )
    expect(result.asset.rate).toBe(48000)
    expect(result.asset.resampledFromRate).toBe(96000)
    expect(sampleBytes(result.asset).length).toBe(4800)
  })

  it("doesn't count an 8-bit source as bit-exact once it had to be resampled or mixed", () => {
    const stereo = Array.from({ length: 1000 }, (_, i) => [0.3, (i % 50) / 100])
    expect(importPlainSample(wav(stereo, 22050, 'pcm8'), 'a.wav', 16384, 'cut').bitExact).toBe(
      false
    )
    const long = rampBytes(20000)
    expect(importPlainSample(wav8Raw(long, 22050), 'a.wav', 8192, 'downsample').bitExact).toBe(
      false
    )
  })

  it('cuts a long source at the maximum, or at the loop end when the loop fits', () => {
    const plain = importPlainSample(wav8Raw(rampBytes(20000), 22050), 'a.wav', 8192, 'cut')
    expect(sampleBytes(plain.asset).length).toBe(8192)
    expect(plain.asset.truncatedFromSeconds).toBeCloseTo(20000 / 22050, 4)

    const looped = importPlainSample(
      wav8Raw(rampBytes(20000), 22050, { unityNote: 60, loops: [{ start: 2000, end: 5999 }] }),
      'a.wav',
      8192,
      'cut'
    )
    expect(sampleBytes(looped.asset).length).toBe(6000)
    expect([looped.asset.loopStart, looped.asset.loopEnd]).toEqual([2000, 6000])
    expect(looped.bitExact).toBe(true)
  })

  it('drops a loop the cut runs through, and says so', () => {
    const result = importPlainSample(
      wav8Raw(rampBytes(20000), 22050, { unityNote: 60, loops: [{ start: 2000, end: 15999 }] }),
      'a.wav',
      8192,
      'cut'
    )
    expect(sampleBytes(result.asset).length).toBe(8192)
    expect(result.asset.loopStart).toBeUndefined()
    expect(result.droppedLoop).toEqual({ reason: 'cut' })
  })

  it('downsamples to fit, scaling the loop with it', () => {
    const result = importPlainSample(
      wav(sine(32000, 32000, 500), 32000, 'pcm16', {
        unityNote: 59,
        loops: [{ start: 8000, end: 23999 }]
      }),
      'a.wav',
      16384,
      'downsample'
    )
    expect(result.asset.rate).toBe(16384)
    expect(result.asset.resampledFromRate).toBe(32000)
    expect(sampleBytes(result.asset).length).toBe(16384)
    expect(result.asset.truncatedFromSeconds).toBeUndefined()
    expect([result.asset.loopStart, result.asset.loopEnd]).toEqual([4096, 12288])
  })

  it('downsamples no lower than MIN_SAMPLE_RATE, then cuts the rest', () => {
    const result = importPlainSample(
      wav(sine(48000 * 4, 48000, 300), 48000, 'pcm16'),
      'a.wav',
      4096,
      'downsample'
    )
    expect(result.asset.rate).toBe(2000)
    expect(sampleBytes(result.asset).length).toBe(4096)
    expect(result.asset.truncatedFromSeconds).toBeCloseTo(4, 2)
  })

  it('trims leading silence and moves the loop with it, but never trims into the loop', () => {
    const raw = new Uint8Array(3000).fill(128)
    raw.set(rampBytes(2000), 500)
    // The loop runs into the trailing silence, which therefore stays.
    const result = importPlainSample(
      wav8Raw(raw, 22050, { unityNote: 60, loops: [{ start: 1500, end: 2799 }] }),
      'a.wav',
      16384,
      'cut'
    )
    expect(sampleBytes(result.asset).length).toBe(2300)
    expect([result.asset.loopStart, result.asset.loopEnd]).toEqual([1000, 2300])
  })

  it('drops a loop of another type, one past the data, and one shorter than MIN_LOOP_LENGTH', () => {
    const raw = rampBytes(1000)
    const pingPong = importPlainSample(
      wav8Raw(raw, 22050, { unityNote: 60, loops: [{ start: 10, end: 500, type: 1 }] }),
      'a.wav',
      16384,
      'cut'
    )
    expect(pingPong.droppedLoop).toEqual({ reason: 'type', type: 1 })
    expect(pingPong.asset.loopStart).toBeUndefined()

    const past = importPlainSample(
      wav8Raw(raw, 22050, { unityNote: 60, loops: [{ start: 10, end: 1000 }] }),
      'a.wav',
      16384,
      'cut'
    )
    expect(past.droppedLoop).toEqual({ reason: 'invalid' })

    const short = importPlainSample(
      wav8Raw(raw, 22050, { unityNote: 60, loops: [{ start: 10, end: 10 + MIN_LOOP_LENGTH - 2 }] }),
      'a.wav',
      16384,
      'cut'
    )
    expect(short.droppedLoop).toEqual({ reason: 'short' })
  })

  it('refuses a silent file', () => {
    expect(() =>
      importPlainSample(wav8Raw(new Uint8Array(100).fill(128), 22050), 'quiet.wav', 16384, 'cut')
    ).toThrow(/silent/)
  })

  it('decodes pcm8 for the Inspector preview', () => {
    expect(pcm8Decode(0)).toBe(0)
    expect(pcm8Decode(127)).toBeCloseTo(127 / 128, 9)
    expect(pcm8Decode(128)).toBe(-1)
    expect(pcm8Decode(255)).toBeCloseTo(-1 / 128, 9)
    const { asset } = importPlainSample(wav8Raw(rampBytes(500), 22050), 'a.wav', 16384, 'cut')
    const preview = decodeSampleAsset(asset)
    expect(preview[0]).toBeCloseTo(20 / 128, 9)
  })
})

describe('.loguepatch codec, pcm8 samples', () => {
  function docWith(sample: SampleAsset): PatchDocument {
    const node: ObjNode = {
      kind: 'obj',
      type: 'logue/osc/granular',
      name: 'g',
      x: 0,
      y: 0,
      params: [],
      sample
    }
    return { nodes: [node], nets: [], settings: {}, notes: '' }
  }

  it('round-trips the encoding, loop pair and resampled-from rate', () => {
    const { asset } = importPlainSample(
      wav8Raw(rampBytes(1000), 22050, { unityNote: 60, loops: [{ start: 100, end: 899 }] }),
      'a.wav',
      16384,
      'cut'
    )
    const sample = { ...asset, resampledFromRate: 44100 }
    const back = parsePatchFile(serializePatchFile(docWith(sample)))
    expect((back.nodes[0] as ObjNode).sample).toEqual(sample)
  })

  it('refuses a loop outside the sample, a half loop and an unknown encoding', () => {
    const { asset } = importPlainSample(wav8Raw(rampBytes(1000), 22050), 'a.wav', 16384, 'cut')
    const bad = (patch: Record<string, unknown>): string => {
      const text = JSON.parse(serializePatchFile(docWith(asset)))
      Object.assign(text.nodes[0].sample, patch)
      return JSON.stringify(text)
    }
    expect(() => parsePatchFile(bad({ loopStart: 10, loopEnd: 1001 }))).toThrow(/invalid loop/)
    expect(() => parsePatchFile(bad({ loopStart: 10 }))).toThrow(/invalid loop/)
    expect(() => parsePatchFile(bad({ loopStart: 50, loopEnd: 50 }))).toThrow(/invalid loop/)
    expect(() => parsePatchFile(bad({ encoding: 'adpcm' }))).toThrow(/encoding/)
    expect(() => parsePatchFile(bad({ loopStart: 0, loopEnd: 1000 }))).not.toThrow()
  })
})

describe('logue/osc/granular with a pcm8 sample', () => {
  it('reports it as an instance problem instead of playing it through the mu-law table', () => {
    const { asset } = importPlainSample(wav8Raw(rampBytes(1000), 22050), 'a.wav', 16384, 'cut')
    const node = {
      kind: 'obj',
      type: 'logue/osc/granular',
      name: 'g',
      x: 0,
      y: 0,
      params: [],
      sample: asset
    } as ObjNode
    expect(findLoguePrimitive('logue/osc/granular')!.instanceProblem!(node)).toMatch(/linear 8-bit/)
  })
})

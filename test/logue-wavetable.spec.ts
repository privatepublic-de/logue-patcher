import { describe, expect, it } from 'vitest'
import { findLoguePrimitive } from '../logue-codegen/src/primitives'
import { generateOldGenOscUnit } from '../logue-codegen/src/minilogue-xd/generateOscUnit'
import { estimateOscStateCost } from '../logue-codegen/src/estimateOscStateCost'
import { sampleBytes } from '../logue-codegen/src/sample/importSample'
import {
  WAVETABLE_MIN_LEVEL_LENGTH,
  wavetableLevelCount,
  wavetableLevelLength,
  wavetableLevelOffsets,
  wavetablePyramid,
  wavetablePyramidBytes
} from '../logue-codegen/src/sample/wavetablePyramid'
import {
  wavetableFramePos,
  wavetableLevel,
  renderWavetable
} from '../logue-codegen/src/sample/wavetableRead'
import {
  cycleHarmonics,
  wavetableFrameAt,
  wavetableFrames
} from '../logue-codegen/src/sample/wavetableView'
import type { ObjNode, PatchDocument, SampleAsset } from '../src/shared/domain/patch'
import { testPcm8SampleAsset, testWavetableAsset } from './support/testSample'

const signed = (b: number): number => (b >= 128 ? b - 256 : b)

/** Amplitude of harmonic k in one cycle of `values`. */
function harmonic(values: number[], k: number): number {
  let re = 0
  let im = 0
  values.forEach((v, j) => {
    re += v * Math.cos((2 * Math.PI * k * j) / values.length)
    im -= v * Math.sin((2 * Math.PI * k * j) / values.length)
  })
  return (2 * Math.hypot(re, im)) / values.length
}

describe('wavetablePyramid', () => {
  const asset = testWavetableAsset(4, 256)
  const shape = { frameCount: 4, frameLength: 256 }
  const pyramid = wavetablePyramid(asset)

  it('lays out every level of every frame, at least 64 points each', () => {
    expect(wavetableLevelCount(256)).toBe(6)
    expect([0, 1, 2, 3, 4, 5].map((l) => wavetableLevelLength(256, l))).toEqual([
      256, 128, 64, 64, 64, 64
    ])
    expect(wavetableLevelOffsets(shape)).toEqual([0, 1024, 1536, 1792, 2048, 2304])
    expect(pyramid.length).toBe(wavetablePyramidBytes(shape))
    expect(pyramid.length).toBe(4 * (256 + 128 + 64 * 4))
  })

  it('keeps the stored frames as level 0, byte for byte', () => {
    expect(Array.from(pyramid.subarray(0, 1024))).toEqual(Array.from(sampleBytes(asset)))
  })

  it('band-limits level j to (L / 4) >> j harmonics and keeps those', () => {
    const offsets = wavetableLevelOffsets(shape)
    const lastFrame = Array.from(pyramid.subarray(3 * 256, 4 * 256), signed)
    for (let level = 1; level < 6; level++) {
      const len = wavetableLevelLength(256, level)
      const top = 64 >> level
      const values = Array.from(
        pyramid.subarray(offsets[level] + 3 * len, offsets[level] + 4 * len),
        signed
      )
      for (let k = 1; k <= top; k++) {
        expect(Math.abs(harmonic(values, k) - harmonic(lastFrame, k))).toBeLessThan(0.75)
      }
      for (let k = top + 1; k < len / 2; k++) expect(harmonic(values, k)).toBeLessThan(0.75)
    }
  })
})

describe('the read (TypeScript reference)', () => {
  const shape = { frameCount: 32, frameLength: 256 }

  it('picks level j while L * w0 is in [2^j, 2^(j+1)), crossfading into j+1 across it', () => {
    expect(wavetableLevel(0.5 / 256, shape)).toBe(0)
    expect(wavetableLevel(1 / 256, shape)).toBe(0)
    expect(wavetableLevel(1.5 / 256, shape)).toBeCloseTo(0.5, 6)
    expect(wavetableLevel(3 / 256, shape)).toBeCloseTo(1.5, 6)
    // Level j's top harmonic, (64 >> j) * w0, reaches Nyquist exactly as its weight reaches 0.
    expect(wavetableLevel(4 / 256, shape)).toBe(2)
    expect(wavetableLevel(1000 / 256, shape)).toBe(5)
  })

  it('maps POSITION onto the frames, rounding with MORPH Step', () => {
    expect(wavetableFramePos(0.5, shape, false)).toBeCloseTo(15.5, 5)
    expect(wavetableFramePos(0.5, shape, true)).toBe(16)
    expect(wavetableFramePos(1, shape, true)).toBe(31)
  })

  it('plays the last frame at POSITION 100 and stays inside -1..1', () => {
    const asset = testWavetableAsset(4, 128)
    const pyramid = new Int8Array(wavetablePyramid(asset).buffer)
    const y = renderWavetable(pyramid, { frameCount: 4, frameLength: 128 }, 1 / 128, 1, false, 128)
    const last = Array.from(sampleBytes(asset).subarray(3 * 128), (b) => signed(b) / 128)
    y.forEach((v, i) => expect(v).toBeCloseTo(last[i], 6))
  })
})

describe('logue/osc/wavetable', () => {
  const p = findLoguePrimitive('logue/osc/wavetable')!
  const node = (sample?: SampleAsset): ObjNode =>
    ({ kind: 'obj', type: p.id, name: 'w', x: 0, y: 0, params: [], sample }) as ObjNode

  it('asks for a wavetable import of anything else', () => {
    expect(p.instanceProblem!(node())).toMatch(/No wavetable/)
    expect(p.instanceProblem!(node(testPcm8SampleAsset()))).toMatch(/re-import it as a wavetable/)
    expect(p.instanceProblem!(node(testWavetableAsset()))).toBeUndefined()
  })

  it('bakes the pyramid once per content, counted in the RAM estimate', () => {
    const asset = testWavetableAsset(4, 256)
    const doc: PatchDocument = {
      nodes: [
        { ...node(asset), name: 'a' },
        { ...node(asset), name: 'b' },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      // b scans a, so both are active.
      nets: [
        { sources: [{ obj: 'a' }], dests: [{ obj: 'out', inlet: 'in' }] },
        { sources: [{ obj: 'b' }], dests: [{ obj: 'a', inlet: 'position' }] }
      ],
      settings: {},
      notes: ''
    }
    const cpp = generateOldGenOscUnit(doc, { name: 't' }).oscCpp
    expect(cpp.match(/static const int8_t kWavetable_\w+\[/g)).toHaveLength(1)
    const est = estimateOscStateCost(doc, 'minilogue-xd')
    expect(est.status).toBe('ok')
    if (est.status === 'ok')
      expect(est.estimate.stateBytes).toBeGreaterThan(
        wavetablePyramidBytes({ frameCount: 4, frameLength: 256 })
      )
  })

  it('never reads a level shorter than the minimum', () => {
    expect(WAVETABLE_MIN_LEVEL_LENGTH).toBe(64)
    expect(wavetableLevelLength(128, 4)).toBe(64)
  })
})

describe('the Inspector view of a wavetable', () => {
  const frames = wavetableFrames(testWavetableAsset(4, 128))

  it('blends the neighbouring frames like the device (Smooth) or takes the nearest (Step)', () => {
    // POSITION 50 of 4 frames is frame 1.5.
    const mid = wavetableFrameAt(frames, 0.5, false)
    mid.forEach((v, i) => expect(v).toBeCloseTo((frames[1][i] + frames[2][i]) / 2, 6))
    expect(Array.from(wavetableFrameAt(frames, 0.5, true))).toEqual(Array.from(frames[2]))
    expect(Array.from(wavetableFrameAt(frames, 1, false))).toEqual(Array.from(frames[3]))
  })

  it("gives a cycle's harmonics in createPeriodicWave's terms", () => {
    const cycle = Float32Array.from(
      { length: 128 },
      (_, j) => 0.5 * Math.sin((2 * Math.PI * 3 * j) / 128)
    )
    const { real, imag } = cycleHarmonics(cycle, 8)
    expect(imag[3]).toBeCloseTo(0.5, 6)
    for (let k = 1; k <= 8; k++) {
      expect(real[k]).toBeCloseTo(0, 6)
      if (k !== 3) expect(imag[k]).toBeCloseTo(0, 6)
    }
  })
})

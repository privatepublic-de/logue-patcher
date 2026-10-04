import { describe, it, expect } from 'vitest'
import { importWavetable } from '../logue-codegen/src/sample/importWavetable'
import { decodeSampleAsset, sampleContentHash } from '../logue-codegen/src/sample/importSample'
import { findLoguePrimitive } from '../logue-codegen/src/primitives'
import { parsePatchFile, serializePatchFile } from '../src/shared/json/patchCodec'
import type { ObjNode, PatchDocument, SampleAsset } from '../src/shared/domain/patch'
import { wav } from './support/wavWriter'

const RATE = 48000

/** A band-limited tone following `hz(t)`, with harmonic amplitudes `amp(k)`, up to 0.45 x rate. */
function tone(
  seconds: number,
  rate: number,
  hz: (t: number) => number,
  amp: (k: number) => number,
  maxK = 400
): Float64Array {
  const out = new Float64Array(Math.round(seconds * rate))
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const f = hz(i / rate)
    const top = Math.min(maxK, Math.floor((0.45 * rate) / f))
    let v = 0
    for (let k = 1; k <= top; k++) v += amp(k) * Math.sin(k * phase)
    out[i] = v
    phase += (2 * Math.PI * f) / rate
  }
  return out
}

function toWav(x: Float64Array, rate: number): Uint8Array {
  let peak = 0
  for (const v of x) peak = Math.max(peak, Math.abs(v))
  return wav(
    Array.from(x, (v) => [(0.9 * v) / peak]),
    rate,
    'float32'
  )
}

const saw = (k: number): number => 1 / k

/** Frame i's DFT bins 1..count as [amplitude, phase]. */
function frameSpectrum(asset: SampleAsset, i: number, count: number): [number, number][] {
  const length = asset.frameLength!
  const frame = decodeSampleAsset(asset).subarray(i * length, (i + 1) * length)
  const bins: [number, number][] = []
  for (let k = 1; k <= count; k++) {
    let re = 0
    let im = 0
    for (let j = 0; j < length; j++) {
      re += frame[j] * Math.cos((2 * Math.PI * k * j) / length)
      im -= frame[j] * Math.sin((2 * Math.PI * k * j) / length)
    }
    bins.push([(2 * Math.hypot(re, im)) / length, Math.atan2(im, re)])
  }
  return bins
}

function frames(asset: SampleAsset): Float32Array[] {
  const all = decodeSampleAsset(asset)
  const n = asset.frameLength!
  return Array.from({ length: asset.frameCount! }, (_, i) => all.subarray(i * n, (i + 1) * n))
}

function correlation(a: Float32Array, b: Float32Array): number {
  let ab = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  return ab / Math.sqrt(aa * bb)
}

const db = (x: number): number => 20 * Math.log10(x)

describe('importWavetable', () => {
  // 220 Hz drifting up 3 semitones over 2 s.
  const drift = (t: number): number => 220 * 2 ** ((1.5 * t) / 12)
  const driftSaw = importWavetable(toWav(tone(2, RATE, drift, saw), RATE), 'saw.wav', 32, 256)

  it('stores 32 frames of 256 signed 8-bit points', () => {
    expect(driftSaw.asset.encoding).toBe('wt8')
    expect(driftSaw.asset.frameCount).toBe(32)
    expect(driftSaw.asset.frameLength).toBe(256)
    expect(decodeSampleAsset(driftSaw.asset).length).toBe(32 * 256)
    expect(driftSaw.harmonics).toBe(64)
    expect(driftSaw.harmonicsLimitedBySource).toBe(false)
  })

  it('rebuilds a saw in every frame: harmonic k at 1/k up to the 64th, nothing above', () => {
    for (const i of [0, 15, 31]) {
      const bins = frameSpectrum(driftSaw.asset, i, 100)
      // 0.75 dB: the 64th harmonic sits at -36 dB, where the 8-bit rounding moves it ~0.5 dB.
      for (let k = 1; k <= 64; k++) {
        expect(Math.abs(db(bins[k - 1][0] / bins[0][0]) - db(1 / k))).toBeLessThan(0.75)
      }
      for (let k = 65; k <= 100; k++) expect(db(bins[k - 1][0] / bins[0][0])).toBeLessThan(-50)
    }
  })

  it('aligns every frame: the fundamental is a sine from 0, and neighbours match', () => {
    for (let i = 0; i < 32; i++) {
      const [, phase] = frameSpectrum(driftSaw.asset, i, 1)[0]
      expect(Math.abs(phase + Math.PI / 2)).toBeLessThan(0.02)
    }
    const f = frames(driftSaw.asset)
    for (let i = 1; i < f.length; i++) expect(correlation(f[i - 1], f[i])).toBeGreaterThan(0.99)
  })

  it('tracks the drift', () => {
    expect(driftSaw.lowestNote).toBeCloseTo(57, 0)
    expect(driftSaw.highestNote).toBeCloseTo(60, 0)
    expect(driftSaw.medianNote).toBeCloseTo(58.5, 0)
    expect(driftSaw.skippedSeconds).toBeLessThan(0.05)
  })

  it('keeps every harmonic of a saw with vibrato (6 Hz, +-50 ct)', () => {
    const vibrato = (t: number): number => 220 * 2 ** ((0.5 * Math.sin(2 * Math.PI * 6 * t)) / 12)
    const { asset } = importWavetable(toWav(tone(1, RATE, vibrato, saw), RATE), 'v.wav', 16, 256)
    for (let i = 0; i < 16; i++) {
      const bins = frameSpectrum(asset, i, 64)
      for (let k = 1; k <= 64; k++) {
        expect(Math.abs(db(bins[k - 1][0] / bins[0][0]) - db(1 / k))).toBeLessThan(1)
      }
      expect(Math.abs(bins[0][1] + Math.PI / 2)).toBeLessThan(0.02)
    }
  })

  it('skips an unpitched gap and takes no frame from it', () => {
    const a = tone(0.8, RATE, () => 220, saw)
    const b = tone(0.8, RATE, () => 220, saw)
    let seed = 1
    const noise = Float64Array.from({ length: Math.round(0.3 * RATE) }, () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return (seed / 2 ** 32 - 0.5) * 2
    })
    const x = new Float64Array(a.length + noise.length + b.length)
    x.set(a)
    x.set(noise, a.length)
    x.set(b, a.length + noise.length)
    const result = importWavetable(toWav(x, RATE), 'gap.wav', 32, 256)
    expect(result.skippedSeconds).toBeGreaterThan(0.27)
    expect(result.skippedSeconds).toBeLessThan(0.36)
    for (const t of result.frameSeconds) expect(t < 0.79 || t > 1.11).toBe(true)
  })

  it('caps the harmonics at a low-rate source own bandwidth', () => {
    const result = importWavetable(
      toWav(
        tone(1, 8000, () => 220, saw),
        8000
      ),
      'lo.wav',
      16,
      256
    )
    expect(result.harmonicsLimitedBySource).toBe(true)
    expect(result.harmonics).toBe(16)
    const bins = frameSpectrum(result.asset, 8, 40)
    for (let k = 17; k <= 40; k++) expect(db(bins[k - 1][0] / bins[0][0])).toBeLessThan(-50)
  })

  it('stays at the right octave under a strong second harmonic', () => {
    const amp = (k: number): number => (k === 2 ? 1 : k <= 4 ? 0.3 : 0)
    const result = importWavetable(
      toWav(
        tone(1, RATE, () => 150, amp),
        RATE
      ),
      'oct.wav',
      16,
      256
    )
    expect(result.medianNote).toBeCloseTo(69 + 12 * Math.log2(150 / 440), 1)
  })

  it('stays on the fundamental under a strong high formant (no harmonic locks)', () => {
    // A formant at ~2 kHz over a weak 220 Hz fundamental: alone, YIN's first dip locked onto
    // the 9th harmonic for ~60 ms at a time.
    const amp = (k: number): number => Math.exp(-((k * 220 - 2000) ** 2) / (2 * 250 ** 2)) + 0.3 / k
    const result = importWavetable(
      toWav(
        tone(1, RATE, () => 220, amp),
        RATE
      ),
      'ee.wav',
      32,
      256
    )
    expect(result.highestNote).toBeLessThan(57.5)
    expect(result.lowestNote).toBeGreaterThan(56.5)
  })

  it('stays on the fundamental while a vowel-like formant sweeps (short locks)', () => {
    // 220 Hz rising 2 semitones with 5.5 Hz vibrato, a formant sweeping 500 Hz to 2.3 kHz and
    // back: as it passes a harmonic the tone repeats cleanly at that harmonic for ~60 ms, which
    // only the 200 ms context check caught (a frame was measured at C7).
    const hz = (t: number): number =>
      220 * 2 ** ((0.4 * Math.sin(2 * Math.PI * 5.5 * t) + (2 * t) / 2.4) / 12)
    const sweep = new Float64Array(Math.round(2.4 * RATE))
    let phase = 0
    for (let i = 0; i < sweep.length; i++) {
      const t = i / RATE
      const f = hz(t)
      const formant = 500 + 1800 * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 2.4))
      for (let k = 1; k * f < 0.45 * RATE; k++) {
        const g = Math.exp(-((k * f - formant) ** 2) / (2 * 250 ** 2)) + 0.3 / k
        sweep[i] += g * Math.sin(k * phase)
      }
      phase += (2 * Math.PI * f) / RATE
    }
    const result = importWavetable(toWav(sweep, RATE), 'sweep.wav', 32, 256)
    expect(result.lowestNote).toBeGreaterThan(56.5)
    expect(result.highestNote).toBeLessThan(59.6)
  })

  it('aligns frames with no fundamental to each other', () => {
    const amp = (k: number): number => (k >= 2 && k <= 6 ? 1 / k : 0)
    const result = importWavetable(
      toWav(
        tone(1, RATE, (t) => 200 * 2 ** (t / 12), amp),
        RATE
      ),
      'missing.wav',
      16,
      256
    )
    const f = frames(result.asset)
    for (let i = 1; i < f.length; i++) expect(correlation(f[i - 1], f[i])).toBeGreaterThan(0.98)
  })

  it('analyses only the first 30 s of a long source, and says so', () => {
    const long = tone(
      31,
      8000,
      () => 220,
      (k) => (k <= 3 ? 1 / k : 0),
      3
    )
    const result = importWavetable(toWav(long, 8000), 'long.wav', 16, 256)
    expect(result.asset.truncatedFromSeconds).toBeCloseTo(31, 1)
    expect(Math.max(...result.frameSeconds)).toBeLessThan(30)
  })

  it('fails loudly on unpitched material', () => {
    let seed = 7
    const noise = Float64Array.from({ length: RATE }, () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 2 ** 32 - 0.5
    })
    expect(() => importWavetable(toWav(noise, RATE), 'noise.wav', 32, 256)).toThrow(
      /pitched material/
    )
  })

  it('evens out the level of a fading tone, by at most +12 dB', () => {
    const fade = tone(1, RATE, () => 220, saw).map((v, i) => v * 10 ** (-1.2 * (i / RATE)))
    const f = frames(importWavetable(toWav(fade, RATE), 'fade.wav', 16, 256).asset)
    const rms = f.map((frame) => Math.sqrt(frame.reduce((s, v) => s + v * v, 0) / frame.length))
    // -24 dB over the second: the first ~half is evened out, the rest stays 12 dB short of it.
    expect(db(rms[4] / rms[0])).toBeGreaterThan(-0.5)
    expect(db(rms[15] / rms[0])).toBeLessThan(-6)
  })
})

describe('wt8 assets', () => {
  const { asset } = importWavetable(
    toWav(
      tone(0.5, RATE, () => 220, saw),
      RATE
    ),
    'saw.wav',
    16,
    256
  )
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
  const bad = (patch: Record<string, unknown>): string => {
    const text = JSON.parse(serializePatchFile(docWith(asset)))
    Object.assign(text.nodes[0].sample, patch)
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete text.nodes[0].sample[k]
    return JSON.stringify(text)
  }

  it('round-trips through the codec', () => {
    const back = parsePatchFile(serializePatchFile(docWith(asset)))
    expect((back.nodes[0] as ObjNode).sample).toEqual(asset)
  })

  it('refuses a wrong shape, a missing shape, a loop, and a shape on another encoding', () => {
    expect(() => parsePatchFile(bad({ frameCount: 15 }))).toThrow(/wavetable shape/)
    expect(() => parsePatchFile(bad({ frameLength: 300 }))).toThrow(/wavetable shape/)
    expect(() => parsePatchFile(bad({ frameCount: undefined }))).toThrow(/wavetable shape/)
    expect(() => parsePatchFile(bad({ loopStart: 0, loopEnd: 100 }))).toThrow(/wavetable/)
    expect(() => parsePatchFile(bad({ encoding: 'pcm8' }))).toThrow(/frame shape/)
  })

  it('hashes the frame length too', () => {
    const recut = { ...asset, frameLength: 512, frameCount: 8 }
    expect(sampleContentHash(recut)).not.toBe(sampleContentHash(asset))
  })

  it('is an instance problem for granular and the sample player', () => {
    for (const type of ['logue/osc/granular', 'logue/osc/sample']) {
      const node = {
        kind: 'obj',
        type,
        name: 'g',
        x: 0,
        y: 0,
        params: [],
        sample: asset
      } as ObjNode
      expect(findLoguePrimitive(type)!.instanceProblem!(node)).toMatch(/wavetable/)
    }
  })
})

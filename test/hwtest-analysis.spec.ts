import { describe, expect, it } from 'vitest'
import {
  bandLevels,
  peakFrequency,
  scanGlitches,
  toneLevel,
  trackPeak
} from '../logue-codegen/scripts/hwtest/analysis'
import {
  cyclesFromFxTone,
  DETECTOR_HZ,
  FX_TONE_BAND,
  fxToneHz,
  TONE_AMPLITUDE,
  totToneHz
} from '../logue-codegen/scripts/hwtest/telemetry'

const SR = 48000

/** The telemetry unit's output: detector + fx tone + tot tone, with a little noise. */
function telemetry(seconds: number, fxCycles: number, clock = 1): Float32Array {
  const x = new Float32Array(Math.round(seconds * SR))
  let seed = 1
  for (let i = 0; i < x.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    const t = (i / SR) * clock
    x[i] =
      TONE_AMPLITUDE *
        (Math.sin(2 * Math.PI * DETECTOR_HZ * t) +
          Math.sin(2 * Math.PI * fxToneHz(fxCycles) * t) +
          Math.sin(2 * Math.PI * totToneHz(11457) * t)) +
      (seed / 2 ** 32 - 0.5) * 1e-3
  }
  return x
}

describe('telemetry decoding', () => {
  it('reads the fx cycles to within a cycle from one second', () => {
    for (const c of [39.3, 2001, 7300, 11000]) {
      const { hz } = peakFrequency(telemetry(1, c), SR, ...FX_TONE_BAND)
      expect(Math.abs(cyclesFromFxTone(hz) - c)).toBeLessThan(1)
    }
  })
})

describe('trackPeak', () => {
  it('follows a reading that changes halfway through', () => {
    const x = telemetry(2, 1800)
    const y = telemetry(2, 2500)
    x.set(y.subarray(SR), SR)
    const t = trackPeak(x, SR, FX_TONE_BAND)
    expect(Math.abs(cyclesFromFxTone(t.min) - 1800)).toBeLessThan(5)
    expect(Math.abs(cyclesFromFxTone(t.max) - 2500)).toBeLessThan(5)
  })
})

describe('scanGlitches', () => {
  const freqsOf = (x: Float32Array): number[] => [
    peakFrequency(x, SR, 300, 600).hz,
    peakFrequency(x, SR, ...FX_TONE_BAND).hz,
    peakFrequency(x, SR, 6000, 9000).hz
  ]

  it('finds nothing in a clean recording, even with the clock 200 ppm off', () => {
    const x = telemetry(1, 3000, 1.0002)
    expect(scanGlitches(x, SR, freqsOf(x)).times).toEqual([])
  })

  // A gap also bends that block's fit, so its whole 1024-sample block may light up.
  it('finds a 64-sample gap of zeros, in its block', () => {
    const x = telemetry(1, 3000)
    x.fill(0, 20000, 20064)
    const { times } = scanGlitches(x, SR, freqsOf(x))
    expect(times.length).toBeGreaterThan(0)
    expect(times.every((t) => t >= 19456 / SR && t < 20480 / SR)).toBe(true)
  })

  it('finds a recording broken everywhere once told the clean floor', () => {
    const x = telemetry(1, 3000)
    for (let at = 1000; at + 64 < x.length; at += 2000) x.fill(0, at, at + 64)
    const clean = telemetry(1, 3000)
    const { floor } = scanGlitches(clean, SR, freqsOf(clean))
    expect(scanGlitches(x, SR, freqsOf(x), { floor }).times.length).toBeGreaterThan(20)
  })

  it('finds a repeated 64-sample block (an underrun replaying the last buffer)', () => {
    const x = telemetry(1, 3000)
    const y = new Float32Array(x.length)
    y.set(x.subarray(0, 30064))
    y.set(x.subarray(30000, x.length - 64), 30064)
    expect(scanGlitches(y, SR, freqsOf(y)).times.length).toBeGreaterThan(0)
  })
})

describe('bandLevels / toneLevel', () => {
  it('read white noise flat at 3 dB per third octave and a tone 20 dB down at its level', () => {
    const x = new Float32Array(SR * 4)
    let seed = 7
    for (let i = 0; i < x.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      x[i] = (seed / 2 ** 32 - 0.5) * 0.5
    }
    const b = bandLevels(x, SR)
    const slope = (b[b.length - 4] - b[3]) / (b.length - 7)
    expect(Math.abs(slope - 10 * Math.log10(Math.pow(2, 1 / 3)))).toBeLessThan(0.1)
    const y = new Float32Array(SR * 2)
    for (let i = 0; i < y.length; i++)
      y[i] = Math.sin((2 * Math.PI * 1000 * i) / SR) + 0.1 * Math.sin((2 * Math.PI * 3000 * i) / SR)
    expect(toneLevel(y, SR, 1000) - toneLevel(y, SR, 3000)).toBeCloseTo(20, 1)
  })
})

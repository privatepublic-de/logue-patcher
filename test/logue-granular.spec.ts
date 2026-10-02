import { describe, it, expect } from 'vitest'
import { mulawDecode, mulawEncode } from '../logue-codegen/src/sample/mulaw'
import { base64ToBytes, bytesToBase64 } from '../logue-codegen/src/sample/base64'
import { decodeWav, InvalidWavError } from '../logue-codegen/src/sample/wav'
import { resample } from '../logue-codegen/src/sample/resample'
import { detectRootNote } from '../logue-codegen/src/sample/detectRootNote'
import {
  importWavSample,
  MIN_SAMPLE_RATE,
  sampleBytes,
  sampleContentHash
} from '../logue-codegen/src/sample/importSample'
import { generateOldGenOscUnit } from '../logue-codegen/src/minilogue-xd/generateOscUnit'
import { generateOscUnit } from '../logue-codegen/src/nts1mkii/generateOscUnit'
import { estimateOscStateCost } from '../logue-codegen/src/estimateOscStateCost'
import { findUnresolvedReferences } from '../logue-codegen/src/unresolvedReferences'
import { LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import { parsePatchFile, serializePatchFile } from '../src/shared/json/patchCodec'
import type { ObjNode, PatchDocument, SampleAsset } from '../src/shared/domain/patch'
import { testSampleAsset } from './support/testSample'
import { wav } from './support/wavWriter'

function sineFrames(hz: number, rate: number, seconds: number, channels = 1): number[][] {
  return Array.from({ length: Math.round(rate * seconds) }, (_, i) =>
    Array(channels).fill(0.5 * Math.sin((2 * Math.PI * hz * i) / rate))
  )
}

function granularDoc(nodes: ObjNode[]): PatchDocument {
  const last = nodes[nodes.length - 1].name!
  return {
    nodes: [
      ...nodes,
      { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
    ],
    nets: [{ sources: [{ obj: last, outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
    settings: {},
    notes: ''
  }
}

function granular(name: string, sample?: SampleAsset): ObjNode {
  return { kind: 'obj', type: 'logue/osc/granular', name, x: 0, y: 0, params: [], sample }
}

describe('mu-law', () => {
  it('round-trips within mu-law quantization error, and matches G.711 reference bytes', () => {
    for (let x = -1; x <= 1; x += 0.01) {
      const back = mulawDecode(mulawEncode(x))
      expect(Math.abs(back - x)).toBeLessThan(Math.max(0.002, Math.abs(x) * 0.07))
    }
    // G.711: silence encodes to 0xFF, full-scale positive to 0x80, full-scale negative to 0x00.
    expect(mulawEncode(0)).toBe(0xff)
    expect(mulawEncode(1)).toBe(0x80)
    expect(mulawEncode(-1)).toBe(0x00)
    expect(mulawDecode(0x80)).toBeCloseTo(32124 / 32768, 6)
  })

  it('is monotonic across all 256 codes, so the on-device decoder never folds back', () => {
    const positives = Array.from({ length: 128 }, (_, i) => mulawDecode(0xff - i))
    for (let i = 1; i < positives.length; i++)
      expect(positives[i]).toBeGreaterThan(positives[i - 1])
  })
})

describe('base64', () => {
  it('round-trips every length remainder', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 255]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37) & 0xff)
      expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes))
    }
  })
})

describe('decodeWav', () => {
  it.each(['pcm8', 'pcm16', 'pcm24', 'float32'] as const)(
    'decodes %s and mixes stereo to mono',
    (format) => {
      const frames = [
        [0.5, -0.5],
        [0.25, 0.25],
        [-0.75, -0.25]
      ]
      const decoded = decodeWav(wav(frames, 44100, format))
      expect(decoded.sampleRate).toBe(44100)
      const tolerance = format === 'pcm8' ? 0.02 : 0.001
      expect(Array.from(decoded.samples).map((x) => Math.abs(x - 0))[0]).toBeLessThan(tolerance)
      expect(decoded.samples[1]).toBeCloseTo(0.25, format === 'pcm8' ? 1 : 3)
      expect(decoded.samples[2]).toBeCloseTo(-0.5, format === 'pcm8' ? 1 : 3)
    }
  )

  it('rejects a non-WAV file with a clear error', () => {
    expect(() => decodeWav(new TextEncoder().encode('not a wav file at all'))).toThrow(
      InvalidWavError
    )
  })
})

describe('resample', () => {
  it('produces the length the rate ratio implies and keeps a low tone at unity gain', () => {
    const input = Float32Array.from(sineFrames(100, 48000, 1).map((f) => f[0]))
    const out = resample(input, 48000, 8000)
    expect(out.length).toBe(8000)
    let peak = 0
    for (let i = 500; i < 7500; i++) peak = Math.max(peak, Math.abs(out[i]))
    expect(peak).toBeCloseTo(0.5, 2)
  })

  it('removes a tone above the new Nyquist instead of aliasing it down', () => {
    const input = Float32Array.from(sineFrames(6000, 48000, 0.5).map((f) => f[0]))
    const out = resample(input, 48000, 8000)
    let peak = 0
    for (let i = 200; i < out.length - 200; i++) peak = Math.max(peak, Math.abs(out[i]))
    expect(peak).toBeLessThan(0.01)
  })
})

describe('detectRootNote', () => {
  it.each([
    [220, 57],
    [440, 69],
    [110, 45],
    [261.63, 60]
  ])('finds %f Hz as MIDI note %i', (hz, note) => {
    const samples = Float32Array.from(sineFrames(hz, 44100, 0.5).map((f) => f[0]))
    expect(detectRootNote(samples, 44100)).toBe(note)
  })

  it('proposes nothing for noise', () => {
    let x = 1
    const samples = Float32Array.from({ length: 22050 }, () => {
      x = (x * 1103515245 + 12345) & 0x7fffffff
      return x / 0x7fffffff - 0.5
    })
    expect(detectRootNote(samples, 44100)).toBeUndefined()
  })
})

describe('importWavSample', () => {
  it('fits the whole file into the chosen size by lowering the stored rate', () => {
    const result = importWavSample(wav(sineFrames(220, 44100, 2), 44100, 'pcm16'), 'a.wav', 16384)
    expect(result.asset.rate).toBe(Math.floor(16384 / 2))
    expect(sampleBytes(result.asset).length).toBeLessThanOrEqual(16384)
    expect(sampleBytes(result.asset).length).toBeGreaterThan(16300)
    expect(result.asset.truncatedFromSeconds).toBeUndefined()
    expect(result.rootNote).toBe(57)
  })

  it('never upsamples a short file past its own rate', () => {
    const result = importWavSample(wav(sineFrames(220, 22050, 0.1), 22050, 'pcm16'), 'a.wav', 16384)
    expect(result.asset.rate).toBe(22050)
    // One sample shorter: the sine's own leading zero is trimmed as silence.
    expect(sampleBytes(result.asset).length).toBe(2204)
  })

  it('cuts a file too long for the lowest rate, and says so', () => {
    const result = importWavSample(wav(sineFrames(220, 8000, 5), 8000, 'pcm16'), 'long.wav', 4096)
    expect(result.asset.rate).toBe(MIN_SAMPLE_RATE)
    expect(sampleBytes(result.asset).length).toBe(4096)
    expect(result.asset.truncatedFromSeconds).toBeCloseTo(5, 1)
  })

  it('trims silence at both ends before fitting', () => {
    const frames = [
      ...Array(4410).fill([0]),
      ...sineFrames(220, 44100, 1),
      ...Array(4410).fill([0])
    ]
    const result = importWavSample(wav(frames, 44100, 'pcm16'), 'a.wav', 8192)
    expect(result.sourceSeconds).toBeCloseTo(1, 2)
  })

  it('normalizes to full scale', () => {
    const result = importWavSample(wav(sineFrames(220, 44100, 0.5), 44100, 'pcm16'), 'a.wav', 8192)
    const peak = Math.max(...Array.from(sampleBytes(result.asset), (b) => Math.abs(mulawDecode(b))))
    expect(peak).toBeGreaterThan(0.95)
  })
})

describe('logue/osc/granular codegen', () => {
  it('bakes one shared table for two instances playing the same sample, and counts it once', () => {
    const sample = testSampleAsset(1000)
    const doc = granularDoc([granular('a', sample), granular('b', sample)])
    doc.nodes.push({ kind: 'obj', type: 'logue/mix/mix2', name: 'mix', x: 0, y: 0, params: [] })
    doc.nets = [
      { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'mix', inlet: 'in1' }] },
      { sources: [{ obj: 'b', outlet: 'out' }], dests: [{ obj: 'mix', inlet: 'in2' }] },
      { sources: [{ obj: 'mix', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
    ]
    const hash = sampleContentHash(sample)
    const { oscCpp } = generateOldGenOscUnit(doc, { name: 'g' })
    expect(
      oscCpp.match(new RegExp(`static const uint8_t kGranularSample_${hash}\\[1000\\]`, 'g'))
    ).toHaveLength(1)
    expect(oscCpp).toContain(`smp_a = granular_sample_${hash}();`)
    expect(oscCpp).toContain(`smp_b = granular_sample_${hash}();`)

    const estimate = estimateOscStateCost(doc, 'minilogue-xd')
    expect(estimate.status).toBe('ok')
    if (estimate.status !== 'ok') return
    expect(
      estimate.estimate.sharedHelpers.filter((h) => h.helperKey === `granular_sample_${hash}`)
    ).toEqual([{ helperKey: `granular_sample_${hash}`, bytes: 1000 }])
  })

  it('bakes the table bytes exactly as stored', () => {
    const sample = testSampleAsset(96)
    const { oscH } = generateOscUnit(granularDoc([granular('g', sample)]), { name: 'g' })
    const table = oscH.match(/kGranularSample_\w+\[96\] = \{([^}]*)\}/)![1]
    expect(table.split(',').map((t) => Number(t.trim()))).toEqual(Array.from(sampleBytes(sample)))
    expect(oscH).toContain(`rateRatio_g = ${sample.rate}.f / 48000.f;`)
  })

  it('force-inlines every grain-engine helper -- a real, callable granular_step (itself calling mulaw_decode/grain_sin_pi) hung a real minilogue xd, the same -Os call shape as the formant crash', () => {
    const { oscCpp } = generateOldGenOscUnit(granularDoc([granular('g', testSampleAsset(96))]), {
      name: 'g'
    })
    expect(oscCpp).toContain(
      'static inline __attribute__((always_inline)) const float *mulaw_table()'
    )
    for (const fn of ['granular_step', 'grain_window', 'grain_sin_pi']) {
      expect(oscCpp).toMatch(
        new RegExp(`static inline __attribute__\\(\\(always_inline\\)\\) float ${fn}\\(`)
      )
    }
  })

  it('recomputes the grain setup at control rate -- per-sample note_w0 lookups and divides overloaded a real xd playing chords with SYNC off', () => {
    const { oscCpp } = generateOldGenOscUnit(granularDoc([granular('g', testSampleAsset(96))]), {
      name: 'g'
    })
    expect(oscCpp).toContain('(ctlCount_g == 0u ? note_w0(note_ + ')
    expect(oscCpp).toContain('(ctlCount_g == 0u ? (sync_g >= 1.f ? 1.f : note_w0(root_g)) : 0.f)')
    for (const name of ['size', 'density', 'window']) {
      expect(oscCpp).toContain(`(ctlCount_g == 0u ? (${name}_g * 0.01f) : 0.f)`)
    }
    // Position/smear are read at every spawn, so they stay per-sample.
    expect(oscCpp).toContain(', (position_g * 0.01f), (smear_g * 0.01f), ')
    expect(oscCpp).toMatch(/void noteOn\(\)[\s\S]*?spawn_g = 1\.f;\n\s*ctlCount_g = 0u;/)
    expect(oscCpp).toContain('*ctlCount = 15u;')
    // SYNC off tops out at 3 overlapping grains.
    expect(oscCpp).toContain('overlap = 0.5f + 2.5f * density01;')
    // Sounding grains follow the current note, so a new note doesn't start with the last one's pitch.
    expect(oscCpp).toContain('pos += speed;')
    expect(oscCpp).not.toContain('gStep')
  })

  it('adds each wired percent inlet onto its dial at +-50, clamped to 0-100', () => {
    const inlets = ['position', 'smear', 'size', 'density', 'window']
    const doc = granularDoc([
      { kind: 'obj', type: 'logue/lfo/sine-lfo', name: 'lfo', x: 0, y: 0, params: [] },
      granular('g', testSampleAsset(96))
    ])
    doc.nets.push(
      ...inlets.map((inlet) => ({
        sources: [{ obj: 'lfo', outlet: 'out' }],
        dests: [{ obj: 'g', inlet }]
      }))
    )
    const { oscCpp } = generateOldGenOscUnit(doc, { name: 'g' })
    for (const inlet of inlets) {
      expect(oscCpp).toContain(`(clampf(${inlet}_g + (y_lfo) * 50.f, 0.f, 100.f) * 0.01f)`)
    }
  })

  it('refuses to export an active node with no sample, naming it', () => {
    const doc = granularDoc([granular('grain')])
    expect(() => generateOldGenOscUnit(doc, { name: 'g' })).toThrow(/"grain": No sample loaded/)
    expect(estimateOscStateCost(doc, 'nts1mkii').status).toBe('incomplete')
    expect(findUnresolvedReferences(doc, doc.nodes[0] as ObjNode)).toEqual([
      expect.objectContaining({ kind: 'instance-problem' })
    ])
  })

  it("doesn't block Export when the sample-less node isn't wired to the output", () => {
    const doc = granularDoc([
      granular('unwired'),
      { kind: 'obj', type: 'logue/osc/sine', name: 's', x: 0, y: 0, params: [] }
    ])
    expect(() => generateOldGenOscUnit(doc, { name: 'g' })).not.toThrow()
  })
})

describe('.loguepatch codec', () => {
  it('round-trips a node sample', () => {
    const sample = { ...testSampleAsset(64), sourcePath: '/x/a.wav', truncatedFromSeconds: 12.5 }
    const doc = granularDoc([granular('g', sample)])
    const back = parsePatchFile(serializePatchFile(doc))
    expect((back.nodes[0] as ObjNode).sample).toEqual(sample)
    expect((back.nodes[1] as ObjNode).sample).toBeUndefined()
  })
})

import { describe, it, expect } from 'vitest'
import { generateOldGenOscUnit } from '../logue-codegen/src/minilogue-xd/generateOscUnit'
import { generateOscUnit } from '../logue-codegen/src/nts1mkii/generateOscUnit'
import { estimateOscStateCost } from '../logue-codegen/src/estimateOscStateCost'
import { findLoguePrimitive } from '../logue-codegen/src/primitives'
import { LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import { sampleContentHash } from '../logue-codegen/src/sample/importSample'
import { mulawDecode } from '../logue-codegen/src/sample/mulaw'
import { bytesToBase64 } from '../logue-codegen/src/sample/base64'
import type { ObjNode, PatchDocument, SampleAsset } from '../src/shared/domain/patch'
import { testPcm8SampleAsset, testSampleAsset } from './support/testSample'

function sampleNode(name: string, sample?: SampleAsset): ObjNode {
  return { kind: 'obj', type: 'logue/osc/sample', name, x: 0, y: 0, params: [], sample }
}

function docOf(nodes: ObjNode[], nets: PatchDocument['nets']): PatchDocument {
  return {
    nodes: [
      ...nodes,
      { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
    ],
    nets,
    settings: {},
    notes: ''
  }
}

function single(sample: SampleAsset | undefined): PatchDocument {
  return docOf(
    [sampleNode('s', sample)],
    [{ sources: [{ obj: 's', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }]
  )
}

function withoutLoop(sample: SampleAsset): SampleAsset {
  const copy = { ...sample }
  delete copy.loopStart
  delete copy.loopEnd
  return copy
}

function tableValues(code: string): number[] {
  const body = code.match(/kSamplePcm8_\w+\[\d+\] = \{([^}]*)\}/)![1]
  return body.split(',').map((t) => Number(t.trim()))
}

describe('logue/osc/sample codegen', () => {
  it('bakes a pcm8 sample as signed bytes, with its rate and loop as init constants', () => {
    const sample = testPcm8SampleAsset(256)
    const { oscH } = generateOscUnit(single(sample), { name: 's' })
    const stored = Array.from(Buffer.from(sample.data, 'base64'), (b) => (b >= 128 ? b - 256 : b))
    expect(tableValues(oscH)).toEqual(stored)
    expect(oscH).toContain('static const int8_t kSamplePcm8_')
    expect(oscH).toContain('len_s = 256u;')
    expect(oscH).toContain('loopStart_s = 128u;')
    expect(oscH).toContain('loopEnd_s = 256u;')
    expect(oscH).toContain('rateRatio_s = 24000.f / 48000.f;')
  })

  it('loops the whole sample when it has no stored loop', () => {
    const sample = withoutLoop(testPcm8SampleAsset(100))
    const { oscCpp } = generateOldGenOscUnit(single(sample), { name: 's' })
    expect(oscCpp).toContain('loopStart_s = 0u;')
    expect(oscCpp).toContain('loopEnd_s = 100u;')
  })

  it('converts a mu-law sample (a granular node replaced by this) to linear 8-bit', () => {
    const sample = testSampleAsset(64)
    const { oscCpp } = generateOldGenOscUnit(single(sample), { name: 's' })
    const expected = Array.from(Buffer.from(sample.data, 'base64'), (b) =>
      Math.max(-128, Math.min(127, Math.round(mulawDecode(b) * 128)))
    )
    expect(tableValues(oscCpp)).toEqual(expected)
    expect(oscCpp).not.toContain('mulaw_table')
  })

  it('bakes one table for two instances on the same bytes, counted once, whatever their loops', () => {
    const a = testPcm8SampleAsset(500)
    const b = { ...a, loopStart: 10, loopEnd: 400 }
    const doc = docOf(
      [
        sampleNode('a', a),
        sampleNode('b', b),
        { kind: 'obj', type: 'logue/mix/mix2', name: 'mix', x: 0, y: 0, params: [] }
      ],
      [
        { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'mix', inlet: 'in1' }] },
        { sources: [{ obj: 'b', outlet: 'out' }], dests: [{ obj: 'mix', inlet: 'in2' }] },
        { sources: [{ obj: 'mix', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ]
    )
    const hash = sampleContentHash(a)
    const { oscCpp } = generateOldGenOscUnit(doc, { name: 's' })
    expect(
      oscCpp.match(new RegExp(`static const int8_t kSamplePcm8_${hash}\\[500\\]`, 'g'))
    ).toHaveLength(1)
    expect(oscCpp).toContain('loopStart_a = 250u;')
    expect(oscCpp).toContain('loopStart_b = 10u;')
    const estimate = estimateOscStateCost(doc, 'minilogue-xd')
    expect(estimate.status).toBe('ok')
    if (estimate.status !== 'ok') return
    expect(
      estimate.estimate.sharedHelpers.filter((h) => h.helperKey === `sample_pcm8_${hash}`)
    ).toEqual([{ helperKey: `sample_pcm8_${hash}`, bytes: 500 }])
  })

  it('keeps the call shape at process -> leaf on the xd: every helper it brings is always_inline but note_w0', () => {
    const { oscCpp } = generateOldGenOscUnit(single(testPcm8SampleAsset()), { name: 's' })
    for (const fn of ['sample_step', 'sample_speed', 'sample_speed_ctl']) {
      expect(oscCpp).toMatch(
        new RegExp(`static inline __attribute__\\(\\(always_inline\\)\\) float ${fn}\\(`)
      )
    }
  })

  it('works out a per-sample pitch every 16 samples, and a per-sample start only at a restart', () => {
    const doc = docOf(
      [
        sampleNode('s', testPcm8SampleAsset()),
        { kind: 'obj', type: 'logue/lfo/sine-lfo', name: 'lfo', x: 0, y: 0, params: [] }
      ],
      [
        { sources: [{ obj: 's', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] },
        { sources: [{ obj: 'lfo', outlet: 'out' }], dests: [{ obj: 's', inlet: 'pitch' }] },
        { sources: [{ obj: 'lfo', outlet: 'out' }], dests: [{ obj: 's', inlet: 'start' }] }
      ]
    )
    const { oscCpp } = generateOldGenOscUnit(doc, { name: 's' })
    expect(oscCpp).toContain(
      'sample_speed_ctl(&ctlCount_s, &speed_s, (ctlCount_s == 0u ? sample_speed('
    )
    expect(oscCpp).toContain('*ctlCount = 15u;')
    expect(oscCpp).toContain(
      '(restart_s != 0u ? (clampf(start_s + (y_lfo) * 50.f, 0.f, 100.f) * 0.01f) : 0.f)'
    )
    expect(oscCpp).not.toContain('blkSpeed_s')
    expect(oscCpp).not.toContain('blkStart_s')
  })

  it('restarts on every note-on', () => {
    const { oscCpp } = generateOldGenOscUnit(single(testPcm8SampleAsset()), { name: 's' })
    expect(oscCpp).toMatch(/void noteOn\(\)\s*\{\s*restart_s = 1u;/)
  })
})

describe('logue/osc/sample instance problems', () => {
  const problem = (sample?: SampleAsset): string | undefined =>
    findLoguePrimitive('logue/osc/sample')!.instanceProblem!({ name: 's', sample })

  it('needs a sample, of at least 2 samples', () => {
    expect(problem(undefined)).toMatch(/No sample loaded/)
    const one = { ...testPcm8SampleAsset(2), data: bytesToBase64(new Uint8Array(1)) }
    delete one.loopStart
    delete one.loopEnd
    expect(problem(one)).toMatch(/shorter than 2/)
    expect(problem(testPcm8SampleAsset())).toBeUndefined()
  })

  it('rejects a loop shorter than the speed cap allows (a hand-edited file)', () => {
    expect(problem({ ...testPcm8SampleAsset(256), loopStart: 100, loopEnd: 120 })).toMatch(
      /Loop is shorter/
    )
  })

  it('rejects a sample longer than the 16.16 position addresses', () => {
    const base = withoutLoop(testPcm8SampleAsset(2))
    expect(problem({ ...base, data: bytesToBase64(new Uint8Array(65536)) })).toMatch(/longer than/)
  })

  it("refuses to export an active node with no sample, but not one that isn't wired", () => {
    expect(() => generateOldGenOscUnit(single(undefined), { name: 's' })).toThrow(
      /"s": No sample loaded/
    )
    const unwired = docOf(
      [sampleNode('s'), sampleNode('t', testPcm8SampleAsset())],
      [{ sources: [{ obj: 't', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }]
    )
    expect(() => generateOldGenOscUnit(unwired, { name: 's' })).not.toThrow()
  })
})

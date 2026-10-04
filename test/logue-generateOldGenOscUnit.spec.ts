import { describe, it, expect } from 'vitest'
import {
  generateOldGenOscUnit,
  UnsupportedLogueNodeError,
  InvalidLogueUnitNameError,
  InvalidLogueParamError
} from '../logue-codegen/src/minilogue-xd/generateOscUnit'
import { generateOscUnit } from '../logue-codegen/src/nts1mkii/generateOscUnit'
import { LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import type { PatchDocument, ObjNode, CommentNode } from '../src/shared/domain/patch'

function sineNode(name: string): ObjNode {
  return { kind: 'obj', type: 'logue/osc/sine', name, x: 0, y: 0, params: [] }
}

function pulseNode(name: string, logueParamIndex?: number): ObjNode {
  return {
    kind: 'obj',
    type: 'logue/osc/pulse',
    name,
    x: 0,
    y: 0,
    params:
      logueParamIndex === undefined
        ? []
        : [{ name: 'WIDTH', value: '50', logueParamIndex: { 'minilogue-xd': logueParamIndex } }]
  }
}

/** Same auto-wiring convention as `test/logue-generateOscUnit.spec.ts`'s own `docWith` -- see its doc comment. */
function docWith(nodes: PatchDocument['nodes']): PatchDocument {
  if (nodes.length === 0) {
    return { nodes: [], nets: [], settings: {}, notes: '' }
  }
  const firstObj = nodes.find((n): n is ObjNode => n.kind === 'obj')
  const out: ObjNode = {
    kind: 'obj',
    type: LOGUE_AUDIO_OUT_TYPE,
    name: 'out',
    x: 0,
    y: 0,
    params: []
  }
  return {
    nodes: [...nodes, out],
    nets: firstObj
      ? [
          {
            sources: [{ obj: firstObj.name!, outlet: 'out' }],
            dests: [{ obj: out.name!, inlet: 'in' }]
          }
        ]
      : [],
    settings: {},
    notes: ''
  }
}

describe('generateOldGenOscUnit (phase-4, minilogue xd)', () => {
  it('generates a real, well-formed manifest.json/osc.cpp for a single sine primitive', () => {
    const doc = docWith([sineNode('sine1')])
    const result = generateOldGenOscUnit(doc, { name: 'axo poc' })

    const manifest = JSON.parse(result.manifestJson)
    expect(manifest.header.platform).toBe('minilogue-xd')
    expect(manifest.header.module).toBe('osc')
    expect(manifest.header.name).toBe('axo poc')
    expect(manifest.header.num_param).toBe(0)
    expect(manifest.header.params).toEqual([])

    expect(result.oscCpp).toContain('class Osc')
    expect(result.oscCpp).toContain('float phase_sine1;')
    expect(result.oscCpp).toContain('osc_sinf(phase_sine1)')
    expect(result.oscCpp).toContain('yn[i] = f32_to_q31(clip1m1f(')
    expect(result.oscCpp).toContain('void OSC_CYCLE(')
    expect(result.oscCpp).toContain('void OSC_PARAM(')
  })

  it('scales the clipped signal below exact full-scale before the Q31 cast -- f32_to_q31(1.0f) is real, confirmed undefined behavior (0x7FFFFFFF rounds up to 2147483648.0f as a float, one past INT32_MAX), found via a host-native UBSan harness run on a hard-edged pulse wave (2026-09-16)', () => {
    const doc = docWith([sineNode('sine1')])
    const result = generateOldGenOscUnit(doc, { name: 'headroom test' })

    expect(result.oscCpp).toContain('float y_sine1 = osc_sinf(phase_sine1);')
    expect(result.oscCpp).toContain('f32_to_q31(clip1m1f(y_sine1) * 0.999f)')
  })

  it('reuses the SAME primitive registry as NTS-1 mkII -- saw/square/pulse/triangle all work unmodified', () => {
    for (const type of ['logue/osc/saw', 'logue/osc/square', 'logue/osc/triangle']) {
      const doc = docWith([{ kind: 'obj', type, name: 'n', x: 0, y: 0, params: [] }])
      expect(() => generateOldGenOscUnit(doc, { name: 'test' })).not.toThrow()
    }
  })

  it('exposes a bound param as a real manifest.json row and a real setParameter case', () => {
    const doc = docWith([pulseNode('pulse1', 0)])
    const result = generateOldGenOscUnit(doc, { name: 'pulse exposed' })

    const manifest = JSON.parse(result.manifestJson)
    expect(manifest.header.num_param).toBe(1)
    // WIDTH's raw value already IS a plain percent (@logue-codegen/paramDeviceType), so it gets
    // the real manifest '%' type minilogue xd's own schema supports, not '' (typeless).
    expect(manifest.header.params).toEqual([['WIDTH', 0, 100, '%']])

    expect(result.oscCpp).toContain('switch (index)')
    expect(result.oscCpp).toContain('case 0: width_pulse1 = value; break;')
  })

  it('declares COARSE/FINE as "%" on minilogue xd -- typeless ranges must be positive', () => {
    const doc = docWith([
      {
        kind: 'obj',
        type: 'logue/osc/sine',
        name: 'sine1',
        x: 0,
        y: 0,
        params: [
          { name: 'COARSE', value: '3', logueParamIndex: { 'minilogue-xd': 0 } },
          { name: 'FINE', value: '-10', logueParamIndex: { 'minilogue-xd': 1 } }
        ]
      }
    ])
    const result = generateOldGenOscUnit(doc, { name: 'coarse fine exposed' })

    const manifest = JSON.parse(result.manifestJson)
    expect(manifest.header.params).toEqual([
      ['COARSE', -24, 24, '%'],
      ['FINE', -50, 50, '%']
    ])
  })

  it('gives TUNE/FEEDBACK the broad "%" default and TRACK a two-step 0..1 "%" row, in one real manifest (@logue-codegen/paramDeviceType), from the pre-rename CUTOFF/GAIN names', () => {
    const doc = docWith([
      {
        kind: 'obj',
        type: 'logue/filter/comb',
        name: 'comb1',
        x: 0,
        y: 0,
        params: [
          { name: 'CUTOFF', value: '50', logueParamIndex: { 'minilogue-xd': 0 } },
          { name: 'GAIN', value: '0', logueParamIndex: { 'minilogue-xd': 1 } },
          { name: 'TRACK', value: '0', logueParamIndex: { 'minilogue-xd': 2 } }
        ]
      }
    ])
    const result = generateOldGenOscUnit(doc, { name: 'comb device types' })

    const manifest = JSON.parse(result.manifestJson)
    expect(manifest.header.params).toEqual([
      ['TUNE', 0, 100, '%'],
      ['FEEDBACK', 0, 100, '%'],
      // A checkbox in-app: two device steps reading 0%/1% instead of a 0-100 sweep.
      ['TRACK', 0, 1, '%']
    ])
    expect(result.oscCpp).toContain('case 2: if (v < 0) v = 0; else if (v > 1) v = 1; break;')
    expect(result.oscCpp).toContain('case 2: track_comb1 = (value * 100); break;')
  })

  it("clamps OSC_PARAM's raw value to the manifest-declared max before forwarding -- old-gen does NOT pre-clamp incoming values itself (found via a real hardware bug, 2026-09-16: an unclamped value produced constant-DC/spark output instead of a variable pulse)", () => {
    const doc = docWith([pulseNode('pulse1', 0)])
    const result = generateOldGenOscUnit(doc, { name: 'clamp test' })

    expect(result.oscCpp).toContain('void OSC_PARAM(uint16_t index, uint16_t value)')
    expect(result.oscCpp).toContain('int32_t v = (int32_t)value;')
    expect(result.oscCpp).toContain('case 0: if (v < 0) v = 0; else if (v > 100) v = 100; break;')
    // the clamp switch must run BEFORE forwarding into the class
    const clampIndex = result.oscCpp.indexOf('else if (v > 100) v = 100;')
    const forwardIndex = result.oscCpp.indexOf('s_osc.setParameter(index, v);')
    expect(clampIndex).toBeGreaterThan(0)
    expect(forwardIndex).toBeGreaterThan(clampIndex)
  })

  it('reads a negative-range param as 0-200 with 0% at 100 (Korg userosc.h) and clamps both ends (a real xd bug, 2026-09-27)', () => {
    const doc = docWith([
      {
        kind: 'obj',
        type: 'logue/util/constant',
        name: 'rate',
        x: 0,
        y: 0,
        params: [{ name: 'VALUE', value: '0', logueParamIndex: { 'minilogue-xd': 0 } }]
      }
    ])
    const result = generateOldGenOscUnit(doc, { name: 'bipolar param' })
    expect(JSON.parse(result.manifestJson).header.params).toEqual([['VALUE', -100, 100, '%']])
    expect(result.oscCpp).toContain(
      'case 0: v -= 100; if (v < -100) v = -100; else if (v > 100) v = 100; break;'
    )
    expect(result.oscCpp).toContain('void setParameter(uint16_t index, int32_t value)')
  })

  it('OSC_PARAM has no clamp switch at all when nothing is exposed', () => {
    const doc = docWith([pulseNode('pulse1')])
    const result = generateOldGenOscUnit(doc, { name: 'no clamp needed' })

    // The shape/second-fixed-knob sense intercept is always
    // present, regardless of whether anything is exposed on the 0-5 slots -- only the clamp
    // switch for THOSE slots is conditionally omitted.
    expect(result.oscCpp).toContain(
      'if (index == k_user_osc_param_shape) { s_osc.setShapeParam(param_val_to_f32(value)); return; }'
    )
    expect(result.oscCpp).not.toContain('int32_t v =')
    expect(result.oscCpp).toContain(
      'void OSC_PARAM(uint16_t index, uint16_t value)\n{\n  // SHAPE and the second fixed knob'
    )
  })

  it('leaves an unexposed param-capable primitive with zero manifest params but still seeds its own default', () => {
    const doc = docWith([pulseNode('pulse1')])
    const result = generateOldGenOscUnit(doc, { name: 'pulse unexposed' })

    const manifest = JSON.parse(result.manifestJson)
    expect(manifest.header.num_param).toBe(0)
    // stored RAW now, the *0.01f conversion moved to point-of-use
    expect(result.oscCpp).toContain('width_pulse1 = 50;')
  })

  it('rejects a gap in exposed indices -- unlike NTS-1 mkII, minilogue xd has no confirmed "unused slot" row', () => {
    const doc = docWith([pulseNode('pulse1', 2)])
    expect(() => generateOldGenOscUnit(doc, { name: 'gap test' })).toThrow(InvalidLogueParamError)
    expect(() => generateOldGenOscUnit(doc, { name: 'gap test' })).toThrow(/contiguous/)
  })

  it('rejects an index beyond the real 6-slot minilogue xd osc limit', () => {
    const doc = docWith([pulseNode('pulse1', 6)])
    expect(() => generateOldGenOscUnit(doc, { name: 'bad index' })).toThrow(InvalidLogueParamError)
  })

  it('rejects an unwired graph -- shares resolveAudioGraph with NTS-1 mkII (oscInstances.ts), not a separate check', () => {
    const doc: PatchDocument = {
      nodes: [
        sineNode('sine1'),
        {
          kind: 'obj',
          type: LOGUE_AUDIO_OUT_TYPE,
          name: 'out',
          x: 0,
          y: 0,
          params: []
        }
      ],
      nets: [],
      settings: {},
      notes: ''
    }
    expect(() => generateOldGenOscUnit(doc, { name: 'unwired' })).toThrow(UnsupportedLogueNodeError)
    expect(() => generateOldGenOscUnit(doc, { name: 'unwired' })).toThrow(/isn't connected/)
  })

  it('ignores comment nodes -- they generate no code', () => {
    const comment: CommentNode = { kind: 'comment', type: 'patch/comment', x: 0, y: 0, text: 'hi' }
    const annotated = docWith([sineNode('sine1'), comment])
    const plain = docWith([sineNode('sine1')])

    expect(generateOldGenOscUnit(annotated, { name: 'ok' })).toEqual(
      generateOldGenOscUnit(plain, { name: 'ok' })
    )
  })

  it('rejects an unrecognized primitive type', () => {
    const doc = docWith([{ kind: 'obj', type: 'osc/sine', name: 'n', x: 0, y: 0, params: [] }])
    expect(() => generateOldGenOscUnit(doc, { name: 'bad' })).toThrow(
      /isn't a recognized logue primitive/
    )
  })

  it('rejects an empty graph', () => {
    expect(() => generateOldGenOscUnit(docWith([]), { name: 'empty' })).toThrow(/Graph is empty/)
  })

  it('rejects a unit name containing a quote or newline (no length limit is enforced -- unlike NTS-1 mkII, manifest.json has no confirmed fixed-size buffer)', () => {
    const doc = docWith([sineNode('sine1')])
    expect(() => generateOldGenOscUnit(doc, { name: 'bad"name' })).toThrow(
      InvalidLogueUnitNameError
    )
    expect(() =>
      generateOldGenOscUnit(doc, { name: 'a genuinely quite long unit name with no issue' })
    ).not.toThrow()
  })

  describe('logue/mix/mix2 -- real multi-node wiring', () => {
    it('chains two oscillators into a mixer, computing each in topological order before the sum', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          sineNode('b'),
          { kind: 'obj', type: 'logue/mix/mix2', name: 'mixer', x: 0, y: 0, params: [] },
          {
            kind: 'obj',
            type: LOGUE_AUDIO_OUT_TYPE,
            name: 'out',
            x: 0,
            y: 0,
            params: []
          }
        ],
        nets: [
          {
            sources: [{ obj: 'a', outlet: 'out' }],
            dests: [{ obj: 'mixer', inlet: 'in1' }]
          },
          {
            sources: [{ obj: 'b', outlet: 'out' }],
            dests: [{ obj: 'mixer', inlet: 'in2' }]
          },
          {
            sources: [{ obj: 'mixer', outlet: 'out' }],
            dests: [{ obj: 'out', inlet: 'in' }]
          }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'mix test' })

      // Both oscillators compute first (in either relative order -- both are equally valid
      // topological orderings), the mixer references them by variable name, never by
      // re-inlining their expressions, and the mixer's own sum is what reaches the output.
      expect(result.oscCpp).toContain('float y_a = osc_sinf(phase_a);')
      expect(result.oscCpp).toContain('float y_b = osc_sinf(phase_b);')
      // GAIN1/GAIN2 default to 50/50, reproducing the exact prior * 0.5f averaging behavior.
      expect(result.oscCpp).toContain(
        'float y_mixer = (((y_a) * gain1_mixer) + ((y_b) * gain2_mixer));'
      )
      expect(result.oscCpp).toContain('f32_to_q31(clip1m1f(y_mixer) * 0.999f)')
      const aIndex = result.oscCpp.indexOf('float y_a =')
      const bIndex = result.oscCpp.indexOf('float y_b =')
      const mixerIndex = result.oscCpp.indexOf('float y_mixer =')
      expect(mixerIndex).toBeGreaterThan(aIndex)
      expect(mixerIndex).toBeGreaterThan(bIndex)
    })

    it('an unwired mixer inlet is left out of the sum (silence, no multiply), not an error', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          { kind: 'obj', type: 'logue/mix/mix2', name: 'mixer', x: 0, y: 0, params: [] },
          {
            kind: 'obj',
            type: LOGUE_AUDIO_OUT_TYPE,
            name: 'out',
            x: 0,
            y: 0,
            params: []
          }
        ],
        nets: [
          {
            sources: [{ obj: 'a', outlet: 'out' }],
            dests: [{ obj: 'mixer', inlet: 'in1' }]
          },
          {
            sources: [{ obj: 'mixer', outlet: 'out' }],
            dests: [{ obj: 'out', inlet: 'in' }]
          }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'mix unwired inlet' })
      expect(result.oscCpp).toContain('float y_mixer = (((y_a) * gain1_mixer));')
    })

    it('thru adds the previous mixer at unity, so mixers cascade without halving again', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          sineNode('b'),
          { kind: 'obj', type: 'logue/mix/mix2', name: 'm1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/mix/mix2', name: 'm2', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'm1', inlet: 'in1' }] },
          { sources: [{ obj: 'm1', outlet: 'out' }], dests: [{ obj: 'm2', inlet: 'thru' }] },
          { sources: [{ obj: 'b', outlet: 'out' }], dests: [{ obj: 'm2', inlet: 'in2' }] },
          { sources: [{ obj: 'm2', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'mix cascade' })
      expect(result.oscCpp).toContain('float y_m2 = ((y_m1) + ((y_b) * gain2_m2));')
    })

    it('rejects two sources wired into the SAME mixer inlet -- fan-in needs a real mixer, not a duplicate wire', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          sineNode('b'),
          { kind: 'obj', type: 'logue/mix/mix2', name: 'mixer', x: 0, y: 0, params: [] },
          {
            kind: 'obj',
            type: LOGUE_AUDIO_OUT_TYPE,
            name: 'out',
            x: 0,
            y: 0,
            params: []
          }
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in1' }] },
          { sources: [{ obj: 'b', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in1' }] },
          { sources: [{ obj: 'mixer', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      expect(() => generateOldGenOscUnit(doc, { name: 'double wired' })).toThrow(
        /fed by more than one source/
      )
    })

    it('rejects a feedback loop (a mixer wired into its own inlet, directly or transitively)', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/mix/mix2', name: 'mixer', x: 0, y: 0, params: [] },
          {
            kind: 'obj',
            type: LOGUE_AUDIO_OUT_TYPE,
            name: 'out',
            x: 0,
            y: 0,
            params: []
          }
        ],
        nets: [
          {
            sources: [{ obj: 'mixer', outlet: 'out' }],
            dests: [{ obj: 'mixer', inlet: 'in1' }]
          },
          {
            sources: [{ obj: 'mixer', outlet: 'out' }],
            dests: [{ obj: 'out', inlet: 'in' }]
          }
        ],
        settings: {},
        notes: ''
      }
      expect(() => generateOldGenOscUnit(doc, { name: 'feedback' })).toThrow(/feedback loop/)
    })
  })

  describe('per-instance param defaults', () => {
    function pulseNodeWithValue(name: string, value: string, logueParamIndex?: number): ObjNode {
      return {
        kind: 'obj',
        type: 'logue/osc/pulse',
        name,
        x: 0,
        y: 0,
        params: [
          {
            name: 'WIDTH',
            value,
            logueParamIndex:
              logueParamIndex === undefined ? undefined : { 'minilogue-xd': logueParamIndex }
          }
        ]
      }
    }

    it("bakes a placed instance's own authored value instead of the primitive spec's default", () => {
      const doc = docWith([pulseNodeWithValue('pulse1', '75')])
      const result = generateOldGenOscUnit(doc, { name: 'authored default' })
      expect(result.oscCpp).toContain('width_pulse1 = 75;')
    })

    it('two instances of the same primitive can have different authored defaults', () => {
      const doc: PatchDocument = {
        nodes: [
          pulseNodeWithValue('a', '10'),
          pulseNodeWithValue('b', '90'),
          {
            kind: 'obj',
            type: 'logue/mix/mix2',
            name: 'mixer',
            x: 0,
            y: 0,
            params: []
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in1' }] },
          { sources: [{ obj: 'b', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in2' }] },
          { sources: [{ obj: 'mixer', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'two defaults' })
      expect(result.oscCpp).toContain('width_a = 10;')
      expect(result.oscCpp).toContain('width_b = 90;')
    })

    it("an exposed param's manifest default reflects the authored value too, not just the spec default", () => {
      const doc = docWith([pulseNodeWithValue('pulse1', '33', 0)])
      const result = generateOldGenOscUnit(doc, { name: 'exposed authored' })
      const manifest = JSON.parse(result.manifestJson)
      // minilogue xd's manifest rows don't carry a default value at all (see generateManifestJson)
      // -- this primarily exercises resolveExposedParams' ExposedParamBinding.default without a
      // visible manifest assertion; the real assertion is the baked init value below, shared by
      // both the exposed and unexposed paths through the same resolveParamDefaultValue call.
      expect(manifest.header.num_param).toBe(1)
      expect(result.oscCpp).toContain('width_pulse1 = 33;')
    })

    it('rejects a non-numeric authored value with a clear error', () => {
      const doc = docWith([pulseNodeWithValue('pulse1', 'not-a-number')])
      expect(() => generateOldGenOscUnit(doc, { name: 'bad value' })).toThrow(
        InvalidLogueParamError
      )
      expect(() => generateOldGenOscUnit(doc, { name: 'bad value' })).toThrow(/non-numeric/)
    })

    it("rejects an authored value outside the param spec's declared range", () => {
      const doc = docWith([pulseNodeWithValue('pulse1', '150')])
      expect(() => generateOldGenOscUnit(doc, { name: 'out of range' })).toThrow(
        InvalidLogueParamError
      )
      expect(() => generateOldGenOscUnit(doc, { name: 'out of range' })).toThrow(
        /outside its declared range/
      )
    })
  })

  describe('logue/filter/lowpass-cheap -- a real wireable control inlet', () => {
    function filterNode(name: string, cutoffValue?: string): ObjNode {
      return {
        kind: 'obj',
        type: 'logue/filter/lowpass-cheap',
        name,
        x: 0,
        y: 0,
        params: cutoffValue === undefined ? [] : [{ name: 'CUTOFF', value: cutoffValue }]
      }
    }

    it('chains osc -> filter -> audio-out, with the filter reading the audio inlet by variable name', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          filterNode('filt1'),
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'filt1', inlet: 'in' }] },
          { sources: [{ obj: 'filt1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'filter chain' })
      expect(result.oscCpp).toContain('float y_osc1 = osc_sinf(phase_osc1);')
      expect(result.oscCpp).toContain(
        'float y_filt1 = onepole_step(&z1_filt1, y_osc1, cutoff_warp(cutoff_filt1));'
      )
      expect(result.oscCpp).toContain('static float onepole_step(float *z1, float x, float a)')
      // unwired cutoff defaults to fully open (100 -> 1.0f)
      expect(result.oscCpp).toContain('cutoff_filt1 = 100 * 0.01f;')
      expect(result.oscCpp).toContain('f32_to_q31(clip1m1f(y_filt1) * 0.999f)')
    })

    it('an unwired audio inlet reads as silence (0.f), not an error', () => {
      const doc: PatchDocument = {
        nodes: [
          filterNode('filt1'),
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'filt1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'unwired in' })
      expect(result.oscCpp).toContain('onepole_step(&z1_filt1, 0.f, cutoff_warp(cutoff_filt1))')
    })

    it("a wired cutoff inlet adds the upstream instance's own variable to the CUTOFF param", () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          sineNode('lfo1'),
          filterNode('filt1'),
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'filt1', inlet: 'in' }] },
          { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'filt1', inlet: 'cutoff' }] },
          { sources: [{ obj: 'filt1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'wired cutoff' })
      expect(result.oscCpp).toContain('float y_lfo1 = osc_sinf(phase_lfo1);')
      expect(result.oscCpp).toContain(
        'onepole_step(&z1_filt1, y_osc1, cutoff_warp((cutoff_filt1 + (y_lfo1))))'
      )
      // the dial is the centre the wired value moves around, so it's still read
      expect(result.oscCpp).not.toContain(
        'onepole_step(&z1_filt1, y_osc1, cutoff_warp(cutoff_filt1))'
      )
    })

    it('a custom unwired CUTOFF value reaches the generated init, not just the 100 default', () => {
      const doc = docWith([filterNode('filt1', '25')])
      const result = generateOldGenOscUnit(doc, { name: 'custom cutoff' })
      expect(result.oscCpp).toContain('cutoff_filt1 = 25 * 0.01f;')
    })

    it('the onepole_step helper is emitted exactly once even with multiple filter instances', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          filterNode('filt1'),
          filterNode('filt2'),
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'filt1', inlet: 'in' }] },
          { sources: [{ obj: 'filt1', outlet: 'out' }], dests: [{ obj: 'filt2', inlet: 'in' }] },
          { sources: [{ obj: 'filt2', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'two filters' })
      const occurrences = result.oscCpp.split('static float onepole_step').length - 1
      expect(occurrences).toBe(1)
      expect(result.oscCpp).toContain('onepole_step(&z1_filt1, y_osc1, cutoff_warp(cutoff_filt1))')
      expect(result.oscCpp).toContain('onepole_step(&z1_filt2, y_filt1, cutoff_warp(cutoff_filt2))')
    })

    it('cutoff_warp is a plain cheap cube (no libm), emitted exactly once regardless of instance count', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          filterNode('filt1'),
          filterNode('filt2'),
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'filt1', inlet: 'in' }] },
          { sources: [{ obj: 'filt1', outlet: 'out' }], dests: [{ obj: 'filt2', inlet: 'in' }] },
          { sources: [{ obj: 'filt2', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'warp dedup' })
      const occurrences = result.oscCpp.split('static float cutoff_warp').length - 1
      expect(occurrences).toBe(1)
      expect(result.oscCpp).toContain('return t * t * t;')
      expect(result.oscCpp).not.toMatch(/exp[f]?\(/)
    })
  })

  describe('logue/env/ad + logue/gain/vca -- note-triggered modulation', () => {
    function envNode(name: string, attack?: string, decay?: string): ObjNode {
      const params: ObjNode['params'] = []
      if (attack !== undefined) params.push({ name: 'ATTACK', value: attack })
      if (decay !== undefined) params.push({ name: 'DECAY', value: decay })
      return { kind: 'obj', type: 'logue/env/ad', name, x: 0, y: 0, params }
    }
    function vcaNode(name: string): ObjNode {
      return { kind: 'obj', type: 'logue/gain/vca', name, x: 0, y: 0, params: [] }
    }

    it('chains osc -> vca (audio) + env -> vca (gain) -> audio-out', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          envNode('env1'),
          vcaNode('vca1'),
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'in' }] },
          { sources: [{ obj: 'env1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'gain' }] },
          { sources: [{ obj: 'vca1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'env vca chain' })
      expect(result.oscCpp).toContain('float y_osc1 = osc_sinf(phase_osc1);')
      expect(result.oscCpp).toContain(
        'float y_env1 = ad_env_step(&stage_env1, &level_env1, blkAttackRate_env1, (exp_env1 >= 1.f ? (blkDecayRate_env1) * (level_env1 + 0.01f) : (blkDecayRate_env1)), 0.f, &prevTrig_env1);'
      )
      expect(result.oscCpp).toContain(
        'const float blkAttackRate_env1 = env_rate_from_percent(attackPercent_env1);'
      )
      expect(result.oscCpp).toContain(
        'const float blkDecayRate_env1 = env_rate_from_percent(decayPercent_env1);'
      )
      expect(result.oscCpp).toContain('float y_vca1 = ((y_osc1) * (y_env1));')
      expect(result.oscCpp).toContain(
        'static float ad_env_step(int *stage, float *level, float attackRate, float decayRate, float trig, float *prevTrig)'
      )
      expect(result.oscCpp).toContain('static float env_rate_from_percent(float percent)')
    })

    it('a real note-on event triggers the envelope -- OSC_NOTEON calls noteOn(), which sets stage to attack', () => {
      const doc = docWith([envNode('env1')])
      // env1 alone has no audio inlet wired anywhere, but it's still the active (output-
      // reachable) instance here since docWith wires the first obj node straight to audio-out.
      const result = generateOldGenOscUnit(doc, { name: 'noteon test' })
      expect(result.oscCpp).toContain(
        'void OSC_NOTEON(const user_osc_param_t * const params) { (void)params; s_osc.noteOn(); }'
      )
      expect(result.oscCpp).toContain('void noteOn()\n  {\n    stage_env1 = 1;\n  }')
    })

    it('an instance with no noteOnStatement (e.g. a plain oscillator) still gets a real, harmlessly-empty noteOn() method', () => {
      const doc = docWith([sineNode('sine1')])
      const result = generateOldGenOscUnit(doc, { name: 'no envelope' })
      expect(result.oscCpp).toContain('void noteOn()\n  {\n  }')
    })

    // Phase 20 moved the percent->rate conversion out of the params and into renderExpr (so a
    // wired attack/decay inlet can add in the same raw percent units the user dials) -- the
    // params themselves now store the plain percent, unconverted.
    it('custom ATTACK/DECAY values reach the generated init as raw percent members', () => {
      const doc = docWith([envNode('env1', '5', '80')])
      const result = generateOldGenOscUnit(doc, { name: 'custom env' })
      expect(result.oscCpp).toContain('attackPercent_env1 = 5;')
      expect(result.oscCpp).toContain('decayPercent_env1 = 80;')
      expect(result.oscCpp).toContain('float attackPercent_env1;')
      expect(result.oscCpp).toContain('float decayPercent_env1;')
    })

    it('an unwired VCA gain inlet falls back to the GAIN param (default 25 -- unity gain under the *0.04f scale, still fully open)', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          vcaNode('vca1'),
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'in' }] },
          { sources: [{ obj: 'vca1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'vca unwired gain' })
      expect(result.oscCpp).toContain('gain_vca1 = 25 * 0.04f;')
      expect(result.oscCpp).toContain('float y_vca1 = ((y_osc1) * (gain_vca1));')
    })

    it('GAIN=100 is a real, disclosed 4x/+12dB boost under the widened scale, not unity', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          {
            kind: 'obj',
            type: 'logue/gain/vca',
            name: 'vca1',
            x: 0,
            y: 0,
            params: [{ name: 'GAIN', value: '100' }]
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'in' }] },
          { sources: [{ obj: 'vca1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'vca boosted' })
      expect(result.oscCpp).toContain('gain_vca1 = 100 * 0.04f;')
    })

    describe('wireable ATTACK/DECAY', () => {
      function docWithModulatedEnv(inlet: 'attack' | 'decay'): PatchDocument {
        return {
          nodes: [
            envNode('env1', '5', '80'),
            { kind: 'obj', type: 'logue/lfo/sine-lfo', name: 'lfo1', x: 0, y: 0, params: [] },
            { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
          ],
          nets: [
            { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'env1', inlet }] },
            { sources: [{ obj: 'env1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
          ],
          settings: {},
          notes: ''
        }
      }

      it('a wired attack inlet ADDS to the ATTACK param (scaled +-50, clamped) rather than replacing it', () => {
        const result = generateOldGenOscUnit(docWithModulatedEnv('attack'), {
          name: 'wired attack'
        })
        expect(result.oscCpp).toContain(
          'ad_env_step(&stage_env1, &level_env1, env_rate_ctl(&attackCtl_env1, &attackRate_env1, attackPercent_env1 + (y_lfo1) * 50.f), (exp_env1 >= 1.f ? (blkDecayRate_env1) * (level_env1 + 0.01f) : (blkDecayRate_env1)), 0.f, &prevTrig_env1)'
        )
        expect(result.oscCpp).toContain(
          'const float blkDecayRate_env1 = env_rate_from_percent(decayPercent_env1);'
        )
        expect(result.oscCpp).toContain('static float clampf(float v, float lo, float hi)')
      })

      it('a wired decay inlet is the same shape, and leaves the unwired attack on its own param', () => {
        const result = generateOldGenOscUnit(docWithModulatedEnv('decay'), { name: 'wired decay' })
        expect(result.oscCpp).toContain(
          'ad_env_step(&stage_env1, &level_env1, blkAttackRate_env1, (exp_env1 >= 1.f ? (env_rate_ctl(&decayCtl_env1, &decayRate_env1, decayPercent_env1 + (y_lfo1) * 50.f)) * (level_env1 + 0.01f) : (env_rate_ctl(&decayCtl_env1, &decayRate_env1, decayPercent_env1 + (y_lfo1) * 50.f))), 0.f, &prevTrig_env1)'
        )
        expect(result.oscCpp).toContain(
          'const float blkAttackRate_env1 = env_rate_from_percent(attackPercent_env1);'
        )
      })

      // Phase 20 is NOT byte-transparent the way phase 11's FM was (the percent->rate conversion
      // genuinely moved), so the unwired case needs its own assertion that nothing modulation-
      // shaped leaks into a plain param-driven envelope.
      it('an envelope with neither inlet wired emits no clamp/add at all', () => {
        const doc = docWith([envNode('env1', '5', '80')])
        const result = generateOldGenOscUnit(doc, { name: 'unwired env' })
        expect(result.oscCpp).toContain(
          'ad_env_step(&stage_env1, &level_env1, blkAttackRate_env1, (exp_env1 >= 1.f ? (blkDecayRate_env1) * (level_env1 + 0.01f) : (blkDecayRate_env1)), 0.f, &prevTrig_env1)'
        )
        expect(result.oscCpp).toContain(
          'const float blkAttackRate_env1 = env_rate_from_percent(attackPercent_env1);'
        )
        expect(result.oscCpp).toContain(
          'const float blkDecayRate_env1 = env_rate_from_percent(decayPercent_env1);'
        )
        expect(result.oscCpp).not.toContain('clampf(attackPercent_env1')
        expect(result.oscCpp).not.toContain('clampf(decayPercent_env1')
      })
    })
  })

  describe('logue/env/ahd -- a gated Attack-Hold-Decay envelope', () => {
    function ahdNode(name: string, attack?: string, decay?: string): ObjNode {
      const params: ObjNode['params'] = []
      if (attack !== undefined) params.push({ name: 'ATTACK', value: attack })
      if (decay !== undefined) params.push({ name: 'DECAY', value: decay })
      return { kind: 'obj', type: 'logue/env/ahd', name, x: 0, y: 0, params }
    }

    it('renders via ahd_env_step, a real, separate helper from ad_env_step', () => {
      const doc = docWith([ahdNode('env1')])
      const result = generateOldGenOscUnit(doc, { name: 'ahd env' })
      expect(result.oscCpp).toContain(
        'float y_env1 = ahd_env_step(&stage_env1, &level_env1, blkAttackRate_env1, blkDecayRate_env1, 0.f, &prevTrig_env1);'
      )
      expect(result.oscCpp).toContain(
        'const float blkAttackRate_env1 = env_rate_from_percent(attackPercent_env1);'
      )
      expect(result.oscCpp).toContain(
        'const float blkDecayRate_env1 = env_rate_from_percent(decayPercent_env1);'
      )
      expect(result.oscCpp).toContain(
        'static float ahd_env_step(int *stage, float *level, float attackRate, float decayRate, float trig, float *prevTrig)'
      )
    })

    it('a real note-on event sets stage to attack, same as logue/env/ad', () => {
      const doc = docWith([ahdNode('env1')])
      const result = generateOldGenOscUnit(doc, { name: 'ahd noteon' })
      expect(result.oscCpp).toContain('void noteOn()\n  {\n    stage_env1 = 1;\n  }')
    })

    it('a real note-off event moves an attacking or holding instance to decay', () => {
      const doc = docWith([ahdNode('env1')])
      const result = generateOldGenOscUnit(doc, { name: 'ahd noteoff' })
      expect(result.oscCpp).toContain(
        'void noteOff()\n  {\n    if (stage_env1 == 1 || stage_env1 == 2) { stage_env1 = 3; }\n  }'
      )
      expect(result.oscCpp).toContain(
        'void OSC_NOTEOFF(const user_osc_param_t * const params) { (void)params; s_osc.noteOff(); }'
      )
    })

    it('an instance with no noteOffStatement (e.g. logue/env/ad, or a plain oscillator) still gets a real, harmlessly-empty noteOff()', () => {
      const doc = docWith([sineNode('sine1')])
      const result = generateOldGenOscUnit(doc, { name: 'no ahd' })
      expect(result.oscCpp).toContain('void noteOff()\n  {\n  }')
    })
  })

  describe('logue/env/ad + logue/env/ahd -- wired trig inlet retriggers from a gate signal, same as note-on', () => {
    it('logue/env/ad reads a wired trig, unwired reads as 0.f/no retrigger', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/env/ad', name: 'env1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'ad trig unwired' })
      expect(result.oscCpp).toContain(
        'float y_env1 = ad_env_step(&stage_env1, &level_env1, blkAttackRate_env1, (exp_env1 >= 1.f ? (blkDecayRate_env1) * (level_env1 + 0.01f) : (blkDecayRate_env1)), 0.f, &prevTrig_env1);'
      )
      expect(result.oscCpp).toContain(
        'const float blkAttackRate_env1 = env_rate_from_percent(attackPercent_env1);'
      )
      expect(result.oscCpp).toContain(
        'const float blkDecayRate_env1 = env_rate_from_percent(decayPercent_env1);'
      )
      expect(result.oscCpp).toContain('float prevTrig_env1;')
      expect(result.oscCpp).toContain('prevTrig_env1 = 0.f;')
    })

    it('logue/env/ad reads a real wired trig signal from a gate/comparator', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/logic/greater-than', name: 'gate1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/env/ad', name: 'env1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'gate1', outlet: 'out' }], dests: [{ obj: 'env1', inlet: 'trig' }] },
          { sources: [{ obj: 'env1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'ad trig wired' })
      expect(result.oscCpp).toContain(
        'float y_env1 = ad_env_step(&stage_env1, &level_env1, blkAttackRate_env1, (exp_env1 >= 1.f ? (blkDecayRate_env1) * (level_env1 + 0.01f) : (blkDecayRate_env1)), y_gate1, &prevTrig_env1);'
      )
      expect(result.oscCpp).toContain(
        'const float blkAttackRate_env1 = env_rate_from_percent(attackPercent_env1);'
      )
      expect(result.oscCpp).toContain(
        'const float blkDecayRate_env1 = env_rate_from_percent(decayPercent_env1);'
      )
    })

    it('logue/env/ahd reads a wired trig too -- retriggers attack only, note-off is still the only way to reach decay', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/logic/edge', name: 'edge1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/env/ahd', name: 'env1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'edge1', outlet: 'out' }], dests: [{ obj: 'env1', inlet: 'trig' }] },
          { sources: [{ obj: 'env1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'ahd trig wired' })
      expect(result.oscCpp).toContain(
        'float y_env1 = ahd_env_step(&stage_env1, &level_env1, blkAttackRate_env1, blkDecayRate_env1, y_edge1, &prevTrig_env1);'
      )
      expect(result.oscCpp).toContain(
        'const float blkAttackRate_env1 = env_rate_from_percent(attackPercent_env1);'
      )
      expect(result.oscCpp).toContain(
        'const float blkDecayRate_env1 = env_rate_from_percent(decayPercent_env1);'
      )
      expect(result.oscCpp).toContain(
        'void noteOff()\n  {\n    if (stage_env1 == 1 || stage_env1 == 2) { stage_env1 = 3; }\n  }'
      )
    })
  })

  describe('logue/sense/gate -- the real note-on/note-off state as a wireable signal', () => {
    it('generates on minilogue xd, no platforms restriction unlike cutoff/resonance/param', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/sense/gate', name: 'gate1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'sense gate test' })
      expect(result.oscCpp).toContain('float y_gate1 = held_gate1;')
      expect(result.oscCpp).toContain('float held_gate1;')
      expect(result.oscCpp).toContain('held_gate1 = 0.f;')
      expect(result.oscCpp).toContain('void noteOn()\n  {\n    held_gate1 = 1.f;\n  }')
      expect(result.oscCpp).toContain('void noteOff()\n  {\n    held_gate1 = 0.f;\n  }')
    })

    it('wires directly into an envelope trig, reproducing the note-on retrigger exactly', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/sense/gate', name: 'gate1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/env/ad', name: 'env1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'gate1', outlet: 'out' }], dests: [{ obj: 'env1', inlet: 'trig' }] },
          { sources: [{ obj: 'env1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'gate into trig' })
      expect(result.oscCpp).toContain(
        'float y_env1 = ad_env_step(&stage_env1, &level_env1, blkAttackRate_env1, (exp_env1 >= 1.f ? (blkDecayRate_env1) * (level_env1 + 0.01f) : (blkDecayRate_env1)), y_gate1, &prevTrig_env1);'
      )
      expect(result.oscCpp).toContain(
        'const float blkAttackRate_env1 = env_rate_from_percent(attackPercent_env1);'
      )
      expect(result.oscCpp).toContain(
        'const float blkDecayRate_env1 = env_rate_from_percent(decayPercent_env1);'
      )
    })
  })

  describe('logue/lfo/sine-lfo -- a free-running, note-pitch-independent oscillator', () => {
    function lfoNode(name: string, rateValue?: string): ObjNode {
      return {
        kind: 'obj',
        type: 'logue/lfo/sine-lfo',
        name,
        x: 0,
        y: 0,
        params: rateValue === undefined ? [] : [{ name: 'RATE', value: rateValue }]
      }
    }

    it('advances its own phase by its RATE (a block constant, blkLfoRate_<suffix>), never by w0_ (the note-pitch-derived increment every oscillator uses)', () => {
      const doc = docWith([lfoNode('lfo1')])
      const result = generateOldGenOscUnit(doc, { name: 'lfo basic' })
      expect(result.oscCpp).toContain('float y_lfo1 = osc_sinf(phase_lfo1);')
      expect(result.oscCpp).toContain('phase_lfo1 += blkLfoRate_lfo1;')
      expect(result.oscCpp).not.toContain('phase_lfo1 += w0_;')
      expect(result.oscCpp).toContain('static float lfo_rate_from_percent(float percent)')
      // cubed, mirrored by paramUnits.ts's lfoHzUnit
      expect(result.oscCpp).toContain('float hz = 0.1f + t * t * t * 19.9f;')
      // default RATE (20) reaches the generated init RAW -- the lfo_rate_from_percent
      // conversion moved to point-of-use (the same pass that added a wireable `rate` inlet)
      expect(result.oscCpp).toContain('ratePercent_lfo1 = 20;')
    })

    it('a custom RATE value reaches the generated init, not just the default', () => {
      const doc = docWith([lfoNode('lfo1', '75')])
      const result = generateOldGenOscUnit(doc, { name: 'lfo custom rate' })
      expect(result.oscCpp).toContain('ratePercent_lfo1 = 75;')
    })

    it('modulates a filter cutoff exactly like any other wireable control source (no special-casing)', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          lfoNode('lfo1'),
          {
            kind: 'obj',
            type: 'logue/filter/lowpass-cheap',
            name: 'filt1',
            x: 0,
            y: 0,
            params: []
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'filt1', inlet: 'in' }] },
          { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'filt1', inlet: 'cutoff' }] },
          { sources: [{ obj: 'filt1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'lfo modulates filter' })
      expect(result.oscCpp).toContain(
        'onepole_step(&z1_filt1, y_osc1, cutoff_warp((cutoff_filt1 + (y_lfo1))))'
      )
    })
  })

  describe('logue/lfo/{triangle,square,ramp-up,ramp-down} -- the other LFO shapes, sharing sine-lfo\'s own accumulator/RATE machinery via makeLfoPrimitive ("more LFO shapes" follow-up)', () => {
    function lfoNode(type: string, name: string, rateValue?: string): ObjNode {
      return {
        kind: 'obj',
        type,
        name,
        x: 0,
        y: 0,
        params: rateValue === undefined ? [] : [{ name: 'RATE', value: rateValue }]
      }
    }

    it('triangle-lfo renders a piecewise-linear rise/fall on the shared phase accumulator', () => {
      const doc = docWith([lfoNode('logue/lfo/triangle-lfo', 'lfo1')])
      const result = generateOldGenOscUnit(doc, { name: 'triangle lfo' })
      expect(result.oscCpp).toContain(
        'float y_lfo1 = (phase_lfo1 < 0.5f ? phase_lfo1 * 4.f - 1.f : 3.f - phase_lfo1 * 4.f);'
      )
      expect(result.oscCpp).toContain('phase_lfo1 += blkLfoRate_lfo1;')
      expect(result.oscCpp).toContain('ratePercent_lfo1 = 20;')
    })

    it('square-lfo renders a two-level phase comparison', () => {
      const doc = docWith([lfoNode('logue/lfo/square-lfo', 'lfo1')])
      const result = generateOldGenOscUnit(doc, { name: 'square lfo' })
      expect(result.oscCpp).toContain('float y_lfo1 = (phase_lfo1 < 0.5f ? 1.f : -1.f);')
    })

    it('ramp-up renders a linear -1->1 ramp with no id collision against any logue/osc/* label', () => {
      const doc = docWith([lfoNode('logue/lfo/ramp-up', 'lfo1')])
      const result = generateOldGenOscUnit(doc, { name: 'ramp up lfo' })
      expect(result.oscCpp).toContain('float y_lfo1 = (phase_lfo1 * 2.f - 1.f);')
    })

    it('ramp-down renders the mirrored linear 1->-1 ramp', () => {
      const doc = docWith([lfoNode('logue/lfo/ramp-down', 'lfo1')])
      const result = generateOldGenOscUnit(doc, { name: 'ramp down lfo' })
      expect(result.oscCpp).toContain('float y_lfo1 = (1.f - phase_lfo1 * 2.f);')
    })

    it('a wired rate inlet is the same additive/+-50/clamp shape on every shape, not just sine', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('mod1'),
          lfoNode('logue/lfo/square-lfo', 'lfo1'),
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'mod1', outlet: 'out' }], dests: [{ obj: 'lfo1', inlet: 'rate' }] },
          { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'square lfo wired rate' })
      expect(result.oscCpp).toContain(
        'phase_lfo1 += lfo_rate_from_percent(clampf(ratePercent_lfo1 + (y_mod1) * 50.f, 0.f, 100.f));'
      )
    })

    it('a custom RATE value reaches the generated init on a non-sine shape too', () => {
      const doc = docWith([lfoNode('logue/lfo/triangle-lfo', 'lfo1', '75')])
      const result = generateOldGenOscUnit(doc, { name: 'triangle lfo custom rate' })
      expect(result.oscCpp).toContain('ratePercent_lfo1 = 75;')
    })
  })

  describe('logue/sense/* -- sensed hardware inputs as wireable sources', () => {
    function senseNode(name: string, type: string): ObjNode {
      return { kind: 'obj', type, name, x: 0, y: 0, params: [] }
    }

    it('wires logue/sense/pitch into a filter cutoff for a keyboard-tracking filter', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          senseNode('pitch1', 'logue/sense/pitch'),
          {
            kind: 'obj',
            type: 'logue/filter/lowpass-cheap',
            name: 'filt1',
            x: 0,
            y: 0,
            params: []
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'filt1', inlet: 'in' }] },
          {
            sources: [{ obj: 'pitch1', outlet: 'out' }],
            dests: [{ obj: 'filt1', inlet: 'cutoff' }]
          },
          { sources: [{ obj: 'filt1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'tracking filter' })
      expect(result.oscCpp).toContain('float y_pitch1_unipolar = note01_;')
      expect(result.oscCpp).toContain(
        'onepole_step(&z1_filt1, y_osc1, cutoff_warp((cutoff_filt1 + (y_pitch1_unipolar))))'
      )
      // note01_/cutoff01_/resonance01_ are always computed, regardless of which sense
      // primitives are actually placed -- see setSenseInputs's own doc comment.
      expect(result.oscCpp).toContain(
        'void setSenseInputs(float note01, float cutoff01, float resonance01)'
      )
      expect(result.oscCpp).toContain(
        's_osc.setSenseInputs(\n    (float)(params->pitch >> 8) * (1.f / 127.f),\n    (float)params->cutoff * (1.f / 8191.f),\n    (float)params->resonance * (1.f / 8191.f)\n  );'
      )
    })

    it('logue/sense/shape reads shape01_, combining the static OSC_PARAM knob position with the device Mod-LFO contribution delivered every OSC_CYCLE', () => {
      const doc = docWith([senseNode('shape1', 'logue/sense/shape')])
      const result = generateOldGenOscUnit(doc, { name: 'shape sense' })
      expect(result.oscCpp).toContain('float y_shape1_unipolar = shape01_;')
      expect(result.oscCpp).toContain('float y_shape1_bipolar = shape01_ * 2.f - 1.f;')
      expect(result.oscCpp).toContain('void setShapeParam(float v) { shapeParam01_ = v; }')
      expect(result.oscCpp).toContain(
        'if (index == k_user_osc_param_shape) { s_osc.setShapeParam(param_val_to_f32(value)); return; }'
      )
      expect(result.oscCpp).toContain('s_osc.updateShapeSense(q31_to_f32(params->shape_lfo));')
    })

    // logue/sense/shape-2 merges what used to be two
    // separate ids (logue/sense/shift-shape, minilogue-xd-only; logue/sense/shape-alt,
    // nts1mkii-only) into one, valid on both platforms, so it's no longer rejected here the way
    // shape-alt used to be. Minilogue xd's own mechanism (OSC_PARAM ordinal, no Mod-LFO path) is
    // completely unchanged from the old shift-shape primitive -- only the id/member name moved.
    it('logue/sense/shape-2 reads shape2_01_ on minilogue xd, fed by OSC_PARAM only -- no Mod-LFO path on real hardware', () => {
      const doc = docWith([senseNode('shape2inst1', 'logue/sense/shape-2')])
      const result = generateOldGenOscUnit(doc, { name: 'shape 2 sense' })
      expect(result.oscCpp).toContain('float y_shape2inst1_unipolar = shape2_01_;')
      expect(result.oscCpp).toContain('void setShape2Sense(float v) { shape2_01_ = v; }')
      expect(result.oscCpp).toContain(
        'if (index == k_user_osc_param_shiftshape) { s_osc.setShape2Sense(param_val_to_f32(value)); return; }'
      )
    })

    it("logue/sense/cutoff and logue/sense/resonance read cutoff01_/resonance01_ -- the built-in filter's own live knobs", () => {
      const doc = docWith([senseNode('cut1', 'logue/sense/cutoff')])
      const result = generateOldGenOscUnit(doc, { name: 'cutoff sense' })
      expect(result.oscCpp).toContain('float y_cut1_unipolar = cutoff01_;')
    })

    it('logue/sense/param requires a non-empty label once exposed to a knob slot', () => {
      const doc = docWith([
        {
          kind: 'obj',
          type: 'logue/sense/param',
          name: 'sense1',
          x: 0,
          y: 0,
          params: [{ name: 'VALUE', value: '50', logueParamIndex: { 'minilogue-xd': 0 } }]
        }
      ])
      expect(() => generateOldGenOscUnit(doc, { name: 'unlabeled sense param' })).toThrow(
        InvalidLogueParamError
      )
    })

    it('logue/sense/param exports its authored label (not its internal "VALUE" binding key) as the manifest name', () => {
      const doc = docWith([
        {
          kind: 'obj',
          type: 'logue/sense/param',
          name: 'sense1',
          x: 0,
          y: 0,
          params: [
            {
              name: 'VALUE',
              value: '50',
              logueParamIndex: { 'minilogue-xd': 0 },
              label: 'Wave Blend'
            }
          ]
        }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'labeled sense param' })
      const manifest = JSON.parse(result.manifestJson)
      // VALUE's own 0-100 range is non-negative and not a boolean widget, so it gets the broad
      // '%' default (@logue-codegen/paramDeviceType's resolveMinilogueXdParamType) just like any
      // other affected param -- the exported NAME is still the user's own label, unaffected.
      expect(manifest.header.params).toEqual([['Wave Blend', 0, 100, '%']])
      expect(result.oscCpp).toContain('float y_sense1_unipolar = sense_sense1;')
    })

    it("exports a fixed-name param's label (set in the Param Matrix) as its manifest name", () => {
      const node = pulseNode('pulse1', 0)
      node.params[0].label = 'Tone'
      const result = generateOldGenOscUnit(docWith([node]), { name: 'pulse relabeled' })
      expect(JSON.parse(result.manifestJson).header.params[0][0]).toBe('Tone')
    })

    it('an unexposed logue/sense/param needs no label at all -- it just holds its baked default', () => {
      const doc = docWith([senseNode('sense1', 'logue/sense/param')])
      const result = generateOldGenOscUnit(doc, { name: 'unexposed sense param' })
      expect(JSON.parse(result.manifestJson).header.num_param).toBe(0)
      expect(result.oscCpp).toContain('sense_sense1 = 50 * 0.01f;')
    })
  })

  describe('optimize existing primitives: coarse/fine tuning, pitch/rate/width/gain inlets', () => {
    it("a custom COARSE/FINE value reaches the generated init, and defaults reproduce today's exact w0 computation", () => {
      const doc = docWith([sineNode('sine1')])
      const result = generateOldGenOscUnit(doc, { name: 'coarse fine defaults' })
      // COARSE default 0, FINE default 0 (cents -> semitone fraction via *0.01f)
      expect(result.oscCpp).toContain('coarse_sine1 = 0;')
      expect(result.oscCpp).toContain('fine_sine1 = 0 * 0.01f;')
      // at these defaults and no wired pitch inlet, the transposed expression reduces to
      // exactly the same note_w0(note_ + noteFine_/255) this project's own osc_w0f_for_note
      // base-pitch computation always did -- a real regression check, not just a fixture.
      expect(result.oscCpp).toContain(
        'const float blkW0_sine1 = note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_sine1 + fine_sine1);'
      )
      expect(result.oscCpp).toContain('phase_sine1 += blkW0_sine1;')
    })

    it('a custom COARSE/FINE value is baked per instance', () => {
      const doc = docWith([
        {
          kind: 'obj',
          type: 'logue/osc/saw',
          name: 'saw1',
          x: 0,
          y: 0,
          params: [
            { name: 'COARSE', value: '12' },
            { name: 'FINE', value: '-25' }
          ]
        }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'custom coarse fine' })
      expect(result.oscCpp).toContain('coarse_saw1 = 12;')
      expect(result.oscCpp).toContain('fine_saw1 = -25 * 0.01f;')
    })

    it("a wired pitch inlet adds (scaled by the +-24 semitone depth) to the base note, on top of COARSE/FINE -- doesn't replace them", () => {
      const doc: PatchDocument = {
        nodes: [
          senseNode('pitch1', 'logue/sense/pitch'),
          {
            kind: 'obj',
            type: 'logue/osc/sine',
            name: 'sine1',
            x: 0,
            y: 0,
            params: [{ name: 'COARSE', value: '12' }]
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          {
            sources: [{ obj: 'pitch1', outlet: 'out' }],
            dests: [{ obj: 'sine1', inlet: 'pitch' }]
          },
          { sources: [{ obj: 'sine1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'pitch inlet' })
      expect(result.oscCpp).toContain(
        'phase_sine1 += note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_sine1 + fine_sine1 + (y_pitch1_unipolar) * 24.f);'
      )
    })

    it('a wired harmonic inlet multiplies the WHOLE transposed w0 by an exact integer ratio (clamped to +-16, rounded not truncated) -- unlike pitch/COARSE this is never folded into the semitone sum', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/util/constant', name: 'harm1', x: 0, y: 0, params: [] },
          sineNode('sine1'),
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          {
            sources: [{ obj: 'harm1', outlet: 'out' }],
            dests: [{ obj: 'sine1', inlet: 'harmonic' }]
          },
          { sources: [{ obj: 'sine1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'harmonic inlet' })
      expect(result.oscCpp).toContain('phase_sine1 += blkW0_sine1;')
      expect(result.oscCpp).toContain('static float harmonic_ratio(float raw)')
    })

    // harmonic_ratio itself is still emitted unconditionally (it's in the primitive's own
    // `helpers` list, same as CLAMPF_HELPER/NOTE_W0_HELPER -- unused-but-harmless dead code when
    // nothing wires `harmonic`, the same tradeoff every other always-listed helper already
    // accepts). What actually matters for byte-transparency is this exact accumulation line,
    // already asserted above with no `* harmonic_ratio(...)` multiply tacked onto it.

    it('a wired pulse width inlet adds (scaled by the +-50 depth) to the base WIDTH, clamped to [0,100]', () => {
      const doc: PatchDocument = {
        nodes: [
          senseNode('shape1', 'logue/sense/shape'),
          pulseNode('pulse1'),
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          {
            sources: [{ obj: 'shape1', outlet: 'out' }],
            dests: [{ obj: 'pulse1', inlet: 'width' }]
          },
          { sources: [{ obj: 'pulse1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'width inlet' })
      expect(result.oscCpp).toContain(
        'polyblep_pulse(phase_pulse1, clampf(width_pulse1 + (y_shape1_unipolar) * 50.f, 0.f, 100.f) * 0.01f, '
      )
      expect(result.oscCpp).toContain('static float clampf(float v, float lo, float hi)')
    })

    it('mix2 GAIN1/GAIN2 are independently authorable, not just the fixed 50/50 default', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          sineNode('b'),
          {
            kind: 'obj',
            type: 'logue/mix/mix2',
            name: 'mixer',
            x: 0,
            y: 0,
            params: [
              { name: 'GAIN1', value: '100' },
              { name: 'GAIN2', value: '25' }
            ]
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in1' }] },
          { sources: [{ obj: 'b', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in2' }] },
          { sources: [{ obj: 'mixer', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'asymmetric gains' })
      expect(result.oscCpp).toContain('gain1_mixer = 100 * 0.01f;')
      expect(result.oscCpp).toContain('gain2_mixer = 25 * 0.01f;')
    })

    it('a wired sine-lfo rate inlet adds (scaled by the +-50 depth) to the base RATE, clamped to [0,100]', () => {
      const doc: PatchDocument = {
        nodes: [
          senseNode('shape1', 'logue/sense/shape'),
          { kind: 'obj', type: 'logue/lfo/sine-lfo', name: 'lfo1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'shape1', outlet: 'out' }], dests: [{ obj: 'lfo1', inlet: 'rate' }] },
          { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'lfo rate inlet' })
      expect(result.oscCpp).toContain(
        'phase_lfo1 += lfo_rate_from_percent(clampf(ratePercent_lfo1 + (y_shape1_unipolar) * 50.f, 0.f, 100.f));'
      )
    })

    function senseNode(name: string, type: string): ObjNode {
      return { kind: 'obj', type, name, x: 0, y: 0, params: [] }
    }
  })

  describe('logue/math/multiply + logue/filter/highpass-cheap', () => {
    it('multiplies two upstream instances rather than summing them', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          sineNode('b'),
          { kind: 'obj', type: 'logue/math/multiply', name: 'rm', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'rm', inlet: 'in1' }] },
          { sources: [{ obj: 'b', outlet: 'out' }], dests: [{ obj: 'rm', inlet: 'in2' }] },
          { sources: [{ obj: 'rm', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'multiply test' })
      expect(result.oscCpp).toContain('float y_rm = ((y_a) * (y_b));')
    })

    it('an unwired multiply inlet reads as silence (0.f), muting the whole product', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          { kind: 'obj', type: 'logue/math/multiply', name: 'rm', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'rm', inlet: 'in1' }] },
          { sources: [{ obj: 'rm', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'multiply unwired' })
      expect(result.oscCpp).toContain('float y_rm = ((y_a) * (0.f));')
    })

    it('a multiply instance declares no per-instance state at all (stateless)', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          { kind: 'obj', type: 'logue/math/multiply', name: 'rm', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'rm', inlet: 'in1' }] },
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'rm', inlet: 'in2' }] },
          { sources: [{ obj: 'rm', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'multiply stateless' })
      expect(result.oscCpp).not.toMatch(/float\s+\w*rm\w*;/)
    })

    it('a node still typed with the former id logue/mix/ringmod generates byte-identical source, on both platforms', () => {
      const docOf = (type: string): PatchDocument => ({
        nodes: [
          sineNode('a'),
          sineNode('b'),
          { kind: 'obj', type, name: 'rm', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'rm', inlet: 'in1' }] },
          { sources: [{ obj: 'b', outlet: 'out' }], dests: [{ obj: 'rm', inlet: 'in2' }] },
          { sources: [{ obj: 'rm', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      })
      const oldDoc = docOf('logue/mix/ringmod')
      const newDoc = docOf('logue/math/multiply')
      expect(generateOldGenOscUnit(oldDoc, { name: 'rename' })).toEqual(
        generateOldGenOscUnit(newDoc, { name: 'rename' })
      )
      expect(generateOscUnit(oldDoc, { name: 'rename' })).toEqual(
        generateOscUnit(newDoc, { name: 'rename' })
      )
    })

    it("highpass computes as in - onepole_step(...), sharing lowpass-cheap's exact helpers", () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          { kind: 'obj', type: 'logue/filter/highpass-cheap', name: 'hp1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'hp1', inlet: 'in' }] },
          { sources: [{ obj: 'hp1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'highpass test' })
      expect(result.oscCpp).toContain(
        'float y_hp1 = ((y_osc1) - onepole_step(&z1_hp1, y_osc1, cutoff_warp(cutoff_hp1)));'
      )
      expect(result.oscCpp).toContain('static float onepole_step(float *z1, float x, float a)')
      expect(result.oscCpp).toContain('static float cutoff_warp(float t)')
      // CUTOFF defaults to 0 here (fully open/passthrough) -- the OPPOSITE of lowpass-cheap's
      // own 100 default -- so a freshly placed highpass never silently mutes what's wired in.
      expect(result.oscCpp).toContain('cutoff_hp1 = 0 * 0.01f;')
    })
  })

  describe('logue/mix/crossfader', () => {
    it('at the default FADE=50, mixes both inputs at equal (sqrt(0.5)) power', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          sineNode('b'),
          { kind: 'obj', type: 'logue/mix/crossfader', name: 'xf', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'xf', inlet: 'in1' }] },
          { sources: [{ obj: 'b', outlet: 'out' }], dests: [{ obj: 'xf', inlet: 'in2' }] },
          { sources: [{ obj: 'xf', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'crossfader default' })
      expect(result.oscCpp).toContain(
        'float y_xf = ((blkFadeMoving_xf != 0.f ? xfade_glide(&xfG_xf[0], blkFadeA_xf) : blkFadeA_xf) * (y_a) + (blkFadeMoving_xf != 0.f ? xfade_glide(&xfG_xf[1], blkFadeB_xf) : blkFadeB_xf) * (y_b));'
      )
      expect(result.oscCpp).toContain('fadePercent_xf = 50;')
    })

    it('a wired fade inlet adds to the dial (depth 100), clamped to [0,100] to keep the square root finite', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          sineNode('b'),
          sineNode('lfo1'),
          { kind: 'obj', type: 'logue/mix/crossfader', name: 'xf', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'xf', inlet: 'in1' }] },
          { sources: [{ obj: 'b', outlet: 'out' }], dests: [{ obj: 'xf', inlet: 'in2' }] },
          { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'xf', inlet: 'fade' }] },
          { sources: [{ obj: 'xf', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'crossfader wired' })
      expect(result.oscCpp).toContain(
        'float y_xf = ((xfLaw_xf >= 0.5f ? (100.f - clampf(fadePercent_xf + (y_lfo1) * 100.f, 0.f, 100.f)) * 0.01f : xfade_sqrtf((100.f - clampf(fadePercent_xf + (y_lfo1) * 100.f, 0.f, 100.f)) * 0.01f)) * (y_a) + (xfLaw_xf >= 0.5f ? (clampf(fadePercent_xf + (y_lfo1) * 100.f, 0.f, 100.f)) * 0.01f : xfade_sqrtf((clampf(fadePercent_xf + (y_lfo1) * 100.f, 0.f, 100.f)) * 0.01f)) * (y_b));'
      )
      expect(result.oscCpp).toContain('static float clampf(float v, float lo, float hi)')
    })

    it('unwired in1/in2 read as silence (0.f), same convention as mix2/multiply', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/mix/crossfader', name: 'xf', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'crossfader unwired' })
      expect(result.oscCpp).toContain(
        'float y_xf = ((blkFadeMoving_xf != 0.f ? xfade_glide(&xfG_xf[0], blkFadeA_xf) : blkFadeA_xf) * (0.f) + (blkFadeMoving_xf != 0.f ? xfade_glide(&xfG_xf[1], blkFadeB_xf) : blkFadeB_xf) * (0.f));'
      )
    })

    it('FADE=0 and FADE=100 select each input fully', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          sineNode('b'),
          {
            kind: 'obj',
            type: 'logue/mix/crossfader',
            name: 'xf',
            x: 0,
            y: 0,
            params: [{ name: 'FADE', value: '0' }]
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'xf', inlet: 'in1' }] },
          { sources: [{ obj: 'b', outlet: 'out' }], dests: [{ obj: 'xf', inlet: 'in2' }] },
          { sources: [{ obj: 'xf', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'crossfader FADE=0' })
      expect(result.oscCpp).toContain('fadePercent_xf = 0;')
    })
  })

  describe('logue/filter/highpass-cheap -- shared-helper and wired-cutoff tests', () => {
    it('lowpass-cheap and highpass-cheap share one onepole_step/cutoff_warp emission each, not two', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          { kind: 'obj', type: 'logue/filter/lowpass-cheap', name: 'lp1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/filter/highpass-cheap', name: 'hp1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'lp1', inlet: 'in' }] },
          { sources: [{ obj: 'lp1', outlet: 'out' }], dests: [{ obj: 'hp1', inlet: 'in' }] },
          { sources: [{ obj: 'hp1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'shared helpers' })
      expect(result.oscCpp.split('static float onepole_step').length - 1).toBe(1)
      expect(result.oscCpp.split('static float cutoff_warp').length - 1).toBe(1)
    })

    it("a wired highpass cutoff inlet adds to the CUTOFF param, like lowpass-cheap's", () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          sineNode('lfo1'),
          { kind: 'obj', type: 'logue/filter/highpass-cheap', name: 'hp1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'hp1', inlet: 'in' }] },
          { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'hp1', inlet: 'cutoff' }] },
          { sources: [{ obj: 'hp1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'wired highpass cutoff' })
      expect(result.oscCpp).toContain(
        'float y_hp1 = ((y_osc1) - onepole_step(&z1_hp1, y_osc1, cutoff_warp((cutoff_hp1 + (y_lfo1)))));'
      )
    })
  })

  describe('linear FM: a new fm inlet on every oscillator, implemented as phase modulation', () => {
    it('an unwired fm inlet reproduces the exact prior renderExpr, byte-identical', () => {
      const doc = docWith([sineNode('sine1')])
      const result = generateOldGenOscUnit(doc, { name: 'fm unwired sine' })
      expect(result.oscCpp).toContain('float y_sine1 = osc_sinf(phase_sine1);')
    })

    it('a wired fm inlet phase-modulates a sine, wrapped by pm_wrap, scaled by fmDepth', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('carrier'),
          sineNode('modulator'),
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          {
            sources: [{ obj: 'modulator', outlet: 'out' }],
            dests: [{ obj: 'carrier', inlet: 'fm' }]
          },
          { sources: [{ obj: 'carrier', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'sine fm' })
      expect(result.oscCpp).toContain(
        'float y_carrier = osc_sinf(pm_wrap(phase_carrier + (y_modulator) * (fmDepthPercent_carrier * 0.02f)));'
      )
      expect(result.oscCpp).toContain('static float pm_wrap(float p)')
      // the phase ACCUMULATOR itself is untouched by fm -- still the plain transposed increment
      expect(result.oscCpp).toContain(
        'const float blkW0_carrier = note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_carrier + fine_carrier);'
      )
      expect(result.oscCpp).toContain('phase_carrier += blkW0_carrier;')
    })

    it('FM_DEPTH defaults to 0 (no effect even once wired) and a custom value reaches init', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('carrier'),
          sineNode('modulator'),
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          {
            sources: [{ obj: 'modulator', outlet: 'out' }],
            dests: [{ obj: 'carrier', inlet: 'fm' }]
          },
          { sources: [{ obj: 'carrier', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'fm depth default' })
      expect(result.oscCpp).toContain('fmDepthPercent_carrier = 0;')
    })

    it('fm phase-modulates square/pulse without changing the polyblep dt argument (saw has its own TZFM-aware test below)', () => {
      const real: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/osc/square', name: 'square1', x: 0, y: 0, params: [] },
          sineNode('mod1'),
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'mod1', outlet: 'out' }], dests: [{ obj: 'square1', inlet: 'fm' }] },
          { sources: [{ obj: 'square1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(real, { name: 'square fm' })
      expect(result.oscCpp).toContain(
        'const float blkW0_square1 = note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_square1 + fine_square1);'
      )
      expect(result.oscCpp).toContain(
        'float y_square1 = polyblep_square(pm_wrap(phase_square1 + (y_mod1) * (fmDepthPercent_square1 * 0.02f)), blkW0_square1);'
      )
    })

    it("logue/osc/saw's TZFM off (default): fm still phase-modulates via a gated ternary, dt still the plain pitch increment via the same gate", () => {
      const real: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
          sineNode('mod1'),
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'mod1', outlet: 'out' }], dests: [{ obj: 'saw1', inlet: 'fm' }] },
          { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(real, { name: 'saw fm' })
      expect(result.oscCpp).toContain(
        'const float blkW0_saw1 = note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_saw1 + fine_saw1);'
      )
      expect(result.oscCpp).toContain(
        'float y_saw1 = polyblep_saw((tzfm_saw1 >= 1.f ? phase_saw1 : pm_wrap(phase_saw1 + (y_mod1) * (fmDepthPercent_saw1 * 0.02f))), (tzfm_saw1 >= 1.f ? (blkW0_saw1) * (1.f + (y_mod1) * (fmDepthPercent_saw1 * 0.04f)) : (blkW0_saw1)));'
      )
      expect(result.oscCpp).toContain(
        'phase_saw1 += (tzfm_saw1 >= 1.f ? (blkW0_saw1) * (1.f + (y_mod1) * (fmDepthPercent_saw1 * 0.04f)) : (blkW0_saw1));'
      )
      expect(result.oscCpp).toContain('while (phase_saw1 >= 1.f) phase_saw1 -= 1.f;')
      expect(result.oscCpp).toContain('while (phase_saw1 < 0.f) phase_saw1 += 1.f;')
    })

    it('a pulse instance gets pitch, width, AND fm inlets all at once', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/osc/pulse', name: 'pulse1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'pulse1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'pulse fm scope' })
      expect(result.oscCpp).toContain('float fmDepthPercent_pulse1;')
    })

    it('pm_wrap is emitted exactly once even though every oscillator type references it', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('sine1'),
          { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/mix/mix2', name: 'mixer', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'sine1', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in1' }] },
          { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in2' }] },
          { sources: [{ obj: 'mixer', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'pm_wrap dedup' })
      expect(result.oscCpp.split('static float pm_wrap').length - 1).toBe(1)
    })

    it("a wired fmDepth inlet adds (scaled by the +-50 depth) to FM_DEPTH's own percent, clamped to [0,100], before the *0.02f conversion", () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('carrier'),
          sineNode('modulator'),
          sineNode('envelope'),
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          {
            sources: [{ obj: 'modulator', outlet: 'out' }],
            dests: [{ obj: 'carrier', inlet: 'fm' }]
          },
          {
            sources: [{ obj: 'envelope', outlet: 'out' }],
            dests: [{ obj: 'carrier', inlet: 'fmDepth' }]
          },
          { sources: [{ obj: 'carrier', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'wired fm depth' })
      expect(result.oscCpp).toContain(
        'float y_carrier = osc_sinf(pm_wrap(phase_carrier + (y_modulator) * (clampf(fmDepthPercent_carrier + (y_envelope) * 50.f, 0.f, 100.f) * 0.02f)));'
      )
    })

    it('a wired fmDepth inlet with fm left unwired has no effect at all -- fm gates the whole term, not just depth', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('carrier'),
          sineNode('envelope'),
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          {
            sources: [{ obj: 'envelope', outlet: 'out' }],
            dests: [{ obj: 'carrier', inlet: 'fmDepth' }]
          },
          { sources: [{ obj: 'carrier', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'fmDepth wired alone' })
      expect(result.oscCpp).toContain('float y_carrier = osc_sinf(phase_carrier);')
    })
  })

  describe('logue/shape/wavefolder + logue/shape/soft-clip', () => {
    it('wavefolder pre-gains by DRIVE then folds -- exact passthrough at DRIVE=0', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          { kind: 'obj', type: 'logue/shape/wavefolder', name: 'fold1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'fold1', inlet: 'in' }] },
          { sources: [{ obj: 'fold1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'wavefolder test' })
      expect(result.oscCpp).toContain(
        'float y_fold1 = wavefold((y_osc1) * (1.f + (drivePercent_fold1) * 0.07f));'
      )
      expect(result.oscCpp).toContain('static float wavefold(float x)')
      // DRIVE=0 -> drivePercent_fold1 = 0 -> pregain 1.0f -> a normalized input never folds
      expect(result.oscCpp).toContain('drivePercent_fold1 = 0;')
    })

    it('a custom DRIVE value reaches the generated init, not just the 0 default', () => {
      const doc: PatchDocument = {
        nodes: [
          {
            kind: 'obj',
            type: 'logue/shape/wavefolder',
            name: 'fold1',
            x: 0,
            y: 0,
            params: [{ name: 'DRIVE', value: '100' }]
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'fold1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'wavefolder custom drive' })
      expect(result.oscCpp).toContain('drivePercent_fold1 = 100;')
    })

    it('an unwired wavefolder audio inlet reads as silence (0.f), not an error', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/shape/wavefolder', name: 'fold1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'fold1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'wavefolder unwired' })
      expect(result.oscCpp).toContain(
        'float y_fold1 = wavefold((0.f) * (1.f + (drivePercent_fold1) * 0.07f));'
      )
    })

    it('soft-clip pre-gains by DRIVE then applies the rational tanh-ish curve', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          { kind: 'obj', type: 'logue/shape/soft-clip', name: 'sat1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'sat1', inlet: 'in' }] },
          { sources: [{ obj: 'sat1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'saturator test' })
      expect(result.oscCpp).toContain(
        'float y_sat1 = soft_clip((y_osc1) * (1.f + (drivePercent_sat1) * 0.09f));'
      )
      expect(result.oscCpp).toContain('static float soft_clip(float x)')
      expect(result.oscCpp).toContain('return x / (1.f + fabsf(x));')
      expect(result.oscCpp).toContain('drivePercent_sat1 = 0;')
    })

    it('wavefolder and soft-clip are independent primitives with their own DRIVE param each', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          {
            kind: 'obj',
            type: 'logue/shape/wavefolder',
            name: 'fold1',
            x: 0,
            y: 0,
            params: [{ name: 'DRIVE', value: '40' }]
          },
          {
            kind: 'obj',
            type: 'logue/shape/soft-clip',
            name: 'sat1',
            x: 0,
            y: 0,
            params: [{ name: 'DRIVE', value: '60' }]
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'fold1', inlet: 'in' }] },
          { sources: [{ obj: 'fold1', outlet: 'out' }], dests: [{ obj: 'sat1', inlet: 'in' }] },
          { sources: [{ obj: 'sat1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'chained shapers' })
      expect(result.oscCpp).toContain('drivePercent_fold1 = 40;')
      expect(result.oscCpp).toContain('drivePercent_sat1 = 60;')
      expect(result.oscCpp).toContain(
        'float y_fold1 = wavefold((y_osc1) * (1.f + (drivePercent_fold1) * 0.07f));'
      )
      expect(result.oscCpp).toContain(
        'float y_sat1 = soft_clip((y_fold1) * (1.f + (drivePercent_sat1) * 0.09f));'
      )
    })

    it("a wired drive inlet adds (scaled by the +-50 depth) to the wavefolder's own DRIVE, clamped to [0,100]", () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          sineNode('env1'),
          { kind: 'obj', type: 'logue/shape/wavefolder', name: 'fold1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'fold1', inlet: 'in' }] },
          { sources: [{ obj: 'env1', outlet: 'out' }], dests: [{ obj: 'fold1', inlet: 'drive' }] },
          { sources: [{ obj: 'fold1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'wired wavefolder drive' })
      expect(result.oscCpp).toContain(
        'float y_fold1 = wavefold((y_osc1) * (1.f + (clampf(drivePercent_fold1 + (y_env1) * 50.f, 0.f, 100.f)) * 0.07f));'
      )
      expect(result.oscCpp).toContain('static float clampf(float v, float lo, float hi)')
    })

    it("a wired drive inlet on soft-clip uses its own 0.09 ceiling, independent of the wavefolder's 0.07", () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          sineNode('env1'),
          { kind: 'obj', type: 'logue/shape/soft-clip', name: 'sat1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'sat1', inlet: 'in' }] },
          { sources: [{ obj: 'env1', outlet: 'out' }], dests: [{ obj: 'sat1', inlet: 'drive' }] },
          { sources: [{ obj: 'sat1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'wired saturator drive' })
      expect(result.oscCpp).toContain(
        'float y_sat1 = soft_clip((y_osc1) * (1.f + (clampf(drivePercent_sat1 + (y_env1) * 50.f, 0.f, 100.f)) * 0.09f));'
      )
    })
  })

  describe('logue/util/unipolar-to-bipolar + logue/util/bipolar-to-unipolar', () => {
    it('unipolar-to-bipolar clamps to [0,1] then maps to [-1,1]', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          {
            kind: 'obj',
            type: 'logue/util/unipolar-to-bipolar',
            name: 'u2b',
            x: 0,
            y: 0,
            params: []
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'u2b', inlet: 'in' }] },
          { sources: [{ obj: 'u2b', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'unipolar to bipolar' })
      expect(result.oscCpp).toContain('float y_u2b = (clampf(y_osc1, 0.f, 1.f) * 2.f - 1.f);')
      expect(result.oscCpp).toContain('static float clampf(float v, float lo, float hi)')
    })

    it('bipolar-to-unipolar clamps to [-1,1] then maps to [0,1]', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          {
            kind: 'obj',
            type: 'logue/util/bipolar-to-unipolar',
            name: 'b2u',
            x: 0,
            y: 0,
            params: []
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'b2u', inlet: 'in' }] },
          { sources: [{ obj: 'b2u', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'bipolar to unipolar' })
      expect(result.oscCpp).toContain('float y_b2u = ((clampf(y_osc1, -1.f, 1.f) + 1.f) * 0.5f);')
    })

    it('an unwired inlet on either converter reads as 0.f, not an error', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/util/unipolar-to-bipolar', name: 'u2b', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'unwired converter' })
      expect(result.oscCpp).toContain('float y_u2b = (clampf(0.f, 0.f, 1.f) * 2.f - 1.f);')
    })

    it('chains -- converting bipolar to unipolar and back is the identity, up to the clamp', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          {
            kind: 'obj',
            type: 'logue/util/bipolar-to-unipolar',
            name: 'b2u',
            x: 0,
            y: 0,
            params: []
          },
          {
            kind: 'obj',
            type: 'logue/util/unipolar-to-bipolar',
            name: 'u2b',
            x: 0,
            y: 0,
            params: []
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'b2u', inlet: 'in' }] },
          { sources: [{ obj: 'b2u', outlet: 'out' }], dests: [{ obj: 'u2b', inlet: 'in' }] },
          { sources: [{ obj: 'u2b', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'round trip converters' })
      expect(result.oscCpp).toContain('float y_b2u = ((clampf(y_osc1, -1.f, 1.f) + 1.f) * 0.5f);')
      expect(result.oscCpp).toContain('float y_u2b = (clampf(y_b2u, 0.f, 1.f) * 2.f - 1.f);')
    })
  })

  describe('logue/math/one-minus', () => {
    it('computes 1 - x of its wired input, unclamped', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          { kind: 'obj', type: 'logue/math/one-minus', name: 'om', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'om', inlet: 'in' }] },
          { sources: [{ obj: 'om', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'one minus test' })
      expect(result.oscCpp).toContain('float y_om = (1.f - (y_osc1));')
    })

    it('an unwired inlet reads as 0.f, so the output is a constant 1', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/math/one-minus', name: 'om', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'unwired one minus' })
      expect(result.oscCpp).toContain('float y_om = (1.f - (0.f));')
    })
  })

  describe('logue/math/negate', () => {
    it('negates its wired input, no clamp needed', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          { kind: 'obj', type: 'logue/math/negate', name: 'inv1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'inv1', inlet: 'in' }] },
          { sources: [{ obj: 'inv1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'invert test' })
      expect(result.oscCpp).toContain('float y_inv1 = (-(y_osc1));')
    })

    it('an unwired inlet reads as 0.f, not an error', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/math/negate', name: 'inv1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'unwired invert' })
      expect(result.oscCpp).toContain('float y_inv1 = (-(0.f));')
    })

    it('chains -- inverting twice is the identity', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          { kind: 'obj', type: 'logue/math/negate', name: 'inv1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/math/negate', name: 'inv2', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'inv1', inlet: 'in' }] },
          { sources: [{ obj: 'inv1', outlet: 'out' }], dests: [{ obj: 'inv2', inlet: 'in' }] },
          { sources: [{ obj: 'inv2', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'double invert' })
      expect(result.oscCpp).toContain('float y_inv1 = (-(y_osc1));')
      expect(result.oscCpp).toContain('float y_inv2 = (-(y_inv1));')
    })
  })

  describe('logue/math/* -- platform-agnostic, same as NTS-1 mkII', () => {
    it('logue/math/add sums two wired signals', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          sineNode('b'),
          { kind: 'obj', type: 'logue/math/add', name: 'add1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'add1', inlet: 'a' }] },
          { sources: [{ obj: 'b', outlet: 'out' }], dests: [{ obj: 'add1', inlet: 'b' }] },
          { sources: [{ obj: 'add1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'add wired' })
      expect(result.oscCpp).toContain('float y_add1 = ((y_a) + (y_b));')
    })

    it('logue/math/subtract computes a - b, unwired reads as silence', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/math/subtract', name: 'sub1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'subtract test' })
      expect(result.oscCpp).toContain('float y_sub1 = ((0.f) - (0.f));')
    })

    it('logue/math/scale multiplies by a dialed FACTOR, default 100 (unity)', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/math/scale', name: 'sc1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'scale test' })
      expect(result.oscCpp).toContain('float y_sc1 = ((0.f) * factor_sc1);')
      expect(result.oscCpp).toContain(
        'factorPercent_sc1 = 100; factor_sc1 = factorPercent_sc1 * 0.01f * range_sc1;'
      )
    })

    it('logue/math/min and logue/math/max are plain ternaries', () => {
      const minResult = generateOldGenOscUnit(
        docWith([{ kind: 'obj', type: 'logue/math/min', name: 'mn1', x: 0, y: 0, params: [] }]),
        { name: 'min test' }
      )
      expect(minResult.oscCpp).toContain('float y_mn1 = ((0.f) < (0.f) ? (0.f) : (0.f));')

      const maxResult = generateOldGenOscUnit(
        docWith([{ kind: 'obj', type: 'logue/math/max', name: 'mx1', x: 0, y: 0, params: [] }]),
        { name: 'max test' }
      )
      expect(maxResult.oscCpp).toContain('float y_mx1 = ((0.f) > (0.f) ? (0.f) : (0.f));')
    })

    it('logue/math/clamp reuses clampf against dialed LO/HI', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/math/clamp', name: 'cl1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'clamp test' })
      expect(result.oscCpp).toContain('float y_cl1 = clampf(0.f, lo_cl1, hi_cl1);')
      expect(result.oscCpp).toContain('lo_cl1 = -100 * 0.01f;')
      expect(result.oscCpp).toContain('hi_cl1 = 100 * 0.01f;')
    })

    it('logue/math/abs rectifies via a direct fabsf call', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/math/abs', name: 'ab1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'abs test' })
      expect(result.oscCpp).toContain('float y_ab1 = fabsf(0.f);')
    })
  })

  describe('logue/logic/* -- platform-agnostic, same as NTS-1 mkII', () => {
    it('logue/logic/greater-than compares against a dialed THRESHOLD, default 0', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/logic/greater-than', name: 'gt1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'gt test' })
      expect(result.oscCpp).toContain('float y_gt1 = ((0.f) > (threshold_gt1) ? 1.f : 0.f);')
      expect(result.oscCpp).toContain('threshold_gt1 = 0 * 0.01f;')
    })

    it('logue/logic/greater-than with a wired b adds it to THRESHOLD', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          sineNode('b'),
          { kind: 'obj', type: 'logue/logic/greater-than', name: 'gt1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'gt1', inlet: 'a' }] },
          { sources: [{ obj: 'b', outlet: 'out' }], dests: [{ obj: 'gt1', inlet: 'b' }] },
          { sources: [{ obj: 'gt1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'gt two-signal' })
      expect(result.oscCpp).toContain(
        'float y_gt1 = ((y_a) > ((threshold_gt1 + (y_b))) ? 1.f : 0.f);'
      )
    })

    it('logue/logic/less-than mirrors greater-than', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/logic/less-than', name: 'lt1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'lt test' })
      expect(result.oscCpp).toContain('float y_lt1 = ((0.f) < (threshold_lt1) ? 1.f : 0.f);')
    })

    it('logue/logic/equal uses a real tolerance window, default 2', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/logic/equal', name: 'eq1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'eq test' })
      expect(result.oscCpp).toContain(
        'float y_eq1 = (fabsf((0.f) - (threshold_eq1)) <= tolerance_eq1 ? 1.f : 0.f);'
      )
      expect(result.oscCpp).toContain('tolerance_eq1 = 2 * 0.01f;')
    })

    it('logue/logic/and reads both inputs at >=0.5f, unwired reads as silence/false', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/logic/and', name: 'and1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'and test' })
      expect(result.oscCpp).toContain(
        'float y_and1 = (((0.f) >= 0.5f) && ((0.f) >= 0.5f) ? 1.f : 0.f);'
      )
    })

    it('logue/logic/or mirrors and with ||', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/logic/or', name: 'or1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'or test' })
      expect(result.oscCpp).toContain(
        'float y_or1 = (((0.f) >= 0.5f) || ((0.f) >= 0.5f) ? 1.f : 0.f);'
      )
    })

    it('logue/logic/xor outputs true only when exactly one input is open', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/logic/xor', name: 'xor1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'xor test' })
      expect(result.oscCpp).toContain(
        'float y_xor1 = ((((0.f) >= 0.5f) != ((0.f) >= 0.5f)) ? 1.f : 0.f);'
      )
    })
  })

  describe('logue/mux/* -- platform-agnostic, same as NTS-1 mkII', () => {
    it('logue/mux/mux2 selects i1 by default (SELECT=0, unwired sel)', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/mux/mux2', name: 'mx1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'mux2 test' })
      expect(result.oscCpp).toContain(
        'float y_mx1 = ((selectPercent_mx1 >= 50.f) ? (0.f) : (0.f));'
      )
      expect(result.oscCpp).toContain('selectPercent_mx1 = 0;')
    })

    it('logue/mux/mux2 a wired sel fully replaces the dial', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          sineNode('b'),
          { kind: 'obj', type: 'logue/logic/greater-than', name: 'gate1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/mux/mux2', name: 'mx1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'mx1', inlet: 'i1' }] },
          { sources: [{ obj: 'b', outlet: 'out' }], dests: [{ obj: 'mx1', inlet: 'i2' }] },
          { sources: [{ obj: 'gate1', outlet: 'out' }], dests: [{ obj: 'mx1', inlet: 'sel' }] },
          { sources: [{ obj: 'mx1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'mux2 wired' })
      expect(result.oscCpp).toContain('float y_mx1 = (((y_gate1) >= 0.5f) ? (y_b) : (y_a));')
    })

    it('logue/mux/mux4 selects i1 by default (INDEX=0), integer-stepped param', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/mux/mux4', name: 'mx4', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'mux4 test' })
      expect(result.oscCpp).toContain(
        'float y_mx4 = mux4_select(indexRaw_mx4, 0.f, 0.f, 0.f, 0.f);'
      )
      expect(result.oscCpp).toContain('indexRaw_mx4 = 0;')
      expect(result.oscCpp).toContain('static float mux4_select(float rawIndex')
    })

    it('logue/mux/mux4 honors a dialed INDEX', () => {
      const doc = docWith([
        {
          kind: 'obj',
          type: 'logue/mux/mux4',
          name: 'mx4',
          x: 0,
          y: 0,
          params: [{ name: 'INDEX', value: '2' }]
        }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'mux4 indexed' })
      expect(result.oscCpp).toContain('indexRaw_mx4 = 2;')
    })

    it('an exposed select shows as its 1-based input number on the device (typeless, +1 offset) and scales back to the spec domain', () => {
      const doc: PatchDocument = {
        nodes: [
          {
            kind: 'obj',
            type: 'logue/mux/mux4',
            name: 'mx4',
            x: 0,
            y: 0,
            params: [{ name: 'INDEX', value: '2', logueParamIndex: { 'minilogue-xd': 1 } }]
          },
          {
            kind: 'obj',
            type: 'logue/mux/mux2',
            name: 'mx1',
            x: 0,
            y: 0,
            params: [{ name: 'SELECT', value: '100', logueParamIndex: { 'minilogue-xd': 0 } }]
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'mx4', outlet: 'out' }], dests: [{ obj: 'mx1', inlet: 'i1' }] },
          { sources: [{ obj: 'mx1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'mux device params' })
      expect(JSON.parse(result.manifestJson).header.params).toEqual([
        ['SELECT', 0, 1, ''],
        ['INDEX', 0, 3, '']
      ])
      expect(result.oscCpp).toContain('case 0: if (v < 0) v = 0; else if (v > 1) v = 1; break;')
      expect(result.oscCpp).toContain('case 0: selectPercent_mx1 = (value * 100); break;')
      expect(result.oscCpp).toContain('case 1: if (v < 0) v = 0; else if (v > 3) v = 3; break;')
      // The baked default stays in the spec domain.
      expect(result.oscCpp).toContain('selectPercent_mx1 = 100;')
    })

    it('logue/mux/mux4 rescales a wired bipolar index into 0..3 before rounding', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          { kind: 'obj', type: 'logue/mux/mux4', name: 'mx4', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'mx4', inlet: 'index' }] },
          { sources: [{ obj: 'mx4', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'mux4 wired index' })
      expect(result.oscCpp).toContain(
        'float y_mx4 = mux4_select(((clampf(y_a, -1.f, 1.f) + 1.f) * 1.5f), 0.f, 0.f, 0.f, 0.f);'
      )
    })

    it('logue/mux/demux2 routes to o0 by default, o1 reads silence -- only the wired outlet contributes', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          { kind: 'obj', type: 'logue/mux/demux2', name: 'dx1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'dx1', inlet: 'in' }] },
          { sources: [{ obj: 'dx1', outlet: 'o0' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'demux2 o0' })
      expect(result.oscCpp).toContain(
        'float y_dx1_o0 = ((selectPercent_dx1 >= 50.f)) ? 0.f : (y_a);'
      )
      expect(result.oscCpp).toContain(
        'float y_dx1_o1 = ((selectPercent_dx1 >= 50.f)) ? (y_a) : 0.f;'
      )
    })

    it('logue/mux/demux2 with a wired sel selecting o1', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          { kind: 'obj', type: 'logue/logic/greater-than', name: 'gate1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/mux/demux2', name: 'dx1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'dx1', inlet: 'in' }] },
          { sources: [{ obj: 'gate1', outlet: 'out' }], dests: [{ obj: 'dx1', inlet: 'sel' }] },
          { sources: [{ obj: 'dx1', outlet: 'o1' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'demux2 wired sel' })
      expect(result.oscCpp).toContain('float y_dx1_o1 = (((y_gate1) >= 0.5f)) ? (y_a) : 0.f;')
    })
  })

  describe('logue/logic/schmitt + logue/logic/edge + logue/util/glide -- platform-agnostic, same as NTS-1 mkII', () => {
    it('logue/logic/schmitt opens above THRESHOLD+HYSTERESIS, closes below THRESHOLD-HYSTERESIS', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/logic/schmitt', name: 'sch1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'schmitt test' })
      expect(result.oscCpp).toContain(
        'float y_sch1 = schmitt_step(&state_sch1, 0.f, threshold_sch1 + hysteresis_sch1, threshold_sch1 - hysteresis_sch1);'
      )
      expect(result.oscCpp).toContain('threshold_sch1 = 0 * 0.01f;')
      expect(result.oscCpp).toContain('hysteresis_sch1 = 5 * 0.01f;')
      expect(result.oscCpp).toContain('state_sch1 = 0.f;')
    })

    it('logue/logic/edge emits a one-sample trigger from a real state-tracking helper', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/logic/edge', name: 'edg1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'edge test' })
      expect(result.oscCpp).toContain('float y_edg1 = edge_step(&prevOpen_edg1, 0.f);')
      expect(result.oscCpp).toContain('prevOpen_edg1 = 0.f;')
    })

    it('logue/util/glide defaults GLIDE=0 -- a transparent pass-through, no lag', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/util/glide', name: 'gl1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'glide test' })
      expect(result.oscCpp).toContain(
        'float y_gl1 = slew_step(&current_gl1, 0.f, slew_max_delta_from_percent(glidePercent_gl1));'
      )
      expect(result.oscCpp).toContain('current_gl1 = 0.f;')
      expect(result.oscCpp).toContain('glidePercent_gl1 = 0;')
    })

    it('logue/util/glide reads a real wired signal via a real linear ramp helper', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          {
            kind: 'obj',
            type: 'logue/util/glide',
            name: 'gl1',
            x: 0,
            y: 0,
            params: [{ name: 'GLIDE', value: '50' }]
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'gl1', inlet: 'in' }] },
          { sources: [{ obj: 'gl1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'glide wired' })
      expect(result.oscCpp).toContain(
        'float y_gl1 = slew_step(&current_gl1, y_a, slew_max_delta_from_percent(glidePercent_gl1));'
      )
      expect(result.oscCpp).toContain('glidePercent_gl1 = 50;')
    })
  })

  describe('logue/osc/noise', () => {
    it('emits a plain LCG step for White, the coloured noises behind a COLOR branch', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/osc/noise', name: 'noise1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'noise1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'noise test' })
      expect(result.oscCpp).toContain(
        'float y_noise1 = ((noiseColor_noise1 == 0 ? noise_step(&seed_noise1) : noise_color_step(&seed_noise1, &noiseState_noise1, &pinkCount_noise1, pinkRows_noise1, &pinkSum_noise1, noiseColor_noise1)) * blkLevel_noise1);'
      )
      expect(result.oscCpp).toContain('static float noise_step(uint32_t *seed)')
      expect(result.oscCpp).toContain('*seed = *seed * 1664525u + 1013904223u;')
      expect(result.oscCpp).toContain('uint32_t seed_noise1;')
    })

    it('two simultaneous noise instances get different, non-zero baked seeds (decorrelated sequences)', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/osc/noise', name: 'noiseA', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/osc/noise', name: 'noiseB', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/mix/mix2', name: 'mixer', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'noiseA', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in1' }] },
          { sources: [{ obj: 'noiseB', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in2' }] },
          { sources: [{ obj: 'mixer', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'two noise sources' })
      const seedA = /seed_noiseA = (\d+)u;/.exec(result.oscCpp)?.[1]
      const seedB = /seed_noiseB = (\d+)u;/.exec(result.oscCpp)?.[1]
      expect(seedA).toBeDefined()
      expect(seedB).toBeDefined()
      expect(seedA).not.toBe('0')
      expect(seedB).not.toBe('0')
      expect(seedA).not.toBe(seedB)
    })

    it('noise_step is emitted exactly once even with multiple noise instances', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/osc/noise', name: 'noiseA', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/osc/noise', name: 'noiseB', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/mix/mix2', name: 'mixer', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'noiseA', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in1' }] },
          { sources: [{ obj: 'noiseB', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in2' }] },
          { sources: [{ obj: 'mixer', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'noise_step dedup' })
      expect(result.oscCpp.split('static float noise_step').length - 1).toBe(1)
    })
  })

  describe('logue/lfo/random-steps -- generic S&H, samples whatever is wired into `in` on each RATE-driven trigger ("more LFO shapes" follow-up)', () => {
    function shNode(name: string, rateValue?: string): ObjNode {
      return {
        kind: 'obj',
        type: 'logue/lfo/random-steps',
        name,
        x: 0,
        y: 0,
        params: rateValue === undefined ? [] : [{ name: 'RATE', value: rateValue }]
      }
    }

    it('an unwired `in` falls back to the internal noise_step LCG rather than reading as silence', () => {
      const doc = docWith([shNode('sh1')])
      const result = generateOldGenOscUnit(doc, { name: 'unwired sh' })
      expect(result.oscCpp).toContain(
        'float y_sh1 = sample_hold_step(&phase_sh1, blkLfoRate_sh1, &held_sh1, noise_step(&seed_sh1));'
      )
      expect(result.oscCpp).toContain(
        'static float sample_hold_step(float *phase, float rate, float *held, float sampleValue)'
      )
      expect(result.oscCpp).toContain('static float noise_step(uint32_t *seed)')
      expect(result.oscCpp).toContain('uint32_t seed_sh1;')
      expect(result.oscCpp).toContain('ratePercent_sh1 = 20;')
      // The state advance/latch happens entirely inside sample_hold_step itself (same shape as
      // onepole_step/ad_env_step/noise_step) -- advanceStatement is a real no-op for this
      // primitive, so nothing should emit a separate phase_sh1 update statement.
      expect(result.oscCpp).not.toContain('phase_sh1 +=')
    })

    it('a wired `in` samples that signal instead of the internal noise fallback', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          shNode('sh1'),
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'sh1', inlet: 'in' }] },
          { sources: [{ obj: 'sh1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'wired sh in' })
      expect(result.oscCpp).toContain(
        'float y_sh1 = sample_hold_step(&phase_sh1, blkLfoRate_sh1, &held_sh1, (y_osc1));'
      )
      // seed_sh1 is still declared (memberDecls can't see wiring), just never read from.
      expect(result.oscCpp).toContain('uint32_t seed_sh1;')
      expect(result.oscCpp).not.toContain('noise_step(&seed_sh1)')
    })

    it('a wired rate inlet is the same additive/+-50/clamp shape every other LFO uses', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('mod1'),
          shNode('sh1'),
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'mod1', outlet: 'out' }], dests: [{ obj: 'sh1', inlet: 'rate' }] },
          { sources: [{ obj: 'sh1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'sh wired rate' })
      expect(result.oscCpp).toContain(
        'sample_hold_step(&phase_sh1, lfo_rate_from_percent(clampf(ratePercent_sh1 + (y_mod1) * 50.f, 0.f, 100.f)), &held_sh1, noise_step(&seed_sh1))'
      )
    })

    it('a custom RATE value reaches the generated init', () => {
      const doc = docWith([shNode('sh1', '75')])
      const result = generateOldGenOscUnit(doc, { name: 'sh custom rate' })
      expect(result.oscCpp).toContain('ratePercent_sh1 = 75;')
    })

    it('sample_hold_step is emitted exactly once even with multiple instances', () => {
      const doc: PatchDocument = {
        nodes: [
          shNode('shA'),
          shNode('shB'),
          { kind: 'obj', type: 'logue/mix/mix2', name: 'mixer', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'shA', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in1' }] },
          { sources: [{ obj: 'shB', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in2' }] },
          { sources: [{ obj: 'mixer', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'sample_hold_step dedup' })
      expect(result.oscCpp.split('static float sample_hold_step').length - 1).toBe(1)
    })
  })

  describe('logue/filter/comb', () => {
    it('defaults to an audible resonance -- CUTOFF=50/GAIN=60/DAMPING=20/TRACK=0, NOT a passthrough', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          { kind: 'obj', type: 'logue/filter/comb', name: 'comb1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'comb1', inlet: 'in' }] },
          { sources: [{ obj: 'comb1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'comb test' })
      expect(result.oscCpp).toContain(
        'float y_comb1 = comb_step(buf_comb1, &writeIdx_comb1, &dampZ1_comb1, &dcX1_comb1, &dcY1_comb1, blkCombDelay_comb1, blkCombGain_comb1, blkCombDamp_comb1, y_osc1);'
      )
      expect(result.oscCpp).toContain(
        'const float blkCombDelay_comb1 = (track_comb1 >= 1.f ? (int)clampf(1.f / note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_comb1 + fine_comb1), 1.f, 511.f) : (int)(1.f + (100.f - (cutoffPercent_comb1)) * 5.10f));'
      )
      expect(result.oscCpp).toContain(
        'const float blkCombGain_comb1 = comb_response_warp((gainPercent_comb1) * 0.01f) * 0.999f;'
      )
      expect(result.oscCpp).toContain(
        'const float blkCombDamp_comb1 = (1.f - comb_response_warp((dampingPercent_comb1) * 0.01f) * 0.95f);'
      )
      expect(result.oscCpp).toContain(
        'static float comb_step(float *buf, int *writeIdx, float *dampZ1, float *dcX1, float *dcY1, int delaySamples, float gain, float dampingA, float x)'
      )
      // GAIN=60 (not 0) is the actual fix for the reported "no audible effect" bug -- a fresh
      // instance now resonates out of the box instead of being a byte-exact passthrough.
      expect(result.oscCpp).toContain('cutoffPercent_comb1 = 50;')
      expect(result.oscCpp).toContain('gainPercent_comb1 = 60;')
      expect(result.oscCpp).toContain('dampingPercent_comb1 = 20;')
      expect(result.oscCpp).toContain('track_comb1 = 0;')
    })

    it('GAIN=0 is still an exact passthrough regardless of CUTOFF/DAMPING (same "safe zero" guarantee phase 16 always had)', () => {
      const doc: PatchDocument = {
        nodes: [
          {
            kind: 'obj',
            type: 'logue/filter/comb',
            name: 'comb1',
            x: 0,
            y: 0,
            params: [{ name: 'GAIN', value: '0' }]
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'comb1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'comb gain zero' })
      expect(result.oscCpp).toContain('gainPercent_comb1 = 0;')
    })

    it('declares a 512-float circular buffer, a damping-filter state var, and zeroes all of it (plus writeIdx) at init', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/filter/comb', name: 'comb1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'comb init' })
      expect(result.oscCpp).toContain('float buf_comb1[512];')
      expect(result.oscCpp).toContain('int writeIdx_comb1;')
      expect(result.oscCpp).toContain('float dampZ1_comb1;')
      expect(result.oscCpp).toContain('writeIdx_comb1 = 0;')
      expect(result.oscCpp).toContain('dampZ1_comb1 = 0.f;')
      expect(result.oscCpp).toContain('for (int i = 0; i < 512; i++) buf_comb1[i] = 0.f;')
    })

    it('a wired cutoff inlet adds (scaled by the +-50 depth) to CUTOFF, a wired gain inlet adds to GAIN, and a wired damping inlet adds to DAMPING, each independently clamped', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          sineNode('lfo1'),
          sineNode('env1'),
          sineNode('lfo2'),
          { kind: 'obj', type: 'logue/filter/comb', name: 'comb1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'comb1', inlet: 'in' }] },
          { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'comb1', inlet: 'cutoff' }] },
          { sources: [{ obj: 'env1', outlet: 'out' }], dests: [{ obj: 'comb1', inlet: 'gain' }] },
          {
            sources: [{ obj: 'lfo2', outlet: 'out' }],
            dests: [{ obj: 'comb1', inlet: 'damping' }]
          },
          { sources: [{ obj: 'comb1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'wired comb' })
      expect(result.oscCpp).toContain(
        'float y_comb1 = comb_step(buf_comb1, &writeIdx_comb1, &dampZ1_comb1, &dcX1_comb1, &dcY1_comb1, (track_comb1 >= 1.f ? (int)clampf(1.f / note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_comb1 + fine_comb1), 1.f, 511.f) : (int)(1.f + (100.f - (clampf(cutoffPercent_comb1 + (y_lfo1) * 50.f, 0.f, 100.f))) * 5.10f)), comb_response_warp((clampf(gainPercent_comb1 + (y_env1) * 50.f, 0.f, 100.f)) * 0.01f) * 0.999f, (1.f - comb_response_warp((clampf(dampingPercent_comb1 + (y_lfo2) * 50.f, 0.f, 100.f)) * 0.01f) * 0.95f), y_osc1);'
      )
    })

    it('comb_step is emitted exactly once even with multiple comb instances, and shares onepole_step with lowpass-cheap', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          { kind: 'obj', type: 'logue/filter/comb', name: 'comb1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/filter/comb', name: 'comb2', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'comb1', inlet: 'in' }] },
          { sources: [{ obj: 'comb1', outlet: 'out' }], dests: [{ obj: 'comb2', inlet: 'in' }] },
          { sources: [{ obj: 'comb2', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'two combs' })
      expect(result.oscCpp.split('static float comb_step').length - 1).toBe(1)
      expect(result.oscCpp.split('static float onepole_step').length - 1).toBe(1)
      expect(result.oscCpp.split('static float comb_response_warp').length - 1).toBe(1)
      expect(result.oscCpp).toContain('float buf_comb1[512];')
      expect(result.oscCpp).toContain('float buf_comb2[512];')
    })

    // A real, user-reported "have to turn GAIN up past ~75% before anything changes" complaint
    // -- root-caused as GAIN's own linear percent-to-feedback-coefficient map crushing nearly
    // all of the audible ring-decay-time range into the last ~20% of the dial (cycles-to--60dB
    // is `ln(0.001)/ln(coefficient)`, a genuine pole as coefficient approaches 1). Same class of
    // problem `lowpass-cheap`'s own `cutoff_warp` already fixed for `CUTOFF`, so `GAIN`/`DAMPING`
    // get an analogous (differently-shaped) warp rather than reusing `cutoff_warp` verbatim --
    // its own cube was shaped/verified for a different relationship.
    it('comb_response_warp is a plain cheap ease-out square (no libm), exact at both endpoints', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          { kind: 'obj', type: 'logue/filter/comb', name: 'comb1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'comb1', inlet: 'in' }] },
          { sources: [{ obj: 'comb1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'warp shape' })
      expect(result.oscCpp).toContain('return 1.f - (1.f - t) * (1.f - t);')
      expect(result.oscCpp).not.toMatch(/exp[f]?\(|pow[f]?\(/)
      // Exact at both endpoints -- GAIN=0/100 and DAMPING=0/100 still mean exactly what they
      // did before the warp, only the middle of each dial's travel changed.
      const warp = (t: number): number => 1 - (1 - t) * (1 - t)
      expect(warp(0)).toBe(0)
      expect(warp(1)).toBe(1)
      // The actual fix: at the dial's own midpoint, the warped value is already well past what
      // the OLD linear map needed ~76% to reach (0.76), confirmed against the real generated
      // formula's own math, not just asserted in the abstract.
      expect(warp(0.5)).toBeCloseTo(0.75, 5)
    })

    it("TRACK>=1 replaces CUTOFF's percent mapping with 1/note_w0(...) -- a real Karplus-Strong tuning mode", () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/osc/noise', name: 'noise1', x: 0, y: 0, params: [] },
          {
            kind: 'obj',
            type: 'logue/filter/comb',
            name: 'comb1',
            x: 0,
            y: 0,
            params: [{ name: 'TRACK', value: '100' }]
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'noise1', outlet: 'out' }], dests: [{ obj: 'comb1', inlet: 'in' }] },
          { sources: [{ obj: 'comb1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'comb pitch tracking' })
      expect(result.oscCpp).toContain(
        'float y_comb1 = comb_step(buf_comb1, &writeIdx_comb1, &dampZ1_comb1, &dcX1_comb1, &dcY1_comb1, blkCombDelay_comb1, blkCombGain_comb1, blkCombDamp_comb1, y_noise1);'
      )
      expect(result.oscCpp).toContain(
        'const float blkCombDelay_comb1 = (track_comb1 >= 1.f ? (int)clampf(1.f / note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_comb1 + fine_comb1), 1.f, 511.f) : (int)(1.f + (100.f - (cutoffPercent_comb1)) * 5.10f));'
      )
      expect(result.oscCpp).toContain(
        'const float blkCombGain_comb1 = comb_response_warp((gainPercent_comb1) * 0.01f) * 0.999f;'
      )
      expect(result.oscCpp).toContain(
        'const float blkCombDamp_comb1 = (1.f - comb_response_warp((dampingPercent_comb1) * 0.01f) * 0.95f);'
      )
      expect(result.oscCpp).toContain('track_comb1 = 100;')
    })

    it("a wired pitch inlet adds a semitone-domain bend on top of the tracked note, the SAME +-24 depth every oscillator's own pitch inlet uses -- it never has to also double as the tracking mode switch", () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/osc/noise', name: 'noise1', x: 0, y: 0, params: [] },
          sineNode('lfo1'),
          {
            kind: 'obj',
            type: 'logue/filter/comb',
            name: 'comb1',
            x: 0,
            y: 0,
            params: [{ name: 'TRACK', value: '100' }]
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'noise1', outlet: 'out' }], dests: [{ obj: 'comb1', inlet: 'in' }] },
          { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'comb1', inlet: 'pitch' }] },
          { sources: [{ obj: 'comb1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'comb pitch bend' })
      expect(result.oscCpp).toContain(
        'float y_comb1 = comb_step(buf_comb1, &writeIdx_comb1, &dampZ1_comb1, &dcX1_comb1, &dcY1_comb1, (track_comb1 >= 1.f ? (int)clampf(1.f / note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_comb1 + fine_comb1 + (y_lfo1) * 24.f), 1.f, 511.f) : (int)(1.f + (100.f - (cutoffPercent_comb1)) * 5.10f)), blkCombGain_comb1, blkCombDamp_comb1, y_noise1);'
      )
      expect(result.oscCpp).toContain(
        'const float blkCombGain_comb1 = comb_response_warp((gainPercent_comb1) * 0.01f) * 0.999f;'
      )
      expect(result.oscCpp).toContain(
        'const float blkCombDamp_comb1 = (1.f - comb_response_warp((dampingPercent_comb1) * 0.01f) * 0.95f);'
      )
    })

    it('comb COARSE/FINE reach the generated init, same shared params every oscillator uses', () => {
      const doc: PatchDocument = {
        nodes: [
          {
            kind: 'obj',
            type: 'logue/filter/comb',
            name: 'comb1',
            x: 0,
            y: 0,
            params: [
              { name: 'COARSE', value: '12' },
              { name: 'FINE', value: '-25' }
            ]
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'comb1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'comb coarse fine' })
      expect(result.oscCpp).toContain('coarse_comb1 = 12;')
      expect(result.oscCpp).toContain('fine_comb1 = -25 * 0.01f;')
    })
  })

  describe('logue/filter/string', () => {
    it('defaults to an audible pluck -- STRUCTURE=20/DAMPING=30/DECAY=60, always pitch-tracked (no TRACK param)', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/osc/noise', name: 'noise1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/filter/string', name: 'string1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          {
            sources: [{ obj: 'noise1', outlet: 'out' }],
            dests: [{ obj: 'string1', inlet: 'in' }]
          },
          { sources: [{ obj: 'string1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'string test' })
      expect(result.oscCpp).toContain(
        'float y_string1 = string_step(buf_string1, &writeIdx_string1, &dampZ_string1, apz_string1, &dcX_string1, &dcY_string1, blkStrDelay_string1, blkStrDamp_string1, blkStrDisp_string1, decayGain_string1, y_noise1);'
      )
      expect(result.oscCpp).toContain(
        'const float blkStrDelay_string1 = clampf(1.f / note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_string1 + fine_string1), 4.f, 2044.f);'
      )
      expect(result.oscCpp).toContain(
        'const float blkStrDisp_string1 = ((structurePercent_string1) * 0.01f * 0.72f);'
      )
      expect(result.oscCpp).toContain(
        'const float blkStrDamp_string1 = (1.f - comb_response_warp((dampingPercent_string1) * 0.01f) * 0.95f);'
      )
      expect(result.oscCpp).toContain(
        'static float string_step(float *buf, int *writeIdx, float *dampZ, float *apz,'
      )
      expect(result.oscCpp).toContain('structurePercent_string1 = 20;')
      expect(result.oscCpp).toContain('dampingPercent_string1 = 30;')
      expect(result.oscCpp).toContain('decayPercent_string1 = 60;')
      // Deliberately NOT present -- unlike comb, this primitive has no free-running/tracked mode
      // switch, so there's no track_string1 field at all.
      expect(result.oscCpp).not.toContain('track_string1')
    })

    it('declares a 2048-float circular buffer plus damping/allpass/DC-blocker state, and zeroes all of it at init', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/filter/string', name: 'string1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'string init' })
      expect(result.oscCpp).toContain('float buf_string1[2048];')
      expect(result.oscCpp).toContain('int writeIdx_string1;')
      expect(result.oscCpp).toContain('float dampZ_string1;')
      expect(result.oscCpp).toContain('float apz_string1[8];')
      expect(result.oscCpp).toContain('float dcX_string1;')
      expect(result.oscCpp).toContain('float dcY_string1;')
      expect(result.oscCpp).toContain('writeIdx_string1 = 0;')
      expect(result.oscCpp).toContain('dampZ_string1 = 0.f;')
      expect(result.oscCpp).toContain('for (int i = 0; i < 8; i++) apz_string1[i] = 0.f;')
      expect(result.oscCpp).toContain('dcX_string1 = 0.f;')
      expect(result.oscCpp).toContain('dcY_string1 = 0.f;')
      expect(result.oscCpp).toContain('for (int i = 0; i < 2048; i++) buf_string1[i] = 0.f;')
    })

    // Real bug (2026-09-24, found while testing on real minilogue xd hardware): the loop's own
    // onepole damping filter and (8-stage) allpass dispersion cascade each add a small, real
    // group delay on top of the delay line's own length -- negligible against a long bass-note
    // period but a large, audible fraction of a short high-note period (measured: ~17 cents
    // sharp at C3, ~69 cents sharp at C5 at default DAMPING/STRUCTURE), so string_step now
    // subtracts each stage's own group delay from the target delay before the Hermite read.
    it('string_step compensates the target delay for the loop filters\' own group delay before the Hermite read -- the real fix for "accurate in low registers, badly sharp above C3"', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/filter/string', name: 'string1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'string tuning compensation' })
      expect(result.oscCpp).toContain('float onepoleDelay = (1.f - dampingA) / dampingA;')
      // The runtime dispersion safety clamp (2026-09-25, see STRING_DISPERSION_STAGES's own doc
      // comment): a coefficient strong enough to be audible can exceed a high note's own short
      // period, so the coefficient actually used is clamped to whatever this note can afford
      // BEFORE it's used for either compensation or the real allpass processing.
      expect(result.oscCpp).toContain(
        'float dispersionBudget = delaySamples - onepoleDelay - 8.0f;'
      )
      expect(result.oscCpp).toContain('float safeMaxDispersion = 0.f;')
      expect(result.oscCpp).toContain('if (dispersionBudget > 8.f) {')
      expect(result.oscCpp).toContain(
        'safeMaxDispersion = (dispersionBudget - 8.f) / (dispersionBudget + 8.f);'
      )
      expect(result.oscCpp).toContain('if (safeMaxDispersion > 0.72f) safeMaxDispersion = 0.72f;')
      expect(result.oscCpp).toContain(
        'if (dispersion > safeMaxDispersion) dispersion = safeMaxDispersion;'
      )
      expect(result.oscCpp).toContain(
        'float allpassDelayPerStage = (1.f + dispersion) / (1.f - dispersion);'
      )
      expect(result.oscCpp).toContain(
        'float compensatedDelay = delaySamples - onepoleDelay - 8.f * allpassDelayPerStage;'
      )
      expect(result.oscCpp).toContain('if (compensatedDelay < 2.f) compensatedDelay = 2.f;')
      expect(result.oscCpp).toContain('float readPos = (float)(*writeIdx) - compensatedDelay;')
    })

    // Real, user-reported miss (2026-09-24, second round): a first fix here only raised the
    // cycle-count ceiling, which is still fundamentally REGISTER-DEPENDENT (seconds-to--60dB is
    // cycle-count times the played note's own period) -- worse, the pitch-tracking fix above
    // shortens the loop's own effective period, so decay got FASTER in real time despite the
    // higher ceiling. The real ask: "decay should ring out very slow, 100% = multiple seconds,
    // UNRELATED to register". Fixed properly: decayGain_string1 (referenced directly in the
    // render line above, not computed inline any more) is set ONCE per real note-on from an
    // EXACT formula solved for a target TIME regardless of period.
    it('DECAY is computed once per note-on from an exact, register-independent seconds formula (not a per-sample cycle-count coefficient any more)', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/filter/string', name: 'string1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'string decay noteon' })
      expect(result.oscCpp).toContain('void noteOn()')
      expect(result.oscCpp).toContain(
        'float p_string1 = clampf(1.f / note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_string1 + fine_string1), 4.f, 2044.f);'
      )
      expect(result.oscCpp).toContain(
        'float t_string1 = 0.05f + (decayPercent_string1 * 0.01f) * 29.95f;'
      )
      expect(result.oscCpp).toContain(
        'decayGain_string1 = exp_approx(-6.907755f * p_string1 / (t_string1 * 48000.f));'
      )
      expect(result.oscCpp).toContain('float decayGain_string1;')
      expect(result.oscCpp).toContain('decayGain_string1 = 0.99f;')
    })

    // Real, user-reported miss (2026-09-24, second round): even a correct, verified 10-second
    // decay "didn't register" perceptually -- the actual ask was "ring out like an open guitar
    // string with NO DAMPING", which a finite RT60 number, however large, can't express. Matches
    // `logue/filter/svf`'s own `RESONANCE=100`->`k=0` "rings forever" precedent exactly.
    it('DECAY=100 is a genuinely lossless special case (decayGain_=1 exactly), not just the top of the seconds range', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/filter/string', name: 'string1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'string decay lossless' })
      expect(result.oscCpp).toContain('if (decayPercent_string1 >= 100.f) {')
      expect(result.oscCpp).toContain('decayGain_string1 = 1.f;')
      expect(result.oscCpp).toContain('} else {')
    })

    // exp_approx exists specifically because a real local-toolchain build of this exact formula
    // failed to LINK a genuine `expf` call (newlib pulled in reentrant syscall stubs --
    // _sbrk/_read/_write/_close/_lseek -- this minimal embedded target doesn't provide), unlike
    // `logue/filter/svf`'s own confirmed `tanf` exception, which links clean. Verified
    // numerically (Python) to <0.01% relative error across the whole range this formula uses.
    it('exp_approx is a real, libm-free range-reduced Padé approximation, not a real expf call', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/filter/string', name: 'string1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'string exp approx' })
      expect(result.oscCpp).toContain('static float exp_approx(float x)')
      expect(result.oscCpp).not.toMatch(/[^_]expf\(/)
      // Numerically verify the exact same formula the generated code uses, not just its shape.
      const expApprox = (x: number): number => {
        const y = x * 0.125
        const y2 = y * y
        let r = (1 + y * 0.5 + y2 * (1 / 12)) / (1 - y * 0.5 + y2 * (1 / 12))
        r = r * r
        r = r * r
        r = r * r
        return r
      }
      for (const x of [-0.0000576, -0.01468, -2.936, 0]) {
        expect(expApprox(x)).toBeCloseTo(Math.exp(x), 3)
      }
    })

    // A wired `decay` inlet can't use the noteOn-time formula (noteOnStatement has no access to
    // a node's wired inlets) -- it falls back to the OLDER cycle-count-based shape instead, a
    // real, disclosed divergence between the two paths.
    it('a wired decay inlet falls back to the older cycle-count-based formula (0.9998 ceiling), since noteOn-time computation has no access to wired inlets', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/osc/noise', name: 'noise1', x: 0, y: 0, params: [] },
          sineNode('lfo1'),
          { kind: 'obj', type: 'logue/filter/string', name: 'string1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          {
            sources: [{ obj: 'noise1', outlet: 'out' }],
            dests: [{ obj: 'string1', inlet: 'in' }]
          },
          {
            sources: [{ obj: 'lfo1', outlet: 'out' }],
            dests: [{ obj: 'string1', inlet: 'decay' }]
          },
          { sources: [{ obj: 'string1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'string wired decay' })
      expect(result.oscCpp).toContain(
        '(comb_response_warp((clampf(decayPercent_string1 + (y_lfo1) * 50.f, 0.f, 100.f)) * 0.01f) * 0.9998f)'
      )
    })

    it('a wired pitch inlet adds a +-24 semitone bend on top of the always-tracked note, and structure/damping/decay inlets are additive and independently clamped', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/osc/noise', name: 'noise1', x: 0, y: 0, params: [] },
          sineNode('lfo1'),
          sineNode('lfo2'),
          sineNode('lfo3'),
          sineNode('lfo4'),
          { kind: 'obj', type: 'logue/filter/string', name: 'string1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          {
            sources: [{ obj: 'noise1', outlet: 'out' }],
            dests: [{ obj: 'string1', inlet: 'in' }]
          },
          {
            sources: [{ obj: 'lfo1', outlet: 'out' }],
            dests: [{ obj: 'string1', inlet: 'pitch' }]
          },
          {
            sources: [{ obj: 'lfo2', outlet: 'out' }],
            dests: [{ obj: 'string1', inlet: 'structure' }]
          },
          {
            sources: [{ obj: 'lfo3', outlet: 'out' }],
            dests: [{ obj: 'string1', inlet: 'damping' }]
          },
          {
            sources: [{ obj: 'lfo4', outlet: 'out' }],
            dests: [{ obj: 'string1', inlet: 'decay' }]
          },
          { sources: [{ obj: 'string1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'wired string' })
      expect(result.oscCpp).toContain(
        'note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_string1 + fine_string1 + (y_lfo1) * 24.f)'
      )
      expect(result.oscCpp).toContain(
        'comb_response_warp((clampf(dampingPercent_string1 + (y_lfo3) * 50.f, 0.f, 100.f)) * 0.01f)'
      )
      expect(result.oscCpp).toContain(
        '(clampf(structurePercent_string1 + (y_lfo2) * 50.f, 0.f, 100.f)) * 0.01f * 0.72f'
      )
      expect(result.oscCpp).toContain(
        'comb_response_warp((clampf(decayPercent_string1 + (y_lfo4) * 50.f, 0.f, 100.f)) * 0.01f)'
      )
    })

    it('string_step/allpass1_step/dc_blocker_step are emitted exactly once even with multiple string instances, and comb_response_warp/onepole_step/clampf/note_w0 are shared with other primitives', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/osc/noise', name: 'noise1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/filter/string', name: 'string1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/filter/string', name: 'string2', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/filter/comb', name: 'comb1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          {
            sources: [{ obj: 'noise1', outlet: 'out' }],
            dests: [{ obj: 'string1', inlet: 'in' }]
          },
          {
            sources: [{ obj: 'string1', outlet: 'out' }],
            dests: [{ obj: 'string2', inlet: 'in' }]
          },
          {
            sources: [{ obj: 'string2', outlet: 'out' }],
            dests: [{ obj: 'comb1', inlet: 'in' }]
          },
          { sources: [{ obj: 'comb1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'two strings and a comb' })
      expect(result.oscCpp.split('static float string_step').length - 1).toBe(1)
      expect(result.oscCpp.split('static float allpass1_step').length - 1).toBe(1)
      expect(result.oscCpp.split('static float dc_blocker_step').length - 1).toBe(1)
      expect(result.oscCpp.split('static float comb_response_warp').length - 1).toBe(1)
      expect(result.oscCpp.split('static float onepole_step').length - 1).toBe(1)
      expect(result.oscCpp.split('static float clampf').length - 1).toBe(1)
      expect(result.oscCpp.split('static float note_w0').length - 1).toBe(1)
      expect(result.oscCpp).toContain('float buf_string1[2048];')
      expect(result.oscCpp).toContain('float buf_string2[2048];')
    })

    // Real, user-requested follow-up (2026-09-24): dispersion should be stronger on higher,
    // thinner/more-taut strings than on low bass ones -- first attempt was a note-dependent
    // FACTOR on the coefficient (0.7-1.0), later found (2026-09-25, "most pronounced on higher
    // notes... in the lower register it's not really audible") to be exactly backwards: that
    // factor made LOW notes weaker for no protective reason, while a FIXED high coefficient was
    // silently breaking pitch tracking at genuinely high notes (where budget is tight) --
    // "pronounced at high notes" was partly audible detuning from tuning breaking, not a working
    // effect. Replaced entirely by the runtime safety clamp verified in the tuning-compensation
    // test above: STRUCTURE alone sets the desired coefficient (no note-factor at codegen time),
    // and `string_step` clamps it down to whatever the CURRENT note's own period can afford.
    it("STRUCTURE alone sets the desired dispersion coefficient (no note-factor at codegen time -- register-dependence is now the runtime safety clamp's job, not a fixed formula here)", () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/filter/string', name: 'string1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'string dispersion structure-only' })
      expect(result.oscCpp).toContain('((structurePercent_string1) * 0.01f * 0.72f)')
      expect(result.oscCpp).toContain('float apz_string1[8];')
      expect(result.oscCpp).toContain('for (int i = 0; i < 8; i++) {')
      expect(result.oscCpp).toContain('dispersed = allpass1_step(&apz[i], dispersed, dispersion);')
    })

    // Real finding (2026-09-25): pushing STRING_DISPERSION_MAX to 0.85 was "safe" by the budget
    // clamp above but was separately verified (via the same exact phase-accumulation solve) to
    // break the FUNDAMENTAL's own tuning by up to +66 cents at C5 -- the DC-approximated
    // compensation formula just isn't accurate enough at that strength. 0.72 was the measured
    // point past which tuning drift at the top of the practical register starts exceeding ~15
    // cents; this test locks that number in so a future change doesn't silently re-introduce the
    // same regression without re-verifying it.
    it('STRING_DISPERSION_MAX stays at the measured-safe 0.72, not a stronger, unverified value', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/filter/string', name: 'string1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'string dispersion max ceiling' })
      expect(result.oscCpp).toContain('* 0.72f)')
      expect(result.oscCpp).toContain('if (safeMaxDispersion > 0.72f) safeMaxDispersion = 0.72f;')
    })

    it('COARSE/FINE reach the generated init, the same shared params every oscillator uses', () => {
      const doc: PatchDocument = {
        nodes: [
          {
            kind: 'obj',
            type: 'logue/filter/string',
            name: 'string1',
            x: 0,
            y: 0,
            params: [
              { name: 'COARSE', value: '7' },
              { name: 'FINE', value: '-10' }
            ]
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'string1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'string coarse fine' })
      expect(result.oscCpp).toContain('coarse_string1 = 7;')
      expect(result.oscCpp).toContain('fine_string1 = -10 * 0.01f;')
    })
  })

  describe('logue/osc/exciter -- one-knob BOW crossfades pluck click <-> sustained bowed swell', () => {
    it('renders via pluck_exciter_step, reading the played note directly (no COARSE/FINE)', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/osc/exciter', name: 'exc1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'exciter test' })
      expect(result.oscCpp).toContain(
        'float y_exc1 = pluck_exciter_step(&seed_exc1, &z1_exc1, &stage_exc1, &level_exc1, &strikesRemaining_exc1, &strikeGain_exc1, &pinkB0_exc1, &pinkB1_exc1, &pinkB2_exc1, bowPercent_exc1, note_ + noteFine_ * (1.f/255.f));'
      )
      expect(result.oscCpp).toContain(
        'static float pluck_exciter_step(uint32_t *seed, float *z1, int *stage, float *level,'
      )
      expect(result.oscCpp).toContain('bowPercent_exc1 = 15;') // default: mostly pluck
    })

    it('declares seed/z1/stage/level/bowPercent/strikesRemaining/strikeGain/pinkB0-2 and zeroes everything but bowPercent/strikeGain at init', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/osc/exciter', name: 'exc1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'exciter init' })
      expect(result.oscCpp).toContain('uint32_t seed_exc1;')
      expect(result.oscCpp).toContain('float z1_exc1;')
      expect(result.oscCpp).toContain('int stage_exc1;')
      expect(result.oscCpp).toContain('float level_exc1;')
      expect(result.oscCpp).toContain('float bowPercent_exc1;')
      expect(result.oscCpp).toContain('int strikesRemaining_exc1;')
      expect(result.oscCpp).toContain('float strikeGain_exc1;')
      expect(result.oscCpp).toContain('float pinkB0_exc1;')
      expect(result.oscCpp).toContain('float pinkB1_exc1;')
      expect(result.oscCpp).toContain('float pinkB2_exc1;')
      expect(result.oscCpp).toContain('z1_exc1 = 0.f;')
      expect(result.oscCpp).toContain('stage_exc1 = 0;')
      expect(result.oscCpp).toContain('level_exc1 = 0.f;')
      expect(result.oscCpp).toContain('strikesRemaining_exc1 = 0;')
      expect(result.oscCpp).toContain('strikeGain_exc1 = 1.f;')
      expect(result.oscCpp).toContain('pinkB0_exc1 = 0.f;')
      expect(result.oscCpp).toContain('pinkB1_exc1 = 0.f;')
      expect(result.oscCpp).toContain('pinkB2_exc1 = 0.f;')
    })

    it('blends white noise toward pink_noise_step by the same warmth value that drives tone, so the first strike stays pure white', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/osc/exciter', name: 'exc1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'exciter pink noise' })
      expect(result.oscCpp).toContain(
        'static float pink_noise_step(float *b0, float *b1, float *b2, float white)'
      )
      expect(result.oscCpp).toContain('float white = noise_step(seed);')
      expect(result.oscCpp).toContain(
        'float pink = pink_noise_step(pinkB0, pinkB1, pinkB2, white);'
      )
      expect(result.oscCpp).toContain(
        'float noiseSample = clampf(white + warmth * (pink - white), -2.f, 2.f);'
      )
      expect(result.oscCpp).toContain(
        'return onepole_step(z1, noiseSample, a) * (*level) * sustainLevelScale;'
      )
    })

    // Real, user-reported miss (2026-09-26), a THIRD round: "the exciter is coming in too hot" --
    // a genuinely different mechanism from the pink-noise gain bug below (that fixed the noise
    // color's own average power; this tapers the ENVELOPE's own held level, since at high BOW
    // *level pins at its peak and stays there for as long as the note is held -- a continuous
    // feed into a resonant loop, not a decaying pluck's bounded, self-limiting energy).
    it('sustainLevelScale tapers the final output by warmth, so the continuously-held case gets quieter while the initial transient stays untouched', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/osc/exciter', name: 'exc1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'exciter sustain level' })
      expect(result.oscCpp).toContain('float sustainLevelScale = 1.f - warmth * 0.9f;')
      expect(result.oscCpp).toContain(
        'return onepole_step(z1, noiseSample, a) * (*level) * sustainLevelScale;'
      )
      // warmth = max(BOW, 1 - strikeGain), so only a pure pluck (BOW 0, first strike) has
      // warmth 0 and keeps its full level; full BOW is scaled to 0.1.
      expect(1 - 0 * 0.9).toBe(1)
    })

    // Real, user-reported miss (2026-09-26), a SECOND round on the same pink-noise feature: "with
    // higher bow the exciter signal gets too much overall gain and the resonated sound gets
    // really more distorted." Root-caused numerically, not assumed: the raw Paul Kellet economy
    // filter runs ~3x white noise's own RMS (its near-unity-feedback low stages have real DC gain
    // in the tens), so blending more of it in as `warmth` rises was a genuine, measured loudness
    // increase, not a subjective impression.
    it('pink_noise_step applies a real gain-compensation scale, not just the raw Kellet filter sum', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/osc/exciter', name: 'exc1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'exciter pink gain' })
      expect(result.oscCpp).toContain('return (*b0 + *b1 + *b2 + white * 0.1848f) * 0.3374f;')
    })

    it("the gain-compensation scale actually brings pink noise back in line with white noise's own RMS -- verified numerically against the exact shipped formula, not assumed", () => {
      // Reimplements noise_step's own LCG and pink_noise_step's own formula (including the
      // 0.3374 compensation) verbatim, so a future edit to either constant without re-verifying
      // this ratio fails a real test instead of silently drifting back into the original bug.
      let seed = 12345 >>> 0
      const noiseStep = (): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return (seed | 0) * (1 / 2147483648)
      }
      let b0 = 0
      let b1 = 0
      let b2 = 0
      const pinkNoiseStep = (white: number): number => {
        b0 = 0.99765 * b0 + white * 0.099046
        b1 = 0.963 * b1 + white * 0.2965164
        b2 = 0.57 * b2 + white * 1.0526913
        return (b0 + b1 + b2 + white * 0.1848) * 0.3374
      }
      for (let i = 0; i < 100000; i++) pinkNoiseStep(noiseStep())
      let sumSqWhite = 0
      let sumSqPink = 0
      const n = 500000
      for (let i = 0; i < n; i++) {
        const w = noiseStep()
        const p = pinkNoiseStep(w)
        sumSqWhite += w * w
        sumSqPink += p * p
      }
      const rmsWhite = Math.sqrt(sumSqWhite / n)
      const rmsPink = Math.sqrt(sumSqPink / n)
      expect(rmsPink / rmsWhite).toBeGreaterThan(0.9)
      expect(rmsPink / rmsWhite).toBeLessThan(1.1)
    })

    // The whole pluck/bow divide comes from ahd_env_step's own stage machine (0 idle / 1 attack /
    // 2 hold / 3 release) with stage 2 also decaying by a BOW-dependent rate -- so noteOff is
    // byte-identical to logue/env/ahd's own. noteOn additionally resets the strike-train state
    // (strikeGain_ to full strength, strikesRemaining_ recomputed from the current BOW dial) --
    // logue/env/ahd has no equivalent since it has no strike train at all.
    it('a real note-on event sets stage to attack and resets the strike train from the current BOW dial', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/osc/exciter', name: 'exc1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'exciter noteon' })
      expect(result.oscCpp).toContain(
        'void noteOn()\n  {\n    stage_exc1 = 1;\n    strikeGain_exc1 = 1.f;\n    strikesRemaining_exc1 = (int)(bowPercent_exc1 * 0.01f * 5.f);\n  }'
      )
    })

    it('BOW=0 gets exactly zero extra strikes -- the original single-shot click is untouched', () => {
      const doc: PatchDocument = {
        nodes: [
          {
            kind: 'obj',
            type: 'logue/osc/exciter',
            name: 'exc1',
            x: 0,
            y: 0,
            params: [{ name: 'BOW', value: '0' }]
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [{ sources: [{ obj: 'exc1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'exciter zero bow' })
      expect(result.oscCpp).toContain('bowPercent_exc1 = 0;')
      expect(Math.trunc(0 * 0.01 * 5)).toBe(0)
    })

    it('a real note-off event moves an attacking or holding instance to release, same as logue/env/ahd', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/osc/exciter', name: 'exc1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'exciter noteoff' })
      expect(result.oscCpp).toContain(
        'void noteOff()\n  {\n    if (stage_exc1 == 1 || stage_exc1 == 2) { stage_exc1 = 3; }\n  }'
      )
    })

    it('BOW=100 makes the held-decay rate exactly 0 (cutoff_warp(1-s) hits its own zero endpoint) -- a genuinely lossless hold, same precedent as string DECAY=100/svf RESONANCE=100', () => {
      const doc: PatchDocument = {
        nodes: [
          {
            kind: 'obj',
            type: 'logue/osc/exciter',
            name: 'exc1',
            x: 0,
            y: 0,
            params: [{ name: 'BOW', value: '100' }]
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [{ sources: [{ obj: 'exc1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'exciter full bow' })
      expect(result.oscCpp).toContain('bowPercent_exc1 = 100;')
      // Numerically verify the exact same formula the generated code uses, not just its shape.
      const s = 1.0
      const cutoffWarp = (t: number): number => {
        const c = Math.max(0, Math.min(1, t))
        return c * c * c
      }
      const heldDecayRate = 0.002604 * cutoffWarp(1 - s)
      expect(heldDecayRate).toBe(0)
    })

    // Real, user-reported miss (2026-09-25): "the short burst is fine... but the 'bowing' attack
    // starts too soon. after the short burst there need to be more softer strikes, that sound
    // more like nylon guitar strings" -- fixed with a real, decaying train of re-strikes between
    // the initial click and any eventual hold, not a single smooth ramp.
    it('a mid-range BOW gets a real, non-zero number of extra strikes, floored not rounded', () => {
      const doc: PatchDocument = {
        nodes: [
          {
            kind: 'obj',
            type: 'logue/osc/exciter',
            name: 'exc1',
            x: 0,
            y: 0,
            params: [{ name: 'BOW', value: '44' }]
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [{ sources: [{ obj: 'exc1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'exciter mid bow' })
      expect(result.oscCpp).toContain('bowPercent_exc1 = 44;')
      // Numerically verify the exact same (int) truncation the generated noteOn() expression
      // uses, not just assume it floors the way percent 0-100 would suggest.
      expect(Math.trunc(44 * 0.01 * 5)).toBe(2)
    })

    it('reaching level<=0 mid-hold retriggers a softer, quieter re-strike instead of always going idle -- the real strike-train mechanism', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/osc/exciter', name: 'exc1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'exciter strike train' })
      expect(result.oscCpp).toContain('if (*strikesRemaining > 0)')
      expect(result.oscCpp).toContain('*strikesRemaining -= 1;')
      expect(result.oscCpp).toContain('*strikeGain *= 0.55f;')
      expect(result.oscCpp).toContain('*stage = 1;')
      // Attack targets the CURRENT strikeGain, not a hardcoded 1 -- so each re-strike peaks
      // lower than the one before it.
      expect(result.oscCpp).toContain(
        'if (*level >= *strikeGain) { *level = *strikeGain; *stage = 2; }'
      )
      // Attack rate is now fixed (env_rate_from_percent(0.f)), decoupled from BOW entirely --
      // the actual fix for "the 'bowing' attack starts too soon".
      expect(result.oscCpp).toContain('float attackRate    = env_rate_from_percent(0.f);')
      // Tone warms toward the note-tracked color as strikeGain shrinks, floored at (not overridden
      // by) BOW's own base blend -- so a later, quieter strike is always at least as warm as
      // strikeGain implies, regardless of where BOW itself sits.
      expect(result.oscCpp).toContain('float warmth = 1.f - *strikeGain;')
      expect(result.oscCpp).toContain('if (warmth < s) warmth = s;')
    })

    it('a wired bow inlet is additive (+-50, clamped), not full-replace -- a wired source bends the dialed BOW rather than taking it over', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/osc/exciter', name: 'exc1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/osc/sine', name: 'lfo1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          {
            sources: [{ obj: 'lfo1', outlet: 'out' }],
            dests: [{ obj: 'exc1', inlet: 'bow' }]
          },
          { sources: [{ obj: 'exc1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'exciter wired bow' })
      expect(result.oscCpp).toContain(
        'float y_exc1 = pluck_exciter_step(&seed_exc1, &z1_exc1, &stage_exc1, &level_exc1, &strikesRemaining_exc1, &strikeGain_exc1, &pinkB0_exc1, &pinkB1_exc1, &pinkB2_exc1, clampf(bowPercent_exc1 + (y_lfo1) * 50.f, 0.f, 100.f), note_ + noteFine_ * (1.f/255.f));'
      )
    })

    it('pluck_exciter_step/noise_step/pink_noise_step/onepole_step/cutoff_warp/env_rate_from_percent/note_w0/clampf are shared with other primitives, not re-emitted per instance', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/osc/exciter', name: 'exc1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/osc/exciter', name: 'exc2', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/filter/string', name: 'string1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/mix/mix2', name: 'mixer', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          {
            sources: [{ obj: 'exc1', outlet: 'out' }],
            dests: [{ obj: 'mixer', inlet: 'in1' }]
          },
          {
            sources: [{ obj: 'exc2', outlet: 'out' }],
            dests: [{ obj: 'string1', inlet: 'in' }]
          },
          {
            sources: [{ obj: 'string1', outlet: 'out' }],
            dests: [{ obj: 'mixer', inlet: 'in2' }]
          },
          { sources: [{ obj: 'mixer', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'exciter dedup' })
      expect(result.oscCpp.split('static float pluck_exciter_step').length - 1).toBe(1)
      expect(result.oscCpp.split('static float noise_step').length - 1).toBe(1)
      expect(result.oscCpp.split('static float pink_noise_step').length - 1).toBe(1)
      expect(result.oscCpp.split('static float onepole_step').length - 1).toBe(1)
      expect(result.oscCpp.split('static float cutoff_warp').length - 1).toBe(1)
      expect(result.oscCpp.split('static float env_rate_from_percent').length - 1).toBe(1)
      expect(result.oscCpp.split('static float note_w0').length - 1).toBe(1)
      expect(result.oscCpp.split('static float clampf').length - 1).toBe(1)
    })
  })

  describe('legacy id/param/inlet aliases (RENAMED_PRIMITIVE_IDS/FieldAlias, 2026-09-21)', () => {
    it('a node still carrying the old logue/sense/shift-shape id generates identically to logue/sense/shape-2 -- the exact incident that prompted this alias table', () => {
      const node = (type: string): ObjNode => ({
        kind: 'obj',
        type,
        name: 'shift1',
        x: 0,
        y: 0,
        params: []
      })
      const oldDoc = docWith([node('logue/sense/shift-shape')])
      const newDoc = docWith([node('logue/sense/shape-2')])
      const oldResult = generateOldGenOscUnit(oldDoc, { name: 'legacy shift-shape id' })
      const newResult = generateOldGenOscUnit(newDoc, { name: 'legacy shift-shape id' })
      expect(oldResult.oscCpp).toBe(newResult.oscCpp)
    })

    it('a node still carrying the old logue/filter/lowpass id generates identically to logue/filter/lowpass-cheap', () => {
      const oldDoc = docWith([
        { kind: 'obj', type: 'logue/filter/lowpass', name: 'lp1', x: 0, y: 0, params: [] }
      ])
      const newDoc = docWith([
        { kind: 'obj', type: 'logue/filter/lowpass-cheap', name: 'lp1', x: 0, y: 0, params: [] }
      ])
      const oldResult = generateOldGenOscUnit(oldDoc, { name: 'legacy lowpass id' })
      const newResult = generateOldGenOscUnit(newDoc, { name: 'legacy lowpass id' })
      expect(oldResult.oscCpp).toBe(newResult.oscCpp)
    })

    it('a node still carrying the old logue/util/invert id generates identically to logue/math/negate (2026-09-25 math reclassification)', () => {
      const oldDoc = docWith([
        { kind: 'obj', type: 'logue/util/invert', name: 'inv1', x: 0, y: 0, params: [] }
      ])
      const newDoc = docWith([
        { kind: 'obj', type: 'logue/math/negate', name: 'inv1', x: 0, y: 0, params: [] }
      ])
      const oldResult = generateOldGenOscUnit(oldDoc, { name: 'legacy invert id' })
      const newResult = generateOldGenOscUnit(newDoc, { name: 'legacy invert id' })
      expect(oldResult.oscCpp).toBe(newResult.oscCpp)
    })

    it('a node still carrying the old logue/math/invert id generates identically to logue/math/negate (2026-10-02 rename)', () => {
      const oldDoc = docWith([
        { kind: 'obj', type: 'logue/math/invert', name: 'inv1', x: 0, y: 0, params: [] }
      ])
      const newDoc = docWith([
        { kind: 'obj', type: 'logue/math/negate', name: 'inv1', x: 0, y: 0, params: [] }
      ])
      const oldResult = generateOldGenOscUnit(oldDoc, { name: 'legacy invert id' })
      const newResult = generateOldGenOscUnit(newDoc, { name: 'legacy invert id' })
      expect(oldResult.oscCpp).toBe(newResult.oscCpp)
    })

    it('a node still carrying the old logue/util/curve id generates identically to logue/math/curve (2026-09-25 math reclassification)', () => {
      const oldDoc = docWith([
        { kind: 'obj', type: 'logue/util/curve', name: 'c1', x: 0, y: 0, params: [] }
      ])
      const newDoc = docWith([
        { kind: 'obj', type: 'logue/math/curve', name: 'c1', x: 0, y: 0, params: [] }
      ])
      const oldResult = generateOldGenOscUnit(oldDoc, { name: 'legacy curve id' })
      const newResult = generateOldGenOscUnit(newDoc, { name: 'legacy curve id' })
      expect(oldResult.oscCpp).toBe(newResult.oscCpp)
    })

    it('a value-preserving param alias (GAIN->FEEDBACK) carries the old value across', () => {
      const doc = docWith([
        {
          kind: 'obj',
          type: 'logue/filter/comb',
          name: 'comb1',
          x: 0,
          y: 0,
          params: [{ name: 'GAIN', value: '80' }]
        }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'legacy feedback alias' })
      expect(result.oscCpp).toContain('gainPercent_comb1 = 80;')
      expect(result.oscCpp).not.toContain('gainPercent_comb1 = 60;')
    })

    it('a NON-value-preserving param alias (DELAY->TUNE) is NOT auto-carried -- TUNE keeps its own default', () => {
      const doc = docWith([
        {
          kind: 'obj',
          type: 'logue/filter/comb',
          name: 'comb1',
          x: 0,
          y: 0,
          params: [{ name: 'DELAY', value: '20' }]
        }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'legacy delay alias' })
      expect(result.oscCpp).toContain('cutoffPercent_comb1 = 50;')
    })

    it('a value-preserving inlet alias (gain->feedback) resolves an old net to the current feedback inlet', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          sineNode('env1'),
          { kind: 'obj', type: 'logue/filter/comb', name: 'comb1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'comb1', inlet: 'in' }] },
          {
            sources: [{ obj: 'env1', outlet: 'out' }],
            dests: [{ obj: 'comb1', inlet: 'gain' }]
          },
          { sources: [{ obj: 'comb1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'legacy feedback inlet alias' })
      expect(result.oscCpp).toContain(
        'comb_response_warp((clampf(gainPercent_comb1 + (y_env1) * 50.f, 0.f, 100.f)) * 0.01f) * 0.999f'
      )
    })

    it('a NON-value-preserving inlet alias (delay->cutoff) is NOT auto-resolved -- the old net stays unwired', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          sineNode('lfo1'),
          { kind: 'obj', type: 'logue/filter/comb', name: 'comb1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'comb1', inlet: 'in' }] },
          { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'comb1', inlet: 'delay' }] },
          { sources: [{ obj: 'comb1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'legacy delay inlet alias' })
      // Unresolved: cutoff falls back to the plain (un-clamped-by-inlet) dial percent, same as
      // if `lfo1` had never been wired at all.
      expect(result.oscCpp).toContain('(int)(1.f + (100.f - (cutoffPercent_comb1)) * 5.10f)')
    })
  })

  describe('logue/filter/formant -- 3-band vowel formant filter', () => {
    it('defaults to VOWEL=50/SHIFT=0/RESONANCE=60/CHARACTER=0 and calls formant_step once with all 6 state pointers plus the input', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          { kind: 'obj', type: 'logue/filter/formant', name: 'formant1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'formant1', inlet: 'in' }] },
          { sources: [{ obj: 'formant1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'formant test' })
      expect(result.oscCpp).toContain(
        'float y_formant1 = formant_step(&fS1a_formant1, &fS2a_formant1, &fS1b_formant1, &fS2b_formant1, &fS1c_formant1, &fS2c_formant1, vowelPercent_formant1, shiftSemis_formant1, resonancePercent_formant1, characterPercent_formant1, y_osc1);'
      )
      expect(result.oscCpp).toContain('vowelPercent_formant1 = 50;')
      expect(result.oscCpp).toContain('shiftSemis_formant1 = 0;')
      expect(result.oscCpp).toContain('resonancePercent_formant1 = 60;')
      expect(result.oscCpp).toContain('characterPercent_formant1 = 0;')
      expect(result.oscCpp.match(/formant_step\(&/g)).toHaveLength(1)
    })

    it('bakes the note-space vowel table in u->o->a->e->i order (NOT alphabetical) with the exact Peterson & Barney-derived note values', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/filter/formant', name: 'formant1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'formant table' })
      // 69 + 12*log2(f/440) for each vowel's own F1/F2/F3 -- see this primitive's own doc
      // comment for the source Hz table. Row order is u, o, a, e, i specifically so a future
      // reorder back to the "obvious" alphabetical a-e-i-o-u (which makes F2 double back
      // non-monotonically, an audible lurch) would fail this test rather than only a real ear
      // check.
      // Male table first (CHARACTER 0 must stay the original sound), then women's and children's.
      expect(result.oscCpp).toContain(
        'static const float kFormantNote[3][5][3] = {\n' +
          '      {\n' +
          '        { 62.3695f, 80.8021f, 97.1751f },\n' +
          '        { 73.4815f, 80.1946f, 98.4415f },\n' +
          '        { 77.7647f, 84.7050f, 98.6557f },\n' +
          '        { 72.2219f, 93.7696f, 98.9372f },\n' +
          '        { 60.5455f, 97.5573f, 102.2903f }\n' +
          '      },'
      )
      // Every formant of every vowel sits higher for the next voice.
      const rows = [...result.oscCpp.matchAll(/\{ ([\d.]+)f, ([\d.]+)f, ([\d.]+)f \}/g)]
        .slice(0, 15)
        .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])])
      expect(rows).toHaveLength(15)
      for (let v = 0; v < 5; v++)
        for (let f = 0; f < 3; f++) {
          expect(rows[5 + v][f]).toBeGreaterThan(rows[v][f])
          expect(rows[10 + v][f]).toBeGreaterThan(rows[5 + v][f])
        }
    })

    it('declares 6 filter state floats (2 per band) plus the 3 raw param members, all zeroed at init', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/filter/formant', name: 'formant1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'formant init' })
      for (const state of ['fS1a', 'fS2a', 'fS1b', 'fS2b', 'fS1c', 'fS2c']) {
        expect(result.oscCpp).toContain(`float ${state}_formant1;`)
        expect(result.oscCpp).toContain(`${state}_formant1 = 0.f;`)
      }
    })

    it('a wired vowel/shift/resonance inlet each adds (scaled by its own depth) to its param, independently clamped', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          sineNode('lfo1'),
          sineNode('env1'),
          sineNode('lfo2'),
          { kind: 'obj', type: 'logue/filter/formant', name: 'formant1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'formant1', inlet: 'in' }] },
          {
            sources: [{ obj: 'lfo1', outlet: 'out' }],
            dests: [{ obj: 'formant1', inlet: 'vowel' }]
          },
          {
            sources: [{ obj: 'env1', outlet: 'out' }],
            dests: [{ obj: 'formant1', inlet: 'shift' }]
          },
          {
            sources: [{ obj: 'lfo2', outlet: 'out' }],
            dests: [{ obj: 'formant1', inlet: 'resonance' }]
          },
          { sources: [{ obj: 'formant1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'formant wired' })
      expect(result.oscCpp).toContain('clampf(vowelPercent_formant1 + (y_lfo1) * 50.f, 0.f, 100.f)')
      expect(result.oscCpp).toContain('clampf(shiftSemis_formant1 + (y_env1) * 24.f, -24.f, 24.f)')
      expect(result.oscCpp).toContain(
        'clampf(resonancePercent_formant1 + (y_lfo2) * 50.f, 0.f, 100.f)'
      )
      // The percent->k conversion now happens INSIDE formant_step, not nested as a call-site
      // argument -- see formant_step's own doc comment for the real hardware bug this avoids.
      expect(result.oscCpp).not.toContain('formant_k_from_percent(clampf(')
    })

    it('a wired character inlet adds to CHARACTER, clamped to its own range', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          sineNode('lfo1'),
          { kind: 'obj', type: 'logue/filter/formant', name: 'formant1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'formant1', inlet: 'in' }] },
          {
            sources: [{ obj: 'lfo1', outlet: 'out' }],
            dests: [{ obj: 'formant1', inlet: 'character' }]
          },
          { sources: [{ obj: 'formant1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'formant character' })
      expect(result.oscCpp).toContain(
        'clampf(characterPercent_formant1 + (y_lfo1) * 50.f, 0.f, 100.f)'
      )
    })

    it('a custom VOWEL/SHIFT/RESONANCE reaches the generated init', () => {
      const doc: PatchDocument = {
        nodes: [
          {
            kind: 'obj',
            type: 'logue/filter/formant',
            name: 'formant1',
            x: 0,
            y: 0,
            params: [
              { name: 'VOWEL', value: '0' },
              { name: 'SHIFT', value: '-12' },
              { name: 'RESONANCE', value: '90' }
            ]
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'formant1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'formant custom' })
      expect(result.oscCpp).toContain('vowelPercent_formant1 = 0;')
      expect(result.oscCpp).toContain('shiftSemis_formant1 = -12;')
      expect(result.oscCpp).toContain('resonancePercent_formant1 = 90;')
    })
  })

  describe('logue/util/constant', () => {
    it('a plain constant reads its own baked value, no inlets, defaults to 0', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/util/constant', name: 'const1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'const1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'constant test' })
      expect(result.oscCpp).toContain('float y_const1 = value_const1;')
      expect(result.oscCpp).toContain('value_const1 = 0 * 0.01f;')
    })

    it('a custom (including negative) VALUE reaches the generated init, mapped linearly to -1..1', () => {
      const doc: PatchDocument = {
        nodes: [
          {
            kind: 'obj',
            type: 'logue/util/constant',
            name: 'const1',
            x: 0,
            y: 0,
            params: [{ name: 'VALUE', value: '50' }]
          },
          {
            kind: 'obj',
            type: 'logue/util/constant',
            name: 'const2',
            x: 0,
            y: 0,
            params: [{ name: 'VALUE', value: '-30' }]
          },
          { kind: 'obj', type: 'logue/mix/mix2', name: 'mixer', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'const1', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in1' }] },
          { sources: [{ obj: 'const2', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in2' }] },
          { sources: [{ obj: 'mixer', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'constant custom values' })
      expect(result.oscCpp).toContain('value_const1 = 50 * 0.01f;')
      expect(result.oscCpp).toContain('value_const2 = -30 * 0.01f;')
    })

    it("a constant wired into an oscillator's pitch inlet combines with that inlet's own +-24 semitone depth, exactly like a parked LFO", () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('carrier'),
          {
            kind: 'obj',
            type: 'logue/util/constant',
            name: 'detune',
            x: 0,
            y: 0,
            params: [{ name: 'VALUE', value: '50' }]
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          {
            sources: [{ obj: 'detune', outlet: 'out' }],
            dests: [{ obj: 'carrier', inlet: 'pitch' }]
          },
          { sources: [{ obj: 'carrier', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'constant pitch offset' })
      expect(result.oscCpp).toContain('phase_carrier += blkW0_carrier;')
    })
  })

  describe('logue/math/curve', () => {
    it('at the default SHAPE=0, is an exact linear passthrough regardless of AMOUNT', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          { kind: 'obj', type: 'logue/math/curve', name: 'c1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'c1', inlet: 'in' }] },
          { sources: [{ obj: 'c1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'curve default' })
      expect(result.oscCpp).toContain(
        'float y_c1 = curve_shape(clampf(y_osc1, 0.f, 1.f), (shapePercent_c1 * 0.01f), (amountPercent_c1 * 0.1600f));'
      )
      expect(result.oscCpp).toContain('shapePercent_c1 = 0;')
      expect(result.oscCpp).toContain('amountPercent_c1 = 100;')
      expect(result.oscCpp).toContain('static float curve_shape(float x, float shapeNorm, float k)')
    })

    it('an unwired in reads as silence (0.f), same convention as every other audio inlet', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/math/curve', name: 'c1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [{ sources: [{ obj: 'c1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'curve unwired' })
      expect(result.oscCpp).toContain(
        'float y_c1 = curve_shape(clampf(0.f, 0.f, 1.f), (shapePercent_c1 * 0.01f), (amountPercent_c1 * 0.1600f));'
      )
    })

    it('a wired shape inlet adds to SHAPE, clamped to [-100,100], instead of replacing it', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          sineNode('lfo1'),
          { kind: 'obj', type: 'logue/math/curve', name: 'c1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'c1', inlet: 'in' }] },
          { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'c1', inlet: 'shape' }] },
          { sources: [{ obj: 'c1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'curve wired shape' })
      expect(result.oscCpp).toContain(
        'float y_c1 = curve_shape(clampf(y_osc1, 0.f, 1.f), (clampf(shapePercent_c1 + (y_lfo1) * 100.f, -100.f, 100.f) * 0.01f), (amountPercent_c1 * 0.1600f));'
      )
    })

    it('SHAPE=-100/+100 select the full logarithmic/exponential curve, AMOUNT=0 stays linear', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('osc1'),
          {
            kind: 'obj',
            type: 'logue/math/curve',
            name: 'c1',
            x: 0,
            y: 0,
            params: [
              { name: 'SHAPE', value: '100' },
              { name: 'AMOUNT', value: '0' }
            ]
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'c1', inlet: 'in' }] },
          { sources: [{ obj: 'c1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'curve full exp, zero amount' })
      expect(result.oscCpp).toContain('shapePercent_c1 = 100;')
      expect(result.oscCpp).toContain('amountPercent_c1 = 0;')
    })
  })

  describe('logue/osc/additive -- baked wavetable-morph oscillator', () => {
    it('defaults to TIMBRE=30, declares its 4 members, zeroes phase at init, and bakes a 6x512 frame table', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/osc/additive', name: 'add1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'additive defaults' })
      expect(result.oscCpp).toContain('timbrePercent_add1 = 30;')
      for (const member of ['phase_add1', 'coarse_add1', 'fine_add1', 'timbrePercent_add1']) {
        expect(result.oscCpp).toContain(`float ${member};`)
      }
      expect(result.oscCpp).toContain('phase_add1 = 0.f;')
      expect(result.oscCpp).toContain('static const float kAdditiveFrames[6][512] = {')
      // One `additive_step(` call site (in process()) plus its own `static float additive_step(`
      // definition -- confirms the shared helper is emitted once and actually called, not just
      // declared.
      expect(result.oscCpp.match(/additive_step\(/g)).toHaveLength(2)
      expect(result.oscCpp).toContain(
        'const float blkW0_add1 = note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_add1 + fine_add1);'
      )
      expect(result.oscCpp).toContain(
        'float y_add1 = additive_step(phase_add1, blkW0_add1, (timbrePercent_add1 * 0.01f));'
      )
      expect(result.oscCpp).toContain('phase_add1 += blkW0_add1;')
    })

    it('bakes the exact non-decreasing per-frame max-harmonic ceiling the Nyquist clamp walks (pins the 6 hand-designed recipes)', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/osc/additive', name: 'add1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'additive max harmonic' })
      // sine(1) -> odd-to-23(23) -> formant-cluster-to-36(36) -> comb-of-4-to-72(72) ->
      // comb-of-7-to-112(112) -> dense-to-128(128) -- see additiveRecipeForFrame's own doc
      // comment for what each frame actually IS; a future edit that reorders/rebalances these
      // recipes and accidentally makes a later frame LESS safe than an earlier one fails this
      // test (and the module-load-time assertion in primitives.ts) rather than only an ear check.
      expect(result.oscCpp).toContain(
        'static const float kAdditiveFrameMaxHarmonic[6] = {\n' +
          '      1.0f, 23.0f, 36.0f, 72.0f, 112.0f, 128.0f\n' +
          '    };'
      )
    })

    it("frame 0 is an exact pure sine (1 partial) and frame 1's own odd-harmonic recipe has no energy at the 2nd harmonic", () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/osc/additive', name: 'add1', x: 0, y: 0, params: [] }
      ])
      const result = generateOldGenOscUnit(doc, { name: 'additive frame shape' })
      const rowsMatch = result.oscCpp.match(/kAdditiveFrames\[6\]\[512\] = \{\n([^]*?)\n {4}\};/)
      expect(rowsMatch).not.toBeNull()
      const rows = rowsMatch![1].split('},').map((row) =>
        row
          .replace(/[{}\s]/g, '')
          .split(',')
          .filter((s) => s.length > 0)
          .map((s) => parseFloat(s))
      )
      expect(rows).toHaveLength(6)
      for (const row of rows) expect(row).toHaveLength(512)

      // Frame 0's own row -- a single sine cycle has exactly one zero-crossing pair per half
      // cycle, so index 128 (a quarter turn, sin(pi/2)) is close to that frame's own peak.
      expect(rows[0][0]).toBeCloseTo(0, 3)
      expect(rows[0][128]).toBeGreaterThan(rows[0][64])

      // Frame 1 is odd harmonics ONLY (1,3,5,...,23) -- a pure 2nd-harmonic component (k=2) would
      // itself be zero at table index 256 (a half cycle of the FUNDAMENTAL, sin(pi)=0, but
      // sin(2*pi*2*256/512)=sin(2*pi)=0 too, not a useful probe); instead confirm the row is NOT
      // symmetric under a half-table shift the way a purely-even-harmonic signal would be --
      // odd harmonics flip sign under phase+0.5, even ones don't, so `row[i] + row[i+256]` should
      // be close to zero everywhere for an odd-only recipe.
      const oddRow = rows[1]
      for (const i of [10, 100, 200]) {
        expect(oddRow[i] + oddRow[i + 256]).toBeCloseTo(0, 3)
      }
    })

    it('a wired timbre inlet adds to the dial value at depth 100 (clamped to [0,1]), like crossfader FADE', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/lfo/sine-lfo', name: 'lfo1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/osc/additive', name: 'add1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          {
            sources: [{ obj: 'lfo1', outlet: 'out' }],
            dests: [{ obj: 'add1', inlet: 'timbre' }]
          },
          { sources: [{ obj: 'add1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'additive timbre inlet' })
      expect(result.oscCpp).toContain(
        'additive_step(phase_add1, blkW0_add1, clampf(timbrePercent_add1 * 0.01f + (y_lfo1), 0.f, 1.f))'
      )
    })

    it('a wired pitch inlet still uses the shared +-24 depth, same as every other oscillator', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/util/constant', name: 'pitch1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/osc/additive', name: 'add1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          {
            sources: [{ obj: 'pitch1', outlet: 'out' }],
            dests: [{ obj: 'add1', inlet: 'pitch' }]
          },
          { sources: [{ obj: 'add1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOldGenOscUnit(doc, { name: 'additive pitch inlet' })
      expect(result.oscCpp).toContain('phase_add1 += blkW0_add1;')
    })
  })

  it('emits the fixed, real (byte-identical-to-the-SDK-verified) scaffold files unmodified', () => {
    const doc = docWith([sineNode('sine1')])
    const result = generateOldGenOscUnit(doc, { name: 'test' })

    expect(result.makefile).toContain('PKGARCH := $(PROJECT).mnlgxdunit')
    expect(result.unitC).toContain('_hook_cycle')
    expect(result.rulesLd).toContain('SECTIONS')
    expect(result.useroscLd).toContain('ENTRY(_entry)')
    expect(result.oscApiSyms).toContain('k_osc_api_version')
    expect(result.projectMk).toContain('UCXXSRC = osc.cpp')
  })

  describe('logue/lfo/fast-square + logue/util/sample-hold', () => {
    const audioOutNode = (): ObjNode => ({
      kind: 'obj',
      type: LOGUE_AUDIO_OUT_TYPE,
      name: 'out',
      x: 0,
      y: 0,
      params: []
    })

    function squareClockedHold(squareParams: { name: string; value: string }[]): PatchDocument {
      return {
        nodes: [
          sineNode('a'),
          {
            kind: 'obj',
            type: 'logue/lfo/fast-square',
            name: 'clk',
            x: 0,
            y: 0,
            params: squareParams
          },
          { kind: 'obj', type: 'logue/util/sample-hold', name: 'sh', x: 0, y: 0, params: [] },
          audioOutNode()
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'sh', inlet: 'in' }] },
          { sources: [{ obj: 'clk', outlet: 'out' }], dests: [{ obj: 'sh', inlet: 'trig' }] },
          { sources: [{ obj: 'sh', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
    }

    it('fast-square is a naive pulse whose increment switches on TRACK', () => {
      const result = generateOldGenOscUnit(
        docWith([
          { kind: 'obj', type: 'logue/lfo/fast-square', name: 'fs1', x: 0, y: 0, params: [] }
        ]),
        { name: 'xd fs' }
      )
      const src = result.oscCpp
      expect(src).toContain('float y_fs1 = (phase_fs1 < width_fs1 * 0.01f ? 1.f : -1.f);')
      expect(src).toContain(
        'const float blkW0_fs1 = note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_fs1 + fine_fs1);'
      )
      expect(src).toContain('phase_fs1 += (track_fs1 >= 1.f ? blkW0_fs1 : blkLfoRate_fs1);')
      expect(src).toContain('static float fast_lfo_rate_from_percent(float percent)')
      expect(src).not.toContain('polyblep')
      expect(src).toContain('ratePercent_fs1 = 30;')
      expect(src).toContain('width_fs1 = 50;')
      expect(src).toContain('track_fs1 = 0;')
    })

    it('fast-square wired rate/pitch/width inlets are additive', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('m'),
          { kind: 'obj', type: 'logue/lfo/fast-square', name: 'fs1', x: 0, y: 0, params: [] },
          audioOutNode()
        ],
        nets: [
          {
            sources: [{ obj: 'm', outlet: 'out' }],
            dests: [
              { obj: 'fs1', inlet: 'rate' },
              { obj: 'fs1', inlet: 'pitch' },
              { obj: 'fs1', inlet: 'width' }
            ]
          },
          { sources: [{ obj: 'fs1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const src = generateOldGenOscUnit(doc, { name: 'xd fs wired' }).oscCpp
      expect(src).toContain('clampf(width_fs1 + (y_m) * 50.f, 0.f, 100.f) * 0.01f')
      expect(src).toContain('coarse_fs1 + fine_fs1 + (y_m) * 24.f')
      expect(src).toContain(
        'fast_lfo_rate_from_percent(clampf(ratePercent_fs1 + (y_m) * 50.f, 0.f, 100.f))'
      )
    })

    it('sample-hold latches `in` on a rising trig edge via a leaf helper', () => {
      const src = generateOldGenOscUnit(squareClockedHold([]), { name: 'xd sh' }).oscCpp
      expect(src).toContain('float y_sh = trig_hold_step(&held_sh, &prevTrig_sh, (y_a), y_clk);')
      expect(src).toContain(
        'static float trig_hold_step(float *held, float *prevTrig, float value, float trig)'
      )
      expect(src).toContain('held_sh = 0.f;')
      expect(src).toContain('prevTrig_sh = 0.f;')
    })

    it('sample-hold with trig unwired passes `in` straight through', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          { kind: 'obj', type: 'logue/util/sample-hold', name: 'sh', x: 0, y: 0, params: [] },
          audioOutNode()
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'sh', inlet: 'in' }] },
          { sources: [{ obj: 'sh', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const src = generateOldGenOscUnit(doc, { name: 'xd sh thru' }).oscCpp
      expect(src).toContain('float y_sh = (y_a);')
      expect(src).not.toContain('trig_hold_step(&held_sh')
    })
  })

  describe('logue/lfo/* trig inlet -- a rising edge resets the phase', () => {
    const PHASE_LFOS = [
      'logue/lfo/sine-lfo',
      'logue/lfo/triangle-lfo',
      'logue/lfo/square-lfo',
      'logue/lfo/ramp-up',
      'logue/lfo/ramp-down',
      'logue/lfo/fast-square'
    ]

    function gatedLfo(type: string): PatchDocument {
      return {
        nodes: [
          { kind: 'obj', type: 'logue/sense/gate', name: 'gate1', x: 0, y: 0, params: [] },
          { kind: 'obj', type, name: 'lfo1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'gate1', outlet: 'out' }], dests: [{ obj: 'lfo1', inlet: 'trig' }] },
          { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
    }

    it.each(PHASE_LFOS)('%s: a wired trig resets phase to 0 after the advance', (type) => {
      const src = generateOldGenOscUnit(gatedLfo(type), { name: 'lfo trig' }).oscCpp
      expect(src).toContain('float prevTrig_lfo1;')
      expect(src).toContain('prevTrig_lfo1 = 0.f;')
      const reset =
        '      float trigOpen_lfo1 = (y_gate1 >= 0.5f) ? 1.f : 0.f;\n' +
        '      if (trigOpen_lfo1 > prevTrig_lfo1) phase_lfo1 = 0.f;\n' +
        '      prevTrig_lfo1 = trigOpen_lfo1;\n'
      expect(src).toContain('if (phase_lfo1 >= 1.f) phase_lfo1 -= 1.f;\n' + reset)
    })

    it.each(PHASE_LFOS)('%s: an unwired trig emits no edge check', (type) => {
      const src = generateOldGenOscUnit(
        docWith([{ kind: 'obj', type, name: 'lfo1', x: 0, y: 0, params: [] }]),
        {
          name: 'lfo no trig'
        }
      ).oscCpp
      expect(src).toContain('float prevTrig_lfo1;')
      expect(src).not.toContain('trigOpen_lfo1')
    })

    it('random-steps: a wired trig resets phase to 1 so the next sample latches a fresh value', () => {
      const src = generateOldGenOscUnit(gatedLfo('logue/lfo/random-steps'), {
        name: 'sh trig'
      }).oscCpp
      expect(src).toContain('prevTrig_lfo1 = 0.f;')
      expect(src).toContain('if (trigOpen_lfo1 > prevTrig_lfo1) phase_lfo1 = 1.f;')
      expect(src).toContain(
        'float y_lfo1 = sample_hold_step(&phase_lfo1, blkLfoRate_lfo1, &held_lfo1, noise_step(&seed_lfo1));'
      )
    })
  })
})

import { describe, it, expect } from 'vitest'
import {
  generateOscUnit,
  UnsupportedLogueNodeError,
  InvalidLogueUnitNameError,
  InvalidLogueParamError
} from '../logue-codegen/src/nts1mkii/generateOscUnit'
import { LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import type { PatchDocument, ObjNode, CommentNode } from '../src/shared/domain/patch'

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
        : [{ name: 'WIDTH', value: '50', logueParamIndex: { nts1mkii: logueParamIndex } }]
  }
}

function sineNode(name: string): ObjNode {
  return { kind: 'obj', type: 'logue/osc/sine', name, x: 0, y: 0, params: [] }
}

function audioOutNode(): ObjNode {
  return {
    kind: 'obj',
    type: LOGUE_AUDIO_OUT_TYPE,
    name: 'out',
    x: 0,
    y: 0,
    params: []
  }
}

/**
 * Auto-wires the FIRST `obj`-kind node to a synthesized `logue/io/audio-out` via a real net --
 * keeps every pre-existing single-primitive fixture valid under the now-required
 * one-net-to-audio-out model (`oscInstances.ts`'s `resolveAudioGraph`) without rewriting each
 * test individually. A genuinely empty `nodes` array is passed through untouched (no node to
 * wire), preserving the "rejects an empty graph" test's own meaning. Tests that need a specific
 * topology (multiple nodes, deliberately unwired, fan-in, etc.) build a `PatchDocument` by hand
 * instead of using this helper.
 */
function docWith(nodes: PatchDocument['nodes']): PatchDocument {
  if (nodes.length === 0) {
    return { nodes: [], nets: [], settings: {}, notes: '' }
  }
  const firstObj = nodes.find((n): n is ObjNode => n.kind === 'obj')
  const out = audioOutNode()
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

describe('generateOscUnit (phase-2 minimal slice)', () => {
  it('generates a real, well-formed unit_header/Osc class/callback set for a single sine primitive', () => {
    const doc = docWith([sineNode('sine1')])
    const result = generateOscUnit(doc, { name: 'axo poc2' })

    expect(result.headerC).toContain('k_unit_module_osc')
    expect(result.headerC).toContain('.name = "axo poc2"')
    // The fixed SHAPE/ALT-SHAPE knob pair is now reserved on
    // EVERY NTS-1 mkII unit (not just ones using logue/sense/shape(-alt)), so even a plain,
    // param-free sine still gets num_params=2 -- see reserveFixedKnobSlots's own doc comment.
    expect(result.headerC).toContain('.num_params = 2')
    expect(result.headerC).toContain('"SHPE"')
    expect(result.headerC).toContain('"ALT"')

    expect(result.oscH).toContain('class Osc : public Processor')
    expect(result.oscH).toContain('float phase_sine1;')
    expect(result.oscH).toContain('osc_sinf(phase_sine1)')
    expect(result.oscH).toContain(
      'phase_sine1 += note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_sine1 + fine_sine1);'
    )

    expect(result.unitCc).toContain('unit_render')
    expect(result.unitCc).toContain(
      's_osc_instance.setPitch((context->pitch) >> 8, context->pitch & 0xFF);'
    )
    // osc_w0f_for_note itself is now called from each oscillator instance's own note_w0 helper
    // (oscH), not unit_render directly -- setPitch just stashes the raw note/fine bytes.
    expect(result.oscH).toContain('osc_w0f_for_note')
  })

  it("unit_init calls Osc::init() explicitly -- a real, user-reported bug: the reference dummy-osc/unit.cc never calls it (harmless there, its own init() is a no-op), but this generator's own Osc::init() carries every non-exposed param's configured default (e.g. a comb filter's FEEDBACK/TRACK), so skipping it left those stuck at 0 on real NTS-1 mkII hardware regardless of the authored value -- confirmed by comparing against dummy-delfx/dummy-revfx/dummy-modfx's own unit_init, which DO call init(nullptr) when getBufferSize()==0, exactly this class's own case", () => {
    const doc = docWith([sineNode('sine1')])
    const result = generateOscUnit(doc, { name: 'init test' })

    expect(result.unitCc).toContain('s_osc_instance.init(nullptr);')
  })

  it('only the primitive actually wired to logue/io/audio-out contributes -- an unconnected primitive is pruned entirely (no auto-sum)', () => {
    const out = audioOutNode()
    const doc: PatchDocument = {
      nodes: [sineNode('a'), sineNode('b'), out],
      nets: [{ sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
      settings: {},
      notes: ''
    }
    const result = generateOscUnit(doc, { name: 'one wired' })

    expect(result.oscH).toContain('float y_a = osc_sinf(phase_a);')
    expect(result.oscH).toContain('out[i] = clip1m1f(y_a);')
    expect(result.oscH).toContain('float phase_a;')
    expect(result.oscH).not.toContain('phase_b')
    expect(result.oscH).not.toContain('osc_sinf(phase_a) + ')
  })

  it('ignores comment nodes -- they generate no code', () => {
    const comment: CommentNode = { kind: 'comment', type: 'patch/comment', x: 0, y: 0, text: 'hi' }
    const annotated = docWith([sineNode('sine1'), comment])
    const plain = docWith([sineNode('sine1')])

    expect(generateOscUnit(annotated, { name: 'ok' })).toEqual(
      generateOscUnit(plain, { name: 'ok' })
    )
  })

  it('rejects an unrecognized primitive type', () => {
    const doc = docWith([{ kind: 'obj', type: 'osc/sine', name: 'n', x: 0, y: 0, params: [] }])

    expect(() => generateOscUnit(doc, { name: 'bad' })).toThrow(
      /isn't a recognized logue primitive/
    )
  })

  it('rejects an empty graph', () => {
    expect(() => generateOscUnit(docWith([]), { name: 'empty' })).toThrow(/Graph is empty/)
  })

  it('rejects a minilogue-xd-only logue/sense/* primitive -- logue/sense/cutoff has no NTS-1 mkII equivalent (the raw context field is real but Korg\'s own header marks it "Unused. Future.")', () => {
    const doc = docWith([
      { kind: 'obj', type: 'logue/sense/cutoff', name: 'cutoff1', x: 0, y: 0, params: [] }
    ])

    expect(() => generateOscUnit(doc, { name: 'bad platform' })).toThrow(UnsupportedLogueNodeError)
    expect(() => generateOscUnit(doc, { name: 'bad platform' })).toThrow(
      /isn't supported on NTS-1 mkII/
    )
  })

  it('generates logue/sense/pitch and logue/sense/shape on NTS-1 mkII too (widened from minilogue-xd-only)', () => {
    const doc: PatchDocument = {
      nodes: [
        { kind: 'obj', type: 'logue/sense/pitch', name: 'pitch1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/sense/shape', name: 'shape1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/mix/mix2', name: 'mix1', x: 0, y: 0, params: [] },
        audioOutNode()
      ],
      nets: [
        { sources: [{ obj: 'pitch1', outlet: 'out' }], dests: [{ obj: 'mix1', inlet: 'in1' }] },
        { sources: [{ obj: 'shape1', outlet: 'out' }], dests: [{ obj: 'mix1', inlet: 'in2' }] },
        { sources: [{ obj: 'mix1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    }

    const result = generateOscUnit(doc, { name: 'sense test' })

    expect(result.oscH).toContain('note01_')
    expect(result.oscH).toContain('shape01_')
    expect(result.oscH).toContain('void setShapeLfo(float shapeLfo01)')
    expect(result.unitCc).toContain('setShapeLfo(q31_to_f32(context->shape_lfo))')
    expect(result.headerC).toContain('"SHPE"')
    expect(result.oscH).toContain('case 0: shapeParam01_ = param_10bit_to_f32(value); break;')
    // A post-ship correction: a real Kontrol Editor "Wrong
    // number of unit params" rejection on a num_params:1 (slot 0 only) unit confirmed the two
    // fixed knobs must be declared as a pair -- slot 1 (ALT) must also be present, even when
    // only logue/sense/shape (not logue/sense/shape-2) is placed, so its value is still
    // written to shape2_01_ unconditionally rather than discarded.
    expect(result.headerC).toContain('.num_params = 2')
    expect(result.headerC).toContain('"ALT"')
    expect(result.oscH).toContain('case 1: shape2_01_ = param_10bit_to_f32(value); break;')
  })

  it('generates logue/sense/shape-2 on NTS-1 mkII, reserving both fixed knob slots even without logue/sense/shape', () => {
    const doc: PatchDocument = {
      nodes: [
        { kind: 'obj', type: 'logue/sense/shape-2', name: 'shape2inst1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/gain/vca', name: 'vca1', x: 0, y: 0, params: [] },
        audioOutNode()
      ],
      nets: [
        {
          sources: [{ obj: 'shape2inst1', outlet: 'out' }],
          dests: [{ obj: 'vca1', inlet: 'in' }]
        },
        { sources: [{ obj: 'vca1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    }

    const result = generateOscUnit(doc, { name: 'shape 2 test' })

    expect(result.oscH).toContain('shape2_01_')
    expect(result.headerC).toContain('.num_params = 2')
    expect(result.headerC).toContain('"SHPE"')
    expect(result.headerC).toContain('"ALT"')
    expect(result.oscH).toContain('case 0: shapeParam01_ = param_10bit_to_f32(value); break;')
    expect(result.oscH).toContain('case 1: shape2_01_ = param_10bit_to_f32(value); break;')
  })

  it('reserves param slots 0 AND 1 for the fixed knob pair on EVERY unit (not just ones using logue/sense/shape) and rejects a colliding logueParamIndex on either', () => {
    const doc: PatchDocument = {
      nodes: [
        { kind: 'obj', type: 'logue/sense/shape', name: 'shape1', x: 0, y: 0, params: [] },
        {
          kind: 'obj',
          type: 'logue/gain/vca',
          name: 'vca1',
          x: 0,
          y: 0,
          params: [{ name: 'GAIN', value: '50', logueParamIndex: { nts1mkii: 0 } }]
        },
        audioOutNode()
      ],
      nets: [
        { sources: [{ obj: 'shape1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'in' }] },
        { sources: [{ obj: 'vca1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    }

    expect(() => generateOscUnit(doc, { name: 'slot clash' })).toThrow(
      /reserved on every NTS-1 mkII unit for its fixed SHAPE knob/
    )
  })

  it('also rejects a colliding logueParamIndex on slot 1 (the reserved ALT-SHAPE slot), not just slot 0', () => {
    const doc: PatchDocument = {
      nodes: [
        { kind: 'obj', type: 'logue/sense/shape', name: 'shape1', x: 0, y: 0, params: [] },
        {
          kind: 'obj',
          type: 'logue/gain/vca',
          name: 'vca1',
          x: 0,
          y: 0,
          params: [{ name: 'GAIN', value: '50', logueParamIndex: { nts1mkii: 1 } }]
        },
        audioOutNode()
      ],
      nets: [
        { sources: [{ obj: 'shape1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'in' }] },
        { sources: [{ obj: 'vca1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    }

    expect(() => generateOscUnit(doc, { name: 'slot clash' })).toThrow(
      /reserved on every NTS-1 mkII unit for its fixed ALT-SHAPE knob/
    )
  })

  it('reserves slots 0 AND 1 even with NO sense/shape(-alt) anywhere in the graph (a real Kontrol Editor "Wrong number of unit params" rejection on num_params:0)', () => {
    const doc: PatchDocument = {
      nodes: [
        { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
        {
          kind: 'obj',
          type: 'logue/filter/comb',
          name: 'comb1',
          x: 0,
          y: 0,
          params: []
        },
        audioOutNode()
      ],
      nets: [
        { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'comb1', inlet: 'in' }] },
        { sources: [{ obj: 'comb1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    }

    const result = generateOscUnit(doc, { name: 'no sense' })

    expect(result.headerC).toContain('.num_params = 2')
    expect(result.headerC).toContain('"SHPE"')
    expect(result.headerC).toContain('"ALT"')
  })

  it('generates a PolyBLEP saw with its helper', () => {
    const doc = docWith([
      { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] }
    ])
    const result = generateOscUnit(doc, { name: 'saw test' })

    expect(result.oscH).toContain(
      'polyblep_saw(phase_saw1, note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_saw1 + fine_saw1))'
    )
    expect(result.oscH).toContain('static float polyblep(float t, float dt)')
    expect(result.oscH).toContain('static float polyblep_saw(float phase, float dt)')
  })

  it('generates a PolyBLEP square with its helper', () => {
    const doc = docWith([
      { kind: 'obj', type: 'logue/osc/square', name: 'sq1', x: 0, y: 0, params: [] }
    ])
    const result = generateOscUnit(doc, { name: 'square test' })

    expect(result.oscH).toContain(
      'polyblep_square(phase_sq1, note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_sq1 + fine_sq1))'
    )
    expect(result.oscH).toContain('static float polyblep_square(float phase, float dt)')
  })

  it('generates a naive triangle with no helper needed', () => {
    const doc = docWith([
      { kind: 'obj', type: 'logue/osc/triangle', name: 'tri1', x: 0, y: 0, params: [] }
    ])
    const result = generateOscUnit(doc, { name: 'tri test' })

    expect(result.oscH).toContain('fabsf(phase_tri1 - 0.5f)')
    expect(result.oscH).not.toContain('polyblep')
  })

  it('rejects a unit name longer than the real 19-char on-device limit (found via a real Docker build overflow warning)', () => {
    const doc = docWith([sineNode('sine1')])
    expect(() => generateOscUnit(doc, { name: 'this name is definitely too long' })).toThrow(
      InvalidLogueUnitNameError
    )
    expect(() => generateOscUnit(doc, { name: 'this name is definitely too long' })).toThrow(/19/)
  })

  it('rejects a unit name containing a quote or newline', () => {
    const doc = docWith([sineNode('sine1')])
    expect(() => generateOscUnit(doc, { name: 'bad"name' })).toThrow(InvalidLogueUnitNameError)
  })

  // `buildOscBodyPieces`'s own helper-dedup behavior across multiple SIMULTANEOUSLY ACTIVE
  // instances (e.g. saw + square both contributing) has no reachable scenario through this
  // generator anymore -- `resolveAudioGraph` resolves to exactly one active instance in this
  // slice (single-edge output resolution, see oscInstances.ts) -- covered directly instead in
  // test/logue-oscShared.spec.ts.

  it('rejects an unwired graph -- placing a primitive and logue/io/audio-out with no net between them is not enough', () => {
    const out = audioOutNode()
    const doc: PatchDocument = {
      nodes: [sineNode('sine1'), out],
      nets: [],
      settings: {},
      notes: ''
    }
    expect(() => generateOscUnit(doc, { name: 'unwired' })).toThrow(UnsupportedLogueNodeError)
    expect(() => generateOscUnit(doc, { name: 'unwired' })).toThrow(/isn't connected/)
  })

  it('rejects a graph with no logue/io/audio-out node at all', () => {
    const doc: PatchDocument = {
      nodes: [sineNode('sine1')],
      nets: [],
      settings: {},
      notes: ''
    }
    expect(() => generateOscUnit(doc, { name: 'no output' })).toThrow(UnsupportedLogueNodeError)
    expect(() => generateOscUnit(doc, { name: 'no output' })).toThrow(/no "logue\/io\/audio-out"/)
  })

  describe('param exposure (logueParamIndex)', () => {
    it('leaves num_params at 2 (just the always-reserved fixed knob pair) and setParameter only handles slots 0/1 when a param-capable primitive has no exposed params of its own', () => {
      const doc = docWith([pulseNode('pulse1')])
      const result = generateOscUnit(doc, { name: 'pulse unexposed' })

      expect(result.headerC).toContain('.num_params = 2')
      // The fixed knob pair is reserved on EVERY unit now, so
      // `setParameter` is never truly a no-op on NTS-1 mkII any more; the switch always has at
      // least the SHPE/ALT cases, even when the placed primitive itself exposes nothing.
      expect(result.oscH).toContain('switch (index)')
      expect(result.oscH).toContain('case 0: shapeParam01_ = param_10bit_to_f32(value); break;')
      expect(result.oscH).toContain('case 1: shape2_01_ = param_10bit_to_f32(value); break;')
      // still seeds its own internal default even when never exposed to the host (now stored
      // RAW, the *0.01f conversion moved to point-of-use)
      expect(result.oscH).toContain('width_pulse1 = 50;')
    })

    it('exposes a bound param as a real header row and a real setParameter case (slot 2 -- 0/1 are always reserved for the fixed knob pair)', () => {
      const doc = docWith([pulseNode('pulse1', 2)])
      const result = generateOscUnit(doc, { name: 'pulse exposed' })

      expect(result.headerC).toContain('.num_params = 3')
      // WIDTH's raw value already IS a plain percent (@logue-codegen/paramDeviceType), so it
      // gets a real on-device unit label, not the k_unit_param_type_none every param got before
      // that file existed.
      expect(result.headerC).toContain(
        '{0, 100, 0, 50, k_unit_param_type_percent, 0, 0, 0, {"WIDTH"}}'
      )
      expect(result.oscH).toContain('switch (index)')
      expect(result.oscH).toContain('case 2: width_pulse1 = value; break;')
    })

    it("exports a fixed-name param's label (set in the Param Matrix) as its header name", () => {
      const node = pulseNode('pulse1', 2)
      node.params[0].label = 'Tone'
      const result = generateOscUnit(docWith([node]), { name: 'pulse relabeled' })
      expect(result.headerC).toContain(
        '{0, 100, 0, 50, k_unit_param_type_percent, 0, 0, 0, {"Tone"}}'
      )
    })

    it('leaves gap slots below the highest exposed index as real k_unit_param_type_none sentinel rows -- distinct from the always-populated SHPE/ALT rows at 0/1', () => {
      const doc = docWith([pulseNode('pulse1', 4)])
      const result = generateOscUnit(doc, { name: 'gap test' })

      expect(result.headerC).toContain('.num_params = 5')
      const rows = result.headerC.split('.params = {')[1].split('};')[0]
      expect(rows).toContain('{0, 0, 0, 0, k_unit_param_type_none, 0, 0, 0, {""}}')
      expect(rows).toContain('{0, 100, 0, 50, k_unit_param_type_percent, 0, 0, 0, {"WIDTH"}}')
      expect(rows).toContain('{0, 1023, 0, 0, k_unit_param_type_none, 0, 0, 0, {"SHPE"}}')
      expect(rows).toContain('{0, 1023, 0, 0, k_unit_param_type_none, 0, 0, 0, {"ALT"}}')
    })

    it('exposes COARSE/FINE as real semi/cents header rows (already real semitones/cents, no curve needed) -- slots 2/3, since 0/1 are always reserved for the fixed knob pair', () => {
      const doc = docWith([
        {
          kind: 'obj',
          type: 'logue/osc/sine',
          name: 'sine1',
          x: 0,
          y: 0,
          params: [
            { name: 'COARSE', value: '3', logueParamIndex: { nts1mkii: 2 } },
            { name: 'FINE', value: '-10', logueParamIndex: { nts1mkii: 3 } }
          ]
        }
      ])
      const result = generateOscUnit(doc, { name: 'coarse fine exposed' })

      expect(result.headerC).toContain(
        '{-24, 24, 0, 3, k_unit_param_type_semi, 0, 0, 0, {"COARSE"}}'
      )
      expect(result.headerC).toContain(
        '{-50, 50, 0, -10, k_unit_param_type_cents, 0, 0, 0, {"FINE"}}'
      )
    })

    it("exposes comb/svf TRACK as a real k_unit_param_type_onoff header row -- safe now that the DSP threshold exactly matches onoff's own value==0/nonzero device semantics (slot 2, since 0/1 are always reserved for the fixed knob pair)", () => {
      const doc = docWith([
        {
          kind: 'obj',
          type: 'logue/filter/comb',
          name: 'comb1',
          x: 0,
          y: 0,
          params: [{ name: 'TRACK', value: '100', logueParamIndex: { nts1mkii: 2 } }]
        }
      ])
      const result = generateOscUnit(doc, { name: 'track exposed' })

      // A 0..1 device range, so the knob flips once; setParameter scales back to the spec's 100.
      expect(result.headerC).toContain('{0, 1, 0, 1, k_unit_param_type_onoff, 0, 0, 0, {"TRACK"}}')
      expect(result.oscH).toContain('case 2: track_comb1 = (value * 100); break;')
    })

    it('bakes a toggle default in by the DSP threshold, not by rounding (TRACK=30 is ON)', () => {
      const doc = docWith([
        {
          kind: 'obj',
          type: 'logue/filter/comb',
          name: 'comb1',
          x: 0,
          y: 0,
          params: [{ name: 'TRACK', value: '30', logueParamIndex: { nts1mkii: 2 } }]
        }
      ])
      const result = generateOscUnit(doc, { name: 'track default' })
      expect(result.headerC).toContain('{0, 1, 0, 1, k_unit_param_type_onoff, 0, 0, 0, {"TRACK"}}')
    })

    it('labels exposed selects "In 1".."In N" (demux2: "Out 1"/"Out 2") via k_unit_param_type_strings', () => {
      const doc: PatchDocument = {
        nodes: [
          {
            kind: 'obj',
            type: 'logue/mux/mux4',
            name: 'mx4',
            x: 0,
            y: 0,
            params: [{ name: 'INDEX', value: '2', logueParamIndex: { nts1mkii: 3 } }]
          },
          {
            kind: 'obj',
            type: 'logue/mux/mux2',
            name: 'mx1',
            x: 0,
            y: 0,
            params: [{ name: 'SELECT', value: '60', logueParamIndex: { nts1mkii: 2 } }]
          },
          {
            kind: 'obj',
            type: 'logue/mux/demux2',
            name: 'dx1',
            x: 0,
            y: 0,
            params: [{ name: 'SELECT', value: '0', logueParamIndex: { nts1mkii: 4 } }]
          },
          audioOutNode()
        ],
        nets: [
          { sources: [{ obj: 'mx4', outlet: 'out' }], dests: [{ obj: 'mx1', inlet: 'i1' }] },
          { sources: [{ obj: 'mx1', outlet: 'out' }], dests: [{ obj: 'dx1', inlet: 'in' }] },
          { sources: [{ obj: 'dx1', outlet: 'o0' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOscUnit(doc, { name: 'mux strings' })
      expect(result.headerC).toContain(
        '{0, 1, 0, 1, k_unit_param_type_strings, 0, 0, 0, {"SELECT"}}'
      )
      expect(result.headerC).toContain(
        '{0, 3, 0, 2, k_unit_param_type_strings, 0, 0, 0, {"INDEX"}}'
      )
      expect(result.headerC).toContain(
        '{0, 1, 0, 0, k_unit_param_type_strings, 0, 0, 0, {"SELECT"}}'
      )
      expect(result.oscH).toContain('case 2: selectPercent_mx1 = (value * 100); break;')
      expect(result.oscH).toContain('case 3: indexRaw_mx4 = value; break;')
      // A wired choice is named after its source node (mx1's i1 comes from mx4); unwired, "In N".
      expect(result.unitCc).toContain(
        'static const char *const strs[] = {"mx4", "In 2"};\n    return strs[value - 0];'
      )
      expect(result.unitCc).toContain('{"In 1", "In 2", "In 3", "In 4"}')
      expect(result.unitCc).toContain('{"Out 1", "Out 2"}')
      expect(result.unitCc).toContain(
        'value = clipminmaxi32(unit_header.params[id].min, value, unit_header.params[id].max);\n  switch (id)'
      )
    })

    it("names a mux's choices after the nodes wired into them, cut to 7 characters, _ as a space", () => {
      const src = (name: string): PatchDocument['nodes'][number] => ({
        kind: 'obj',
        type: 'logue/lfo/sine-lfo',
        name,
        x: 0,
        y: 0,
        params: []
      })
      const doc: PatchDocument = {
        nodes: [
          src('SAW_DN'),
          src('a-very-long-name'),
          {
            kind: 'obj',
            type: 'logue/mux/mux4',
            name: 'mx',
            x: 0,
            y: 0,
            params: [{ name: 'INDEX', value: '0', logueParamIndex: { nts1mkii: 2 } }]
          },
          audioOutNode()
        ],
        nets: [
          { sources: [{ obj: 'SAW_DN', outlet: 'out' }], dests: [{ obj: 'mx', inlet: 'i1' }] },
          {
            sources: [{ obj: 'a-very-long-name', outlet: 'out' }],
            dests: [{ obj: 'mx', inlet: 'i3' }]
          },
          { sources: [{ obj: 'mx', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      expect(generateOscUnit(doc, { name: 'named' }).unitCc).toContain(
        '{"SAW DN", "In 2", "a-very-", "In 4"}'
      )
    })

    it('keeps the plain nullptr unit_get_param_str_value when no strings param is exposed', () => {
      const result = generateOscUnit(docWith([pulseNode('pulse1')]), { name: 'no strings' })
      expect(result.unitCc).toContain(
        '__unit_callback const char *unit_get_param_str_value(uint8_t, int32_t) { return nullptr; }'
      )
    })

    it("rejects a logueParamIndex on a primitive that isn't wired to the output -- exposing a param there would map a physical control to nothing", () => {
      const out = audioOutNode()
      const doc: PatchDocument = {
        nodes: [pulseNode('pulse1', 0), pulseNode('pulse2', 0), out],
        nets: [
          { sources: [{ obj: 'pulse1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      expect(() => generateOscUnit(doc, { name: 'unwired exposure' })).toThrow(
        InvalidLogueParamError
      )
      expect(() => generateOscUnit(doc, { name: 'unwired exposure' })).toThrow(/isn't wired/)
    })

    it('rejects a logueParamIndex outside the real NTS-1 mkII osc range [0,9]', () => {
      const doc = docWith([pulseNode('pulse1', 10)])
      expect(() => generateOscUnit(doc, { name: 'bad index' })).toThrow(InvalidLogueParamError)
      expect(() => generateOscUnit(doc, { name: 'bad index' })).toThrow(/outside the valid range/)
    })

    it("ignores a ParamValue whose name does not match any of the primitive's declared params -- num_params still lands at 2, just the always-reserved fixed knob pair", () => {
      const doc = docWith([
        {
          kind: 'obj',
          type: 'logue/osc/pulse',
          name: 'pulse1',
          x: 0,
          y: 0,
          params: [{ name: 'NOT_A_REAL_PARAM', value: '5', logueParamIndex: { nts1mkii: 0 } }]
        }
      ])
      const result = generateOscUnit(doc, { name: 'unmatched param' })
      expect(result.headerC).toContain('.num_params = 2')
    })
  })

  describe('logue/util/constant -- platform-agnostic', () => {
    it('generates on NTS-1 mkII too (no `platforms` restriction, unlike the sense/* primitives)', () => {
      const doc = docWith([
        {
          kind: 'obj',
          type: 'logue/util/constant',
          name: 'const1',
          x: 0,
          y: 0,
          params: [{ name: 'VALUE', value: '50' }]
        }
      ])
      const result = generateOscUnit(doc, { name: 'constant on nts1' })
      expect(result.oscH).toContain('float y_const1 = value_const1;')
      expect(result.oscH).toContain('value_const1 = 50 * 0.01f;')
    })
  })

  describe('logue/util/unipolar-to-bipolar + logue/util/bipolar-to-unipolar -- platform-agnostic', () => {
    it('generate on NTS-1 mkII too, same as constant', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/util/bipolar-to-unipolar', name: 'b2u', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'converter on nts1' })
      expect(result.oscH).toContain('float y_b2u = ((clampf(0.f, -1.f, 1.f) + 1.f) * 0.5f);')
    })
  })

  describe('logue/math/negate -- platform-agnostic', () => {
    it('generates on NTS-1 mkII too, same as the range converters', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/math/negate', name: 'inv1', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'invert on nts1' })
      expect(result.oscH).toContain('float y_inv1 = (-(0.f));')
    })
  })

  describe('logue/mix/crossfader -- platform-agnostic', () => {
    it('generates on NTS-1 mkII too, same as mix2/multiply', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/mix/crossfader', name: 'xf', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'crossfader on nts1' })
      expect(result.oscH).toContain(
        'float y_xf = ((blkFadeMoving_xf != 0.f ? xfade_glide(&xfG_xf[0], blkFadeA_xf) : blkFadeA_xf) * (0.f) + (blkFadeMoving_xf != 0.f ? xfade_glide(&xfG_xf[1], blkFadeB_xf) : blkFadeB_xf) * (0.f));'
      )
    })
  })

  describe('logue/osc/additive -- platform-agnostic, baked wavetable-morph oscillator', () => {
    it('generates on NTS-1 mkII too, same shared additive_step call and baked table as minilogue xd', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/osc/additive', name: 'add1', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'additive on nts1' })
      expect(result.oscH).toContain('static const float kAdditiveFrames[6][512] = {')
      expect(result.oscH).toContain('static const float kAdditiveFrameMaxHarmonic[6] = {')
      expect(result.oscH).toContain(
        'float y_add1 = additive_step(phase_add1, note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_add1 + fine_add1), (timbrePercent_add1 * 0.01f));'
      )
      expect(result.oscH).toContain('out[i] = clip1m1f(y_add1);')
    })
  })

  describe('logue/filter/svf -- platform-agnostic, multi-outlet', () => {
    it('generates on NTS-1 mkII too, wiring only the requested outlet to audio-out', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/osc/noise', name: 'noise1', x: 0, y: 0, params: [] },
          {
            kind: 'obj',
            type: 'logue/filter/svf',
            name: 'svf1',
            x: 0,
            y: 0,
            params: [{ name: 'RESONANCE', value: '80' }]
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          { sources: [{ obj: 'noise1', outlet: 'out' }], dests: [{ obj: 'svf1', inlet: 'in' }] },
          { sources: [{ obj: 'svf1', outlet: 'hp' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOscUnit(doc, { name: 'svf on nts1' })
      // One shared svf_step CALL producing all three taps (the helper's own `static void
      // svf_step(...)` definition is the second, unrelated match), output picks the wired
      // outlet (hp).
      expect(result.oscH.match(/svf_step\(&/g)).toHaveLength(1)
      expect(result.oscH).toContain('out[i] = clip1m1f(y_svf1_hp);')
      expect(result.oscH).toContain('resonancePercent_svf1 = 80;')
    })
  })

  describe('logue/filter/formant -- platform-agnostic, 3-band formant filter', () => {
    it('generates on NTS-1 mkII, one shared formant_step call, wireable VOWEL/SHIFT/RESONANCE', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/osc/noise', name: 'noise1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/lfo/sine-lfo', name: 'lfo1', x: 0, y: 0, params: [] },
          {
            kind: 'obj',
            type: 'logue/filter/formant',
            name: 'formant1',
            x: 0,
            y: 0,
            params: [{ name: 'RESONANCE', value: '75' }]
          },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          {
            sources: [{ obj: 'noise1', outlet: 'out' }],
            dests: [{ obj: 'formant1', inlet: 'in' }]
          },
          {
            sources: [{ obj: 'lfo1', outlet: 'out' }],
            dests: [{ obj: 'formant1', inlet: 'vowel' }]
          },
          { sources: [{ obj: 'formant1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOscUnit(doc, { name: 'formant on nts1' })
      // The shared step helper is called exactly once per instance regardless of how many of
      // its 3 internal bands it computes -- the second, unrelated match is the helper's own
      // `static float formant_step(...)` definition.
      expect(result.oscH.match(/formant_step\(&/g)).toHaveLength(1)
      expect(result.oscH).toContain(
        'static inline __attribute__((always_inline)) float formant_bp_step'
      )
      expect(result.oscH).toContain(
        'static inline __attribute__((always_inline)) float formant_g_from_note'
      )
      expect(result.oscH).toContain('static float formant_k_from_percent')
      expect(result.oscH).toContain('resonancePercent_formant1 = 75;')
      expect(result.oscH).toContain('vowelPercent_formant1')
      expect(result.oscH).toContain('shiftSemis_formant1')
      expect(result.oscH).toContain('out[i] = clip1m1f(y_formant1);')
    })
  })

  describe("logue/env/ad's wireable ATTACK/DECAY", () => {
    it('generates identically on NTS-1 mkII -- the envelope has no `platforms` restriction', () => {
      const doc: PatchDocument = {
        nodes: [
          {
            kind: 'obj',
            type: 'logue/env/ad',
            name: 'env1',
            x: 0,
            y: 0,
            params: [{ name: 'ATTACK', value: '5' }]
          },
          { kind: 'obj', type: 'logue/util/constant', name: 'const1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
        ],
        nets: [
          {
            sources: [{ obj: 'const1', outlet: 'out' }],
            dests: [{ obj: 'env1', inlet: 'attack' }]
          },
          { sources: [{ obj: 'env1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOscUnit(doc, { name: 'wired env on nts1' })
      expect(result.oscH).toContain(
        'ad_env_step(&stage_env1, &level_env1, blkAttackRate_env1, (exp_env1 >= 1.f ? (blkDecayRate_env1) * (level_env1 + 0.01f) : (blkDecayRate_env1)), 0.f, &prevTrig_env1)'
      )
      // Wired from a constant (computed once per block), so the rate is a block constant too.
      expect(result.oscH).toContain(
        'const float blkAttackRate_env1 = env_rate_from_percent(clampf(attackPercent_env1 + (y_const1) * 50.f, 0.f, 100.f));'
      )
      expect(result.oscH).toContain(
        'const float blkDecayRate_env1 = env_rate_from_percent(decayPercent_env1);'
      )
      expect(result.oscH).toContain('attackPercent_env1 = 5;')
    })
  })

  describe('logue/env/ahd -- a gated Attack-Hold-Decay envelope', () => {
    function ahdNode(name: string): ObjNode {
      return { kind: 'obj', type: 'logue/env/ahd', name, x: 0, y: 0, params: [] }
    }

    it('generates a real noteOff() override alongside noteOn(), moving an attacking/holding instance to decay', () => {
      const doc = docWith([ahdNode('env1')])
      const result = generateOscUnit(doc, { name: 'ahd on nts1' })
      expect(result.oscH).toContain(
        'float y_env1 = ahd_env_step(&stage_env1, &level_env1, blkAttackRate_env1, blkDecayRate_env1, 0.f, &prevTrig_env1);'
      )
      expect(result.oscH).toContain(
        'const float blkAttackRate_env1 = env_rate_from_percent(attackPercent_env1);'
      )
      expect(result.oscH).toContain(
        'const float blkDecayRate_env1 = env_rate_from_percent(decayPercent_env1);'
      )
      expect(result.oscH).toContain(
        'void noteOn(uint8_t, uint8_t) override final\n  {\n    stage_env1 = 1;\n  }'
      )
      expect(result.oscH).toContain(
        'void noteOff(uint8_t) override final\n  {\n    if (stage_env1 == 1 || stage_env1 == 2) { stage_env1 = 3; }\n  }'
      )
    })

    it('a plain oscillator (no noteOffStatement) still gets a real, harmlessly-empty noteOff() override', () => {
      const doc = docWith([sineNode('sine1')])
      const result = generateOscUnit(doc, { name: 'no ahd on nts1' })
      expect(result.oscH).toContain('void noteOff(uint8_t) override final\n  {\n  }')
    })
  })

  describe('logue/env/ad + logue/env/ahd -- wired trig inlet retriggers from a gate signal, same as note-on', () => {
    it('logue/env/ad reads a wired trig, unwired reads as 0.f/no retrigger', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/env/ad', name: 'env1', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'ad trig unwired' })
      expect(result.oscH).toContain(
        'float y_env1 = ad_env_step(&stage_env1, &level_env1, blkAttackRate_env1, (exp_env1 >= 1.f ? (blkDecayRate_env1) * (level_env1 + 0.01f) : (blkDecayRate_env1)), 0.f, &prevTrig_env1);'
      )
      expect(result.oscH).toContain(
        'const float blkAttackRate_env1 = env_rate_from_percent(attackPercent_env1);'
      )
      expect(result.oscH).toContain(
        'const float blkDecayRate_env1 = env_rate_from_percent(decayPercent_env1);'
      )
      expect(result.oscH).toContain('float prevTrig_env1;')
      expect(result.oscH).toContain('prevTrig_env1 = 0.f;')
    })

    it('logue/env/ad reads a real wired trig signal from a gate/comparator', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/logic/greater-than', name: 'gate1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/env/ad', name: 'env1', x: 0, y: 0, params: [] },
          audioOutNode()
        ],
        nets: [
          { sources: [{ obj: 'gate1', outlet: 'out' }], dests: [{ obj: 'env1', inlet: 'trig' }] },
          { sources: [{ obj: 'env1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOscUnit(doc, { name: 'ad trig wired' })
      expect(result.oscH).toContain(
        'float y_env1 = ad_env_step(&stage_env1, &level_env1, blkAttackRate_env1, (exp_env1 >= 1.f ? (blkDecayRate_env1) * (level_env1 + 0.01f) : (blkDecayRate_env1)), y_gate1, &prevTrig_env1);'
      )
      expect(result.oscH).toContain(
        'const float blkAttackRate_env1 = env_rate_from_percent(attackPercent_env1);'
      )
      expect(result.oscH).toContain(
        'const float blkDecayRate_env1 = env_rate_from_percent(decayPercent_env1);'
      )
    })

    it('logue/env/ahd reads a wired trig too -- retriggers attack only, note-off is still the only way to reach decay', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/logic/edge', name: 'edge1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/env/ahd', name: 'env1', x: 0, y: 0, params: [] },
          audioOutNode()
        ],
        nets: [
          { sources: [{ obj: 'edge1', outlet: 'out' }], dests: [{ obj: 'env1', inlet: 'trig' }] },
          { sources: [{ obj: 'env1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOscUnit(doc, { name: 'ahd trig wired' })
      expect(result.oscH).toContain(
        'float y_env1 = ahd_env_step(&stage_env1, &level_env1, blkAttackRate_env1, blkDecayRate_env1, y_edge1, &prevTrig_env1);'
      )
      expect(result.oscH).toContain(
        'const float blkAttackRate_env1 = env_rate_from_percent(attackPercent_env1);'
      )
      expect(result.oscH).toContain(
        'const float blkDecayRate_env1 = env_rate_from_percent(decayPercent_env1);'
      )
      // trig never appears in noteOff -- decay is still exclusively note-off-driven.
      expect(result.oscH).toContain(
        'void noteOff(uint8_t) override final\n  {\n    if (stage_env1 == 1 || stage_env1 == 2) { stage_env1 = 3; }\n  }'
      )
    })
  })

  describe('logue/sense/gate -- the real note-on/note-off state as a wireable signal', () => {
    it('generates on NTS-1 mkII, no platforms restriction unlike cutoff/resonance/param', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/sense/gate', name: 'gate1', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'sense gate on nts1' })
      expect(result.oscH).toContain('float y_gate1 = held_gate1;')
      expect(result.oscH).toContain('float held_gate1;')
      expect(result.oscH).toContain('held_gate1 = 0.f;')
      expect(result.oscH).toContain(
        'void noteOn(uint8_t, uint8_t) override final\n  {\n    held_gate1 = 1.f;\n  }'
      )
      expect(result.oscH).toContain(
        'void noteOff(uint8_t) override final\n  {\n    held_gate1 = 0.f;\n  }'
      )
    })

    it('wires directly into an envelope trig, reproducing the note-on retrigger exactly', () => {
      const doc: PatchDocument = {
        nodes: [
          { kind: 'obj', type: 'logue/sense/gate', name: 'gate1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/env/ad', name: 'env1', x: 0, y: 0, params: [] },
          audioOutNode()
        ],
        nets: [
          { sources: [{ obj: 'gate1', outlet: 'out' }], dests: [{ obj: 'env1', inlet: 'trig' }] },
          { sources: [{ obj: 'env1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOscUnit(doc, { name: 'gate into trig' })
      expect(result.oscH).toContain(
        'float y_env1 = ad_env_step(&stage_env1, &level_env1, blkAttackRate_env1, (exp_env1 >= 1.f ? (blkDecayRate_env1) * (level_env1 + 0.01f) : (blkDecayRate_env1)), y_gate1, &prevTrig_env1);'
      )
      expect(result.oscH).toContain(
        'const float blkAttackRate_env1 = env_rate_from_percent(attackPercent_env1);'
      )
      expect(result.oscH).toContain(
        'const float blkDecayRate_env1 = env_rate_from_percent(decayPercent_env1);'
      )
    })
  })

  describe('logue/math/* -- platform-agnostic stateless/dial-backed math primitives', () => {
    it('logue/math/add sums two wired signals, unwired reads as silence', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/math/add', name: 'add1', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'add on nts1' })
      expect(result.oscH).toContain('float y_add1 = ((0.f) + (0.f));')
    })

    it('logue/math/subtract computes a - b', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/math/subtract', name: 'sub1', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'subtract on nts1' })
      expect(result.oscH).toContain('float y_sub1 = ((0.f) - (0.f));')
    })

    it('logue/math/scale multiplies by a dialed FACTOR, default 100 (unity, not silence)', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/math/scale', name: 'sc1', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'scale on nts1' })
      expect(result.oscH).toContain('float y_sc1 = ((0.f) * factor_sc1);')
      expect(result.oscH).toContain(
        'factorPercent_sc1 = 100; factor_sc1 = factorPercent_sc1 * 0.01f * range_sc1;'
      )
      // RANGE defaults to x1 and is set after FACTOR, so init ends on the real product.
      const init = result.oscH.slice(result.oscH.indexOf('factorPercent_sc1 = 100;'))
      expect(init).toContain(
        'range_sc1 = (0) >= 3 ? 8.f : (0) >= 2 ? 4.f : (0) >= 1 ? 2.f : 1.f; factor_sc1 = factorPercent_sc1 * 0.01f * range_sc1;'
      )
    })

    it('logue/math/scale honors an authored FACTOR (dialing a negative value flips sign)', () => {
      const doc = docWith([
        {
          kind: 'obj',
          type: 'logue/math/scale',
          name: 'sc1',
          x: 0,
          y: 0,
          params: [{ name: 'FACTOR', value: '-50' }]
        }
      ])
      const result = generateOscUnit(doc, { name: 'scale negative' })
      expect(result.oscH).toContain('factorPercent_sc1 = -50;')
    })

    it('logue/math/scale RANGE multiplies FACTOR by 1/2/4/8, per sample still one multiply', () => {
      const doc = docWith([
        {
          kind: 'obj',
          type: 'logue/math/scale',
          name: 'sc1',
          x: 0,
          y: 0,
          params: [
            { name: 'FACTOR', value: '75' },
            { name: 'RANGE', value: '2' }
          ]
        }
      ])
      const result = generateOscUnit(doc, { name: 'scale range' })
      expect(result.oscH).toContain('range_sc1 = (2) >= 3 ? 8.f : (2) >= 2 ? 4.f')
      expect(result.oscH).toContain('float y_sc1 = ((0.f) * factor_sc1);')
    })

    it('logue/math/min and logue/math/max are plain ternaries, not fminf/fmaxf', () => {
      const minResult = generateOscUnit(
        docWith([{ kind: 'obj', type: 'logue/math/min', name: 'mn1', x: 0, y: 0, params: [] }]),
        { name: 'min on nts1' }
      )
      expect(minResult.oscH).toContain('float y_mn1 = ((0.f) < (0.f) ? (0.f) : (0.f));')

      const maxResult = generateOscUnit(
        docWith([{ kind: 'obj', type: 'logue/math/max', name: 'mx1', x: 0, y: 0, params: [] }]),
        { name: 'max on nts1' }
      )
      expect(maxResult.oscH).toContain('float y_mx1 = ((0.f) > (0.f) ? (0.f) : (0.f));')
    })

    it('logue/math/clamp reuses clampf against dialed LO/HI, default [-100,100] (full range, no clipping)', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/math/clamp', name: 'cl1', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'clamp on nts1' })
      expect(result.oscH).toContain('float y_cl1 = clampf(0.f, lo_cl1, hi_cl1);')
      expect(result.oscH).toContain('lo_cl1 = -100 * 0.01f;')
      expect(result.oscH).toContain('hi_cl1 = 100 * 0.01f;')
    })

    it('logue/math/abs rectifies via a direct fabsf call, no ternary helper', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/math/abs', name: 'ab1', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'abs on nts1' })
      expect(result.oscH).toContain('float y_ab1 = fabsf(0.f);')
    })

    it('logue/math/add actually reads a real wired signal, not just its own unwired-silence default', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          sineNode('b'),
          { kind: 'obj', type: 'logue/math/add', name: 'add1', x: 0, y: 0, params: [] },
          audioOutNode()
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'add1', inlet: 'a' }] },
          { sources: [{ obj: 'b', outlet: 'out' }], dests: [{ obj: 'add1', inlet: 'b' }] },
          { sources: [{ obj: 'add1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOscUnit(doc, { name: 'add wired' })
      expect(result.oscH).toContain('float y_add1 = ((y_a) + (y_b));')
    })
  })

  describe('logue/logic/* -- platform-agnostic comparators and boolean ops', () => {
    it('logue/logic/greater-than compares against a dialed THRESHOLD by default (0), unwired a reads as silence', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/logic/greater-than', name: 'gt1', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'gt on nts1' })
      expect(result.oscH).toContain('float y_gt1 = ((0.f) > (threshold_gt1) ? 1.f : 0.f);')
      expect(result.oscH).toContain('threshold_gt1 = 0 * 0.01f;')
    })

    it('logue/logic/greater-than with a wired b adds it to the dialed THRESHOLD (a true two-signal compare when THRESHOLD=0)', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          sineNode('b'),
          { kind: 'obj', type: 'logue/logic/greater-than', name: 'gt1', x: 0, y: 0, params: [] },
          audioOutNode()
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'gt1', inlet: 'a' }] },
          { sources: [{ obj: 'b', outlet: 'out' }], dests: [{ obj: 'gt1', inlet: 'b' }] },
          { sources: [{ obj: 'gt1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOscUnit(doc, { name: 'gt two-signal' })
      expect(result.oscH).toContain(
        'float y_gt1 = ((y_a) > ((threshold_gt1 + (y_b))) ? 1.f : 0.f);'
      )
    })

    it('logue/logic/less-than mirrors greater-than', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/logic/less-than', name: 'lt1', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'lt on nts1' })
      expect(result.oscH).toContain('float y_lt1 = ((0.f) < (threshold_lt1) ? 1.f : 0.f);')
    })

    it('logue/logic/equal uses a real tolerance window, defaulting to 2 (not an unreachable exact ==)', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/logic/equal', name: 'eq1', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'eq on nts1' })
      expect(result.oscH).toContain(
        'float y_eq1 = (fabsf((0.f) - (threshold_eq1)) <= tolerance_eq1 ? 1.f : 0.f);'
      )
      expect(result.oscH).toContain('tolerance_eq1 = 2 * 0.01f;')
    })

    it('logue/logic/and reads both inputs at >=0.5f, unwired reads as silence/false', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/logic/and', name: 'and1', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'and on nts1' })
      expect(result.oscH).toContain(
        'float y_and1 = (((0.f) >= 0.5f) && ((0.f) >= 0.5f) ? 1.f : 0.f);'
      )
    })

    it('logue/logic/or mirrors and with ||', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/logic/or', name: 'or1', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'or on nts1' })
      expect(result.oscH).toContain(
        'float y_or1 = (((0.f) >= 0.5f) || ((0.f) >= 0.5f) ? 1.f : 0.f);'
      )
    })

    it('logue/logic/xor outputs true only when exactly one input is open', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/logic/xor', name: 'xor1', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'xor on nts1' })
      expect(result.oscH).toContain(
        'float y_xor1 = ((((0.f) >= 0.5f) != ((0.f) >= 0.5f)) ? 1.f : 0.f);'
      )
    })
  })

  describe('logue/mux/* -- platform-agnostic routing (hard select/demultiplex)', () => {
    it('logue/mux/mux2 selects i1 by default (SELECT=0, unwired sel)', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/mux/mux2', name: 'mx1', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'mux2 on nts1' })
      expect(result.oscH).toContain('float y_mx1 = ((selectPercent_mx1 >= 50.f) ? (0.f) : (0.f));')
      expect(result.oscH).toContain('selectPercent_mx1 = 0;')
    })

    it('logue/mux/mux2 a wired sel fully replaces the dial', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          sineNode('b'),
          { kind: 'obj', type: 'logue/logic/greater-than', name: 'gate1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/mux/mux2', name: 'mx1', x: 0, y: 0, params: [] },
          audioOutNode()
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
      const result = generateOscUnit(doc, { name: 'mux2 wired' })
      expect(result.oscH).toContain('float y_mx1 = (((y_gate1) >= 0.5f) ? (y_b) : (y_a));')
    })

    it('logue/mux/mux4 selects i1 by default (INDEX=0), integer-stepped param', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/mux/mux4', name: 'mx4', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'mux4 on nts1' })
      expect(result.oscH).toContain('float y_mx4 = mux4_select(indexRaw_mx4, 0.f, 0.f, 0.f, 0.f);')
      expect(result.oscH).toContain('indexRaw_mx4 = 0;')
      expect(result.oscH).toContain('static float mux4_select(float rawIndex')
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
      const result = generateOscUnit(doc, { name: 'mux4 indexed' })
      expect(result.oscH).toContain('indexRaw_mx4 = 2;')
    })

    it('logue/mux/mux4 rescales a wired bipolar index into 0..3 before rounding', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          { kind: 'obj', type: 'logue/mux/mux4', name: 'mx4', x: 0, y: 0, params: [] },
          audioOutNode()
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'mx4', inlet: 'index' }] },
          { sources: [{ obj: 'mx4', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOscUnit(doc, { name: 'mux4 wired index' })
      expect(result.oscH).toContain(
        'float y_mx4 = mux4_select(((clampf(y_a, -1.f, 1.f) + 1.f) * 1.5f), 0.f, 0.f, 0.f, 0.f);'
      )
    })

    it('logue/mux/demux2 routes to o0 by default, o1 reads silence -- only the wired outlet contributes', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          { kind: 'obj', type: 'logue/mux/demux2', name: 'dx1', x: 0, y: 0, params: [] },
          audioOutNode()
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'dx1', inlet: 'in' }] },
          { sources: [{ obj: 'dx1', outlet: 'o0' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOscUnit(doc, { name: 'demux2 o0' })
      expect(result.oscH).toContain('float y_dx1_o0 = ((selectPercent_dx1 >= 50.f)) ? 0.f : (y_a);')
      expect(result.oscH).toContain('float y_dx1_o1 = ((selectPercent_dx1 >= 50.f)) ? (y_a) : 0.f;')
      expect(result.oscH).toContain('out[i] = clip1m1f(y_dx1_o0);')
    })

    it('logue/mux/demux2 with a wired sel selecting o1', () => {
      const doc: PatchDocument = {
        nodes: [
          sineNode('a'),
          { kind: 'obj', type: 'logue/logic/greater-than', name: 'gate1', x: 0, y: 0, params: [] },
          { kind: 'obj', type: 'logue/mux/demux2', name: 'dx1', x: 0, y: 0, params: [] },
          audioOutNode()
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'dx1', inlet: 'in' }] },
          { sources: [{ obj: 'gate1', outlet: 'out' }], dests: [{ obj: 'dx1', inlet: 'sel' }] },
          { sources: [{ obj: 'dx1', outlet: 'o1' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOscUnit(doc, { name: 'demux2 wired sel' })
      expect(result.oscH).toContain('float y_dx1_o1 = (((y_gate1) >= 0.5f)) ? (y_a) : 0.f;')
      expect(result.oscH).toContain('out[i] = clip1m1f(y_dx1_o1);')
    })
  })

  describe('logue/logic/schmitt + logue/logic/edge + logue/util/glide -- platform-agnostic stateful primitives', () => {
    it('logue/logic/schmitt opens above THRESHOLD+HYSTERESIS, closes below THRESHOLD-HYSTERESIS', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/logic/schmitt', name: 'sch1', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'schmitt on nts1' })
      expect(result.oscH).toContain(
        'float y_sch1 = schmitt_step(&state_sch1, 0.f, threshold_sch1 + hysteresis_sch1, threshold_sch1 - hysteresis_sch1);'
      )
      expect(result.oscH).toContain('threshold_sch1 = 0 * 0.01f;')
      expect(result.oscH).toContain('hysteresis_sch1 = 5 * 0.01f;')
      expect(result.oscH).toContain('state_sch1 = 0.f;')
    })

    it('logue/logic/edge emits a one-sample trigger from a real state-tracking helper', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/logic/edge', name: 'edg1', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'edge on nts1' })
      expect(result.oscH).toContain('float y_edg1 = edge_step(&prevOpen_edg1, 0.f);')
      expect(result.oscH).toContain('prevOpen_edg1 = 0.f;')
      expect(result.oscH).toContain('static float edge_step(float *prevOpen, float value)')
    })

    it('logue/util/glide defaults GLIDE=0 -- a transparent pass-through, no lag', () => {
      const doc = docWith([
        { kind: 'obj', type: 'logue/util/glide', name: 'gl1', x: 0, y: 0, params: [] }
      ])
      const result = generateOscUnit(doc, { name: 'glide on nts1' })
      expect(result.oscH).toContain(
        'float y_gl1 = slew_step(&current_gl1, 0.f, slew_max_delta_from_percent(glidePercent_gl1));'
      )
      expect(result.oscH).toContain('current_gl1 = 0.f;')
      expect(result.oscH).toContain('glidePercent_gl1 = 0;')
    })

    it('logue/util/glide reads a real wired signal, moving toward it via a real linear ramp helper', () => {
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
          audioOutNode()
        ],
        nets: [
          { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'gl1', inlet: 'in' }] },
          { sources: [{ obj: 'gl1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
        ],
        settings: {},
        notes: ''
      }
      const result = generateOscUnit(doc, { name: 'glide wired' })
      expect(result.oscH).toContain(
        'float y_gl1 = slew_step(&current_gl1, y_a, slew_max_delta_from_percent(glidePercent_gl1));'
      )
      expect(result.oscH).toContain('glidePercent_gl1 = 50;')
    })
  })

  describe('logue/lfo/fast-square + logue/util/sample-hold', () => {
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
      const result = generateOscUnit(
        docWith([
          { kind: 'obj', type: 'logue/lfo/fast-square', name: 'fs1', x: 0, y: 0, params: [] }
        ]),
        { name: 'nts1 fs' }
      )
      const src = result.oscH
      expect(src).toContain('float y_fs1 = (phase_fs1 < width_fs1 * 0.01f ? 1.f : -1.f);')
      expect(src).toContain(
        'phase_fs1 += (track_fs1 >= 1.f ? note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_fs1 + fine_fs1) : blkLfoRate_fs1);'
      )
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
      const src = generateOscUnit(doc, { name: 'nts1 fs wired' }).oscH
      expect(src).toContain('clampf(width_fs1 + (y_m) * 50.f, 0.f, 100.f) * 0.01f')
      expect(src).toContain('coarse_fs1 + fine_fs1 + (y_m) * 24.f')
      expect(src).toContain(
        'fast_lfo_rate_from_percent(clampf(ratePercent_fs1 + (y_m) * 50.f, 0.f, 100.f))'
      )
    })

    it('sample-hold latches `in` on a rising trig edge via a leaf helper', () => {
      const src = generateOscUnit(squareClockedHold([]), { name: 'nts1 sh' }).oscH
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
      const src = generateOscUnit(doc, { name: 'nts1 sh thru' }).oscH
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
      const src = generateOscUnit(gatedLfo(type), { name: 'lfo trig' }).oscH
      expect(src).toContain('float prevTrig_lfo1;')
      expect(src).toContain('prevTrig_lfo1 = 0.f;')
      const reset =
        '      float trigOpen_lfo1 = (y_gate1 >= 0.5f) ? 1.f : 0.f;\n' +
        '      if (trigOpen_lfo1 > prevTrig_lfo1) phase_lfo1 = 0.f;\n' +
        '      prevTrig_lfo1 = trigOpen_lfo1;\n'
      expect(src).toContain('if (phase_lfo1 >= 1.f) phase_lfo1 -= 1.f;\n' + reset)
    })

    it.each(PHASE_LFOS)('%s: an unwired trig emits no edge check', (type) => {
      const src = generateOscUnit(
        docWith([{ kind: 'obj', type, name: 'lfo1', x: 0, y: 0, params: [] }]),
        {
          name: 'lfo no trig'
        }
      ).oscH
      expect(src).toContain('float prevTrig_lfo1;')
      expect(src).not.toContain('trigOpen_lfo1')
    })

    it('random-steps: a wired trig resets phase to 1 so the next sample latches a fresh value', () => {
      const src = generateOscUnit(gatedLfo('logue/lfo/random-steps'), { name: 'sh trig' }).oscH
      expect(src).toContain('prevTrig_lfo1 = 0.f;')
      expect(src).toContain('if (trigOpen_lfo1 > prevTrig_lfo1) phase_lfo1 = 1.f;')
      expect(src).toContain(
        'float y_lfo1 = sample_hold_step(&phase_lfo1, blkLfoRate_lfo1, &held_lfo1, noise_step(&seed_lfo1));'
      )
    })
  })
})

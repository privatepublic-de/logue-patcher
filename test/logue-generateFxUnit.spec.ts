import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { generateFxUnit } from '../logue-codegen/src/nts1mkii/generateFxUnit'
import { LOGUE_AUDIO_IN_TYPE, LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import { estimateOscStateCost } from '../logue-codegen/src/estimateOscStateCost'
import { estimateOscCpuCost } from '../logue-codegen/src/estimateOscCpuCost'
import type { LogueModule, Net, ObjNode, PatchDocument } from '../src/shared/domain/patch'
import type { ParamValue } from '../src/shared/domain/paramValueTypes'

function obj(name: string, type: string, params: ParamValue[] = []): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params }
}

function wire(from: string, outlet: string, to: string, inlet: string): Net {
  return { sources: [{ obj: from, outlet }], dests: [{ obj: to, inlet }] }
}

function doc(nodes: ObjNode[], nets: Net[], module: LogueModule = 'delfx'): PatchDocument {
  return { nodes, nets, settings: { logueTarget: { module } }, notes: '' }
}

const IN = obj('in', LOGUE_AUDIO_IN_TYPE)
const OUT = obj('out', LOGUE_AUDIO_OUT_TYPE)

function passThrough(module: LogueModule): PatchDocument {
  return doc([IN, OUT], [wire('in', 'l', 'out', 'l'), wire('in', 'r', 'out', 'r')], module)
}

/** The new-document shape: dry in1, the effect chain (here a lowpass) in2, FADE on MIX. */
function mixedLowpass(fade: ParamValue): PatchDocument {
  return doc(
    [IN, obj('lp', 'logue/filter/lowpass-cheap'), obj('x', 'logue/mix/crossfader', [fade]), OUT],
    [
      wire('in', 'mono', 'x', 'in1'),
      wire('in', 'mono', 'lp', 'in'),
      wire('lp', 'out', 'x', 'in2'),
      wire('x', 'out', 'out', 'l')
    ]
  )
}

const snapshotDir = join(__dirname, '__snapshots__', 'fx')

describe('generateFxUnit (NTS-1 mkII)', () => {
  it.each(['modfx', 'delfx', 'revfx'] as const)(
    'targets the %s module with its own header and fixed rows',
    (module) => {
      const { headerC, fxH, unitCc } = generateFxUnit(passThrough(module), { name: 'pass' })
      expect(headerC).toContain(`#include "unit_${module}.h"`)
      expect(headerC).toContain(`.target = UNIT_TARGET_PLATFORM | k_unit_module_${module},`)
      expect(headerC).toContain('{0, 1023, 0, 0, k_unit_param_type_none, 0, 0, 0, {"TIME"}}')
      expect(headerC).toContain('{0, 1023, 0, 0, k_unit_param_type_none, 0, 0, 0, {"DPTH"}}')
      const hasMix = module !== 'modfx'
      expect(headerC.includes('{"MIX"}')).toBe(hasMix)
      expect(headerC).toContain(`.num_params = ${hasMix ? 3 : 2},`)
      expect(fxH).toContain(`#include "unit_${module}.h"`)
      expect(unitCc).toContain('desc->output_channels != 2')
    }
  )

  it("declares Korg's MIX row exactly, init mid-way", () => {
    const { headerC } = generateFxUnit(passThrough('delfx'), { name: 'pass' })
    expect(headerC).toContain('{-1000, 1000, 0, 0, k_unit_param_type_drywet, 1, 1, 0, {"MIX"}}')
  })

  it('reads both input channels before writing either output', () => {
    const { fxH } = generateFxUnit(passThrough('delfx'), { name: 'pass' })
    const read = fxH.indexOf('const float y_in_r = in[2 * i + 1];')
    const write = fxH.indexOf('out[2 * i] = clip1m1f(y_in_l);')
    expect(read).toBeGreaterThan(0)
    expect(write).toBeGreaterThan(read)
    expect(fxH).toContain('out[2 * i + 1] = clip1m1f(y_in_r);')
  })

  it('copies the left output to an unwired right one', () => {
    const { fxH } = generateFxUnit(mixedLowpass({ name: 'FADE', value: '50' }), { name: 'lp' })
    expect(fxH).toContain('out[2 * i] = clip1m1f(y_x);')
    expect(fxH).toContain('out[2 * i + 1] = clip1m1f(y_x);')
  })

  it('never reaches for the oscillator API', () => {
    const sine = doc(
      [IN, obj('s', 'logue/osc/sine'), obj('m', 'logue/math/multiply'), OUT],
      [wire('in', 'mono', 'm', 'in1'), wire('s', 'out', 'm', 'in2'), wire('m', 'out', 'out', 'l')],
      'modfx'
    )
    const { fxH, unitCc, headerC } = generateFxUnit(sine, { name: 'ring' })
    for (const text of [fxH, unitCc, headerC]) {
      expect(text).not.toContain('osc_api.h')
      expect(text).not.toContain('unit_osc')
    }
    expect(fxH).toContain('#define osc_sinf fx_sinf')
    expect(fxH).toContain('float osc_w0f_for_note(uint8_t note, uint8_t mod)')
    expect(fxH).toContain('note_ = 60.f;')
  })

  it('drives a param bound to MIX from slot 2, starting where it was authored', () => {
    const { headerC, fxH } = generateFxUnit(
      mixedLowpass({ name: 'FADE', value: '100', logueKnob: { nts1mkii: 'mix' } }),
      { name: 'lp' }
    )
    expect(headerC).toContain('{-1000, 1000, 0, 1000, k_unit_param_type_drywet, 1, 1, 0, {"MIX"}}')
    expect(fxH).toContain('case 2: mix01_ = (value + 1000) * (1.f / 2000.f); break;')
    expect(fxH).toMatch(/mix01_ = 1\.f?;/)
    expect(fxH).toContain('fadePercent_x = (0.f + mix01_ * 100.f);')
  })

  it('puts a menu param after the fixed rows', () => {
    const { headerC } = generateFxUnit(
      mixedLowpass({ name: 'FADE', value: '50', logueParamIndex: { nts1mkii: 3 } }),
      { name: 'lp' }
    )
    expect(headerC).toContain('.num_params = 4,')
    expect(headerC).toContain('{"FADE"}')
  })

  it.each([
    ['a fixed slot', { logueParamIndex: { nts1mkii: 1 } }, /reserved on every NTS-1 mkII unit/],
    ['an oscillator knob', { logueKnob: { nts1mkii: 'shape' as const } }, /this kind of unit/]
  ])('rejects a param on %s', (_label, control, message) => {
    expect(() =>
      generateFxUnit(mixedLowpass({ name: 'FADE', value: '50', ...control }), { name: 'lp' })
    ).toThrow(message)
  })

  it('rejects an oscillator-only primitive and an oscillator document', () => {
    const gated = doc(
      [IN, obj('g', 'logue/sense/gate'), obj('v', 'logue/gain/vca'), OUT],
      [wire('in', 'l', 'v', 'in'), wire('g', 'out', 'v', 'gain'), wire('v', 'out', 'out', 'l')]
    )
    expect(() => generateFxUnit(gated, { name: 'g' })).toThrow(/only works in oscillator units/)
    expect(() => generateFxUnit(passThrough('osc'), { name: 'g' })).toThrow(
      /oscillator patch -- it builds with generateOscUnit/
    )
  })

  it('estimates RAM against the module budget, and CPU as not measured', () => {
    const ram = estimateOscStateCost(passThrough('modfx'), 'nts1mkii')
    expect(ram.status === 'ok' && ram.estimate.budgetBytes).toBe(16 * 1024)
    expect(estimateOscCpuCost(passThrough('delfx'), new Map(), 'nts1mkii')).toEqual({
      status: 'incomplete',
      reason: "CPU use isn't measured for effects yet."
    })
  })

  it('matches the golden source for a pass-through delay and a mixed lowpass', async () => {
    for (const [name, d] of [
      ['passthrough.delfx', passThrough('delfx')],
      [
        'mixed-lowpass.delfx',
        mixedLowpass({ name: 'FADE', value: '50', logueKnob: { nts1mkii: 'mix' } })
      ]
    ] as const) {
      const { headerC, fxH, unitCc } = generateFxUnit(d, { name: 'golden' })
      const text = `// header.c\n${headerC}\n// fx.h\n${fxH}\n// unit.cc\n${unitCc}`
      await expect(text).toMatchFileSnapshot(join(snapshotDir, `${name}.nts1mkii.txt`))
    }
  })
})

describe('logue/util/long-delay (SDRAM)', () => {
  function delays(module: LogueModule, ranges: string[], extra: ParamValue[] = []): PatchDocument {
    const nodes = ranges.map((range, i) =>
      obj(`d${i}`, 'logue/util/long-delay', [
        { name: 'RANGE', value: range },
        ...(i === 0 ? extra : [])
      ])
    )
    const nets = ranges.map((_, i) =>
      i === 0 ? wire('in', 'l', 'd0', 'in') : wire(`d${i - 1}`, 'out', `d${i}`, 'in')
    )
    nets.push(wire(`d${ranges.length - 1}`, 'out', 'out', 'l'))
    return doc([IN, ...nodes, OUT], nets, module)
  }

  it('lays the lines out back to back in one block and clears it in init()', () => {
    const { fxH, unitCc } = generateFxUnit(delays('delfx', ['0', '2']), { name: 'd' })
    expect(fxH).toContain('return 147456u; }')
    expect(fxH).toContain('sdram_d0 = sdram + 0;')
    expect(fxH).toContain('sdram_d1 = sdram + 16384;')
    expect(fxH).toContain('for (uint32_t i = 0; i < 147456u; ++i) sdram[i] = 0.f;')
    expect(unitCc).toContain('desc->hooks.sdram_alloc(sdramFloats * sizeof(float))')
  })

  it("fills a modfx's 256 KB with one 1.4 s line and refuses a 2.7 s one", () => {
    expect(() => generateFxUnit(delays('modfx', ['1']), { name: 'd' })).not.toThrow()
    expect(() => generateFxUnit(delays('modfx', ['2']), { name: 'd' })).toThrow(
      /need 512 KB of SDRAM, more than a modulation effect unit's 256 KB/
    )
  })

  it.each([
    ['exposed', { logueParamIndex: { nts1mkii: 3 } }],
    ['on a knob', { logueKnob: { nts1mkii: 'time' as const } }]
  ])('refuses RANGE %s: it sizes the line', (_label, control) => {
    const d = delays('delfx', ['1'])
    const node = d.nodes[1] as ObjNode
    node.params = [{ name: 'RANGE', value: '1', ...control }]
    expect(() => generateFxUnit(d, { name: 'd' })).toThrow(/fixed when the unit is built/)
  })

  it('is effects-only', () => {
    const osc = doc(
      [obj('n', 'logue/osc/noise'), obj('d', 'logue/util/long-delay'), OUT],
      [wire('n', 'out', 'd', 'in'), wire('d', 'out', 'out', 'in')],
      'osc'
    )
    expect(estimateOscStateCost(osc, 'nts1mkii')).toMatchObject({ status: 'incomplete' })
  })

  it('shows up in the RAM estimate as SDRAM, with the code baseline in the total', () => {
    const est = estimateOscStateCost(delays('delfx', ['0', '3']), 'nts1mkii')
    if (est.status !== 'ok') throw new Error(est.reason)
    expect(est.estimate.sdram).toEqual({
      perInstance: [
        { nodeName: 'd0', primitiveId: 'logue/util/long-delay', bytes: 16384 * 4 },
        { nodeName: 'd1', primitiveId: 'logue/util/long-delay', bytes: 262144 * 4 }
      ],
      usedBytes: (16384 + 262144) * 4,
      budgetBytes: 3 * 1024 * 1024
    })
    expect(est.estimate.codeBaselineBytes).toBe(4244 - 24)
    expect(est.estimate.stateBytes).toBe(est.estimate.baselineBytes + 2 * 4 + 2 * 40 + 40)
    expect(est.estimate.totalBytes).toBe(est.estimate.stateBytes + est.estimate.codeBytes)
  })
})

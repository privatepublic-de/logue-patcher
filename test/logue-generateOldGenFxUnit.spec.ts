import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { generateOldGenFxUnit } from '../logue-codegen/src/minilogue-xd/generateFxUnit'
import { generateMinilogueXdProject } from '../logue-codegen/src/minilogue-xd/projectFiles'
import { LOGUE_AUDIO_IN_TYPE, LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import { estimateOscStateCost } from '../logue-codegen/src/estimateOscStateCost'
import { findUnitKind } from '../logue-codegen/src/unitKinds'
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
const passThrough = (module: LogueModule): PatchDocument =>
  doc([IN, OUT], [wire('in', 'l', 'out', 'l'), wire('in', 'r', 'out', 'r')], module)

function mixedLowpass(fade: ParamValue, module: LogueModule = 'delfx'): PatchDocument {
  return doc(
    [IN, obj('lp', 'logue/filter/lowpass-cheap'), obj('x', 'logue/mix/crossfader', [fade]), OUT],
    [
      wire('in', 'mono', 'x', 'in1'),
      wire('in', 'mono', 'lp', 'in'),
      wire('lp', 'out', 'x', 'in2'),
      wire('x', 'out', 'out', 'l')
    ],
    module
  )
}

const snapshotDir = join(__dirname, '__snapshots__', 'fx')

describe('generateOldGenFxUnit (minilogue xd)', () => {
  it.each([
    ['modfx', 'usermodfx.h', "'U','M','O','D'", '6K', '128K', '0x20017800'],
    ['delfx', 'userdelfx.h', "'U','D','E','L'", '12K', '2432K', '0x20019000'],
    ['revfx', 'userrevfx.h', "'U','R','E','V'", '12K', '2432K', '0x20019000']
  ] as const)(
    'targets %s with its own header, hook table and memory map',
    (module, header, magic, sram, sdram, origin) => {
      const fx = generateOldGenFxUnit(passThrough(module), { name: 'pass' })
      expect(fx.fxCpp).toContain(`#include "${header}"`)
      expect(fx.unitC).toContain(`#include "${header}"`)
      expect(fx.unitC).toContain(`.magic = {${magic}},`)
      expect(fx.unitC).toContain(`static const user_${module}_hook_table_t s_hook_table`)
      expect(fx.moduleLd).toContain(`SRAM   (rx) : org = ${origin}, len = ${sram}`)
      expect(fx.moduleLd).toContain(`len = ${sdram}`)
      expect(fx.makefile).toContain('MCU_MODEL := STM32F446xE')
      expect(fx.makefile).toContain(`LDSCRIPT := $(LDDIR)/user${module}.ld`)
      expect(fx.makefile).toContain('--just-symbols=$(LDDIR)/main_api.syms')
      expect(fx.rulesLd).toContain('.sdram (NOLOAD)')
      expect(fx.mainApiSyms).toContain('_fx_get_bpmf = 0x0807ca8c;')
      expect(JSON.parse(fx.manifestJson)).toEqual({
        header: {
          platform: 'minilogue-xd',
          module,
          api: '1.1-0',
          dev_id: 0,
          prg_id: 0,
          version: '1.0-0',
          name: 'pass',
          num_param: 0
        }
      })
    }
  )

  it('processes delay/reverb in place and modfx from separate buffers, copying the sub timbre', () => {
    expect(generateOldGenFxUnit(passThrough('delfx'), { name: 'p' }).fxCpp).toContain(
      'void DELFX_PROCESS(float *xn, uint32_t frames) { s_fx.process(xn, xn, frames); }'
    )
    const modfx = generateOldGenFxUnit(passThrough('modfx'), { name: 'p' }).fxCpp
    expect(modfx).toContain('s_fx.process(main_xn, main_yn, frames);')
    expect(modfx).toContain('sub_yn[i] = sub_xn[i];')
  })

  it('reads knob values as Q31, Shift+Depth (id 3) as the mix knob on delay/reverb only', () => {
    const delfx = generateOldGenFxUnit(passThrough('delfx'), { name: 'p' }).fxCpp
    expect(delfx).toContain('s_fx.setKnob(index, clip01f(q31_to_f32(value)));')
    expect(delfx).toContain('case k_user_delfx_param_time: time01_ = v; break;')
    expect(delfx).toContain('case k_user_delfx_param_depth: depth01_ = v; break;')
    expect(delfx).toContain('case k_user_delfx_param_shift_depth: mix01_ = v; break;')
    expect(generateOldGenFxUnit(passThrough('modfx'), { name: 'p' }).fxCpp).not.toContain(
      'mix01_ = v'
    )
  })

  it('drives a param bound to Shift+Depth, starting where it was authored', () => {
    const { fxCpp } = generateOldGenFxUnit(
      mixedLowpass({ name: 'FADE', value: '100', logueKnob: { 'minilogue-xd': 'mix' } }),
      { name: 'lp' }
    )
    expect(fxCpp).toMatch(/mix01_ = 1\.f?;/)
    expect(fxCpp).toContain('fadePercent_x = (0.f + mix01_ * 100.f);')
  })

  it('pulls the tempo each block', () => {
    const { fxCpp } = generateOldGenFxUnit(passThrough('modfx'), { name: 'p' })
    expect(fxCpp).toContain('const float bpm = fx_get_bpmf();')
    expect(fxCpp).toContain('if (bpm > 0.f) tempo_ = bpm;')
  })

  it('never reaches for the oscillator API', () => {
    const sine = doc(
      [IN, obj('s', 'logue/osc/sine'), obj('m', 'logue/math/multiply'), OUT],
      [wire('in', 'mono', 'm', 'in1'), wire('s', 'out', 'm', 'in2'), wire('m', 'out', 'out', 'l')],
      'modfx'
    )
    const fx = generateOldGenFxUnit(sine, { name: 'ring' })
    for (const text of [fx.fxCpp, fx.unitC, fx.makefile]) {
      expect(text).not.toContain('userosc.h')
      expect(text).not.toContain('osc_api')
    }
    expect(fx.fxCpp).toContain('#define osc_sinf fx_sinf')
    expect(fx.fxCpp).toContain('note_ = 60.f;')
  })

  it('refuses a menu param (an xd effect has none) and a knob the module lacks', () => {
    expect(() =>
      generateOldGenFxUnit(
        mixedLowpass({ name: 'FADE', value: '50', logueParamIndex: { 'minilogue-xd': 0 } }),
        { name: 'lp' }
      )
    ).toThrow(/has no menu params on this platform -- put it on one of the panel knobs/)
    expect(() =>
      generateOldGenFxUnit(
        mixedLowpass({ name: 'FADE', value: '50', logueKnob: { 'minilogue-xd': 'mix' } }, 'modfx'),
        { name: 'lp' }
      )
    ).toThrow(/this kind of unit/)
  })

  it('refuses an oscillator document', () => {
    expect(() => generateOldGenFxUnit(passThrough('osc'), { name: 'p' })).toThrow(
      /oscillator patch -- it builds with generateOldGenOscUnit/
    )
  })

  it('places SDRAM lines in one static __sdram block, cleared in init and on resume', () => {
    const d = doc(
      [IN, obj('d', 'logue/util/long-delay', [{ name: 'RANGE', value: '0' }]), OUT],
      [wire('in', 'l', 'd', 'in'), wire('d', 'out', 'out', 'l')]
    )
    const { fxCpp } = generateOldGenFxUnit(d, { name: 'd' })
    expect(fxCpp).toContain('static float s_sdram[16384] __sdram;')
    expect(fxCpp).toContain('sdram_d = s_sdram + 0;')
    expect(fxCpp).toContain('for (uint32_t i = 0; i < 16384u; ++i) s_sdram[i] = 0.f;')
    expect(fxCpp).toContain('void DELFX_RESUME(void) { s_fx.reset(); }')
  })

  it("refuses more SDRAM than a modfx's 128 KB", () => {
    const d = doc(
      [IN, obj('d', 'logue/util/long-delay', [{ name: 'RANGE', value: '1' }]), OUT],
      [wire('in', 'l', 'd', 'in'), wire('d', 'out', 'out', 'l')],
      'modfx'
    )
    expect(() => generateOldGenFxUnit(d, { name: 'd' })).toThrow(
      /need 256 KB of SDRAM, more than a minilogue xd modulation effect unit's 128 KB/
    )
  })

  it('estimates RAM against the SRAM region, with the measured pass-through', () => {
    const est = estimateOscStateCost(passThrough('modfx'), 'minilogue-xd')
    if (est.status !== 'ok') throw new Error(est.reason)
    expect(est.estimate.budgetBytes).toBe(6 * 1024)
    expect(est.estimate.codeBaselineBytes + est.estimate.baselineBytes).toBe(464)
    expect(findUnitKind('minilogue-xd', 'delfx')!.fixedCodeBytes! + 24).toBe(440)
  })

  it('lays the whole project out for Export and Build', () => {
    const project = generateMinilogueXdProject(passThrough('revfx'), 'pass')
    expect(project.project).toBe('fx')
    expect(Object.keys(project.files).sort()).toEqual([
      'Makefile',
      'fx.cpp',
      'ld/main_api.syms',
      'ld/rules.ld',
      'ld/userrevfx.ld',
      'manifest.json',
      'project.mk',
      'tpl/_unit.c'
    ])
    expect(project.files['project.mk']).toContain('UCXXSRC = fx.cpp')
    const osc: PatchDocument = {
      nodes: [obj('s', 'logue/osc/sine'), OUT],
      nets: [wire('s', 'out', 'out', 'in')],
      settings: {},
      notes: ''
    }
    expect(generateMinilogueXdProject(osc, 'o')).toMatchObject({ project: 'osc', module: 'osc' })
    expect(Object.keys(generateMinilogueXdProject(osc, 'o').files)).toContain('ld/userosc.ld')
  })

  it('matches the golden source for a pass-through modfx and a mixed lowpass', async () => {
    for (const [name, d] of [
      ['passthrough.modfx', passThrough('modfx')],
      [
        'mixed-lowpass.delfx',
        mixedLowpass({ name: 'FADE', value: '50', logueKnob: { 'minilogue-xd': 'mix' } })
      ]
    ] as const) {
      const fx = generateOldGenFxUnit(d, { name: 'golden' })
      const text = `// manifest.json\n${fx.manifestJson}\n// fx.cpp\n${fx.fxCpp}\n// tpl/_unit.c\n${fx.unitC}`
      await expect(text).toMatchFileSnapshot(join(snapshotDir, `${name}.minilogue-xd.txt`))
    }
  })
})

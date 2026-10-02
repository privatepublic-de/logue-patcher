import { describe, expect, it } from 'vitest'
import { parsePatchFile, PATCH_FILE_VERSION } from '@shared/json/patchCodec'
import type { ObjNode } from '@shared/domain/patch'
import { generateOldGenOscUnit } from '../logue-codegen/src/minilogue-xd/generateOscUnit'

function file(version: number, nodes: unknown[], nets: unknown[]): string {
  return JSON.stringify({ version, nodes, nets, settings: {}, notes: '' })
}
const obj = (name: string, type: string, params: unknown[] = []) => ({
  kind: 'obj',
  type,
  name,
  x: 0,
  y: 0,
  params
})
const wire = (from: string, outlet: string, to: string, inlet: string) => ({
  sources: [{ obj: from, outlet }],
  dests: [{ obj: to, inlet }]
})
const paramOf = (doc: ReturnType<typeof parsePatchFile>, node: string, param: string) =>
  (doc.nodes.find((n) => n.name === node) as ObjNode).params.find((p) => p.name === param)

describe('v3 -> v4: former replace inlets become additive', () => {
  it('writes version 4', () => {
    expect(PATCH_FILE_VERSION).toBe(4)
  })

  it("sets a wired inlet's dial to 0, keeping the param's other fields", () => {
    const doc = parsePatchFile(
      file(
        3,
        [
          obj('lfo', 'logue/lfo/sine-lfo'),
          obj('f', 'logue/filter/svf', [
            { name: 'CUTOFF', value: '50', logueParamIndex: { nts1mkii: 3 } },
            { name: 'RESONANCE', value: '59' }
          ])
        ],
        [wire('lfo', 'out', 'f', 'cutoff')]
      )
    )
    expect(paramOf(doc, 'f', 'CUTOFF')).toEqual({
      name: 'CUTOFF',
      value: '0',
      logueParamIndex: { nts1mkii: 3 }
    })
    expect(paramOf(doc, 'f', 'RESONANCE')?.value).toBe('59')
  })

  it('adds a 0 entry when the file relied on the default, for every former replace inlet', () => {
    const cases: [string, string, string][] = [
      ['logue/filter/lowpass', 'cutoff', 'CUTOFF'],
      ['logue/filter/lowpass-cheap', 'cutoff', 'CUTOFF'],
      ['logue/filter/highpass-cheap', 'cutoff', 'CUTOFF'],
      ['logue/filter/svf', 'cutoff', 'CUTOFF'],
      ['logue/mix/crossfader', 'fade', 'FADE'],
      ['logue/osc/additive', 'timbre', 'TIMBRE']
    ]
    for (const [type, inlet, param] of cases) {
      const doc = parsePatchFile(
        file(
          3,
          [obj('src', 'logue/lfo/sine-lfo'), obj('n', type)],
          [wire('src', 'out', 'n', inlet)]
        )
      )
      expect(paramOf(doc, 'n', param)?.value, type).toBe('0')
    }
  })

  it('leaves unwired inlets, other inlets, still-replacing inlets and v4 files alone', () => {
    const nodes = [
      obj('lfo', 'logue/lfo/sine-lfo'),
      obj('unwired', 'logue/filter/svf', [{ name: 'CUTOFF', value: '50' }]),
      obj('res', 'logue/filter/svf', [{ name: 'CUTOFF', value: '50' }]),
      obj('vca', 'logue/gain/vca', [{ name: 'GAIN', value: '25' }])
    ]
    const nets = [wire('lfo', 'out', 'res', 'resonance'), wire('lfo', 'out', 'vca', 'gain')]
    const v3 = parsePatchFile(file(3, nodes, nets))
    expect(paramOf(v3, 'unwired', 'CUTOFF')?.value).toBe('50')
    expect(paramOf(v3, 'res', 'CUTOFF')?.value).toBe('50')
    expect(paramOf(v3, 'vca', 'GAIN')?.value).toBe('25')
    const v4 = parsePatchFile(file(4, nodes, [wire('lfo', 'out', 'unwired', 'cutoff')]))
    expect(paramOf(v4, 'unwired', 'CUTOFF')?.value).toBe('50')
  })

  it('a migrated v3 file generates what the old replace inlet computed', () => {
    const doc = parsePatchFile(
      file(
        3,
        [
          obj('osc', 'logue/osc/saw'),
          obj('lfo', 'logue/lfo/sine-lfo'),
          obj('f', 'logue/filter/lowpass-cheap', [{ name: 'CUTOFF', value: '80' }]),
          obj('out', 'logue/io/audio-out')
        ],
        [
          wire('osc', 'out', 'f', 'in'),
          wire('lfo', 'out', 'f', 'cutoff'),
          wire('f', 'out', 'out', 'in')
        ]
      )
    )
    const cpp = generateOldGenOscUnit(doc, { name: 'migrated' }).oscCpp
    // cutoff_warp clamps to 0..1 itself, and 0 + x is exactly x, so this is the old cutoff_warp(y_lfo)
    expect(cpp).toContain('cutoff_warp((cutoff_f + (y_lfo)))')
    expect(cpp).toContain('cutoff_f = 0 * 0.01f;')
  })
})

import { describe, it, expect } from 'vitest'
import { generateOscUnit } from '../logue-codegen/src/nts1mkii/generateOscUnit'
import { generateOldGenOscUnit } from '../logue-codegen/src/minilogue-xd/generateOscUnit'
import { findLoguePrimitive, outletPolarityOf } from '../logue-codegen/src/primitives'
import { LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import type { Net, ObjNode, PatchDocument } from '../src/shared/domain/patch'

function node(type: string, name: string, params: ObjNode['params'] = []): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params }
}
function net(from: string, outlet: string, to: string, inlet: string): Net {
  return { sources: [{ obj: from, outlet }], dests: [{ obj: to, inlet }] }
}
function doc(nodes: ObjNode[], nets: Net[]): PatchDocument {
  return { nodes: [...nodes, node(LOGUE_AUDIO_OUT_TYPE, 'out')], nets, settings: {}, notes: '' }
}

const mseg = findLoguePrimitive('logue/env/multistage')!

describe('logue/env/multistage', () => {
  it('colours its envelope outlet bipolar and its eoc outlet as a gate', () => {
    expect(outletPolarityOf(mseg, 'env').declared).toBe('bipolar')
    expect(outletPolarityOf(mseg, 'eoc').declared).toBe('gate')
  })

  it('reads an unlabelled wire as the envelope outlet', () => {
    const src = generateOldGenOscUnit(
      doc([node('logue/env/multistage', 'e')], [net('e', 'out', 'out', 'in')]),
      { name: 'env' }
    ).oscCpp
    expect(src).toContain('y_e_env')
  })

  it('follows the played note unless gate is wired, and then ignores note-on', () => {
    const played = generateOldGenOscUnit(
      doc([node('logue/env/multistage', 'e')], [net('e', 'env', 'out', 'in')]),
      { name: 'env' }
    ).oscCpp
    expect(played).toMatch(/mseg_step\([^;]*noteHeld_e,/)
    expect(played).not.toContain('retrig_e = 0;\n      float y_e_env')

    const gated = generateOldGenOscUnit(
      doc(
        [node('logue/lfo/square-lfo', 'lfo'), node('logue/env/multistage', 'e')],
        [net('lfo', 'out', 'e', 'gate'), net('e', 'env', 'out', 'in')]
      ),
      { name: 'env' }
    ).oscCpp
    expect(gated).toMatch(/retrig_e = 0;\n\s*float y_e_env = mseg_step\([^;]*y_lfo,/)
  })

  it('shows mode names on the NTS-1 mkII when MODE is exposed', () => {
    const { unitCc } = generateOscUnit(
      doc(
        [
          node('logue/env/multistage', 'e', [
            { name: 'MODE', value: '2', logueParamIndex: { nts1mkii: 2 } }
          ])
        ],
        [net('e', 'env', 'out', 'in')]
      ),
      { name: 'env' }
    )
    expect(unitCc).toContain('{"OneShot", "Sustain", "Loop", "Cycle"}')
  })

  it('converts the six stage times where they are set, never in process', () => {
    const src = generateOldGenOscUnit(
      doc([node('logue/env/multistage', 'e')], [net('e', 'env', 'out', 'in')]),
      { name: 'env' }
    ).oscCpp
    for (let i = 0; i < 6; i++) {
      expect(src).toContain(`stageRate_e[${i}] = mseg_rate_from_percent(`)
    }
    const process = src.slice(src.indexOf('void process'), src.indexOf('static float'))
    expect(process).not.toContain('mseg_rate_from_percent')
  })
})

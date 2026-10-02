import { describe, it, expect } from 'vitest'
import { generateOldGenOscUnit } from '../logue-codegen/src/minilogue-xd/generateOscUnit'
import { generateOscUnit } from '../logue-codegen/src/nts1mkii/generateOscUnit'
import { generateFxUnit } from '../logue-codegen/src/nts1mkii/generateFxUnit'
import { findLoguePrimitive, recognizedLoguePrimitiveIds } from '../logue-codegen/src/primitives'
import { testSampleFor } from './support/testSample'
import { LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import type { Net, ObjNode, PatchDocument } from '../src/shared/domain/patch'

/**
 * Knob-only math is computed once per block (`oscBody.ts`' `hoistedSuffixes`): pure instances
 * whose inputs are all per-block values, and the conversions of whatever reads them.
 */
function obj(type: string, name: string, params: ObjNode['params'] = []): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params }
}
function net(from: string, outlet: string, to: string, inlet: string): Net {
  return { sources: [{ obj: from, outlet }], dests: [{ obj: to, inlet }] }
}
function doc(nodes: ObjNode[], nets: Net[]): PatchDocument {
  return {
    nodes: [...nodes, obj(LOGUE_AUDIO_OUT_TYPE, 'audio-out')],
    nets,
    settings: {},
    notes: ''
  }
}
/** The process body split at its sample loop: [before the loop, the loop]. */
function split(oscCpp: string): [string, string] {
  const body = oscCpp.slice(oscCpp.indexOf('void process'))
  const loop = body.indexOf('for (uint32_t i = 0; i < frames; ++i)')
  return [body.slice(0, loop), body.slice(loop)]
}

describe('per-block computation of knob-only math', () => {
  // A control (per block) scaled and added to a constant, into an envelope's decay; an LFO
  // (per sample) through another scale into its attack.
  const patch = doc(
    [
      obj('logue/sense/control', 'knob', [{ name: 'VALUE', value: '40' }]),
      obj('logue/math/scale', 'half', [{ name: 'FACTOR', value: '50' }]),
      obj('logue/util/constant', 'c', [{ name: 'VALUE', value: '10' }]),
      obj('logue/math/add', 'sum'),
      obj('logue/lfo/sine-lfo', 'lfo'),
      obj('logue/math/scale', 'wobble', [{ name: 'FACTOR', value: '20' }]),
      obj('logue/env/ad', 'env')
    ],
    [
      net('knob', 'unipolar', 'half', 'in'),
      net('half', 'out', 'sum', 'a'),
      net('c', 'out', 'sum', 'b'),
      net('sum', 'out', 'env', 'decay'),
      net('lfo', 'out', 'wobble', 'in'),
      net('wobble', 'out', 'env', 'attack'),
      net('env', 'out', 'audio-out', 'in')
    ]
  )
  const [before, loop] = split(generateOldGenOscUnit(patch, { name: 'hoist' }).oscCpp)

  it('moves a chain of pure nodes fed only by knobs and constants out of the sample loop', () => {
    for (const v of ['y_knob_unipolar', 'y_half', 'y_c', 'y_sum']) {
      expect(before, v).toContain(`float ${v} =`)
      expect(loop, v).not.toContain(`float ${v} =`)
    }
  })

  it('keeps a pure node fed by a per-sample signal in the loop', () => {
    expect(loop).toContain('float y_wobble =')
    expect(before).not.toContain('float y_wobble =')
  })

  it("makes a reader's conversion a block constant only for a per-block input", () => {
    expect(before).toContain(
      'const float blkDecayRate_env = env_rate_from_percent(clampf(decayPercent_env + (y_sum) * 50.f'
    )
    expect(loop).toContain(
      'env_rate_ctl(&attackCtl_env, &attackRate_env, attackPercent_env + (y_wobble) * 50.f)'
    )
  })

  // With every inlet wired from a constant (a per-block value), whatever a primitive computes
  // before the loop must not name a variable only the loop declares (freq-shift's sh_ local did,
  // 2026-10-01: an oscillator with its shift wired from a constant stopped compiling).
  it('never makes a block constant read a loop-local, for any primitive', () => {
    for (const id of recognizedLoguePrimitiveIds()) {
      const p = findLoguePrimitive(id)!
      // util/buffer's outlet is a buffer wire, not a signal; its inputs are read after the loop.
      if (p.supersededBy || !p.inlets?.length || id === 'logue/util/buffer') continue
      const effect = !!p.modules && !p.modules.includes('osc')
      const nodes: ObjNode[] = [
        {
          ...obj(id, 'n'),
          sample: testSampleFor(p)
        }
      ]
      const nets: Net[] = []
      for (const inlet of p.inlets) {
        if (inlet.role === 'buffer') {
          nodes.push(obj('logue/util/buffer', `c_${inlet.name}`))
          nets.push(net(`c_${inlet.name}`, 'buf', 'n', inlet.name))
        } else {
          nodes.push(
            obj('logue/util/constant', `c_${inlet.name}`, [{ name: 'VALUE', value: '37' }])
          )
          nets.push(net(`c_${inlet.name}`, 'out', 'n', inlet.name))
        }
      }
      nets.push(net('n', p.outlets?.[0]?.name ?? 'out', 'audio-out', effect ? 'l' : 'in'))
      const d: PatchDocument = {
        nodes: [...nodes, obj(LOGUE_AUDIO_OUT_TYPE, 'audio-out')],
        nets,
        settings: effect ? { logueTarget: { module: 'delfx' } } : {},
        notes: ''
      }
      const source = effect
        ? generateFxUnit(d, { name: 'h' }).fxH
        : p.platforms && !p.platforms.includes('nts1mkii')
          ? generateOldGenOscUnit(d, { name: 'h' }).oscCpp
          : generateOscUnit(d, { name: 'h' }).oscH
      const body = source.slice(source.indexOf('void process'))
      const at = body.indexOf('for (uint32_t i = 0; i < frames; ++i)')
      // The loop up to the end of process (members declared further down aren't locals).
      const [before, loop] = [body.slice(0, at), body.slice(at, body.indexOf('\n  }\n', at))]
      const loopLocals = [...loop.matchAll(/\bfloat (\w+)(?: =|;)/g)].map((m) => m[1])
      for (const local of loopLocals) {
        expect(before, `${id}: ${local}`).not.toMatch(new RegExp(`\\b${local}\\b`))
      }
    }
  })
})

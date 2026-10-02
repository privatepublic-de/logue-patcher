import { describe, it, expect } from 'vitest'
import { findLoguePrimitive, recognizedLoguePrimitiveIds } from '../logue-codegen/src/primitives'
import { resolveAudioGraph, LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import { generateOscUnit } from '../logue-codegen/src/nts1mkii/generateOscUnit'
import { generateOldGenOscUnit } from '../logue-codegen/src/minilogue-xd/generateOscUnit'
import { estimateOscStateCost } from '../logue-codegen/src/estimateOscStateCost'
import type { Net, ObjNode, PatchDocument } from '../src/shared/domain/patch'

function obj(type: string, name: string): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params: [] }
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

/** A sine fed back into its own fm through a one-sample delay -- the basic feedback-FM patch. */
const feedbackFm = doc(
  [obj('logue/osc/sine', 'op'), obj('logue/util/sample-delay', 'z')],
  [net('op', 'out', 'audio-out', 'in'), net('op', 'out', 'z', 'in'), net('z', 'out', 'op', 'fm')]
)

describe('feedback through logue/util/sample-delay', () => {
  it('never reads a delayed inlet in the per-sample compute step', () => {
    for (const id of recognizedLoguePrimitiveIds()) {
      const p = findLoguePrimitive(id)!
      for (const name of p.delayedInlets ?? []) {
        const inlets = { [name]: '__DELAYED_INLET__' }
        const compute = p.renderOutletStatements
          ? p.renderOutletStatements('x', inlets)
          : p.renderExpr('x', inlets)
        expect(compute, `${id} ${name}`).not.toContain('__DELAYED_INLET__')
        expect(p.advanceStatement('x', inlets), `${id} ${name}`).toContain('__DELAYED_INLET__')
      }
    }
  })

  it('resolves a loop through a delay, reading last sample into the fm input', () => {
    const graph = resolveAudioGraph(feedbackFm)
    expect(graph.activeInstances.map((i) => i.node.name).sort()).toEqual(['op', 'z'])
    const op = graph.activeInstances.find((i) => i.node.name === 'op')!
    const z = graph.activeInstances.find((i) => i.node.name === 'z')!
    expect(op.inletSources.fm).toEqual({ suffix: z.suffix, outlet: 'out' })
    expect(z.inletSources.in).toEqual({ suffix: op.suffix, outlet: 'out' })

    const { oscH } = generateOscUnit(feedbackFm, { name: 'fb' })
    const loop = oscH.slice(oscH.indexOf('for (uint32_t i = 0; i < frames; ++i)'))
    const store = loop.indexOf(`z_${z.suffix} = sample_delay_store(y_${op.suffix});`)
    expect(store).toBeGreaterThan(loop.indexOf(`float y_${op.suffix} =`))
    expect(generateOldGenOscUnit(feedbackFm, { name: 'fb' }).oscCpp).toContain(
      'sample_delay_store('
    )
  })

  it('still rejects a loop that has no delay in it, and says what to add', () => {
    const direct = doc(
      [obj('logue/osc/sine', 'a'), obj('logue/osc/sine', 'b')],
      [net('a', 'out', 'audio-out', 'in'), net('a', 'out', 'b', 'fm'), net('b', 'out', 'a', 'fm')]
    )
    expect(() => resolveAudioGraph(direct)).toThrow(/sample-delay/)
  })

  it('follows sources reachable only through delays, including a delay behind a delay', () => {
    const chained = doc(
      [
        obj('logue/util/sample-delay', 'z1'),
        obj('logue/util/sample-delay', 'z2'),
        obj('logue/osc/saw', 'src')
      ],
      [
        net('z1', 'out', 'audio-out', 'in'),
        net('z2', 'out', 'z1', 'in'),
        net('src', 'out', 'z2', 'in')
      ]
    )
    const graph = resolveAudioGraph(chained)
    expect(graph.activeInstances.map((i) => i.node.name).sort()).toEqual(['src', 'z1', 'z2'])
    expect(() => generateOscUnit(chained, { name: 'chain' })).not.toThrow()
  })

  it('still reports fan-in into a delay', () => {
    const fanIn = doc(
      [obj('logue/util/sample-delay', 'z'), obj('logue/osc/saw', 'a'), obj('logue/osc/saw', 'b')],
      [net('z', 'out', 'audio-out', 'in'), net('a', 'out', 'z', 'in'), net('b', 'out', 'z', 'in')]
    )
    expect(() => resolveAudioGraph(fanIn)).toThrow()
  })

  it('counts the delay state in the RAM estimate', () => {
    const cost = estimateOscStateCost(feedbackFm, 'minilogue-xd')
    expect(cost.status).toBe('ok')
    if (cost.status === 'ok') {
      const delay = cost.estimate.perInstance.find(
        (i) => i.primitiveId === 'logue/util/sample-delay'
      )
      expect(delay?.bytes).toBe(4)
    }
  })
})

describe('logue/sense/velocity', () => {
  const withVelocity = doc(
    [obj('logue/sense/velocity', 'vel'), obj('logue/gain/vca', 'amp'), obj('logue/osc/saw', 'src')],
    [
      net('src', 'out', 'amp', 'in'),
      net('vel', 'unipolar', 'amp', 'gain'),
      net('amp', 'out', 'audio-out', 'in')
    ]
  )

  it('latches the NTS-1 mkII note-on velocity as 0..1', () => {
    const { oscH } = generateOscUnit(withVelocity, { name: 'vel' })
    expect(oscH).toContain('void noteOn(uint8_t, uint8_t velo) override final')
    expect(oscH).toMatch(/velocity01_\w+ = \(float\)velo \* \(1\.f \/ 127\.f\);/)
  })

  it('leaves the velocity parameter unnamed when nothing reads it', () => {
    expect(generateOscUnit(feedbackFm, { name: 'fb' }).oscH).toContain(
      'void noteOn(uint8_t, uint8_t) override final'
    )
  })

  it('is rejected on the minilogue xd, which gives oscillators no velocity', () => {
    expect(() => generateOldGenOscUnit(withVelocity, { name: 'vel' })).toThrow(/isn't supported/)
  })
})

describe('block constants (values computed once per block)', () => {
  it('never read a wired inlet -- that would freeze a per-sample signal for a whole block', () => {
    for (const id of recognizedLoguePrimitiveIds()) {
      const p = findLoguePrimitive(id)!
      if (!p.blockConstants) continue
      const wired = Object.fromEntries((p.inlets ?? []).map((i) => [i.name, `__IN_${i.name}__`]))
      for (const c of p.blockConstants('x', wired)) {
        expect(c.expr, `${id} ${c.name}`).not.toMatch(/__IN_|\by_/)
      }
      for (const c of p.blockConstants('x', {})) {
        expect(c.expr, `${id} ${c.name}`).not.toMatch(/\by_/)
      }
    }
  })

  it('are declared before the sample loop and referenced inside it', () => {
    const svf = doc(
      [obj('logue/osc/saw', 'src'), obj('logue/filter/svf', 'f')],
      [net('src', 'out', 'f', 'in'), net('f', 'lp', 'audio-out', 'in')]
    )
    const { oscCpp } = generateOldGenOscUnit(svf, { name: 'svf' })
    const loop = oscCpp.indexOf(
      'for (uint32_t i = 0; i < frames; ++i)',
      oscCpp.indexOf('void process')
    )
    const decl = oscCpp.indexOf('const float blkSvfG_')
    expect(decl).toBeGreaterThan(oscCpp.indexOf('void process'))
    expect(decl).toBeLessThan(loop)
    expect(oscCpp.slice(loop)).toMatch(/float svfG_\w+ = blkSvfG_\w+;/)
  })
})

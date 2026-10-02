import { describe, it, expect } from 'vitest'
import { normalizeRenamedFields } from '../logue-codegen/src/renamedFields'
import type { Net, ObjNode, PatchDocument } from '../src/shared/domain/patch'

function node(type: string, name: string, params: ObjNode['params'] = []): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params }
}
function net(from: string, to: string, inlet: string): Net {
  return { sources: [{ obj: from, outlet: 'out' }], dests: [{ obj: to, inlet }] }
}
function doc(nodes: ObjNode[], nets: Net[]): PatchDocument {
  return { nodes, nets, settings: {}, notes: '' }
}

describe('normalizeRenamedFields', () => {
  it('opens a comb saved as CUTOFF/GAIN with TUNE/FEEDBACK, keeping values, device slots and wires', () => {
    const before = doc(
      [
        node('logue/lfo/sine-lfo', 'lfo'),
        node('logue/filter/comb', 'comb', [
          { name: 'CUTOFF', value: '30', logueParamIndex: { 'minilogue-xd': 0, nts1mkii: 3 } },
          { name: 'GAIN', value: '85', label: 'Ring' }
        ])
      ],
      [net('lfo', 'comb', 'cutoff'), net('lfo', 'comb', 'gain')]
    )
    const after = normalizeRenamedFields(before)
    expect((after.nodes[1] as ObjNode).params).toEqual([
      { name: 'TUNE', value: '30', logueParamIndex: { 'minilogue-xd': 0, nts1mkii: 3 } },
      { name: 'FEEDBACK', value: '85', label: 'Ring' }
    ])
    expect(after.nets.map((n) => n.dests[0].inlet)).toEqual(['tune', 'feedback'])
  })

  it('leaves a meaning-changing alias (DELAY/delay) for the unresolved-reference warning', () => {
    const before = doc(
      [
        node('logue/lfo/sine-lfo', 'lfo'),
        node('logue/filter/comb', 'comb', [{ name: 'DELAY', value: '20' }])
      ],
      [net('lfo', 'comb', 'delay')]
    )
    expect(normalizeRenamedFields(before)).toBe(before)
  })

  it('does not rename a param when the current name is stored too', () => {
    const params = [
      { name: 'GAIN', value: '10' },
      { name: 'FEEDBACK', value: '70' }
    ]
    const before = doc([node('logue/filter/comb', 'comb', params)], [])
    expect(normalizeRenamedFields(before)).toBe(before)
  })

  it('rewrites an old primitive id to the current one', () => {
    const after = normalizeRenamedFields(doc([node('logue/mix/ringmod', 'rm')], []))
    expect(after.nodes[0]).toMatchObject({ type: 'logue/math/multiply' })
  })

  it('opens the two old sample-and-hold ids under their new names', () => {
    const after = normalizeRenamedFields(
      doc([node('logue/lfo/sample-hold', 'a'), node('logue/util/trig-hold', 'b')], [])
    )
    expect(after.nodes.map((n) => (n as ObjNode).type)).toEqual([
      'logue/lfo/random-steps',
      'logue/util/sample-hold'
    ])
  })

  it('only renames inlets on the node the alias belongs to', () => {
    const before = doc(
      [node('logue/lfo/sine-lfo', 'lfo'), node('logue/gain/vca', 'vca')],
      [net('lfo', 'vca', 'gain')]
    )
    expect(normalizeRenamedFields(before)).toBe(before)
  })
})

import { describe, it, expect } from 'vitest'
import { findUnresolvedReferences } from '../logue-codegen/src/unresolvedReferences'
import { LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import type { ObjNode, PatchDocument } from '../src/shared/domain/patch'

function combNode(name: string, params: ObjNode['params'] = []): ObjNode {
  return { kind: 'obj', type: 'logue/filter/comb', name, x: 0, y: 0, params }
}

function docWith(node: ObjNode, nets: PatchDocument['nets'] = []): PatchDocument {
  return { nodes: [node], nets, settings: {}, notes: '' }
}

describe('findUnresolvedReferences', () => {
  it('reports nothing for a fully current node with no wiring', () => {
    expect(findUnresolvedReferences(docWith(combNode('comb1')), combNode('comb1'))).toEqual([])
  })

  it('flags a totally unrecognized type and checks nothing else', () => {
    const node: ObjNode = {
      kind: 'obj',
      type: 'logue/nope/made-up',
      name: 'n1',
      x: 0,
      y: 0,
      params: []
    }
    expect(findUnresolvedReferences(docWith(node), node)).toEqual([
      { kind: 'unrecognized-type', rawName: 'logue/nope/made-up' }
    ])
  })

  it('flags a type resolvable only via RENAMED_PRIMITIVE_IDS as informational, not broken', () => {
    const node: ObjNode = {
      kind: 'obj',
      type: 'logue/sense/shift-shape',
      name: 'n1',
      x: 0,
      y: 0,
      params: []
    }
    expect(findUnresolvedReferences(docWith(node), node)).toEqual([
      { kind: 'renamed-type', rawName: 'logue/sense/shift-shape', renamedTo: 'logue/sense/shape-2' }
    ])
  })

  it('does not flag a value-preserving stale param name (GAIN, silently resolves)', () => {
    const node = combNode('comb1', [{ name: 'GAIN', value: '80' }])
    expect(findUnresolvedReferences(docWith(node), node)).toEqual([])
  })

  it('flags a non-value-preserving stale param name (DELAY) with its rename target and note', () => {
    const node = combNode('comb1', [{ name: 'DELAY', value: '20' }])
    const results = findUnresolvedReferences(docWith(node), node)
    expect(results).toHaveLength(1)
    expect(results[0].kind).toBe('stale-param')
    expect(results[0].rawName).toBe('DELAY')
    expect(results[0].renamedTo).toBe('TUNE')
    expect(results[0].note).toMatch(/inverted/)
  })

  it('flags a param name with no alias at all as stale, with no renamedTo/note', () => {
    const node = combNode('comb1', [{ name: 'RESONANCE', value: '5' }])
    expect(findUnresolvedReferences(docWith(node), node)).toEqual([
      { kind: 'stale-param', rawName: 'RESONANCE' }
    ])
  })

  it('does not flag a value-preserving stale wired inlet name (feedback, silently resolves)', () => {
    const node = combNode('comb1')
    const doc = docWith(node, [
      { sources: [{ obj: 'env1', outlet: 'out' }], dests: [{ obj: 'comb1', inlet: 'feedback' }] }
    ])
    expect(findUnresolvedReferences(doc, node)).toEqual([])
  })

  it('flags a non-value-preserving stale wired inlet name (delay) with its rename target and note', () => {
    const node = combNode('comb1')
    const doc = docWith(node, [
      { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'comb1', inlet: 'delay' }] }
    ])
    const results = findUnresolvedReferences(doc, node)
    expect(results).toHaveLength(1)
    expect(results[0].kind).toBe('stale-inlet')
    expect(results[0].rawName).toBe('delay')
    expect(results[0].renamedTo).toBe('tune')
    expect(results[0].note).toMatch(/inverted/)
  })

  it('never flags the audio-out pseudo-object as unrecognized -- it deliberately has no registry entry', () => {
    const node: ObjNode = {
      kind: 'obj',
      type: LOGUE_AUDIO_OUT_TYPE,
      name: 'out',
      x: 0,
      y: 0,
      params: []
    }
    expect(findUnresolvedReferences(docWith(node), node)).toEqual([])
  })

  it('a net wired to a different node is not attributed to this one', () => {
    const node = combNode('comb1')
    const doc = docWith(node, [
      {
        sources: [{ obj: 'lfo1', outlet: 'out' }],
        dests: [{ obj: 'someOtherNode', inlet: 'delay' }]
      }
    ])
    expect(findUnresolvedReferences(doc, node)).toEqual([])
  })
})

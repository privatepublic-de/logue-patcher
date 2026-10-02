import { describe, it, expect } from 'vitest'
import {
  assertPrimitivesSupportModule,
  LOGUE_AUDIO_IN_TYPE,
  LOGUE_AUDIO_OUT_TYPE,
  resolveAudioGraph,
  UnsupportedLogueNodeError
} from '../logue-codegen/src/oscInstances'
import { resolvePlatformGraph } from '../logue-codegen/src/resolveUnit'
import {
  createSubpatchAwareResolver,
  flattenSubpatches,
  type SubpatchDefinitions
} from '../logue-codegen/src/subpatches'
import { findLoguePrimitive } from '../logue-codegen/src/primitives'
import { findUnresolvedReferences } from '../logue-codegen/src/unresolvedReferences'
import type { LogueModule, Net, ObjNode, PatchDocument } from '../src/shared/domain/patch'

function obj(name: string, type: string): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params: [] }
}

function wire(from: string, outlet: string, to: string, inlet: string): Net {
  return { sources: [{ obj: from, outlet }], dests: [{ obj: to, inlet }] }
}

function doc(nodes: ObjNode[], nets: Net[], module: LogueModule = 'delfx'): PatchDocument {
  return { nodes, nets, settings: { logueTarget: { module } }, notes: '' }
}

const IN = obj('in', LOGUE_AUDIO_IN_TYPE)
const OUT = obj('out', LOGUE_AUDIO_OUT_TYPE)

describe('resolveAudioGraph in an effect document', () => {
  it('resolves a stereo pass-through with no primitive at all', () => {
    const graph = resolveAudioGraph(
      doc([IN, OUT], [wire('in', 'l', 'out', 'l'), wire('in', 'r', 'out', 'r')])
    )
    expect(graph.activeInstances).toEqual([])
    expect(graph.stereoSinks).toEqual({
      l: { suffix: 'in', outlet: 'l' },
      r: { suffix: 'in', outlet: 'r' }
    })
    expect(graph.audioInSuffix).toBe('in')
  })

  it('copies l to an unwired r, and reads audio-in like any source', () => {
    const graph = resolveAudioGraph(
      doc(
        [IN, obj('lp', 'logue/filter/lowpass-cheap'), OUT],
        [wire('in', 'mono', 'lp', 'in'), wire('lp', 'out', 'out', 'l')]
      )
    )
    expect(graph.activeInstances.map((i) => i.suffix)).toEqual(['lp'])
    expect(graph.activeInstances[0].inletSources.in).toEqual({ suffix: 'in', outlet: 'mono' })
    expect(graph.stereoSinks).toEqual({
      l: { suffix: 'lp', outlet: 'out' },
      r: { suffix: 'lp', outlet: 'out' }
    })
  })

  it('resolves two independent chains, one per side', () => {
    const graph = resolveAudioGraph(
      doc(
        [IN, obj('a', 'logue/filter/lowpass-cheap'), obj('b', 'logue/filter/highpass-cheap'), OUT],
        [
          wire('in', 'l', 'a', 'in'),
          wire('in', 'r', 'b', 'in'),
          wire('a', 'out', 'out', 'l'),
          wire('b', 'out', 'out', 'r')
        ]
      )
    )
    expect(graph.activeInstances.map((i) => i.suffix).sort()).toEqual(['a', 'b'])
    expect(graph.stereoSinks?.r).toEqual({ suffix: 'b', outlet: 'out' })
  })

  it('lets a feedback loop through sample-delay start from audio-in', () => {
    const graph = resolveAudioGraph(
      doc(
        [IN, obj('sum', 'logue/math/add'), obj('z', 'logue/util/sample-delay'), OUT],
        [
          wire('in', 'l', 'sum', 'a'),
          wire('z', 'out', 'sum', 'b'),
          wire('sum', 'out', 'z', 'in'),
          wire('sum', 'out', 'out', 'l')
        ]
      )
    )
    expect(graph.activeInstances.map((i) => i.suffix).sort()).toEqual(['sum', 'z'])
  })

  it('leaves audioInSuffix unset when nothing reads the input', () => {
    const graph = resolveAudioGraph(
      doc([IN, obj('n', 'logue/osc/noise'), OUT], [wire('n', 'out', 'out', 'l')])
    )
    expect(graph.audioInSuffix).toBeUndefined()
  })

  it.each([
    ['nothing on l', [wire('in', 'r', 'out', 'r')], /nothing on its "l" inlet/],
    ['the mono "in" inlet', [wire('in', 'l', 'out', 'in')], /output is stereo/],
    ['an outlet audio-in lacks', [wire('in', 'x', 'out', 'l')], /doesn't declare/]
  ])('rejects %s', (_label, nets, message) => {
    expect(() => resolveAudioGraph(doc([IN, OUT], nets))).toThrow(message)
  })

  it('rejects a second audio-in', () => {
    expect(() =>
      resolveAudioGraph(
        doc([IN, obj('in2', LOGUE_AUDIO_IN_TYPE), OUT], [wire('in', 'l', 'out', 'l')])
      )
    ).toThrow(/2 "logue\/io\/audio-in" nodes/)
  })
})

describe('resolveAudioGraph in an oscillator document', () => {
  it('rejects an audio-in', () => {
    expect(() =>
      resolveAudioGraph(
        doc([IN, obj('s', 'logue/osc/sine'), OUT], [wire('s', 'out', 'out', 'in')], 'osc')
      )
    ).toThrow(/an oscillator has none/)
  })

  it('keeps the mono sink and sets no stereo fields', () => {
    const graph = resolveAudioGraph(
      doc([obj('s', 'logue/osc/sine'), OUT], [wire('s', 'out', 'out', 'in')], 'osc')
    )
    expect(graph.sinkOutlet).toBe('out')
    expect(graph.stereoSinks).toBeUndefined()
    expect(graph.audioInSuffix).toBeUndefined()
  })
})

describe('module restrictions', () => {
  const noteReaders = [
    'logue/sense/pitch',
    'logue/sense/gate',
    'logue/sense/velocity',
    'logue/sense/shape',
    'logue/sense/shape-2',
    'logue/sense/cutoff',
    'logue/sense/resonance',
    'logue/sense/param'
  ]

  it.each(noteReaders)('marks %s as oscillator-only', (id) => {
    expect(findLoguePrimitive(id)!.modules).toEqual(['osc'])
  })

  it('leaves sense/control usable everywhere', () => {
    expect(findLoguePrimitive('logue/sense/control')!.modules).toBeUndefined()
  })

  it('rejects an oscillator-only primitive in an effect graph', () => {
    const graph = resolveAudioGraph(
      doc(
        [IN, obj('g', 'logue/sense/gate'), obj('v', 'logue/gain/vca'), OUT],
        [wire('in', 'l', 'v', 'in'), wire('g', 'out', 'v', 'gain'), wire('v', 'out', 'out', 'l')]
      )
    )
    expect(() => assertPrimitivesSupportModule(graph.activeInstances, 'delfx')).toThrow(
      UnsupportedLogueNodeError
    )
    expect(() => assertPrimitivesSupportModule(graph.activeInstances, 'delfx')).toThrow(
      /only works in oscillator units/
    )
    expect(() => assertPrimitivesSupportModule(graph.activeInstances, 'osc')).not.toThrow()
  })

  it('still builds an oscillator that uses one', () => {
    const osc = doc(
      [obj('p', 'logue/sense/pitch'), obj('s', 'logue/osc/sine'), OUT],
      [wire('p', 'bipolar', 's', 'pitch'), wire('s', 'out', 'out', 'in')],
      'osc'
    )
    expect(() => resolvePlatformGraph(osc, new Map(), 'nts1mkii')).not.toThrow()
  })
})

describe('subpatches and audio-in', () => {
  function definition(nodes: ObjNode[], nets: Net[]): PatchDocument {
    return { nodes, nets, settings: { subpatch: true }, notes: '' }
  }

  it("intersects the contents' modules", () => {
    const def = definition(
      [obj('i', 'logue/io/inlet'), obj('g', 'logue/sense/gate'), obj('o', 'logue/io/outlet')],
      [wire('g', 'out', 'o', 'in')]
    )
    const defs: SubpatchDefinitions = new Map([['sub/gated', def]])
    expect(createSubpatchAwareResolver(defs)('sub/gated')!.modules).toEqual(['osc'])
  })

  it('leaves a subpatch of generic primitives usable everywhere', () => {
    const def = definition(
      [
        obj('i', 'logue/io/inlet'),
        obj('lp', 'logue/filter/lowpass-cheap'),
        obj('o', 'logue/io/outlet')
      ],
      [wire('i', 'out', 'lp', 'in'), wire('lp', 'out', 'o', 'in')]
    )
    const defs: SubpatchDefinitions = new Map([['sub/lp', def]])
    expect(createSubpatchAwareResolver(defs)('sub/lp')!.modules).toBeUndefined()
  })

  it('rejects an audio-in inside a definition', () => {
    const def = definition([obj('x', LOGUE_AUDIO_IN_TYPE), obj('o', 'logue/io/outlet')], [])
    const root = doc([obj('s1', 'sub/withIn'), OUT], [wire('s1', 'o', 'out', 'l')])
    expect(() => flattenSubpatches(root, new Map([['sub/withIn', def]]))).toThrow(
      /takes audio in through "logue\/io\/inlet"/
    )
  })

  it('reports no unresolved references on the audio-in node itself', () => {
    const d = doc([IN, OUT], [wire('in', 'l', 'out', 'l')])
    expect(findUnresolvedReferences(d, IN)).toEqual([])
  })
})

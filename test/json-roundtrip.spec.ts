import { describe, expect, it } from 'vitest'
import {
  parsePatchFile,
  serializePatchFile,
  InvalidPatchFileError,
  PATCH_FILE_VERSION
} from '@shared/json/patchCodec'
import type { PatchDocument } from '@shared/domain/patch'

function sampleDoc(): PatchDocument {
  return {
    nodes: [
      { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 10, y: 20, params: [] },
      {
        kind: 'obj',
        type: 'logue/filter/formant',
        name: 'formant1',
        x: 100,
        y: 20,
        params: [
          { name: 'RESONANCE', value: '90', logueParamIndex: { 'minilogue-xd': 2 } },
          { name: 'VOWEL', value: '50' }
        ]
      },
      {
        kind: 'obj',
        type: 'logue/sense/param',
        name: 'param1',
        x: 200,
        y: 20,
        params: [{ name: 'VALUE', value: '60', label: 'Custom Label' }]
      },
      { kind: 'comment', type: 'patch/comment', x: 0, y: 0, text: 'hi' }
    ],
    nets: [
      { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'formant1', inlet: 'in' }] }
    ],
    settings: { logueTarget: { module: 'osc' }, unitName: 'My Cool Patch' },
    notes: 'some notes'
  }
}

describe('.loguepatch round-trip', () => {
  it('loads a legacy hyperlink node as a comment showing its target', () => {
    const text = JSON.stringify({
      version: 3,
      nodes: [
        { kind: 'hyperlink', type: 'patch/hyperlink', name: 'other.loguepatch', x: 5, y: 40 }
      ],
      nets: [],
      settings: {},
      notes: ''
    })
    expect(parsePatchFile(text).nodes).toEqual([
      { kind: 'comment', type: 'patch/comment', x: 5, y: 40, text: 'other.loguepatch' }
    ])
  })

  it('parse -> serialize -> parse is deep-equal', () => {
    const doc = sampleDoc()
    const doc2 = parsePatchFile(serializePatchFile(doc))
    expect(doc2).toEqual(doc)
  })

  // A real, disclosed past bug (see 565a2db): logueParamIndex/label are real ParamValue fields
  // but were once never wired into the XML codec's decode/encode at all, so an assigned device
  // param slot silently reverted to unset on the very next save+reopen. Pinned here so the same
  // class of gap can't reappear silently in the new codec.
  it('round-trips logueParamIndex and label on a param', () => {
    const doc = sampleDoc()
    const doc2 = parsePatchFile(serializePatchFile(doc))
    const formant = doc2.nodes.find((n) => n.name === 'formant1')
    expect(formant?.kind).toBe('obj')
    if (formant?.kind === 'obj') {
      expect(formant.params.find((p) => p.name === 'RESONANCE')?.logueParamIndex).toEqual({
        'minilogue-xd': 2
      })
    }
    const param1 = doc2.nodes.find((n) => n.name === 'param1')
    expect(param1?.kind).toBe('obj')
    if (param1?.kind === 'obj') {
      expect(param1.params.find((p) => p.name === 'VALUE')?.label).toBe('Custom Label')
    }
  })

  // Same bug class the logueParamIndex/label regression test above already guards against:
  // `settings.unitName` is a real, typed field -- pinned here so a future codec change can't
  // silently stop reading/writing it the way the old XML codec once did for logueParamIndex/label.
  it('round-trips settings.unitName', () => {
    const doc = sampleDoc()
    const doc2 = parsePatchFile(serializePatchFile(doc))
    expect(doc2.settings.unitName).toBe('My Cool Patch')
  })

  it('decodes a file with no settings.unitName to undefined rather than a made-up value', () => {
    const doc = sampleDoc()
    const raw = JSON.parse(serializePatchFile(doc))
    delete raw.settings.unitName
    expect(parsePatchFile(JSON.stringify(raw)).settings.unitName).toBeUndefined()
  })

  it('round-trips a subpatch definition marker and a promoted param', () => {
    const def: PatchDocument = {
      nodes: [
        {
          kind: 'obj',
          type: 'logue/filter/lowpass-cheap',
          name: 'lp',
          x: 0,
          y: 0,
          params: [{ name: 'CUTOFF', value: '40', subpatchExpose: { outerName: 'Cutoff' } }]
        }
      ],
      nets: [],
      settings: { subpatch: true },
      notes: ''
    }
    const doc2 = parsePatchFile(serializePatchFile(def))
    expect(doc2.settings.subpatch).toBe(true)
    const lp = doc2.nodes[0]
    expect(lp.kind === 'obj' && lp.params[0].subpatchExpose).toEqual({ outerName: 'Cutoff' })
    expect(parsePatchFile(serializePatchFile(sampleDoc())).settings.subpatch).toBeUndefined()
  })

  it('rejects a file with no version field', () => {
    expect(() => parsePatchFile(JSON.stringify({ nodes: [], nets: [], notes: '' }))).toThrow(
      InvalidPatchFileError
    )
  })

  it('rejects a file with an unsupported version', () => {
    const doc = sampleDoc()
    const raw = JSON.parse(serializePatchFile(doc))
    raw.version = PATCH_FILE_VERSION + 1
    expect(() => parsePatchFile(JSON.stringify(raw))).toThrow(InvalidPatchFileError)
  })

  // The first real migration this codec has ever needed.
  // logueParamIndex went from a flat number (v1, one slot for whichever platform the whole
  // document was committed to) to a per-platform map (v2). A v1 file must still open, migrated
  // in place -- and re-serializing it writes the CURRENT version, not the legacy one it came in
  // as, so a save-and-reopen doesn't keep re-migrating the same file forever.
  describe('v1 -> v2 logueParamIndex migration', () => {
    function v1FileText(logueTarget: unknown, logueParamIndex: number): string {
      return JSON.stringify({
        version: 1,
        nodes: [
          {
            kind: 'obj',
            type: 'logue/osc/pulse',
            name: 'pulse1',
            x: 0,
            y: 0,
            params: [{ name: 'WIDTH', value: '50', logueParamIndex }]
          }
        ],
        nets: [],
        settings: logueTarget === undefined ? {} : { logueTarget },
        notes: ''
      })
    }

    it("attributes a v1 file's flat index to the document's own committed platform", () => {
      const parsed = parsePatchFile(v1FileText({ platform: 'minilogue-xd', module: 'osc' }, 3))
      const node = parsed.nodes.find((n) => n.name === 'pulse1')
      expect(node?.kind).toBe('obj')
      if (node?.kind === 'obj') {
        expect(node.params[0].logueParamIndex).toEqual({ 'minilogue-xd': 3 })
      }
    })

    it('falls back to nts1mkii for a v1 file with no logueTarget at all', () => {
      const parsed = parsePatchFile(v1FileText(undefined, 1))
      const node = parsed.nodes.find((n) => n.name === 'pulse1')
      expect(node?.kind).toBe('obj')
      if (node?.kind === 'obj') {
        expect(node.params[0].logueParamIndex).toEqual({ nts1mkii: 1 })
      }
    })

    it('re-serializes a migrated v1 file at the current PATCH_FILE_VERSION, in the new map shape', () => {
      const parsed = parsePatchFile(v1FileText({ platform: 'nts1mkii', module: 'osc' }, 4))
      const raw = JSON.parse(serializePatchFile(parsed))
      expect(raw.version).toBe(PATCH_FILE_VERSION)
      expect(raw.nodes[0].params[0].logueParamIndex).toEqual({ nts1mkii: 4 })
    })
  })

  // `platform` is no longer part of the decoded
  // `LogueTargetSettings` shape at all, so a bogus/foreign one (e.g. from an old v1/v2 file, or a
  // hand-edited one) is simply never read for validity any more, unlike `module`.
  it('ignores an unrecognized logueTarget.platform value entirely -- module alone decides validity', () => {
    const doc = sampleDoc()
    const raw = JSON.parse(serializePatchFile(doc))
    raw.settings.logueTarget = { platform: 'bogus', module: 'osc' }
    expect(parsePatchFile(JSON.stringify(raw)).settings.logueTarget).toEqual({ module: 'osc' })
  })

  it('decodes an unrecognized logueTarget.module to undefined rather than a made-up value', () => {
    const doc = sampleDoc()
    const raw = JSON.parse(serializePatchFile(doc))
    raw.settings.logueTarget = { platform: 'minilogue-xd', module: 'bogus' }
    expect(parsePatchFile(JSON.stringify(raw)).settings.logueTarget).toBeUndefined()
  })

  it('rejects malformed JSON with a native SyntaxError', () => {
    expect(() => parsePatchFile('{not json')).toThrow(SyntaxError)
  })
})

import { describe, expect, it } from 'vitest'
import { parsePatchFile, serializePatchFile } from '@shared/json/patchCodec'
import type { PatchDocument } from '@shared/domain/patch'

function docWithSettings(settings: PatchDocument['settings']): PatchDocument {
  return { nodes: [], nets: [], settings, notes: '' }
}

// `logueTarget` narrowed from `{platform, module}` to
// just `{module}`: a document no longer commits to, or even currently "views," one platform, so
// there's nothing left for `logueTarget` itself to say about platform at all.
describe('PatchSettings.logueTarget json round-trip', () => {
  it('round-trips a logue-target document (parse -> domain -> serialize -> parse, deep-equal)', () => {
    const logueTarget = { module: 'osc' } as const
    const doc1 = docWithSettings({ logueTarget })
    const text = serializePatchFile(doc1)
    const doc2 = parsePatchFile(text)
    expect(doc2).toEqual(doc1)
    expect(doc2.settings.logueTarget).toEqual(logueTarget)
  })

  it('a document with no logueTarget at all round-trips with none -- the field never gets invented', () => {
    const doc1 = docWithSettings({})
    const text = serializePatchFile(doc1)

    expect(text).not.toContain('logueTarget')

    const doc2 = parsePatchFile(text)
    expect(doc2.settings.logueTarget).toBeUndefined()
  })

  it.each(['modfx', 'delfx', 'revfx'] as const)('round-trips an effect module (%s)', (module) => {
    const doc1 = docWithSettings({ logueTarget: { module } })
    const doc2 = parsePatchFile(serializePatchFile(doc1))
    expect(doc2.settings.logueTarget).toEqual({ module })
  })

  it('an unrecognized module (e.g. from a future or foreign file) decodes to undefined rather than a made-up value', () => {
    const text = JSON.stringify({
      version: 1,
      nodes: [],
      nets: [],
      settings: { logueTarget: { platform: 'nts1mkii', module: 'masterfx' } },
      notes: ''
    })

    const doc = parsePatchFile(text)
    expect(doc.settings.logueTarget).toBeUndefined()
  })

  it('ignores a foreign/unrecognized platform value entirely -- module alone decides validity now', () => {
    const text = JSON.stringify({
      version: 1,
      nodes: [],
      nets: [],
      settings: { logueTarget: { platform: 'prologue', module: 'osc' } },
      notes: ''
    })

    const doc = parsePatchFile(text)
    expect(doc.settings.logueTarget).toEqual({ module: 'osc' })
  })
})

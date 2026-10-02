import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  listLocalSubpatches,
  listSubpatchLibrary,
  listSubpatchesFor,
  loadSubpatchDefinitions,
  subpatchTypeForPath
} from '../src/main/config/subpatchLibrary'
import { serializePatchFile } from '../src/shared/json/patchCodec'

describe('subpatch library folder', () => {
  it('derives the instance type from the path relative to the library folder', () => {
    expect(subpatchTypeForPath('/lib', '/lib/bass/pluck.loguesub')).toBe('sub/bass/pluck')
  })

  it('lists .loguesub files recursively, keeping broken ones as errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loguesub-'))
    mkdirSync(join(dir, 'filters'))
    const good = serializePatchFile({
      nodes: [],
      nets: [],
      settings: { subpatch: true },
      notes: ''
    })
    writeFileSync(join(dir, 'filters', 'soft.loguesub'), good)
    writeFileSync(join(dir, 'broken.loguesub'), '{ not json')
    writeFileSync(join(dir, 'ignored.loguepatch'), good)

    const entries = listSubpatchLibrary(dir)
    expect(entries.map((e) => e.type)).toEqual(['sub/broken', 'sub/filters/soft'])
    expect(entries[0].error).toBeDefined()
    expect(entries[1].doc?.settings.subpatch).toBe(true)
    expect([...loadSubpatchDefinitions(null, dir).keys()]).toEqual(['sub/filters/soft'])
  })

  it('treats an unset or missing folder as an empty library', () => {
    expect(listSubpatchLibrary(undefined)).toEqual([])
    expect(listSubpatchLibrary('/definitely/not/here')).toEqual([])
  })

  it("finds the top level of a patch's own folder first, overriding the library", () => {
    const def = (notes: string): string =>
      serializePatchFile({ nodes: [], nets: [], settings: { subpatch: true }, notes })
    const lib = mkdtempSync(join(tmpdir(), 'loguesub-lib-'))
    writeFileSync(join(lib, 'voice.loguesub'), def('library voice'))
    writeFileSync(join(lib, 'other.loguesub'), def('library other'))
    const patchDir = mkdtempSync(join(tmpdir(), 'loguesub-patch-'))
    const patch = join(patchDir, 'grain-mill.loguepatch')
    writeFileSync(join(patchDir, 'voice.loguesub'), def('local voice'))
    mkdirSync(join(patchDir, 'deeper'))
    writeFileSync(join(patchDir, 'deeper', 'hidden.loguesub'), def('not searched'))

    expect(listLocalSubpatches(patch).map((e) => [e.type, e.source])).toEqual([
      ['sub/voice', 'local']
    ])
    const seen = listSubpatchesFor(patch, lib)
    expect(seen.map((e) => [e.type, e.source, e.doc?.notes])).toEqual([
      ['sub/voice', 'local', 'local voice'],
      ['sub/other', 'library', 'library other']
    ])
    expect(loadSubpatchDefinitions(patch, lib).get('sub/voice')?.notes).toBe('local voice')
    // An unsaved patch has no folder: the library only.
    expect(loadSubpatchDefinitions(null, lib).get('sub/voice')?.notes).toBe('library voice')
  })
})

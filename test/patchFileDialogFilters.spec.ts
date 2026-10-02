import { describe, expect, it } from 'vitest'
import {
  LOGUEPATCH_FILTER,
  LOGUESUB_FILTER,
  OPEN_DIALOG_FILTERS,
  saveDialogOptionsFor
} from '../src/main/ipc/patchFile'
import type { PatchDocument } from '../src/shared/domain/patch'

const rootDoc: PatchDocument = { nodes: [], nets: [], settings: {}, notes: '' }
const subDoc: PatchDocument = { nodes: [], nets: [], settings: { subpatch: true }, notes: '' }

describe('patch file dialogs', () => {
  it('opens both document kinds from one dialog', () => {
    expect(OPEN_DIALOG_FILTERS[0].extensions).toEqual(['loguepatch', 'loguesub'])
  })

  it('saves a root patch as .loguepatch', () => {
    expect(saveDialogOptionsFor(rootDoc, undefined, '/lib')).toEqual({
      filters: [LOGUEPATCH_FILTER],
      defaultPath: 'untitled.loguepatch'
    })
  })

  it('saves a new subpatch as .loguesub, defaulting into the library folder', () => {
    expect(saveDialogOptionsFor(subDoc, undefined, '/lib')).toEqual({
      filters: [LOGUESUB_FILTER],
      defaultPath: '/lib/untitled.loguesub'
    })
    expect(saveDialogOptionsFor(subDoc, '/elsewhere/x.loguesub', '/lib').defaultPath).toBe(
      '/elsewhere/x.loguesub'
    )
  })
})

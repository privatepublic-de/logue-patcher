import { describe, expect, it } from 'vitest'
import {
  deriveBuildFileName,
  deriveExportFolderName,
  formatHistoryTimestamp,
  historyRenamedName
} from '../src/main/config/buildResultNaming'

describe('deriveBuildFileName', () => {
  it('sanitizes unsafe characters and appends the given extension', () => {
    expect(deriveBuildFileName('my patch/v2!', 'mnlgxdunit')).toBe('my_patch_v2_.mnlgxdunit')
  })

  it('falls back to "unit" when the sanitized name is empty', () => {
    expect(deriveBuildFileName('', 'nts1mkiiunit')).toBe('unit.nts1mkiiunit')
  })
})

describe('deriveExportFolderName', () => {
  it('sanitizes the unit name and appends the platform', () => {
    expect(deriveExportFolderName('My Patch', 'nts1mkii')).toBe('My_Patch-nts1mkii')
    expect(deriveExportFolderName('My Patch', 'minilogue-xd')).toBe('My_Patch-minilogue-xd')
  })
})

describe('formatHistoryTimestamp', () => {
  it('formats as YYYYMMDD-HHMMSS in local time, zero-padded', () => {
    const date = new Date(2026, 8, 3, 4, 5, 6) // 2026-09-03 04:05:06 local
    expect(formatHistoryTimestamp(date)).toBe('20260903-040506')
  })
})

describe('historyRenamedName', () => {
  const now = new Date(2026, 8, 23, 14, 35, 12) // 2026-09-23 14:35:12 local

  it("inserts the history segment before a file's real extension", () => {
    expect(historyRenamedName('MyUnit.mnlgxdunit', now)).toBe(
      'MyUnit.history-20260923-143512.mnlgxdunit'
    )
  })

  it('preserves the real extension even when the unit name itself contains a dot', () => {
    expect(historyRenamedName('My.Unit.nts1mkiiunit', now)).toBe(
      'My.Unit.history-20260923-143512.nts1mkiiunit'
    )
  })

  it('appends the history segment to an extension-less folder name', () => {
    expect(historyRenamedName('MyUnit-nts1mkii', now)).toBe(
      'MyUnit-nts1mkii.history-20260923-143512'
    )
  })
})

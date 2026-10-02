import { describe, expect, it } from 'vitest'
import { normalizePath } from '../src/renderer/src/util/paths'

describe('normalizePath', () => {
  it('collapses a "." segment', () => {
    expect(normalizePath('/patches/./sub.axs')).toBe('/patches/sub.axs')
  })

  it('resolves ".." against a preceding real segment', () => {
    expect(normalizePath('/patches/foo/../sub.axs')).toBe('/patches/sub.axs')
  })

  it('leaves an already-normalized absolute path unchanged', () => {
    expect(normalizePath('/patches/sub.axs')).toBe('/patches/sub.axs')
  })

  it('collapses doubled slashes', () => {
    expect(normalizePath('/patches//sub.axs')).toBe('/patches/sub.axs')
  })

  it('makes a direct absolute path and its "./"-relative-joined equivalent compare equal', () => {
    const direct = '/library/stomps/chorus1.axs'
    const withDot = '/library/stomps/./chorus1.axs'
    expect(normalizePath(withDot)).toBe(normalizePath(direct))
  })
})

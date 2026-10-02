import { describe, expect, it } from 'vitest'
import { deriveStagingName } from '../src/main/config/logueBuildStaging'

/**
 * `logueBuild.ts`'s real orchestration (staging into a real logue-sdk checkout, spawning
 * `make` against a local ARM toolchain) needs a real toolchain + checkout to exercise -- verified manually/via an
 * agent, not here (matches this project's own established discipline for anything that needs
 * the real toolchain). `deriveStagingName` is the one piece of real, pure logic worth a unit
 * test on its own.
 */
describe('deriveStagingName', () => {
  it('sanitizes unsafe characters to underscores', () => {
    expect(deriveStagingName('my patch/v2!')).toMatch(
      /^logue-patcher-build-my_patch_v2_-[0-9a-f]{8}$/
    )
  })

  it('falls back to "patch" when the sanitized name is empty', () => {
    expect(deriveStagingName('')).toMatch(/^logue-patcher-build-patch-[0-9a-f]{8}$/)
  })

  it('caps the sanitized portion at 40 characters', () => {
    const long = 'a'.repeat(100)
    const name = deriveStagingName(long)
    const middle = name.replace(/^logue-patcher-build-/, '').replace(/-[0-9a-f]{8}$/, '')
    expect(middle.length).toBe(40)
  })

  it('produces a different suffix on each call, avoiding collisions between repeated builds', () => {
    const a = deriveStagingName('same-name')
    const b = deriveStagingName('same-name')
    expect(a).not.toBe(b)
  })
})

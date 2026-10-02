import { describe, it, expect } from 'vitest'
import {
  type DeviceParam,
  findParamDeviceType,
  resolveMinilogueXdDeviceParam,
  resolveNts1mkiiDeviceParam,
  toDeviceValue
} from '../logue-codegen/src/paramDeviceType'

/**
 * `findParamDeviceType` (NTS-1 mkII, curated) should return an entry for EXACTLY the same "raw
 * value already equals its real unit" params `@logue-codegen/paramUnits`'s own identity units
 * cover (COARSE/FINE/WIDTH/FADE) -- never for a param whose display unit needs a curve the real
 * device's own linear-only rendering can't do (see paramDeviceType.ts's own module doc comment).
 * `resolveMinilogueXdDeviceParam` (minilogue xd, a general rule instead) is tested separately below.
 */
describe('paramDeviceType', () => {
  it('COARSE/FINE map to semi/cents on NTS-1 mkII', () => {
    for (const id of [
      'logue/osc/sine',
      'logue/osc/saw',
      'logue/osc/square',
      'logue/osc/pulse',
      'logue/osc/triangle',
      'logue/filter/comb',
      'logue/filter/svf'
    ]) {
      expect(findParamDeviceType(id, 'COARSE')).toEqual({ nts1mkii: 'semi' })
      expect(findParamDeviceType(id, 'FINE')).toEqual({ nts1mkii: 'cents' })
    }
  })

  it('WIDTH/FADE map to percent on NTS-1 mkII', () => {
    expect(findParamDeviceType('logue/osc/pulse', 'WIDTH')).toEqual({ nts1mkii: 'percent' })
    expect(findParamDeviceType('logue/mix/crossfader', 'FADE')).toEqual({ nts1mkii: 'percent' })
  })

  it('TRACK maps to onoff on both comb and svf -- safe now that TRACK_ON_RAW_THRESHOLD exactly matches k_unit_param_type_onoff', () => {
    expect(findParamDeviceType('logue/filter/comb', 'TRACK')).toEqual({ nts1mkii: 'onoff' })
    expect(findParamDeviceType('logue/filter/svf', 'TRACK')).toEqual({ nts1mkii: 'onoff' })
  })

  it("logue/osc/saw's TZFM maps to onoff too -- the same plain on/off runtime threshold shape as comb/svf's own TRACK", () => {
    expect(findParamDeviceType('logue/osc/saw', 'TZFM')).toEqual({ nts1mkii: 'onoff' })
  })

  it('a param needing a real curve (not a 1:1 raw-to-unit mapping) has no NTS-1 mkII device type', () => {
    expect(findParamDeviceType('logue/lfo/sine-lfo', 'RATE')).toBeUndefined()
    expect(findParamDeviceType('logue/env/ad', 'ATTACK')).toBeUndefined()
    expect(findParamDeviceType('logue/gain/vca', 'GAIN')).toBeUndefined()
    expect(findParamDeviceType('logue/filter/comb', 'CUTOFF')).toBeUndefined()
    expect(findParamDeviceType('logue/filter/lowpass-cheap', 'CUTOFF')).toBeUndefined()
  })

  describe('resolveMinilogueXdDeviceParam', () => {
    const xd = (id: string, name: string, min: number, max: number): DeviceParam =>
      resolveMinilogueXdDeviceParam(id, { name, min, max })

    it('gives any other param "%" over its own spec range, unscaled -- sidesteps the typeless +1 display offset', () => {
      const cases: Array<[string, string]> = [
        ['logue/osc/pulse', 'WIDTH'],
        ['logue/mix/crossfader', 'FADE'],
        ['logue/filter/lowpass-cheap', 'CUTOFF'],
        ['logue/filter/svf', 'RESONANCE'],
        ['logue/gain/vca', 'GAIN'],
        ['logue/env/ad', 'ATTACK'],
        ['logue/lfo/sine-lfo', 'RATE'],
        ['logue/filter/comb', 'GAIN'],
        ['logue/sense/param', 'VALUE']
      ]
      for (const [id, name] of cases) {
        expect(xd(id, name, 0, 100)).toEqual({ min: 0, max: 100, type: '%', scale: 1 })
      }
    })

    it('gives a negative-range param "%" too -- Korg: typeless ranges must be positive', () => {
      expect(xd('logue/osc/sine', 'COARSE', -24, 24)).toEqual({
        min: -24,
        max: 24,
        type: '%',
        scale: 1
      })
      expect(xd('logue/util/constant', 'VALUE', -100, 100)).toEqual({
        min: -100,
        max: 100,
        type: '%',
        scale: 1
      })
    })

    it('shows a hard select as its 1-based input number: typeless 0..N-1 (the xd displays +1)', () => {
      expect(xd('logue/mux/mux2', 'SELECT', 0, 100)).toEqual({
        min: 0,
        max: 1,
        type: '',
        scale: 100,
        onThreshold: 50
      })
      expect(xd('logue/mux/demux2', 'SELECT', 0, 100)).toEqual({
        min: 0,
        max: 1,
        type: '',
        scale: 100,
        onThreshold: 50
      })
      expect(xd('logue/mux/mux4', 'INDEX', 0, 3)).toEqual({
        min: 0,
        max: 3,
        type: '',
        scale: 1,
        onThreshold: undefined
      })
    })

    it("shows a boolean widget as two steps, 0%/1%, scaled back to the widget's own onValue", () => {
      for (const [id, name] of [
        ['logue/filter/comb', 'TRACK'],
        ['logue/filter/svf', 'TRACK'],
        ['logue/lfo/fast-square', 'TRACK'],
        ['logue/osc/granular', 'SYNC'],
        ['logue/osc/saw', 'TZFM']
      ]) {
        expect(xd(id, name, 0, 100)).toEqual({
          min: 0,
          max: 1,
          type: '%',
          scale: 100,
          onThreshold: 1
        })
      }
    })
  })

  describe('resolveNts1mkiiDeviceParam', () => {
    const nts = (id: string, name: string, min: number, max: number): DeviceParam =>
      resolveNts1mkiiDeviceParam(id, { name, min, max })

    it('labels hard selects through k_unit_param_type_strings over 0..N-1', () => {
      expect(nts('logue/mux/mux2', 'SELECT', 0, 100)).toMatchObject({
        min: 0,
        max: 1,
        type: 'strings',
        scale: 100,
        strings: ['In 1', 'In 2']
      })
      expect(nts('logue/mux/demux2', 'SELECT', 0, 100).strings).toEqual(['Out 1', 'Out 2'])
      expect(nts('logue/mux/mux4', 'INDEX', 0, 3)).toMatchObject({
        min: 0,
        max: 3,
        type: 'strings',
        scale: 1,
        strings: ['In 1', 'In 2', 'In 3', 'In 4']
      })
    })

    it('gives a boolean widget onoff over 0..1, scaled back to its onValue', () => {
      expect(nts('logue/osc/granular', 'SYNC', 0, 100)).toEqual({
        min: 0,
        max: 1,
        type: 'onoff',
        scale: 100,
        onThreshold: 1
      })
    })

    it('keeps every other param on its spec range with its curated type, or none', () => {
      expect(nts('logue/osc/sine', 'COARSE', -24, 24)).toEqual({
        min: -24,
        max: 24,
        type: 'semi',
        scale: 1
      })
      expect(nts('logue/gain/vca', 'GAIN', 0, 100)).toEqual({
        min: 0,
        max: 100,
        type: 'none',
        scale: 1
      })
    })
  })

  describe('toDeviceValue', () => {
    it('reads a two-step param by its DSP threshold, anything else by scale', () => {
      const select = nts2('logue/mux/mux2', 'SELECT')
      expect([0, 49, 50, 100].map((v) => toDeviceValue(select, v))).toEqual([0, 0, 1, 1])
      const track = nts2('logue/filter/comb', 'TRACK')
      expect([0, 1, 30].map((v) => toDeviceValue(track, v))).toEqual([0, 1, 1])
      expect(toDeviceValue(nts2('logue/mux/mux4', 'INDEX'), 2)).toBe(2)
    })
    function nts2(id: string, name: string): DeviceParam {
      return resolveNts1mkiiDeviceParam(id, { name, min: 0, max: 100 })
    }
  })
})

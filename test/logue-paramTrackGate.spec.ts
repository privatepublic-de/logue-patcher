import { describe, it, expect } from 'vitest'
import {
  TRACK_ON_THRESHOLD,
  findBooleanWidget,
  findInletTrackGate,
  findParamTrackGate,
  isTrackGated
} from '../logue-codegen/src/paramTrackGate'

/**
 * Confirms this module's own gating logic matches `combCutoffSamplesExpr`/`svfGExpr`'s real
 * `track_<suffix> >= TRACK_ON_RAW_THRESHOLD` comparison (primitives.ts) -- see paramTrackGate.ts's
 * own module doc comment for why `1` (not the original `50`) is shared as one constant rather
 * than re-typed per entry, and primitives.ts's own `TRACK_ON_RAW_THRESHOLD` doc comment for why
 * it moved there (matching NTS-1 mkII's real `k_unit_param_type_onoff` device semantics exactly).
 */
describe('paramTrackGate', () => {
  it('TRACK renders as a checkbox on both comb and svf, sharing the same threshold', () => {
    const combTrack = findBooleanWidget('logue/filter/comb', 'TRACK')
    const svfTrack = findBooleanWidget('logue/filter/svf', 'TRACK')
    expect(combTrack?.threshold).toBe(TRACK_ON_THRESHOLD)
    expect(TRACK_ON_THRESHOLD).toBe(1)
    expect(svfTrack?.threshold).toBe(TRACK_ON_THRESHOLD)
    expect(combTrack?.onValue).toBe(100)
    expect(combTrack?.offValue).toBe(0)
  })

  it('comb TUNE and svf CUTOFF go inert once TRACK is ON (>=1, matching k_unit_param_type_onoff exactly)', () => {
    const combCutoff = findParamTrackGate('logue/filter/comb', 'TUNE')!
    const svfCutoff = findParamTrackGate('logue/filter/svf', 'CUTOFF')!
    expect(isTrackGated(combCutoff, 0)).toBe(false)
    expect(isTrackGated(combCutoff, 1)).toBe(true)
    expect(isTrackGated(combCutoff, 50)).toBe(true)
    expect(isTrackGated(combCutoff, 100)).toBe(true)
    expect(isTrackGated(svfCutoff, 1)).toBe(true)
  })

  it('COARSE/FINE go inert while TRACK is OFF (==0), the opposite direction', () => {
    const combCoarse = findParamTrackGate('logue/filter/comb', 'COARSE')!
    const svfFine = findParamTrackGate('logue/filter/svf', 'FINE')!
    expect(isTrackGated(combCoarse, 0)).toBe(true)
    expect(isTrackGated(combCoarse, 1)).toBe(false)
    expect(isTrackGated(combCoarse, 50)).toBe(false)
    expect(isTrackGated(combCoarse, 100)).toBe(false)
    expect(isTrackGated(svfFine, 0)).toBe(true)
  })

  it('GAIN/DAMPING/RESONANCE/TRACK itself are never gated -- they apply in both modes', () => {
    expect(findParamTrackGate('logue/filter/comb', 'FEEDBACK')).toBeUndefined()
    expect(findParamTrackGate('logue/filter/comb', 'DAMPING')).toBeUndefined()
    expect(findParamTrackGate('logue/filter/svf', 'RESONANCE')).toBeUndefined()
    expect(findParamTrackGate('logue/filter/comb', 'TRACK')).toBeUndefined()
    expect(findParamTrackGate('logue/filter/svf', 'TRACK')).toBeUndefined()
  })

  it('TZFM (logue/osc/saw) renders as a checkbox too, sharing the same threshold', () => {
    const sawTzfm = findBooleanWidget('logue/osc/saw', 'TZFM')
    expect(sawTzfm?.threshold).toBe(TRACK_ON_THRESHOLD)
    expect(sawTzfm?.onValue).toBe(100)
    expect(sawTzfm?.offValue).toBe(0)
  })

  it('FM_DEPTH/COARSE/FINE/fm are never gated on logue/osc/saw -- unlike TUNE/CUTOFF/COARSE on comb/svf, they always have SOME effect in both TZFM modes, just a different one', () => {
    expect(findParamTrackGate('logue/osc/saw', 'FM_DEPTH')).toBeUndefined()
    expect(findParamTrackGate('logue/osc/saw', 'COARSE')).toBeUndefined()
    expect(findParamTrackGate('logue/osc/saw', 'FINE')).toBeUndefined()
    expect(findParamTrackGate('logue/osc/saw', 'TZFM')).toBeUndefined()
    expect(findInletTrackGate('logue/osc/saw', 'fm')).toBeUndefined()
  })

  it('the tune/cutoff/pitch INLETS (comb/svf) are gated the same way as their param-side counterparts -- a wire into either can currently do nothing depending on TRACK', () => {
    const combCutoffInlet = findInletTrackGate('logue/filter/comb', 'tune')!
    const combPitchInlet = findInletTrackGate('logue/filter/comb', 'pitch')!
    const svfCutoffInlet = findInletTrackGate('logue/filter/svf', 'cutoff')!
    const svfPitchInlet = findInletTrackGate('logue/filter/svf', 'pitch')!

    // cutoff: same "inert once TRACK >= 1" direction as the CUTOFF param.
    expect(isTrackGated(combCutoffInlet, 0)).toBe(false)
    expect(isTrackGated(combCutoffInlet, 1)).toBe(true)
    expect(isTrackGated(svfCutoffInlet, 1)).toBe(true)

    // pitch: the OPPOSITE direction -- inert while TRACK is OFF, same as COARSE/FINE.
    expect(isTrackGated(combPitchInlet, 0)).toBe(true)
    expect(isTrackGated(combPitchInlet, 1)).toBe(false)
    expect(isTrackGated(svfPitchInlet, 0)).toBe(true)

    // gain/resonance/in/damping are never gated -- no entry at all.
    expect(findInletTrackGate('logue/filter/comb', 'feedback')).toBeUndefined()
    expect(findInletTrackGate('logue/filter/comb', 'damping')).toBeUndefined()
    expect(findInletTrackGate('logue/filter/comb', 'in')).toBeUndefined()
    expect(findInletTrackGate('logue/filter/svf', 'resonance')).toBeUndefined()
  })
})

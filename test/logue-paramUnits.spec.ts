import { describe, it, expect } from 'vitest'
import {
  dependentUnit,
  findDisplayUnit,
  findParamUnit,
  findUnitDependency
} from '../logue-codegen/src/paramUnits'

/**
 * Golden-value checks against numbers computed BY HAND from the exact formulas this module's own
 * doc comments cite (`LFO_RATE_HELPER`/`ENV_RATE_HELPER`/`vcaPrimitive`'s `GAIN` setStatement/
 * `driveGainExpr`'s two call sites, all in primitives.ts) -- not re-derived here, so a future
 * accidental change to paramUnits.ts's own arithmetic (not primitives.ts's) fails a fixed
 * expectation instead of silently passing against itself. See paramUnits.ts's own module doc
 * comment for why this still can't catch primitives.ts's C++ constants drifting away from these
 * TS mirrors on its own -- that's a human-cross-reference discipline, not something a test in
 * this repo can verify by executing the generated C++.
 */
describe('paramUnits', () => {
  it('COARSE/FINE are identity units (already real semitones/cents)', () => {
    const coarse = findParamUnit('logue/osc/sine', 'COARSE')
    const fine = findParamUnit('logue/osc/sine', 'FINE')
    expect(coarse?.toDisplay(3)).toBe('+3 st')
    expect(coarse?.toDisplay(-12)).toBe('-12 st')
    expect(coarse?.toDisplay(0)).toBe('0 st')
    expect(fine?.toDisplay(25)).toBe('+25 ct')
    expect(coarse?.parseInput('+3 st')).toBe(3)
  })

  it('math/scale FACTOR shows the multiplier it applies, and a typed factor round-trips', () => {
    const factor = findParamUnit('logue/math/scale', 'FACTOR')
    expect(factor?.toDisplay(100)).toBe('1.00x')
    expect(factor?.toDisplay(50)).toBe('0.50x')
    expect(factor?.toDisplay(-100)).toBe('-1.00x')
    expect(factor?.toDisplay(0)).toBe('0.00x')
    expect(factor?.parseInput('0.25x')).toBeCloseTo(25, 9)
    expect(factor?.parseInput('-1')).toBeCloseTo(-100, 9)
  })

  it('math/scale FACTOR follows RANGE on a placed node, not on a promoted param', () => {
    const dependency = findUnitDependency('logue/math/scale', { name: 'FACTOR' })!
    expect(dependentUnit(dependency, undefined).toDisplay(75)).toBe('0.75x')
    expect(dependentUnit(dependency, '2').toDisplay(75)).toBe('3.00x')
    expect(dependentUnit(dependency, '3').toDisplay(-100)).toBe('-8.00x')
    expect(dependentUnit(dependency, '1').parseInput('1.5x')).toBeCloseTo(75, 9)
    expect(findParamUnit('logue/math/scale', 'RANGE')?.toDisplay(3)).toBe('8x')
    const promoted = {
      name: 'sc:FACTOR',
      promotedFrom: { primitiveId: 'logue/math/scale', paramName: 'FACTOR' }
    }
    expect(findUnitDependency('sub/x', promoted)).toBeUndefined()
    expect(findDisplayUnit('sub/x', promoted)).toBeUndefined()
  })

  it('WIDTH/FADE are identity percent units', () => {
    const width = findParamUnit('logue/osc/pulse', 'WIDTH')
    const fade = findParamUnit('logue/mix/crossfader', 'FADE')
    expect(width?.toDisplay(62)).toBe('62%')
    expect(fade?.parseInput('62%')).toBe(62)
  })

  it('fast-square RATE maps 0-100 to 0.1 Hz-2 kHz along t^4, both directions', () => {
    const rate = findParamUnit('logue/lfo/fast-square', 'RATE')
    expect(rate?.toDisplay(0)).toBe('0.10 Hz')
    expect(rate?.toDisplay(30)).toBe('16.3 Hz') // 0.1 + 0.3^4 * 1999.9 = 16.299
    expect(rate?.toDisplay(50)).toBe('125 Hz') // 0.1 + 0.5^4 * 1999.9 = 125.09
    expect(rate?.toDisplay(100)).toBe('2.00 kHz')
    expect(rate?.parseInput('2 kHz')).toBeCloseTo(100, 5)
    expect(rate?.parseInput('125.09375 Hz')).toBeCloseTo(50, 5)
    expect(rate?.parseInput('0.1')).toBeCloseTo(0, 5)
    expect(rate?.parseInput('fast')).toBeUndefined()
  })

  it('LFO RATE maps 0-100 to 0.1-20 Hz along t^3, both directions', () => {
    const rate = findParamUnit('logue/lfo/sine-lfo', 'RATE')
    expect(rate?.toDisplay(0)).toBe('0.10 Hz')
    expect(rate?.toDisplay(100)).toBe('20.00 Hz')
    expect(rate?.toDisplay(50)).toBe('2.59 Hz') // 0.1 + 0.5^3 * 19.9 = 2.5875
    expect(rate?.parseInput('2.5875 Hz')).toBeCloseTo(50, 5)
    expect(rate?.parseInput('0.05')).toBeCloseTo(0, 5)
    expect(rate?.parseInput('20')).toBeCloseTo(100, 5)
  })

  it('ATTACK/DECAY map 0-100 to 5-2000ms, switching to seconds at 1000ms', () => {
    const attack = findParamUnit('logue/env/ad', 'ATTACK')
    expect(attack?.toDisplay(0)).toBe('5 ms')
    expect(attack?.toDisplay(40)).toBe('803 ms')
    expect(attack?.toDisplay(60)).toBe('1.20 s')
    expect(attack?.toDisplay(100)).toBe('2.00 s')
    expect(attack?.parseInput('803ms')).toBeCloseTo(40, 5)
    expect(attack?.parseInput('1.2s')).toBeCloseTo(59.9, 1)
    // ahd shares the exact same unit, not a separately-maintained copy.
    expect(findParamUnit('logue/env/ahd', 'DECAY')?.toDisplay(0)).toBe('5 ms')
  })

  it("VCA GAIN maps its 0-4x linear gain (widened for real headroom, see vcaPrimitive's own doc comment) to dB, unity at 25, including -inf at 0", () => {
    const gain = findParamUnit('logue/gain/vca', 'GAIN')
    expect(gain?.toDisplay(0)).toBe('-∞ dB')
    expect(gain?.toDisplay(25)).toBe('+0.0 dB')
    expect(gain?.toDisplay(100)).toBe('+12.0 dB')
    expect(gain?.toDisplay(50)).toBe('+6.0 dB')
    expect(gain?.parseInput('-6.0')).toBeCloseTo(12.53, 1)
  })

  it('wavefolder/soft-clip DRIVE map their own 1x-8x/1x-10x pre-gain to dB', () => {
    const fold = findParamUnit('logue/shape/wavefolder', 'DRIVE')
    const clip = findParamUnit('logue/shape/soft-clip', 'DRIVE')
    expect(fold?.toDisplay(0)).toBe('+0.0 dB')
    expect(fold?.toDisplay(100)).toBe('+18.1 dB')
    expect(clip?.toDisplay(100)).toBe('+20.0 dB')
  })

  it('a param with no disclosed real-world calibration gets no unit', () => {
    expect(findParamUnit('logue/filter/lowpass-cheap', 'CUTOFF')).toBeUndefined()
    expect(findParamUnit('logue/filter/svf', 'RESONANCE')).toBeUndefined()
    expect(findParamUnit('logue/filter/comb', 'TRACK')).toBeUndefined()
    expect(findParamUnit('logue/util/constant', 'VALUE')).toBeUndefined()
    expect(findParamUnit('logue/osc/sine', 'FM_DEPTH')).toBeUndefined()
    // svf's CUTOFF never gets a unit either -- uncalibrated when free-running, played-note-
    // dependent (so unknowable statically) once TRACK engages. See paramTrackGate.spec.ts for
    // the "dial is inert while tracked" side of this, which ParamDial.tsx handles separately.
    expect(findParamUnit('logue/filter/svf', 'CUTOFF')).toBeUndefined()
  })

  it('comb TUNE maps its free-running sample count to ms (only valid while TRACK is off)', () => {
    // Note the flip vs. phase 16's own `DELAY`: CUTOFF=100 is the SHORTEST delay (brightest,
    // matching every other filter's own cutoff convention), so the ms value now DECREASES as
    // the raw value increases -- 5.1's own floating-point imprecision (the same one phase 16's
    // test already called out) still lands the 0-raw ceiling at 510 samples, not primitives.ts's
    // own doc comment's stated "511".
    const cutoff = findParamUnit('logue/filter/comb', 'TUNE')
    expect(cutoff?.toDisplay(100)).toBe('0.02 ms')
    expect(cutoff?.toDisplay(50)).toBe('5.31 ms')
    expect(cutoff?.toDisplay(0)).toBe('10.63 ms')
    expect(cutoff?.parseInput('5.31ms')).toBeCloseTo(50, 0)
  })

  it('comb FEEDBACK/DAMPING have no calibrated unit, just a plain percent', () => {
    expect(findParamUnit('logue/filter/comb', 'FEEDBACK')?.toDisplay(60)).toBe('60%')
    expect(findParamUnit('logue/filter/comb', 'DAMPING')?.toDisplay(20)).toBe('20%')
  })

  it('comb/svf COARSE+FINE get the same semitone/cent units the oscillators use', () => {
    expect(findParamUnit('logue/filter/comb', 'COARSE')?.toDisplay(3)).toBe('+3 st')
    expect(findParamUnit('logue/filter/comb', 'FINE')?.toDisplay(25)).toBe('+25 ct')
    expect(findParamUnit('logue/filter/svf', 'COARSE')?.toDisplay(3)).toBe('+3 st')
    expect(findParamUnit('logue/filter/svf', 'FINE')?.toDisplay(25)).toBe('+25 ct')
  })

  it('ladder CUTOFF shows its note-domain cutoff in Hz, and a typed frequency round-trips', () => {
    // note = 15.5 + 1.2 * raw (LADDER_NOTE_LO/SPAN), 440 Hz at note 69.
    const cutoff = findParamUnit('logue/filter/ladder', 'CUTOFF')
    expect(cutoff?.toDisplay(0)).toBe('20.0 Hz')
    expect(cutoff?.toDisplay(60)).toBe('1.28 kHz')
    expect(cutoff?.toDisplay(100)).toBe('20.5 kHz')
    expect(cutoff?.parseInput('440 Hz')).toBeCloseTo((69 - 15.5) / 1.2, 9)
    expect(cutoff?.parseInput('1.28k')).toBeUndefined()
    expect(cutoff?.parseInput('2 kHz')).toBeCloseTo(
      (69 + 12 * Math.log2(2000 / 440) - 15.5) / 1.2,
      9
    )
  })
})

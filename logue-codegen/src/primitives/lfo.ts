import {
  FAST_LFO_HZ,
  LFO_HZ,
  NEEDS_TRACK_GATE,
  PERCENT,
  PITCH_TRACKED_GATE,
  TRACK_WIDGET
} from '../paramPresentation'
import type { HelperBlock, LoguePrimitive } from './types'
import {
  CLAMPF_HELPER,
  COARSE_PARAM,
  FAST_LFO_RATE_HELPER,
  FINE_PARAM,
  NOISE_STEP_HELPER,
  NOTE_W0_HELPER,
  RATE_INLET_DEPTH,
  TRACK_ON_RAW_THRESHOLD,
  WIDTH_INLET_DEPTH,
  additiveInletExpr,
  hashSuffixToSeed,
  transposedW0,
  blockDecls,
  blockValue
} from './shared'

// This formula's own 0.1/19.9 constants are mirrored in `paramUnits.ts`'s `lfoHzUnit` (for the
// canvas dial's Hz display) -- changing them here without updating that mirror silently breaks
// the display's own accuracy without failing any check that runs the real generated C++.
const LFO_RATE_HELPER: HelperBlock = {
  key: 'lfo_rate_from_percent',
  code: `  // Deliberately no libm (expf/logf) -- same code-size reasoning as env_rate_from_percent
  // above. Maps a plain 0-100 percent to a per-sample PHASE INCREMENT (not a raw Hz value --
  // this feeds phase_<suffix> directly, the same accumulator convention osc_sinf expects)
  // covering a fixed, made-up-but-reasonable 0.1Hz-20Hz LFO range at the platform's real fixed
  // 48kHz sample rate. Cubed: a linear map spent half the dial above 10Hz, leaving the slow
  // sweeps a modulation LFO mostly wants crammed into the bottom few percent.
  static float lfo_rate_from_percent(float percent)
  {
    float t = percent * 0.01f;
    float hz = 0.1f + t * t * t * 19.9f;
    // Not "hz / 48000.f": without -ffast-math GCC keeps that as a real divide (14 cycles on
    // the xd's M4), and this runs per sample per LFO per voice.
    return hz * (1.f / 48000.f);
  }
`
}

/**
 * Free-running LFOs (sine/triangle/square/ramp-up/ramp-down). Not a reuse of the oscillators,
 * which advance by the note-derived `w0_`: an LFO needs its own accumulator at a user-set RATE
 * unrelated to the note. All shapes share that accumulator, the `rate`/`trig` handling and the
 * `RATE` param, so `makeLfoPrimitive` is a factory over the one difference, `renderExpr`.
 *
 * Separate ids rather than one LFO with a `WAVE` param: a param is a runtime `OSC_PARAM` value the
 * compiler can't fold, so every shape's branch would compile into every instance. It also matches
 * one primitive per oscillator shape.
 *
 * Output is bipolar `[-1,1]` like every other source. So into `logue/gain/vca`'s `gain` it gives
 * AM with polarity inversion on the negative half, and into `lowpass-cheap`'s `cutoff` it closes
 * the filter for the negative half (`onepole_step`'s clamp). Both are valid; a unipolar variant
 * would be a separate primitive if a patch needs one.
 *
 * Square/ramp edges are naive (no PolyBLEP): at 0.1-20 Hz (`LFO_RATE_HELPER`) aliasing isn't a
 * concern for a control signal.
 *
 * `rate` inlet: additive, onto the raw percent in `ratePercent_` before `lfo_rate_from_percent`
 * converts it; a full `+-1` swing is `+-50` points, half of RATE's range.
 * `trig` inlet: resets the phase to 0 (see `lfoTrigResetStatement`) -- sine at its rising zero
 * crossing, triangle/ramp-up at -1, square/ramp-down at +1. History: docs/HISTORY.md.
 */

/**
 * An LFO's per-sample phase increment: once per block while `rate` is unwired (a block constant,
 * output-identical -- params only change between blocks; it used to be converted every sample),
 * per sample from the wired inlet otherwise.
 */
function lfoRate(
  convert: string,
  suffix: string,
  inlets: Record<string, string | undefined>
): ReturnType<typeof blockValue> {
  return blockValue(
    'blkLfoRate',
    suffix,
    inlets.rate !== undefined
      ? `${convert}(${additiveInletExpr('ratePercent', suffix, inlets.rate, RATE_INLET_DEPTH)})`
      : `${convert}(ratePercent_${suffix})`,
    [inlets.rate]
  )
}

/**
 * Every `logue/lfo/*` primitive's `trig` inlet: a rising edge (the usual `>=0.5f` gate read, see
 * the gate convention in CLAUDE.md) sets the phase to `resetPhase`, usually from
 * `logue/sense/gate` for a note-synced LFO. Emitted after the phase advance, so the reset shows
 * one sample late -- inaudible, and it keeps `renderExpr` a pure read of the phase with no new
 * helper. Only emitted when wired: `prevTrig_` is always declared (`memberDecls` can't see
 * wiring), but an unwired LFO spends no cycles on it. A legato/overlapping note-on never drops
 * `sense/gate`, so it gives no rising edge and no reset -- disclosed, not worked around.
 */
function lfoTrigResetStatement(
  suffix: string,
  trig: string | undefined,
  resetPhase: string
): string {
  if (trig === undefined) return ''
  return (
    `      float trigOpen_${suffix} = (${trig} >= 0.5f) ? 1.f : 0.f;\n` +
    `      if (trigOpen_${suffix} > prevTrig_${suffix}) phase_${suffix} = ${resetPhase};\n` +
    `      prevTrig_${suffix} = trigOpen_${suffix};\n`
  )
}

/** One LFO shape's own phase-to-value mapping -- the only thing that differs between shapes. */
type LfoRenderExpr = (suffix: string) => string

function makeLfoPrimitive(
  idSuffix: string,
  description: string,
  renderExpr: LfoRenderExpr
): LoguePrimitive {
  return {
    id: `logue/lfo/${idSuffix}`,
    // Every shape stays bipolar (see this function's own doc comment above) -- fixed, not
    // 'inherit', since `rate` is control-role, not a signal this primitive passes through.
    outletPolarity: 'bipolar',
    description,
    inlets: [
      { name: 'rate', role: 'control' },
      { name: 'trig', role: 'control' }
    ],
    stateBytesPerInstance: 12, // phase_ + ratePercent_ + prevTrig_, 3 floats -- same for all 5 LFO shapes
    memberDecls: (suffix) =>
      `  float phase_${suffix};\n  float ratePercent_${suffix};\n  float prevTrig_${suffix};\n`,
    initStatement: (suffix) => `    phase_${suffix} = 0.f;\n    prevTrig_${suffix} = 0.f;\n`,
    renderExpr,
    blockConstants: (suffix, inlets) =>
      blockDecls({ rate: lfoRate('lfo_rate_from_percent', suffix, inlets) }),
    advanceStatement: (suffix, inlets) => {
      const rate = lfoRate('lfo_rate_from_percent', suffix, inlets).ref
      return (
        `      phase_${suffix} += ${rate};\n      if (phase_${suffix} >= 1.f) phase_${suffix} -= 1.f;\n` +
        lfoTrigResetStatement(suffix, inlets.trig, '0.f')
      )
    },
    helpers: [LFO_RATE_HELPER, CLAMPF_HELPER],
    params: [
      {
        name: 'RATE',
        unit: LFO_HZ,
        modulatedBy: { inlet: 'rate', shape: 'additive' },
        min: 0,
        max: 100,
        default: 20,
        setStatement: (suffix, valueExpr) => `ratePercent_${suffix} = ${valueExpr};`
      }
    ]
  }
}

// Reuses `osc_sinf` unchanged (a pure phase-ratio-to-sine lookup, no note/pitch dependency of its
// own -- see this file's own module doc comment on why it's shared verbatim across every
// oscillator-shaped primitive already).
export const lfoSinePrimitive = makeLfoPrimitive(
  'sine-lfo',
  'A free-running sine LFO for modulation, independent of the played note. A rising edge on trig (e.g. from sense/gate) restarts it from the top of its cycle.',
  (suffix) => `osc_sinf(phase_${suffix})`
)

// Rises -1->1 over the first half-cycle, falls 1->-1 over the second -- continuous at both the
// midpoint and the wrap (phase=0 and phase=1 both map to -1), so no discontinuity beyond the one
// every shape here already has via `advanceStatement`'s own phase wrap.
export const lfoTrianglePrimitive = makeLfoPrimitive(
  'triangle-lfo',
  'A free-running triangle LFO for modulation, independent of the played note. A rising edge on trig (e.g. from sense/gate) restarts it from the top of its cycle.',
  (suffix) => `(phase_${suffix} < 0.5f ? phase_${suffix} * 4.f - 1.f : 3.f - phase_${suffix} * 4.f)`
)

// High (+1) for the first half-cycle, low (-1) for the second -- an arbitrary but standard phase
// convention (matches `phase=0` being the sine shape's own zero-crossing-going-up point).
export const lfoSquarePrimitive = makeLfoPrimitive(
  'square-lfo',
  'A free-running square LFO for modulation, independent of the played note. A rising edge on trig (e.g. from sense/gate) restarts it from the top of its cycle.',
  (suffix) => `(phase_${suffix} < 0.5f ? 1.f : -1.f)`
)

// Rises linearly -1->1 across the full cycle then snaps back to -1 on wrap -- no `-lfo` suffix
// needed: no `logue/osc/ramp*` exists to collide with in the palette's derived label.
export const lfoRampUpPrimitive = makeLfoPrimitive(
  'ramp-up',
  'A free-running rising ramp LFO for modulation, independent of the played note. A rising edge on trig (e.g. from sense/gate) restarts it from the top of its cycle.',
  (suffix) => `(phase_${suffix} * 2.f - 1.f)`
)

// The mirror of ramp-up: falls linearly 1->-1 across the full cycle then snaps back to 1 on wrap.
export const lfoRampDownPrimitive = makeLfoPrimitive(
  'ramp-down',
  'A free-running falling ramp LFO for modulation, independent of the played note. A rising edge on trig (e.g. from sense/gate) restarts it from the top of its cycle.',
  (suffix) => `(1.f - phase_${suffix} * 2.f)`
)

/**
 * A naive (deliberately NOT PolyBLEP-corrected) pulse from `-1` to `+1`, meant as a fast
 * modulation/clock source -- e.g. the `trig` of `logue/util/sample-hold`, where band-limiting would
 * smear the edge a trigger input thresholds on. Aliases audibly if used as an audio oscillator;
 * `logue/osc/square`/`pulse` are the tools for that.
 *
 * `TRACK` (same on/off convention as comb/svf) picks the phase increment: off, a free `RATE`
 * (0.1Hz-2kHz); on, the played note via `transposedW0Expr` with `COARSE`/`FINE`/`pitch`. No
 * `harmonic` inlet: its x16 can push the increment past 1, which the single-`if` wrap can't
 * handle. `WIDTH=0`/`100` is a constant `-1`/`+1` -- no edges at all, so nothing downstream
 * triggers (disclosed, not clamped away: it's the honest end of the dial).
 */
export const fastSquareLfoPrimitive: LoguePrimitive = {
  id: 'logue/lfo/fast-square',
  outletPolarity: 'bipolar',
  stateBytesPerInstance: 28, // phase_ + ratePercent_ + width_ + coarse_ + fine_ + track_ + prevTrig_, 7 floats
  description:
    'A naive (not band-limited) -1/+1 pulse wave, free-running from 0.1 Hz to 2 kHz or tracking the played note. Meant as a fast clock/trigger source, e.g. for trig hold. A rising edge on trig restarts its cycle.',
  inlets: [
    { name: 'rate', trackGate: PITCH_TRACKED_GATE, role: 'control' },
    { name: 'pitch', trackGate: NEEDS_TRACK_GATE, role: 'control' },
    { name: 'width', role: 'control' },
    { name: 'trig', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  float phase_${suffix};\n` +
    `  float ratePercent_${suffix};\n` +
    `  float width_${suffix};\n` +
    `  float coarse_${suffix};\n` +
    `  float fine_${suffix};\n` +
    `  float track_${suffix};\n` +
    `  float prevTrig_${suffix};\n`,
  initStatement: (suffix) => `    phase_${suffix} = 0.f;\n    prevTrig_${suffix} = 0.f;\n`,
  renderExpr: (suffix, inlets) => {
    const width =
      inlets.width !== undefined
        ? `${additiveInletExpr('width', suffix, inlets.width, WIDTH_INLET_DEPTH)} * 0.01f`
        : `width_${suffix} * 0.01f`
    return `(phase_${suffix} < ${width} ? 1.f : -1.f)`
  },
  blockConstants: (suffix, inlets) =>
    blockDecls({
      rate: lfoRate('fast_lfo_rate_from_percent', suffix, inlets),
      w0: transposedW0(suffix, inlets)
    }),
  advanceStatement: (suffix, inlets) => {
    const rate = lfoRate('fast_lfo_rate_from_percent', suffix, inlets).ref
    const increment = `(track_${suffix} >= ${TRACK_ON_RAW_THRESHOLD}.f ? ${transposedW0(suffix, inlets).ref} : ${rate})`
    return (
      `      phase_${suffix} += ${increment};\n      if (phase_${suffix} >= 1.f) phase_${suffix} -= 1.f;\n` +
      lfoTrigResetStatement(suffix, inlets.trig, '0.f')
    )
  },
  helpers: [FAST_LFO_RATE_HELPER, NOTE_W0_HELPER, CLAMPF_HELPER],
  params: [
    {
      name: 'RATE',
      unit: FAST_LFO_HZ,
      modulatedBy: {
        inlet: 'rate',
        shape: 'additive',
        note: 'only applies in free-running mode (TRACK off)'
      },
      trackGate: PITCH_TRACKED_GATE,
      min: 0,
      max: 100,
      default: 30,
      setStatement: (suffix, valueExpr) => `ratePercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'WIDTH',
      unit: PERCENT,
      modulatedBy: { inlet: 'width', shape: 'additive' },
      nts1mkiiType: 'percent',
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `width_${suffix} = ${valueExpr};`
    },
    { ...COARSE_PARAM, trackGate: NEEDS_TRACK_GATE },
    { ...FINE_PARAM, trackGate: NEEDS_TRACK_GATE },
    {
      name: 'TRACK',
      booleanWidget: TRACK_WIDGET,
      min: 0,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `track_${suffix} = ${valueExpr};`
    }
  ]
}

/**
 * `logue/lfo/random-steps`: at each RATE-driven wrap it latches whatever is wired into `in` --
 * `logue/osc/noise` for classic random steps, or any signal for a stepped version of it. Unwired
 * `in` falls back to `noise_step` (per-instance seed like `noisePrimitive`) rather than silence,
 * because random steps is the main use and a bare instance should just work.
 *
 * The state update lives inside `sample_hold_step`, called from `renderExpr` (`advanceStatement`
 * is a no-op): the output is a step function of the wrap itself, so the wrap has to be resolved
 * before this sample's output or the new value would show one sample late.
 *
 * `held_`/`seed_` are declared even when `in` is wired (`memberDecls` can't see wiring), a few
 * bytes of dead state. Until the first wrap the output is 0 -- up to 10 s at `RATE=0`, ~0.25 s at
 * the default 20. History: docs/HISTORY.md.
 */
const SAMPLE_HOLD_HELPER: HelperBlock = {
  key: 'sample_hold_step',
  code: `  static float sample_hold_step(float *phase, float rate, float *held, float sampleValue)
  {
    *phase += rate;
    if (*phase >= 1.f)
    {
      *phase -= 1.f;
      *held = sampleValue;
    }
    return *held;
  }
`
}

// Named `logue/lfo/sample-hold` until 2026-09-28: it's an LFO that steps to a new random value at
// RATE (noise is its default input), while the sample-and-hold proper -- latching an input on a
// trigger -- is `logue/util/sample-hold` (formerly `trig-hold`). Id-only rename, C++ unchanged.
export const randomStepsPrimitive: LoguePrimitive = {
  id: 'logue/lfo/random-steps',
  outletPolarity: 'inherit',
  stateBytesPerInstance: 20, // phase_ + ratePercent_ + held_ + seed_(uint32_t) + prevTrig_, 5 x 4 bytes
  description:
    'A stepped random LFO: jumps to a new random value at RATE and holds it until the next step. Wire a signal into `in` to step through that instead of noise. A rising edge on trig restarts the clock and takes a fresh value. To latch an input on your own trigger, use util/sample-hold.',
  inlets: [
    { name: 'in', role: 'audio' },
    { name: 'rate', role: 'control' },
    { name: 'trig', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  float phase_${suffix};\n` +
    `  float ratePercent_${suffix};\n` +
    `  float held_${suffix};\n` +
    `  uint32_t seed_${suffix};\n` +
    `  float prevTrig_${suffix};\n`,
  initStatement: (suffix) =>
    `    phase_${suffix} = 0.f;\n` +
    `    held_${suffix} = 0.f;\n` +
    `    prevTrig_${suffix} = 0.f;\n` +
    `    seed_${suffix} = ${hashSuffixToSeed(suffix)}u;\n`,
  blockConstants: (suffix, inlets) =>
    blockDecls({ rate: lfoRate('lfo_rate_from_percent', suffix, inlets) }),
  renderExpr: (suffix, inlets) => {
    const rate = lfoRate('lfo_rate_from_percent', suffix, inlets).ref
    const sampleValue = inlets.in !== undefined ? `(${inlets.in})` : `noise_step(&seed_${suffix})`
    return `sample_hold_step(&phase_${suffix}, ${rate}, &held_${suffix}, ${sampleValue})`
  },
  // Resets to 1.f, not 0.f: the next `sample_hold_step` then wraps and latches at once, so a
  // retrigger (e.g. every note-on) samples a fresh value instead of holding the previous note's
  // one for a whole period.
  advanceStatement: (suffix, inlets) => lfoTrigResetStatement(suffix, inlets.trig, '1.f'),
  helpers: [SAMPLE_HOLD_HELPER, LFO_RATE_HELPER, CLAMPF_HELPER, NOISE_STEP_HELPER],
  params: [
    {
      name: 'RATE',
      unit: LFO_HZ,
      modulatedBy: { inlet: 'rate', shape: 'additive' },
      min: 0,
      max: 100,
      default: 20,
      setStatement: (suffix, valueExpr) => `ratePercent_${suffix} = ${valueExpr};`
    }
  ]
}

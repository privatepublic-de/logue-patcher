import {
  ALLPASS_MS,
  COMB_CUTOFF_MS,
  NEEDS_TRACK_GATE,
  PERCENT,
  PITCH_TRACKED_GATE,
  SEMITONES,
  TRACK_WIDGET
} from '../paramPresentation'
import type { HelperBlock, LoguePrimitive } from './types'
import {
  blockDecls,
  blockValue,
  type BlockValue,
  CLAMPF_HELPER,
  COARSE_PARAM,
  CUTOFF_WARP_HELPER,
  FINE_PARAM,
  HILBERT_STATE_FLOATS,
  HILBERT_STEP_HELPER,
  NOTE_W0_HELPER,
  ONEPOLE_HELPER,
  TRACK_ON_RAW_THRESHOLD,
  additiveInletExpr,
  transposedW0Expr
} from './shared'

/** A wired `cutoff` adds to the dial at depth 100 (the whole range), so a bipolar LFO swings
 *  around CUTOFF and a 0..1 source wired over a dial at 0 is the pre-v4 "replace" exactly (see
 *  `migrateAdditiveDialInlets`). `cutoff_warp` clamps, so the sum needs no clamp here. */
function cheapCutoffExpr(suffix: string, inlets: Record<string, string | undefined>): string {
  return inlets.cutoff !== undefined
    ? `(cutoff_${suffix} + (${inlets.cutoff}))`
    : `cutoff_${suffix}`
}

/**
 * A one-pole lowpass (`y = z1 + a*(x - z1)`; `a=1` passes through, `a=0` is fully closed).
 * Deliberately not Hz-accurate: a real `1 - exp(-2*pi*fc/fs)` coefficient needs libm's `expf`,
 * which costs code size against the 32 KB budget (and `expf` doesn't link on the xd). The id's
 * "-cheap" says so in the palette. Revisit only if a patch needs Hz-accurate tuning.
 *
 * `a` goes through `cutoff_warp` (a cube) because the one-pole's cutoff is logarithmic in `a`
 * (`fc ~= -(fs/2*pi)*ln(1-a)`): a linear `a` sweeps nearly the whole audible range in the bottom
 * ~10% of its travel, which sounds steppy. The warp sits in `renderExpr`, not in `setStatement`,
 * so a wired `cutoff` (which bypasses the param) gets it too. `CUTOFF` defaults to 100 (open) so
 * a fresh filter never mutes what's wired through it. The state update lives in `onepole_step`
 * because the next state is the output just computed; `advanceStatement` is empty on purpose.
 * History: docs/HISTORY.md.
 */
export const lowpassCheapFilterPrimitive: LoguePrimitive = {
  id: 'logue/filter/lowpass-cheap',
  outletPolarity: 'inherit',
  stateBytesPerInstance: 8, // z1_ + cutoff_, 2 floats
  description: 'A simple one-pole lowpass filter that darkens a signal as CUTOFF is lowered.',
  inlets: [
    { name: 'in', role: 'audio' },
    { name: 'cutoff', role: 'control' }
  ],
  memberDecls: (suffix) => `  float z1_${suffix};\n  float cutoff_${suffix};\n`,
  initStatement: (suffix) => `    z1_${suffix} = 0.f;\n`,
  renderExpr: (suffix, inlets) =>
    `onepole_step(&z1_${suffix}, ${inlets.in ?? '0.f'}, cutoff_warp(${cheapCutoffExpr(suffix, inlets)}))`,
  advanceStatement: () => '',
  helpers: [ONEPOLE_HELPER, CUTOFF_WARP_HELPER],
  params: [
    {
      name: 'CUTOFF',
      modulatedBy: { inlet: 'cutoff', shape: 'additive' },
      min: 0,
      max: 100,
      default: 100,
      setStatement: (suffix, valueExpr) => `cutoff_${suffix} = ${valueExpr} * 0.01f;`
    }
  ]
}

/**
 * A one-pole HIGHPASS filter -- phase 10, the highpass complement to `lowpassCheapFilterPrimitive`
 * above. NOT a separate filter topology: `in - onepole_step(...)` is definitionally "everything
 * the matching lowpass would have removed" (a one-pole highpass is the dry signal minus its own
 * lowpassed version). Shares BOTH `lowpassCheapFilterPrimitive`'s helpers verbatim
 * (`onepole_step`, `cutoff_warp`) -- deduped the same way two `lowpass-cheap` instances already
 * dedupe a single `onepole_step` emission (see that primitive's own test), now extended across
 * two different primitive types sharing the same helper keys.
 *
 * `CUTOFF` defaults to 0 (fully OPEN/passthrough) -- the OPPOSITE of `lowpass-cheap`'s own
 * default of 100 -- a deliberate asymmetry, not an inconsistency. At `a=1` (`CUTOFF=100`), the
 * shared one-pole tracks the input perfectly every sample (`z1` immediately equals `x`), so
 * `in - onepole_step(...)` is exactly 0 -- total silence, regardless of input. At `a=0`
 * (`CUTOFF=0`), `z1` never updates (frozen at its init value, 0), so the output is `in - 0 = in`,
 * an unfiltered passthrough. Defaulting to 0 preserves this filter's own "never silently mute
 * whatever's wired through it" guarantee -- the same principle behind `lowpass-cheap`'s own
 * `CUTOFF=100` default, just anchored at the opposite end of the identical underlying
 * coefficient (turning `CUTOFF` up still sweeps the SAME direction sonically either way: away
 * from "does nothing" and toward "removes more of the signal", matching a real hardware
 * highpass knob's own expected feel).
 */
export const highpassCheapFilterPrimitive: LoguePrimitive = {
  id: 'logue/filter/highpass-cheap',
  outletPolarity: 'inherit',
  stateBytesPerInstance: 8, // z1_ + cutoff_, 2 floats
  description:
    'A simple one-pole highpass filter, the complement of lowpass cheap -- thins a signal as CUTOFF is raised.',
  inlets: [
    { name: 'in', role: 'audio' },
    { name: 'cutoff', role: 'control' }
  ],
  memberDecls: (suffix) => `  float z1_${suffix};\n  float cutoff_${suffix};\n`,
  initStatement: (suffix) => `    z1_${suffix} = 0.f;\n`,
  renderExpr: (suffix, inlets) =>
    `((${inlets.in ?? '0.f'}) - onepole_step(&z1_${suffix}, ${inlets.in ?? '0.f'}, cutoff_warp(${cheapCutoffExpr(suffix, inlets)})))`,
  advanceStatement: () => '',
  helpers: [ONEPOLE_HELPER, CUTOFF_WARP_HELPER],
  params: [
    {
      name: 'CUTOFF',
      modulatedBy: { inlet: 'cutoff', shape: 'additive' },
      min: 0,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `cutoff_${suffix} = ${valueExpr} * 0.01f;`
    }
  ]
}

/**
 * A feedback comb with a damping filter in the loop (the extended Karplus-Strong topology):
 * `y = x + feedback*onepole(buf[read])`, so higher harmonics fade faster each pass and a
 * continuous input rings as swept bands rather than one buzzy pitch.
 *
 * - `TUNE` sets the delay length: 1..511 samples (never 0, a same-sample loop), inverted like a
 *   cutoff (100 = shortest = highest), linear in samples and deliberately not calibrated to Hz;
 *   integer reads, so short delays are pitch-quantized. 512 samples (2 KB) reaches ~94 Hz --
 *   `logue/filter/string` is the bass-capable, finely tuned one.
 * - `TRACK` on replaces `TUNE` with the played note's period, `1/transposedW0Expr` (no libm).
 *   It is its own switch rather than "wire sense/pitch into pitch", which would add the note
 *   twice; a linear wire into `tune` can't track either (period is exponential in semitones).
 *   `COARSE`/`FINE` offset the tracked pitch and are inert while it's off.
 * - `FEEDBACK` defaults to an audible 60 (at 0 the node is a silent passthrough, which once made
 *   a fresh instance look broken) and caps at 0.999; the one-pole never amplifies, so the loop
 *   is stable at every setting.
 * - `DAMPING` is `1 - warp(percent)*0.95`: 1.0 is an undamped loop, and it floors at 0.05
 *   because `onepole_step` freezes at 0. It adds phase lag, which detunes a tracked pluck a
 *   little as it rises.
 * - All three are additive (+-50) inlets on the raw percent, before the warp.
 *
 * Old names (`DELAY`/`FEEDBACK` before phase 33, `CUTOFF`/`GAIN` until 2026-09-28) resolve
 * through `renamedParams`/`renamedInlets`; `DELAY` ran the other way and is only flagged. The
 * reasoning and measurements behind all of this are in docs/HISTORY.md.
 */
const COMB_MAX_DELAY_SAMPLES = 512

const COMB_STEP_HELPER: HelperBlock = {
  key: 'comb_step',
  code: `  // The DC blocker on the fed-back tap (a ~1.5 Hz one-pole highpass) keeps a continuously fed
  // loop from integrating its input's DC and sub-audio drift: at FEEDBACK 0.999 that built up to
  // several times full scale with a bowed exciter. Its phase lag detunes a tracked pitch by about
  // 4 cents at the lowest note (~94 Hz) and under 2 at middle C.
  static float comb_step(float *buf, int *writeIdx, float *dampZ1, float *dcX1, float *dcY1, int delaySamples, float gain, float dampingA, float x)
  {
    int readIdx = *writeIdx - delaySamples;
    if (readIdx < 0) readIdx += ${COMB_MAX_DELAY_SAMPLES};
    float delayed = buf[readIdx];
    float damped = onepole_step(dampZ1, delayed, dampingA);
    float blocked = damped - *dcX1 + 0.9998f * *dcY1;
    *dcX1 = damped;
    *dcY1 = blocked;
    float y = x + gain * blocked;
    // Only what recirculates is limited, softly above a knee: exactly linear up to 0.6, then a
    // parabola that meets 1.0 with zero slope (at 1.4). A loop fed continuously (a bowed exciter
    // at high FEEDBACK) then settles near full scale instead of growing to several times it;
    // plucks decay below the knee and ring as before, and FEEDBACK 0 stays an exact passthrough.
    float stored = y;
    float mag = stored < 0.f ? -stored : stored;
    if (mag > 0.6f)
    {
      float over = mag - 0.6f;
      if (over > 0.8f) over = 0.8f;
      mag = 0.6f + over - 0.625f * over * over;
      stored = stored < 0.f ? -mag : mag;
    }
    buf[*writeIdx] = stored;
    *writeIdx = *writeIdx + 1;
    if (*writeIdx >= ${COMB_MAX_DELAY_SAMPLES}) *writeIdx = 0;
    return y;
  }
`
}

const COMB_CUTOFF_INLET_DEPTH = 50
const COMB_GAIN_INLET_DEPTH = 50
const COMB_DAMPING_INLET_DEPTH = 50
// `1 - warp(DAMPING*0.01)*(1-DAMPING_MIN_A)` -- see combFilterPrimitive's own doc comment for why
// this floors at 0.05 rather than 0, and `comb_response_warp`'s own doc comment for why DAMPING
// (and GAIN) are no longer a plain linear map.
const DAMPING_MIN_A = 0.05

/**
 * An ease-out warp (`1-(1-t)^2`, no libm) on the combined (dial + inlet) percent of `FEEDBACK`
 * (field `gainPercent_`, formerly `GAIN`) and `DAMPING` before it becomes a coefficient; `string`
 * reuses it for its `DAMPING` and wired `DECAY`. Cycles to -60 dB is `ln(0.001)/ln(g)`, which has
 * a pole as `g` nears 1 (~10 cycles at g=0.5, ~65 at 0.9, ~625 at 0.989), so a linear map put
 * nearly all the audible ring times in the last ~20% of the dial. Warped, 50% gives g ~0.749
 * (~24 cycles), which the linear map needed 76% to reach. Steeper than `cutoff_warp` because this
 * relationship is steeper. The endpoints are exact, so 0 and 100 mean what they always did; the
 * middle changed, a disclosed silent change for documents with non-default values.
 * History: docs/HISTORY.md.
 */
function combResponseWarpExpr(t: string): string {
  return `comb_response_warp(${t})`
}

const COMB_RESPONSE_WARP_HELPER: HelperBlock = {
  key: 'comb_response_warp',
  code: `  static float comb_response_warp(float t)
  {
    if (t < 0.f) t = 0.f;
    else if (t > 1.f) t = 1.f;
    return 1.f - (1.f - t) * (1.f - t);
  }
`
}

function combCutoffSamplesExpr(suffix: string, inlets: Record<string, string | undefined>): string {
  const percent =
    inlets.tune !== undefined
      ? additiveInletExpr('cutoffPercent', suffix, inlets.tune, COMB_CUTOFF_INLET_DEPTH)
      : `cutoffPercent_${suffix}`
  const freeRunning = `(int)(1.f + (100.f - (${percent})) * 5.10f)`
  const tracked = `(int)clampf(1.f / ${transposedW0Expr(suffix, inlets)}, 1.f, ${COMB_MAX_DELAY_SAMPLES - 1}.f)`
  return `(track_${suffix} >= ${TRACK_ON_RAW_THRESHOLD}.f ? ${tracked} : ${freeRunning})`
}

function combGainExpr(suffix: string, inlets: Record<string, string | undefined>): string {
  const percent =
    inlets.feedback !== undefined
      ? additiveInletExpr('gainPercent', suffix, inlets.feedback, COMB_GAIN_INLET_DEPTH)
      : `gainPercent_${suffix}`
  return `${combResponseWarpExpr(`(${percent}) * 0.01f`)} * 0.999f`
}

function combDampingAExpr(suffix: string, inlets: Record<string, string | undefined>): string {
  const percent =
    inlets.damping !== undefined
      ? additiveInletExpr('dampingPercent', suffix, inlets.damping, COMB_DAMPING_INLET_DEPTH)
      : `dampingPercent_${suffix}`
  return `(1.f - ${combResponseWarpExpr(`(${percent}) * 0.01f`)} * ${(1 - DAMPING_MIN_A).toFixed(2)}f)`
}

/** The delay length (`1/note_w0` when tracked), feedback gain and damping, once per block while unwired. */
function combBlockValues(
  suffix: string,
  inlets: Record<string, string | undefined>
): Record<'delay' | 'gain' | 'damping', BlockValue> {
  return {
    // An int in the C source; it goes through a `const float` local unchanged (at most 511).
    delay: blockValue('blkCombDelay', suffix, combCutoffSamplesExpr(suffix, inlets), [
      inlets.tune,
      inlets.pitch,
      inlets.harmonic
    ]),
    gain: blockValue('blkCombGain', suffix, combGainExpr(suffix, inlets), [inlets.feedback]),
    damping: blockValue('blkCombDamp', suffix, combDampingAExpr(suffix, inlets), [inlets.damping])
  }
}

export const combFilterPrimitive: LoguePrimitive = {
  id: 'logue/filter/comb',
  outletPolarity: 'inherit',
  // buf_[512] (2048 bytes) + writeIdx_(int) + dampZ1_ + dcX1_ + dcY1_ + cutoffPercent_ +
  // gainPercent_ + dampingPercent_ + coarse_ + fine_ + track_ (10 x 4 bytes) -- the one primitive in this
  // registry whose state actually matters for the 32K minilogue-xd budget
  // (~16 combs = the whole pool).
  stateBytesPerInstance: COMB_MAX_DELAY_SAMPLES * 4 + 40,
  description:
    'A resonant comb filter (Karplus-Strong plucked-string style): TUNE sets the pitch it rings at (the delay length), FEEDBACK how long it rings, DAMPING how dark. TRACK tunes it to the played note instead.',
  inlets: [
    { name: 'in', role: 'audio' },
    { name: 'tune', trackGate: PITCH_TRACKED_GATE, role: 'control' },
    { name: 'feedback', role: 'control' },
    { name: 'damping', role: 'control' },
    { name: 'pitch', trackGate: NEEDS_TRACK_GATE, role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  float buf_${suffix}[${COMB_MAX_DELAY_SAMPLES}];\n  int writeIdx_${suffix};\n  float dampZ1_${suffix};\n  float dcX1_${suffix};\n  float dcY1_${suffix};\n  float cutoffPercent_${suffix};\n  float gainPercent_${suffix};\n  float dampingPercent_${suffix};\n  float coarse_${suffix};\n  float fine_${suffix};\n  float track_${suffix};\n`,
  initStatement: (suffix) =>
    `    writeIdx_${suffix} = 0;\n    dampZ1_${suffix} = 0.f;\n    dcX1_${suffix} = 0.f;\n    dcY1_${suffix} = 0.f;\n    for (int i = 0; i < ${COMB_MAX_DELAY_SAMPLES}; i++) buf_${suffix}[i] = 0.f;\n`,
  blockConstants: (suffix, inlets) => blockDecls(combBlockValues(suffix, inlets)),
  renderExpr: (suffix, inlets) => {
    const v = combBlockValues(suffix, inlets)
    return `comb_step(buf_${suffix}, &writeIdx_${suffix}, &dampZ1_${suffix}, &dcX1_${suffix}, &dcY1_${suffix}, ${v.delay.ref}, ${v.gain.ref}, ${v.damping.ref}, ${inlets.in ?? '0.f'})`
  },
  advanceStatement: () => '',
  helpers: [
    COMB_STEP_HELPER,
    ONEPOLE_HELPER,
    CLAMPF_HELPER,
    NOTE_W0_HELPER,
    COMB_RESPONSE_WARP_HELPER
  ],
  // See `FieldAlias`'s own doc comment. 2026-09-28: CUTOFF/GAIN became TUNE/FEEDBACK (user: the
  // MiniFreak names hid that one sets the delay length -- the pitch -- and the other is the loop
  // feedback). Same values, same direction, so both are value-preserving; FEEDBACK was also this
  // param's name before phase 33, so a pre-phase-33 file resolves again with no alias at all.
  // `DELAY`/`delay` inverted direction on the way to CUTOFF (see this primitive's own doc
  // comment above), so an old value is flagged, never silently remapped.
  renamedParams: [
    { from: 'GAIN', to: 'FEEDBACK', valuePreserving: true },
    { from: 'CUTOFF', to: 'TUNE', valuePreserving: true },
    {
      from: 'DELAY',
      to: 'TUNE',
      valuePreserving: false,
      note: 'DELAY->TUNE also inverted direction: DELAY=20 was a short/bright delay, but TUNE=20 is a long/dark one. Re-tune this value by ear.'
    }
  ],
  renamedInlets: [
    { from: 'gain', to: 'feedback', valuePreserving: true },
    { from: 'cutoff', to: 'tune', valuePreserving: true },
    {
      from: 'delay',
      to: 'tune',
      valuePreserving: false,
      note: 'delay->tune also inverted direction: a signal that used to push the delay longer now pushes it shorter. Re-check the modulation depth/sign on this wire.'
    }
  ],
  params: [
    {
      name: 'TUNE',
      unit: COMB_CUTOFF_MS,
      modulatedBy: {
        inlet: 'tune',
        shape: 'additive',
        note: 'only applies in free-running mode (TRACK off)'
      },
      trackGate: PITCH_TRACKED_GATE,
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `cutoffPercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'FEEDBACK',
      unit: PERCENT,
      modulatedBy: { inlet: 'feedback', shape: 'additive' },
      min: 0,
      max: 100,
      default: 60,
      setStatement: (suffix, valueExpr) => `gainPercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'DAMPING',
      unit: PERCENT,
      modulatedBy: { inlet: 'damping', shape: 'additive' },
      min: 0,
      max: 100,
      default: 20,
      setStatement: (suffix, valueExpr) => `dampingPercent_${suffix} = ${valueExpr};`
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

// Real, user-reported miss (2026-09-25): "pitch tracking gets off in the low register below
// midi note 36." Root cause, confirmed by re-deriving string_step's own delay/compensation math
// numerically rather than assumed: at the original 1024, stringDelaySamplesExpr's own clamp
// (delaySamples capped at STRING_MAX_DELAY_SAMPLES-4) pinned the delay length at ~1020 samples
// for any note below ~46.9Hz (MIDI note ~30) -- the string's real closed-loop pitch stopped
// descending entirely below that, and the last several semitones approaching that ceiling were
// ALSO measurably sharp (the tuning-compensation math fighting an increasingly tight budget as
// delaySamples gets pushed toward the cap), matching a "gets off" impression starting a bit
// above the literal flatline point. This was a real, disclosed, PRECEDENTED tradeoff (matching
// `peterall/eurorack-prologue`'s `mo2_string` on the same 32KB budget), not an oversight -- but
// the user asked for the extended bass range anyway, accepting the real RAM cost: doubling to
// 2048 (the wraparound bitmask needs a power of two, so this is the only real step up) pushes the
// floor down to ~23.5Hz (MIDI note ~18), comfortably covering the practical bass range, at
// roughly DOUBLE this primitive's own per-instance RAM (~13% -> ~25% of minilogue xd's 32KB
// budget) -- measured numbers in docs/HISTORY.md.
const STRING_MAX_DELAY_SAMPLES = 2048
const STRING_STRUCTURE_INLET_DEPTH = 50
const STRING_DAMPING_INLET_DEPTH = 50
const STRING_DECAY_INLET_DEPTH = 50
/**
 * Dispersion: 8 first-order allpass stages sharing ONE coefficient (scaled-down stages detune
 * less; the effect is steeply nonlinear in the coefficient).
 *
 * The loop's delay is shortened by each stage's DC group delay, `(1+c)/(1-c)`, so strong
 * dispersion eats a roughly note-independent budget out of a period that shrinks with pitch.
 * `string_step` therefore solves, per note, the largest `c` the remaining budget affords
 * (`STAGES*(1+c)/(1-c) <= budget`) and clamps the STRUCTURE-derived value to it, so high notes
 * taper instead of losing their tuning.
 *
 * `STRING_DISPERSION_MAX` is 0.72: the DC approximation drifts at high `c` and pitch (0.85 put
 * C5's fundamental +66 ct out; 0.72 keeps it ~13 ct). Stronger dispersion needs a
 * frequency-aware compensation or a real dispersion delay line -- open. The measurements and the
 * three rounds that led here: docs/HISTORY.md.
 */
const STRING_DISPERSION_STAGES = 8
// The strongest coefficient STRUCTURE=100 can ask for. NOT 0.85 -- see this constant's own doc
// comment history for why that broke fundamental tuning (up to +66 cents at C5) despite being
// "safe" by the runtime budget clamp above; 0.72 is the measured point past which tuning drift
// at the top of the practical register starts exceeding ~15 cents.
const STRING_DISPERSION_MAX = 0.72
// Extra headroom (beyond the hard `compensatedDelay>=2` floor in `string_step`) the runtime
// safety-clamp calculation reserves before computing how much coefficient a note's period can
// afford -- keeps the Hermite read comfortably away from the degenerate very-short-delay corner
// even at the top of the safely-dispersible range, not just technically non-negative.
const STRING_DISPERSION_MIN_HEADROOM = 8.0
// DECAY's own loop-gain ceiling for the WIRED-inlet fallback path only (see `stringDecayGainExpr`'s
// own doc comment for why a wired `decay` inlet can't use the register-independent noteOn-time
// formula below and falls back to this older, cycle-count-based, register-DEPENDENT shape --
// same math comb's own `GAIN` uses, just a higher ceiling). Still unconditionally BIBO-stable at
// any value below 1 (same reasoning as comb's own `0.999` doc comment).
const STRING_DECAY_MAX_GAIN = 0.9998
// DECAY's percent->seconds range for the unwired path (see `stringDecayGainExpr`): affine
// 0.05 s-30 s, the same plain shape as `env_rate_from_percent`. Not run through
// `comb_response_warp`: that curve fixes the pole in a percent->coefficient map, and this path
// solves the coefficient from a target time, so there is no pole. DECAY=100 is a separate case,
// not the top of this range: `noteOnStatement` sets `decayGain_ = 1`, because no finite ring time
// sounds like an undamped string. That is exactly lossless at the fundamental, since
// `onepole_step`/`allpass1_step` are unity-gain there -- the same accepted idealization as svf's
// `RESONANCE=100` -> `k=0`. History: docs/HISTORY.md.
const STRING_DECAY_MIN_SECONDS = 0.05
const STRING_DECAY_MAX_SECONDS = 30.0
// ln(0.001) (the "-60dB" RT60-style threshold this whole registry already uses for comb/this
// primitive's own cycle-count reasoning) -- computed once here at CODEGEN time (a real TS
// constant), not a runtime `logf` call.
const STRING_DECAY_LN_THRESHOLD = Math.log(0.001)

const STRING_EXP_APPROX_HELPER: HelperBlock = {
  key: 'exp_approx',
  code: `  // Range-reduced Padé[2/2] approximation of exp(x) -- NOT a real \`expf\` call, a deliberate,
  // real finding: unlike \`tanf\` (which links clean, no extra stubs needed; svf used it until
  // 2026-09-30), a real local-toolchain build failed to LINK \`expf\` at all --
  // its newlib implementation pulls in the full reentrant syscall stubs (_sbrk/_read/_write/
  // _close/_lseek), none of which this minimal embedded target provides, a real toolchain-
  // version-specific risk this approximation sidesteps entirely by staying libm-free like the
  // rest of this file. Plain Padé[2/2] (accurate only very close to 0) is range-reduced first
  // (x/8, applied, then squared 3 times -- the standard "exp via repeated squaring" trick) for
  // accuracy across the WIDER range this primitive's own noteOn-time decay-gain formula
  // actually uses -- verified numerically to <0.01% relative error across that whole range
  // (x in roughly [-3, 0]), far tighter than a musical decay-time control needs.
  static float exp_approx(float x)
  {
    float y = x * 0.125f;
    float y2 = y * y;
    float r = (1.f + y * 0.5f + y2 * (1.f/12.f)) / (1.f - y * 0.5f + y2 * (1.f/12.f));
    r = r * r;
    r = r * r;
    r = r * r;
    return r;
  }
`
}

const STRING_ALLPASS1_HELPER: HelperBlock = {
  key: 'allpass1_step',
  code: `  // First-order allpass ("Schroeder" direct form) -- a real, standard, cheap technique for
  // approximating a plucked string's stiffness-driven dispersion (higher partials arriving
  // very slightly out of phase with the fundamental, the actual character that makes a struck/
  // plucked string sound different from a metallic comb resonance) WITHOUT the separate
  // multi-hundred-sample allpass delay LINE Rings'/Plaits' own string engine uses for the same
  // effect -- a disclosed simplification, traded for real per-instance RAM: this needs 2 floats
  // of state per stage, not a few hundred.
  static float allpass1_step(float *z, float x, float a)
  {
    float y = -a * x + *z;
    *z = x + a * y;
    return y;
  }
`
}

const STRING_DC_BLOCKER_HELPER: HelperBlock = {
  key: 'dc_blocker_step',
  code: `  // One-pole DC blocker on the final OUTPUT sample (not inside the recirculating loop --
  // matching Rings' own placement): the damping/dispersion cascade can drift a small DC bias
  // over a long ring that comb's simpler single-onepole loop doesn't accumulate the same way.
  // R=0.995 is a standard, cheap corner choice -- removes DC without perceptibly touching the
  // audible band.
  static float dc_blocker_step(float *x1, float *y1, float x)
  {
    float y = x - *x1 + 0.995f * (*y1);
    *x1 = x;
    *y1 = y;
    return y;
  }
`
}

const STRING_STEP_HELPER: HelperBlock = {
  key: 'string_step',
  code: `  // Karplus-Strong plucked-string loop: a circular delay line read via 4-point Hermite
  // interpolation (unlike logue/filter/comb's own plain integer-indexed read, this gives a
  // continuously, accurately tuned string rather than comb's disclosed sample-quantized pitch),
  // then a damping one-pole (brightness/decay-rate shaping, the same onepole_step comb already
  // uses) and an ${STRING_DISPERSION_STAGES}-stage first-order allpass cascade (dispersion/
  // stiffness -- see allpass1_step's own doc comment) before being fed back into the loop with
  // the new excitation sample added. STRING_MAX_DELAY_SAMPLES must stay a power of two -- every
  // tap below uses a bitmask, not a conditional wraparound, relying on two's-complement
  // negative-index masking working correctly for a power-of-two size (a real, standard
  // technique -- stmlib's own DelayLine<T,N> uses the identical trick).
  //
  // ${STRING_DISPERSION_STAGES} stages sharing ONE coefficient (was 3 stages with DIFFERENT,
  // progressively-scaled coefficients -- a real, measured mistake, see STRING_DISPERSION_STAGES's
  // own doc comment). \`apz\` points at a fixed-size \`float[${STRING_DISPERSION_STAGES}]\` state
  // array (not individually-named pointers), since the stage count itself may need retuning
  // again.
  //
  // RUNTIME DISPERSION SAFETY CLAMP (2026-09-25, the real fix for a genuine bug found via a
  // "most pronounced on higher notes" report -- see STRING_DISPERSION_STAGES's own doc comment
  // for the full story): a coefficient strong enough to be audible at low notes costs a large,
  // roughly note-INDEPENDENT amount of compensation, which can EXCEED a high note's own short
  // period -- silently breaking pitch tracking, not just capping dispersion. Solved properly:
  // compute the actual maximum coefficient THIS note's period can afford
  // (STAGES*(1+c)/(1-c) <= budget, solved for c), and clamp the STRUCTURE-derived desired
  // coefficient down to that safe ceiling BEFORE it's used for anything (both the compensation
  // below and the actual allpass processing use the SAME, already-safe value, so they can never
  // disagree).
  //
  // TUNING COMPENSATION (added after a real "accurate in the bass register, badly sharp above
  // C3" report): the loop's own onepole damping filter and allpass dispersion cascade each add a
  // small, real group delay (phase lag) ON TOP of the delay LINE's own length -- a basic
  // Karplus-Strong fact this first version missed. Fixed by subtracting each stage's own DC
  // group delay -- onepole_step's is the standard one-pole result (1-a)/a; allpass1_step's is
  // (1+c)/(1-c) for its form (z^-1-c)/(1-c*z^-1), confirmed against its own transfer function,
  // not assumed -- from the target delay BEFORE the Hermite read, so the loop's real closed-loop
  // period matches the requested pitch across the whole playable range. All
  // ${STRING_DISPERSION_STAGES} stages share ONE (now safety-clamped) coefficient, so their
  // combined group delay is just that stage count times one allpass delay term.
  static float string_step(float *buf, int *writeIdx, float *dampZ, float *apz,
    float *dcX, float *dcY, float delaySamples, float dampingA, float desiredDispersion,
    float decayGain, float x)
  {
    const int mask = ${STRING_MAX_DELAY_SAMPLES} - 1;
    float onepoleDelay = (1.f - dampingA) / dampingA;
    float dispersionBudget = delaySamples - onepoleDelay - ${STRING_DISPERSION_MIN_HEADROOM.toFixed(1)}f;
    float safeMaxDispersion = 0.f;
    if (dispersionBudget > ${STRING_DISPERSION_STAGES}.f) {
      safeMaxDispersion = (dispersionBudget - ${STRING_DISPERSION_STAGES}.f) / (dispersionBudget + ${STRING_DISPERSION_STAGES}.f);
      if (safeMaxDispersion > ${STRING_DISPERSION_MAX}f) safeMaxDispersion = ${STRING_DISPERSION_MAX}f;
    }
    float dispersion = desiredDispersion;
    if (dispersion > safeMaxDispersion) dispersion = safeMaxDispersion;
    float allpassDelayPerStage = (1.f + dispersion) / (1.f - dispersion);
    float compensatedDelay = delaySamples - onepoleDelay - ${STRING_DISPERSION_STAGES}.f * allpassDelayPerStage;
    if (compensatedDelay < 2.f) compensatedDelay = 2.f;
    float readPos = (float)(*writeIdx) - compensatedDelay;
    int idx = (int)readPos;
    float frac = readPos - (float)idx;
    if (frac < 0.f) { idx -= 1; frac += 1.f; }
    float xm1 = buf[(idx - 1) & mask];
    float x0  = buf[idx & mask];
    float x1  = buf[(idx + 1) & mask];
    float x2  = buf[(idx + 2) & mask];
    float c = (x1 - xm1) * 0.5f;
    float v = x0 - x1;
    float w = c + v;
    float aCoef = w + v + (x2 - x0) * 0.5f;
    float bNeg = w + aCoef;
    float delayed = (((aCoef * frac) - bNeg) * frac + c) * frac + x0;

    float damped = onepole_step(dampZ, delayed, dampingA);
    float dispersed = damped;
    for (int i = 0; i < ${STRING_DISPERSION_STAGES}; i++) {
      dispersed = allpass1_step(&apz[i], dispersed, dispersion);
    }

    float y = x + decayGain * dispersed;
    // The same soft knee as comb_step on what recirculates (linear to 0.6, ceiling 1.0), so a
    // bowed exciter into a long or lossless DECAY settles near full scale instead of growing to
    // several times it. Plucks ring below the knee, and DECAY 100 stays lossless there.
    float stored = y;
    float mag = stored < 0.f ? -stored : stored;
    if (mag > 0.6f)
    {
      float over = mag - 0.6f;
      if (over > 0.8f) over = 0.8f;
      mag = 0.6f + over - 0.625f * over * over;
      stored = stored < 0.f ? -mag : mag;
    }
    buf[*writeIdx] = stored;
    *writeIdx = (*writeIdx + 1) & mask;

    return dc_blocker_step(dcX, dcY, y);
  }
`
}

function stringDelaySamplesExpr(
  suffix: string,
  inlets: Record<string, string | undefined>
): string {
  return `clampf(1.f / ${transposedW0Expr(suffix, inlets)}, 4.f, ${STRING_MAX_DELAY_SAMPLES - 4}.f)`
}

function stringDampingAExpr(suffix: string, inlets: Record<string, string | undefined>): string {
  const percent =
    inlets.damping !== undefined
      ? additiveInletExpr('dampingPercent', suffix, inlets.damping, STRING_DAMPING_INLET_DEPTH)
      : `dampingPercent_${suffix}`
  return `(1.f - ${combResponseWarpExpr(`(${percent}) * 0.01f`)} * ${(1 - DAMPING_MIN_A).toFixed(2)}f)`
}

/**
 * The DESIRED dispersion coefficient from STRUCTURE alone -- no note-dependent factor any more
 * (see docs/HISTORY.md, "above `STRING_DISPERSION_STAGES`", for why that was removed: the thing that
 * actually needs to vary with register is a hard SAFETY ceiling protecting tuning, not a
 * physical-realism guess, and that ceiling is computed at RUNTIME inside `string_step` itself
 * from the note's own real period, not here at codegen time from a semitone approximation).
 * `string_step` clamps this desired value down to whatever the current note can safely afford.
 */
function stringDispersionExpr(suffix: string, inlets: Record<string, string | undefined>): string {
  const percent =
    inlets.structure !== undefined
      ? additiveInletExpr(
          'structurePercent',
          suffix,
          inlets.structure,
          STRING_STRUCTURE_INLET_DEPTH
        )
      : `structurePercent_${suffix}`
  return `((${percent}) * 0.01f * ${STRING_DISPERSION_MAX}f)`
}

/** The tracked delay length (`1/note_w0`), damping and dispersion, once per block while unwired. */
function stringBlockValues(
  suffix: string,
  inlets: Record<string, string | undefined>
): Record<'delay' | 'damping' | 'dispersion', BlockValue> {
  return {
    delay: blockValue('blkStrDelay', suffix, stringDelaySamplesExpr(suffix, inlets), [
      inlets.pitch,
      inlets.harmonic
    ]),
    damping: blockValue('blkStrDamp', suffix, stringDampingAExpr(suffix, inlets), [inlets.damping]),
    dispersion: blockValue('blkStrDisp', suffix, stringDispersionExpr(suffix, inlets), [
      inlets.structure
    ])
  }
}

/**
 * The string's per-cycle loop gain. Unwired (the common case) it's `decayGain_`, computed once per
 * note-on in `noteOnStatement` so DECAY is a real time in any register: a fixed per-cycle gain
 * rings for a number of cycles, and cycles times the note's period varies with pitch.
 * `g = exp(ln(0.001) * period / (targetSeconds * 48000))` reaches -60 dB in exactly
 * `targetSeconds` (0.05-30 s over DECAY 0-99); DECAY=100 sets `g = 1`, lossless (see
 * `STRING_DECAY_MAX_SECONDS`). The exponential is `exp_approx`, since `expf` fails to link.
 *
 * A wired `decay` can't use any of that, because `noteOnStatement` can't see wired inlets. It
 * falls back to comb's register-dependent shape, `comb_response_warp(percent) *
 * STRING_DECAY_MAX_GAIN`, with no lossless top. Accepted: live modulation is a different use from
 * setting how long one pluck rings. History: docs/HISTORY.md.
 */
function stringDecayGainExpr(suffix: string, inlets: Record<string, string | undefined>): string {
  if (inlets.decay !== undefined) {
    const percent = additiveInletExpr(
      'decayPercent',
      suffix,
      inlets.decay,
      STRING_DECAY_INLET_DEPTH
    )
    return `(${combResponseWarpExpr(`(${percent}) * 0.01f`)} * ${STRING_DECAY_MAX_GAIN}f)`
  }
  return `decayGain_${suffix}`
}

/**
 * A Karplus-Strong plucked string: one delay-line loop, so its cost is O(1) however rich it
 * sounds. A modal bank was rejected on cost (8/16 SVF modes ~21%/~41% of the xd's CPU budget).
 *
 * Over `logue/filter/comb` it adds a 4-point Hermite fractional read (continuous tuning), an
 * 8-stage allpass dispersion cascade for stiffness (see `STRING_DISPERSION_STAGES`), and a DC
 * blocker on the output. Always pitch-tracked (no `TRACK`); `COARSE`/`FINE` offset it through
 * `transposedW0Expr`.
 *
 * `STRING_MAX_DELAY_SAMPLES` is 2048 (a power of two for the wrap mask): the floor is ~23.5 Hz
 * (MIDI ~18) at ~25% of the xd's 32 KB for one instance, so a second instance is a tight fit.
 * `DAMPING`/`DECAY` reuse comb's `comb_response_warp` for the same pole-near-1 reason.
 *
 * Techniques adapted (not copied) from Mutable Instruments Rings/Plaits `string.cc` (MIT,
 * Emilie Gillet); named descriptively rather than after either. History: docs/HISTORY.md.
 */
export const pluckedStringPrimitive: LoguePrimitive = {
  id: 'logue/filter/string',
  outletPolarity: 'inherit',
  // buf_[1024] (4096 bytes) + writeIdx_(int) + dampZ_/apz_[8]/dcX_/dcY_/structurePercent_/
  // dampingPercent_/decayPercent_/coarse_/fine_/decayGain_ (18 x 4 bytes)
  stateBytesPerInstance: STRING_MAX_DELAY_SAMPLES * 4 + 72,
  description:
    'A Karplus-Strong plucked-string resonator with stiffness/dispersion and pitch tracking -- a single tuned delay loop, not a modal filter bank.',
  inlets: [
    { name: 'in', role: 'audio' },
    { name: 'pitch', role: 'control' },
    { name: 'structure', role: 'control' },
    { name: 'damping', role: 'control' },
    { name: 'decay', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  float buf_${suffix}[${STRING_MAX_DELAY_SAMPLES}];\n  int writeIdx_${suffix};\n  float dampZ_${suffix};\n  float apz_${suffix}[${STRING_DISPERSION_STAGES}];\n  float dcX_${suffix};\n  float dcY_${suffix};\n  float structurePercent_${suffix};\n  float dampingPercent_${suffix};\n  float decayPercent_${suffix};\n  float coarse_${suffix};\n  float fine_${suffix};\n  float decayGain_${suffix};\n`,
  initStatement: (suffix) =>
    `    writeIdx_${suffix} = 0;\n    dampZ_${suffix} = 0.f;\n    for (int i = 0; i < ${STRING_DISPERSION_STAGES}; i++) apz_${suffix}[i] = 0.f;\n    dcX_${suffix} = 0.f;\n    dcY_${suffix} = 0.f;\n    for (int i = 0; i < ${STRING_MAX_DELAY_SAMPLES}; i++) buf_${suffix}[i] = 0.f;\n    decayGain_${suffix} = 0.99f;\n`,
  // See `stringDecayGainExpr`'s own doc comment for the full story -- this is what makes DECAY
  // an EXACT, register-independent number of real seconds rather than a fixed cycle count, AND
  // (at DECAY=100 exactly) a genuinely lossless "no damping" resonator, matching `logue/filter/
  // svf`'s own `RESONANCE=100`->`k=0` precedent. Recomputed on every real note-on (not just once
  // at init) since the played note's own period is exactly the thing a fixed cycle-count ceiling
  // can't account for.
  noteOnStatement: (suffix) =>
    `    if (decayPercent_${suffix} >= 100.f) {\n` +
    `      decayGain_${suffix} = 1.f;\n` +
    `    } else {\n` +
    `      float p_${suffix} = clampf(1.f / note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_${suffix} + fine_${suffix}), 4.f, ${STRING_MAX_DELAY_SAMPLES - 4}.f);\n` +
    `      float t_${suffix} = ${STRING_DECAY_MIN_SECONDS}f + (decayPercent_${suffix} * 0.01f) * ${(STRING_DECAY_MAX_SECONDS - STRING_DECAY_MIN_SECONDS).toFixed(2)}f;\n` +
    `      decayGain_${suffix} = exp_approx(${STRING_DECAY_LN_THRESHOLD.toFixed(6)}f * p_${suffix} / (t_${suffix} * 48000.f));\n` +
    `    }\n`,
  blockConstants: (suffix, inlets) => blockDecls(stringBlockValues(suffix, inlets)),
  renderExpr: (suffix, inlets) => {
    const v = stringBlockValues(suffix, inlets)
    return `string_step(buf_${suffix}, &writeIdx_${suffix}, &dampZ_${suffix}, apz_${suffix}, &dcX_${suffix}, &dcY_${suffix}, ${v.delay.ref}, ${v.damping.ref}, ${v.dispersion.ref}, ${stringDecayGainExpr(suffix, inlets)}, ${inlets.in ?? '0.f'})`
  },
  advanceStatement: () => '',
  helpers: [
    STRING_STEP_HELPER,
    STRING_ALLPASS1_HELPER,
    STRING_DC_BLOCKER_HELPER,
    STRING_EXP_APPROX_HELPER,
    ONEPOLE_HELPER,
    CLAMPF_HELPER,
    NOTE_W0_HELPER,
    COMB_RESPONSE_WARP_HELPER
  ],
  params: [
    {
      name: 'STRUCTURE',
      modulatedBy: { inlet: 'structure', shape: 'additive' },
      min: 0,
      max: 100,
      default: 20,
      setStatement: (suffix, valueExpr) => `structurePercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'DAMPING',
      modulatedBy: { inlet: 'damping', shape: 'additive' },
      min: 0,
      max: 100,
      default: 30,
      setStatement: (suffix, valueExpr) => `dampingPercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'DECAY',
      modulatedBy: {
        inlet: 'decay',
        shape: 'additive',
        note: 'while wired, decay is per cycle (low notes ring longer) and 100% is no longer lossless'
      },
      min: 0,
      max: 100,
      default: 60,
      setStatement: (suffix, valueExpr) => `decayPercent_${suffix} = ${valueExpr};`
    },
    COARSE_PARAM,
    FINE_PARAM
  ]
}

/**
 * A 2-pole state-variable filter with simultaneous lowpass/bandpass/highpass outlets, a step up
 * from the cheap one-poles: 12 dB/oct, real resonance, three taps from one state update.
 *
 * - Topology: Andrew Simper's zero-delay-feedback (trapezoidal) SVF, not the naive Chamberlin
 *   form, whose tuning drifts above ~fs/6. `g = tan(pi*fc/fs)` puts the resonant peak exactly on
 *   target up to Nyquist, and the filter is stable for any `g, k >= 0`.
 * - Tracked `g` is exact: `svf_tan`, a Pade approximant range-reduced to [0, pi/4] (above it,
 *   `tan(x) = 1/tan(pi/2 - x)`), within 2.4e-7 of `tan` over every note (0.0003 ct). It replaced
 *   libm's `tanf` (2026-09-30, user's call), whose range reduction linked ~3.2 KB -- over half a
 *   minilogue xd modulation effect's 6 KB. Free-running `CUTOFF` uses the cheap cube warp
 *   (`g = t^3*8`).
 * - `RESONANCE` maps to `k = 2*(1-t)^3`, reaching exactly 0 at 100: a lossless resonator that
 *   rings forever once excited but never starts from silence. Self-starting oscillation would
 *   need `k < 0` with a clip in the loop -- not asked for.
 * - `pitch`/`COARSE`/`FINE`/`TRACK` work exactly as on `logue/filter/comb`.
 */
const SVF_CUTOFF_G_MAX = 8.0

const SVF_STEP_HELPER: HelperBlock = {
  key: 'svf_step',
  code: `  // Andrew Simper's zero-delay-feedback (trapezoidal-integrated) state-variable filter --
  // see logue/filter/svf's own doc comment for the derivation/why. *s1/*s2 are the filter's own
  // per-sample integrator state (NOT literally "the bandpass/lowpass value", a real ZDF
  // implementation detail -- see the referenced paper), each fed back doubled ("2.f*v-...") by
  // design, the standard trick that makes this form delay-free without an iterative solve.
  static void svf_step(float *s1, float *s2, float in, float g, float k,
    float *outLp, float *outBp, float *outHp)
  {
    float a1 = 1.f / (1.f + g * (g + k));
    float a2 = g * a1;
    float a3 = g * a2;
    float v3 = in - *s2;
    float v1 = a1 * (*s1) + a2 * v3;
    float v2 = *s2 + a2 * (*s1) + a3 * v3;
    *s1 = 2.f * v1 - *s1;
    *s2 = 2.f * v2 - *s2;
    *outLp = v2;
    *outBp = v1;
    *outHp = in - k * v1 - v2;
  }
`
}

const SVF_K_FROM_PERCENT_HELPER: HelperBlock = {
  key: 'svf_k_from_percent',
  code: `  static float svf_k_from_percent(float percent)
  {
    float t = percent * 0.01f;
    if (t < 0.f) t = 0.f; else if (t > 1.f) t = 1.f;
    float u = 1.f - t;
    return u * u * u * 2.f;
  }
`
}

const SVF_TAN_HELPER: HelperBlock = {
  key: 'svf_tan',
  code: `  // tan(x) for x in [0, pi/2): Pade [5/4] on [0, pi/4], and 1/tan(pi/2 - x) above, so the
  // argument never nears the pole. The tracked note is clipped below Nyquist, so pi/2 - x stays
  // over 0.02. A leaf inline, libm-free (tanf's own range reduction is ~3.2 KB of code).
  static inline __attribute__((always_inline)) float svf_tan(float x)
  {
    const bool high = x > 0.78539816f;
    const float y = high ? 1.57079633f - x : x;
    const float y2 = y * y;
    const float t = y * (945.f - 105.f * y2 + y2 * y2) / (945.f - 420.f * y2 + 15.f * y2 * y2);
    return high ? 1.f / t : t;
  }
`
}

const SVF_G_FREE_HELPER: HelperBlock = {
  key: 'svf_g_free',
  code: `  // Cheap, non-Hz-accurate coefficient warp for the manual/free-running CUTOFF path -- see
  // logue/filter/svf's own doc comment for why this stays libm-free while TRACK mode doesn't.
  static float svf_g_free(float cutoff01)
  {
    float t = cutoff01;
    if (t < 0.f) t = 0.f; else if (t > 1.f) t = 1.f;
    return t * t * t * ${SVF_CUTOFF_G_MAX.toFixed(1)}f;
  }
`
}

const SVF_RESONANCE_INLET_DEPTH = 50

function svfKExpr(suffix: string, inlets: Record<string, string | undefined>): string {
  const percent =
    inlets.resonance !== undefined
      ? additiveInletExpr('resonancePercent', suffix, inlets.resonance, SVF_RESONANCE_INLET_DEPTH)
      : `resonancePercent_${suffix}`
  return `svf_k_from_percent(${percent})`
}

/**
 * A wired `cutoff` adds to CUTOFF at depth 100 (the whole range), like `lowpass-cheap`'s, rather
 * than `resonance`'s +-50: one LFO should be able to sweep the filter from closed to open.
 */
function svfGExpr(suffix: string, inlets: Record<string, string | undefined>): string {
  const cutoff01 =
    inlets.cutoff !== undefined
      ? `clampf(cutoff_${suffix} + (${inlets.cutoff}), 0.f, 1.f)`
      : `cutoff_${suffix}`
  const w0 = transposedW0Expr(suffix, inlets)
  return `(track_${suffix} >= ${TRACK_ON_RAW_THRESHOLD}.f ? svf_tan(3.14159265f * (${w0})) : svf_g_free(${cutoff01}))`
}

/** `svf_tan` of the tracked note (or the free cutoff's warp) and `k`, once per block while unwired. */
function svfBlockValues(
  suffix: string,
  inlets: Record<string, string | undefined>
): Record<'g' | 'k', BlockValue> {
  return {
    g: blockValue('blkSvfG', suffix, svfGExpr(suffix, inlets), [
      inlets.cutoff,
      inlets.pitch,
      inlets.harmonic
    ]),
    k: blockValue('blkSvfK', suffix, svfKExpr(suffix, inlets), [inlets.resonance])
  }
}

export const svfFilterPrimitive: LoguePrimitive = {
  id: 'logue/filter/svf',
  outletPolarity: 'inherit',
  // svfS1_ + svfS2_ + cutoff_ + resonancePercent_ + coarse_ + fine_ + track_, 7 floats
  stateBytesPerInstance: 28,
  description:
    'A resonant 2-pole state-variable filter with simultaneous lowpass, bandpass and highpass outputs, and optional pitch-tracked resonance.',
  inlets: [
    { name: 'in', role: 'audio' },
    { name: 'cutoff', trackGate: PITCH_TRACKED_GATE, role: 'control' },
    { name: 'resonance', role: 'control' },
    { name: 'pitch', trackGate: NEEDS_TRACK_GATE, role: 'control' }
  ],
  outlets: [{ name: 'lp' }, { name: 'bp' }, { name: 'hp' }],
  memberDecls: (suffix) =>
    `  float svfS1_${suffix};\n  float svfS2_${suffix};\n  float cutoff_${suffix};\n  float resonancePercent_${suffix};\n  float coarse_${suffix};\n  float fine_${suffix};\n  float track_${suffix};\n`,
  initStatement: (suffix) => `    svfS1_${suffix} = 0.f;\n    svfS2_${suffix} = 0.f;\n`,
  renderExpr: () => {
    throw new Error(
      'logue/filter/svf is multi-outlet -- use renderOutletStatements, not renderExpr'
    )
  },
  blockConstants: (suffix, inlets) => blockDecls(svfBlockValues(suffix, inlets)),
  renderOutletStatements: (suffix, inlets) => {
    const g = svfBlockValues(suffix, inlets).g.ref
    const k = svfBlockValues(suffix, inlets).k.ref
    const inExpr = inlets.in ?? '0.f'
    // `svf_step` always computes all three taps together (they share almost all of its
    // arithmetic -- see the primitive's own doc comment), but a real placed instance often only
    // wires one or two of them downstream. The unwired tap(s) would otherwise be a genuine
    // unused-local-variable compiler warning; `(void)`-casting every declared outlet
    // unconditionally (same idiom this file's generators already use for an unused function
    // parameter, e.g. `setParameter`'s own `(void)index;`) silences that without needing to know
    // at codegen time which outlets are actually wired -- harmless on a tap that IS used too,
    // since the cast doesn't consume/invalidate the variable for later real reads.
    return (
      `      float svfG_${suffix} = ${g};\n` +
      `      float svfK_${suffix} = ${k};\n` +
      `      float y_${suffix}_lp, y_${suffix}_bp, y_${suffix}_hp;\n` +
      `      svf_step(&svfS1_${suffix}, &svfS2_${suffix}, ${inExpr}, svfG_${suffix}, svfK_${suffix}, ` +
      `&y_${suffix}_lp, &y_${suffix}_bp, &y_${suffix}_hp);\n` +
      `      (void)y_${suffix}_lp; (void)y_${suffix}_bp; (void)y_${suffix}_hp;\n`
    )
  },
  advanceStatement: () => '',
  helpers: [
    SVF_STEP_HELPER,
    SVF_K_FROM_PERCENT_HELPER,
    SVF_TAN_HELPER,
    SVF_G_FREE_HELPER,
    CLAMPF_HELPER,
    NOTE_W0_HELPER
  ],
  params: [
    {
      name: 'CUTOFF',
      modulatedBy: { inlet: 'cutoff', shape: 'additive' },
      trackGate: PITCH_TRACKED_GATE,
      min: 0,
      max: 100,
      default: 100,
      setStatement: (suffix, valueExpr) => `cutoff_${suffix} = ${valueExpr} * 0.01f;`
    },
    {
      name: 'RESONANCE',
      modulatedBy: { inlet: 'resonance', shape: 'additive' },
      min: 0,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `resonancePercent_${suffix} = ${valueExpr};`
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
 * Three parallel resonant bandpasses on vowel formants (F1-F3), with `VOWEL` sweeping five
 * vowels, `CHARACTER` blending male -> female (50) -> child (100), `SHIFT` transposing all bands,
 * and `RESONANCE` setting their width.
 *
 * - Data: Peterson & Barney (1952) averages for men, women and children (CHARACTER 0/50/100,
 *   interpolated in note space; the default 0 is the original male table, unchanged). Order is u->o->a->e->i, not alphabetical: F2 then
 *   rises almost monotonically, while alphabetical order doubles back (audible as a lurch).
 *   `VOWEL` 0-100 is four equal segments, interpolated linearly.
 * - Interpolation and `SHIFT` (+-24 st, like `COARSE`) happen in note space: frequencies are
 *   baked as note numbers at codegen time (`hzToNote`) and converted back through `note_w0`,
 *   so no pow/log runs on the device.
 * - `formant_g_from_note` uses a Taylor series for `tan` instead of `tanf`: under 0.01% error on
 *   the table, ~1.4% in the worst corner (`i` F3 at SHIFT +24).
 * - Each band is the ZDF SVF's bandpass tap only, returned as `k*v1` (unity peak gain), weighted
 *   1.0/0.5/0.28 and divided by their sum, so `RESONANCE` changes width, not loudness.
 * - `k` floors at 0.05 (unlike svf's 0): three summed marginally-stable resonators were never
 *   verified. `RESONANCE` defaults to 60 so a fresh instance sounds like a vowel, not an EQ.
 * - All three params are additive inlets (+-50, SHIFT +-24).
 *
 * Verified with a numeric re-implementation (peaks within ~1% at all five vowels, SHIFT exactly
 * scales them) and real builds on both platforms. On the xd the helpers must stay
 * `always_inline` with their own `formant_note_w0` -- see CLAUDE.md. Details: docs/HISTORY.md.
 */
// Peterson & Barney (1952) averages per voice, rows u o a e i (their /u/ /ɔ/ /ɑ/ /ɛ/ /i/). Male is
// the original table, so CHARACTER 0 sounds exactly as before it existed.
const FORMANT_VOWEL_NOTE_TABLES_HZ: [number, number, number][][] = [
  [
    [300, 870, 2240], // u
    [570, 840, 2410], // o
    [730, 1090, 2440], // a
    [530, 1840, 2480], // e
    [270, 2290, 3010] // i
  ],
  [
    [370, 950, 2670], // u
    [590, 920, 2710], // o
    [850, 1220, 2810], // a
    [610, 2330, 2990], // e
    [310, 2790, 3310] // i
  ],
  [
    [430, 1170, 3260], // u
    [680, 1060, 3180], // o
    [1030, 1370, 3170], // a
    [690, 2610, 3570], // e
    [370, 3200, 3730] // i
  ]
]

function hzToNote(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440)
}

const FORMANT_NOTE_TABLES: [number, number, number][][] = FORMANT_VOWEL_NOTE_TABLES_HZ.map((t) =>
  t.map(([f1, f2, f3]) => [hzToNote(f1), hzToNote(f2), hzToNote(f3)])
)

function formatFormantNoteRow(row: [number, number, number]): string {
  return `{ ${row.map((n) => n.toFixed(4) + 'f').join(', ')} }`
}

const FORMANT_VOWEL_INLET_DEPTH = 50
// Reuses COARSE_PARAM's own max rather than a separately-invented number, same rule
// PITCH_INLET_DEPTH already follows -- keeps this in sync with SHIFT's own range automatically
// if either is ever changed, rather than two numbers that happen to agree today.
const FORMANT_SHIFT_INLET_DEPTH = COARSE_PARAM.max
const FORMANT_RESONANCE_INLET_DEPTH = 50
const FORMANT_CHARACTER_INLET_DEPTH = 50
const FORMANT_K_MAX = 2.0
const FORMANT_K_MIN = 0.05
// F1/F2/F3 relative mix weights (loudest to quietest) -- see this primitive's own doc comment
// for why these are fixed per-formant-index rather than a real per-vowel amplitude table.
const FORMANT_BAND_WEIGHTS = [1.0, 0.5, 0.28] as const
const FORMANT_WEIGHT_SUM = FORMANT_BAND_WEIGHTS.reduce((a, b) => a + b, 0)

/**
 * `always_inline` here, on `formant_g_from_note` and on `FORMANT_NOTE_W0_HELPER` works around a
 * minilogue xd crash seen only at the SDK's default `-Os`. At `-O2` GCC inlines `process` ->
 * `formant_step` -> `formant_bp_step`/`formant_g_from_note` -> `note_w0` into one function and it
 * doesn't crash; at `-Os` they stay real `bl` calls. Inlining `formant_bp_step`/
 * `formant_g_from_note` alone fixed a single wired inlet but not a patch with `vowel`/`shift`/
 * `resonance` all wired (both checked on hardware), so `note_w0` (called 3x) is inlined too,
 * through a formant-only copy. The shared `note_w0` stays a real call, because every other
 * primitive is hardware-proven that way. The root cause was never found (the `-Os` disassembly
 * looked correct per AAPCS-VFP); this just gets as close to the known-safe fully inlined shape as
 * possible without touching shared helpers. See also `FORMANT_STEP_HELPER`. History:
 * docs/HISTORY.md.
 */
const FORMANT_BP_STEP_HELPER: HelperBlock = {
  key: 'formant_bp_step',
  code: `  // Cytomic ZDF SVF bandpass tap (see logue/filter/svf's own svf_step doc comment for the
  // full derivation), trimmed to the one tap a formant band needs, and normalized to unity peak
  // gain at resonance by the *k -- v1's own raw peak gain is 1/k, so this cancels it, keeping
  // RESONANCE from also sweeping loudness. See logue/filter/formant's own doc comment (both for
  // the DSP itself and for why this is force-inlined -- a real, hardware-confirmed fix).
  static inline __attribute__((always_inline)) float formant_bp_step(float *s1, float *s2, float in, float g, float k)
  {
    float a1 = 1.f / (1.f + g * (g + k));
    float a2 = g * a1;
    float a3 = g * a2;
    float v3 = in - *s2;
    float v1 = a1 * (*s1) + a2 * v3;
    float v2 = *s2 + a2 * (*s1) + a3 * v3;
    *s1 = 2.f * v1 - *s1;
    *s2 = 2.f * v2 - *s2;
    return k * v1;
  }
`
}

/** A force-inlined DUPLICATE of the shared `NOTE_W0_HELPER`'s exact body -- see
 * `FORMANT_BP_STEP_HELPER`'s own doc comment for why this exists as its own copy rather than
 * force-inlining the shared `note_w0` everything else in the registry already calls as a real,
 * proven-safe function. */
const FORMANT_NOTE_W0_HELPER: HelperBlock = {
  key: 'formant_note_w0',
  code: `  static inline __attribute__((always_inline)) float formant_note_w0(float note)
  {
    int whole = (int)note;
    float frac = note - (float)whole;
    if (frac < 0.f) { whole -= 1; frac += 1.f; }
    if (whole < 0) whole = 0;
    if (whole > 150) whole = 150;
    return osc_w0f_for_note((uint8_t)whole, (uint8_t)(frac * 255.f));
  }
`
}

const FORMANT_G_FROM_NOTE_HELPER: HelperBlock = {
  key: 'formant_g_from_note',
  code: `  // ZDF SVF's own g = tan(pi*fc/fs) coefficient, approximated by tan's own Taylor series
  // (x + x^3/3 + 2x^5/15) instead of calling real tanf -- see logue/filter/formant's own doc
  // comment for the measured accuracy across the whole formant/SHIFT range AND for why this is
  // force-inlined. Keeps this primitive libm-free (svf has its own, full-range svf_tan).
  static inline __attribute__((always_inline)) float formant_g_from_note(float note)
  {
    float w0 = formant_note_w0(note);
    float x = 3.14159265f * w0;
    return x + x * x * x * (1.f / 3.f) + x * x * x * x * x * (2.f / 15.f);
  }
`
}

const FORMANT_K_FROM_PERCENT_HELPER: HelperBlock = {
  key: 'formant_k_from_percent',
  code: `  // Same cube taper as svf_k_from_percent, but floored above zero -- see
  // logue/filter/formant's own doc comment for why 3 simultaneous marginally-stable resonators
  // are a real, disclosed reason to diverge from SVF's own k=0-at-RESONANCE=100 mapping.
  static float formant_k_from_percent(float percent)
  {
    float t = percent * 0.01f;
    if (t < 0.f) t = 0.f; else if (t > 1.f) t = 1.f;
    float u = 1.f - t;
    return u * u * u * ${(FORMANT_K_MAX - FORMANT_K_MIN).toFixed(2)}f + ${FORMANT_K_MIN.toFixed(2)}f;
  }
`
}

/**
 * One formant's centre as a note number: linear in note space across the vowel, then across the
 * two neighbouring voices (male/female, female/child). A leaf, `always_inline` like the other
 * formant helpers so `formant_step` keeps its no-real-call shape on the xd.
 */
const FORMANT_NOTE_HELPER: HelperBlock = {
  key: 'formant_note',
  code: `  static inline __attribute__((always_inline)) float formant_note(const float (*t)[5][3], int voice, int seg, float frac, float vfrac, int f)
  {
    float a = t[voice][seg][f] + (t[voice][seg + 1][f] - t[voice][seg][f]) * frac;
    float b = t[voice + 1][seg][f] + (t[voice + 1][seg + 1][f] - t[voice + 1][seg][f]) * frac;
    return a + (b - a) * vfrac;
  }
`
}

/**
 * Takes the raw `resonancePercent` and converts it to `k` inside, and assigns every nested helper
 * result (`k`, `gA`/`gB`/`gC`) to a named local before passing it on (the `svfKExpr` convention).
 * The original shape nested those calls as arguments -- `formant_step(...,
 * formant_k_from_percent(clampf(...)), ...)` at the call site and `formant_bp_step(...,
 * formant_g_from_note(noteA), ...)` in here -- and crashed a real minilogue xd at `-Os` but not
 * at `-O2`. An 11-build hardware bisect ruled out the DSP and numerics (identical values, a
 * 10M-sample stability sweep, ELF/linker diffs). Keep both this shape and
 * `FORMANT_BP_STEP_HELPER`'s force-inlining; the records disagree on which one alone was enough.
 *
 * Row order: u, o, a, e, i (index 0..4); columns: F1, F2, F3 (index 0..2) -- see
 * logue/filter/formant's own doc comment for the Hz source table, the note-space conversion,
 * and why this sweep order (not alphabetical) was picked. History: docs/HISTORY.md.
 */
const FORMANT_STEP_HELPER: HelperBlock = {
  key: 'formant_step',
  // kFormantNote[voice][vowel][3] (F1/F2/F3), float -- derived from the same table
  // the embedded array is actually built from, same reasoning as ADDITIVE_STEP_HELPER's own.
  sharedBytes: FORMANT_NOTE_TABLES.length * FORMANT_NOTE_TABLES[0].length * 3 * 4,
  code: `  static float formant_step(float *s1a, float *s2a, float *s1b, float *s2b, float *s1c, float *s2c,
    float vowelPercent, float shiftSemis, float resonancePercent, float characterPercent, float x)
  {
    static const float kFormantNote[3][5][3] = {
      ${FORMANT_NOTE_TABLES.map(
        (t) => '{\n        ' + t.map(formatFormantNoteRow).join(',\n        ') + '\n      }'
      ).join(',\n      ')}
    };
    float k = formant_k_from_percent(resonancePercent);
    float pos = vowelPercent * 0.01f;
    if (pos < 0.f) pos = 0.f; else if (pos > 1.f) pos = 1.f;
    float segF = pos * 4.f;
    int seg = (int)segF;
    if (seg > 3) seg = 3;
    float frac = segF - (float)seg;
    float cpos = characterPercent * 0.02f;
    if (cpos < 0.f) cpos = 0.f; else if (cpos > 2.f) cpos = 2.f;
    int voice = (int)cpos;
    if (voice > 1) voice = 1;
    float vfrac = cpos - (float)voice;

    float noteA = formant_note(kFormantNote, voice, seg, frac, vfrac, 0) + shiftSemis;
    float noteB = formant_note(kFormantNote, voice, seg, frac, vfrac, 1) + shiftSemis;
    float noteC = formant_note(kFormantNote, voice, seg, frac, vfrac, 2) + shiftSemis;

    float gA = formant_g_from_note(noteA);
    float gB = formant_g_from_note(noteB);
    float gC = formant_g_from_note(noteC);

    float yA = formant_bp_step(s1a, s2a, x, gA, k);
    float yB = formant_bp_step(s1b, s2b, x, gB, k);
    float yC = formant_bp_step(s1c, s2c, x, gC, k);

    return (yA * ${FORMANT_BAND_WEIGHTS[0].toFixed(2)}f + yB * ${FORMANT_BAND_WEIGHTS[1].toFixed(2)}f + yC * ${FORMANT_BAND_WEIGHTS[2].toFixed(2)}f) * ${(1 / FORMANT_WEIGHT_SUM).toFixed(4)}f;
  }
`
}

function formantVowelExpr(suffix: string, inlets: Record<string, string | undefined>): string {
  return inlets.vowel !== undefined
    ? additiveInletExpr('vowelPercent', suffix, inlets.vowel, FORMANT_VOWEL_INLET_DEPTH)
    : `vowelPercent_${suffix}`
}

function formantCharacterExpr(suffix: string, inlets: Record<string, string | undefined>): string {
  return inlets.character !== undefined
    ? additiveInletExpr('characterPercent', suffix, inlets.character, FORMANT_CHARACTER_INLET_DEPTH)
    : `characterPercent_${suffix}`
}

function formantShiftExpr(suffix: string, inlets: Record<string, string | undefined>): string {
  return inlets.shift !== undefined
    ? additiveInletExpr('shiftSemis', suffix, inlets.shift, FORMANT_SHIFT_INLET_DEPTH, -24, 24)
    : `shiftSemis_${suffix}`
}

/** Returns the raw, un-converted resonance PERCENT (symmetric with vowel/shift's own shape) --
 * see `formant_step`'s own doc comment for why the `formant_k_from_percent` conversion moved
 * inside that function rather than nesting here at the call site. */
function formantResonancePercentExpr(
  suffix: string,
  inlets: Record<string, string | undefined>
): string {
  return inlets.resonance !== undefined
    ? additiveInletExpr('resonancePercent', suffix, inlets.resonance, FORMANT_RESONANCE_INLET_DEPTH)
    : `resonancePercent_${suffix}`
}

export const formantFilterPrimitive: LoguePrimitive = {
  id: 'logue/filter/formant',
  outletPolarity: 'inherit',
  // vowelPercent_ + shiftSemis_ + resonancePercent_ + characterPercent_ + fS1a_/fS2a_/fS1b_/fS2b_/fS1c_/fS2c_,
  // 10 floats
  stateBytesPerInstance: 40,
  description:
    'A 3-band resonant filter bank sweeping through human vowel formants, with formant frequency shift (moves the formants, not the pitch of the input), a male-to-female-to-child voice blend and resonance control.',
  inlets: [
    { name: 'in', role: 'audio' },
    { name: 'vowel', role: 'control' },
    { name: 'shift', role: 'control' },
    { name: 'resonance', role: 'control' },
    { name: 'character', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  float vowelPercent_${suffix};\n  float shiftSemis_${suffix};\n  float resonancePercent_${suffix};\n  float characterPercent_${suffix};\n  float fS1a_${suffix};\n  float fS2a_${suffix};\n  float fS1b_${suffix};\n  float fS2b_${suffix};\n  float fS1c_${suffix};\n  float fS2c_${suffix};\n`,
  initStatement: (suffix) =>
    `    fS1a_${suffix} = 0.f;\n    fS2a_${suffix} = 0.f;\n    fS1b_${suffix} = 0.f;\n    fS2b_${suffix} = 0.f;\n    fS1c_${suffix} = 0.f;\n    fS2c_${suffix} = 0.f;\n`,
  renderExpr: (suffix, inlets) =>
    `formant_step(&fS1a_${suffix}, &fS2a_${suffix}, &fS1b_${suffix}, &fS2b_${suffix}, &fS1c_${suffix}, &fS2c_${suffix}, ${formantVowelExpr(suffix, inlets)}, ${formantShiftExpr(suffix, inlets)}, ${formantResonancePercentExpr(suffix, inlets)}, ${formantCharacterExpr(suffix, inlets)}, ${inlets.in ?? '0.f'})`,
  advanceStatement: () => '',
  // Every one of these must be listed directly (not via `dependsOn`, which only resolves against
  // `HELPER_REGISTRY` -- `polyblep`/`polyblep_saw`/`polyblep_square` only) -- same reasoning
  // `ENV_RATE_HELPER`'s own doc comment already gives for `logue/env/ad`'s helpers.
  helpers: [
    FORMANT_STEP_HELPER,
    FORMANT_NOTE_HELPER,
    FORMANT_BP_STEP_HELPER,
    FORMANT_G_FROM_NOTE_HELPER,
    FORMANT_NOTE_W0_HELPER,
    FORMANT_K_FROM_PERCENT_HELPER,
    CLAMPF_HELPER
  ],
  params: [
    {
      name: 'VOWEL',
      unit: PERCENT,
      modulatedBy: { inlet: 'vowel', shape: 'additive' },
      nts1mkiiType: 'percent',
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `vowelPercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'SHIFT',
      unit: SEMITONES,
      modulatedBy: { inlet: 'shift', shape: 'additive' },
      nts1mkiiType: 'semi',
      min: -24,
      max: 24,
      default: 0,
      setStatement: (suffix, valueExpr) => `shiftSemis_${suffix} = ${valueExpr};`
    },
    {
      name: 'RESONANCE',
      unit: PERCENT,
      modulatedBy: { inlet: 'resonance', shape: 'additive' },
      nts1mkiiType: 'percent',
      min: 0,
      max: 100,
      default: 60,
      setStatement: (suffix, valueExpr) => `resonancePercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'CHARACTER',
      unit: PERCENT,
      modulatedBy: { inlet: 'character', shape: 'additive' },
      nts1mkiiType: 'percent',
      min: 0,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `characterPercent_${suffix} = ${valueExpr};`
    }
  ]
}

/** The allpass line in SDRAM: 8192 floats (32 KB), room for its 100 ms maximum (4800 samples). */
const ALLPASS_LINE = 8192
const ALLPASS_TIME_INLET_DEPTH = 50

const ALLPASS_STEP_HELPER: HelperBlock = {
  key: 'allpass_step',
  code: `  // Schroeder allpass: w[n] = x + g*w[n-D], y = w[n-D] - g*w[n] -- a flat magnitude response
  // that smears an impulse into a decaying train (a reverb's diffusion). D is read with linear
  // interpolation, so a modulated time glides. What's stored is bounded (+-4) so a runaway input
  // can't grow without end. A leaf.
  static float allpass_step(float *buf, uint32_t *w, float delay, float x, float g)
  {
    const uint32_t di = (uint32_t)delay;
    const float frac = delay - (float)di;
    const float a = buf[(*w - di) & ${ALLPASS_LINE - 1}u];
    const float b = buf[(*w - di - 1u) & ${ALLPASS_LINE - 1}u];
    const float d = a + (b - a) * frac;
    float v = x + g * d;
    v = v > 4.f ? 4.f : (v < -4.f ? -4.f : v);
    buf[*w & ${ALLPASS_LINE - 1}u] = v;
    *w = *w + 1u;
    return d - g * v;
  }
`
}

// allpass_step for a whole-sample delay (a static TIME): one SDRAM read instead of two and no
// interpolation, the same output (frac was exactly 0), and inlined -- with the call, four
// diffusers were a third of reverse-wash's xd cycles (2026-10-01).
const ALLPASS_STEP_INT_HELPER: HelperBlock = {
  key: 'allpass_step_int',
  code: `  static inline __attribute__((always_inline)) float allpass_step_int(float *buf, uint32_t *w, uint32_t di, float x, float g)
  {
    const float d = buf[(*w - di) & ${ALLPASS_LINE - 1}u];
    float v = x + g * d;
    v = v > 4.f ? 4.f : (v < -4.f ? -4.f : v);
    buf[*w & ${ALLPASS_LINE - 1}u] = v;
    *w = *w + 1u;
    return d - g * v;
  }
`
}

/** The allpass delay in samples: a block constant while `time` is unwired (2026-10-01). */
function allpassDelay(suffix: string, inlets: Record<string, string | undefined>): BlockValue {
  const time =
    inlets.time !== undefined
      ? additiveInletExpr('timePercent', suffix, inlets.time, ALLPASS_TIME_INLET_DEPTH)
      : `timePercent_${suffix}`
  const samples = `clampf((0.5f + 99.5f * (${time}) * (${time}) * 0.0001f) * 48.f, 1.f, ${ALLPASS_LINE - 2}.f)`
  // Linear interpolation inside the loop is a gentle lowpass (a 788.2-sample delay kept 76% of
  // an impulse's energy), so a static time is a whole number of samples: exactly allpass. A
  // wired time stays fractional, so a sweep glides.
  return blockValue(
    'blkAllpassDelay',
    suffix,
    inlets.time !== undefined ? samples : `(uint32_t)(${samples} + 0.5f)`,
    [inlets.time]
  )
}

/**
 * `logue/filter/allpass`: a Schroeder allpass on a delay line in the effect's SDRAM (effects
 * only), the diffuser of a classic reverb: in series after a bank of combs (`util/long-delay`
 * with RANGE 0.34 s and MIX 100 is a damped feedback comb) it thickens their echoes into a wash.
 * TIME is 0.5-100 ms (squared, fine at the short end) with an additive `time` inlet; GAIN
 * -100..100 is g = +-0.9 (50 = 0.45; Freeverb uses 0.5). The magnitude response is flat -- it
 * only disperses in time -- so it can't boost; its output is a mix of the delayed and the
 * direct signal, never dry-only. A static TIME is rounded to whole samples (exactly allpass); a
 * wired one is interpolated, so it glides.
 */
export const allpassPrimitive: LoguePrimitive = {
  id: 'logue/filter/allpass',
  modules: ['modfx', 'delfx', 'revfx'],
  outletPolarity: 'inherit',
  // w_, timePercent_, gain_ (3 x 4 B); the line is SDRAM.
  stateBytesPerInstance: 12,
  description:
    "A Schroeder allpass diffuser (0.5-100 ms) on a line in the effect's SDRAM: in series after combs, it smears echoes into a reverb wash. GAIN is the diffusion. Effects only.",
  inlets: [
    { name: 'in', role: 'audio' },
    { name: 'time', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  uint32_t w_${suffix};\n  float timePercent_${suffix};\n  float gain_${suffix};\n`,
  initStatement: (suffix) => `    w_${suffix} = 0u;\n`,
  sdramFloats: () => ALLPASS_LINE,
  blockConstants: (suffix, inlets) => blockDecls({ delay: allpassDelay(suffix, inlets) }),
  renderExpr: (suffix, inlets) =>
    `${inlets.time !== undefined ? 'allpass_step' : 'allpass_step_int'}(sdram_${suffix}, &w_${suffix}, ${allpassDelay(suffix, inlets).ref}, ${inlets.in ?? '0.f'}, gain_${suffix} * 0.009f)`,
  advanceStatement: () => '',
  helpers: [CLAMPF_HELPER, ALLPASS_STEP_HELPER, ALLPASS_STEP_INT_HELPER],
  params: [
    {
      name: 'TIME',
      unit: ALLPASS_MS,
      modulatedBy: { inlet: 'time', shape: 'additive' },
      min: 0,
      max: 100,
      default: 40,
      setStatement: (suffix, valueExpr) => `timePercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'GAIN',
      unit: PERCENT,
      min: -100,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `gain_${suffix} = ${valueExpr};`
    }
  ]
}

/**
 * `logue/filter/hilbert`: the input as two allpass-filtered copies 90 degrees apart (`i`, `q`),
 * the building block of single-sideband tricks -- a frequency shifter (`logue/util/freq-shift`
 * has one built in), single-sideband ring modulation, a smooth envelope from `sqrt(i^2 + q^2)`. Both
 * outlets keep the input's level; neither is the dry input (both are phase-shifted). The 90
 * degrees hold from ~25 Hz up (`HILBERT_STEP_HELPER`), so content below ~20 Hz isn't split.
 * No params: the pair is fixed.
 */
export const hilbertPrimitive: LoguePrimitive = {
  id: 'logue/filter/hilbert',
  outletPolarity: 'inherit',
  // hb_[21] + hbParity_
  stateBytesPerInstance: HILBERT_STATE_FLOATS * 4 + 4,
  description:
    'Splits a signal into two copies 90 degrees apart (i and q), equally loud: the core of a frequency shifter or other single-sideband effects. Works from about 25 Hz up.',
  inlets: [{ name: 'in', role: 'audio' }],
  outlets: [{ name: 'i' }, { name: 'q' }],
  memberDecls: (suffix) =>
    `  float hb_${suffix}[${HILBERT_STATE_FLOATS}];\n  int hbParity_${suffix};\n`,
  initStatement: (suffix) =>
    `    for (int i = 0; i < ${HILBERT_STATE_FLOATS}; i++) hb_${suffix}[i] = 0.f;\n    hbParity_${suffix} = 0;\n`,
  renderExpr: () => {
    throw new Error('logue/filter/hilbert is multi-outlet -- use renderOutletStatements')
  },
  renderOutletStatements: (suffix, inlets) =>
    `      float y_${suffix}_i;\n` +
    `      float y_${suffix}_q;\n` +
    `      hilbert_step(hb_${suffix}, &hbParity_${suffix}, ${inlets.in ?? '0.f'}, &y_${suffix}_i, &y_${suffix}_q);\n` +
    `      (void)y_${suffix}_i; (void)y_${suffix}_q;\n`,
  advanceStatement: () => '',
  helpers: [HILBERT_STEP_HELPER]
}

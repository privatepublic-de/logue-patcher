import type { HelperBlock, LoguePrimitive } from './types'
import {
  BUFFER_LENGTH_NAME,
  GRAIN_MAXLEN_NAME,
  DELAY_MS,
  FREE_TIME_GATE,
  FREEZE_WIDGET,
  FREQ_SHIFT_HZ,
  LONG_DELAY_RANGE_NAME,
  NEEDS_TEMPO_SYNC_GATE,
  PERCENT,
  QUANTIZE_SCALE,
  ROOT_NOTE,
  TEMPO_DIVISION_NAME,
  TEMPO_SYNC_WIDGET
} from '../paramPresentation'
import {
  blockDecls,
  blockValue,
  type BlockValue,
  CLAMPF_HELPER,
  COARSE_PARAM,
  HILBERT_STATE_FLOATS,
  HILBERT_STEP_HELPER,
  TRACK_ON_RAW_THRESHOLD,
  additiveInletExpr,
  isBlockInvariant
} from './shared'

/**
 * A plain constant/DC source -- phase 19, requested for exactly the reason every other wireable
 * inlet in this registry needs one: every inlet only ever reads ANOTHER instance's own computed
 * value (`oscInstances.ts`'s `resolveAudioGraph`), never a raw literal -- there was previously no
 * way to feed a fixed, user-dialed offset into e.g. an oscillator's `pitch`/`fm` inlet (a static
 * detune for a ring-mod/FM operator) without wiring in something that ALSO does unwanted work of
 * its own (an LFO parked at one point in its cycle, a sense primitive with no natural fit on
 * NTS-1 mkII). New `util` category, not `sense` -- `logue/sense/param` LOOKS similar (a single
 * user-dialed `VALUE`) but is fundamentally a hardware-param-slot mechanism, minilogue-xd-only,
 * unipolar `0..1`; this is deliberately platform-agnostic and bipolar, a closer cousin to "an LFO
 * that never moves" than to a sensed hardware value -- lumping it into `sense` would misrepresent
 * what it actually is.
 *
 * `VALUE` is `-100..100` percent, mapped LINEARLY to `-1.0..1.0` -- the SAME bipolar domain every
 * other audio-rate/modulation signal in this registry already uses (oscillators, `mix2`,
 * `sine-lfo`, etc.), so a constant wired into `pitch`/`fm`/`width`/`rate`/`fmDepth`/`drive`/
 * `delay`/`feedback` combines with THAT inlet's own already-existing depth scaling automatically
 * -- no special-casing needed anywhere else in the codebase. Wiring a constant at `+50%` (`0.5`)
 * into an oscillator's `pitch` inlet, for example, adds a fixed `0.5 * 24 = 12` semitones (see
 * `PITCH_INLET_DEPTH`), exactly as if an LFO were frozen at its own `+0.5` point -- a real,
 * predictable, already-documented number, not a new unit to learn. Default `0` (silence/no
 * offset) -- the safe, unsurprising choice, same reasoning as every other `0`-default control in
 * this registry. No inlets: a constant that could itself be modulated wouldn't be a constant.
 */
export const constantPrimitive: LoguePrimitive = {
  id: 'logue/util/constant',
  pure: true,
  outletPolarity: 'bipolar',
  stateBytesPerInstance: 4, // value_, 1 float
  description: 'A fixed constant value, for feeding a steady offset into another control input.',
  memberDecls: (suffix) => `  float value_${suffix};\n`,
  renderExpr: (suffix) => `value_${suffix}`,
  advanceStatement: () => '',
  params: [
    {
      name: 'VALUE',
      min: -100,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `value_${suffix} = ${valueExpr} * 0.01f;`
    }
  ]
}

/**
 * Two range converters, stateless and platform-agnostic like `constantPrimitive` above --
 * requested because this registry's two signal domains (unipolar `0..1`, used by
 * `logue/sense/*`/`logue/sense/param`'s own `VALUE`, and bipolar `-1..1`, used by every
 * oscillator/LFO/`constant`) never had a bridge: wiring a `sense/*` reading into an oscillator's
 * `pitch`/`fm` inlet, or a bipolar LFO into `sense/param`-shaped control math, previously meant
 * either accepting the wrong scale/offset or not being expressible at all. The `sense/*`-into-
 * bipolar-inlet case specifically no longer needs this node at all -- every `logue/sense/*`
 * primitive except `gate` now exposes its own `bipolar` outlet directly (see
 * `sensePitchPrimitive`'s own doc comment) -- but this pair still bridges every OTHER
 * unipolar/bipolar mismatch (a `logue/sense/param`-shaped `VALUE` constant, a bipolar LFO fed
 * into unipolar-expecting control math, any other arbitrary wired signal).
 *
 * Both clamp their input to the domain they're converting FROM before rescaling -- an
 * out-of-range input (a mis-wired signal, or one of this registry's own bipolar sources fed
 * into `unipolarToBipolar` by mistake) still produces an in-range output rather than silently
 * exceeding `+-1`/`0..1` downstream. Reuses the existing shared `CLAMPF_HELPER` rather than a
 * new one-off clamp.
 */
export const unipolarToBipolarPrimitive: LoguePrimitive = {
  id: 'logue/util/unipolar-to-bipolar',
  pure: true,
  outletPolarity: 'bipolar',
  stateBytesPerInstance: 0, // stateless, memberDecls is empty
  description: 'Converts a 0..1 signal (e.g. a sense reading) to a -1..1 signal.',
  inlets: [{ name: 'in', role: 'audio' }],
  memberDecls: () => '',
  renderExpr: (_suffix, inlets) => `(clampf(${inlets.in ?? '0.f'}, 0.f, 1.f) * 2.f - 1.f)`,
  advanceStatement: () => '',
  helpers: [CLAMPF_HELPER]
}

export const bipolarToUnipolarPrimitive: LoguePrimitive = {
  id: 'logue/util/bipolar-to-unipolar',
  pure: true,
  outletPolarity: 'unipolar',
  stateBytesPerInstance: 0, // stateless, memberDecls is empty
  description: 'Converts a -1..1 signal to a 0..1 signal.',
  inlets: [{ name: 'in', role: 'audio' }],
  memberDecls: () => '',
  renderExpr: (_suffix, inlets) => `((clampf(${inlets.in ?? '0.f'}, -1.f, 1.f) + 1.f) * 0.5f)`,
  advanceStatement: () => '',
  helpers: [CLAMPF_HELPER]
}

/**
 * Called from `renderExpr` so the value is latched on the SAME sample as the edge (same reasoning
 * as `sample_hold_step`). A leaf on purpose -- no calls out, see CLAUDE.md's always-inline rule.
 * Like `edge_step`, a `trig` already high on the very first sample counts as a rising edge.
 */
const TRIG_HOLD_STEP_HELPER: HelperBlock = {
  key: 'trig_hold_step',
  code: `  static float trig_hold_step(float *held, float *prevTrig, float value, float trig)
  {
    float isOpen = (trig >= 0.5f) ? 1.f : 0.f;
    if (isOpen > *prevTrig) *held = value;
    *prevTrig = isOpen;
    return *held;
  }
`
}

/**
 * Sample-and-hold on a wired trigger rather than `logue/lfo/random-steps`'s own internal clock:
 * latches `in` on each rising edge of `trig` (the usual `>=0.5f` gate read, so a bipolar square
 * works directly). Works on audio or control signals alike -- nothing here is rate-specific.
 *
 * Unwired `trig` passes `in` straight through (a freshly placed node shouldn't sit at 0 looking
 * broken); unwired `in` reads as `0.f` like `mix2`'s inlets -- the noise fallback is what
 * `logue/lfo/random-steps` is for. `held_`/`prevTrig_` are declared even when unused (the usual
 * "memberDecls can't see wiring" tradeoff).
 */
// Named `logue/util/trig-hold` until 2026-09-28 (see `randomStepsPrimitive`).
export const sampleHoldPrimitive: LoguePrimitive = {
  id: 'logue/util/sample-hold',
  outletPolarity: 'inherit',
  stateBytesPerInstance: 8, // held_ + prevTrig_, 2 floats
  description:
    'Sample and hold: latches whatever is wired into `in` on each rising edge of `trig`. With `trig` unwired, `in` passes straight through.',
  inlets: [
    { name: 'in', role: 'audio' },
    { name: 'trig', role: 'control' }
  ],
  memberDecls: (suffix) => `  float held_${suffix};\n  float prevTrig_${suffix};\n`,
  initStatement: (suffix) => `    held_${suffix} = 0.f;\n    prevTrig_${suffix} = 0.f;\n`,
  renderExpr: (suffix, inlets) => {
    const value = inlets.in !== undefined ? `(${inlets.in})` : '0.f'
    if (inlets.trig === undefined) return value
    return `trig_hold_step(&held_${suffix}, &prevTrig_${suffix}, ${value}, ${inlets.trig})`
  },
  advanceStatement: () => '',
  helpers: [TRIG_HOLD_STEP_HELPER]
}

/**
 * Maps `GLIDE`'s own raw 0-100 percent to a real, made-up-but-reasonable 1ms-2000ms full-scale
 * (this registry's own `2.0`-wide `-1..1` span) transition time at the platform's fixed 48kHz
 * rate -- the SAME shape (and same "no libm" reasoning: no `expf`/`logf`, just a plain
 * percent->ms->samples chain) `ENV_RATE_HELPER` already established for `logue/env/ad`'s own
 * ATTACK/DECAY, not a coincidence -- both are "how long should a transition take" controls.
 * Returns a max PER-SAMPLE delta (not a duration) since that's what `slew_step` actually needs.
 */
const SLEW_MAX_DELTA_HELPER: HelperBlock = {
  key: 'slew_max_delta_from_percent',
  code: `  static float slew_max_delta_from_percent(float percent)
  {
    float t = percent * 0.01f;
    float ms = 1.f + t * 1999.f;
    float samples = ms * 0.001f * 48000.f;
    if (samples < 1.f) samples = 1.f;
    return 2.f / samples;
  }
`
}

/**
 * Called from `renderExpr`, same "mutation in a static helper" shape as `schmitt_step`/
 * `edge_step` above -- moves `*current` toward `target` by at most `maxDelta` per sample (a
 * genuine LINEAR ramp, constant slope, not an exponential approach).
 */
const SLEW_STEP_HELPER: HelperBlock = {
  key: 'slew_step',
  code: `  static float slew_step(float *current, float target, float maxDelta)
  {
    float delta = target - *current;
    if (delta > maxDelta) delta = maxDelta;
    else if (delta < -maxDelta) delta = -maxDelta;
    *current += delta;
    return *current;
  }
`
}

/**
 * A true LINEAR slew-rate limiter (glide/portamento) -- checked against what already exists
 * first: `logue/filter/lowpass-cheap` fed a low `CUTOFF` already smooths/lags any signal
 * EXPONENTIALLY (`onepole_step`), so a second one-pole-based "glide" primitive would just be
 * `lowpass-cheap` under another name. This is genuinely different: a constant maximum rate of
 * change per sample (a straight ramp toward the target) rather than a decaying-approach curve --
 * the real distinguishing character of a hardware slew limiter/analog portamento circuit,
 * not achievable by re-tuning the existing one-pole filter.
 *
 * `GLIDE` (0-100, default `0` -- instant, a transparent pass-through) is deliberately the
 * inverse framing of a "rate" control: `0` = no glide at all (the safe, unsurprising default, same
 * "don't silently alter a freshly placed node's behavior" reasoning `logue/math/scale`'s own
 * `FACTOR` default already uses), `100` = the slowest, most audible glide. No `noteOn` reset --
 * unlike an envelope, portamento's entire musical point is continuing smoothly from wherever the
 * output currently sits toward the new target, not snapping back at the start of every note.
 */
export const glidePrimitive: LoguePrimitive = {
  id: 'logue/util/glide',
  outletPolarity: 'inherit',
  stateBytesPerInstance: 8, // current_ + glidePercent_, 2 floats
  description:
    'Portamento/glide -- limits how fast a signal can change, smoothing sudden jumps into a ramp.',
  inlets: [{ name: 'in', role: 'audio' }],
  memberDecls: (suffix) => `  float current_${suffix};\n  float glidePercent_${suffix};\n`,
  initStatement: (suffix) => `    current_${suffix} = 0.f;\n`,
  renderExpr: (suffix, inlets) =>
    `slew_step(&current_${suffix}, ${inlets.in ?? '0.f'}, slew_max_delta_from_percent(glidePercent_${suffix}))`,
  advanceStatement: () => '',
  helpers: [SLEW_MAX_DELTA_HELPER, SLEW_STEP_HELPER],
  params: [
    {
      name: 'GLIDE',
      min: 0,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `glidePercent_${suffix} = ${valueExpr};`
    }
  ]
}

/**
 * Stores the value that will come out on the NEXT sample. A loop whose gain is above 1 (a VCA at
 * 4x in the loop) would otherwise run off to inf and then NaN, and a NaN in `z_` never leaves on
 * its own, so the stored value is clamped to +-4 and any inf/NaN is reset to 0. The exponent test
 * is on the bits, so it holds whatever float flags the compiler runs with.
 */
const SAMPLE_DELAY_STORE_HELPER: HelperBlock = {
  key: 'sample_delay_store',
  code: `  static inline __attribute__((always_inline)) float sample_delay_store(float x)
  {
    union { float f; uint32_t u; } bits = { x };
    if ((bits.u & 0x7f800000u) == 0x7f800000u) return 0.f;
    if (x > 4.f) return 4.f;
    if (x < -4.f) return -4.f;
    return x;
  }
`
}

/**
 * A one-sample delay (z^-1), and the only node a feedback loop may pass through: its `in` is
 * a `delayedInlets` entry, read in `advanceStatement` after the whole sample has been computed,
 * so the loop has a defined order. Feedback FM (an oscillator's output back into its own `fm`,
 * the DX7 operator-feedback idea without its two-sample averaging), cross-FM between two
 * oscillators, and feedback around a folder or filter all go through one of these. Unwired, it
 * outputs silence.
 */
export const sampleDelayPrimitive: LoguePrimitive = {
  id: 'logue/util/sample-delay',
  outletPolarity: 'inherit',
  stateBytesPerInstance: 4, // z_, 1 float
  description:
    'One-sample delay: outputs whatever came in one sample earlier. Feedback loops must pass through one -- e.g. an oscillator back into its own fm for feedback FM. The stored value is kept within +-4.',
  inlets: [{ name: 'in', role: 'audio' }],
  delayedInlets: ['in'],
  memberDecls: (suffix) => `  float z_${suffix};\n`,
  initStatement: (suffix) => `    z_${suffix} = 0.f;\n`,
  renderExpr: (suffix) => `z_${suffix}`,
  advanceStatement: (suffix, inlets) =>
    inlets.in === undefined ? '' : `      z_${suffix} = sample_delay_store(${inlets.in});\n`,
  helpers: SAMPLE_DELAY_STORE_HELPER
}

const DELAY_BUFFER_SAMPLES = 1024
// 20 ms at 48 kHz, inside the buffer with room for the Hermite read's two samples of lookahead.
const DELAY_MAX_SAMPLES = 960
// Stored as int16 over +-2, so feedback has 6 dB of headroom before the clamp.
const DELAY_STORE_SCALE = 16383

const DELAY_STEP_HELPER: HelperBlock = {
  key: 'delay_step',
  code: `  // A short modulatable delay: 16-bit ring buffer, 4-point Hermite read at a fractional delay
  // (so a swept time glides instead of zippering), feedback into the write, and a dry/wet mix.
  // What is written is clamped to +-2 before the int16 conversion, so any FEEDBACK setting stays
  // bounded. A leaf: no calls.
  static float delay_step(int16_t *buf, int *writeIdx, float in, float delaySamples, float feedback, float mix)
  {
    const int mask = ${DELAY_BUFFER_SAMPLES - 1};
    if (delaySamples < 2.f) delaySamples = 2.f;
    else if (delaySamples > ${DELAY_MAX_SAMPLES}.f) delaySamples = ${DELAY_MAX_SAMPLES}.f;
    float readPos = (float)(*writeIdx) - delaySamples;
    int idx = (int)readPos;
    float frac = readPos - (float)idx;
    if (frac < 0.f) { idx -= 1; frac += 1.f; }
    const float toFloat = 1.f / ${DELAY_STORE_SCALE}.f;
    float xm1 = buf[(idx - 1) & mask] * toFloat;
    float x0 = buf[idx & mask] * toFloat;
    float x1 = buf[(idx + 1) & mask] * toFloat;
    float x2 = buf[(idx + 2) & mask] * toFloat;
    float c = (x1 - xm1) * 0.5f;
    float v = x0 - x1;
    float w = c + v;
    float a = w + v + (x2 - x0) * 0.5f;
    float wet = (((a * frac) - (w + a)) * frac + c) * frac + x0;
    float store = in + feedback * wet;
    if (store > 2.f) store = 2.f; else if (store < -2.f) store = -2.f;
    buf[*writeIdx] = (int16_t)(store * ${DELAY_STORE_SCALE}.f);
    *writeIdx = (*writeIdx + 1) & mask;
    return in + mix * (wet - in);
  }
`
}

const DELAY_TIME_INLET_DEPTH = 50
const DELAY_FEEDBACK_INLET_DEPTH = 50

/** TIME percent to samples: 0.1 ms + 19.9 ms * t^2, fine resolution at flanger times. */
function delaySamplesExpr(percent: string): string {
  return `((0.1f + 19.9f * (${percent}) * (${percent}) * 0.0001f) * 48.f)`
}

/**
 * `logue/util/delay`: a short delay line (0.1-20 ms) for chorus, flanging, doubling and comb-like
 * colour. No built-in LFO on purpose: wire an LFO (or envelope) into `time` -- additive on the
 * TIME dial -- for the sweep, which also lets one LFO drive several delays. FEEDBACK -100..100
 * (coefficient up to 0.95; negative gives the hollow flanger colour), MIX dry to wet (50 = equal,
 * the classic chorus/flange). A time near the minimum with MIX 50 flanges against the dry signal
 * through zero. The buffer is 16-bit to halve the RAM (2 KB): ~96 dB of range, inaudible here.
 * Both synths also have their own mod effects after the oscillator; this one sits inside the
 * patch, per note.
 */
export const delayPrimitive: LoguePrimitive = {
  id: 'logue/util/delay',
  outletPolarity: 'inherit',
  // int16 buf_[1024] (2048 bytes) + writeIdx_ + timePercent_ + feedbackPercent_ + mixPercent_
  stateBytesPerInstance: DELAY_BUFFER_SAMPLES * 2 + 16,
  description:
    'A short delay (0.1-20 ms) for chorus and flanger: wire an LFO into time for the sweep. FEEDBACK (negative for a hollow flange) and MIX (dry to wet).',
  inlets: [
    { name: 'in', role: 'audio' },
    { name: 'time', role: 'control' },
    { name: 'feedback', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  int16_t buf_${suffix}[${DELAY_BUFFER_SAMPLES}];\n  int writeIdx_${suffix};\n  float timePercent_${suffix};\n  float feedbackPercent_${suffix};\n  float mixPercent_${suffix};\n`,
  initStatement: (suffix) =>
    `    writeIdx_${suffix} = 0;\n    for (int i = 0; i < ${DELAY_BUFFER_SAMPLES}; i++) buf_${suffix}[i] = 0;\n`,
  renderExpr: (suffix, inlets) => {
    const time =
      inlets.time !== undefined
        ? additiveInletExpr('timePercent', suffix, inlets.time, DELAY_TIME_INLET_DEPTH)
        : `timePercent_${suffix}`
    const feedback =
      inlets.feedback !== undefined
        ? additiveInletExpr(
            'feedbackPercent',
            suffix,
            inlets.feedback,
            DELAY_FEEDBACK_INLET_DEPTH,
            -100,
            100
          )
        : `feedbackPercent_${suffix}`
    return `delay_step(buf_${suffix}, &writeIdx_${suffix}, ${inlets.in ?? '0.f'}, ${delaySamplesExpr(time)}, (${feedback}) * 0.0095f, mixPercent_${suffix} * 0.01f)`
  },
  advanceStatement: () => '',
  helpers: [CLAMPF_HELPER, DELAY_STEP_HELPER],
  params: [
    {
      name: 'TIME',
      unit: DELAY_MS,
      modulatedBy: { inlet: 'time', shape: 'additive' },
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `timePercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'FEEDBACK',
      unit: PERCENT,
      modulatedBy: { inlet: 'feedback', shape: 'additive' },
      min: -100,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `feedbackPercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'MIX',
      unit: PERCENT,
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `mixPercent_${suffix} = ${valueExpr};`
    }
  ]
}

/** RANGE 0..3 -> the SDRAM line's length in floats (a power of two, so the ring index masks). */
const LONG_DELAY_LENGTHS = [16384, 65536, 131072, 262144]
const LONG_DELAY_DEFAULT_RANGE = 1

function longDelayLength(range: number): number {
  const i = Math.min(3, Math.max(0, Math.round(range)))
  return LONG_DELAY_LENGTHS[Number.isFinite(i) ? i : LONG_DELAY_DEFAULT_RANGE]
}

const LONG_DELAY_STEP_HELPER: HelperBlock = {
  key: 'long_delay_step',
  // long_delay_target's beats[10] table.
  sharedBytes: 40,
  code: `  // The delay in samples: TIME percent of the line, or a DIVISION of a beat at the device
  // tempo while synced -- clamped to what the line (length len) can hold.
  static inline __attribute__((always_inline)) float long_delay_target(float sync, float timePercent, int div, float bpm, uint32_t len)
  {
    static const float beats[10] = {0.25f, 1.f / 3.f, 0.5f, 0.75f, 2.f / 3.f, 1.f, 1.5f, 2.f, 3.f, 4.f};
    const float maxDelay = (float)(len - 2u);
    float d;
    if (sync >= 1.f)
    {
      const int i = div < 0 ? 0 : (div > 9 ? 9 : div);
      d = (2880000.f / (bpm < 20.f ? 20.f : bpm)) * beats[i];
    }
    else
    {
      d = 1.f + timePercent * 0.01f * (maxDelay - 1.f);
    }
    return d < 1.f ? 1.f : (d > maxDelay ? maxDelay : d);
  }

  // One echo on a line in SDRAM: reads at a smoothed delay (so a TIME change glides like tape),
  // then writes the input plus the damped feedback, softly limited like comb_step's (linear to
  // 0.6, ceiling 1.0) so FEEDBACK 100 can't run away. Returns dry-to-wet by mix. A leaf.
  static float long_delay_step(float *buf, uint32_t mask, uint32_t *w, float *delay, float target, float x, float fb, float dampA, float *dampZ, float mix)
  {
    if (*delay < 1.f) *delay = target;
    *delay += (target - *delay) * 0.0005f;
    const uint32_t di = (uint32_t)*delay;
    const float frac = *delay - (float)di;
    const float a = buf[(*w - di) & mask];
    const float b = buf[(*w - di - 1u) & mask];
    const float wet = a + (b - a) * frac;
    *dampZ += dampA * (wet - *dampZ);
    float stored = x + fb * *dampZ;
    float mag = stored < 0.f ? -stored : stored;
    if (mag > 0.6f)
    {
      float over = mag - 0.6f;
      if (over > 0.8f) over = 0.8f;
      mag = 0.6f + over - 0.625f * over * over;
      stored = stored < 0.f ? -mag : mag;
    }
    buf[*w & mask] = stored;
    *w = *w + 1u;
    return x + (wet - x) * mix;
  }
`
}

/**
 * `logue/util/long-delay`: an echo of up to 5.5 s on a line in the effect's SDRAM -- effects
 * only (an oscillator has no SDRAM). RANGE sizes the line when the unit is built (structural:
 * no device control may move it) -- 0.34 s / 1.4 s / 2.7 s / 5.5 s is 64 KB / 256 KB / 512 KB /
 * 1 MB, so a modfx (256 KB) takes the two short ones. TIME is linear over the RANGE; with SYNC
 * on, DIVISION of a beat at the device tempo (`unit_set_tempo`) replaces it. A TIME change
 * glides (tape-like pitch bend) rather than jumping. FEEDBACK up to 0.98 with a soft limit on
 * what recirculates, DAMPING a lowpass in the loop (darker repeats), MIX dry to wet built in
 * (user's call, 2026-09-30, over a wet-only node whose input could close loops). Stereo is two
 * instances. Mono float line: reads/writes in SDRAM are slow on the NTS-1 mkII (the spike's
 * two-line delay cost ~450 cycles/sample), so one read point.
 */
export const longDelayPrimitive: LoguePrimitive = {
  id: 'logue/util/long-delay',
  modules: ['modfx', 'delfx', 'revfx'],
  outletPolarity: 'inherit',
  // len_, w_, delay_, dampZ_, timePercent_, feedbackPercent_, dampingPercent_, mixPercent_,
  // sync_, div_ (10 x 4 B). The line is SDRAM; the generator's sdram_ pointer to it is counted
  // by the RAM estimate with the SDRAM.
  stateBytesPerInstance: 40,
  description:
    "An echo up to 5.5 s in the effect's SDRAM (RANGE sets its length when built). TIME, or a tempo DIVISION with SYNC; FEEDBACK, DAMPING (darker repeats), MIX dry to wet. Effects only.",
  inlets: [
    { name: 'in', role: 'audio' },
    { name: 'time', role: 'control', trackGate: FREE_TIME_GATE },
    { name: 'feedback', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  uint32_t len_${suffix};\n  uint32_t w_${suffix};\n  float delay_${suffix};\n  float dampZ_${suffix};\n  float timePercent_${suffix};\n  float feedbackPercent_${suffix};\n  float dampingPercent_${suffix};\n  float mixPercent_${suffix};\n  float sync_${suffix};\n  int div_${suffix};\n`,
  initStatement: (suffix) =>
    `    w_${suffix} = 0u;\n    delay_${suffix} = 0.f;\n    dampZ_${suffix} = 0.f;\n`,
  sdramFloats: (node) =>
    longDelayLength(
      Number(node.params?.find((p) => p.name === 'RANGE')?.value ?? LONG_DELAY_DEFAULT_RANGE)
    ),
  renderExpr: (suffix, inlets) => {
    const time =
      inlets.time !== undefined
        ? additiveInletExpr('timePercent', suffix, inlets.time, DELAY_TIME_INLET_DEPTH)
        : `timePercent_${suffix}`
    const feedback =
      inlets.feedback !== undefined
        ? additiveInletExpr('feedbackPercent', suffix, inlets.feedback, DELAY_FEEDBACK_INLET_DEPTH)
        : `feedbackPercent_${suffix}`
    const target = `long_delay_target(sync_${suffix}, ${time}, div_${suffix}, tempo_, len_${suffix})`
    return `long_delay_step(sdram_${suffix}, len_${suffix} - 1u, &w_${suffix}, &delay_${suffix}, ${target}, ${inlets.in ?? '0.f'}, (${feedback}) * 0.0098f, 1.f - dampingPercent_${suffix} * 0.0095f, &dampZ_${suffix}, mixPercent_${suffix} * 0.01f)`
  },
  advanceStatement: () => '',
  helpers: [CLAMPF_HELPER, LONG_DELAY_STEP_HELPER],
  params: [
    {
      name: 'RANGE',
      structural: true,
      unit: LONG_DELAY_RANGE_NAME,
      select: { count: 4, scale: 1, label: 'Range', names: ['0.34 s', '1.4 s', '2.7 s', '5.5 s'] },
      min: 0,
      max: 3,
      default: LONG_DELAY_DEFAULT_RANGE,
      step: 1,
      setStatement: (suffix, valueExpr) =>
        `len_${suffix} = (${valueExpr}) >= 3 ? ${LONG_DELAY_LENGTHS[3]}u : (${valueExpr}) >= 2 ? ${LONG_DELAY_LENGTHS[2]}u : (${valueExpr}) >= 1 ? ${LONG_DELAY_LENGTHS[1]}u : ${LONG_DELAY_LENGTHS[0]}u;`
    },
    {
      name: 'TIME',
      unit: PERCENT,
      modulatedBy: { inlet: 'time', shape: 'additive', note: 'only while SYNC is off' },
      trackGate: FREE_TIME_GATE,
      min: 0,
      max: 100,
      default: 25,
      setStatement: (suffix, valueExpr) => `timePercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'SYNC',
      booleanWidget: TEMPO_SYNC_WIDGET,
      min: 0,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `sync_${suffix} = ${valueExpr};`
    },
    {
      name: 'DIVISION',
      unit: TEMPO_DIVISION_NAME,
      trackGate: NEEDS_TEMPO_SYNC_GATE,
      select: {
        count: 10,
        scale: 1,
        label: 'Div',
        names: ['1/16', '1/8T', '1/8', '1/8D', '1/4T', '1/4', '1/4D', '1/2', '1/2D', '1/1']
      },
      min: 0,
      max: 9,
      default: 5,
      step: 1,
      setStatement: (suffix, valueExpr) => `div_${suffix} = (int)(${valueExpr});`
    },
    {
      name: 'FEEDBACK',
      unit: PERCENT,
      modulatedBy: { inlet: 'feedback', shape: 'additive' },
      min: 0,
      max: 100,
      default: 35,
      setStatement: (suffix, valueExpr) => `feedbackPercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'DAMPING',
      unit: PERCENT,
      min: 0,
      max: 100,
      default: 20,
      setStatement: (suffix, valueExpr) => `dampingPercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'MIX',
      unit: PERCENT,
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `mixPercent_${suffix} = ${valueExpr};`
    }
  ]
}

/** LENGTH 0..3 -> the ring's length in samples (a power of two, so the index masks). */
const BUFFER_LENGTHS = [32768, 65536, 131072, 262144]
const BUFFER_DEFAULT_LENGTH = 2
// int16 over +-2, like util/delay: a feedback loop has 6 dB of headroom before the clamp.
const BUFFER_STORE_SCALE = 16383

function bufferLength(value: number): number {
  const i = Math.min(3, Math.max(0, Math.round(value)))
  return BUFFER_LENGTHS[Number.isFinite(i) ? i : BUFFER_DEFAULT_LENGTH]
}

/**
 * What a buffer reader's code needs from the writer a `buf` wire names (`oscBody.ts` passes a
 * buffer inlet the writer's suffix): its int16 samples, index mask and write index. At compute
 * time `write` is the slot the writer fills next (it writes in `advanceStatement`), so delay 1
 * is the newest sample and delay `mask + 1` the oldest, whatever order the graph emits in.
 */
export function bufferRef(writerSuffix: string): { data: string; mask: string; write: string } {
  return {
    data: `((const int16_t *)sdram_${writerSuffix})`,
    mask: `(bufLen_${writerSuffix} - 1u)`,
    write: `bufW_${writerSuffix}`
  }
}

const BUFFER_WRITE_HELPER: HelperBlock = {
  key: 'buffer_write',
  code: `  // Stores one sample into a ring of int16 (over +-2). freeze (0 or 1) glides the stored value
  // from the input to what the slot already holds (~5 ms), so the buffer keeps looping its
  // content; once fully frozen the slot is left alone, so the loop doesn't wear down by
  // re-quantizing on every pass. The index keeps moving either way. A leaf.
  static inline __attribute__((always_inline)) void buffer_write(int16_t *buf, uint32_t mask, uint32_t *w, float in, float freeze, float *level)
  {
    *level += (freeze - *level) * 0.004f;
    const uint32_t i = *w & mask;
    *w = *w + 1u;
    if (*level > 0.9999f) return;
    const float old = (float)buf[i] * (1.f / ${BUFFER_STORE_SCALE}.f);
    float x = in + (old - in) * *level;
    if (x > 2.f) x = 2.f; else if (x < -2.f) x = -2.f;
    buf[i] = (int16_t)(x * ${BUFFER_STORE_SCALE}.f + (x < 0.f ? -0.5f : 0.5f));
  }
`
}

/**
 * `logue/util/buffer`: a recording ring in the effect's SDRAM that other nodes read through its
 * `buf` outlet -- a buffer wire, a reference to the ring rather than a signal (Axoloti's
 * `table/alloc` + objref, but visible as a wire). It only writes: `util/buffer-tap` reads it at a
 * delay, and more readers can share one buffer. The input is stored in `advanceStatement` (so
 * `in`/`freeze` are `delayedInlets`): readers always see the samples before this one, and a
 * reader's output may feed the buffer's own input (feedback) without a `sample-delay`. FREEZE
 * (or a gate on `freeze`) stops recording and keeps the content looping. int16 storage over +-2
 * halves the SDRAM (2.7 s = 256 KB). Effects only.
 */
export const bufferPrimitive: LoguePrimitive = {
  id: 'logue/util/buffer',
  modules: ['modfx', 'delfx', 'revfx'],
  description:
    "A recording buffer in the effect's SDRAM (LENGTH sets its size when built). Its buf outlet goes to readers such as buffer-tap. FREEZE, or a gate into freeze, stops recording and keeps the content. Effects only.",
  inlets: [
    { name: 'in', role: 'audio' },
    { name: 'freeze', role: 'control' }
  ],
  delayedInlets: ['in', 'freeze'],
  outlets: [{ name: 'buf' }],
  outletPolarity: 'buffer',
  // bufLen_, bufW_, freezeLevel_, freeze_ (4 x 4 B); the ring is SDRAM.
  stateBytesPerInstance: 16,
  memberDecls: (suffix) =>
    `  uint32_t bufLen_${suffix};\n  uint32_t bufW_${suffix};\n  float freezeLevel_${suffix};\n  float freeze_${suffix};\n`,
  initStatement: (suffix) => `    bufW_${suffix} = 0u;\n    freezeLevel_${suffix} = 0.f;\n`,
  sdramFloats: (node) =>
    bufferLength(
      Number(node.params?.find((p) => p.name === 'LENGTH')?.value ?? BUFFER_DEFAULT_LENGTH)
    ) / 2,
  // Nothing per sample but the store: the outlet is the ring itself.
  renderOutletStatements: () => '',
  renderExpr: () => '0.f',
  advanceStatement: (suffix, inlets) => {
    const freeze =
      inlets.freeze === undefined
        ? `(freeze_${suffix} >= ${TRACK_ON_RAW_THRESHOLD}.f ? 1.f : 0.f)`
        : `((freeze_${suffix} >= ${TRACK_ON_RAW_THRESHOLD}.f || ${inlets.freeze} >= 0.5f) ? 1.f : 0.f)`
    return `      buffer_write((int16_t *)sdram_${suffix}, bufLen_${suffix} - 1u, &bufW_${suffix}, ${inlets.in ?? '0.f'}, ${freeze}, &freezeLevel_${suffix});\n`
  },
  helpers: BUFFER_WRITE_HELPER,
  params: [
    {
      name: 'LENGTH',
      structural: true,
      unit: BUFFER_LENGTH_NAME,
      select: { count: 4, scale: 1, label: 'Length', names: ['0.68 s', '1.4 s', '2.7 s', '5.5 s'] },
      min: 0,
      max: 3,
      default: BUFFER_DEFAULT_LENGTH,
      step: 1,
      setStatement: (suffix, valueExpr) =>
        `bufLen_${suffix} = (${valueExpr}) >= 3 ? ${BUFFER_LENGTHS[3]}u : (${valueExpr}) >= 2 ? ${BUFFER_LENGTHS[2]}u : (${valueExpr}) >= 1 ? ${BUFFER_LENGTHS[1]}u : ${BUFFER_LENGTHS[0]}u;`
    },
    {
      name: 'FREEZE',
      booleanWidget: FREEZE_WIDGET,
      min: 0,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `freeze_${suffix} = ${valueExpr};`
    }
  ]
}

const BUFFER_TAP_TIME_INLET_DEPTH = 50

const BUFFER_TAP_HELPER: HelperBlock = {
  key: 'buffer_tap_read',
  code: `  // Reads a util/buffer ring (int16 over +-2) at a fractional delay in samples with a 4-point
  // Hermite interpolation, the delay clamped so all four points are recorded samples (3 up to
  // the ring's length - 2). A leaf.
  static inline __attribute__((always_inline)) float buffer_tap_read(const int16_t *buf, uint32_t mask, uint32_t w, float delay)
  {
    const float maxDelay = (float)(mask - 1u);
    if (delay < 3.f) delay = 3.f; else if (delay > maxDelay) delay = maxDelay;
    const uint32_t di = (uint32_t)delay;
    const float frac = 1.f - (delay - (float)di);
    const uint32_t i = w - di - 1u;
    const float toFloat = 1.f / ${BUFFER_STORE_SCALE}.f;
    const float xm1 = (float)buf[(i - 1u) & mask] * toFloat;
    const float x0 = (float)buf[i & mask] * toFloat;
    const float x1 = (float)buf[(i + 1u) & mask] * toFloat;
    const float x2 = (float)buf[(i + 2u) & mask] * toFloat;
    const float c = (x1 - xm1) * 0.5f;
    const float v = x0 - x1;
    const float a = c + v + v + (x2 - x0) * 0.5f;
    return (((a * frac) - (c + v + a)) * frac + c) * frac + x0;
  }
`
}

/**
 * `logue/util/buffer-tap`: reads a `util/buffer` at a delay -- TIME 0..100 % of the buffer's
 * length (3 samples up to the whole ring), a wired `time` additive on it. Several taps on one
 * buffer make a multi-tap delay; a tap into the buffer's input makes an echo. No smoothing: a
 * jump in TIME jumps (wire `util/glide` into `time` for a tape bend). Unwired `buf`: silence.
 * Effects only (a buffer is).
 */
export const bufferTapPrimitive: LoguePrimitive = {
  id: 'logue/util/buffer-tap',
  modules: ['modfx', 'delfx', 'revfx'],
  description:
    'Reads a buffer at a delay: TIME is 0..100 % of its length. Several taps on one buffer make a multi-tap delay. Effects only.',
  inlets: [
    { name: 'buf', role: 'buffer' },
    { name: 'time', role: 'control' }
  ],
  outletPolarity: 'audio',
  stateBytesPerInstance: 4, // timePercent_
  memberDecls: (suffix) => `  float timePercent_${suffix};\n`,
  renderExpr: (suffix, inlets) => {
    if (inlets.buf === undefined) return '0.f'
    const ref = bufferRef(inlets.buf)
    const time =
      inlets.time !== undefined
        ? additiveInletExpr('timePercent', suffix, inlets.time, BUFFER_TAP_TIME_INLET_DEPTH)
        : `timePercent_${suffix}`
    return `buffer_tap_read(${ref.data}, ${ref.mask}, ${ref.write}, 3.f + (${time}) * 0.01f * (float)(${ref.mask} - 4u))`
  },
  advanceStatement: () => '',
  helpers: [CLAMPF_HELPER, BUFFER_TAP_HELPER],
  params: [
    {
      name: 'TIME',
      unit: PERCENT,
      modulatedBy: { inlet: 'time', shape: 'additive' },
      min: 0,
      max: 100,
      default: 25,
      setStatement: (suffix, valueExpr) => `timePercent_${suffix} = ${valueExpr};`
    }
  ]
}

/** MAXLEN 0..2 -> the grain table's length in samples (its longest grain). */
const GRAIN_MAXLENS = [16384, 32768, 65536]
const GRAIN_DEFAULT_MAXLEN = 2
// The shortest grain, 10 ms: SIZE 0.
const GRAIN_MIN_SAMPLES = 480
const GRAIN_INLET_DEPTH = 50

function grainMaxLen(value: number): number {
  const i = Math.min(2, Math.max(0, Math.round(value)))
  return GRAIN_MAXLENS[Number.isFinite(i) ? i : GRAIN_DEFAULT_MAXLEN]
}

const GRAIN_STEP_HELPER: HelperBlock = {
  key: 'grain_step',
  code: `  // One sample of a looping grain (util/grain). st: [0] index, [1] length (0 = nothing yet),
  // [2] delay, [3] fade, [4] capturing. On a rising trig -- or, with selfTrig, at the start of
  // every pass -- it latches the delay (position 0..1 of the buffer, 1 = oldest), the length (size,
  // in samples) and the fade (0..1 of half the grain), then for length samples copies the buffer
  // at that constant delay into its own table (int16 over +-2, like the buffer), a fade-in and
  // fade-out of fade samples baked in, and afterwards loops the table until the next trigger.
  // What was playing at the trigger (*last) ramps out over the fade, so a retrigger doesn't
  // click. Inlined (always_inline): a call with its fourteen arguments cost more than much of
  // the body in grain-mill (xd emulator, 2026-10-01); code grows by a copy per voice.
  static inline __attribute__((always_inline)) float grain_step(const int16_t *buf, uint32_t mask, uint32_t w, int16_t *table, uint32_t tableLen, uint32_t *st, float *prevTrig, float *hold, float *last, float trig, int selfTrig, float positionPercent, float sizePercent, float fadePercent)
  {
    const float gate = trig >= 0.5f ? 1.f : 0.f;
    int start = gate > *prevTrig;
    *prevTrig = gate;
    if (selfTrig && !st[4] && st[0] == 0u) start = 1;
    if (start)
    {
      *hold = *last;
      // Position and size are only ever read here, so the clamps and SIZE's cube cost nothing
      // between triggers (they used to be computed every sample: +40 cycles a voice on the xd).
      const float p = positionPercent < 0.f ? 0.f : (positionPercent > 100.f ? 1.f : positionPercent * 0.01f);
      st[2] = 1u + (uint32_t)(p * (float)mask);
      const float t = sizePercent < 0.f ? 0.f : (sizePercent > 100.f ? 1.f : sizePercent * 0.01f);
      uint32_t len = ${GRAIN_MIN_SAMPLES}u + (uint32_t)((float)(tableLen - ${GRAIN_MIN_SAMPLES}u) * t * t * t);
      if (len > tableLen) len = tableLen;
      st[1] = len;
      const float f = fadePercent < 0.f ? 0.f : (fadePercent > 100.f ? 1.f : fadePercent * 0.01f);
      st[3] = 16u + (uint32_t)(f * (float)(len / 2u - 16u));
      st[4] = 1u;
      st[0] = 0u;
    }
    const uint32_t len = st[1];
    if (len == 0u) { *last = 0.f; return 0.f; }
    const uint32_t i = st[0];
    const uint32_t fl = st[3];
    const float toFloat = 1.f / ${BUFFER_STORE_SCALE}.f;
    if (st[4])
    {
      float att = 1.f;
      if (i < fl) att = (float)i / (float)fl;
      if (len - i <= fl) { const float a = (float)(len - i) / (float)fl; if (a < att) att = a; }
      float x = (float)buf[(w - st[2]) & mask] * toFloat * att;
      if (x > 2.f) x = 2.f; else if (x < -2.f) x = -2.f;
      table[i] = (int16_t)(x * ${BUFFER_STORE_SCALE}.f + (x < 0.f ? -0.5f : 0.5f));
    }
    float out = (float)table[i] * toFloat;
    if (st[4] && i < fl) out += *hold * (1.f - (float)i / (float)fl);
    *last = out;
    if (++st[0] >= len) { st[0] = 0u; st[4] = 0u; }
    return out;
  }
`
}

/**
 * `logue/util/grain`: the grain player of grain-mill (docs/PLAN-grain-mill.md), after the
 * Axoloti grain-player: on a rising `trig` it latches POSITION (how far back in the buffer, 0 =
 * the newest audio, 100 = the oldest) and SIZE (10 ms up to MAXLEN, cubed), records that long
 * from a `util/buffer` at a fixed delay into its own table in SDRAM -- so a frozen snapshot, not
 * a window on a moving buffer -- with FADE-long ramps baked in at both ends, and loops it until
 * the next trigger. Unlike the original, what was playing at the trigger ramps out instead of
 * the new grain crossfading against the old table's start (which clicked). With `trig` unwired it
 * retriggers itself at the start of every pass: a stream of fresh grains. MAXLEN is structural
 * (it sizes the table: 32/64/128 KB). Effects only.
 */
export const grainPrimitive: LoguePrimitive = {
  id: 'logue/util/grain',
  modules: ['modfx', 'delfx', 'revfx'],
  description:
    'A looping grain from a buffer: on each trigger it records SIZE of the buffer, POSITION back, and loops it until the next one. FADE ramps its ends. Unwired trig: a fresh grain every pass. Effects only.',
  inlets: [
    { name: 'buf', role: 'buffer' },
    { name: 'trig', role: 'control' },
    { name: 'position', role: 'control' },
    { name: 'size', role: 'control' }
  ],
  outletPolarity: 'audio',
  // grainSt_[5] (20 B) + prevTrig_, hold_, last_ + positionPercent_, sizePercent_, fadePercent_
  // + grainLen_ (7 x 4 B). The table is SDRAM.
  stateBytesPerInstance: 48,
  memberDecls: (suffix) =>
    `  uint32_t grainSt_${suffix}[5];\n  float prevTrig_${suffix};\n  float hold_${suffix};\n  float last_${suffix};\n  float positionPercent_${suffix};\n  float sizePercent_${suffix};\n  float fadePercent_${suffix};\n  uint32_t grainLen_${suffix};\n`,
  initStatement: (suffix) =>
    `    for (int k = 0; k < 5; ++k) grainSt_${suffix}[k] = 0u;\n    prevTrig_${suffix} = 0.f;\n    hold_${suffix} = 0.f;\n    last_${suffix} = 0.f;\n`,
  sdramFloats: (node) =>
    grainMaxLen(
      Number(node.params?.find((p) => p.name === 'MAXLEN')?.value ?? GRAIN_DEFAULT_MAXLEN)
    ) / 2,
  renderExpr: (suffix, inlets) => {
    if (inlets.buf === undefined) return '0.f'
    const ref = bufferRef(inlets.buf)
    // Unclamped: grain_step clamps them when it triggers, the only time it reads them.
    const additive = (member: string, wired: string | undefined): string =>
      wired !== undefined
        ? `(${member}_${suffix} + (${wired}) * ${GRAIN_INLET_DEPTH}.f)`
        : `${member}_${suffix}`
    return `grain_step(${ref.data}, ${ref.mask}, ${ref.write}, (int16_t *)sdram_${suffix}, grainLen_${suffix}, grainSt_${suffix}, &prevTrig_${suffix}, &hold_${suffix}, &last_${suffix}, ${inlets.trig ?? '0.f'}, ${inlets.trig === undefined ? 1 : 0}, ${additive('positionPercent', inlets.position)}, ${additive('sizePercent', inlets.size)}, fadePercent_${suffix})`
  },
  advanceStatement: () => '',
  helpers: GRAIN_STEP_HELPER,
  params: [
    {
      name: 'POSITION',
      unit: PERCENT,
      modulatedBy: { inlet: 'position', shape: 'additive', note: 'read at each trigger' },
      min: 0,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `positionPercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'SIZE',
      unit: PERCENT,
      modulatedBy: { inlet: 'size', shape: 'additive', note: 'read at each trigger' },
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `sizePercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'FADE',
      unit: PERCENT,
      min: 0,
      max: 100,
      default: 10,
      setStatement: (suffix, valueExpr) => `fadePercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'MAXLEN',
      structural: true,
      unit: GRAIN_MAXLEN_NAME,
      select: { count: 3, scale: 1, label: 'Max', names: ['0.34 s', '0.68 s', '1.4 s'] },
      min: 0,
      max: 2,
      default: GRAIN_DEFAULT_MAXLEN,
      step: 1,
      setStatement: (suffix, valueExpr) =>
        `grainLen_${suffix} = (${valueExpr}) >= 2 ? ${GRAIN_MAXLENS[2]}u : (${valueExpr}) >= 1 ? ${GRAIN_MAXLENS[1]}u : ${GRAIN_MAXLENS[0]}u;`
    }
  ]
}

// The shortest segment, 40 ms, and the shortest fade, 5 ms (WINDOW 0).
const REVERSE_MIN_SEGMENT = 1920
const REVERSE_MIN_FADE = 240
const REVERSE_SIZE_INLET_DEPTH = 50

const REVERSE_TAP_HELPER: HelperBlock = {
  key: 'reverse_tap_step',
  code: `  // A segment's length in samples for SIZE: 40 ms up to half the ring (squared), even, so a
  // head's delay 2c + 1 never passes the oldest sample.
  static inline __attribute__((always_inline)) uint32_t reverse_tap_len(uint32_t mask, float sizePercent)
  {
    const uint32_t maxN = (((mask + 1u) >> 1) - 2u) & ~1u;
    const float t = sizePercent < 0.f ? 0.f : (sizePercent > 100.f ? 1.f : sizePercent * 0.01f);
    uint32_t n = (${REVERSE_MIN_SEGMENT}u + (uint32_t)((float)(maxN - ${REVERSE_MIN_SEGMENT}u) * t * t)) & ~1u;
    return n > maxN ? maxN : n;
  }
  // A fade's length for WINDOW: 5 ms (0) up to half the segment (100, a full crossfade).
  static inline __attribute__((always_inline)) uint32_t reverse_tap_fade(uint32_t n, float windowPercent)
  {
    const float u = windowPercent < 0.f ? 0.f : (windowPercent > 100.f ? 1.f : windowPercent * 0.01f);
    const uint32_t f = ${REVERSE_MIN_FADE}u + (uint32_t)((float)((n >> 1) - ${REVERSE_MIN_FADE}u) * u);
    return f > (n >> 1) ? (n >> 1) : f;
  }
  // The window at sample c of a segment of n with fade-in fi and fade-out fo, smoothstepped so a
  // fade-out and the other head's fade-in of the same length sum to exactly 1.
  static inline __attribute__((always_inline)) float reverse_tap_window(uint32_t c, uint32_t n, float invFi, uint32_t fi, float invFo, uint32_t fo)
  {
    float g = 1.f;
    if (c < fi) g = (float)c * invFi;
    else if (n - c < fo) g = (float)(n - c) * invFo;
    return g * g * (3.f - 2.f * g);
  }
  // Two reverse heads on a util/buffer ring (int16 over +-2). Head a plays segments of n samples
  // backwards: at sample c it reads delay 2c + 1, so it moves back through the last n samples
  // before its segment began, at exactly the recorded speed (a whole-sample read, nothing to
  // interpolate). Head b plays the segments between a's midpoints, so with WINDOW 100 the two
  // crossfade at constant gain. SIZE and WINDOW are read at a's midpoint for a's NEXT segment,
  // which is also when b's next segment begins (it ends at that segment's midpoint), so both
  // heads' lengths and fades stay matched while SIZE moves and no read ever jumps mid-segment.
  // st: [0] a's c, [1] a's n (0 = not started), [2] a's fade, [3] a's next n, [4] its fade,
  // [5] b's c, [6] b's n (0 = not started), [7] b's fade-in, [8] b's fade-out.
  // fs: 1/[1], 1/[2], 1/[6], 1/[7], 1/[8]. A leaf.
  static inline __attribute__((always_inline)) void reverse_tap_step(const int16_t *buf, uint32_t mask, uint32_t w, uint32_t *st, float *fs, float sizePercent, float windowPercent, float *outA, float *outB, float *phaseA, float *phaseB)
  {
    if (st[0] >= st[1])
    {
      uint32_t n = st[3], f = st[4];
      if (n == 0u) { n = reverse_tap_len(mask, sizePercent); f = reverse_tap_fade(n, windowPercent); }
      st[0] = 0u; st[1] = n; st[2] = f;
      fs[0] = 1.f / (float)n; fs[1] = 1.f / (float)f;
    }
    if (st[0] == (st[1] >> 1))
    {
      const uint32_t n = reverse_tap_len(mask, sizePercent);
      const uint32_t f = reverse_tap_fade(n, windowPercent);
      st[3] = n; st[4] = f;
      st[5] = 0u; st[6] = (st[1] >> 1) + (n >> 1); st[7] = st[2]; st[8] = f;
      fs[2] = 1.f / (float)st[6]; fs[3] = 1.f / (float)st[7]; fs[4] = 1.f / (float)st[8];
    }
    const float toFloat = 1.f / ${BUFFER_STORE_SCALE}.f;
    const uint32_t ca = st[0];
    *outA = (float)buf[(w - 2u * ca - 1u) & mask] * toFloat * reverse_tap_window(ca, st[1], fs[1], st[2], fs[1], st[2]);
    *phaseA = (float)ca * fs[0];
    st[0] = ca + 1u;
    const uint32_t cb = st[5];
    if (cb < st[6])
    {
      *outB = (float)buf[(w - 2u * cb - 1u) & mask] * toFloat * reverse_tap_window(cb, st[6], fs[3], st[7], fs[4], st[8]);
      *phaseB = (float)cb * fs[2];
      st[5] = cb + 1u;
    }
    else { *outB = 0.f; *phaseB = 0.f; }
  }
`
}

/**
 * `logue/util/reverse-tap`: the playback head of a reverse delay (docs/PLAN-reverse-delay.md).
 * It plays a `util/buffer` backwards in segments of SIZE (40 ms up to half the buffer), with two
 * heads half a segment apart, each faded in and out by WINDOW (5 ms up to a full crossfade). At
 * WINDOW 100, `a + b` is a seamless reversed stream; `phaseA`/`phaseB` (0..1 across each head's
 * own segment) let a patch move something with each swell, such as a pan. Both heads are in one
 * node because separate instances couldn't stay half a segment apart while SIZE moves.
 * A buffer-tap swept by a ramp LFO can reverse too, but only at fixed segment lengths: its speed
 * depends on the ramp's rate matching its span, and an integer device value of RATE is 15-90 ct
 * off. Effects only.
 */
export const reverseTapPrimitive: LoguePrimitive = {
  id: 'logue/util/reverse-tap',
  modules: ['modfx', 'delfx', 'revfx'],
  description:
    'Plays a buffer backwards in segments of SIZE, with two heads half a segment apart (a and b), faded by WINDOW. At WINDOW 100, a + b is a seamless reversed stream; phaseA/phaseB follow each segment. Effects only.',
  inlets: [
    { name: 'buf', role: 'buffer' },
    { name: 'size', role: 'control' }
  ],
  outlets: [{ name: 'a' }, { name: 'b' }, { name: 'phaseA' }, { name: 'phaseB' }],
  outletPolarity: { a: 'audio', b: 'audio', phaseA: 'unipolar', phaseB: 'unipolar' },
  // revSt_[9] (36 B) + revFs_[5] (20 B) + sizePercent_, windowPercent_ (8 B).
  stateBytesPerInstance: 64,
  memberDecls: (suffix) =>
    `  uint32_t revSt_${suffix}[9];\n  float revFs_${suffix}[5];\n  float sizePercent_${suffix};\n  float windowPercent_${suffix};\n`,
  initStatement: (suffix) =>
    `    for (int k = 0; k < 9; ++k) revSt_${suffix}[k] = 0u;\n    for (int k = 0; k < 5; ++k) revFs_${suffix}[k] = 0.f;\n`,
  renderExpr: () => {
    throw new Error('logue/util/reverse-tap is multi-outlet -- use renderOutletStatements')
  },
  renderOutletStatements: (suffix, inlets) => {
    const decl = `      float y_${suffix}_a = 0.f, y_${suffix}_b = 0.f, y_${suffix}_phaseA = 0.f, y_${suffix}_phaseB = 0.f;\n`
    const voids = `      (void)y_${suffix}_a; (void)y_${suffix}_b; (void)y_${suffix}_phaseA; (void)y_${suffix}_phaseB;\n`
    if (inlets.buf === undefined) return decl + voids
    const ref = bufferRef(inlets.buf)
    // Unclamped: reverse_tap_len clamps it, and only reads it twice a segment.
    const size =
      inlets.size !== undefined
        ? `(sizePercent_${suffix} + (${inlets.size}) * ${REVERSE_SIZE_INLET_DEPTH}.f)`
        : `sizePercent_${suffix}`
    return (
      decl +
      `      reverse_tap_step(${ref.data}, ${ref.mask}, ${ref.write}, revSt_${suffix}, revFs_${suffix}, ${size}, windowPercent_${suffix}, &y_${suffix}_a, &y_${suffix}_b, &y_${suffix}_phaseA, &y_${suffix}_phaseB);\n` +
      voids
    )
  },
  advanceStatement: () => '',
  helpers: REVERSE_TAP_HELPER,
  params: [
    {
      name: 'SIZE',
      unit: PERCENT,
      modulatedBy: { inlet: 'size', shape: 'additive', note: 'read once a segment' },
      min: 0,
      max: 100,
      default: 40,
      setStatement: (suffix, valueExpr) => `sizePercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'WINDOW',
      unit: PERCENT,
      min: 0,
      max: 100,
      default: 100,
      setStatement: (suffix, valueExpr) => `windowPercent_${suffix} = ${valueExpr};`
    }
  ]
}

// Bit n = semitone n above ROOT is in the scale. Order matches QUANTIZE_SCALE_NAMES.
const QUANTIZE_SCALE_MASKS = [
  0xfff, // chromatic
  0xab5, // major: 0 2 4 5 7 9 11
  0x5ad, // natural minor: 0 2 3 5 7 8 10
  0x6ad, // dorian: 0 2 3 5 7 9 10
  0x6b5, // mixolydian: 0 2 4 5 7 9 10
  0x9ad, // harmonic minor: 0 2 3 5 7 8 11
  0x295, // major pentatonic: 0 2 4 7 9
  0x4a9, // minor pentatonic: 0 3 5 7 10
  0x555, // whole tone: 0 2 4 6 8 10
  0x001 // octaves
]
// Short enough for the NTS-1 mkII's value display.
export const QUANTIZE_SCALE_NAMES = [
  'Chrom',
  'Major',
  'Minor',
  'Dorian',
  'Mixolyd',
  'HarmMin',
  'MajPent',
  'MinPent',
  'WholeTn',
  'Octave'
]
// Flats, not sharps: the NTS-1 mkII's display shows "#" as a blank (user, 2026-09-30).
const NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']

const QUANTIZE_STEP_HELPER: HelperBlock = {
  key: 'quantize_step',
  code: `  // Snaps x (semitones above ROOT) to the nearest note in the scale mask (bit n = semitone n).
  // A new note is taken only once x is a quarter-semitone closer to it than to the current one,
  // so a signal sitting on a boundary doesn't chatter; *trig is 1 for the one sample a note
  // changes. The search looks at most 6 semitones each way, enough for any scale here. A leaf.
  static float quantize_step(float x, int mask, float *current, float *trig)
  {
    // Within half a semitone of the current note no other note can win (the nearest one is at
    // least a semitone away), so skip the search: the usual case for a slow modulator.
    float near = x - *current;
    if (near <= 0.5f && near >= -0.5f) { *trig = 0.f; return *current; }
    int r = (int)(x + 1000.5f) - 1000;
    float best = (float)r;
    for (int d = 0; d <= 6; d++)
    {
      int up = r + d, down = r - d;
      int upIn = (mask >> (((up % 12) + 12) % 12)) & 1;
      int downIn = (mask >> (((down % 12) + 12) % 12)) & 1;
      if (upIn || downIn)
      {
        float fu = (float)up, fd = (float)down;
        float du = x - fu, dd = x - fd;
        if (du < 0.f) du = -du;
        if (dd < 0.f) dd = -dd;
        best = (upIn && (!downIn || du <= dd)) ? fu : fd;
        break;
      }
    }
    *trig = 0.f;
    if (best != *current)
    {
      float dCur = x - *current, dNew = x - best;
      if (dCur < 0.f) dCur = -dCur;
      if (dNew < 0.f) dNew = -dNew;
      if (dCur - dNew > 0.25f) { *current = best; *trig = 1.f; }
    }
    return *current;
  }
`
}

/**
 * `logue/util/quantize`: snaps a control signal to the notes of a scale, for melodies from an
 * LFO, random steps or an envelope. It works in the `pitch` inlet's own units (+-1 = +-24
 * semitones, `COARSE_PARAM.max`), so it drops in between a modulator and an oscillator's `pitch`.
 * SCALE picks one of ten scales, ROOT (C..B) transposes it. The `trig` outlet pulses for one
 * sample whenever the note changes, to play each new note through an envelope's `trig`/`gate`.
 * A quarter-semitone of hysteresis keeps a signal hovering on a boundary from chattering. The
 * output isn't clamped, so ROOT can take it slightly past +-1 (+-24 st + 11), which `pitch`
 * accepts.
 */
export const quantizePrimitive: LoguePrimitive = {
  id: 'logue/util/quantize',
  outletPolarity: { pitch: 'bipolar', trig: 'gate' },
  // current_ + trig_ + scale_ + root_
  stateBytesPerInstance: 16,
  description:
    'Snaps a signal to the notes of a scale (in pitch-input units, so it goes straight into an oscillator’s pitch). SCALE and ROOT pick the scale; trig pulses on every note change, to play each note through an envelope.',
  inlets: [{ name: 'in', role: 'audio' }],
  outlets: [{ name: 'pitch' }, { name: 'trig' }],
  memberDecls: (suffix) =>
    `  float current_${suffix};\n  float trig_${suffix};\n  float scale_${suffix};\n  float root_${suffix};\n`,
  // Far from any note, so the first sample always takes one (and triggers).
  initStatement: (suffix) => `    current_${suffix} = -1000.f;\n    trig_${suffix} = 0.f;\n`,
  renderExpr: () => {
    throw new Error('logue/util/quantize is multi-outlet -- use renderOutletStatements')
  },
  renderOutletStatements: (suffix, inlets) => {
    const masks = QUANTIZE_SCALE_MASKS.map((m) => `0x${m.toString(16)}`).join(', ')
    const scale = `(int)scale_${suffix}`
    return (
      `      static const int kQuantizeMasks_${suffix}[${QUANTIZE_SCALE_MASKS.length}] = {${masks}};\n` +
      `      float y_${suffix}_pitch = (quantize_step((${inlets.in ?? '0.f'}) * ${COARSE_PARAM.max}.f - root_${suffix}, kQuantizeMasks_${suffix}[${scale} < 0 ? 0 : ${scale} > ${QUANTIZE_SCALE_MASKS.length - 1} ? ${QUANTIZE_SCALE_MASKS.length - 1} : ${scale}], &current_${suffix}, &trig_${suffix}) + root_${suffix}) * (1.f / ${COARSE_PARAM.max}.f);\n` +
      `      float y_${suffix}_trig = trig_${suffix};\n` +
      `      (void)y_${suffix}_pitch; (void)y_${suffix}_trig;\n`
    )
  },
  advanceStatement: () => '',
  helpers: [QUANTIZE_STEP_HELPER],
  params: [
    {
      name: 'SCALE',
      unit: QUANTIZE_SCALE,
      select: {
        count: QUANTIZE_SCALE_MASKS.length,
        scale: 1,
        label: 'Scale',
        names: QUANTIZE_SCALE_NAMES
      },
      min: 0,
      max: QUANTIZE_SCALE_MASKS.length - 1,
      default: 1,
      step: 1,
      setStatement: (suffix, valueExpr) => `scale_${suffix} = ${valueExpr};`
    },
    {
      name: 'ROOT',
      unit: ROOT_NOTE,
      select: { count: 12, scale: 1, label: 'Root', names: NOTE_NAMES },
      min: 0,
      max: 11,
      default: 0,
      step: 1,
      setStatement: (suffix, valueExpr) => `root_${suffix} = ${valueExpr};`
    }
  ]
}

const FREQ_SHIFT_STEP_HELPER: HelperBlock = {
  key: 'freq_shift_step',
  code: `  // A Bode frequency shifter: the input plus the fed-back shifted signal through hilbert_step,
  // then the pair turned by the carrier phase: i*cos - q*sin moves every partial up by the
  // carrier's frequency, i*cos + q*sin (*mirror) down. The feedback is the previous sample's up
  // output through comb_step's ~1.5 Hz DC blocker (dc[0..1]) -- at SHIFT 0 the pair passes DC
  // at +1, so FEEDBACK 90% would lift an input's DC offset 10x -- and its soft limit (linear to
  // 0.6, ceiling 1.0). inc may be negative (through-zero); the phase stays in 0..1, as osc_sinf
  // needs. A leaf.
  static float freq_shift_step(float *h, int *parity, float *phase, float *fbZ, float *dc, float x, float inc, float fb, float mix, float *mirror)
  {
    const float blocked = *fbZ - dc[0] + 0.9998f * dc[1];
    dc[0] = *fbZ;
    dc[1] = blocked;
    float f = fb * blocked;
    float mag = f < 0.f ? -f : f;
    if (mag > 0.6f)
    {
      float over = mag - 0.6f;
      if (over > 0.8f) over = 0.8f;
      mag = 0.6f + over - 0.625f * over * over;
      f = f < 0.f ? -mag : mag;
    }
    float i, q;
    hilbert_step(h, parity, x + f, &i, &q);
    const float p = *phase;
    const float c = osc_sinf(p + 0.25f);
    const float s = osc_sinf(p);
    const float up = i * c - q * s;
    const float down = i * c + q * s;
    *fbZ = up;
    float np = p + inc;
    if (np >= 1.f) np -= 1.f;
    else if (np < 0.f) np += 1.f;
    *phase = np;
    *mirror = x + (down - x) * mix;
    return x + (up - x) * mix;
  }
`
}

// A wired shift sweeps the whole dial from its centre (half the -100..100 span), so an LFO
// can take it through zero; feedback matches `util/delay`'s.
const FREQ_SHIFT_INLET_DEPTH = 100
const FREQ_SHIFT_FEEDBACK_INLET_DEPTH = 50

/** The carrier's phase increment per sample: `2000 Hz * s^3 / 48000` for SHIFT `s` in -1..1. */
function freqShiftIncExpr(shift: string): string {
  const s = `((${shift}) * 0.01f)`
  return `(${s} * ${s} * ${s} * ${(2000 / 48000).toPrecision(9)}f)`
}

/** Unwired, the increment is a block constant; wired, a per-sample local (`sh_<suffix>`, the
 *  clamped sum, so the cube reads it once) declared by `renderOutletStatements`. */
function freqShiftValues(
  suffix: string,
  inlets: Record<string, string | undefined>
): Record<'inc', BlockValue> {
  // A per-sample shift goes through the loop's sh_ local; a per-block one (knob-only math) must
  // not -- the block constant is computed before the loop, where sh_ doesn't exist yet.
  const shift =
    inlets.shift === undefined
      ? `shiftPercent_${suffix}`
      : isBlockInvariant(inlets.shift)
        ? additiveInletExpr('shiftPercent', suffix, inlets.shift, FREQ_SHIFT_INLET_DEPTH, -100, 100)
        : `sh_${suffix}`
  return { inc: blockValue('blkInc', suffix, freqShiftIncExpr(shift), [inlets.shift]) }
}

/**
 * `logue/util/freq-shift`: a Bode frequency shifter -- every partial moves by the same number of
 * Hz (SHIFT, +-2 kHz, through zero), so harmonic sounds turn inharmonic and metallic, unlike a
 * pitch shift. `shifted` is moved by SHIFT, `mirror` by -SHIFT (the other sideband: a stereo pair
 * spreading apart). A few Hz mixed with the dry input (MIX 50) is the classic barber-pole
 * phaser; FEEDBACK (+-90%) runs the shifted signal round again, so each pass moves it further (a
 * rising or falling cascade); a DC blocker on that path keeps an input's DC offset from building
 * up at SHIFT 0. The split into two 90-degree copies is `HILBERT_STEP_HELPER`,
 * shared with `logue/filter/hilbert`: good from ~25 Hz up, so the lowest bass leaks a little of
 * the wrong sideband. MIX 0 is exactly the dry input. Works in oscillators too (osc_sinf is the
 * carrier on both kinds of unit).
 */
export const freqShiftPrimitive: LoguePrimitive = {
  id: 'logue/util/freq-shift',
  outletPolarity: 'inherit',
  // hb_[21] + hbParity_ + phase_ + fbZ_ + fbDc_[2] + shiftPercent_ + feedbackPercent_ +
  // mixPercent_
  stateBytesPerInstance: HILBERT_STATE_FLOATS * 4 + 8 * 4,
  description:
    'A Bode frequency shifter: moves every partial by SHIFT Hz (up to 2 kHz either way), for metallic, inharmonic sounds. mirror shifts the other way. A few Hz at MIX 50 is a barber-pole phaser; FEEDBACK makes it cascade.',
  inlets: [
    { name: 'in', role: 'audio' },
    { name: 'shift', role: 'control' },
    { name: 'feedback', role: 'control' }
  ],
  outlets: [{ name: 'shifted' }, { name: 'mirror' }],
  memberDecls: (suffix) =>
    `  float hb_${suffix}[${HILBERT_STATE_FLOATS}];\n  int hbParity_${suffix};\n  float phase_${suffix};\n  float fbZ_${suffix};\n  float fbDc_${suffix}[2];\n  float shiftPercent_${suffix};\n  float feedbackPercent_${suffix};\n  float mixPercent_${suffix};\n`,
  initStatement: (suffix) =>
    `    for (int i = 0; i < ${HILBERT_STATE_FLOATS}; i++) hb_${suffix}[i] = 0.f;\n    hbParity_${suffix} = 0;\n    phase_${suffix} = 0.f;\n    fbZ_${suffix} = 0.f;\n    fbDc_${suffix}[0] = 0.f;\n    fbDc_${suffix}[1] = 0.f;\n`,
  blockConstants: (suffix, inlets) => blockDecls(freqShiftValues(suffix, inlets)),
  renderExpr: () => {
    throw new Error('logue/util/freq-shift is multi-outlet -- use renderOutletStatements')
  },
  renderOutletStatements: (suffix, inlets) => {
    const feedback =
      inlets.feedback !== undefined
        ? additiveInletExpr(
            'feedbackPercent',
            suffix,
            inlets.feedback,
            FREQ_SHIFT_FEEDBACK_INLET_DEPTH,
            -100,
            100
          )
        : `feedbackPercent_${suffix}`
    const { inc } = freqShiftValues(suffix, inlets)
    const shiftLocal =
      inlets.shift !== undefined && !isBlockInvariant(inlets.shift)
        ? `      const float sh_${suffix} = ${additiveInletExpr('shiftPercent', suffix, inlets.shift, FREQ_SHIFT_INLET_DEPTH, -100, 100)};\n`
        : ''
    return (
      shiftLocal +
      `      float y_${suffix}_mirror;\n` +
      `      float y_${suffix}_shifted = freq_shift_step(hb_${suffix}, &hbParity_${suffix}, &phase_${suffix}, &fbZ_${suffix}, fbDc_${suffix}, ${inlets.in ?? '0.f'}, ${inc.ref}, (${feedback}) * 0.009f, mixPercent_${suffix} * 0.01f, &y_${suffix}_mirror);\n` +
      `      (void)y_${suffix}_shifted; (void)y_${suffix}_mirror;\n`
    )
  },
  advanceStatement: () => '',
  helpers: [CLAMPF_HELPER, HILBERT_STEP_HELPER, FREQ_SHIFT_STEP_HELPER],
  params: [
    {
      name: 'SHIFT',
      unit: FREQ_SHIFT_HZ,
      modulatedBy: { inlet: 'shift', shape: 'additive' },
      min: -100,
      max: 100,
      default: 25,
      setStatement: (suffix, valueExpr) => `shiftPercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'FEEDBACK',
      unit: PERCENT,
      modulatedBy: { inlet: 'feedback', shape: 'additive' },
      min: -100,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `feedbackPercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'MIX',
      unit: PERCENT,
      min: 0,
      max: 100,
      default: 100,
      setStatement: (suffix, valueExpr) => `mixPercent_${suffix} = ${valueExpr};`
    }
  ]
}

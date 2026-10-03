import {
  BASS_GLIDE_MS,
  BASS_TONE_MULTIPLE,
  NEEDS_TRACK_ON_BY_DEFAULT_GATE,
  NOISE_COLOR_NAME,
  NOISE_COLOR_NAMES,
  LFSR_MODE_NAME,
  LFSR_MODE_NAMES,
  FAST_LFO_HZ,
  PITCH_TRACKED_ON_BY_DEFAULT_GATE,
  NOTE_NAME,
  PD_WAVE2_NAME,
  PD_WAVE2_NAMES,
  PD_WAVE_NAME,
  PD_WAVE_NAMES,
  PERCENT,
  RETRIG_WIDGET,
  REVERSE_WIDGET,
  SAMPLE_INTERP_NAME,
  SAMPLE_INTERP_NAMES,
  SAMPLE_LOOP_NAME,
  SAMPLE_LOOP_NAMES,
  SEMITONES,
  SYNC_SHAPE_NAME,
  SYNC_WIDGET,
  TRACK_WIDGET,
  TZFM_WIDGET,
  UNUSED_WHILE_SYNC_GATE
} from '../paramPresentation'
import { mulawDecode } from '../sample/mulaw'
import { MIN_LOOP_LENGTH, sampleBytes, sampleContentHash } from '../sample/importSample'
import { bytesToBase64 } from '../sample/base64'
import type { SampleAsset } from '../../../src/shared/domain/patch'
import type { HelperBlock, InstanceNodeData, LoguePrimitive } from './types'
import {
  blockDecls,
  blockValue,
  type BlockValue,
  CLAMPF_HELPER,
  COARSE_PARAM,
  CUTOFF_WARP_HELPER,
  ENV_RATE_HELPER,
  FAST_LFO_RATE_HELPER,
  FINE_PARAM,
  FM_DEPTH_INLET_DEPTH,
  FM_DEPTH_PARAM,
  HARMONIC_RATIO_HELPER,
  NOISE_STEP_HELPER,
  NOTE_W0_HELPER,
  ONEPOLE_HELPER,
  PM_WRAP_HELPER,
  POLYBLEP_SAW_HELPER,
  POLYBLEP_SQUARE_HELPER,
  RATE_INLET_DEPTH,
  TRACK_ON_RAW_THRESHOLD,
  WIDTH_INLET_DEPTH,
  additiveInletExpr,
  fmPhaseExpr,
  floatLit,
  hashSuffixToSeed,
  isBlockInvariant,
  transposedW0Expr
} from './shared'

/**
 * A plain, non-band-limited sine oscillator tracking `unit_render`'s per-block pitch --
 * deliberately the simplest possible primitive (no anti-aliasing) so phase 2's first slice
 * proved the pipeline shape, not DSP sophistication (that's what phase 1's hand-written PolyBLEP
 * oscillator already validated against the raw API). Now also carries `COARSE`/`FINE` tuning and
 * a `pitch` inlet, like every other oscillator in this registry.
 */
export const sineOscPrimitive: LoguePrimitive = {
  id: 'logue/osc/sine',
  outletPolarity: 'audio',
  stateBytesPerInstance: 16, // phase_ + coarse_ + fine_ + fmDepthPercent_, 4 floats
  description: "A pure sine oscillator, tracking the played note's pitch.",
  inlets: [
    { name: 'pitch', role: 'control' },
    { name: 'harmonic', role: 'control' },
    { name: 'fm', role: 'audio' },
    { name: 'fmDepth', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  float phase_${suffix};\n  float coarse_${suffix};\n  float fine_${suffix};\n  float fmDepthPercent_${suffix};\n`,
  initStatement: (suffix) => `    phase_${suffix} = 0.f;\n`,
  renderExpr: (suffix, inlets) => `osc_sinf(${fmPhaseExpr(suffix, inlets)})`,
  advanceStatement: (suffix, inlets) =>
    `      phase_${suffix} += ${transposedW0Expr(suffix, inlets)};\n      if (phase_${suffix} >= 1.f) phase_${suffix} -= 1.f;\n`,
  helpers: [NOTE_W0_HELPER, PM_WRAP_HELPER, CLAMPF_HELPER, HARMONIC_RATIO_HELPER],
  params: [COARSE_PARAM, FINE_PARAM, FM_DEPTH_PARAM]
}

/**
 * A full `+-1` swing from a wired `fm` inlet, in TZFM mode, maps to `+-4` MULTIPLES of `w0` --
 * "track w0" was the explicit, deliberate choice (not a fixed Hz/semitone range): every other
 * pitch-relative quantity in this file already scales with `w0` (`COARSE`/`FINE`/`pitch`'s own
 * semitone-domain depth, `harmonic`'s exact frequency ratio), so a TZFM depth that DIDN'T track
 * the played note would behave completely differently across the keyboard at the same dial
 * position. `4x` is chosen the same way `FM_DEPTH`'s own PM range was (phase 11's "well past what
 * most musical FM patches use" reasoning) -- comfortably past the `>1x` a signal needs to actually
 * reverse the increment's sign (the whole point of this mode), without inventing a separately-
 * derived number. Confirmed via the host-native harness (see `sawIncrementExpr`'s own doc
 * comment): a forward case (`fm=+1`) renders a clean ~5x-faster ascending ramp and a backward
 * case (`fm=-1`) a clean ~3x descending one, both matching this constant's own math exactly.
 */
const TZFM_DEPTH_PER_PERCENT = 0.04

/**
 * `logue/osc/saw`'s phase increment. With `fm` unwired or `TZFM` off it is exactly
 * `transposedW0Expr`, like every other oscillator. With `TZFM` on it MULTIPLIES that base by
 * `(1 + fm * depth)` (`depth` = `FM_DEPTH` percent * `TZFM_DEPTH_PER_PERCENT`, plus the additive
 * `fmDepth` inlet), so the deviation tracks the played note's `w0`. Adding `fm * depth` instead
 * doesn't track: near A4 `base` is ~0.02 against a depth of up to 4.0, so the fm term swamps
 * the pitch (the harness showed a "5x faster" case rendering slower than an unmodulated saw).
 *
 * Called from both `advanceStatement` (the accumulator) and `renderExpr` (as `polyblep_saw`'s
 * `dt`, so the antialiasing follows the same signed velocity). Under TZFM it reads `inlets.fm`,
 * an upstream `y_` value from the current sample; that ordering holds by construction, since
 * `oscBody.ts` runs every compute statement before any advance statement and a source is always
 * topologically earlier. History: docs/HISTORY.md.
 */
function sawIncrementExpr(suffix: string, inlets: Record<string, string | undefined>): string {
  const base = transposedW0Expr(suffix, inlets)
  if (inlets.fm === undefined) return base
  const depth =
    inlets.fmDepth !== undefined
      ? `${additiveInletExpr('fmDepthPercent', suffix, inlets.fmDepth, FM_DEPTH_INLET_DEPTH)} * ${TZFM_DEPTH_PER_PERCENT}f`
      : `fmDepthPercent_${suffix} * ${TZFM_DEPTH_PER_PERCENT}f`
  // The fm term MULTIPLIES base (w0), not adds to it -- "track w0" (the user's own explicit
  // choice) means the deviation scales with the played note's own frequency, not a fixed
  // absolute phase-per-sample offset. An earlier draft wrote `base + fm*depth` here, which is
  // NOT that: at audio-rate note pitches base is tiny (~0.02 near A4) next to a depth up to 4.0,
  // so that draft's fm term totally dominated and swamped the pitch term instead of scaling it --
  // caught by actually running the host-native harness (a "5x faster" forward case rendered
  // SLOWER than the plain unmodulated saw, and the backward case pinned near -1 for dozens of
  // samples instead of cleanly ramping), not by re-reading the formula.
  const tzfmTerm = `(${base}) * (1.f + (${inlets.fm}) * (${depth}))`
  return `(tzfm_${suffix} >= ${TRACK_ON_RAW_THRESHOLD}.f ? ${tzfmTerm} : (${base}))`
}

/**
 * A PolyBLEP-antialiased sawtooth -- same technique/formula phase 1 hardware-validated. `dt`
 * (the antialiasing correction width) is recomputed via `transposedW0Expr`/`sawIncrementExpr` --
 * the SAME transposed increment `advanceStatement` uses -- rather than the shared, untransposed
 * `w0_`, since a detuned/pitch-modulated saw's own correction needs to match its ACTUAL
 * per-sample phase step. Deliberately recomputed independently in both places (a second
 * `note_w0` call per sample) -- simpler than caching it in a shared member, no ordering
 * dependency between `renderExpr`/`advanceStatement` FOR THE PLAIN PITCH-TRACKING CASE; once
 * `TZFM` is engaged, `sawIncrementExpr` does carry a real (satisfied-by-construction) ordering
 * dependency on an upstream inlet -- see that function's own doc comment, and `fmPhaseExpr`'s for
 * why this is the one oscillator with through-zero FM at all.
 */
export const sawOscPrimitive: LoguePrimitive = {
  id: 'logue/osc/saw',
  outletPolarity: 'audio',
  stateBytesPerInstance: 20, // phase_ + coarse_ + fine_ + fmDepthPercent_ + tzfm_, 5 floats
  description: "A band-limited sawtooth oscillator, tracking the played note's pitch.",
  inlets: [
    { name: 'pitch', role: 'control' },
    { name: 'harmonic', role: 'control' },
    { name: 'fm', role: 'audio' },
    { name: 'fmDepth', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  float phase_${suffix};\n  float coarse_${suffix};\n  float fine_${suffix};\n  float fmDepthPercent_${suffix};\n  float tzfm_${suffix};\n`,
  initStatement: (suffix) => `    phase_${suffix} = 0.f;\n`,
  // TZFM off (default) or `fm` unwired: identical to every other oscillator, PM via fmPhaseExpr,
  // dt from the plain pitch-only transposedW0Expr (a heavily FM'd saw's correction stays
  // calibrated to the UNMODULATED phase step, a real, disclosed simplification, matching this
  // file's general "verify via harness, don't preemptively over-engineer" posture). TZFM on: the
  // gate gives fmPhaseExpr a bare, un-modulated phase_ read instead (fm's effect already lives in
  // sawIncrementExpr's own accumulator contribution, never applied twice), and dt tracks that same
  // signed instantaneous increment instead of the static one. `harmonic` (when wired) scales dt
  // right along with the accumulator either way, via the shared transposedW0Expr call inside
  // sawIncrementExpr.
  renderExpr: (suffix, inlets) =>
    `polyblep_saw(${fmPhaseExpr(suffix, inlets, `tzfm_${suffix} >= ${TRACK_ON_RAW_THRESHOLD}.f`)}, ${sawIncrementExpr(suffix, inlets)})`,
  // Bidirectional wrap (`while`, not a single `if`) -- required once sawIncrementExpr can go
  // negative under TZFM (and, at high TZFM_DEPTH_PER_PERCENT depths, overshoot by more than one
  // cycle in either direction, same reasoning pm_wrap's own doc comment already gives). Harmless
  // and behaviorally unchanged when it can't (TZFM off or fm unwired, where sawIncrementExpr
  // reduces to the always-nonnegative transposedW0Expr, same as every other oscillator's own
  // increment) -- the downward loop simply never iterates in that case.
  advanceStatement: (suffix, inlets) =>
    `      phase_${suffix} += ${sawIncrementExpr(suffix, inlets)};\n      while (phase_${suffix} >= 1.f) phase_${suffix} -= 1.f;\n      while (phase_${suffix} < 0.f) phase_${suffix} += 1.f;\n`,
  helpers: [
    POLYBLEP_SAW_HELPER,
    NOTE_W0_HELPER,
    PM_WRAP_HELPER,
    CLAMPF_HELPER,
    HARMONIC_RATIO_HELPER
  ],
  params: [
    COARSE_PARAM,
    FINE_PARAM,
    FM_DEPTH_PARAM,
    {
      name: 'TZFM',
      booleanWidget: TZFM_WIDGET,
      min: 0,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `tzfm_${suffix} = ${valueExpr};`
    }
  ]
}

/** A PolyBLEP-antialiased 50% duty square -- same technique/formula phase 1 hardware-validated, same transposed-`dt` reasoning as `saw` above. */
export const squareOscPrimitive: LoguePrimitive = {
  id: 'logue/osc/square',
  outletPolarity: 'audio',
  stateBytesPerInstance: 16, // phase_ + coarse_ + fine_ + fmDepthPercent_, 4 floats
  description: "A band-limited square wave oscillator, tracking the played note's pitch.",
  inlets: [
    { name: 'pitch', role: 'control' },
    { name: 'harmonic', role: 'control' },
    { name: 'fm', role: 'audio' },
    { name: 'fmDepth', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  float phase_${suffix};\n  float coarse_${suffix};\n  float fine_${suffix};\n  float fmDepthPercent_${suffix};\n`,
  initStatement: (suffix) => `    phase_${suffix} = 0.f;\n`,
  // Same disclosed dt-vs-FM'd-phase simplification as saw's own renderExpr -- see its comment.
  renderExpr: (suffix, inlets) =>
    `polyblep_square(${fmPhaseExpr(suffix, inlets)}, ${transposedW0Expr(suffix, inlets)})`,
  advanceStatement: (suffix, inlets) =>
    `      phase_${suffix} += ${transposedW0Expr(suffix, inlets)};\n      if (phase_${suffix} >= 1.f) phase_${suffix} -= 1.f;\n`,
  helpers: [
    POLYBLEP_SQUARE_HELPER,
    NOTE_W0_HELPER,
    PM_WRAP_HELPER,
    CLAMPF_HELPER,
    HARMONIC_RATIO_HELPER
  ],
  params: [COARSE_PARAM, FINE_PARAM, FM_DEPTH_PARAM]
}

const POLYBLEP_PULSE_HELPER: HelperBlock = {
  key: 'polyblep_pulse',
  dependsOn: ['polyblep'],
  code: `  static float polyblep_pulse(float phase, float duty, float dt)
  {
    float value = (phase < duty) ? 1.f : -1.f;
    value += polyblep(phase, dt);
    float falling_edge_phase = phase - duty;
    if (falling_edge_phase < 0.f) falling_edge_phase += 1.f;
    value -= polyblep(falling_edge_phase, dt);
    return value;
  }
`
}

/**
 * A PolyBLEP-antialiased variable-duty pulse -- generalizes \`polyblep_square\` (which is the
 * fixed duty=0.5 case) with a real, exposable WIDTH param, the first primitive in this
 * library with one. First real vehicle for \`logueParamIndex\` param exposure
 * -- deliberately a NEW primitive rather than retrofitting
 * \`squareOscPrimitive\`, so the already-\`websim\`-verified fixed square stays untouched.
 *
 * \`WIDTH\`'s own member (\`width_<suffix>\`) now stores the RAW percent (the \`* 0.01f\` conversion
 * moved to point-of-use in \`renderExpr\`) so a wired \`width\` inlet can add to it, in the SAME raw
 * percent units, before that conversion happens -- see \`CLAMPF_HELPER\`'s own doc comment.
 */
export const pulseOscPrimitive: LoguePrimitive = {
  id: 'logue/osc/pulse',
  outletPolarity: 'audio',
  stateBytesPerInstance: 20, // phase_ + width_ + coarse_ + fine_ + fmDepthPercent_, 5 floats
  description:
    "A band-limited pulse oscillator with an adjustable pulse width, tracking the played note's pitch.",
  inlets: [
    { name: 'pitch', role: 'control' },
    { name: 'harmonic', role: 'control' },
    { name: 'width', role: 'control' },
    { name: 'fm', role: 'audio' },
    { name: 'fmDepth', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  float phase_${suffix};\n  float width_${suffix};\n  float coarse_${suffix};\n  float fine_${suffix};\n  float fmDepthPercent_${suffix};\n`,
  initStatement: (suffix) => `    phase_${suffix} = 0.f;\n`,
  // Same disclosed dt-vs-FM'd-phase simplification as saw's own renderExpr -- see its comment.
  renderExpr: (suffix, inlets) => {
    const width =
      inlets.width !== undefined
        ? `${additiveInletExpr('width', suffix, inlets.width, WIDTH_INLET_DEPTH)} * 0.01f`
        : `width_${suffix} * 0.01f`
    return `polyblep_pulse(${fmPhaseExpr(suffix, inlets)}, ${width}, ${transposedW0Expr(suffix, inlets)})`
  },
  advanceStatement: (suffix, inlets) =>
    `      phase_${suffix} += ${transposedW0Expr(suffix, inlets)};\n      if (phase_${suffix} >= 1.f) phase_${suffix} -= 1.f;\n`,
  helpers: [
    POLYBLEP_PULSE_HELPER,
    NOTE_W0_HELPER,
    CLAMPF_HELPER,
    PM_WRAP_HELPER,
    HARMONIC_RATIO_HELPER
  ],
  params: [
    {
      name: 'WIDTH',
      unit: PERCENT,
      modulatedBy: { inlet: 'width', shape: 'additive' },
      nts1mkiiType: 'percent',
      // 0-100 (a plain percent), NOT the 0-1023 new-gen A/B-knob convention this originally
      // copied -- found via a REAL hardware failure (2026-09-16, Korg Librarian: "Could not
      // parse user unit manifest data" on minilogue xd, saw-with-zero-params worked fine).
      // Every real param row in the official minilogue xd `waves.json` example stays within
      // +/-100 (0-45, 0-100, 0-15) -- the earlier phase-0 research's "[-100,100]" constraint
      // claim was correct and should not have been under-weighted just because no NEGATIVE
      // example was seen. `value * 0.01f` is also plainly portable (no platform-specific knob
      // macro at all), unlike the old `param_10bit_to_f32` formula this replaced, which
      // additionally needed a same-formula-different-name platform shim
      // (`minilogue-xd/generateOscUnit.ts`'s now-removed `param_val_to_f32` alias) to even
      // compile on old-gen. One spec, one formula, no platform awareness needed at all.
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `width_${suffix} = ${valueExpr};`
    },
    COARSE_PARAM,
    FINE_PARAM,
    FM_DEPTH_PARAM
  ]
}

/**
 * A naive (non-BLEP-corrected) triangle -- deliberate, not an oversight: a triangle's
 * harmonics already fall off as 1/n^2 (vs 1/n for a naive saw/square), so the aliasing a BLEP
 * correction would remove is far less audible here. Standard practice in real hardware/
 * software synths to skip BLEP specifically for triangle; revisit only if a real generated
 * patch's high notes are audibly aliased.
 */
export const triangleOscPrimitive: LoguePrimitive = {
  id: 'logue/osc/triangle',
  outletPolarity: 'audio',
  stateBytesPerInstance: 16, // phase_ + coarse_ + fine_ + fmDepthPercent_, 4 floats
  description: "A triangle wave oscillator, tracking the played note's pitch.",
  inlets: [
    { name: 'pitch', role: 'control' },
    { name: 'harmonic', role: 'control' },
    { name: 'fm', role: 'audio' },
    { name: 'fmDepth', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  float phase_${suffix};\n  float coarse_${suffix};\n  float fine_${suffix};\n  float fmDepthPercent_${suffix};\n`,
  initStatement: (suffix) => `    phase_${suffix} = 0.f;\n`,
  renderExpr: (suffix, inlets) => `(4.f * fabsf(${fmPhaseExpr(suffix, inlets)} - 0.5f) - 1.f)`,
  advanceStatement: (suffix, inlets) =>
    `      phase_${suffix} += ${transposedW0Expr(suffix, inlets)};\n      if (phase_${suffix} >= 1.f) phase_${suffix} -= 1.f;\n`,
  helpers: [NOTE_W0_HELPER, PM_WRAP_HELPER, CLAMPF_HELPER, HARMONIC_RATIO_HELPER],
  params: [COARSE_PARAM, FINE_PARAM, FM_DEPTH_PARAM]
}

/**
 * `logue/osc/additive`. A single knob (`TIMBRE`) sweeps a
 * baked-at-codegen-time wavetable bank of DELIBERATELY VARIED additive "characters" -- not a
 * monotonic sine-to-saw brightness ramp (that first shape shipped, then was replaced same-day on
 * direct request: "a real fun shape modifier with unusual partial components... sound variety
 * only achievable through additive synthesis"). Each frame is its own hand-designed harmonic
 * recipe (`ADDITIVE_RECIPES` below) -- odd-only, a formant-like cluster bump, sparse harmonic
 * combs -- things a single analog/polyblep waveform can't produce at all, since those are only
 * ever built from a fixed, continuous spectrum shape. All harmonic summation happens ONCE, here
 * in TypeScript when this generator runs -- the same "expensive work happens offline, cheap
 * arithmetic ships on-device" split `logue/filter/formant`'s baked `kFormantNote` table already
 * established. The sizing/aliasing arithmetic this rests on is summarized inline below, at the
 * fields/helpers that actually implement it.
 */
const ADDITIVE_TABLE_SIZE = 512
const ADDITIVE_NUM_FRAMES = 6

/** One harmonic partial: `k` is the integer multiple of the fundamental (this is baked into a
 *  single-cycle table, so ONLY exact integer ratios are representable at all -- true inharmonic/
 *  bell-FM-style content isn't reachable this way; "metallic" below means a SPARSE integer-
 *  harmonic comb, a real and distinct additive-only texture, not literal inharmonicity). */
interface AdditiveHarmonic {
  k: number
  amp: number
}

/**
 * Six hand-designed stops, each demonstrating a different additive-only trick -- deliberately NOT
 * a single formula parameterized by frame index, unlike the original "more of the same" v1. Each
 * recipe's own OWN highest `k` (`additiveMaxHarmonic` below) must be non-decreasing across frame
 * index -- asserted at module load, not just hoped -- since the Nyquist aliasing clamp (see
 * `ADDITIVE_STEP_HELPER`) walks this sequence assuming later frames are never SAFER than earlier
 * ones, only possibly less safe. Frame 0 stays a pure sine deliberately (same reasoning as v1):
 * `TIMBRE=0` should still be the clean, predictable, always-available baseline.
 */
function additiveRecipeForFrame(frameIndex: number): AdditiveHarmonic[] {
  switch (frameIndex) {
    case 0:
      // Pure sine -- the clean baseline every TIMBRE=0 patch keeps, unchanged from v1.
      return [{ k: 1, amp: 1 }]
    case 1: {
      // Hollow / odd harmonics only (clarinet-like) -- a texture no simple saw/pulse dial-a-
      // waveform reaches, since those are built from ONE fixed spectrum shape, not an authored
      // harmonic subset.
      const recipe: AdditiveHarmonic[] = []
      for (let k = 1; k <= 23; k += 2) recipe.push({ k, amp: 1 / k })
      return recipe
    }
    case 2: {
      // Vocal/formant-like -- a soft general body plus a boosted CLUSTER of harmonics around
      // k=30 (a triangular window, not a hard cutoff), the classic "a vowel lives in a narrow
      // band of partials" additive trick. Fixed to a harmonic NUMBER, not a Hz-locked formant the
      // way logue/filter/formant tracks -- a color, not a literal vowel-formant implementation.
      const recipe: AdditiveHarmonic[] = []
      const center = 30
      const radius = 5
      for (let k = 1; k <= 36; k++) {
        let amp = 0.5 / k
        const dist = Math.abs(k - center)
        if (dist <= radius) amp += 1.1 * (1 - dist / (radius + 1))
        recipe.push({ k, amp })
      }
      return recipe
    }
    case 3: {
      // Sparse harmonic comb, "glassy" -- only every 4th harmonic present. A dense spectrum with
      // gaps punched in it sounds nothing like a quieter version of the same waveform; the GAPS
      // are the actual character here, not achievable by attenuating a continuous spectrum.
      const recipe: AdditiveHarmonic[] = []
      for (let k = 4; k <= 72; k += 4) recipe.push({ k, amp: 1 / Math.sqrt(k) })
      return recipe
    }
    case 4: {
      // Sparse harmonic comb, "metallic" -- wider gaps (every 7th) than frame 3, so the comb
      // itself reads as a different, more open/bell-like texture, not just "frame 3 but bigger
      // numbers." A little fundamental/2nd-harmonic energy is kept underneath so the note's own
      // pitch stays anchored/audible rather than reading as a pure overtone cluster.
      const recipe: AdditiveHarmonic[] = [
        { k: 1, amp: 0.6 },
        { k: 2, amp: 0.3 }
      ]
      for (let k = 7; k <= 112; k += 7) recipe.push({ k, amp: 1 / Math.sqrt(k / 7) })
      return recipe
    }
    case 5: {
      // Dense/bright -- the full classic stack, 1/k falloff, up to the registry's own 128-partial
      // ceiling. Kept as the top of the dial deliberately: the "unusual" textures live in the
      // MIDDLE of the sweep, but a familiar bright/buzzy extreme is still there at full CW.
      const recipe: AdditiveHarmonic[] = []
      for (let k = 1; k <= 128; k++) recipe.push({ k, amp: 1 / k })
      return recipe
    }
    default:
      throw new Error(`no additive recipe defined for frame ${frameIndex}`)
  }
}

function additiveMaxHarmonic(recipe: AdditiveHarmonic[]): number {
  return recipe.reduce((max, { k }) => Math.max(max, k), 1)
}

/** `TABLE_SIZE = 512` gives real margin (`N/2 = 256`) above the highest `k` any recipe above
 *  uses (128, frame 5) -- a smaller table would make that partial land at or past the table's own
 *  fold edge, degenerate at best (`sin(pi*i)` is identically zero at every sample). */
function additiveRawFrame(recipe: AdditiveHarmonic[]): number[] {
  const samples = new Array<number>(ADDITIVE_TABLE_SIZE).fill(0)
  for (const { k, amp } of recipe) {
    for (let i = 0; i < ADDITIVE_TABLE_SIZE; i++) {
      samples[i] += amp * Math.sin((2 * Math.PI * k * i) / ADDITIVE_TABLE_SIZE)
    }
  }
  return samples
}

/**
 * RMS-normalizes (not peak-normalizes) so wildly different recipes -- a single sine, a sparse
 * 16-partial comb, a dense 128-partial stack -- read at similar loudness; matching PEAKS alone
 * would still leave a dense frame noticeably louder, making `TIMBRE` a de-facto volume knob as a
 * side effect. The target RMS (`0.35`) is a v1 default, picked so even the lowest-crest-factor
 * frame stays comfortably under the peak-limit guard below; final loudness balance across these
 * six specific recipes is left to ear-tuning. The guard, not the target, is what actually
 * prevents clipping regardless of how the target is later tuned.
 */
const ADDITIVE_TARGET_RMS = 0.35
const ADDITIVE_PEAK_LIMIT = 0.999

function additiveNormalizeFrame(samples: number[]): number[] {
  const rms = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length)
  if (rms < 1e-9) return samples.slice()
  let scale = ADDITIVE_TARGET_RMS / rms
  let peak = 0
  for (const v of samples) {
    const scaled = Math.abs(v * scale)
    if (scaled > peak) peak = scaled
  }
  if (peak > ADDITIVE_PEAK_LIMIT) scale *= ADDITIVE_PEAK_LIMIT / peak
  return samples.map((v) => v * scale)
}

const ADDITIVE_RECIPES: AdditiveHarmonic[][] = Array.from({ length: ADDITIVE_NUM_FRAMES }, (_, f) =>
  additiveRecipeForFrame(f)
)
const ADDITIVE_FRAMES: number[][] = ADDITIVE_RECIPES.map((recipe) =>
  additiveNormalizeFrame(additiveRawFrame(recipe))
)
const ADDITIVE_FRAME_MAX_HARMONIC: number[] = ADDITIVE_RECIPES.map(additiveMaxHarmonic)

for (let i = 1; i < ADDITIVE_FRAME_MAX_HARMONIC.length; i++) {
  if (ADDITIVE_FRAME_MAX_HARMONIC[i] < ADDITIVE_FRAME_MAX_HARMONIC[i - 1]) {
    throw new Error(
      `additive frame ${i}'s own max harmonic (${ADDITIVE_FRAME_MAX_HARMONIC[i]}) is lower than ` +
        `frame ${i - 1}'s (${ADDITIVE_FRAME_MAX_HARMONIC[i - 1]}) -- the Nyquist clamp below ` +
        `assumes each frame is never SAFER than the one before it; fix the recipe ordering.`
    )
  }
}

function formatAdditiveFrameRow(row: number[]): string {
  return `{ ${row.map((v) => v.toFixed(6) + 'f').join(', ')} }`
}

/**
 * `TIMBRE`'s reachable range is clamped by the CURRENTLY PLAYED note's own Nyquist limit -- this
 * is mandatory, not an optional refinement: frame 5's own 128th partial is only alias-free below
 * roughly F#3, and growing the table doesn't fix that (it's a played-pitch problem, not a
 * table-resolution one). Reuses the
 * frame axis itself as a zero-extra-memory mip pyramid: `maxCleanPartials = 0.5f/w0` (a
 * rearranged `floor(24000/f0_hz)`) is looked up against each frame's own BAKED max harmonic
 * (`kAdditiveFrameMaxHarmonic`, not a closed-form formula -- these six recipes don't have one,
 * unlike v1's uniform "1..N" curve) via a small piecewise-linear search over the (at most 6)
 * segments, continuously interpolated within whichever segment `maxCleanPartials` falls in so
 * playing legato across a boundary glides the ceiling down instead of stepping. `0.5f / w0`
 * safely saturates to the registry's own top max-harmonic when `w0` is zero/near-zero (no note
 * yet) via the same "let IEEE754 infinity clamp itself" precedent `logue/filter/comb`'s own
 * `TRACK`-mode `1.f / w0` division already relies on -- no separate zero-guard needed.
 */
const ADDITIVE_STEP_HELPER: HelperBlock = {
  key: 'additive_step',
  // kAdditiveFrames[NUM_FRAMES][TABLE_SIZE] + kAdditiveFrameMaxHarmonic[NUM_FRAMES], both float --
  // derived from the SAME constants the tables below are actually built from (not a separately
  // hand-typed number that could drift if either constant changes).
  sharedBytes: ADDITIVE_NUM_FRAMES * ADDITIVE_TABLE_SIZE * 4 + ADDITIVE_NUM_FRAMES * 4,
  code: `  static float additive_step(float phase01, float w0, float timbre01)
  {
    static const float kAdditiveFrames[${ADDITIVE_NUM_FRAMES}][${ADDITIVE_TABLE_SIZE}] = {
      ${ADDITIVE_FRAMES.map(formatAdditiveFrameRow).join(',\n      ')}
    };
    static const float kAdditiveFrameMaxHarmonic[${ADDITIVE_NUM_FRAMES}] = {
      ${ADDITIVE_FRAME_MAX_HARMONIC.map((h) => h.toFixed(1) + 'f').join(', ')}
    };

    float maxCleanPartials = 0.5f / w0;
    if (maxCleanPartials < 1.f) maxCleanPartials = 1.f;
    else if (maxCleanPartials > ${ADDITIVE_FRAME_MAX_HARMONIC[ADDITIVE_NUM_FRAMES - 1].toFixed(1)}f) maxCleanPartials = ${ADDITIVE_FRAME_MAX_HARMONIC[ADDITIVE_NUM_FRAMES - 1].toFixed(1)}f;

    float maxFrameF = ${(ADDITIVE_NUM_FRAMES - 1).toFixed(1)}f;
    for (int i = 0; i < ${ADDITIVE_NUM_FRAMES - 1}; i++)
    {
      float loH = kAdditiveFrameMaxHarmonic[i];
      float hiH = kAdditiveFrameMaxHarmonic[i + 1];
      if (maxCleanPartials < hiH)
      {
        float span = hiH - loH;
        float frac = span > 0.f ? (maxCleanPartials - loH) / span : 0.f;
        if (frac < 0.f) frac = 0.f;
        maxFrameF = (float)i + frac;
        break;
      }
    }

    float t = timbre01;
    if (t < 0.f) t = 0.f; else if (t > 1.f) t = 1.f;
    float desiredFrameF = t * ${(ADDITIVE_NUM_FRAMES - 1).toFixed(1)}f;
    float frameF = desiredFrameF < maxFrameF ? desiredFrameF : maxFrameF;

    int frameLo = (int)frameF;
    if (frameLo < 0) frameLo = 0;
    int frameHi = frameLo + 1;
    if (frameHi > ${ADDITIVE_NUM_FRAMES - 1}) frameHi = ${ADDITIVE_NUM_FRAMES - 1};
    float frameBlend = frameF - (float)frameLo;

    float tableX = phase01 * ${ADDITIVE_TABLE_SIZE}.f;
    int i0 = (int)tableX;
    if (i0 < 0) i0 = 0; else if (i0 >= ${ADDITIVE_TABLE_SIZE}) i0 = ${ADDITIVE_TABLE_SIZE - 1};
    int i1 = i0 + 1;
    if (i1 >= ${ADDITIVE_TABLE_SIZE}) i1 = 0;
    float sampleBlend = tableX - (float)i0;

    float loA = kAdditiveFrames[frameLo][i0];
    float loB = kAdditiveFrames[frameLo][i1];
    float lo = loA + (loB - loA) * sampleBlend;
    float hiA = kAdditiveFrames[frameHi][i0];
    float hiB = kAdditiveFrames[frameHi][i1];
    float hi = hiA + (hiB - hiA) * sampleBlend;
    return lo + (hi - lo) * frameBlend;
  }
`
}

function additiveTimbreExpr(suffix: string, inlets: Record<string, string | undefined>): string {
  return inlets.timbre !== undefined
    ? `clampf(timbrePercent_${suffix} * 0.01f + (${inlets.timbre}), 0.f, 1.f)`
    : `(timbrePercent_${suffix} * 0.01f)`
}

export const additiveOscPrimitive: LoguePrimitive = {
  id: 'logue/osc/additive',
  outletPolarity: 'audio',
  stateBytesPerInstance: 16, // phase_ + coarse_ + fine_ + timbrePercent_, 4 floats
  description:
    "An additive oscillator: TIMBRE sweeps through a sine, a hollow odd-harmonic tone, a vocal-ish formant bump, and sparse metallic/glassy harmonic combs, automatically muting partials that would alias above the played note's own Nyquist limit.",
  inlets: [
    { name: 'pitch', role: 'control' },
    { name: 'harmonic', role: 'control' },
    { name: 'timbre', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  float phase_${suffix};\n  float coarse_${suffix};\n  float fine_${suffix};\n  float timbrePercent_${suffix};\n`,
  initStatement: (suffix) => `    phase_${suffix} = 0.f;\n`,
  renderExpr: (suffix, inlets) =>
    `additive_step(phase_${suffix}, ${transposedW0Expr(suffix, inlets)}, ${additiveTimbreExpr(suffix, inlets)})`,
  advanceStatement: (suffix, inlets) =>
    `      phase_${suffix} += ${transposedW0Expr(suffix, inlets)};\n      if (phase_${suffix} >= 1.f) phase_${suffix} -= 1.f;\n`,
  helpers: [ADDITIVE_STEP_HELPER, NOTE_W0_HELPER, CLAMPF_HELPER, HARMONIC_RATIO_HELPER],
  params: [
    COARSE_PARAM,
    FINE_PARAM,
    {
      name: 'TIMBRE',
      modulatedBy: { inlet: 'timbre', shape: 'additive' },
      min: 0,
      max: 100,
      default: 30,
      setStatement: (suffix, valueExpr) => `timbrePercent_${suffix} = ${valueExpr};`
    }
  ]
}

/**
 * COLOR's coloured noises come out at an RMS of 1/3 (white's, uniform, is 0.577): pink and
 * brown are near-Gaussian, and at white's RMS ~8% of their samples would sit past +-1. At 1/3
 * pink and brown pass 1 in under 0.2% of samples; there's no clamp (it cost ~8 xd cycles a
 * sample), and violet peaks at 0.82. Checked by `scripts/runNoiseHarness.ts`.
 */
const NOISE_COLOR_RMS = 1 / 3
/**
 * Pink is Voss-McCartney (Gardner's trailing-zero order): row k of NOISE_PINK_ROWS is redrawn
 * every 2^(k+1) samples, one row a sample, plus a fresh white term. Integer only -- Kellet's
 * economy filter (`PINK_NOISE_STEP_HELPER`) reloaded its seven coefficients every sample and
 * cost ~55 xd cycles. 12 rows reach down to ~6 Hz.
 */
const NOISE_PINK_ROWS = 12
/** Rows and the white term are int32 >> 5, so the sum of 13 can't overflow. */
const NOISE_PINK_SHIFT = 5
/** Each term is uniform over +-2^(31-shift): variance 2^(2(31-shift))/3, NOISE_PINK_ROWS + 1 terms. */
const NOISE_PINK_SCALE =
  NOISE_COLOR_RMS / (2 ** (31 - NOISE_PINK_SHIFT) * Math.sqrt((NOISE_PINK_ROWS + 1) / 3))
/** Brown's leak is `b >> 9`, i.e. 1 - 2^-9: a ~15 Hz corner, so the integrator can't wander
 *  off. Its input is the white int32 >> 9 too; RMS = 2^22 * sqrt(1/3) / sqrt(1 - leak^2). */
const NOISE_BROWN_SHIFT = 9
const NOISE_BROWN_LEAK = 1 - 2 ** -NOISE_BROWN_SHIFT
const NOISE_BROWN_SCALE =
  NOISE_COLOR_RMS /
  ((2 ** (31 - NOISE_BROWN_SHIFT) * Math.sqrt(1 / 3)) / Math.sqrt(1 - NOISE_BROWN_LEAK ** 2))
/** Violet is `(x >> 1) - (previous >> 1)`: RMS 2^30 * sqrt(2/3). */
const NOISE_VIOLET_SCALE = NOISE_COLOR_RMS / (2 ** 30 * Math.sqrt(2 / 3))

/**
 * Pink, brown (a leaky integrator, -6 dB/oct) and violet (a first difference, +6 dB/oct), on
 * the instance's own LCG, all in integers with one conversion to float at the end (float
 * coefficients were reloaded from the literal pool every sample). Brown and violet share `s`
 * (only one colour plays at a time; a switch clicks anyway). White never gets here (see
 * `noisePrimitive`).
 */
const NOISE_COLOR_STEP_HELPER: HelperBlock = {
  key: 'noise_color_step',
  code: `  static inline __attribute__((always_inline)) float noise_color_step(uint32_t *seed, int32_t *s, uint32_t *pinkCount, int32_t *pinkRows, int32_t *pinkSum, int32_t color)
  {
    if (color == 1)
    {
      uint32_t c = *pinkCount + 1u;
      *pinkCount = c;
      uint32_t k = (uint32_t)__builtin_ctz(c | (1u << ${NOISE_PINK_ROWS - 1}));
      uint32_t x = *seed * 1664525u + 1013904223u;
      int32_t row = (int32_t)x >> ${NOISE_PINK_SHIFT};
      x = x * 1664525u + 1013904223u;
      *seed = x;
      int32_t sum = *pinkSum - pinkRows[k] + row;
      pinkRows[k] = row;
      *pinkSum = sum;
      return (float)(sum + ((int32_t)x >> ${NOISE_PINK_SHIFT})) * ${NOISE_PINK_SCALE.toExponential(7)}f;
    }
    uint32_t x = *seed * 1664525u + 1013904223u;
    *seed = x;
    int32_t prev = *s;
    if (color == 2)
    {
      int32_t b = prev - (prev >> ${NOISE_BROWN_SHIFT}) + ((int32_t)x >> ${NOISE_BROWN_SHIFT});
      *s = b;
      return (float)b * ${NOISE_BROWN_SCALE.toExponential(7)}f;
    }
    *s = (int32_t)x;
    return (float)(((int32_t)x >> 1) - (prev >> 1)) * ${NOISE_VIOLET_SCALE.toExponential(7)}f;
  }
`
}

export const noisePrimitive: LoguePrimitive = {
  id: 'logue/osc/noise',
  outletPolarity: 'audio',
  // seed_, noiseColor_, noiseState_, pinkCount_, pinkSum_, pinkRows_[NOISE_PINK_ROWS]
  stateBytesPerInstance: 4 * (5 + NOISE_PINK_ROWS),
  description:
    'A noise source, independent of the played note. COLOR: White (flat), Pink (-3 dB/oct, softer), Brown (-6 dB/oct, a rumble) or Violet (+6 dB/oct, a bright hiss). The coloured ones are about 5 dB quieter than White, so their peaks stay near +-1.',
  searchTerms: ['white', 'pink', 'brown', 'red', 'violet', 'purple', 'hiss'],
  memberDecls: (suffix) =>
    `  uint32_t seed_${suffix};\n  int32_t noiseColor_${suffix};\n  int32_t noiseState_${suffix};\n` +
    `  uint32_t pinkCount_${suffix};\n  int32_t pinkSum_${suffix};\n  int32_t pinkRows_${suffix}[${NOISE_PINK_ROWS}];\n`,
  initStatement: (suffix) =>
    `    seed_${suffix} = ${hashSuffixToSeed(suffix)}u;\n` +
    `    noiseState_${suffix} = 0;\n    pinkCount_${suffix} = 0u;\n    pinkSum_${suffix} = 0;\n` +
    `    for (int k = 0; k < ${NOISE_PINK_ROWS}; ++k) pinkRows_${suffix}[k] = 0;\n`,
  renderExpr: (suffix) =>
    `(noiseColor_${suffix} == 0 ? noise_step(&seed_${suffix}) : noise_color_step(&seed_${suffix}, &noiseState_${suffix}, &pinkCount_${suffix}, pinkRows_${suffix}, &pinkSum_${suffix}, noiseColor_${suffix}))`,
  advanceStatement: () => '',
  helpers: [NOISE_STEP_HELPER, NOISE_COLOR_STEP_HELPER],
  params: [
    {
      name: 'COLOR',
      unit: NOISE_COLOR_NAME,
      select: { count: 4, scale: 1, label: 'Color', names: NOISE_COLOR_NAMES },
      min: 0,
      max: 3,
      default: 0,
      step: 1,
      // An int, so the per-sample colour test is an integer compare, not a float one plus vmrs.
      setStatement: (suffix, valueExpr) =>
        `noiseColor_${suffix} = (int32_t)((${valueExpr}) + 0.5f);`
    }
  ]
}

/**
 * The Game Boy's 7-bit noise mode: its 15-bit register with each feedback bit also written into
 * bit 6, which leaves a 127-step loop -- a pitched, metallic buzz. Built at generation time and
 * read as a table (`lfsr_step`), so the loop can play any note: stepping the register at 127x the
 * note would need several steps per sample above ~380 Hz.
 */
export function lfsrShortSequence(): number[] {
  let r = 0x7fff
  const step = (): number => {
    const fb = (r ^ (r >> 1)) & 1
    r = (r >> 1) | (fb << 14)
    r = (r & ~0x40) | (fb << 6)
    return r & 1
  }
  for (let i = 0; i < 256; i++) step() // into the loop: the start state isn't on it
  return Array.from({ length: LFSR_SHORT_STEPS }, step)
}
export const LFSR_SHORT_STEPS = 127
/** Steps per sample at most, so Short's one `if` wrap holds (B6 tracked is ~5). */
const LFSR_MAX_STEPS = 64

/** Fraction bits of the step accumulator: 127 << 24 plus a 64-step increment still fits 32 bits,
 *  and even RATE's 0.1 Hz (2.6e-4 steps a sample) keeps its pitch to 0.02%. */
const LFSR_FRAC_BITS = 24

const LFSR_STEP_HELPER: HelperBlock = {
  key: 'lfsr_step',
  sharedBytes: LFSR_SHORT_STEPS,
  code: `  static inline __attribute__((always_inline)) float lfsr_step(uint32_t *reg, uint32_t *pos, float inc, int32_t mode)
  {
    static const int8_t kShort[${LFSR_SHORT_STEPS}] = {${lfsrShortSequence()
      .map((b) => (b ? '1' : '-1'))
      .join(',')}};
    // Integer 8.${LFSR_FRAC_BITS} steps (inc is pre-scaled): no float compare (and vmrs) a sample.
    uint32_t p = *pos + (uint32_t)inc;
    if (mode != 0)
    {
      if (p >= (${LFSR_SHORT_STEPS}u << ${LFSR_FRAC_BITS})) p -= (${LFSR_SHORT_STEPS}u << ${LFSR_FRAC_BITS});
      *pos = p;
      return (float)kShort[p >> ${LFSR_FRAC_BITS}];
    }
    uint32_t r = *reg;
    if (p >= (1u << ${LFSR_FRAC_BITS}))
    {
      // At most one step a sample: a faster clock only decimates what is already white.
      p &= (1u << ${LFSR_FRAC_BITS}) - 1u;
      r = (r >> 1) | (((r ^ (r >> 1)) & 1u) << 14);
      *reg = r;
    }
    *pos = p;
    return (r & 1u) ? 1.f : -1.f;
  }
`
}

/**
 * `logue/osc/lfsr`: the NES/Game Boy noise channel. A shift register stepped by a clock of 127x
 * the pitch (the note with TRACK, else RATE): Long is the 15-bit, 32767-step register (grainy
 * hiss whose colour follows the pitch; once the clock passes the sample rate, plain 1-bit white),
 * Short the 127-step loop (`lfsrShortSequence`), which sounds at the pitch itself. Both share the
 * clock, so switching MODE keeps the brightness, as on the hardware. Naive +-1 output, aliasing
 * included: that is the sound.
 */
export const lfsrPrimitive: LoguePrimitive = {
  id: 'logue/osc/lfsr',
  outletPolarity: 'audio',
  stateBytesPerInstance: 28, // reg, pos, mode, ratePercent, coarse, fine, track: 7 words
  description:
    'NES/Game Boy-style 1-bit noise from a shift register. Long: hiss that gets brighter with the pitch. Short: a 127-step loop, a pitched metallic buzz. TRACK plays the note; off, RATE sets the pitch.',
  searchTerms: ['noise', 'nes', 'gameboy', 'chiptune', '8bit', 'digital', 'metallic'],
  inlets: [
    { name: 'rate', trackGate: PITCH_TRACKED_ON_BY_DEFAULT_GATE, role: 'control' },
    { name: 'pitch', trackGate: NEEDS_TRACK_ON_BY_DEFAULT_GATE, role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  uint32_t lfsrReg_${suffix};\n` +
    `  uint32_t lfsrPos_${suffix};\n` +
    `  int32_t lfsrMode_${suffix};\n` +
    `  float ratePercent_${suffix};\n` +
    `  float coarse_${suffix};\n` +
    `  float fine_${suffix};\n` +
    `  float track_${suffix};\n`,
  initStatement: (suffix) => {
    const reg = hashSuffixToSeed(suffix) & 0x7fff || 1
    return `    lfsrReg_${suffix} = ${reg}u;\n    lfsrPos_${suffix} = 0u;\n`
  },
  blockConstants: (suffix, inlets) => blockDecls({ steps: lfsrSteps(suffix, inlets) }),
  renderExpr: (suffix, inlets) =>
    `lfsr_step(&lfsrReg_${suffix}, &lfsrPos_${suffix}, ${lfsrSteps(suffix, inlets).ref}, lfsrMode_${suffix})`,
  advanceStatement: () => '',
  helpers: [LFSR_STEP_HELPER, FAST_LFO_RATE_HELPER, NOTE_W0_HELPER, CLAMPF_HELPER],
  params: [
    {
      name: 'MODE',
      unit: LFSR_MODE_NAME,
      select: { count: 2, scale: 1, label: 'Mode', names: LFSR_MODE_NAMES },
      min: 0,
      max: 1,
      default: 0,
      step: 1,
      setStatement: (suffix, valueExpr) => `lfsrMode_${suffix} = (int32_t)((${valueExpr}) + 0.5f);`
    },
    {
      name: 'RATE',
      unit: FAST_LFO_HZ,
      modulatedBy: {
        inlet: 'rate',
        shape: 'additive',
        note: 'only applies in free-running mode (TRACK off)'
      },
      trackGate: PITCH_TRACKED_ON_BY_DEFAULT_GATE,
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `ratePercent_${suffix} = ${valueExpr};`
    },
    { ...COARSE_PARAM, trackGate: NEEDS_TRACK_ON_BY_DEFAULT_GATE },
    { ...FINE_PARAM, trackGate: NEEDS_TRACK_ON_BY_DEFAULT_GATE },
    {
      name: 'TRACK',
      booleanWidget: TRACK_WIDGET,
      min: 0,
      max: 100,
      default: 100,
      setStatement: (suffix, valueExpr) => `track_${suffix} = ${valueExpr};`
    }
  ]
}

/** Register steps per sample (127x the pitch's cycles per sample) in `lfsr_step`'s 8.24 fixed
 *  point, per block unless an input moves. */
function lfsrSteps(suffix: string, inlets: Record<string, string | undefined>): BlockValue {
  const rate =
    inlets.rate !== undefined
      ? additiveInletExpr('ratePercent', suffix, inlets.rate, RATE_INLET_DEPTH)
      : `ratePercent_${suffix}`
  const cyclesPerSample = `(track_${suffix} >= ${TRACK_ON_RAW_THRESHOLD}.f ? ${transposedW0Expr(suffix, inlets)} : fast_lfo_rate_from_percent(${rate}))`
  return blockValue(
    'blkLfsrSteps',
    suffix,
    `clampf(${cyclesPerSample} * ${LFSR_SHORT_STEPS * 2 ** LFSR_FRAC_BITS}.f, 0.f, ${LFSR_MAX_STEPS * 2 ** LFSR_FRAC_BITS}.f)`,
    [inlets.rate, inlets.pitch]
  )
}

/**
 * `logue/osc/granular`: a baked 8-bit mu-law sample (`ObjNode.sample`, imported by
 * `sample/importSample.ts`) read by a fixed pool of overlapping windowed grains, placed at
 * POSITION with random SMEAR around it. `SYNC` picks how the played note is followed:
 *  - on (default): one grain per note period at the stored rate -- pitch from the grain rate,
 *    timbre from POSITION, fixed formants. At minimum SIZE and no SMEAR it is a wavetable
 *    scanned by POSITION.
 *  - off: classic granular -- grains on their own clock (SIZE in ms, DENSITY as overlap), each
 *    transposed by `note / ROOT`.
 *
 * Every helper is `always_inline` so nothing below `process()` makes a real call: the first
 * version's two-deep `granular_step -> mulaw_decode/grain_sin_pi` calls hung a real minilogue xd,
 * the same `-Os` call shape as the formant crash (`FORMANT_BP_STEP_HELPER`), while an ASan/UBSan
 * fuzz found no bad reads or math. The pool is recycled round-robin and grain length is capped
 * at `GRANULAR_GRAINS` spawn intervals, so a sounding grain is never stolen (a click). Reads are
 * linear-interpolated; the import's resampler is the only anti-aliasing (disclosed lo-fi).
 * History: docs/HISTORY.md.
 */
const GRANULAR_GRAINS = 4
/** Upper bound on per-output-sample read speed (stored samples): past this is pure aliasing, and
 *  it keeps the read position's single conditional wrap valid for any sample of 64+ samples. */
const GRANULAR_MAX_SPEED = 16
const GRANULAR_MIN_SAMPLES = 64
/** Shortest Tukey taper at WINDOW=0 -- a hard rectangle would click at every grain edge. */
const GRANULAR_MIN_TAPER = 0.05
const GRANULAR_SIZE_MIN_MS = 5
const GRANULAR_SIZE_MAX_MS = 250
const GRANULAR_SYNC_MAX_PERIODS = GRANULAR_GRAINS
/** SYNC off: DENSITY's top overlap, one grain short of the pool. A 4th overlapping grain cost
 *  ~70 of the ~560 cycles a voice took at DENSITY 100, and a real xd overloaded with chords
 *  there. Hann windows at an integer overlap still sum flat. Measured on a strings sample with
 *  SMEAR 50-70, spawn-rate ripple rose a little (SIZE 50: 2.2x -> 3.7x the modulation-spectrum
 *  median; SIZE 100: 15x -> 25x). */
const GRANULAR_MAX_OVERLAP = GRANULAR_GRAINS - 1
/** Mean of `sin^(2n)(pi x)` over one window for n = 1..4 (`C(2n,n)/4^n`) -- the overlap-add gain
 *  normalization for WINDOW's Hann-and-narrower half. */
const GRANULAR_HANN_POWER_AREAS = [0.5, 0.375, 0.3125, 0.2734375]
/** Samples between recomputes of the grain setup (speed, spawn rate, window shape) -- two
 *  `note_w0` lookups and three divides per sample were ~180 of the ~800 cycles a voice cost
 *  with SYNC off, enough to overload a real xd playing chords at DENSITY 100. A wired `pitch`
 *  is therefore only read at this rate (no audio-rate FM into a granular). */
const GRANULAR_CONTROL_PERIOD = 16
/** `ctl_` slots: speed, spawnRate, inc, gain, halfTaper, invTaper, power. */
const GRANULAR_CONTROL_FLOATS = 7

/** Every mu-law code decoded once at codegen time (`sample/mulaw.ts`'s `mulawDecode`), so the
 *  grain loop's two reads per grain per sample are one load each -- the bit-twiddling decode was
 *  ~10 integer ops apiece, on a CPU (the xd's 84 MHz Cortex-M4) running this once per voice. */
const MULAW_TABLE_HELPER: HelperBlock = {
  key: 'mulaw_table',
  sharedBytes: 256 * 4,
  code: `  static inline __attribute__((always_inline)) const float *mulaw_table()
  {
    static const float kMulaw[256] = {
      ${Array.from({ length: 256 }, (_, i) => mulawDecode(i).toPrecision(9) + 'f')
        .reduce<string[]>((rows, v, i) => {
          if (i % 8 === 0) rows.push(v)
          else rows[rows.length - 1] += ', ' + v
          return rows
        }, [])
        .join(',\n      ')}
    };
    return kMulaw;
  }
`
}

/**
 * The WINDOW morph, libm-free: 0..50 is a Tukey window whose cosine tapers widen from
 * `GRANULAR_MIN_TAPER` to a full Hann, 50..100 raises that Hann to powers 1..4 (narrower, more
 * "pointillist" grains). `sin(pi t)` is a divide-free quadratic in `t(1-t)`, exact at the ends
 * and the middle and with the right slope at 0 (error < 0.6%), squared -- it's evaluated once per
 * grain per sample per voice, so a rational form's divide was the costliest thing in the loop.
 */
const GRAIN_WINDOW_HELPER: HelperBlock = {
  key: 'grain_window',
  code: `  static inline __attribute__((always_inline)) float grain_sin_pi(float t)
  {
    float p = t * (1.f - t);
    return p * (3.14159265f + 3.43362939f * p);
  }

  static inline __attribute__((always_inline)) float grain_window(float x, float halfTaper, float invTaper, float power)
  {
    if (halfTaper < 0.5f)
    {
      float s;
      if (x < halfTaper) s = grain_sin_pi(x * invTaper);
      else if (x > 1.f - halfTaper) s = grain_sin_pi((1.f - x) * invTaper);
      else return 1.f;
      return s * s;
    }
    float s = grain_sin_pi(x);
    float h = s * s;
    // Straight-line powers instead of a loop: branch-light, and this runs per grain per sample.
    float h2 = h * h;
    if (power < 1.f) return h + (h2 - h) * power;
    float h3 = h2 * h;
    if (power < 2.f) return h2 + (h3 - h2) * (power - 1.f);
    return h3 + (h2 * h2 - h3) * (power - 2.f);
  }
`
}

const GRANULAR_STEP_HELPER: HelperBlock = {
  key: 'granular_step',
  // kHannPowerArea[4], float
  sharedBytes: 4 * GRANULAR_HANN_POWER_AREAS.length,
  code: `  static inline __attribute__((always_inline)) float granular_step(float *gPos, float *gPh, float *gInc,
      float *gGain, float *ctl, uint32_t *ctlCount, uint32_t *next, float *spawnPh, uint32_t *seed,
      const uint8_t *smp, int32_t len, float rateRatio,
      float w0, float rootW0, bool sync,
      float pos01, float smear01, float size01, float density01,
      float window01)
  {
    float lenF = (float)len;
    // Control rate: w0/rootW0/size01/density01/window01 are only meaningful (the call site
    // only evaluates them) when *ctlCount is 0.
    if (*ctlCount == 0u)
    {
      *ctlCount = ${GRANULAR_CONTROL_PERIOD - 1}u;
      // spawnRate is grains started per sample (a phase increment), overlap how many sound at
      // once; a grain's length is overlap / spawnRate.
      float speed, spawnRate, overlap;
      if (sync)
      {
        speed = rateRatio;
        spawnRate = w0;
        overlap = 1.f + ${GRANULAR_SYNC_MAX_PERIODS - 1}.f * size01;
      }
      else
      {
        speed = rateRatio * (w0 / rootW0);
        overlap = 0.5f + ${GRANULAR_MAX_OVERLAP - 0.5}f * density01;
        float grainLen = (${GRANULAR_SIZE_MIN_MS}.f + ${GRANULAR_SIZE_MAX_MS - GRANULAR_SIZE_MIN_MS}.f * size01 * size01) * 48.f;
        spawnRate = overlap / grainLen;
      }
      if (speed > ${GRANULAR_MAX_SPEED}.f) speed = ${GRANULAR_MAX_SPEED}.f;
      // Below the pool size, so a still-sounding grain is never recycled mid-window (a click).
      if (overlap > ${GRANULAR_GRAINS - 0.01}f) overlap = ${GRANULAR_GRAINS - 0.01}f;
      if (spawnRate > 1.f) spawnRate = 1.f;

      float taper, power, area;
      if (window01 < 0.5f)
      {
        taper = ${GRANULAR_MIN_TAPER}f + ${1 - GRANULAR_MIN_TAPER}f * (window01 * 2.f);
        power = 0.f;
        area = 1.f - 0.5f * taper;
      }
      else
      {
        static const float kHannPowerArea[4] = { ${GRANULAR_HANN_POWER_AREAS.map((a) => a + 'f').join(', ')} };
        taper = 1.f;
        power = (window01 - 0.5f) * 6.f;
        int k = (int)power;
        if (k > 2) k = 2;
        area = kHannPowerArea[k] + (kHannPowerArea[k + 1] - kHannPowerArea[k]) * (power - (float)k);
      }
      float inc = spawnRate / overlap;
      if (inc > 1.f) inc = 1.f;
      // Overlapping windows sum to (overlap * window area) on average -- normalized back to
      // unity per grain at its start (never boosting a sparse cloud's gaps).
      float density = overlap * area;
      ctl[0] = speed;
      ctl[1] = spawnRate;
      ctl[2] = inc;
      ctl[3] = density > 1.f ? 1.f / density : 1.f;
      ctl[4] = 0.5f * taper;
      ctl[5] = 1.f / taper;
      ctl[6] = power;
    }
    else
    {
      --*ctlCount;
    }
    float speed = ctl[0], spawnRate = ctl[1], inc = ctl[2];
    float halfTaper = ctl[4], invTaper = ctl[5], power = ctl[6];

    *spawnPh += spawnRate;
    if (*spawnPh >= 1.f)
    {
      *spawnPh -= 1.f;
      if (*spawnPh >= 1.f) *spawnPh = 0.f;
      // How far past the ideal start this sample already is -- carried into the new grain so
      // SYNC's grain rate (the pitch) stays sub-sample accurate instead of quantized.
      float late = *spawnPh / spawnRate;
      uint32_t g = *next;
      *next = (g + 1u) % ${GRANULAR_GRAINS}u;
      float span = speed / inc;
      // Cubed: even a few samples of offset decorrelates overlapping grains audibly, so the
      // bottom of the dial has to stay within a few samples, not a fixed fraction of the sample.
      float smear = smear01 * smear01 * smear01;
      float start = pos01 * lenF - 0.5f * span + noise_step(seed) * smear * 0.5f * lenF;
      if (span < lenF)
      {
        if (start < 0.f) start = 0.f;
        else if (start > lenF - span) start = lenF - span;
      }
      start += late * speed;
      start -= lenF * (float)(int32_t)(start / lenF);
      if (start < 0.f) start += lenF;
      gInc[g] = inc;
      gGain[g] = ctl[3];
      gPh[g] = late * inc;
      gPos[g] = start;
    }

    const float *mulaw = mulaw_table();
    float out = 0.f;
    for (int g = 0; g < ${GRANULAR_GRAINS}; g++)
    {
      float ph = gPh[g];
      if (ph >= 1.f) continue;
      float pos = gPos[g];
      int32_t i0 = (int32_t)pos;
      if (i0 >= len) i0 = len - 1;
      int32_t i1 = i0 + 1;
      if (i1 >= len) i1 = 0;
      float a = mulaw[smp[i0]];
      float b = mulaw[smp[i1]];
      out += (a + (b - a) * (pos - (float)i0)) * (gGain[g] * grain_window(ph, halfTaper, invTaper, power));
      // The CURRENT speed, not the one the grain started with: otherwise a new note's first
      // ~grain length still carried the previous note's pitch from grains already sounding.
      pos += speed;
      if (pos >= lenF) pos -= lenF;
      gPos[g] = pos;
      gPh[g] = ph + gInc[g];
    }

    return out;
  }
`
}

function granularSampleOf(node: InstanceNodeData | undefined): {
  hash: string
  bytes: Uint8Array
  rate: number
} {
  const sample = node?.sample
  if (!sample) throw new Error(`granular node "${node?.name ?? '?'}" has no sample loaded`)
  return { hash: sampleContentHash(sample), bytes: sampleBytes(sample), rate: sample.rate }
}

function granularSampleHelper(hash: string, bytes: Uint8Array): HelperBlock {
  const rows: string[] = []
  for (let i = 0; i < bytes.length; i += 24) {
    rows.push(Array.from(bytes.subarray(i, i + 24)).join(','))
  }
  return {
    key: `granular_sample_${hash}`,
    sharedBytes: bytes.length,
    code: `  static const uint8_t *granular_sample_${hash}()
  {
    static const uint8_t kGranularSample_${hash}[${bytes.length}] = {
      ${rows.join(',\n      ')}
    };
    return kGranularSample_${hash};
  }
`
  }
}

const GRANULAR_PERCENT_INLET_DEPTH = 50

/** A 0-100 param as 0..1, with its same-named inlet (if wired) added on at +-50, then clamped --
 *  the registry's usual additive-inlet shape, shared by every granular percent param. */
function granularPercentExpr(
  suffix: string,
  inlets: Record<string, string | undefined>,
  name: string
): string {
  const wired = inlets[name]
  return wired !== undefined
    ? `(${additiveInletExpr(name, suffix, wired, GRANULAR_PERCENT_INLET_DEPTH)} * 0.01f)`
    : `(${name}_${suffix} * 0.01f)`
}

export const granularOscPrimitive: LoguePrimitive = {
  id: 'logue/osc/granular',
  outletPolarity: 'audio',
  sampleImport: 'granular',
  // gPos_/gPh_/gInc_/gGain_ (4 x float[4]) + ctl_ (float[7]) + ctlCount_/next_/spawn_/seed_
  // + smp_ (pointer, 4 bytes on the ARM target)/smpLen_/rateRatio_ + 9 param floats
  stateBytesPerInstance:
    4 * 4 * GRANULAR_GRAINS + 4 * GRANULAR_CONTROL_FLOATS + 4 * 4 + 3 * 4 + 9 * 4,
  description:
    'A granular sample oscillator: overlapping grains read an imported sample at POSITION, scattered by SMEAR. With SYNC on, grains repeat once per note period, so the sample becomes a scannable wavetable whose pitch follows the keyboard. With SYNC off, the grains are transposed from ROOT to the played note.',
  inlets: [
    { name: 'pitch', role: 'control' },
    { name: 'position', role: 'control' },
    { name: 'smear', role: 'control' },
    { name: 'size', role: 'control' },
    { name: 'density', trackGate: UNUSED_WHILE_SYNC_GATE, role: 'control' },
    { name: 'window', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  float gPos_${suffix}[${GRANULAR_GRAINS}];\n` +
    `  float gPh_${suffix}[${GRANULAR_GRAINS}];\n  float gInc_${suffix}[${GRANULAR_GRAINS}];\n` +
    `  float gGain_${suffix}[${GRANULAR_GRAINS}];\n` +
    `  float ctl_${suffix}[${GRANULAR_CONTROL_FLOATS}];\n  uint32_t ctlCount_${suffix};\n` +
    `  uint32_t next_${suffix};\n  float spawn_${suffix};\n  uint32_t seed_${suffix};\n` +
    `  const uint8_t *smp_${suffix};\n  int32_t smpLen_${suffix};\n  float rateRatio_${suffix};\n` +
    `  float coarse_${suffix};\n  float fine_${suffix};\n  float position_${suffix};\n` +
    `  float smear_${suffix};\n  float size_${suffix};\n  float density_${suffix};\n` +
    `  float window_${suffix};\n  float sync_${suffix};\n  float root_${suffix};\n`,
  initStatement: (suffix, node) => {
    const { hash, bytes, rate } = granularSampleOf(node)
    return (
      `    for (int g = 0; g < ${GRANULAR_GRAINS}; g++) { gPos_${suffix}[g] = 0.f; gPh_${suffix}[g] = 1.f; gInc_${suffix}[g] = 0.f; gGain_${suffix}[g] = 0.f; }\n` +
      `    for (int c = 0; c < ${GRANULAR_CONTROL_FLOATS}; c++) ctl_${suffix}[c] = 0.f;\n    ctlCount_${suffix} = 0u;\n` +
      `    next_${suffix} = 0u;\n    spawn_${suffix} = 1.f;\n    seed_${suffix} = ${hashSuffixToSeed(suffix)}u;\n` +
      `    smp_${suffix} = granular_sample_${hash}();\n    smpLen_${suffix} = ${bytes.length};\n` +
      `    rateRatio_${suffix} = ${rate}.f / 48000.f;\n`
    )
  },
  instanceHelpers: (node) => {
    const { hash, bytes } = granularSampleOf(node)
    return [granularSampleHelper(hash, bytes)]
  },
  instanceProblem: (node) => {
    if (!node.sample) return 'No sample loaded -- use "Load WAV…" in the Inspector.'
    // Replace with keeps a node's sample, so a `logue/osc/sample`'s linear one can land here.
    if (node.sample.encoding !== 'mulaw8') {
      return 'This sample is stored as linear 8-bit -- re-import it for granular ("Load WAV…").'
    }
    if (sampleBytes(node.sample).length < GRANULAR_MIN_SAMPLES) {
      return `Sample is shorter than ${GRANULAR_MIN_SAMPLES} samples.`
    }
    return undefined
  },
  renderExpr: (suffix, inlets) => {
    // Setup-only arguments are evaluated only on a control-rate tick -- see GRANULAR_CONTROL_PERIOD.
    const onTick = (expr: string): string => `(ctlCount_${suffix} == 0u ? ${expr} : 0.f)`
    const percent = (name: string): string => granularPercentExpr(suffix, inlets, name)
    return (
      `granular_step(gPos_${suffix}, gPh_${suffix}, gInc_${suffix}, gGain_${suffix}, ` +
      `ctl_${suffix}, &ctlCount_${suffix}, ` +
      `&next_${suffix}, &spawn_${suffix}, &seed_${suffix}, smp_${suffix}, smpLen_${suffix}, rateRatio_${suffix}, ` +
      `${onTick(transposedW0Expr(suffix, inlets))}, ` +
      `${onTick(`(sync_${suffix} >= ${TRACK_ON_RAW_THRESHOLD}.f ? 1.f : note_w0(root_${suffix}))`)}, ` +
      `sync_${suffix} >= ${TRACK_ON_RAW_THRESHOLD}.f, ` +
      [
        percent('position'),
        percent('smear'),
        ...['size', 'density', 'window'].map((n) => onTick(percent(n)))
      ].join(', ') +
      ')'
    )
  },
  advanceStatement: () => '',
  // A full spawn phase: the next sample starts a grain, so every note onset lines up -- and a
  // control tick first, so that grain already uses the new note.
  noteOnStatement: (suffix) => `    spawn_${suffix} = 1.f;\n    ctlCount_${suffix} = 0u;\n`,
  helpers: [
    GRANULAR_STEP_HELPER,
    GRAIN_WINDOW_HELPER,
    MULAW_TABLE_HELPER,
    NOISE_STEP_HELPER,
    NOTE_W0_HELPER,
    CLAMPF_HELPER
  ],
  params: [
    COARSE_PARAM,
    FINE_PARAM,
    {
      name: 'POSITION',
      unit: PERCENT,
      modulatedBy: { inlet: 'position', shape: 'additive' },
      nts1mkiiType: 'percent',
      min: 0,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `position_${suffix} = ${valueExpr};`
    },
    {
      name: 'SMEAR',
      unit: PERCENT,
      modulatedBy: { inlet: 'smear', shape: 'additive' },
      nts1mkiiType: 'percent',
      min: 0,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `smear_${suffix} = ${valueExpr};`
    },
    {
      // SYNC: 1..4 note periods. Default 33 lands on 2 periods, where two Hann grains overlap-add
      // to a flat sum -- the smoothest wavetable-like setting.
      name: 'SIZE',
      modulatedBy: { inlet: 'size', shape: 'additive' },
      min: 0,
      max: 100,
      default: 33,
      setStatement: (suffix, valueExpr) => `size_${suffix} = ${valueExpr};`
    },
    {
      name: 'DENSITY',
      modulatedBy: { inlet: 'density', shape: 'additive', note: 'only applies with SYNC off' },
      trackGate: UNUSED_WHILE_SYNC_GATE,
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `density_${suffix} = ${valueExpr};`
    },
    {
      name: 'WINDOW',
      modulatedBy: { inlet: 'window', shape: 'additive' },
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `window_${suffix} = ${valueExpr};`
    },
    {
      // Same 0/100 on-off convention (and threshold) as comb/svf's TRACK, so it gets the same
      // checkbox and NTS-1 mkII `onoff` device type.
      name: 'SYNC',
      booleanWidget: SYNC_WIDGET,
      min: 0,
      max: 100,
      default: 100,
      setStatement: (suffix, valueExpr) => `sync_${suffix} = ${valueExpr};`
    },
    {
      // Only used with SYNC off. Set from the importer's pitch detection, else middle C.
      name: 'ROOT',
      unit: NOTE_NAME,
      trackGate: UNUSED_WHILE_SYNC_GATE,
      min: 0,
      max: 127,
      default: 60,
      step: 1,
      setStatement: (suffix, valueExpr) => `root_${suffix} = ${valueExpr};`
    }
  ]
}

/**
 * `logue/osc/sample`: a plain sample player (docs/PLAN-sample.md) -- the imported sample played
 * as recorded, pitched by the note against ROOT, one-shot or looped, from START. The sample is
 * normally linear 8-bit at its own rate (`importPlainSample`); a mu-law one (a granular node
 * replaced by this) is converted to linear 8-bit here, at generation time -- one step function
 * and no branch per read, for a fallback the Inspector offers to re-import properly.
 *
 * The read position is 16.16 fixed point, so playing ROOT from a 48 kHz sample steps exactly one
 * stored sample per output sample, and a loop never drifts. The speed is capped at
 * `SAMPLE_MAX_SPEED`, which with `MIN_LOOP_LENGTH` keeps the loop's single conditional wrap valid.
 * A restart (note-on, a rising `trig`) is only flagged; the step latches START on the next
 * sample, which is how a wired `start` (unreachable from `noteOnStatement`) still counts.
 * No anti-aliasing: transposing up aliases, like the 8-bit samplers this is for.
 */
const SAMPLE_MAX_SPEED = 16
/** The longest sample the 16.16 position can address with room for one capped step past it. */
const SAMPLE_MAX_LENGTH = 65536 - SAMPLE_MAX_SPEED - 1
/** Samples between recomputes of a wired `pitch`'s speed (granular's control period, for the
 *  same reason: two `note_w0` lookups and a divide per sample per voice). */
const SAMPLE_CONTROL_PERIOD = 16
const SAMPLE_START_INLET_DEPTH = 50

/** LOOP's values, as the step reads them. */
const SAMPLE_LOOP_OFF = 0
const SAMPLE_LOOP_FORWARD = 1
const SAMPLE_LOOP_PINGPONG = 2

/**
 * One output sample. `*back` is the direction (REVERSE starts backwards; ping-pong flips it at
 * each loop end). Backwards with LOOP Forward runs the loop region backwards, so REVERSE is the
 * sample mirrored, START measured from the end. A finished one-shot parks the position past the
 * sample (`0xffffffff` backwards), where it reads silence. Interpolation reads the next sample up
 * in either direction; across a Forward loop's seam that's `loopStart`, and ping-pong turns on the
 * last sample, so it never reads past a loop end.
 */
const SAMPLE_STEP_HELPER: HelperBlock = {
  key: 'sample_step',
  code: `  static inline __attribute__((always_inline)) float sample_step(uint32_t *pos, uint32_t *back,
      uint32_t *restart, float *prevTrig, float trig, const int8_t *smp, uint32_t len,
      uint32_t loopStart, uint32_t loopEnd, uint32_t loopMode, bool reverse, bool interp,
      float speed, float start01)
  {
    if (trig >= 0.5f && *prevTrig < 0.5f) *restart = 1u;
    *prevTrig = trig;
    if (*restart != 0u)
    {
      *restart = 0u;
      *back = reverse ? 1u : 0u;
      if (reverse)
      {
        uint32_t first = loopMode != ${SAMPLE_LOOP_OFF}u ? loopStart : 0u;
        *pos = (len - 1u - (uint32_t)(start01 * (float)(len - 1u - first))) << 16;
      }
      else
      {
        uint32_t end = loopMode != ${SAMPLE_LOOP_OFF}u ? loopEnd : len;
        *pos = (uint32_t)(start01 * (float)(end - 1u)) << 16;
      }
    }
    uint32_t i = *pos >> 16;
    // Forwards past a loop's end (LOOP switched on after it, or a finished one-shot): into the loop.
    if (loopMode != ${SAMPLE_LOOP_OFF}u && *back == 0u && i >= loopEnd)
    {
      i = loopStart;
      *pos = loopStart << 16;
    }
    if (i >= len) return 0.f;
    float out = (float)smp[i] * (1.f / 128.f);
    if (interp)
    {
      uint32_t j = i + 1u;
      if (loopMode == ${SAMPLE_LOOP_FORWARD}u && j == loopEnd) j = loopStart;
      float b = j < len ? (float)smp[j] * (1.f / 128.f) : 0.f;
      out += (b - out) * ((float)(*pos & 0xffffu) * (1.f / 65536.f));
    }
    uint32_t step = (uint32_t)(speed * 65536.f);
    uint32_t lo = loopStart << 16;
    uint32_t span = (loopEnd - loopStart) << 16;
    if (*back == 0u)
    {
      uint32_t next = *pos + step;
      uint32_t last = (loopEnd - 1u) << 16;
      if (loopMode == ${SAMPLE_LOOP_FORWARD}u && next >= lo + span) next -= span;
      else if (loopMode == ${SAMPLE_LOOP_PINGPONG}u && next > last) { next = last - (next - last); *back = 1u; }
      *pos = next;
    }
    else if (loopMode == ${SAMPLE_LOOP_OFF}u)
    {
      *pos = *pos >= step ? *pos - step : 0xffffffffu;
    }
    else if (*pos < lo + step)
    {
      // Below the loop start this sample: wrap round (Forward) or bounce (ping-pong).
      uint32_t below = lo + step - *pos;
      if (below > span) below = 0u;
      if (loopMode == ${SAMPLE_LOOP_FORWARD}u) *pos = lo + span - below;
      else { *pos = lo + below; *back = 0u; }
    }
    else
    {
      *pos -= step;
    }
    return out;
  }
`
}

const SAMPLE_SPEED_HELPER: HelperBlock = {
  key: 'sample_speed',
  code: `  static inline __attribute__((always_inline)) float sample_speed(float rateRatio, float w0, float rootW0)
  {
    float speed = rateRatio * (w0 / rootW0);
    return speed > ${SAMPLE_MAX_SPEED}.f ? ${SAMPLE_MAX_SPEED}.f : speed;
  }

  static inline __attribute__((always_inline)) float sample_speed_ctl(uint32_t *ctlCount, float *speed, float fresh)
  {
    // fresh is only evaluated (by the call site) when *ctlCount is 0.
    if (*ctlCount == 0u)
    {
      *ctlCount = ${SAMPLE_CONTROL_PERIOD - 1}u;
      *speed = fresh;
    }
    else
    {
      *ctlCount -= 1u;
    }
    return *speed;
  }
`
}

function pcm8SampleHelper(hash: string, bytes: Uint8Array): HelperBlock {
  const rows: string[] = []
  for (let i = 0; i < bytes.length; i += 24) {
    rows.push(Array.from(bytes.subarray(i, i + 24), (b) => (b >= 128 ? b - 256 : b)).join(','))
  }
  return {
    key: `sample_pcm8_${hash}`,
    sharedBytes: bytes.length,
    code: `  static const int8_t *sample_pcm8_${hash}()
  {
    static const int8_t kSamplePcm8_${hash}[${bytes.length}] = {
      ${rows.join(',\n      ')}
    };
    return kSamplePcm8_${hash};
  }
`
  }
}

function plainSampleOf(node: InstanceNodeData | undefined): SampleAsset {
  const sample = node?.sample
  if (!sample) throw new Error(`sample node "${node?.name ?? '?'}" has no sample loaded`)
  return sample
}

/** The node's sample as linear signed 8-bit bytes (two's complement in a Uint8Array). */
function pcm8BytesOf(sample: SampleAsset): Uint8Array {
  const bytes = sampleBytes(sample)
  if (sample.encoding === 'pcm8') return bytes
  return bytes.map((b) => Math.max(-128, Math.min(127, Math.round(mulawDecode(b) * 128))) & 0xff)
}

function sampleTableHelper(sample: SampleAsset): HelperBlock {
  const bytes = pcm8BytesOf(sample)
  return pcm8SampleHelper(
    sampleContentHash({ ...sample, encoding: 'pcm8', data: bytesToBase64(bytes) }),
    bytes
  )
}

function sampleValues(
  suffix: string,
  inlets: Record<string, string | undefined>
): { speed: BlockValue; start: BlockValue } {
  const pitchTerm = inlets.pitch !== undefined ? ` + (${inlets.pitch}) * ${COARSE_PARAM.max}.f` : ''
  // TRACK off plays every key as ROOT; COARSE/FINE/pitch still transpose.
  const played = `(track_${suffix} >= ${TRACK_ON_RAW_THRESHOLD}.f ? note_ + noteFine_ * (1.f/255.f) : root_${suffix})`
  const speedExpr = `sample_speed(rateRatio_${suffix}, note_w0(${played} + coarse_${suffix} + fine_${suffix}${pitchTerm}), note_w0(root_${suffix}))`
  const speed = blockValue('blkSpeed', suffix, speedExpr, [inlets.pitch])
  const startExpr =
    inlets.start !== undefined
      ? `(${additiveInletExpr('start', suffix, inlets.start, SAMPLE_START_INLET_DEPTH)} * 0.01f)`
      : `(start_${suffix} * 0.01f)`
  const start = blockValue('blkStart', suffix, startExpr, [inlets.start])
  return {
    speed: speed.decl
      ? speed
      : {
          ref: `sample_speed_ctl(&ctlCount_${suffix}, &speed_${suffix}, (ctlCount_${suffix} == 0u ? ${speedExpr} : 0.f))`
        },
    // A moving start is only worked out when a restart will read it.
    start: start.decl ? start : { ref: `(restart_${suffix} != 0u ? ${startExpr} : 0.f)` }
  }
}

export const samplePrimitive: LoguePrimitive = {
  id: 'logue/osc/sample',
  outletPolarity: 'audio',
  sampleImport: 'plain',
  modules: ['osc'],
  searchTerms: ['wav', 'sampler', 'rompler', 'fairlight', 'player'],
  // pos_ back_ restart_ prevTrig_ ctlCount_ speed_ smp_ (4-byte pointer on the ARM target) len_
  // loopStart_ loopEnd_ rateRatio_ + 8 param floats
  stateBytesPerInstance: 11 * 4 + 8 * 4,
  description:
    'Plays an imported sample as recorded: the played note against ROOT sets the speed, LOOP repeats the stored loop (or the whole sample) forward or back and forth, START sets where each note begins. REVERSE plays it backwards from the end (START counts from the end), looping the loop backwards. INTERP None reads without interpolation, for raw 8-bit grit. Every note and every rising trig restarts it.',
  inlets: [
    { name: 'pitch', role: 'control' },
    { name: 'start', role: 'control' },
    { name: 'trig', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  uint32_t pos_${suffix};\n  uint32_t back_${suffix};\n  uint32_t restart_${suffix};\n  float prevTrig_${suffix};\n` +
    `  uint32_t ctlCount_${suffix};\n  float speed_${suffix};\n` +
    `  const int8_t *smp_${suffix};\n  uint32_t len_${suffix};\n` +
    `  uint32_t loopStart_${suffix};\n  uint32_t loopEnd_${suffix};\n  float rateRatio_${suffix};\n` +
    `  float coarse_${suffix};\n  float fine_${suffix};\n  float root_${suffix};\n` +
    `  float start_${suffix};\n  float loop_${suffix};\n  float reverse_${suffix};\n  float track_${suffix};\n  float interp_${suffix};\n`,
  initStatement: (suffix, node) => {
    const sample = plainSampleOf(node)
    const length = sampleBytes(sample).length
    const table = sampleTableHelper(sample).key
    return (
      `    pos_${suffix} = 0u;\n    back_${suffix} = 0u;\n    restart_${suffix} = 1u;\n    prevTrig_${suffix} = 0.f;\n` +
      `    ctlCount_${suffix} = 0u;\n    speed_${suffix} = 0.f;\n` +
      `    smp_${suffix} = ${table}();\n    len_${suffix} = ${length}u;\n` +
      `    loopStart_${suffix} = ${sample.loopStart ?? 0}u;\n    loopEnd_${suffix} = ${sample.loopEnd ?? length}u;\n` +
      `    rateRatio_${suffix} = ${floatLit(sample.rate)} / 48000.f;\n`
    )
  },
  instanceHelpers: (node) => [sampleTableHelper(plainSampleOf(node))],
  instanceProblem: (node) => {
    const sample = node.sample
    if (!sample) return 'No sample loaded -- use "Load WAV…" in the Inspector.'
    const length = sampleBytes(sample).length
    if (length < 2) return 'Sample is shorter than 2 samples.'
    if (length > SAMPLE_MAX_LENGTH) return `Sample is longer than ${SAMPLE_MAX_LENGTH} samples.`
    if (sample.loopStart !== undefined && sample.loopEnd !== undefined) {
      if (sample.loopEnd - sample.loopStart < MIN_LOOP_LENGTH) {
        return `Loop is shorter than ${MIN_LOOP_LENGTH} samples.`
      }
    }
    return undefined
  },
  blockConstants: (suffix, inlets) => blockDecls(sampleValues(suffix, inlets)),
  renderExpr: (suffix, inlets) => {
    const v = sampleValues(suffix, inlets)
    return (
      `sample_step(&pos_${suffix}, &back_${suffix}, &restart_${suffix}, &prevTrig_${suffix}, ${inlets.trig ?? '0.f'}, ` +
      `smp_${suffix}, len_${suffix}, loopStart_${suffix}, loopEnd_${suffix}, (uint32_t)(loop_${suffix} + 0.5f), ` +
      `reverse_${suffix} >= ${TRACK_ON_RAW_THRESHOLD}.f, interp_${suffix} < 0.5f, ${v.speed.ref}, ${v.start.ref})`
    )
  },
  advanceStatement: () => '',
  noteOnStatement: (suffix) => `    restart_${suffix} = 1u;\n`,
  helpers: [NOTE_W0_HELPER, CLAMPF_HELPER, SAMPLE_SPEED_HELPER, SAMPLE_STEP_HELPER],
  params: [
    COARSE_PARAM,
    FINE_PARAM,
    {
      // Set from the file's smpl chunk at import, else from pitch detection, else middle C.
      name: 'ROOT',
      unit: NOTE_NAME,
      trackGate: NEEDS_TRACK_ON_BY_DEFAULT_GATE,
      min: 0,
      max: 127,
      default: 60,
      step: 1,
      setStatement: (suffix, valueExpr) => `root_${suffix} = ${valueExpr};`
    },
    {
      // Of the loop end with LOOP on (so a start inside the loop region stays in it), else of
      // the whole sample; with REVERSE, the same counted from the end.
      name: 'START',
      unit: PERCENT,
      nts1mkiiType: 'percent',
      modulatedBy: {
        inlet: 'start',
        shape: 'additive',
        note: 'read when a note or trig restarts it'
      },
      min: 0,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `start_${suffix} = ${valueExpr};`
    },
    {
      name: 'LOOP',
      unit: SAMPLE_LOOP_NAME,
      select: { count: 3, scale: 1, label: 'Loop', names: SAMPLE_LOOP_NAMES },
      min: 0,
      max: 2,
      default: 0,
      step: 1,
      setStatement: (suffix, valueExpr) => `loop_${suffix} = ${valueExpr};`
    },
    {
      name: 'REVERSE',
      booleanWidget: REVERSE_WIDGET,
      min: 0,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `reverse_${suffix} = ${valueExpr};`
    },
    {
      name: 'TRACK',
      booleanWidget: TRACK_WIDGET,
      min: 0,
      max: 100,
      default: 100,
      setStatement: (suffix, valueExpr) => `track_${suffix} = ${valueExpr};`
    },
    {
      name: 'INTERP',
      unit: SAMPLE_INTERP_NAME,
      select: { count: 2, scale: 1, label: 'Interp', names: SAMPLE_INTERP_NAMES },
      min: 0,
      max: 1,
      default: 0,
      step: 1,
      setStatement: (suffix, valueExpr) => `interp_${suffix} = ${valueExpr};`
    }
  ]
}

// Fast, register-independent pluck decay at BOW=0. cutoff_warp(1.f-s) hits its own zero
// endpoint EXACTLY at s=1 (BOW=100), so this rate reaches literal 0 there -- not an
// approximation of "very long", a genuinely lossless hold for as long as the note stays down,
// same "curve hits its endpoint exactly" precedent svf's RESONANCE=100->k=0 and string's
// DECAY=100->decayGain_=1 already use.
const EXCITER_HELD_DECAY_MS_MIN = 8.0
const EXCITER_HELD_DECAY_RATE_MAX = 1.0 / (EXCITER_HELD_DECAY_MS_MIN * 0.001 * 48000)
// A fixed, register-independent brightness for the pluck end of BOW -- deliberately NOT
// note-tracked itself (see aBowTracked below for why the BOW end needs to be).
const EXCITER_PLUCK_A = 0.85
// How many harmonics' worth of bandwidth above the fundamental the bow end's tracked cutoff
// reaches, and the floor under it so a low note never gets choked to a single, silent-sounding
// harmonic. Real, disclosed ear-tune starting points -- unlike this file's other warp curves, no
// real hardware/harness pass has confirmed these yet (see pluckExciterPrimitive's own doc
// comment).
const EXCITER_TRACKED_HARMONICS = 8.0
const EXCITER_TRACKED_MIN_A = 0.15
// Real, user-reported miss (2026-09-25): the first version's attack RATE scaled with BOW from
// the very first strike (`env_rate_from_percent(bowPercent)`), so even a moderate BOW already
// gave a slow, mushy onset -- "the 'bowing' attack starts too soon", i.e. well before BOW gets
// anywhere near its own top end. Fixed by decoupling the FIRST/every strike's own attack rate
// from BOW entirely -- it's now always `env_rate_from_percent(0.f)`, the same crisp ~5ms onset
// BOW=0's own click always had. All of the "softening" now happens through the strike-train
// mechanism below (quieter AND warmer per strike), not through a slow initial ramp.
//
// The user's own description: "the short burst is fine... it needs more softer strikes, that
// sound more like nylon guitar strings" -- a real, physical distinction (a harpsichord's quill
// pluck is one hard, bright transient; a classical guitar's attack is often a quick FLURRY of
// softer, rounder re-catches, not one smooth swell). `strikesRemaining_`/`strikeGain_` implement
// that literally: reaching level<=0 in the hold stage, instead of always going idle, retriggers
// stage 1 at a REDUCED peak (`strikeGain_ *= EXCITER_STRIKE_GAIN_RATIO` each time) for as long as
// `strikesRemaining_` is still positive and the note is still held -- a real, decaying train of
// re-excitations, not a single ramp. `strikesRemaining_` is derived from BOW alone (computed once
// per real note-on, `pluckedStringPrimitive`'s own `decayGain_` precedent for "can't see a wired
// inlet from noteOnStatement, so this uses the PARAM value only" -- a live-wired `bow` sweep
// still steers everything else per-sample, just not this one note's own strike count) so BOW=0
// still gets exactly zero extra strikes -- the existing, liked harpsichord click is untouched.
const EXCITER_STRIKE_MAX_COUNT = 5
// Each successive strike peaks at this fraction of the previous one -- a real, disclosed
// ear-tune starting point (a plausible decaying-flurry ratio), not measured.
const EXCITER_STRIKE_GAIN_RATIO = 0.55

// Real, user-reported miss (2026-09-26): "with higher bow the exciter signal gets too much
// overall gain and the resonated sound gets really more distorted." Checked numerically, not
// assumed (a real simulation of the exact LCG + this filter, 5,000,000 samples): the RAW Paul
// Kellet economy filter's own output runs ~3x the RMS of the white sample that feeds it (its
// low-frequency stages, b0 especially, are near-unity-feedback leaky integrators with real DC
// gain around 40x) and its PEAK excursions reach ~7.7x white noise's own bounded ~[-1,1) range --
// blending more of that in as `warmth` rises (i.e. exactly "higher BOW") is a real, measured
// gain increase, not a subjective impression. `PINK_NOISE_GAIN_COMPENSATION` (0.3374, the
// measured `rms(white)/rms(pink)` ratio from that same simulation) brings pink's RMS back in
// line with white's -- confirmed afterward: 0.5775 vs 0.5772 at full pink, matched. Peak
// excursions still occasionally exceed unity even after RMS-matching (pink noise built this way
// has a wider crest factor than white's own tightly bounded distribution, a real, disclosed
// property of the technique, not a residual bug) -- `pluck_exciter_step`'s own final
// `clampf(..., -2.f, 2.f)` on the blended sample (see its own doc comment) is a measured, rare
// safety net for that (0.033% of samples at worst-case full warmth in the same simulation), not
// the primary fix.
const PINK_NOISE_GAIN_COMPENSATION = 0.3374

// The output is scaled by `1 - warmth*DROP`, where warmth = max(BOW, 1-strikeGain): a pure pluck
// (BOW 0, first strike) is untouched, and higher BOW or later strikes come in quieter. A continuous feed into a near-lossless resonator builds up without
// bound, while a pluck's energy is self-limiting, so the bow must feed far less per sample. 0.9
// (0.1x at full BOW, about -20 dB) since 2026-09-28: at 0.65 a bow at BOW 100 fed a comb or string
// at ~-16 dBFS RMS continuously and drove it far past full scale on both devices. Ear-tuned, not
// derived: the right level depends on the downstream resonator's FEEDBACK/DECAY. History:
// docs/HISTORY.md.
const EXCITER_SUSTAIN_LEVEL_DROP = 0.9

/**
 * Paul Kellet's "economy" pink noise filter -- a well-known, cheap, no-libm recursive
 * approximation (3 leaky-integrator stages summed at fixed weights) of a 1/f (pink) spectrum,
 * widely used in exactly this "flat white noise reads as synthetic/hissy, real excitation noise
 * is naturally darker" role. Takes an ALREADY-generated white sample (`noise_step`'s own output)
 * rather than its own seed/LCG -- one shared white source feeds both a plain white reading and a
 * pink-shaped one, no second independent generator needed. `PINK_NOISE_GAIN_COMPENSATION` scales
 * the raw filter output down to the SAME real-measured RMS as the white input (see its own doc
 * comment for the real gain-increase bug this fixes) -- a real, necessary normalization, not
 * optional polish; the raw filter's own output is NOT naturally the same loudness as its input.
 * Always advanced every sample (called unconditionally from `pluck_exciter_step`, not gated
 * behind how much `warmth` currently wants) so the filter's own state stays continuously settled
 * -- gating it would mean it has to "catch up" with an audible transient exactly when `warmth`
 * first starts rising, the same reason `logue/filter/lowpass-cheap`'s own `onepole_step` is
 * always called rather than bypassed.
 */
const PINK_NOISE_STEP_HELPER: HelperBlock = {
  key: 'pink_noise_step',
  code: `  static float pink_noise_step(float *b0, float *b1, float *b2, float white)
  {
    *b0 = 0.99765f * (*b0) + white * 0.0990460f;
    *b1 = 0.96300f * (*b1) + white * 0.2965164f;
    *b2 = 0.57000f * (*b2) + white * 1.0526913f;
    return (*b0 + *b1 + *b2 + white * 0.1848f) * ${PINK_NOISE_GAIN_COMPENSATION}f;
  }
`
}

/**
 * The whole noise -> filter -> envelope chain of `logue/osc/exciter` in one helper, since every
 * stage reads the same `bowPercent` and note.
 *
 * - Envelope: `ahd_env_step`'s 4 stages (idle/attack/hold/release), but the hold stage also
 *   decays by `heldDecayRate` -- large at BOW=0 (a pluck that ends while the key is held), exactly
 *   0 at BOW=100 (a lossless hold until note-off). Reaching 0 in hold re-strikes while
 *   `strikesRemaining_` lasts, each strike `strikeGain_` smaller (see
 *   `EXCITER_STRIKE_MAX_COUNT`). Attack is always the fast `env_rate_from_percent(0)`; release
 *   follows BOW.
 * - Tone: a linear blend from a fixed bright `aPluck` to a note-tracked `aBowTracked`
 *   (`2*k*w0`, floored), by `warmth = max(BOW, 1-strikeGain)` -- later strikes are always
 *   warmer, and the first strike stays exactly as bright as at BOW=0.
 * - Noise: white blends toward RMS-matched pink noise by the same `warmth` (real excitation
 *   noise leans low); the result is clamped to +-2 for pink's wider crest factor.
 * - Level: the output is scaled by `1 - warmth*0.9` (`EXCITER_SUSTAIN_LEVEL_DROP`), because a
 *   held bow feeds a resonant loop continuously and overdrove it.
 *
 * The three rounds of user feedback behind this: docs/HISTORY.md.
 */
const PLUCK_EXCITER_STEP_HELPER: HelperBlock = {
  key: 'pluck_exciter_step',
  code: `  static float pluck_exciter_step(uint32_t *seed, float *z1, int *stage, float *level,
    int *strikesRemaining, float *strikeGain, float *pinkB0, float *pinkB1, float *pinkB2,
    float bowPercent, float note)
  {
    float s = bowPercent * 0.01f;

    float attackRate    = env_rate_from_percent(0.f);
    float heldDecayRate = ${EXCITER_HELD_DECAY_RATE_MAX.toFixed(6)}f * cutoff_warp(1.f - s);
    float releaseRate   = env_rate_from_percent(bowPercent);

    if (*stage == 1)
    {
      *level += attackRate;
      if (*level >= *strikeGain) { *level = *strikeGain; *stage = 2; }
    }
    else if (*stage == 2)
    {
      *level -= heldDecayRate;
      if (*level <= 0.f)
      {
        if (*strikesRemaining > 0)
        {
          *strikesRemaining -= 1;
          *strikeGain *= ${EXCITER_STRIKE_GAIN_RATIO}f;
          *level = 0.f;
          *stage = 1;
        }
        else
        {
          *level = 0.f;
          *stage = 0;
        }
      }
    }
    else if (*stage == 3)
    {
      *level -= releaseRate;
      if (*level <= 0.f) { *level = 0.f; *stage = 0; }
    }

    float w0 = note_w0(note);
    float aPluck      = ${EXCITER_PLUCK_A}f;
    float aBowTracked = clampf(2.f * ${EXCITER_TRACKED_HARMONICS.toFixed(1)}f * w0, ${EXCITER_TRACKED_MIN_A}f, 1.f);
    float warmth = 1.f - *strikeGain;
    if (warmth < s) warmth = s;
    float a = aPluck + warmth * (aBowTracked - aPluck);

    float white = noise_step(seed);
    float pink = pink_noise_step(pinkB0, pinkB1, pinkB2, white);
    float noiseSample = clampf(white + warmth * (pink - white), -2.f, 2.f);

    float sustainLevelScale = 1.f - warmth * ${EXCITER_SUSTAIN_LEVEL_DROP}f;

    return onepole_step(z1, noiseSample, a) * (*level) * sustainLevelScale;
  }
`
}

// `bow` inlet (added after real use: a static BOW dial can't be swept live from another node --
// an envelope crossfading pluck->bow mid-performance, or a slow LFO wobbling between the two, has
// no way in without this). ADDITIVE, not full-replace -- matching this file's MODERN convention
// for a new inlet (`width`/`rate`/`drive`/`structure`/`damping`/`decay`, all added after the
// original full-replace precedent (now only `vca`'s `gain` and the mux selectors), see WIDTH_INLET_DEPTH's own doc comment): a
// wired source BENDS the dialed BOW position, it doesn't take it over, so the knob stays
// meaningful with something wired in. Depth is half of BOW's own 0-100 range, the same derivation
// every other additive inlet in this file uses.
const EXCITER_BOW_INLET_DEPTH = 50

function exciterBowPercentExpr(suffix: string, inlets: Record<string, string | undefined>): string {
  return inlets.bow !== undefined
    ? additiveInletExpr('bowPercent', suffix, inlets.bow, EXCITER_BOW_INLET_DEPTH)
    : `bowPercent_${suffix}`
}

/**
 * A one-knob noise exciter meant to feed `logue/filter/string` or `comb`, not to be heard alone.
 * `BOW` crossfades the whole character:
 * - 0%: one short, bright click that decays in a few ms however long the note is held (the
 *   noise->AD->VCA pluck chain in one node). No extra strikes, since `strikesRemaining_` derives
 *   from `BOW` alone (see `EXCITER_STRIKE_MAX_COUNT`).
 * - mid-range: the click is followed by a decaying flurry of softer, warmer re-strikes, like a
 *   nylon-string attack rather than one quill pluck.
 * - 100%: after the strikes it keeps feeding the resonator while the note is held, lowpassed to
 *   a note-tracked brightness so the energy stays near the string's harmonics (that is what
 *   makes a continuously fed loop "sing"). Released only by a real note-off, like a lifted bow.
 *
 * No `COARSE`/`FINE`: the output isn't a pitched tone, the note only steers tracked brightness.
 * `bow` (additive, see `exciterBowPercentExpr`) is the only inlet; level control is a
 * `logue/gain/vca` after it, as for plain noise. History: docs/HISTORY.md.
 */
export const pluckExciterPrimitive: LoguePrimitive = {
  id: 'logue/osc/exciter',
  outletPolarity: 'audio',
  // seed_(uint32_t) + z1_ + stage_(int) + level_ + bowPercent_ + strikesRemaining_(int) +
  // strikeGain_ + pinkB0_/pinkB1_/pinkB2_, 10 x 4 bytes
  stateBytesPerInstance: 40,
  description:
    'A one-knob noise exciter for feeding a resonator (string/comb) -- BOW crossfades from a short, bright pluck click at 0, through a softening flurry of re-strikes, to a sustained, note-tracked bowed swell at 100.',
  inlets: [{ name: 'bow', role: 'control' }],
  memberDecls: (suffix) =>
    `  uint32_t seed_${suffix};\n  float z1_${suffix};\n  int stage_${suffix};\n  float level_${suffix};\n  float bowPercent_${suffix};\n  int strikesRemaining_${suffix};\n  float strikeGain_${suffix};\n  float pinkB0_${suffix};\n  float pinkB1_${suffix};\n  float pinkB2_${suffix};\n`,
  initStatement: (suffix) =>
    `    seed_${suffix} = ${hashSuffixToSeed(suffix)}u;\n    z1_${suffix} = 0.f;\n    stage_${suffix} = 0;\n    level_${suffix} = 0.f;\n    strikesRemaining_${suffix} = 0;\n    strikeGain_${suffix} = 1.f;\n    pinkB0_${suffix} = 0.f;\n    pinkB1_${suffix} = 0.f;\n    pinkB2_${suffix} = 0.f;\n`,
  renderExpr: (suffix, inlets) =>
    `pluck_exciter_step(&seed_${suffix}, &z1_${suffix}, &stage_${suffix}, &level_${suffix}, &strikesRemaining_${suffix}, &strikeGain_${suffix}, &pinkB0_${suffix}, &pinkB1_${suffix}, &pinkB2_${suffix}, ${exciterBowPercentExpr(suffix, inlets)}, note_ + noteFine_ * (1.f/255.f))`,
  advanceStatement: () => '',
  helpers: [
    PLUCK_EXCITER_STEP_HELPER,
    NOISE_STEP_HELPER,
    PINK_NOISE_STEP_HELPER,
    ONEPOLE_HELPER,
    CUTOFF_WARP_HELPER,
    ENV_RATE_HELPER,
    NOTE_W0_HELPER,
    CLAMPF_HELPER
  ],
  // strikesRemaining_/strikeGain_ reset on every real note-on (a fresh note deserves a fresh
  // flurry), from the PARAM value only -- same "noteOnStatement can't see a wired inlet"
  // limitation `pluckedStringPrimitive`'s own `decayGain_` doc comment already discloses, a live
  // `bow` sweep still steers the tone/hold per-sample, just not THIS note's own strike count.
  // level_ itself is deliberately NOT reset here (same `ad`/`ahd` retrigger-without-a-click
  // precedent), only stage_/strikesRemaining_/strikeGain_.
  noteOnStatement: (suffix) =>
    `    stage_${suffix} = 1;\n` +
    `    strikeGain_${suffix} = 1.f;\n` +
    `    strikesRemaining_${suffix} = (int)(bowPercent_${suffix} * 0.01f * ${EXCITER_STRIKE_MAX_COUNT}.f);\n`,
  noteOffStatement: (suffix) =>
    `    if (stage_${suffix} == 1 || stage_${suffix} == 2) { stage_${suffix} = 3; }\n`,
  params: [
    {
      name: 'BOW',
      modulatedBy: { inlet: 'bow', shape: 'additive' },
      min: 0,
      max: 100,
      default: 15,
      setStatement: (suffix, valueExpr) => `bowPercent_${suffix} = ${valueExpr};`
    }
  ]
}

const SYNC_OSC_STEP_HELPER: HelperBlock = {
  key: 'sync_osc_step',
  code: `  // One sample of a hard-synced oscillator: the slave restarts whenever the master wraps. The
  // master's wrap is seen one sample ahead, so each restart's jump is spread over the two samples
  // around its exact sub-sample time (polyBLEP, no latency): the half before it goes into this
  // sample, the half after is kept in *pending for the next. The slave's own saw/pulse edges get
  // the usual polyBLEP. Triangle and sine only jump in value at a restart, handled the same way.
  // shape: 0 saw, 1 pulse, 2 triangle, 3 sine. The lambdas are forced inline so this stays one
  // leaf body (at -Os GCC otherwise calls them).
  static float sync_osc_step(float *mph, float *sph, float *pending, float w0m, float w0s, int shape, float width)
  {
    auto blep = [](float t, float dt) __attribute__((always_inline)) -> float {
      if (t < dt) { t /= dt; return t + t - t * t - 1.f; }
      if (t > 1.f - dt) { t = (t - 1.f) / dt; return t * t + t + t + 1.f; }
      return 0.f;
    };
    auto wave = [&](float p) __attribute__((always_inline)) -> float {
      if (shape == 0) return 2.f * p - 1.f;
      if (shape == 1) return p < width ? 1.f : -1.f;
      if (shape == 2) return p < 0.5f ? 4.f * p - 1.f : 3.f - 4.f * p;
      return osc_sinf(p);
    };
    float out = wave(*sph) + *pending;
    *pending = 0.f;
    if (shape == 0) out -= blep(*sph, w0s);
    else if (shape == 1)
    {
      float fall = *sph - width;
      if (fall < 0.f) fall += 1.f;
      out += blep(*sph, w0s) - blep(fall, w0s);
    }
    float next = *mph + w0m;
    if (next >= 1.f)
    {
      // d: how far into the coming sample interval the master wraps (0..1].
      float d = (1.f - *mph) / w0m;
      float atWrap = *sph + d * w0s;
      if (atWrap >= 1.f) atWrap -= 1.f;
      float jump = wave(0.f) - wave(atWrap);
      out += jump * (1.f - d) * (1.f - d) * 0.5f;
      *pending = -jump * d * d * 0.5f;
      *mph = next - 1.f;
      *sph = (1.f - d) * w0s;
    }
    else
    {
      *mph = next;
      *sph += w0s;
      if (*sph >= 1.f) *sph -= 1.f;
    }
    return out;
  }
`
}

const SYNC_INLET_DEPTH = 24

/** The master and slave phase increments; the slave sits SYNC semitones above the master. */
function syncW0Values(
  suffix: string,
  inlets: Record<string, string | undefined>
): { master: BlockValue; slave: BlockValue } {
  const pitch = inlets.pitch !== undefined ? ` + (${inlets.pitch}) * ${COARSE_PARAM.max}.f` : ''
  const note = `note_ + noteFine_ * (1.f/255.f) + coarse_${suffix} + fine_${suffix}${pitch}`
  const sync =
    inlets.sync !== undefined
      ? additiveInletExpr('syncSemis', suffix, inlets.sync, SYNC_INLET_DEPTH, 0, 48)
      : `syncSemis_${suffix}`
  const master = blockValue('blkSyncMasterW0', suffix, `note_w0(${note})`, [inlets.pitch])
  // Capped at half the sample rate: past that the slave would alias however it is drawn.
  const slave = blockValue(
    'blkSyncSlaveW0',
    suffix,
    `clampf(note_w0(${note} + ${sync}), 0.f, 0.5f)`,
    [inlets.pitch, inlets.sync]
  )
  return { master, slave }
}

/**
 * `logue/osc/sync`: a hard-synced oscillator, master and slave in one node. The master follows
 * the played note (COARSE/FINE/`pitch`) and is never heard; the slave runs `SYNC` semitones above
 * it (0-48) and restarts at each master cycle, so sweeping SYNC -- by hand, envelope or LFO into
 * `sync` -- gives the classic tearing sync sweep at a steady pitch. Built as one node rather than
 * a sync input on every oscillator because only here is the master's exact sub-sample wrap time
 * known, which keeps the restarts anti-aliased. SHAPE picks the slave's wave: saw and pulse
 * (with WIDTH) are the classic sync timbres, triangle and sine softer ones (their restarts are
 * smoothed in value, not slope).
 */
export const syncOscPrimitive: LoguePrimitive = {
  id: 'logue/osc/sync',
  outletPolarity: 'audio',
  // masterPhase_ + slavePhase_ + pending_ + coarse_ + fine_ + syncSemis_ + shape_ + width_
  stateBytesPerInstance: 32,
  description:
    'A hard-sync oscillator: a hidden master plays the note, and the heard slave, SYNC semitones above it, restarts at every master cycle. Sweep SYNC for the classic sync lead sound. SHAPE picks saw, pulse (with WIDTH), triangle or sine.',
  inlets: [
    { name: 'pitch', role: 'control' },
    { name: 'sync', role: 'control' },
    { name: 'width', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  float masterPhase_${suffix};\n  float slavePhase_${suffix};\n  float pending_${suffix};\n` +
    `  float coarse_${suffix};\n  float fine_${suffix};\n  float syncSemis_${suffix};\n  float shape_${suffix};\n  float width_${suffix};\n`,
  initStatement: (suffix) =>
    `    masterPhase_${suffix} = 0.f;\n    slavePhase_${suffix} = 0.f;\n    pending_${suffix} = 0.f;\n`,
  blockConstants: (suffix, inlets) => blockDecls(syncW0Values(suffix, inlets)),
  renderExpr: (suffix, inlets) => {
    const w0 = syncW0Values(suffix, inlets)
    const width =
      inlets.width !== undefined
        ? additiveInletExpr('width', suffix, inlets.width, WIDTH_INLET_DEPTH, 2, 98)
        : `clampf(width_${suffix}, 2.f, 98.f)`
    return `sync_osc_step(&masterPhase_${suffix}, &slavePhase_${suffix}, &pending_${suffix}, ${w0.master.ref}, ${w0.slave.ref}, (int)shape_${suffix}, ${width} * 0.01f)`
  },
  advanceStatement: () => '',
  helpers: [NOTE_W0_HELPER, CLAMPF_HELPER, SYNC_OSC_STEP_HELPER],
  params: [
    COARSE_PARAM,
    FINE_PARAM,
    {
      name: 'SYNC',
      unit: SEMITONES,
      nts1mkiiType: 'semi',
      modulatedBy: { inlet: 'sync', shape: 'additive' },
      min: 0,
      max: 48,
      default: 12,
      setStatement: (suffix, valueExpr) => `syncSemis_${suffix} = ${valueExpr};`
    },
    {
      name: 'SHAPE',
      unit: SYNC_SHAPE_NAME,
      select: { count: 4, scale: 1, label: 'Shape', names: ['Saw', 'Pulse', 'Tri', 'Sine'] },
      min: 0,
      max: 3,
      default: 0,
      step: 1,
      setStatement: (suffix, valueExpr) => `shape_${suffix} = ${valueExpr};`
    },
    {
      name: 'WIDTH',
      unit: PERCENT,
      nts1mkiiType: 'percent',
      modulatedBy: { inlet: 'width', shape: 'additive', note: 'only heard with SHAPE on Pulse' },
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `width_${suffix} = ${valueExpr};`
    }
  ]
}

/** `logue/osc/phase-dist`: a bent stretch reads the cosine at `rate/k` cycles per sample; this
 *  caps it at a quarter of Nyquist, by note. */
const PD_MAX_LOCAL_RATE = 0.125
/** The resonance waves' cosine, `r*rate` cycles per sample, stays under this. */
const PD_MAX_RESO_RATE = 0.25
/** DCW 100 asks for a resonance frequency of this multiple of the note (the CZ's 16th). */
const PD_RESO_MAX_RATIO = 16
const PD_DCW_INLET_DEPTH = 100
const PD_OUT_GAIN = 0.5

const PD_COEFF_HELPER: HelperBlock = {
  key: 'pd_coeffs',
  code: `  // Phase distortion coefficients from DCW (0..1) and the rate the wave is read at (cycles per
  // sample). k: the bend width, 1 = none, cubed from DCW since brightness goes roughly as 1/k,
  // held at rate/${PD_MAX_LOCAL_RATE} or wider so the steepest stretch can't alias. r: the
  // resonance waves' frequency as a multiple of the note, capped below ${PD_MAX_RESO_RATE} cycles per sample.
  static inline __attribute__((always_inline)) float pd_knee(float dcw, float rate)
  {
    float u = 1.f - dcw;
    float k = u * u * u;
    float lo = rate * ${floatLit(1 / PD_MAX_LOCAL_RATE)};
    if (lo > 1.f) lo = 1.f;
    return k < lo ? lo : k;
  }
  static inline __attribute__((always_inline)) float pd_reso_ratio(float dcw, float rate)
  {
    float r = 1.f + ${floatLit(PD_RESO_MAX_RATIO - 1)} * dcw;
    if (r * rate <= ${floatLit(PD_MAX_RESO_RATE)}) return r;
    return rate >= ${floatLit(PD_MAX_RESO_RATE)} ? 1.f : ${floatLit(PD_MAX_RESO_RATE)} / rate;
  }
  // Line 1+2 reads each wave at twice the note's rate.
  static inline __attribute__((always_inline)) float pd_rate(float w0, int wave2)
  {
    return wave2 < 0 ? w0 : w0 + w0;
  }
  // The saw's slow stretch has slope 1/(1 - k/2), every bend's steep one 1/k: both from one
  // divide, through pd_both.
  static inline __attribute__((always_inline)) float pd_both(float k)
  {
    return 1.f / (k * (1.f - 0.5f * k));
  }
  static inline __attribute__((always_inline)) float pd_inv_k(float k, float both)
  {
    return (1.f - 0.5f * k) * both;
  }
  static inline __attribute__((always_inline)) float pd_inv_slow(float k, float both)
  {
    return k * both;
  }
`
}

const PD_STEP_HELPER: HelperBlock = {
  key: 'pd_osc_step',
  code: `  // One CZ wave at phase p (0..1), each a cosine read through a bent phase: 0 saw, 1 square,
  // 2 pulse, 3 double sine, 4 saw-pulse; 5..7 the resonance waves, a cosine at r times the note
  // under a falling saw / triangle / trapezoid window, written 1 - w*(1 - c) so it returns to 1
  // at every reset whatever r is (the window hides the jump, so r needs no rounding). The cosine
  // is osc_sinf(x + 0.25), which osc_cosf is, since effects only get an osc_sinf stand-in.
  // The double sine blends toward reading the sine twice per cycle by DCW itself, not k: it has
  // no steep stretch to limit, and its far end (a clean octave) aliases less than a held kink.
  static inline __attribute__((always_inline)) float pd_wave(float p, int wave, float dcw, float k, float invK, float invSlow, float r)
  {
    float phi;
    switch (wave)
    {
      case 0: { float m = 0.5f * k; phi = p < m ? p * invK : 0.5f + (p - m) * 0.5f * invSlow; break; }
      case 1: { float h = p < 0.5f ? 0.f : 0.5f; float q = (p - h) * invK; phi = h + (q < 0.5f ? q : 0.5f); break; }
      case 2: { float q = p * invK; phi = q < 1.f ? q : 1.f; break; }
      case 3: { float f = p + p; if (f >= 1.f) f -= 1.f; phi = p + dcw * (f - p); break; }
      case 4: { float a = 0.5f * k; phi = p < a ? p * invK : 0.5f + (p - a); if (phi > 1.f) phi = 1.f; break; }
      default:
      {
        float w;
        if (wave == 5) w = 1.f - p;
        else if (wave == 6) w = p < 0.5f ? p + p : 2.f - p - p;
        else w = p < 0.5f ? 1.f : 2.f - p - p;
        return 1.f - w * (1.f - osc_sinf(r * p + 0.25f));
      }
    }
    return osc_sinf(phi + 0.25f);
  }
  // Line 1+2 plays each wave at double speed in its half period, so the note keeps its pitch.
  // The ~2 Hz DC blocker is for pulse, saw-pulse and the resonance waves, which sit mostly above
  // zero. dc: [0] last input, [1] last output.
  static inline __attribute__((always_inline)) float pd_osc_step(float *ph, float *dc, float readPh, float w0, int wave, int wave2, float dcw, float k, float invK, float invSlow, float r)
  {
    float y;
    if (wave2 < 0) y = pd_wave(readPh, wave, dcw, k, invK, invSlow, r);
    else
    {
      float q = readPh + readPh;
      y = q < 1.f ? pd_wave(q, wave, dcw, k, invK, invSlow, r) : pd_wave(q - 1.f, wave2, dcw, k, invK, invSlow, r);
    }
    float p = *ph + w0;
    if (p >= 1.f) p -= 1.f;
    *ph = p;
    float out = y - dc[0] + 0.9997f * dc[1];
    dc[0] = y;
    dc[1] = out;
    return out * ${floatLit(PD_OUT_GAIN)};
  }
  // DCW or the pitch moving per sample: the divides are most of this path's cost, so only the
  // chosen waves' coefficients are worked out (the double sine needs none).
  static inline __attribute__((always_inline)) float pd_osc_step_moving(float *ph, float *dc, float readPh, float w0, int wave, int wave2, float dcw)
  {
    float rate = pd_rate(w0, wave2);
    bool bend = (wave < 5 && wave != 3) || (wave2 >= 0 && wave2 < 5 && wave2 != 3);
    bool reso = wave >= 5 || wave2 >= 5;
    float k = 1.f, invK = 1.f, invSlow = 1.f, r = 1.f;
    if (bend)
    {
      k = pd_knee(dcw, rate);
      float both = pd_both(k);
      invK = pd_inv_k(k, both);
      invSlow = pd_inv_slow(k, both);
    }
    if (reso) r = pd_reso_ratio(dcw, rate);
    return pd_osc_step(ph, dc, readPh, w0, wave, wave2, dcw, k, invK, invSlow, r);
  }
`
}

interface PhaseDistValues {
  w0: BlockValue
  dcw: string
  /** `pd_wave2`'s index: -1 for Off. */
  wave2: string
  /** Undefined while DCW or the pitch moves per sample (then `pd_osc_step_moving`). */
  coeffs?: Record<'rate' | 'k' | 'both' | 'invK' | 'invSlow' | 'r', BlockValue>
}

function phaseDistValues(
  suffix: string,
  inlets: Record<string, string | undefined>
): PhaseDistValues {
  const w0Inputs = [inlets.pitch, inlets.harmonic]
  const w0 = blockValue('blkPdW0', suffix, transposedW0Expr(suffix, inlets), w0Inputs)
  const dcwPercent =
    inlets.dcw !== undefined
      ? additiveInletExpr('dcw', suffix, inlets.dcw, PD_DCW_INLET_DEPTH)
      : `dcw_${suffix}`
  const dcw = `(${dcwPercent}) * 0.01f`
  const wave2 = `(int)wave2_${suffix} - 1`
  const inputs = [inlets.dcw, ...w0Inputs]
  if (!inputs.every(isBlockInvariant)) return { w0, dcw, wave2 }
  const value = (name: string, expr: string): BlockValue => blockValue(name, suffix, expr, inputs)
  const rate = value('blkPdRate', `pd_rate(${w0.ref}, ${wave2})`)
  const k = value('blkPdK', `pd_knee(${dcw}, ${rate.ref})`)
  const both = value('blkPdBoth', `pd_both(${k.ref})`)
  return {
    w0,
    dcw,
    wave2,
    coeffs: {
      rate,
      k,
      both,
      invK: value('blkPdInvK', `pd_inv_k(${k.ref}, ${both.ref})`),
      invSlow: value('blkPdInvSlow', `pd_inv_slow(${k.ref}, ${both.ref})`),
      r: value('blkPdR', `pd_reso_ratio(${dcw}, ${rate.ref})`)
    }
  }
}

/**
 * `logue/osc/phase-dist`: Casio CZ phase distortion. A cosine read through a bent phase: DCW 0
 * is a pure cosine, and turning DCW up bends it toward the chosen wave -- saw, square, pulse,
 * double sine, saw-pulse -- or, for the three resonance waves, raises a windowed cosine from the
 * note to 16 times it (a filter-sweep sound at a steady pitch). WAVE2 (line 1+2) alternates a
 * second wave each half period. DCW is meant to be swept from outside (an envelope into `dcw`,
 * at the full range like a filter cutoff). The bend is held back by note so high notes don't
 * alias (`pd_knee`), which the CZ itself didn't do.
 */
export const phaseDistOscPrimitive: LoguePrimitive = {
  id: 'logue/osc/phase-dist',
  outletPolarity: 'audio',
  // phase_ + dc_[2] + coarse_ + fine_ + wave_ + wave2_ + dcw_ + fmDepthPercent_
  stateBytesPerInstance: 36,
  description:
    "Casio CZ-style phase distortion: a sine bent toward saw, square, pulse, double sine or saw-pulse as DCW rises, or one of three resonance waves that sweep like a filter. WAVE2 alternates a second wave (the CZ's 1+2). Wire an envelope into dcw for the classic CZ sweep.",
  inlets: [
    { name: 'pitch', role: 'control' },
    { name: 'harmonic', role: 'control' },
    { name: 'fm', role: 'audio' },
    { name: 'fmDepth', role: 'control' },
    { name: 'dcw', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  float phase_${suffix};\n  float dc_${suffix}[2];\n  float coarse_${suffix};\n  float fine_${suffix};\n` +
    `  float wave_${suffix};\n  float wave2_${suffix};\n  float dcw_${suffix};\n  float fmDepthPercent_${suffix};\n`,
  initStatement: (suffix) =>
    `    phase_${suffix} = 0.f;\n    dc_${suffix}[0] = 0.f;\n    dc_${suffix}[1] = 0.f;\n`,
  blockConstants: (suffix, inlets) => {
    const v = phaseDistValues(suffix, inlets)
    return blockDecls({ w0: v.w0, ...v.coeffs })
  },
  renderExpr: (suffix, inlets) => {
    const v = phaseDistValues(suffix, inlets)
    const head = `&phase_${suffix}, dc_${suffix}, ${fmPhaseExpr(suffix, inlets)}, ${v.w0.ref}, (int)wave_${suffix}, ${v.wave2}`
    if (v.coeffs === undefined) return `pd_osc_step_moving(${head}, ${v.dcw})`
    const c = v.coeffs
    return `pd_osc_step(${head}, ${v.dcw}, ${c.k.ref}, ${c.invK.ref}, ${c.invSlow.ref}, ${c.r.ref})`
  },
  advanceStatement: () => '',
  helpers: [
    NOTE_W0_HELPER,
    PM_WRAP_HELPER,
    CLAMPF_HELPER,
    HARMONIC_RATIO_HELPER,
    PD_COEFF_HELPER,
    PD_STEP_HELPER
  ],
  params: [
    COARSE_PARAM,
    FINE_PARAM,
    {
      name: 'WAVE',
      unit: PD_WAVE_NAME,
      select: { count: 8, scale: 1, label: 'Wave', names: PD_WAVE_NAMES },
      min: 0,
      max: 7,
      default: 0,
      step: 1,
      setStatement: (suffix, valueExpr) => `wave_${suffix} = ${valueExpr};`
    },
    {
      name: 'WAVE2',
      unit: PD_WAVE2_NAME,
      select: { count: 9, scale: 1, label: 'Wave2', names: PD_WAVE2_NAMES },
      min: 0,
      max: 8,
      default: 0,
      step: 1,
      setStatement: (suffix, valueExpr) => `wave2_${suffix} = ${valueExpr};`
    },
    {
      name: 'DCW',
      unit: PERCENT,
      nts1mkiiType: 'percent',
      modulatedBy: {
        inlet: 'dcw',
        shape: 'additive',
        note: 'the whole range: an envelope sweeps 0 to 100'
      },
      min: 0,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `dcw_${suffix} = ${valueExpr};`
    },
    FM_DEPTH_PARAM
  ]
}

const BASS_SAT_HELPER: HelperBlock = {
  key: 'bass_sat',
  code: `  // Cubic soft clip: x - 4x^3/27 up to |x| = 1.5, where it reaches 1 with zero slope, so the
  // clamp beyond is smooth. Nearly linear for small x (a low DRIVE stays clean), and no divide:
  // a rational tanh here cost ~20 of the xd's cycles per sample.
  static inline __attribute__((always_inline)) float bass_sat(float x)
  {
    if (x > 1.5f) return 1.f;
    if (x < -1.5f) return -1.f;
    return x - 0.148148f * x * x * x;
  }
`
}

const BASS_BLOCK_NOTE_HELPER: HelperBlock = {
  key: 'bass_block_note',
  code: `  // Once per block: the note to play, an octave below the played one, glided.
  // st: [0] glided note (-1000 = snap; a note below 12 plays below 0), [1] phase, [2] sub half.
  static float bass_block_note(float *st, float note, float fine, float glideCoeff)
  {
    float target = note + fine * (1.f / 255.f) - 12.f;
    if (st[0] < -999.f) st[0] = target;
    else st[0] += (target - st[0]) * glideCoeff;
    return st[0];
  }

  // A one-pole glide per block: GLIDE 0..100 -> 0..2000 ms (squared), 0 = none.
  static float bass_glide_coeff(float glide, uint32_t frames)
  {
    float t = glide * 0.01f;
    float samples = 2000.f * t * t * 48.f;
    return (float)frames / ((float)frames + samples);
  }

  // TPT lowpass g for a cutoff of (1 + 31*t^2) x the played pitch; tan by its Taylor series,
  // good to a few percent within the clamp (about 12 kHz). Inline, so a wired tone's repeated
  // uses in the sample loop fold into one.
  static inline __attribute__((always_inline)) float bass_tone_g(float w0, float tone)
  {
    float t = tone * 0.01f;
    if (t < 0.f) t = 0.f;
    if (t > 1.f) t = 1.f;
    float x = 3.14159265f * w0 * (1.f + 31.f * t * t);
    if (x > 0.8f) x = 0.8f;
    float x2 = x * x;
    return x * (1.f + x2 * (0.333333f + x2 * 0.133333f));
  }
`
}

// The tone filter's damping: Q ~1, a small bump at the cutoff.
const BASS_TONE_K = 1

const BASS_STEP_HELPER: HelperBlock = {
  key: 'bass_support_step',
  code: `  // One sample: SHAPE morphs sine -> triangle -> saw -> square (all starting at a zero
  // crossing, so RETRIG restarts cleanly), a square an octave down is blended in (SUB, locked to
  // the main phase: its level flips at every main wrap), then the drive stage (bass_sat with an
  // ASYM offset for even harmonics, its static part subtracted, level-compensated), a tracked
  // 2-pole lowpass (TONE) and a ~2 Hz DC blocker for what the asymmetry leaves. The lambdas are
  // forced inline so this stays one leaf body on the xd.
  // st: [1] phase, [2] sub half (0/1), [3] [4] filter, [5] [6] DC blocker.
  static float bass_support_step(float *st, float w0, float shape, float sub, float drive, float bias, float biasOut, float comp, float g, float a1)
  {
    auto blep = [](float t, float dt) __attribute__((always_inline)) -> float {
      if (t < dt) { t /= dt; return t + t - t * t - 1.f; }
      if (t > 1.f - dt) { t = (t - 1.f) / dt; return t * t + t + t + 1.f; }
      return 0.f;
    };
    float p = st[1];
    auto wave = [&](int k) __attribute__((always_inline)) -> float {
      if (k == 0) return osc_sinf(p);
      if (k == 1) return p < 0.25f ? 4.f * p : (p < 0.75f ? 2.f - 4.f * p : 4.f * p - 4.f);
      if (k == 2)
      {
        float q = p + 0.5f;
        if (q >= 1.f) q -= 1.f;
        return 2.f * q - 1.f - blep(q, w0);
      }
      float fall = p + 0.5f;
      if (fall >= 1.f) fall -= 1.f;
      return (p < 0.5f ? 1.f : -1.f) + blep(p, w0) - blep(fall, w0);
    };
    float s = shape * 0.03f;
    if (s < 0.f) s = 0.f;
    if (s > 3.f) s = 3.f;
    int k = (int)s;
    float f = s - (float)k;
    // Within 2% of a corner (about +-0.7 on the dial, so 33 and 67 land on it) play the pure
    // wave: one wave per sample instead of two.
    if (f > 0.98f) { k++; f = 0.f; }
    float x = wave(k);
    if (f >= 0.02f) x += (wave(k + 1) - x) * f;
    if (sub > 0.f)
    {
      float sp = (p + st[2]) * 0.5f;
      float sfall = sp + 0.5f;
      if (sfall >= 1.f) sfall -= 1.f;
      float dt = w0 * 0.5f;
      float sq = (sp < 0.5f ? 1.f : -1.f) + blep(sp, dt) - blep(sfall, dt);
      x = x * (1.f - 0.4f * sub) + sq * 0.7f * sub;
    }
    float y = (bass_sat(x * drive + bias) - biasOut) * comp;
    float a2 = g * a1, a3 = g * a2;
    float v3 = y - st[4];
    float v1 = a1 * st[3] + a2 * v3;
    float v2 = st[4] + a2 * st[3] + a3 * v3;
    st[3] = 2.f * v1 - st[3];
    st[4] = 2.f * v2 - st[4];
    float out = v2 - st[5] + 0.9997f * st[6];
    st[5] = v2;
    st[6] = out;
    // The filter's ringing on square edges plus the sub peak at 1.82 before this (harness,
    // SHAPE/SUB/DRIVE/ASYM/TONE corners across the bass range), so 0.52 keeps them all under full scale.
    out *= 0.52f;
    p += w0;
    if (p >= 1.f) { p -= 1.f; st[2] = 1.f - st[2]; }
    st[1] = p;
    return out;
  }
`
}

const BASS_SHAPE_INLET_DEPTH = 50
const BASS_DRIVE_INLET_DEPTH = 50
const BASS_TONE_INLET_DEPTH = 50

interface BassValues {
  noteDecl: { name: string; expr: string }
  baseW0Decl: { name: string; expr: string }
  w0: string
  driveGain: BlockValue
  bias: BlockValue
  biasOut: BlockValue
  comp: BlockValue
  g: BlockValue
  a1: BlockValue
  shape: string
}

function bassValues(suffix: string, inlets: Record<string, string | undefined>): BassValues {
  const note = `blkBassNote_${suffix}`
  // Stateful (glide), so always a block local, never inlined per sample.
  const noteDecl = {
    name: note,
    expr: `bass_block_note(st_${suffix}, note_, noteFine_, bass_glide_coeff(glide_${suffix}, frames))`
  }
  const tuned = `${note} + coarse_${suffix} + fine_${suffix}`
  const baseW0Decl = { name: `blkBassW0_${suffix}`, expr: `note_w0(${tuned})` }
  const w0 =
    inlets.pitch !== undefined
      ? `note_w0(${tuned} + (${inlets.pitch}) * ${COARSE_PARAM.max}.f)`
      : baseW0Decl.name
  const driveRaw =
    inlets.drive !== undefined
      ? additiveInletExpr('drive', suffix, inlets.drive, BASS_DRIVE_INLET_DEPTH)
      : `drive_${suffix}`
  // 0.7x (nearly clean) to 8x into bass_sat.
  const driveGain = blockValue(
    'blkBassDrive',
    suffix,
    `(0.7f + 7.3f * (${driveRaw}) * (${driveRaw}) * 0.0001f)`,
    [inlets.drive]
  )
  const bias = blockValue('blkBassBias', suffix, `asym_${suffix} * 0.005f`, [])
  const biasOut = blockValue('blkBassBiasOut', suffix, `bass_sat(${bias.ref})`, [])
  // A full-scale input comes out near full scale at any DRIVE.
  const comp = blockValue('blkBassComp', suffix, `(1.f / bass_sat(${driveGain.ref}))`, [
    inlets.drive
  ])
  const tone =
    inlets.tone !== undefined
      ? additiveInletExpr('tone', suffix, inlets.tone, BASS_TONE_INLET_DEPTH)
      : `tone_${suffix}`
  const g = blockValue('blkBassG', suffix, `bass_tone_g(${baseW0Decl.name}, ${tone})`, [
    inlets.tone
  ])
  const a1 = blockValue(
    'blkBassA1',
    suffix,
    `(1.f / (1.f + ${g.ref} * (${g.ref} + ${BASS_TONE_K}.f)))`,
    [inlets.tone]
  )
  const shape =
    inlets.shape !== undefined
      ? additiveInletExpr('shape', suffix, inlets.shape, BASS_SHAPE_INLET_DEPTH)
      : `shape_${suffix}`
  return { noteDecl, baseW0Decl, w0, driveGain, bias, biasOut, comp, g, a1, shape }
}

/**
 * `logue/osc/bass-support`: a deep, saturated bass voice an octave below the played note
 * (COARSE moves it further) -- a bass underneath the device's own oscillators and filter.
 * It replaced a fold of every note into a fixed two-octave window (RANGE, Wrap/Follow), which
 * was hard to follow in practice (user, 2026-10-02).
 * Chain: SHAPE (sine -> triangle -> saw -> square), SUB (a square an octave down), DRIVE/ASYM
 * (cubic soft clip, level-compensated, ASYM adds even harmonics -- what keeps a 40 Hz fundamental
 * audible on small speakers), TONE (2-pole lowpass at a multiple of the pitch, so every note in
 * has the same brightness), a ~2 Hz DC blocker. GLIDE slews between bass notes.
 * On the xd each voice plays its own bass, so chords get muddy down there: mono/unison suits it.
 */
export const bassSupportPrimitive: LoguePrimitive = {
  id: 'logue/osc/bass-support',
  outletPolarity: 'audio',
  // st_[7] + coarse_ fine_ shape_ sub_ drive_ asym_ tone_ glide_ retrig_
  stateBytesPerInstance: 64,
  description:
    'A deep, saturated bass one octave below the note you play; COARSE moves it further (-12 for two octaves down). SHAPE, SUB, DRIVE, ASYM and TONE shape the sound; GLIDE slides between notes. On low notes the sub is mostly felt, not heard.',
  inlets: [
    { name: 'pitch', role: 'control' },
    { name: 'shape', role: 'control' },
    { name: 'drive', role: 'control' },
    { name: 'tone', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  float st_${suffix}[7];\n` +
    `  float coarse_${suffix};\n  float fine_${suffix};\n` +
    `  float shape_${suffix};\n  float sub_${suffix};\n  float drive_${suffix};\n  float asym_${suffix};\n` +
    `  float tone_${suffix};\n  float glide_${suffix};\n  float retrig_${suffix};\n`,
  initStatement: (suffix) =>
    `    for (int k = 0; k < 7; k++) st_${suffix}[k] = 0.f;\n` + `    st_${suffix}[0] = -1000.f;\n`,
  noteOnStatement: (suffix) =>
    `    if (retrig_${suffix} >= ${TRACK_ON_RAW_THRESHOLD}.f) { st_${suffix}[1] = 0.f; st_${suffix}[2] = 0.f; }\n`,
  blockConstants: (suffix, inlets) => {
    const v = bassValues(suffix, inlets)
    return [
      v.noteDecl,
      v.baseW0Decl,
      ...blockDecls({
        driveGain: v.driveGain,
        bias: v.bias,
        biasOut: v.biasOut,
        comp: v.comp,
        g: v.g,
        a1: v.a1
      })
    ]
  },
  renderExpr: (suffix, inlets) => {
    const v = bassValues(suffix, inlets)
    return `bass_support_step(st_${suffix}, ${v.w0}, ${v.shape}, sub_${suffix} * 0.01f, ${v.driveGain.ref}, ${v.bias.ref}, ${v.biasOut.ref}, ${v.comp.ref}, ${v.g.ref}, ${v.a1.ref})`
  },
  advanceStatement: () => '',
  helpers: [
    NOTE_W0_HELPER,
    CLAMPF_HELPER,
    BASS_SAT_HELPER,
    BASS_BLOCK_NOTE_HELPER,
    BASS_STEP_HELPER
  ],
  params: [
    {
      name: 'SHAPE',
      unit: PERCENT,
      nts1mkiiType: 'percent',
      modulatedBy: {
        inlet: 'shape',
        shape: 'additive',
        note: 'sine 0, triangle 33, saw 67, square 100'
      },
      min: 0,
      max: 100,
      default: 67,
      setStatement: (suffix, valueExpr) => `shape_${suffix} = ${valueExpr};`
    },
    {
      name: 'SUB',
      unit: PERCENT,
      nts1mkiiType: 'percent',
      min: 0,
      max: 100,
      default: 30,
      setStatement: (suffix, valueExpr) => `sub_${suffix} = ${valueExpr};`
    },
    {
      name: 'DRIVE',
      unit: PERCENT,
      nts1mkiiType: 'percent',
      modulatedBy: { inlet: 'drive', shape: 'additive' },
      min: 0,
      max: 100,
      default: 40,
      setStatement: (suffix, valueExpr) => `drive_${suffix} = ${valueExpr};`
    },
    {
      name: 'ASYM',
      unit: PERCENT,
      nts1mkiiType: 'percent',
      min: 0,
      max: 100,
      default: 30,
      setStatement: (suffix, valueExpr) => `asym_${suffix} = ${valueExpr};`
    },
    {
      name: 'TONE',
      unit: BASS_TONE_MULTIPLE,
      modulatedBy: { inlet: 'tone', shape: 'additive' },
      min: 0,
      max: 100,
      default: 40,
      setStatement: (suffix, valueExpr) => `tone_${suffix} = ${valueExpr};`
    },
    {
      name: 'GLIDE',
      unit: BASS_GLIDE_MS,
      min: 0,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `glide_${suffix} = ${valueExpr};`
    },
    {
      name: 'RETRIG',
      booleanWidget: RETRIG_WIDGET,
      min: 0,
      max: 100,
      default: 100,
      setStatement: (suffix, valueExpr) => `retrig_${suffix} = ${valueExpr};`
    },
    COARSE_PARAM,
    FINE_PARAM
  ]
}

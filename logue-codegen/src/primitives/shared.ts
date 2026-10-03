import {
  CENTS,
  LEVEL_DB,
  LEVEL_RANGE_DB,
  SEMITONES,
  TRACK_ON_THRESHOLD
} from '../paramPresentation'
import type { HelperBlock, PrimitiveParamSpec } from './types'

/** A C float literal for `n`, e.g. `100.f`, `0.25f`. */
export function floatLit(n: number): string {
  return Number.isInteger(n) ? `${n}.f` : `${n}f`
}

/**
 * Every oscillator's real pitch computation. Re-derives `osc_w0f_for_note` with a shifted note (never multiplies `w0`
 * by a ratio), mirroring the SDK's own real coarse/fine precedent verbatim
 * (`platform/microkorg2/vox/vox.h`'s `UpdateVoicePitch`: `note = semitoneParam + fineParam*0.01
 * + noteNumber + pitchMod`, split into whole/frac, re-passed to `osc_w0f_for_note`) -- no libm
 * anywhere, same discipline as every other rate/cutoff mapping in this file.
 */
export const NOTE_W0_HELPER: HelperBlock = {
  key: 'note_w0',
  code: `  static float note_w0(float note)
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

/**
 * The registry's additive-inlet shape: the dial's own member plus the wired signal scaled by
 * `depth`, clamped back into the dial's range -- a wired source bends the dial, never replaces it.
 */
export function additiveInletExpr(
  member: string,
  suffix: string,
  wired: string,
  depth: number,
  lo = 0,
  hi = 100
): string {
  return `clampf(${member}_${suffix} + (${wired}) * ${depth}.f, ${lo}.f, ${hi}.f)`
}

/**
 * Backs every ADDITIVE wired inlet added in this same phase (`pitch`/`width`/`rate`) -- a wired
 * value is ADDED to the primitive's own control value (scaled by a "depth" derived from an
 * already-declared param's own range, never a separately-authored number -- see each inlet's own
 * comment), then clamped to the control's valid range. Only `vca`'s `gain` and the mux
 * selectors still REPLACE their dial when wired (an envelope must be able to close a VCA, a gate
 * must pick an input whatever the dial says); the filters' `cutoff`, crossfader `fade` and
 * additive `timbre` replaced theirs too until file version 4 (see `migrateAdditiveDialInlets`).
 */
/** `exp(x)` without libm (`expf` doesn't link on the xd): `string`'s decay gain, the noise
 *  sources' LEVEL. Moved here from filter.ts once a second category needed it. */
export const EXP_APPROX_HELPER: HelperBlock = {
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

export const CLAMPF_HELPER: HelperBlock = {
  key: 'clampf',
  code: `  static float clampf(float v, float lo, float hi)
  {
    return v < lo ? lo : (v > hi ? hi : v);
  }
`
}

/**
 * Every oscillator's own semitone-unit tuning control -- real Korg SDK precedent range
 * (`platform/microkorg2/vox/header.c`'s `kParamSemi`: `{-24,24}`), shared by reference across
 * all 5 oscillators (same pattern `POLYBLEP_HELPER` already uses for a shared HelperBlock).
 */
export const COARSE_PARAM: PrimitiveParamSpec = {
  name: 'COARSE',
  min: -24,
  max: 24,
  default: 0,
  step: 1,
  unit: SEMITONES,
  nts1mkiiType: 'semi',
  // Every primitive with COARSE has a `pitch` inlet, and `transposedW0Expr` adds it to COARSE.
  modulatedBy: {
    inlet: 'pitch',
    shape: 'additive',
    note: 'up to ±24 semitones, not clamped to the dial range'
  },
  setStatement: (suffix, valueExpr) => `coarse_${suffix} = ${valueExpr};`
}

/** Cents, real Korg SDK precedent range (`vox.h`'s `kParamFine`: `{-50,50}`) -- pre-scaled to a semitone fraction (`*0.01f`) at set-time, unlike `COARSE` which needs no scaling. */
export const FINE_PARAM: PrimitiveParamSpec = {
  name: 'FINE',
  min: -50,
  max: 50,
  default: 0,
  unit: CENTS,
  nts1mkiiType: 'cents',
  setStatement: (suffix, valueExpr) => `fine_${suffix} = ${valueExpr} * 0.01f;`
}

/**
 * A full `+-1` swing from a wired `pitch` inlet maps to `+-24` semitones -- reuses `COARSE_PARAM`'s
 * own max rather than a separately-invented number (the same semitone scale the static COARSE
 * control already uses). See `CLAMPF_HELPER`'s own doc comment for why this is additive, not a
 * replacement, and this file's module doc comment section on depth-derivation for the general rule.
 */
const PITCH_INLET_DEPTH = COARSE_PARAM.max

/**
 * A full `+-1` swing from a wired `harmonic` inlet maps to `+-16` -- an independently-chosen
 * range (not derived from `COARSE_PARAM` the way `PITCH_INLET_DEPTH` is, since this isn't a
 * semitone-domain quantity at all -- see `HARMONIC_RATIO_HELPER`'s own doc comment).
 */
const HARMONIC_INLET_DEPTH = 16

/**
 * Requested as a "subharmonic/upper-harmonic patching" utility: an exact integer frequency
 * multiply/divide, wireable so it doesn't cost every oscillator a new dial (unlike `COARSE`,
 * which CAN already express this -- typing `12*log2(N)` semitones into it, or into a
 * `logue/util/constant` wired into `pitch` -- but only up to `+-24` semitones (`x4`/`/4`) per
 * mechanism, and only by hand-computing a log2 each time, which is exactly the friction this
 * inlet exists to remove). Deliberately NOT routed through the semitone/`pitch` system at all:
 * frequency is exactly proportional to `w0` (`note_w0`'s own return value), so multiplying/
 * dividing `w0` directly by an integer is an EXACT ratio with no `log2`/`pow` and no `+-24`
 * ceiling -- see `transposedW0Expr`'s own use of this below, which applies it as an outer
 * multiply on the whole `note_w0(...)` result rather than folding it into the note argument.
 *
 * Rounds to the nearest integer rather than truncating the "integer part" literally, and this
 * is load-bearing, not merely friendlier: a `logue/util/constant` wired in at the exact percent
 * for e.g. `N=3` (`VALUE=18.75`, `raw=0.1875`, `*16=3.0`) is NOT guaranteed to land on exactly
 * `3.0f` after the `*0.01f`/`*16.f` float roundtrip (`0.01f` has no exact binary representation)
 * -- it can come out `2.9999998` or `3.0000002` depending on the specific value. Truncating
 * either of those silently mis-multiplies by 2 instead of 3; rounding lands on the intended
 * integer either way. `n==0` (raw magnitude below `0.5/16 ~ 3.1%`) returns unity -- the same
 * "centered/near-zero wired value means no effect" default every other additive inlet in this
 * file already uses, and exactly what an unwired `harmonic` inlet already produces by simply
 * not being applied at all (see `transposedW0Expr`).
 */
export const HARMONIC_RATIO_HELPER: HelperBlock = {
  key: 'harmonic_ratio',
  code: `  static float harmonic_ratio(float raw)
  {
    int n = (int)(raw + (raw >= 0.f ? 0.5f : -0.5f));
    if (n > 0) return (float)n;
    if (n < 0) return 1.f / (float)(-n);
    return 1.f;
  }
`
}

/**
 * Every oscillator's own transposed phase increment -- `note_`/`noteFine_` (the Osc-class-level
 * raw MIDI note/fine-tune bytes, always set once per render block, see both platform generators'
 * `setPitch`) plus this INSTANCE's own `COARSE`/`FINE`, plus (when wired) the `pitch` inlet's own
 * additive semitone contribution. At `coarse=fine=0`/unwired pitch this reduces to
 * `note_w0(note_ + noteFine_/255)`, which reconstructs `osc_w0f_for_note(note_, noteFine_)`
 * bit-for-bit -- existing default behavior is unchanged, not just approximated.
 *
 * When `harmonic` is ALSO wired, the entire result above is multiplied by
 * `harmonic_ratio(...)` (clamped to the promised `+-16` range first, load-bearing since an
 * upstream signal isn't guaranteed to already be a clean `+-1` -- e.g. a unipolar `sense/*`
 * reading would otherwise only ever request a positive/multiply ratio, silently unable to
 * express a divide). Applying it as an OUTER multiply on the whole `note_w0` result (not folded
 * into the note argument the way `pitch`/`COARSE` are) is what makes this exact: frequency is
 * exactly proportional to `w0`, so this is a real rational scale, not a semitone
 * approximation -- unlike `pitch`, there is no separate static/dial-only param for this
 * (matching `pitch`'s own inlet-only precedent, not `width`/`rate`/`drive`'s dial+inlet shape),
 * since `COARSE` already covers the static case (see this const's own doc comment above).
 */
export function transposedW0Expr(
  suffix: string,
  inlets: Record<string, string | undefined>
): string {
  const pitchTerm =
    inlets.pitch !== undefined ? ` + (${inlets.pitch}) * ${PITCH_INLET_DEPTH}.f` : ''
  const base = `note_w0(note_ + noteFine_ * (1.f/255.f) + coarse_${suffix} + fine_${suffix}${pitchTerm})`
  if (inlets.harmonic === undefined) return base
  return `(${base}) * harmonic_ratio(clampf(${inlets.harmonic}, -1.f, 1.f) * ${HARMONIC_INLET_DEPTH}.f)`
}

/**
 * `transposedW0Expr` once per block while `pitch`/`harmonic` don't move: the note, COARSE and
 * FINE only change between blocks, and an oscillator read it twice a sample (its polyBLEP's `dt`
 * and the phase advance), each a `note_w0` call. A primitive using it lists the decl in
 * `blockConstants`.
 */
export function transposedW0(
  suffix: string,
  inlets: Record<string, string | undefined>
): BlockValue {
  return blockValue('blkW0', suffix, transposedW0Expr(suffix, inlets), [
    inlets.pitch,
    inlets.harmonic
  ])
}

/**
 * Linear FM is PHASE modulation (as on the DX7): `fmPhaseExpr` adds the `fm` inlet to the phase a
 * waveform reads and `pm_wrap` wraps it back into `[0,1)`. The accumulator itself is untouched,
 * so its increment stays non-negative and the single upward wrap in `advanceStatement` holds.
 * For a sine, PM and through-zero FM sound nearly the same.
 *
 * `logue/osc/saw` is the exception: PolyBLEP depends on the sign of the phase velocity, so its
 * `TZFM` param routes `fm` into the accumulator instead (`sawIncrementExpr`, with the
 * bidirectional wrap and signed `polyblep_saw`). square/pulse/triangle would each need their own
 * multi-edge BLEP rework for that -- not done.
 *
 * `pm_wrap` loops rather than using one conditional: `FM_DEPTH` reaches 2.0 cycles, so the phase
 * can overshoot `[0,1)` by more than a full cycle; the loop is exact and runs a few iterations at
 * most. History: docs/HISTORY.md.
 */
export const PM_WRAP_HELPER: HelperBlock = {
  key: 'pm_wrap',
  code: `  static float pm_wrap(float p)
  {
    while (p >= 1.f) p -= 1.f;
    while (p < 0.f) p += 1.f;
    return p;
  }
`
}

/**
 * Unlike `pitch`/`width`/`rate`, whose depth was DERIVED from an already-declared param's own range, FM has no existing param
 * to reuse -- real FM synthesis always exposes modulation index/depth as its own primary,
 * directly-tunable control (unlike a secondary vibrato-style modulation amount), so a fresh
 * param is the right call here, not a fixed derived constant. Range chosen in cycle-normalized
 * phase units (this primitive's own domain, `[0,1)` = one full cycle = 2*pi radians): `0..2.0`
 * covers a REAL modulation index of `0..~12.6` radians, already well past what most musical FM
 * patches use, up to genuinely harsh/extreme inharmonic tones at the top of the dial. Defaults
 * to 0 (no effect even once something's wired) -- unlike `WIDTH`/`RATE`/`CUTOFF`, FM_DEPTH isn't
 * the oscillator's own primary control, so there's no "never silently mute" concern requiring a
 * nonzero default; 0 is the safe, unsurprising choice (same reasoning as `COARSE`/`FINE`'s own
 * 0-default = "no additional effect").
 *
 * `fmDepthPercent_<suffix>` stores the RAW 0-100 percent (the `*0.02f` conversion to cycle units
 * moved to point-of-use in `fmPhaseExpr` below) -- same "store raw, convert at point of use"
 * shape as `WIDTH`/`RATE` (phase 8), needed here for the exact same reason: a wired `fmDepth`
 * inlet (below) adds to this in the SAME raw percent domain, before that conversion happens.
 *
 * On `logue/osc/saw` specifically, this SAME dial means a genuinely different physical quantity
 * depending on `TZFM`: cycles of phase offset (`*0.02f`, this comment's own range above) when
 * off, or multiples of `w0` (`*TZFM_DEPTH_PER_PERCENT`, see `sawIncrementExpr`'s own doc comment)
 * once on. Flipping `TZFM` on an already-tuned patch silently rescales its own FM_DEPTH value --
 * the same disclosed-rescale shape `logue/filter/comb`'s own `TRACK` already has for `CUTOFF`.
 */
export const FM_DEPTH_PARAM: PrimitiveParamSpec = {
  name: 'FM_DEPTH',
  modulatedBy: { inlet: 'fmDepth', shape: 'additive' },
  min: 0,
  max: 100,
  default: 0,
  setStatement: (suffix, valueExpr) => `fmDepthPercent_${suffix} = ${valueExpr};`
}

/**
 * A full `+-1` swing from a wired `fmDepth` inlet maps to `+-50` percentage points -- half of
 * `FM_DEPTH`'s own declared `0-100` range, the SAME "half of the param's own range" rule
 * `WIDTH_INLET_DEPTH`/`RATE_INLET_DEPTH` already use (see this file's module doc comment
 * section on depth-derivation). Real motivation: an envelope routed into an FM operator's own
 * depth/index is one of the most common real FM-synthesis techniques (the classic decaying-
 * brightness "pluck"/bell patch) -- this makes that wireable without a second, separate
 * mechanism from `pitch`/`width`/`rate`'s own additive-and-clamped shape.
 */
export const FM_DEPTH_INLET_DEPTH = 50

/**
 * The phase argument every oscillator's `renderExpr` reads -- `phase_<suffix>` unwired, or
 * phase-modulated-and-wrapped when a wire feeds `fm` (see `PM_WRAP_HELPER`'s own doc comment).
 * Deliberately separate from `transposedW0Expr`: FM modulates the phase a waveform generator
 * READS, never the phase increment `advanceStatement` accumulates.
 *
 * The DEPTH itself (how strongly `fm`'s value shifts phase) is resolved here too: a wired
 * `fmDepth` inlet adds to `FM_DEPTH`'s own raw percent value (clamped to `[0,100]`), matching
 * `width`/`rate`'s own additive-not-replacing inlet shape, before the `*0.02f` conversion to
 * cycle-normalized units. `fmDepth` only matters when `fm` is ALSO wired -- with no modulator
 * signal, there's nothing for any depth value to scale, wired or not.
 *
 * @param gateOffWhen a raw C++ boolean expression; when given, this PM term only applies when
 * it evaluates false (returning the plain `phase_<suffix>` instead when true). Exists ONLY for
 * `logue/osc/saw`'s own `TZFM` mode switch, so `fm` drives EITHER phase modulation OR the
 * frequency accumulator (`sawIncrementExpr`), never both -- every other oscillator calls this
 * with two arguments and gets exactly the plain-PM behavior above, unchanged.
 */
export function fmPhaseExpr(
  suffix: string,
  inlets: Record<string, string | undefined>,
  gateOffWhen?: string
): string {
  if (inlets.fm === undefined) return `phase_${suffix}`
  const depth =
    inlets.fmDepth !== undefined
      ? `${additiveInletExpr('fmDepthPercent', suffix, inlets.fmDepth, FM_DEPTH_INLET_DEPTH)} * 0.02f`
      : `fmDepthPercent_${suffix} * 0.02f`
  const pmTerm = `pm_wrap(phase_${suffix} + (${inlets.fm}) * (${depth}))`
  return gateOffWhen === undefined ? pmTerm : `(${gateOffWhen} ? phase_${suffix} : ${pmTerm})`
}

/**
 * Shared two-segment PolyBLEP discontinuity correction (Valimaki & Huovilainen), the same
 * technique phase 1's hand-written `axomodern-poc1` validated on real hardware -- `t` is the
 * oscillator's own phase in [0,1), `dt` is the phase increment per sample.
 */
const POLYBLEP_HELPER: HelperBlock = {
  key: 'polyblep',
  code: `  static float polyblep(float t, float dt)
  {
    if (dt <= 0.f) return 0.f;
    if (t < dt)
    {
      t /= dt;
      return t + t - t * t - 1.f;
    }
    else if (t > 1.f - dt)
    {
      t = (t - 1.f) / dt;
      return t * t + t + t + 1.f;
    }
    return 0.f;
  }
`
}

/**
 * `dt` is a SIGNED phase velocity, for `logue/osc/saw`'s TZFM mode (`sawIncrementExpr`). For
 * `0 <= dt <= 0.5` (every non-TZFM case) `width`/`sign` reduce to `dt`/`1.f`, i.e. the plain
 * `(2*phase-1) - polyblep(phase, dt)`. A negative `dt` crosses the saw's single edge backward,
 * so the correction is the same one mirrored.
 *
 * The `width > 0.5f` clamp is needed: past 0.5 `polyblep`'s two windows `[0,dt)` and `[1-dt,1)`
 * overlap and every sample gets corrected (a sweep at unclamped dt 0.7/1.0/1.3 gave wild peaks,
 * vs. a stable ~0.24 clamped). Plain pitch near MIDI 127 could already reach it.
 *
 * Disclosed, not fixed: the correction's peak tapers as `dt` grows (dt 0.01 -> 0.98, 0.1 -> 0.80,
 * 0.26 -> 0.545, the last being a plain saw at note 127). TZFM makes those `dt` values reachable
 * at ordinary notes at high `FM_DEPTH`; changing it means redesigning `polyblep` for the whole
 * registry. History: docs/HISTORY.md.
 */
export const POLYBLEP_SAW_HELPER: HelperBlock = {
  key: 'polyblep_saw',
  dependsOn: ['polyblep'],
  code: `  static float polyblep_saw(float phase, float dt)
  {
    float width = dt < 0.f ? -dt : dt;
    if (width > 0.5f) width = 0.5f;
    float sign = dt < 0.f ? -1.f : 1.f;
    return (2.f * phase - 1.f) - sign * polyblep(phase, width);
  }
`
}

export const POLYBLEP_SQUARE_HELPER: HelperBlock = {
  key: 'polyblep_square',
  dependsOn: ['polyblep'],
  code: `  static float polyblep_square(float phase, float dt)
  {
    float value = (phase < 0.5f) ? 1.f : -1.f;
    value += polyblep(phase, dt);
    float falling_edge_phase = phase + 0.5f;
    if (falling_edge_phase >= 1.f) falling_edge_phase -= 1.f;
    value -= polyblep(falling_edge_phase, dt);
    return value;
  }
`
}

/**
 * Backs `logue/env/ad`'s `ATTACK`/`DECAY` -- called from its `renderExpr` (via `envRateExpr`),
 * per sample, NOT from the params' own `setStatement`s: phase 20 made both controls wireable,
 * and a wired value has to be added in the same raw PERCENT units the user dials before this
 * nonlinear percent-to-per-sample-increment conversion happens (same "store raw, convert at
 * point of use" move `WIDTH`/`RATE`/`FM_DEPTH`/`DRIVE` all made for the same reason). Passed as
 * one of `logue/env/ad`'s independent direct `.helpers` (see `LoguePrimitive.helpers`'s own doc
 * comment on why an array), so it needs no `HELPER_REGISTRY` entry of its own -- same as
 * `polyblep_pulse` below, never registered either since nothing reaches either of them via a
 * `dependsOn` chain.
 */
// This formula's own 5/1995 constants are mirrored in `paramUnits.ts`'s `envMsUnit` (for the
// canvas dial's ms/s display) -- changing them here without updating that mirror silently breaks
// the display's own accuracy without failing any check that runs the real generated C++.
export const ENV_RATE_HELPER: HelperBlock = {
  key: 'env_rate_from_percent',
  code: `  // Deliberately no libm (expf/logf) -- see logue/filter/lowpass-cheap's own doc comment on why
  // this project avoids pulling frequency/time-constant math into generated code for code-size
  // reasons. Maps a plain 0-100 percent to a per-sample increment covering a fixed, made-up-but-
  // reasonable 5ms-2000ms range at the platform's real fixed 48kHz sample rate -- not calibrated
  // to any particular real envelope hardware, just a real, audible, monotonic attack/decay sweep.
  static float env_rate_from_percent(float percent)
  {
    float t = percent * 0.01f;
    float ms = 5.f + t * 1995.f;
    float samples = ms * 0.001f * 48000.f;
    if (samples < 1.f) samples = 1.f;
    return 1.f / samples;
  }
`
}

const HELPER_REGISTRY: Record<string, HelperBlock> = {
  polyblep: POLYBLEP_HELPER,
  polyblep_saw: POLYBLEP_SAW_HELPER,
  polyblep_square: POLYBLEP_SQUARE_HELPER
}

export function resolveHelperChain(direct: HelperBlock[]): HelperBlock[] {
  const seen = new Map<string, HelperBlock>()
  const visit = (block: HelperBlock): void => {
    if (seen.has(block.key)) return
    seen.set(block.key, block)
    for (const depKey of block.dependsOn ?? []) {
      const dep = HELPER_REGISTRY[depKey]
      if (dep) visit(dep)
    }
  }
  direct.forEach(visit)
  return Array.from(seen.values())
}

/**
 * A full `+-1` swing from a wired `width` inlet maps to `+-50` percentage points -- half of
 * `WIDTH`'s own declared `0-100` range (a full swing from a centered base spans the param's
 * entire range; from an off-center base it clips asymmetrically at one rail first -- a real,
 * disclosed consequence of an uncentered base, not a bug). See this file's module doc comment
 * section on depth-derivation for the general rule.
 */
export const WIDTH_INLET_DEPTH = 50

/** A `rate` inlet's depth on a 0-100 RATE: a full `+-1` swing is `+-50` points. */
export const RATE_INLET_DEPTH = 50

export const ONEPOLE_HELPER: HelperBlock = {
  key: 'onepole_step',
  code: `  static float onepole_step(float *z1, float x, float a)
  {
    float aClamped = a;
    if (aClamped < 0.f) aClamped = 0.f;
    else if (aClamped > 1.f) aClamped = 1.f;
    float y = *z1 + aClamped * (x - *z1);
    *z1 = y;
    return y;
  }
`
}

/**
 * Warps a raw 0..1 cutoff value (from the `CUTOFF` param OR a wired `cutoff` inlet -- see
 * `lowpassCheapFilterPrimitive`'s own doc comment) before it's used as the one-pole's `a`
 * coefficient. Plain cube, no libm: cheap (two multiplies), monotonic, hits the same 0/1
 * endpoints as an unwarped value (so `CUTOFF=0`/`100` still mean fully closed/open exactly as
 * before), but spreads the *audible* sweep across the control's full travel instead of
 * concentrating nearly all of it in the bottom ~10% -- see the primitive's own doc comment for
 * why a linear `a` is audibly steppy in the first place. Not a frequency-accurate correction
 * (that needs `expf`, the exact cost this primitive was built to avoid) -- just a curve shaped
 * to feel more even, confirmed by ear via the real `run-desktop`/harness verification, not
 * derived from a formula.
 */
export const CUTOFF_WARP_HELPER: HelperBlock = {
  key: 'cutoff_warp',
  code: `  static float cutoff_warp(float t)
  {
    if (t < 0.f) t = 0.f;
    else if (t > 1.f) t = 1.f;
    return t * t * t;
  }
`
}

/**
 * Codegen-time-only (never runs on-device) FNV-1a 32-bit hash of an instance's own suffix --
 * bakes a per-instance-unique LCG seed literal into `noisePrimitive`'s `initStatement` below, so
 * two simultaneously-placed noise instances (e.g. one randomizing pitch, another randomizing
 * filter cutoff) don't emit perfectly-correlated sequences. Deterministic (same suffix always
 * hashes the same way, so a saved patch reopens with the exact same noise sequence) -- no true
 * randomness/clock dependency needed or wanted here.
 */
export function hashSuffixToSeed(suffix: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < suffix.length; i++) {
    hash ^= suffix.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0 || 1
}

/**
 * A plain LCG white noise source (Numerical Recipes constants, no libm, one `uint32_t` of state);
 * the 32-bit result is reinterpreted as signed and scaled to about `[-1,1)`. The seed advances
 * inside `noise_step`, called from `renderExpr` (`advanceStatement` a no-op), like `onepole_step`:
 * there is no independently advanceable state, just a value that changes each time it's read.
 * `logue/osc/noise` lives in `osc` because a zero-input source reads as an oscillator in the
 * palette, even with no pitch/phase machinery. Its COLOR select builds the coloured noises on the
 * same LCG (`NOISE_COLOR_STEP_HELPER`); level control is a `logue/gain/vca`. History:
 * docs/HISTORY.md.
 */
export const NOISE_STEP_HELPER: HelperBlock = {
  key: 'noise_step',
  code: `  static float noise_step(uint32_t *seed)
  {
    *seed = *seed * 1664525u + 1013904223u;
    return (float)(int32_t)(*seed) * (1.f / 2147483648.f);
  }
`
}

// `t^4` rather than `lfo_rate_from_percent`'s `t^3`: 0.1Hz-2kHz is ~14 octaves, and a linear
// dial would put everything below ~20Hz into the first 1% of travel. A power curve (not
// `exp_approx`) keeps it divide-free and lets `paramUnits.ts`'s `fastLfoHzUnit` mirror it exactly
// -- keep the two in sync.
export const FAST_LFO_RATE_HELPER: HelperBlock = {
  key: 'fast_lfo_rate_from_percent',
  code: `  static float fast_lfo_rate_from_percent(float percent)
  {
    float t = percent * 0.01f;
    float t2 = t * t;
    float hz = 0.1f + t2 * t2 * 1999.9f;
    // Not "hz / 48000.f": without -ffast-math GCC keeps that as a real divide (14 cycles on
    // the xd's M4), and this runs per sample per LFO per voice.
    return hz * (1.f / 48000.f);
  }
`
}

/**
 * The on/off threshold for every two-state switch the DSP reads (comb/svf/fast-square `TRACK`,
 * saw `TZFM`), one constant so they can't drift apart. It is 1, not the midpoint 50, so the DSP
 * agrees with NTS-1 mkII's `k_unit_param_type_onoff` display (0 = OFF, anything else = ON); a
 * document with a value in 1..49 reads as on. Used only inside codegen functions, so it may be
 * defined below `sawIncrementExpr`.
 */
export const TRACK_ON_RAW_THRESHOLD = TRACK_ON_THRESHOLD

/**
 * A value that's constant for a whole block unless one of `inputs` is wired: then `ref` is `expr`
 * itself, evaluated per sample; otherwise `ref` names a local that `decl` computes once before
 * the loop (see `LoguePrimitive.blockConstants`). Params and the note only change between blocks,
 * so the per-sample result is identical either way.
 */
export interface BlockValue {
  ref: string
  decl?: { name: string; expr: string }
}

/**
 * The wired-inlet variables that hold a per-block value while a unit is generated: the outputs
 * of instances `oscBody.ts` computes once per block (`hoistedSuffixes`). Set only for the
 * duration of `withBlockInvariantVars`; empty otherwise, so outside generation every wired inlet
 * counts as per-sample.
 */
let blockInvariantVars: ReadonlySet<string> = new Set()

export function withBlockInvariantVars<T>(vars: ReadonlySet<string>, fn: () => T): T {
  const previous = blockInvariantVars
  blockInvariantVars = vars
  try {
    return fn()
  } finally {
    blockInvariantVars = previous
  }
}

/** Unwired, or wired from a per-block value: either way constant for the whole block. */
export function isBlockInvariant(input: string | undefined): boolean {
  return input === undefined || blockInvariantVars.has(input)
}

export function blockValue(
  name: string,
  suffix: string,
  expr: string,
  inputs: (string | undefined)[]
): BlockValue {
  // A wired input from a per-block value (a knob-only chain) is as constant as an unwired one.
  if (!inputs.every(isBlockInvariant)) return { ref: expr }
  const local = `${name}_${suffix}`
  return { ref: local, decl: { name: local, expr } }
}

/** The declarations of a primitive's `blockValue`s, for its `blockConstants`. */
export function blockDecls(
  values: Record<string, BlockValue>
): Array<{ name: string; expr: string }> {
  return Object.values(values).flatMap((v) => (v.decl ? [v.decl] : []))
}

/**
 * Olli Niemitalo's 8-coefficient Hilbert pair: two chains of four `(c - z^-2)/(1 - c*z^-2)`
 * allpasses, `c` the square of each published value, the first chain delayed a sample. Its output
 * (`q`) then lags the second (`i`) by 90 degrees within +-0.7 from ~25 Hz to 23.9 kHz at 48 kHz
 * (about -44 dB of unwanted sideband in a frequency shifter), 1.6 at 20 Hz (-37 dB), falling
 * apart below ~15 Hz. The published values are squared here at generation time.
 */
const HILBERT_Q_CHAIN = [0.6923878, 0.936065432296, 0.988229522686, 0.9987488452737]
const HILBERT_I_CHAIN = [0.4021921162426, 0.856171088242, 0.9722909545651, 0.9952884791278]

/** State of one `hilbert_step`: 2 x 10 history floats, the q chain's one-sample delay. */
export const HILBERT_STATE_FLOATS = 21

function hilbertChainCode(coefficients: number[], base: number, v: string): string {
  // z^-2 sections keep even and odd samples apart, so each signal between sections needs just
  // one slot per parity: h[base + 2k + p] is section k's input two samples ago, and also the
  // previous section's output then.
  return coefficients
    .map((c, k) => {
      const lit = `${(c * c).toPrecision(9)}f`
      const own = `h[${base + 2 * k} + p]`
      const next = `h[${base + 2 * (k + 1)} + p]`
      return `    y = ${lit} * (${v} + ${next}) - ${own}; ${own} = ${v}; ${v} = y;\n`
    })
    .join('')
    .concat(`    h[${base + 2 * coefficients.length} + p] = ${v};\n`)
}

export const HILBERT_STEP_HELPER: HelperBlock = {
  key: 'hilbert_step',
  code: `  // x as a 90-degree pair (*i, *q) of equal level (see HILBERT_Q_CHAIN in primitives/shared.ts).
  // h holds ${HILBERT_STATE_FLOATS} floats, *parity flips every sample. Always inlined: it is also called from
  // freq_shift_step, and the xd's process must only make leaf calls.
  static inline __attribute__((always_inline)) void hilbert_step(float *h, int *parity, float x, float *i, float *q)
  {
    const int p = *parity;
    *parity = p ^ 1;
    float a = x, b = x, y;
${hilbertChainCode(HILBERT_Q_CHAIN, 0, 'a')}${hilbertChainCode(HILBERT_I_CHAIN, 10, 'b')}    *q = h[20];
    h[20] = a;
    *i = b;
  }
`
}

/**
 * A sound source's LEVEL (`LEVEL_DB`): the gain is worked out once per block, exactly 1 at the
 * default 100 (so a patch that never touches it renders bit-identically) and 0 at 0, else
 * `exp_approx` of the dB in natural-log units (libm-free; its own comment checks x in [-3, 0],
 * but over LEVEL's x in [-5.5, 0] it is at worst 0.015 dB off, at LEVEL 1).
 */
export const LEVEL_PARAM: PrimitiveParamSpec = {
  name: 'LEVEL',
  unit: LEVEL_DB,
  min: 0,
  max: 100,
  default: 100,
  setStatement: (suffix, valueExpr) => `levelPercent_${suffix} = ${valueExpr};`
}

export function levelGain(suffix: string): BlockValue {
  const perStep = ((LEVEL_RANGE_DB / 100) * Math.log(10)) / 20
  const v = `levelPercent_${suffix}`
  return blockValue(
    'blkLevel',
    suffix,
    `(${v} >= 100.f ? 1.f : ${v} <= 0.f ? 0.f : exp_approx((${v} - 100.f) * ${perStep.toPrecision(8)}f))`,
    []
  )
}

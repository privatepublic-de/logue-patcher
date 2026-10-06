import {
  DRIVE_DB,
  DRIVE_RANGE_DB,
  DRIVE_TONE,
  SOFTCLIP_DRIVE_DB,
  WAVEFOLDER_DRIVE_DB
} from '../paramPresentation'
import type { HelperBlock, LoguePrimitive } from './types'
import {
  CLAMPF_HELPER,
  EXP_APPROX_HELPER,
  LEVEL_PARAM,
  additiveInletExpr,
  blockDecls,
  blockValue,
  isBlockInvariant,
  levelGain,
  type BlockValue
} from './shared'

/**
 * A full `+-1` swing from a wired `drive` inlet maps to `+-50` percentage points -- half of
 * `DRIVE`'s own declared `0-100` range, the SAME "half of the param's own range" rule
 * `WIDTH_INLET_DEPTH`/`RATE_INLET_DEPTH`/`FM_DEPTH_INLET_DEPTH` already use. Shared by both
 * `wavefolderPrimitive` and `saturatorPrimitive` below -- both declare `DRIVE` with the
 * identical `0-100` range, so one constant covers both.
 */
const DRIVE_INLET_DEPTH = 50

/**
 * The pre-gain applied before either shaper's nonlinearity -- `DRIVE`'s own raw percent
 * (`drivePercent_<suffix>`, additively modulated by a wired `drive` inlet exactly like `width`/
 * `rate`/`fmDepth`'s own shape: add, scale by `DRIVE_INLET_DEPTH`, clamp to `[0,100]`) times
 * `gainPerPercent` (each primitive's own ceiling -- see their individual doc comments for why
 * the two differ), plus the fixed `1.0` baseline so `DRIVE=0` means "no extra gain," not "zero
 * gain." Shared by both primitives below since the wiring shape is identical, only the ceiling
 * constant differs.
 */
function driveGainExpr(
  suffix: string,
  inlets: Record<string, string | undefined>,
  gainPerPercent: number
): string {
  const percent =
    inlets.drive !== undefined
      ? additiveInletExpr('drivePercent', suffix, inlets.drive, DRIVE_INLET_DEPTH)
      : `drivePercent_${suffix}`
  return `1.f + (${percent}) * ${gainPerPercent}f`
}

/**
 * A mirror/triangle wavefolder -- phase 13, the first new primitive under a NEW `shape`
 * category (the id's own middle path segment, same "no palette table to keep in sync" scheme
 * every other category already uses). Genuinely new timbral territory for this registry:
 * everything before this either sums/multiplies signals or subtracts frequency content
 * (filters) -- this is the first true nonlinear WAVESHAPER. Deliberately a FOLD, not a plain
 * soft clip (see `saturatorPrimitive` below for that instead): a signal that exceeds `+-1`
 * reflects back on itself rather than clamping, producing non-monotonic, harmonically rich,
 * classic "west coast"/Buchla-style timbres a clip/filter/mix combination can't reach.
 *
 * `wavefold`'s `while`-loop mirror is exact for any input magnitude (same shape as `pm_wrap`'s
 * own loop-based wrap, same reasoning: a single up/down conditional isn't enough once `DRIVE`
 * pushes the pre-gained signal more than one reflection past `+-1`), no libm anywhere. `DRIVE`
 * (0-100 percent, default 0) is a pre-gain applied BEFORE folding -- `1.0` (no extra gain) at
 * 0, up to `8.0` at 100, chosen so a full-scale oscillator input reliably folds multiple times
 * at the top of the dial rather than needing to already be over-driven upstream to hear
 * anything. At `DRIVE=0` a normalized (`|x|<=1`) input never reaches the fold at all, so this
 * IS a true, exact passthrough at its default -- unlike `saturatorPrimitive`'s curve below.
 *
 * A wired `drive` inlet (phase 14, added right after this primitive's own first landing) adds
 * to `DRIVE`'s own value via `driveGainExpr` above -- the classic "envelope/LFO drives fold
 * amount over time" technique, same motivation as phase 12's wireable `FM_DEPTH`.
 */
const WAVEFOLD_HELPER: HelperBlock = {
  key: 'wavefold',
  code: `  static float wavefold(float x)
  {
    while (x > 1.f || x < -1.f)
    {
      if (x > 1.f) x = 2.f - x;
      else if (x < -1.f) x = -2.f - x;
    }
    return x;
  }
`
}

export const wavefolderPrimitive: LoguePrimitive = {
  id: 'logue/shape/wavefolder',
  outletPolarity: 'inherit',
  stateBytesPerInstance: 4, // drivePercent_, 1 float
  description:
    'Folds a signal back on itself past +-1 for west-coast/Buchla-style non-monotonic harmonics.',
  inlets: [
    { name: 'in', role: 'audio' },
    { name: 'drive', role: 'control' }
  ],
  memberDecls: (suffix) => `  float drivePercent_${suffix};\n`,
  // This 0.07 gain-per-percent is mirrored in `paramUnits.ts`'s `WAVEFOLDER_DRIVE_DB` (for the
  // canvas dial's dB display) -- changing it without updating that mirror silently breaks the
  // display's own accuracy.
  renderExpr: (suffix, inlets) =>
    `wavefold((${inlets.in ?? '0.f'}) * (${driveGainExpr(suffix, inlets, 0.07)}))`,
  advanceStatement: () => '',
  helpers: [WAVEFOLD_HELPER, CLAMPF_HELPER],
  params: [
    {
      name: 'DRIVE',
      unit: WAVEFOLDER_DRIVE_DB,
      modulatedBy: { inlet: 'drive', shape: 'additive' },
      min: 0,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `drivePercent_${suffix} = ${valueExpr};`
    }
  ]
}

/**
 * A soft-clip saturator -- the gentler, monotonic sibling to `wavefolderPrimitive` above.
 * `x / (1 + |x|)` is a cheap, well-known rational approximation of a `tanh`-shaped saturation
 * curve (no libm -- just `fabsf`, the same "cheap intrinsic, not a real libm cost" precedent
 * `triangleOscPrimitive` already established) -- asymptotically approaches `+-1`, NEVER folds
 * back the way `wavefolderPrimitive` does, closer to warm analog overdrive than a Buchla-style
 * fold.
 *
 * Unlike the wavefolder, `DRIVE=0` here is NOT an exact passthrough -- the curve applies SOME
 * gentle rounding at any gain (`x/(1+|x|)` only equals `x` at `x=0`), a real, permanent, and
 * disclosed character of this shape, matching how most real analog "soft clip" stages also
 * color the signal somewhat even at their most transparent setting, not a bug to engineer
 * around with an extra dry/wet blend this phase doesn't need. `DRIVE` (0-100 percent, default
 * 0) is the same pre-gain-before-the-nonlinearity shape as `wavefolderPrimitive`'s own, `1.0`
 * to `10.0` -- a higher ceiling than the folder's `8.0` since this curve saturates smoothly
 * rather than folding, so it needs more pre-gain to sound obviously "driven."
 *
 * Also gains a wired `drive` inlet, same shape/motivation as the wavefolder's own (see its
 * comment) via the SAME shared `driveGainExpr`, just with this primitive's own `0.09` ceiling.
 */
const SATURATOR_HELPER: HelperBlock = {
  key: 'soft_clip',
  code: `  static float soft_clip(float x)
  {
    return x / (1.f + fabsf(x));
  }
`
}

export const saturatorPrimitive: LoguePrimitive = {
  id: 'logue/shape/soft-clip',
  outletPolarity: 'inherit',
  stateBytesPerInstance: 4, // drivePercent_, 1 float
  description: 'A soft, rational saturation curve for gentle warmth and drive.',
  inlets: [
    { name: 'in', role: 'audio' },
    { name: 'drive', role: 'control' }
  ],
  memberDecls: (suffix) => `  float drivePercent_${suffix};\n`,
  // This 0.09 gain-per-percent is mirrored in `paramUnits.ts`'s `SOFTCLIP_DRIVE_DB` (for the
  // canvas dial's dB display) -- changing it without updating that mirror silently breaks the
  // display's own accuracy.
  renderExpr: (suffix, inlets) =>
    `soft_clip((${inlets.in ?? '0.f'}) * (${driveGainExpr(suffix, inlets, 0.09)}))`,
  advanceStatement: () => '',
  helpers: [SATURATOR_HELPER, CLAMPF_HELPER],
  params: [
    {
      name: 'DRIVE',
      unit: SOFTCLIP_DRIVE_DB,
      modulatedBy: { inlet: 'drive', shape: 'additive' },
      min: 0,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `drivePercent_${suffix} = ${valueExpr};`
    }
  ]
}

/** TONE's tilt turns around this corner: the one-pole's coefficient for 800 Hz at 48 kHz. */
const DRIVE_TONE_HZ = 800
const DRIVE_TONE_COEFF = 1 - Math.exp((-2 * Math.PI * DRIVE_TONE_HZ) / 48000)
/** DRIVE's dB per percent, in natural-log units: half of it is `exp_approx`'s argument. */
const DRIVE_HALF_LN_PER_PERCENT = ((DRIVE_RANGE_DB / 100) * Math.log(10)) / 20 / 2

const DRIVE_STEP_HELPER: HelperBlock = {
  key: 'drive_step',
  code: `  // Pre-gain, the cubic soft clip (x - 4x^3/27, reaching 1 with zero slope at 1.5; no divide),
  // then TONE's tilt: the clipped signal split by a one-pole at ${DRIVE_TONE_HZ} Hz, its highs weighted
  // by hi and its lows by hi + d (both with the makeup and LEVEL folded in). At TONE 50, d is 0
  // and the tilt is exactly the clipped signal times hi. A leaf.
  static inline __attribute__((always_inline)) float drive_step(float *z, float x, float pre, float hi, float d)
  {
    x *= pre;
    x = x < -1.5f ? -1.5f : (x > 1.5f ? 1.5f : x);
    x = x - 0.148148148f * x * x * x;
    const float lp = *z + ${DRIVE_TONE_COEFF.toPrecision(8)}f * (x - *z);
    *z = lp;
    return x * hi + lp * d;
  }
  // A moving TONE (percent, clamped here): below 50 the highs fade out, above it the lows.
  static inline __attribute__((always_inline)) float drive_step_t(float *z, float x, float pre, float post, float t)
  {
    t = t < 0.f ? 0.f : (t > 100.f ? 100.f : t);
    const float hi = t < 50.f ? t * 0.02f : 1.f;
    const float lo = t > 50.f ? (100.f - t) * 0.02f : 1.f;
    return drive_step(z, x, pre, hi * post, (lo - hi) * post);
  }
  // A moving DRIVE at control rate: every 16th call works out h = exp(dB / 2), the pre-gain h^2
  // and the makeup level / h (c[0], c[1]); both ramp there over the 16 (c[2], c[3] the steps),
  // since a stepped gain zippers. The very first call jumps. Per sample, the exp_approx and the
  // divide were most of a moving drive's cost.
  static inline __attribute__((always_inline)) void drive_ctl(uint32_t *n, float *c, float drivePercent, float level)
  {
    if ((*n & 15u) == 0u)
    {
      const float h = exp_approx(drivePercent * ${DRIVE_HALF_LN_PER_PERCENT.toPrecision(8)}f);
      const float pre = h * h;
      const float post = level / h;
      if (*n == 0u) { c[0] = pre; c[1] = post; }
      c[2] = (pre - c[0]) * 0.0625f;
      c[3] = (post - c[1]) * 0.0625f;
    }
    (*n)++;
    c[0] += c[2];
    c[1] += c[3];
  }
`
}

/** A wired `tone` sweeps the whole tilt (depth 50 = half its range: +-1 reaches both ends). */
const DRIVE_TONE_INLET_DEPTH = 50

/**
 * What a `drive` instance computes per block and the call its loop makes. DRIVE's
 * `h = exp(dB / 2)` gives the pre-gain `h^2` and the makeup `1/h` (half the drive taken back, so a
 * signal driven into the clip stays about as loud as it came in). With both inputs still,
 * everything down to the tilt's two weights is a block constant (`drive_step`); a moving `tone`
 * re-weights per sample (`drive_step_t`, a clamp and a few multiplies); a moving `drive` works out
 * its two gains every 16 samples and ramps them (`drive_ctl`, then `drive_step_t`).
 */
function driveCode(
  suffix: string,
  inlets: Record<string, string | undefined>
): { values: Record<string, BlockValue>; call: string } {
  const x = inlets.in ?? '0.f'
  const level = levelGain(suffix)
  const drivePercent =
    inlets.drive !== undefined
      ? additiveInletExpr('drivePercent', suffix, inlets.drive, DRIVE_INLET_DEPTH)
      : `drivePercent_${suffix}`
  const h = blockValue(
    'blkDriveH',
    suffix,
    `exp_approx((${drivePercent}) * ${DRIVE_HALF_LN_PER_PERCENT.toPrecision(8)}f)`,
    [inlets.drive]
  )
  const toneMoving = !isBlockInvariant(inlets.tone)
  const tone =
    inlets.tone === undefined
      ? `tonePercent_${suffix}`
      : toneMoving
        ? `tonePercent_${suffix} + (${inlets.tone}) * ${DRIVE_TONE_INLET_DEPTH}.f`
        : additiveInletExpr('tonePercent', suffix, inlets.tone, DRIVE_TONE_INLET_DEPTH)
  if (!h.decl) {
    const c = `driveC_${suffix}`
    return {
      values: { level },
      call:
        `(drive_ctl(&driveCtl_${suffix}, ${c}, ${drivePercent}, ${level.ref}), ` +
        `drive_step_t(&z_${suffix}, ${x}, ${c}[0], ${c}[1], ${tone}))`
    }
  }
  const pre = blockValue('blkDrivePre', suffix, `${h.ref} * ${h.ref}`, [])
  const post = blockValue('blkDrivePost', suffix, `${level.ref} / ${h.ref}`, [])
  if (toneMoving) {
    return {
      values: { level, h, pre, post },
      call: `drive_step_t(&z_${suffix}, ${x}, ${pre.ref}, ${post.ref}, ${tone})`
    }
  }
  const hiW = `((${tone}) < 50.f ? (${tone}) * 0.02f : 1.f)`
  const loW = `((${tone}) > 50.f ? (100.f - (${tone})) * 0.02f : 1.f)`
  const hi = blockValue('blkDriveHi', suffix, `${hiW} * ${post.ref}`, [])
  const d = blockValue('blkDriveD', suffix, `(${loW} - ${hiW}) * ${post.ref}`, [])
  return {
    values: { level, h, pre, post, hi, d },
    call: `drive_step(&z_${suffix}, ${x}, ${pre.ref}, ${hi.ref}, ${d.ref})`
  }
}

/**
 * `logue/shape/drive`: a light saturator with a tone control, for grit on an effect's input or a
 * voice (2026-10-05, after the Radio patch used wavefolder + two one-poles for it and sat close
 * to the xd's CPU limit next to other effects).
 *
 * - DRIVE is 0..+36 dB of pre-gain, linear in dB: an effect's input is quiet (~0.18 peak for a
 *   saw on NTS-1 mkII), so it takes ~+15 dB to reach the clip at all. Half of it is taken back
 *   after the clip, so driving harder adds grit more than level.
 * - The curve is the cubic soft clip bass-support and the ladder use: no divide (`soft-clip`'s
 *   `x/(1+|x|)` costs one a sample), clean for small signals, odd harmonics only.
 * - TONE tilts the clipped signal around ${DRIVE_TONE_HZ} Hz with one one-pole: 0 is a 6 dB/oct lowpass
 *   there, 50 exactly flat, 100 the matching highpass (thin, telephone/radio). The weights are
 *   just gains, so a moving `tone` costs a clamp and a few multiplies, not a filter coefficient.
 * - LEVEL is the noise sources' (dB, 100 = 0 dB).
 * - Unwired, every gain is a block constant: per sample it is a multiply, the clip, the one-pole
 *   and two multiply-adds (`driveCode` has the moving cases).
 */
export const drivePrimitive: LoguePrimitive = {
  id: 'logue/shape/drive',
  outletPolarity: 'inherit',
  // z_ + drivePercent_ + tonePercent_ + levelPercent_ + driveCtl_ + driveC_[4] (driveCtl_/driveC_
  // only used while `drive` moves), 9 words
  stateBytesPerInstance: 36,
  description:
    'A light saturator with a tone control: DRIVE pushes the signal into a soft clip (half the gain is taken back after it), TONE tilts the result from dark through flat to thin, LEVEL sets the output.',
  searchTerms: ['saturation', 'saturator', 'overdrive', 'distortion', 'grit', 'tone'],
  inlets: [
    { name: 'in', role: 'audio' },
    { name: 'drive', role: 'control' },
    { name: 'tone', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  float z_${suffix};\n  float drivePercent_${suffix};\n  float tonePercent_${suffix};\n  float levelPercent_${suffix};\n  uint32_t driveCtl_${suffix};\n  float driveC_${suffix}[4];\n`,
  initStatement: (suffix) =>
    `    z_${suffix} = 0.f;\n    driveCtl_${suffix} = 0;\n    for (int i = 0; i < 4; ++i) driveC_${suffix}[i] = 0.f;\n`,
  blockConstants: (suffix, inlets) => blockDecls(driveCode(suffix, inlets).values),
  renderExpr: (suffix, inlets) => driveCode(suffix, inlets).call,
  advanceStatement: () => '',
  helpers: [DRIVE_STEP_HELPER, EXP_APPROX_HELPER, CLAMPF_HELPER],
  params: [
    {
      name: 'DRIVE',
      unit: DRIVE_DB,
      modulatedBy: { inlet: 'drive', shape: 'additive' },
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `drivePercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'TONE',
      unit: DRIVE_TONE,
      modulatedBy: { inlet: 'tone', shape: 'additive' },
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `tonePercent_${suffix} = ${valueExpr};`
    },
    LEVEL_PARAM
  ]
}

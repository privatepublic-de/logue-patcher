import { PERCENT, STEREO_XFADE_LAWS, STEREO_XFADE_LAW_NAME } from '../paramPresentation'
import type { HelperBlock, LoguePrimitive, PrimitiveParamSpec } from './types'
import {
  CLAMPF_HELPER,
  additiveInletExpr,
  blockDecls,
  blockValue,
  isBlockInvariant,
  type BlockValue
} from './shared'

/**
 * The first non-oscillator primitive, and deliberately the minimal object needed to prove real
 * multi-inlet wiring. Averages rather than sums, found necessary (not a style choice) by
 * actually running the generated code through the host-native harness: two identical, in-phase
 * full-scale sources (e.g. two saws) summed unscaled clip HARD (`f32_to_q31` pinned at the
 * `0.999f` headroom ceiling on nearly every sample, confirmed via a real ASan/UBSan harness run,
 * 2026-09-17) -- `clip1m1f` at the platform generator's own output line stops that from being
 * undefined behavior, but clipping is real audible distortion, not "handled." Halving keeps two
 * full-scale correlated sources within range at the cost of headroom when sources are
 * uncorrelated -- the standard, conservative default tradeoff a simple 2-input mixer makes
 * (axoloti-factory's own `mix 2` is the plain-sum sibling to a `mix 2 sq` equal-power variant;
 * this project doesn't have a real need for the plain-sum variant yet, so only the safer default
 * was built -- add a sibling if a real graph needs the extra headroom back). Either inlet left
 * unwired reads as silence (`0.f`) rather than an error -- an unpatched mixer input is a normal,
 * expected state (matches axoloti-factory's own `mix N` family convention), not a defect.
 *
 * `GAIN1`/`GAIN2` replace the
 * fixed `* 0.5` with two independent per-input gains -- default `50`/`50` reproduces the exact
 * prior averaging behavior, so this is additive to the registry, not a behavior change for
 * anyone who never touches the new params. Plain params, not wireable inlets -- the user asked
 * for "two controls" here, not modulation.
 */
export const mixer2Primitive: LoguePrimitive = {
  id: 'logue/mix/mix2',
  pure: true,
  outletPolarity: 'inherit',
  stateBytesPerInstance: 8, // gain1_ + gain2_, 2 floats
  description: 'Sums two audio signals, each with its own independent input gain.',
  inlets: [
    { name: 'in1', role: 'audio' },
    { name: 'in2', role: 'audio' }
  ],
  memberDecls: (suffix) => `  float gain1_${suffix};\n  float gain2_${suffix};\n`,
  renderExpr: (suffix, inlets) =>
    `(((${inlets.in1 ?? '0.f'}) * gain1_${suffix}) + ((${inlets.in2 ?? '0.f'}) * gain2_${suffix}))`,
  advanceStatement: () => '',
  params: [
    {
      name: 'GAIN1',
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `gain1_${suffix} = ${valueExpr} * 0.01f;`
    },
    {
      name: 'GAIN2',
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `gain2_${suffix} = ${valueExpr} * 0.01f;`
    }
  ]
}

/**
 * The FPU's own square root. Newlib's `sqrtf` sets `errno` for a negative argument, which pulls
 * syscall stubs (`_sbrk`, `_write`, ...) into the minilogue xd's static link and makes it fail --
 * the same failure `string`'s `exp_approx` exists to avoid for `expf`. `vsqrt.f32` is the same
 * correctly-rounded result. Other targets (the host harness) keep `sqrtf`.
 */
const XFADE_SQRTF_HELPER: HelperBlock = {
  key: 'xfade_sqrtf',
  code: `  static inline __attribute__((always_inline)) float xfade_sqrtf(float x)
  {
#if defined(__arm__) && defined(__ARM_FP)
    float r;
    __asm__("vsqrt.f32 %0, %1" : "=t"(r) : "t"(x));
    return r;
#else
    return sqrtf(x);
#endif
  }
`
}

/** A block-rate crossfader gain follows its target with this time constant, in samples (2 ms at
 *  48 kHz), whatever the size of the step. */
const XFADE_SMOOTH_SAMPLES = 96

/**
 * Smoothing for a crossfader's per-block gains: a knob is read once per block, and near the
 * equal-power law's ends one 10-bit knob step is a jump of about -27 dB -- a knob jittering
 * between two values there crackled (user, 2026-10-03). Once per block `xfade_settle` snaps both
 * gains onto their targets when within 1e-5 (-100 dB), so they land exactly, and says whether
 * either is still on its way; only then does the loop run `xfade_glide`, a one-pole of
 * ${XFADE_SMOOTH_SAMPLES} samples. A settled crossfader costs a predictable branch a sample:
 * gliding all the time cost 38 xd emulator cycles. `xfade_settle` is a shared `noinline` leaf
 * (inlined, the two helpers made each instance ~350 B, and an xd modfx has 6 KB); `xfade_glide`
 * stays inlined, as a call inside the loop cost a settled crossfader ~5 more cycles (16 vs 21).
 * A negative gain is init/reset's "not started" mark and takes its target at once.
 */
const XFADE_SLEW_HELPER: HelperBlock = {
  key: 'xfade_slew',
  code: `  // Once per block: snaps each of g[0]/g[1] onto its target when within 1e-5 (or not started,
  // < 0); 1.f while either still has to glide there.
  static __attribute__((noinline)) float xfade_settle(float *g, float a, float b)
  {
    const float da = a - g[0], db = b - g[1];
    const bool aMoving = g[0] >= 0.f && (da > 1e-5f || da < -1e-5f);
    const bool bMoving = g[1] >= 0.f && (db > 1e-5f || db < -1e-5f);
    if (!aMoving) g[0] = a;
    if (!bMoving) g[1] = b;
    return (aMoving || bMoving) ? 1.f : 0.f;
  }
  // Per sample while settling: a one-pole of ${XFADE_SMOOTH_SAMPLES} samples (2 ms at 48 kHz). A leaf.
  static inline __attribute__((always_inline)) float xfade_glide(float *g, float target)
  {
    *g += (target - *g) * ${(1 - Math.exp(-1 / XFADE_SMOOTH_SAMPLES)).toPrecision(6)}f;
    return *g;
  }
`
}

interface CrossfaderMembers {
  fade: string
  law: string
  /** The two slewed gains, `float [2]`. */
  g: string
  /** Prefix of the two per-block gain locals. */
  blk: string
}

const MONO_XFADE: CrossfaderMembers = {
  fade: 'fadePercent',
  law: 'xfLaw',
  g: 'xfG',
  blk: 'blkFade'
}
const STEREO_XFADE: CrossfaderMembers = {
  fade: 'stxFadePercent',
  law: 'stxLaw',
  g: 'stxG',
  blk: 'blkStx'
}

/**
 * Both crossfaders' two gains from the fade percent and LAW (Power: square roots, Linear: the
 * percent itself), once per block while `fade` is unwired or per-block (a dry/wet knob: two square
 * roots per sample were ~3 % of grain-mill's xd CPU, 2026-10-01). In percent, so both ends are
 * exact: `1 - 100 * 0.01f` is not 0 in float, and its square root let ~-72 dB of `in1` through at
 * FADE 100 (harness, 2026-10-03).
 */
function crossfaderBlockValues(
  suffix: string,
  inlets: Record<string, string | undefined>,
  m: CrossfaderMembers
): Record<'a' | 'b', BlockValue> {
  const fade =
    inlets.fade !== undefined
      ? additiveInletExpr(m.fade, suffix, inlets.fade, 100)
      : `${m.fade}_${suffix}`
  const gain = (percent: string): string =>
    `(${m.law}_${suffix} >= 0.5f ? ${percent} * 0.01f : xfade_sqrtf(${percent} * 0.01f))`
  return {
    a: blockValue(`${m.blk}A`, suffix, gain(`(100.f - ${fade})`), [inlets.fade]),
    b: blockValue(`${m.blk}B`, suffix, gain(`(${fade})`), [inlets.fade])
  }
}

/** The gains the loop multiplies by: per-block ones glide toward their targets while
 *  `xfade_settle` says so (`XFADE_SLEW_HELPER`); a per-sample `fade` (an LFO) is already
 *  continuous and used as is. */
function crossfaderGains(
  suffix: string,
  inlets: Record<string, string | undefined>,
  m: CrossfaderMembers
): Record<'a' | 'b', string> {
  const v = crossfaderBlockValues(suffix, inlets, m)
  if (!isBlockInvariant(inlets.fade)) return { a: v.a.ref, b: v.b.ref }
  const g = `${m.g}_${suffix}`
  const moving = `${m.blk}Moving_${suffix}`
  return {
    a: `(${moving} != 0.f ? xfade_glide(&${g}[0], ${v.a.ref}) : ${v.a.ref})`,
    b: `(${moving} != 0.f ? xfade_glide(&${g}[1], ${v.b.ref}) : ${v.b.ref})`
  }
}

/** The per-block targets, then (while they are per-block) the settle step that reads them. */
function crossfaderBlockDecls(
  suffix: string,
  inlets: Record<string, string | undefined>,
  m: CrossfaderMembers
): Array<{ name: string; expr: string }> {
  const v = crossfaderBlockValues(suffix, inlets, m)
  const decls = blockDecls(v)
  if (!isBlockInvariant(inlets.fade)) return decls
  return [
    ...decls,
    {
      name: `${m.blk}Moving_${suffix}`,
      expr: `xfade_settle(${m.g}_${suffix}, ${v.a.ref}, ${v.b.ref})`
    }
  ]
}

const crossfaderMemberDecls = (suffix: string, m: CrossfaderMembers): string =>
  `  float ${m.fade}_${suffix};\n  float ${m.law}_${suffix};\n  float ${m.g}_${suffix}[2];\n`

const crossfaderInit = (suffix: string, m: CrossfaderMembers): string =>
  `    ${m.g}_${suffix}[0] = -1.f;\n    ${m.g}_${suffix}[1] = -1.f;\n`

function crossfaderParams(m: CrossfaderMembers): PrimitiveParamSpec[] {
  return [
    {
      name: 'FADE',
      unit: PERCENT,
      modulatedBy: { inlet: 'fade', shape: 'additive' },
      nts1mkiiType: 'percent',
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `${m.fade}_${suffix} = ${valueExpr};`
    },
    {
      name: 'LAW',
      unit: STEREO_XFADE_LAW_NAME,
      select: { count: 2, scale: 1, label: 'Law', names: STEREO_XFADE_LAWS },
      min: 0,
      max: 1,
      default: 0,
      step: 1,
      setStatement: (suffix, valueExpr) => `${m.law}_${suffix} = ${valueExpr};`
    }
  ]
}

/**
 * A crossfader: `in1` at FADE 0, `in2` at 100. LAW Power (default) is equal power, `gain1 =
 * sqrt(1-t)`, `gain2 = sqrt(t)`, so `gain1^2 + gain2^2 = 1` for uncorrelated inputs (two
 * correlated, in-phase ones sum to ~1.41x at the centre, unlike `mix2`, which averages); Linear
 * sums to unity for correlated inputs and has no steep ends. `fade` adds to FADE at depth 100 (the
 * whole range), clamped to [0,100] -- load-bearing, a negative square-root argument is NaN. The
 * square root is `xfade_sqrtf`, not newlib's `sqrtf`. Unwired `in1`/`in2` read as silence.
 * History: docs/HISTORY.md.
 */
export const crossfaderPrimitive: LoguePrimitive = {
  id: 'logue/mix/crossfader',
  outletPolarity: 'inherit',
  stateBytesPerInstance: 16, // fadePercent_, xfLaw_, xfG_[2]
  description:
    'Crossfades between two signals (in1 at 0, in2 at 100). LAW: equal power, or linear for two signals that are close to each other.',
  inlets: [
    { name: 'in1', role: 'audio' },
    { name: 'in2', role: 'audio' },
    { name: 'fade', role: 'control' }
  ],
  memberDecls: (suffix) => crossfaderMemberDecls(suffix, MONO_XFADE),
  initStatement: (suffix) => crossfaderInit(suffix, MONO_XFADE),
  blockConstants: (suffix, inlets) => crossfaderBlockDecls(suffix, inlets, MONO_XFADE),
  renderExpr: (suffix, inlets) => {
    const g = crossfaderGains(suffix, inlets, MONO_XFADE)
    return `(${g.a} * (${inlets.in1 ?? '0.f'}) + ${g.b} * (${inlets.in2 ?? '0.f'}))`
  },
  advanceStatement: () => '',
  helpers: [CLAMPF_HELPER, XFADE_SQRTF_HELPER, XFADE_SLEW_HELPER],
  params: crossfaderParams(MONO_XFADE)
}

/**
 * `logue/mix/stereo-crossfader`: `crossfader` for a stereo pair, so an effect's dry/wet is one
 * node with one FADE (one device control) instead of two crossfaders whose dials must be kept
 * equal -- every effect example had that pair. `l1`/`r1` at FADE 0, `l2`/`r2` at 100; `fade`
 * and LAW as on `crossfader`. Both sides share the gains, so a wired `fade` costs two square
 * roots per sample, not four.
 */
export const stereoCrossfaderPrimitive: LoguePrimitive = {
  id: 'logue/mix/stereo-crossfader',
  outletPolarity: 'inherit',
  stateBytesPerInstance: 16, // stxFadePercent_, stxLaw_, stxG_[2]
  description:
    "Crossfades between two stereo pairs (l1/r1 at 0, l2/r2 at 100) with one FADE -- an effect's dry/wet in one node. LAW: equal power, or linear for a wet signal that is close to the dry one.",
  searchTerms: ['xfade', 'dry', 'wet', 'blend'],
  inlets: [
    { name: 'l1', role: 'audio' },
    { name: 'r1', role: 'audio' },
    { name: 'l2', role: 'audio' },
    { name: 'r2', role: 'audio' },
    { name: 'fade', role: 'control' }
  ],
  outlets: [{ name: 'l' }, { name: 'r' }],
  memberDecls: (suffix) => crossfaderMemberDecls(suffix, STEREO_XFADE),
  initStatement: (suffix) => crossfaderInit(suffix, STEREO_XFADE),
  blockConstants: (suffix, inlets) => crossfaderBlockDecls(suffix, inlets, STEREO_XFADE),
  renderExpr: () => {
    throw new Error(
      'logue/mix/stereo-crossfader is multi-outlet -- use renderOutletStatements, not renderExpr'
    )
  },
  renderOutletStatements: (suffix, inlets) => {
    const g = crossfaderGains(suffix, inlets, STEREO_XFADE)
    // Locals so a gain is worked out (and glides) once for both sides.
    return (
      `      const float stxA_${suffix} = ${g.a};\n` +
      `      const float stxB_${suffix} = ${g.b};\n` +
      `      float y_${suffix}_l = stxA_${suffix} * (${inlets.l1 ?? '0.f'}) + stxB_${suffix} * (${inlets.l2 ?? '0.f'});\n` +
      `      float y_${suffix}_r = stxA_${suffix} * (${inlets.r1 ?? '0.f'}) + stxB_${suffix} * (${inlets.r2 ?? '0.f'});\n` +
      `      (void)y_${suffix}_l; (void)y_${suffix}_r;\n`
    )
  },
  advanceStatement: () => '',
  helpers: [CLAMPF_HELPER, XFADE_SQRTF_HELPER, XFADE_SLEW_HELPER],
  params: crossfaderParams(STEREO_XFADE)
}

/**
 * `logue/mix/stereo-mix2`: `mix2` for two stereo pairs -- GAIN1 on `l1`/`r1`, GAIN2 on
 * `l2`/`r2`, the same gain on both sides of a pair, defaults averaging like `mix2`. For summing
 * buses (a comb bank per side, a parallel effect under the dry signal); `stereo-reverb` summed
 * its combs with six `mix2`s.
 */
export const stereoMixer2Primitive: LoguePrimitive = {
  id: 'logue/mix/stereo-mix2',
  pure: true,
  outletPolarity: 'inherit',
  stateBytesPerInstance: 8, // gain1_ + gain2_, 2 floats
  description: 'Sums two stereo pairs, each pair with its own gain (both sides alike).',
  searchTerms: ['sum', 'bus'],
  inlets: [
    { name: 'l1', role: 'audio' },
    { name: 'r1', role: 'audio' },
    { name: 'l2', role: 'audio' },
    { name: 'r2', role: 'audio' }
  ],
  outlets: [{ name: 'l' }, { name: 'r' }],
  memberDecls: (suffix) => `  float gain1_${suffix};\n  float gain2_${suffix};\n`,
  renderExpr: () => {
    throw new Error(
      'logue/mix/stereo-mix2 is multi-outlet -- use renderOutletStatements, not renderExpr'
    )
  },
  renderOutletStatements: (suffix, inlets) => {
    const side = (s: 'l' | 'r'): string =>
      `      float y_${suffix}_${s} = ((${inlets[`${s}1`] ?? '0.f'}) * gain1_${suffix}) + ((${inlets[`${s}2`] ?? '0.f'}) * gain2_${suffix});\n`
    return side('l') + side('r') + `      (void)y_${suffix}_l; (void)y_${suffix}_r;\n`
  },
  advanceStatement: () => '',
  params: [
    {
      name: 'GAIN1',
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `gain1_${suffix} = ${valueExpr} * 0.01f;`
    },
    {
      name: 'GAIN2',
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `gain2_${suffix} = ${valueExpr} * 0.01f;`
    }
  ]
}

const PAN_INLET_DEPTH = 100
const WIDTH_INLET_DEPTH = 50

/** The pan's two equal-power gains, once per block while `pan` is unwired. */
function panBlockValues(
  suffix: string,
  inlets: Record<string, string | undefined>
): Record<'l' | 'r', BlockValue> {
  const pan =
    inlets.pan !== undefined
      ? additiveInletExpr('panPercent', suffix, inlets.pan, PAN_INLET_DEPTH, -100, 100)
      : `panPercent_${suffix}`
  return {
    l: blockValue('blkPanL', suffix, `xfade_sqrtf(clampf((100.f - (${pan})) * 0.005f, 0.f, 1.f))`, [
      inlets.pan
    ]),
    r: blockValue('blkPanR', suffix, `xfade_sqrtf(clampf((100.f + (${pan})) * 0.005f, 0.f, 1.f))`, [
      inlets.pan
    ])
  }
}

/** How often a wired `pan` is re-read (the env_rate_ctl precedent): 1/3 ms. */
const PAN_CONTROL_PERIOD = 16

const PAN_CTL_HELPER: HelperBlock = {
  key: 'pan_ctl',
  code: `  // A wired pan at control rate: every ${PAN_CONTROL_PERIOD}th call it works out the equal-power gains for the
  // pan percent (two square roots) and sets g[2]/g[3] so g[0]/g[1] (left/right) ramp there
  // linearly over the next ${PAN_CONTROL_PERIOD} samples, which keeps a sweep free of gain steps. A leaf.
  static inline __attribute__((always_inline)) void pan_ctl(uint32_t *n, float *g, float pan)
  {
    if (((*n)++ & ${PAN_CONTROL_PERIOD - 1}u) == 0u)
    {
      pan = pan < -100.f ? -100.f : (pan > 100.f ? 100.f : pan);
      const float l = xfade_sqrtf(clampf((100.f - pan) * 0.005f, 0.f, 1.f));
      const float r = xfade_sqrtf(clampf((100.f + pan) * 0.005f, 0.f, 1.f));
      g[2] = (l - g[0]) * ${(1 / 16).toFixed(4)}f;
      g[3] = (r - g[1]) * ${(1 / 16).toFixed(4)}f;
    }
    g[0] += g[2];
    g[1] += g[3];
  }
`
}

/**
 * `logue/mix/pan`: places a mono `in` in the stereo field with an equal-power law (the two gains'
 * squares sum to 1: -3 dB each at the center) and ADDS it onto a stereo bus, `l`/`r` in, `l`/`r`
 * out -- so pans chain: the first one's bus inlets unwired, each next one's wired from the one
 * before, the last one's outlets the mix. A mixer without a mixer node, and every voice keeps its
 * own position (grain-mill: 8 grain voices, alternately left and right, `docs/PLAN-grain-mill.md`).
 * PAN -100 (left) .. 100 (right), `pan` additive (+-1 sweeps the whole field).
 */
export const panPrimitive: LoguePrimitive = {
  id: 'logue/mix/pan',
  outletPolarity: 'inherit',
  // panPercent_, panCtl_, panG_[4] (6 x 4 B; the last two only used while `pan` is wired).
  stateBytesPerInstance: 24,
  description:
    'Places a mono signal in the stereo field (equal power) and adds it onto the stereo bus coming in on l/r -- chain several pans to mix them.',
  inlets: [
    { name: 'in', role: 'audio' },
    { name: 'l', role: 'audio' },
    { name: 'r', role: 'audio' },
    { name: 'pan', role: 'control' }
  ],
  outlets: [{ name: 'l' }, { name: 'r' }],
  memberDecls: (suffix) =>
    `  float panPercent_${suffix};\n  uint32_t panCtl_${suffix};\n  float panG_${suffix}[4];\n`,
  initStatement: (suffix) =>
    `    panCtl_${suffix} = 0u;\n    for (int k = 0; k < 4; ++k) panG_${suffix}[k] = 0.f;\n`,
  blockConstants: (suffix, inlets) => blockDecls(panBlockValues(suffix, inlets)),
  renderExpr: () => {
    throw new Error('logue/mix/pan is multi-outlet -- use renderOutletStatements, not renderExpr')
  },
  renderOutletStatements: (suffix, inlets) => {
    const x = inlets.in ?? '0.f'
    const bus = (side: 'l' | 'r', gain: string): string =>
      `      float y_${suffix}_${side} = (${inlets[side] ?? '0.f'}) + (${x}) * ${gain};\n`
    // Wired per sample: two square roots per sample were most of a reverse-wash head's cost on
    // the xd (2026-10-01), so the gains follow at control rate, ramped.
    if (!isBlockInvariant(inlets.pan)) {
      return (
        `      pan_ctl(&panCtl_${suffix}, panG_${suffix}, panPercent_${suffix} + (${inlets.pan}) * ${PAN_INLET_DEPTH}.f);\n` +
        bus('l', `panG_${suffix}[0]`) +
        bus('r', `panG_${suffix}[1]`) +
        `      (void)y_${suffix}_l; (void)y_${suffix}_r;\n`
      )
    }
    const g = panBlockValues(suffix, inlets)
    return (
      bus('l', g.l.ref) + bus('r', g.r.ref) + `      (void)y_${suffix}_l; (void)y_${suffix}_r;\n`
    )
  },
  advanceStatement: () => '',
  helpers: [CLAMPF_HELPER, XFADE_SQRTF_HELPER, PAN_CTL_HELPER],
  params: [
    {
      name: 'PAN',
      unit: PERCENT,
      modulatedBy: { inlet: 'pan', shape: 'additive' },
      min: -100,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `panPercent_${suffix} = ${valueExpr};`
    }
  ]
}

/**
 * `logue/mix/width`: stereo width by mid/side -- `mid = (l+r)/2`, `side = (l-r)/2 * WIDTH`, out
 * `mid +- side`. WIDTH 0 is the mono sum on both sides (at the same level, unlike Axoloti
 * grain-mill's unscaled L+R), 100 leaves the pair as it is. Not wider than 100: the xd's manifest
 * caps a param's range near +-100. `width` additive.
 */
export const widthPrimitive: LoguePrimitive = {
  id: 'logue/mix/width',
  outletPolarity: 'inherit',
  stateBytesPerInstance: 4, // widthPercent_
  description: 'Stereo width: 0 is mono, 100 leaves the pair as it is (mid/side).',
  inlets: [
    { name: 'l', role: 'audio' },
    { name: 'r', role: 'audio' },
    { name: 'width', role: 'control' }
  ],
  outlets: [{ name: 'l' }, { name: 'r' }],
  memberDecls: (suffix) => `  float widthPercent_${suffix};\n`,
  renderExpr: () => {
    throw new Error('logue/mix/width is multi-outlet -- use renderOutletStatements, not renderExpr')
  },
  renderOutletStatements: (suffix, inlets) => {
    const l = inlets.l ?? '0.f'
    const r = inlets.r ?? '0.f'
    const width =
      inlets.width !== undefined
        ? additiveInletExpr('widthPercent', suffix, inlets.width, WIDTH_INLET_DEPTH)
        : `widthPercent_${suffix}`
    return (
      `      const float mid_${suffix} = ((${l}) + (${r})) * 0.5f;\n` +
      `      const float side_${suffix} = ((${l}) - (${r})) * (${width}) * 0.005f;\n` +
      `      float y_${suffix}_l = mid_${suffix} + side_${suffix};\n` +
      `      float y_${suffix}_r = mid_${suffix} - side_${suffix};\n` +
      `      (void)y_${suffix}_l; (void)y_${suffix}_r;\n`
    )
  },
  advanceStatement: () => '',
  helpers: CLAMPF_HELPER,
  params: [
    {
      name: 'WIDTH',
      unit: PERCENT,
      modulatedBy: { inlet: 'width', shape: 'additive' },
      min: 0,
      max: 100,
      default: 100,
      setStatement: (suffix, valueExpr) => `widthPercent_${suffix} = ${valueExpr};`
    }
  ]
}

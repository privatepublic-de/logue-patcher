import { PERCENT } from '../paramPresentation'
import type { HelperBlock, LoguePrimitive } from './types'
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

/** The two square roots, once per block while `fade` is unwired (a dry/wet knob: two per
 *  crossfader per sample were ~3 % of grain-mill's xd CPU, 2026-10-01). */
function crossfaderGains(
  suffix: string,
  inlets: Record<string, string | undefined>
): Record<'a' | 'b', BlockValue> {
  const fade =
    inlets.fade !== undefined
      ? `clampf(fadePercent_${suffix} * 0.01f + (${inlets.fade}), 0.f, 1.f)`
      : `(fadePercent_${suffix} * 0.01f)`
  return {
    a: blockValue('blkFadeA', suffix, `xfade_sqrtf(1.f - (${fade}))`, [inlets.fade]),
    b: blockValue('blkFadeB', suffix, `xfade_sqrtf(${fade})`, [inlets.fade])
  }
}

/**
 * An equal-power crossfader: `gain1 = sqrt(1-t)`, `gain2 = sqrt(t)`, so `gain1^2 + gain2^2 = 1`
 * across the whole fade (a linear fade dips to 0.5 power at the center). The square root is
 * `xfade_sqrtf` (see `XFADE_SQRTF_HELPER`), not newlib's `sqrtf`.
 *
 * `FADE` (0-100, default 50 = center) is where the fade sits; a wired `fade` adds to it at depth
 * 100 (the whole range), so a bipolar LFO swings around FADE. The sum is clamped to [0,1] because
 * a negative square-root argument gives NaN, so the clamp is load-bearing. Unwired `in1`/`in2` read
 * as silence. Constant loudness holds for uncorrelated inputs: two correlated, in-phase,
 * full-scale inputs sum to ~1.41x at the center (both gains ~0.707), unlike `mix2`, which
 * averages. History: docs/HISTORY.md.
 */
export const crossfaderPrimitive: LoguePrimitive = {
  id: 'logue/mix/crossfader',
  outletPolarity: 'inherit',
  stateBytesPerInstance: 4, // fadePercent_, 1 float
  description: 'Equal-power crossfades between two audio signals.',
  inlets: [
    { name: 'in1', role: 'audio' },
    { name: 'in2', role: 'audio' },
    { name: 'fade', role: 'control' }
  ],
  memberDecls: (suffix) => `  float fadePercent_${suffix};\n`,
  blockConstants: (suffix, inlets) => blockDecls(crossfaderGains(suffix, inlets)),
  renderExpr: (suffix, inlets) => {
    const g = crossfaderGains(suffix, inlets)
    return `(${g.a.ref} * (${inlets.in1 ?? '0.f'}) + ${g.b.ref} * (${inlets.in2 ?? '0.f'}))`
  },
  advanceStatement: () => '',
  helpers: [CLAMPF_HELPER, XFADE_SQRTF_HELPER],
  params: [
    {
      name: 'FADE',
      unit: PERCENT,
      modulatedBy: { inlet: 'fade', shape: 'additive' },
      nts1mkiiType: 'percent',
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `fadePercent_${suffix} = ${valueExpr};`
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

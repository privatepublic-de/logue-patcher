import { SOFTCLIP_DRIVE_DB, WAVEFOLDER_DRIVE_DB } from '../paramPresentation'
import type { HelperBlock, LoguePrimitive } from './types'
import { CLAMPF_HELPER, additiveInletExpr } from './shared'

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

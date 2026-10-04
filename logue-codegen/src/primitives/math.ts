import type {
  HelperBlock,
  LoguePrimitive,
  PolarityRefineContext,
  ResolvedWireBucket,
  WirePolarityBucket
} from './types'
import { CLAMPF_HELPER, additiveInletExpr } from './shared'
import {
  SCALE_FACTOR,
  SCALE_FACTOR_BY_RANGE,
  SCALE_RANGE_NAME,
  SCALE_RANGES
} from '../paramPresentation'

// `refinePolarity` rules (display-only, see `LoguePrimitive.refinePolarity`): what each node does
// to its inputs' range, so a VCA's "bipolar into gain" warning sees `max(env, 0)` as safe and
// `env - env` as not. An unwired inlet is `undefined` and reads 0. Audio, `neutral` (inputs that
// disagree) and buffer aren't ranges this can reason about, so those keep the inherited bucket.
type InletBucket = ResolvedWireBucket | undefined
const nonNegative = (b: InletBucket): boolean => b === 'unipolar' || b === 'gate'
const ranged = (b: InletBucket): boolean =>
  b === undefined || b === 'unipolar' || b === 'gate' || b === 'bipolar'
/** Both inputs `>= 0`: a gate only while every wired input is one, else unipolar. */
const nonNegativeOf = (wired: InletBucket[]): WirePolarityBucket =>
  wired.every((b) => b === 'gate') ? 'gate' : 'unipolar'
const pair = (ctx: PolarityRefineContext, x: string, y: string): [InletBucket, InletBucket] => [
  ctx.inlet(x),
  ctx.inlet(y)
]

/**
 * `a * b` -- originally phase 10's `logue/mix/ringmod`, the second `mix` primitive beside `mix2`
 * (same shape, product instead of sum). Renamed into `math` 2026-09-27 (user request): the same
 * product is just as often a plain multiply of CONTROL signals (an envelope scaling an LFO's
 * depth, a `0`/`1` gate muting a signal) as it is audio ring modulation, and "ringmod" read wrong
 * for those. Category and name only -- `RENAMED_PRIMITIVE_IDS` keeps old files resolving, and the
 * `in1`/`in2` inlet names are kept on purpose (not `a`/`b` like `add`): the canvas doesn't read
 * `renamedInlets`, so renaming them would draw every existing wire as broken.
 *
 * Either inlet left unwired reads as silence (`0.f`), same convention as `mix2` -- but because
 * multiplication has an absorbing zero, an unwired inlet here mutes the WHOLE output completely
 * (not merely half the signal the way `mix2`'s unwired-inlet case does) -- a real, disclosed
 * consequence of multiplying by nothing, not a bug to guard against.
 */
export const multiplyPrimitive: LoguePrimitive = {
  id: 'logue/math/multiply',
  pure: true,
  outletPolarity: 'inherit',
  refinePolarity: (ctx) => {
    const ins = pair(ctx, 'in1', 'in2')
    if (ins.includes(undefined) || !ins.every(ranged)) return undefined
    return ins.every(nonNegative) ? nonNegativeOf(ins) : 'bipolar'
  },
  stateBytesPerInstance: 0, // stateless, memberDecls is empty
  description:
    'Multiplies two signals. Two audio signals give ring modulation (metallic, inharmonic sidebands); a 0/1 gate or envelope times a signal acts as a VCA.',
  inlets: [
    { name: 'in1', role: 'audio' },
    { name: 'in2', role: 'audio' }
  ],
  memberDecls: () => '',
  renderExpr: (_suffix, inlets) => `((${inlets.in1 ?? '0.f'}) * (${inlets.in2 ?? '0.f'}))`,
  advanceStatement: () => ''
}

/**
 * A plain negation -- originally the third `util` converter, requested alongside the two range
 * converters above for the same reason: a wireable building block this registry had no way to
 * express without reaching for something that also did unwanted work of its own (e.g. an
 * inverted LFO needed its own separate primitive rather than reusing the existing one). No clamp
 * needed -- negating a value already in this registry's own `-1..1` domain can never leave it.
 *
 * Reclassified `util` -> `math` (2026-09-25, alongside `curve`/`glide`): negation is arithmetic,
 * a closer fit next to `add`/`subtract`/`scale` than a domain-conversion utility. Renamed
 * `invert` -> `negate` (2026-10-02, user's call) when `one-minus` arrived: "invert" means -x to
 * some and 1-x to others, so both are named by their math and both answer a search for "invert".
 * `RENAMED_PRIMITIVE_IDS` keeps old files resolving; the id never reaches generated code.
 */
export const negatePrimitive: LoguePrimitive = {
  id: 'logue/math/negate',
  shortLabel: '−x',
  pure: true,
  outletPolarity: 'inherit',
  refinePolarity: (ctx) => (nonNegative(ctx.inlet('in')) ? 'bipolar' : undefined),
  stateBytesPerInstance: 0, // stateless, memberDecls is empty
  description:
    "Flips a signal's sign (-x): a bipolar LFO turns upside down around 0; on audio, a polarity flip.",
  searchTerms: ['invert'],
  inlets: [{ name: 'in', role: 'audio' }],
  memberDecls: () => '',
  renderExpr: (_suffix, inlets) => `(-(${inlets.in ?? '0.f'}))`,
  advanceStatement: () => ''
}

/**
 * `1 - x`, the other thing "invert" means: it flips a `0..1` signal end to end (an envelope that
 * rests at 1 and dips on a note, a ducking amount from a follower, the other side of a
 * crossfade). Not clamped, so it's exact for any input -- a bipolar one comes out as `0..2`, which
 * the description says rather than silently clipping. `inherit` polarity like `negate`.
 */
export const oneMinusPrimitive: LoguePrimitive = {
  id: 'logue/math/one-minus',
  shortLabel: '1−x',
  pure: true,
  outletPolarity: 'inherit',
  // 1 - x of a -1..1 signal is 0..2.
  refinePolarity: (ctx) => (ctx.inlet('in') === 'bipolar' ? 'unipolar' : undefined),
  stateBytesPerInstance: 0, // stateless, memberDecls is empty
  description:
    '1 - x: flips a 0..1 signal end to end, so an envelope rests at 1 and falls on a note. A -1..1 signal comes out as 0..2.',
  searchTerms: ['invert'],
  inlets: [{ name: 'in', role: 'audio' }],
  memberDecls: () => '',
  renderExpr: (_suffix, inlets) => `(1.f - (${inlets.in ?? '0.f'}))`,
  advanceStatement: () => ''
}

/**
 * `logue/math/curve`: one `SHAPE` dial morphs log (-100) -> linear (0) -> exp (+100). One primitive,
 * not two, because both sides are the same rational curve mirrored about the diagonal.
 *
 * No `powf`/`expf`/`logf` (the no-libm rule; a runtime exponent is `expf(p*logf(x))`). Instead one
 * divide: `x / (1 + k*(1-x))` for the exponential/ease-in side and its mirror
 * `1 - (1-x) / (1 + k*x)` for the log/ease-out side. Both pass through (0,0)/(1,1), are strictly
 * monotonic, and are exactly linear at `k=0`; `curve_shape` blends toward them by `shapeNorm`, so
 * `SHAPE=0` or `AMOUNT=0` is an exact passthrough (checked algebraically and by a 1001-point sweep).
 *
 * Domain is unipolar `0..1`, clamped on input: an ease curve only makes sense on a one-way ramp,
 * and `logue/util/bipolar-to-unipolar` bridges a bipolar source.
 *
 * `SHAPE` is wireable (additive, depth `SHAPE_INLET_DEPTH = 100`, half its -100..100 span).
 * `AMOUNT` (default 100, so SHAPE alone works from the start) is dial-only and maps to `k` up to
 * `CURVE_K_MAX = 16`; past 16 the curve barely moves. History: docs/HISTORY.md.
 */
const CURVE_K_MAX = 16
const SHAPE_INLET_DEPTH = 100

const CURVE_SHAPE_HELPER: HelperBlock = {
  key: 'curve_shape',
  code: `  static float curve_shape(float x, float shapeNorm, float k)
  {
    if (shapeNorm >= 0.f)
    {
      float e = x / (1.f + k * (1.f - x));
      return x + (e - x) * shapeNorm;
    }
    else
    {
      float l = 1.f - (1.f - x) / (1.f + k * x);
      return x + (l - x) * (-shapeNorm);
    }
  }
`
}

export const curvePrimitive: LoguePrimitive = {
  id: 'logue/math/curve',
  pure: true,
  outletPolarity: 'inherit',
  stateBytesPerInstance: 8, // shapePercent_ + amountPercent_, 2 floats
  description:
    'Reshapes a 0..1 signal along a logarithmic-to-exponential ease curve, e.g. to taper an envelope or sense reading.',
  inlets: [
    { name: 'in', role: 'audio' },
    { name: 'shape', role: 'control' }
  ],
  memberDecls: (suffix) => `  float shapePercent_${suffix};\n  float amountPercent_${suffix};\n`,
  renderExpr: (suffix, inlets) => {
    const shapeNorm =
      inlets.shape !== undefined
        ? `(${additiveInletExpr('shapePercent', suffix, inlets.shape, SHAPE_INLET_DEPTH, -100, 100)} * 0.01f)`
        : `(shapePercent_${suffix} * 0.01f)`
    const x = `clampf(${inlets.in ?? '0.f'}, 0.f, 1.f)`
    const k = `(amountPercent_${suffix} * ${(CURVE_K_MAX / 100).toFixed(4)}f)`
    return `curve_shape(${x}, ${shapeNorm}, ${k})`
  },
  advanceStatement: () => '',
  helpers: [CURVE_SHAPE_HELPER, CLAMPF_HELPER],
  params: [
    {
      name: 'SHAPE',
      modulatedBy: { inlet: 'shape', shape: 'additive' },
      min: -100,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `shapePercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'AMOUNT',
      min: 0,
      max: 100,
      default: 100,
      setStatement: (suffix, valueExpr) => `amountPercent_${suffix} = ${valueExpr};`
    }
  ]
}

/**
 * A plain two-signal sum -- genuinely missing from this registry: `logue/mix/mix2` averages
 * (fixed or dialed-but-still-proportional gains), never an exact sum, so there was no way to add
 * two signals algebraically (e.g. combining two envelope outputs into one bipolar contour)
 * without reaching for a mixer whose actual job is loudness balancing. Stateless, same
 * "unwired inlet reads silence" convention as `mix2`/`multiply` -- deliberately unclamped, an
 * out-of-range sum is the user's own responsibility, the same headroom tradeoff `mix2`'s own doc
 * comment already discloses.
 */
export const addPrimitive: LoguePrimitive = {
  id: 'logue/math/add',
  pure: true,
  outletPolarity: 'inherit',
  refinePolarity: (ctx) => {
    const ins = pair(ctx, 'a', 'b')
    const wired = ins.filter((b) => b !== undefined)
    if (wired.length === 0 || !ins.every(ranged)) return undefined
    return wired.every(nonNegative) ? nonNegativeOf(wired) : 'bipolar'
  },
  stateBytesPerInstance: 0, // stateless, memberDecls is empty
  description: 'Adds two signals together.',
  inlets: [
    { name: 'a', role: 'audio' },
    { name: 'b', role: 'audio' }
  ],
  memberDecls: () => '',
  renderExpr: (_suffix, inlets) => `((${inlets.a ?? '0.f'}) + (${inlets.b ?? '0.f'}))`,
  advanceStatement: () => ''
}

/**
 * `a - b` -- `add`'s mirror, for a genuine bipolar difference (e.g. subtracting two envelopes
 * into a contour that can go negative) rather than chaining `add` behind a separate `invert`.
 * Same stateless, unwired-reads-silence shape.
 */
export const subtractPrimitive: LoguePrimitive = {
  id: 'logue/math/subtract',
  pure: true,
  outletPolarity: 'inherit',
  refinePolarity: (ctx) => {
    const [a, b] = pair(ctx, 'a', 'b')
    if (b === undefined || !ranged(a) || !ranged(b)) return undefined
    // Both wired: a difference goes either way, even of two gates.
    return a !== undefined || nonNegative(b) ? 'bipolar' : undefined
  },
  stateBytesPerInstance: 0, // stateless, memberDecls is empty
  description: 'Subtracts one signal from another (a - b).',
  inlets: [
    { name: 'a', role: 'audio' },
    { name: 'b', role: 'audio' }
  ],
  memberDecls: () => '',
  renderExpr: (_suffix, inlets) => `((${inlets.a ?? '0.f'}) - (${inlets.b ?? '0.f'}))`,
  advanceStatement: () => ''
}

/**
 * Multiply-by-constant, and (dial the reciprocal) divide-by-constant, in one node: a plain
 * bipolar `FACTOR` dial, `-100..100` mapped linearly to `-1..1`, the same domain/scale
 * `logue/util/constant`'s own `VALUE` uses, times `RANGE` (x1/x2/x4/x8). Weighed against what
 * already exists: chaining `logue/gain/vca` (`gain` unwired, 0-4x, positive only) and
 * `logue/math/negate` already covers "scale by any signed constant factor" today -- this exists
 * anyway because that costs two nodes and a wire for what's conceptually one control, and
 * because `vca`'s own 0-4x/unity-at-25 framing is an audio GAIN stage, awkward to reach for when
 * the actual need is rescaling a CONTROL signal's depth (e.g. halving an LFO's swing before
 * feeding it into another additive inlet). Default `100` (unity, no effect) rather than `0` -- a
 * freshly placed node shouldn't silently mute whatever's wired through it.
 *
 * `RANGE` (2026-10-02, user's call) rather than a wider FACTOR: the xd caps a param's manifest
 * range near +-100, and a separate select keeps 0.5x/2x exact to dial. A document without it
 * reads the default, x1. Both set statements recompute the one `factor_` the loop reads, so
 * the per-sample cost is unchanged; at init FACTOR's runs first against a zeroed `range_`
 * (static storage) and RANGE's then sets the real product. Not an `initStatement`: an effect's
 * reset re-runs those but not the param sets, which would put `range_` back to x1.
 */
export const scalePrimitive: LoguePrimitive = {
  id: 'logue/math/scale',
  pure: true,
  outletPolarity: 'inherit',
  refinePolarity: (ctx) =>
    nonNegative(ctx.inlet('in')) && ctx.param('FACTOR') < 0 ? 'bipolar' : undefined,
  stateBytesPerInstance: 12, // factor_, factorPercent_, range_
  description:
    'Multiplies a signal by FACTOR, which goes from -1x to +1x times RANGE (up to ±8x): 0.50x halves it, 2.00x doubles it, -1.00x flips it upside down.',
  inlets: [{ name: 'in', role: 'audio' }],
  memberDecls: (suffix) =>
    `  float factor_${suffix};\n  float factorPercent_${suffix};\n  float range_${suffix};\n`,
  renderExpr: (suffix, inlets) => `((${inlets.in ?? '0.f'}) * factor_${suffix})`,
  advanceStatement: () => '',
  params: [
    {
      name: 'FACTOR',
      min: -100,
      max: 100,
      default: 100,
      unit: SCALE_FACTOR,
      unitDependsOn: SCALE_FACTOR_BY_RANGE,
      setStatement: (suffix, valueExpr) =>
        `factorPercent_${suffix} = ${valueExpr}; factor_${suffix} = factorPercent_${suffix} * 0.01f * range_${suffix};`
    },
    {
      name: 'RANGE',
      unit: SCALE_RANGE_NAME,
      select: { count: 4, scale: 1, label: 'Range', names: SCALE_RANGES.map((r) => `${r}x`) },
      min: 0,
      max: 3,
      default: 0,
      step: 1,
      setStatement: (suffix, valueExpr) =>
        `range_${suffix} = (${valueExpr}) >= 3 ? 8.f : (${valueExpr}) >= 2 ? 4.f : (${valueExpr}) >= 1 ? 2.f : 1.f; factor_${suffix} = factorPercent_${suffix} * 0.01f * range_${suffix};`
    }
  ]
}

/**
 * Sample-wise minimum of two signals -- a plain ternary, not `fminf`: unlike `fabsf`/`sqrtf`
 * (used elsewhere in this file, see `saturatorPrimitive`/`crossfaderPrimitive`'s own doc
 * comments), there's no existing confirmed-cheap-intrinsic precedent for `fminf` on the real
 * target, so this stays a plain comparison rather than assuming that's true. Unwired inlet reads
 * silence, same convention as `add`.
 */
export const minPrimitive: LoguePrimitive = {
  id: 'logue/math/min',
  pure: true,
  outletPolarity: 'inherit',
  refinePolarity: (ctx) => {
    const ins = pair(ctx, 'a', 'b')
    if (ins.every((b) => b === undefined) || !ins.every(ranged)) return undefined
    if (ins.every(nonNegative)) return nonNegativeOf(ins)
    // An unwired side is 0, so the result is <= 0.
    return 'bipolar'
  },
  stateBytesPerInstance: 0, // stateless, memberDecls is empty
  description: 'Outputs the smaller of two signals, sample by sample.',
  inlets: [
    { name: 'a', role: 'audio' },
    { name: 'b', role: 'audio' }
  ],
  memberDecls: () => '',
  renderExpr: (_suffix, inlets) => {
    const a = inlets.a ?? '0.f'
    const b = inlets.b ?? '0.f'
    return `((${a}) < (${b}) ? (${a}) : (${b}))`
  },
  advanceStatement: () => ''
}

/** `max`'s mirror -- see `minPrimitive`'s own doc comment for why this is a plain ternary, not `fmaxf`. */
export const maxPrimitive: LoguePrimitive = {
  id: 'logue/math/max',
  pure: true,
  outletPolarity: 'inherit',
  refinePolarity: (ctx) => {
    const ins = pair(ctx, 'a', 'b')
    if (ins.every((b) => b === undefined) || !ins.every(ranged)) return undefined
    if (ins.every((b) => b === 'gate')) return 'gate'
    // An unwired side is 0: max(x, 0) is a half-wave rectifier.
    return ins.some((b) => b === undefined || nonNegative(b)) ? 'unipolar' : undefined
  },
  stateBytesPerInstance: 0, // stateless, memberDecls is empty
  searchTerms: ['rectify', 'rectifier', 'half-wave', 'positive'],
  description:
    'Outputs the larger of two signals, sample by sample. With b unwired (0) it keeps only the positive half: a half-wave rectifier.',
  inlets: [
    { name: 'a', role: 'audio' },
    { name: 'b', role: 'audio' }
  ],
  memberDecls: () => '',
  renderExpr: (_suffix, inlets) => {
    const a = inlets.a ?? '0.f'
    const b = inlets.b ?? '0.f'
    return `((${a}) > (${b}) ? (${a}) : (${b}))`
  },
  advanceStatement: () => ''
}

/**
 * Clamps a signal to a dialable `[LO,HI]` range -- reuses the existing `CLAMPF_HELPER` rather
 * than a new one-off (the same reuse `unipolarToBipolarPrimitive`/`bipolarToUnipolarPrimitive`
 * already established). `LO`/`HI` are independent dials, not a single "amount"; no ordering
 * between them is enforced -- an inverted range (`LO > HI`) just falls through to whichever bound
 * `clampf`'s own plain `v < lo ? lo : (v > hi ? hi : v)` definition hits first, a disclosed
 * consequence of that shared helper's own arithmetic rather than something guarded against here.
 */
export const clampPrimitive: LoguePrimitive = {
  id: 'logue/math/clamp',
  pure: true,
  outletPolarity: 'inherit',
  refinePolarity: (ctx) => {
    const input = ctx.inlet('in')
    if (input === undefined || !ranged(input)) return undefined
    const lo = ctx.param('LO')
    const hi = ctx.param('HI')
    if (lo >= 0) return input === 'gate' && lo === 0 && hi >= 100 ? 'gate' : 'unipolar'
    return hi <= 0 ? 'bipolar' : undefined
  },
  stateBytesPerInstance: 8, // lo_ + hi_, 2 floats
  searchTerms: ['limit', 'rectify', 'positive'],
  description: 'Clamps a signal to a dialable [LO,HI] range.',
  inlets: [{ name: 'in', role: 'audio' }],
  memberDecls: (suffix) => `  float lo_${suffix};\n  float hi_${suffix};\n`,
  renderExpr: (suffix, inlets) => `clampf(${inlets.in ?? '0.f'}, lo_${suffix}, hi_${suffix})`,
  advanceStatement: () => '',
  helpers: [CLAMPF_HELPER],
  params: [
    {
      name: 'LO',
      min: -100,
      max: 100,
      default: -100,
      setStatement: (suffix, valueExpr) => `lo_${suffix} = ${valueExpr} * 0.01f;`
    },
    {
      name: 'HI',
      min: -100,
      max: 100,
      default: 100,
      setStatement: (suffix, valueExpr) => `hi_${suffix} = ${valueExpr} * 0.01f;`
    }
  ]
}

/**
 * Full-wave rectifier -- calls `fabsf` directly, the same "cheap FPU intrinsic, not a real libm
 * cost" precedent already established by `triangleOscPrimitive`/`saturatorPrimitive`'s own
 * `fabsf` calls, so no ternary helper is needed here either.
 */
export const absPrimitive: LoguePrimitive = {
  id: 'logue/math/abs',
  shortLabel: '|x|',
  pure: true,
  outletPolarity: 'inherit',
  refinePolarity: (ctx) => {
    const input = ctx.inlet('in')
    if (input === undefined || !ranged(input)) return undefined
    return input === 'gate' ? 'gate' : 'unipolar'
  },
  stateBytesPerInstance: 0, // stateless, memberDecls is empty
  searchTerms: ['rectify', 'rectifier', 'full-wave'],
  description: 'Outputs the absolute value of a signal (full-wave rectification).',
  inlets: [{ name: 'in', role: 'audio' }],
  memberDecls: () => '',
  renderExpr: (_suffix, inlets) => `fabsf(${inlets.in ?? '0.f'})`,
  advanceStatement: () => ''
}

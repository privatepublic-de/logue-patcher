import type { HelperBlock, LoguePrimitive, PrimitiveParamSpec } from './types'
import { PERCENT } from '../paramPresentation'
import { CLAMPF_HELPER, additiveInletExpr, hashSuffixToSeed } from './shared'

/**
 * Gate/boolean convention for every `logue/logic/*` primitive below (comparators AND boolean
 * ops): output is a hard `0.f`/`1.f`, and any input read AS a gate is thresholded at `>=0.5f`
 * rather than an exact `==1.f`/`!=0.f` check. Chosen over a `+-1` bipolar gate for two concrete
 * reasons: fed into `logue/math/multiply` or `logue/gain/vca`'s own `gain` inlet, `0`=mute/
 * `1`=unity-pass-through is exactly the multiply semantics a "gate" should have -- a `+-1`
 * convention would make "closed" INVERT the signal instead of muting it, which is wrong. And
 * `>=0.5f` happens to also correctly read a raw BIPOLAR `+-1` square LFO wired directly into a
 * gate input with no converter needed (`-1` reads false, `+1` reads true) -- free compatibility
 * with this registry's existing bipolar-by-default sources (oscillators/LFOs/`constant`).
 */

/**
 * Shared by `greater-than`/`less-than`/`equal`'s own `renderExpr` -- the same "collapse a
 * variable-vs-variable op and a variable-vs-constant op into one primitive" shape
 * `logue/math/scale` already established for multiply/divide: a `THRESHOLD` dial (`-100..100`,
 * the same domain/scale `logue/util/constant`'s own `VALUE` uses) with an optional additive `b`
 * inlet on top. Deliberately unclamped and added in raw, unscaled -- `b` is a compared-against
 * OPERAND, not a modulation depth nudging a dial position, so it skips the `+-50`/clamp-to-range
 * treatment every other additive inlet in this file uses (same disclosed deviation
 * `logue/math/scale`'s own doc comment already made for the identical reason). Unwired `b` means
 * "compare against a dialed constant"; wired `b` with `THRESHOLD=0` means a true two-signal
 * compare.
 */
function thresholdExpr(suffix: string, inlets: Record<string, string | undefined>): string {
  return inlets.b !== undefined ? `(threshold_${suffix} + (${inlets.b}))` : `threshold_${suffix}`
}

const THRESHOLD_PARAM: PrimitiveParamSpec = {
  name: 'THRESHOLD',
  min: -100,
  max: 100,
  default: 0,
  setStatement: (suffix, valueExpr) => `threshold_${suffix} = ${valueExpr} * 0.01f;`
}

/**
 * A comparator -- outputs a hard gate (see this file's own gate-convention doc comment just
 * above), `1.f` when `a` exceeds the dialed/wired threshold, `0.f` otherwise. `a` left unwired
 * reads as silence (`0.f`), same convention as every other signal inlet in this registry, which
 * compares against the threshold exactly as any other value would.
 */
export const greaterThanPrimitive: LoguePrimitive = {
  id: 'logue/logic/greater-than',
  pure: true,
  outletPolarity: 'gate',
  stateBytesPerInstance: 4, // threshold_, 1 float
  description: 'Outputs 1 when a signal exceeds a dialable threshold, 0 otherwise.',
  inlets: [
    { name: 'a', role: 'control' },
    { name: 'b', role: 'control' }
  ],
  memberDecls: (suffix) => `  float threshold_${suffix};\n`,
  renderExpr: (suffix, inlets) =>
    `((${inlets.a ?? '0.f'}) > (${thresholdExpr(suffix, inlets)}) ? 1.f : 0.f)`,
  advanceStatement: () => '',
  params: [
    {
      ...THRESHOLD_PARAM,
      modulatedBy: {
        inlet: 'b',
        shape: 'additive',
        unclamped: true,
        note: 'b is added to the threshold as-is, not clamped'
      }
    }
  ]
}

/** `less-than`'s mirror -- see `greaterThanPrimitive`'s own doc comment. */
export const lessThanPrimitive: LoguePrimitive = {
  id: 'logue/logic/less-than',
  pure: true,
  outletPolarity: 'gate',
  stateBytesPerInstance: 4, // threshold_, 1 float
  description: 'Outputs 1 when a signal is below a dialable threshold, 0 otherwise.',
  inlets: [
    { name: 'a', role: 'control' },
    { name: 'b', role: 'control' }
  ],
  memberDecls: (suffix) => `  float threshold_${suffix};\n`,
  renderExpr: (suffix, inlets) =>
    `((${inlets.a ?? '0.f'}) < (${thresholdExpr(suffix, inlets)}) ? 1.f : 0.f)`,
  advanceStatement: () => '',
  params: [
    {
      ...THRESHOLD_PARAM,
      modulatedBy: {
        inlet: 'b',
        shape: 'additive',
        unclamped: true,
        note: 'b is added to the threshold as-is, not clamped'
      }
    }
  ]
}

/**
 * Float equality is otherwise unreachable against a dialed/wired threshold -- an exact `==`
 * would almost never fire (the same `0.01f`/`*16.f` roundtrip hazard `harmonic_ratio`'s own doc
 * comment discloses, here with no integer snap-back to rescue it), so this needs a real
 * tolerance WINDOW rather than a single comparison operator. `TOLERANCE` (0-100 percent of this
 * registry's own `-1..1`/`0..1` full-scale range, scaled the same `*0.01f` way as every other
 * percent param here) defaults to a small but real `2` (`+-0.02` around the threshold) --
 * `0` would make this behave identically to an exact, near-unreachable `==` for anything but a
 * literal unwired-both-sides `0==0` case, defeating the entire reason this primitive exists.
 */
export const equalPrimitive: LoguePrimitive = {
  id: 'logue/logic/equal',
  pure: true,
  outletPolarity: 'gate',
  stateBytesPerInstance: 8, // threshold_ + tolerance_, 2 floats
  description:
    'Outputs 1 when a signal is within a dialable tolerance of a threshold, 0 otherwise.',
  inlets: [
    { name: 'a', role: 'control' },
    { name: 'b', role: 'control' }
  ],
  memberDecls: (suffix) => `  float threshold_${suffix};\n  float tolerance_${suffix};\n`,
  renderExpr: (suffix, inlets) =>
    `(fabsf((${inlets.a ?? '0.f'}) - (${thresholdExpr(suffix, inlets)})) <= tolerance_${suffix} ? 1.f : 0.f)`,
  advanceStatement: () => '',
  params: [
    {
      ...THRESHOLD_PARAM,
      modulatedBy: {
        inlet: 'b',
        shape: 'additive',
        unclamped: true,
        note: 'b is added to the threshold as-is, not clamped'
      }
    },
    {
      name: 'TOLERANCE',
      min: 0,
      max: 100,
      default: 2,
      setStatement: (suffix, valueExpr) => `tolerance_${suffix} = ${valueExpr} * 0.01f;`
    }
  ]
}

/**
 * Logic AND -- both `a`/`b` read as a gate (`>=0.5f`, see this file's own gate-convention doc
 * comment above `thresholdExpr`), unwired reads as `0.f`/false, same convention as every other
 * signal inlet here. A real, disclosed consequence of that uniform "unwired = silence" rule: AND
 * with one input left unwired is always false (false AND anything is false) -- no special-cased
 * identity element, the same "let the primitive's own arithmetic define the edge case" precedent
 * `logue/math/clamp`'s own doc comment already sets.
 */
export const andPrimitive: LoguePrimitive = {
  id: 'logue/logic/and',
  pure: true,
  outletPolarity: 'gate',
  stateBytesPerInstance: 0, // stateless, memberDecls is empty
  description: 'Outputs 1 only when both gate inputs are open.',
  inlets: [
    { name: 'a', role: 'control' },
    { name: 'b', role: 'control' }
  ],
  memberDecls: () => '',
  renderExpr: (_suffix, inlets) =>
    `(((${inlets.a ?? '0.f'}) >= 0.5f) && ((${inlets.b ?? '0.f'}) >= 0.5f) ? 1.f : 0.f)`,
  advanceStatement: () => ''
}

/** Logic OR -- see `andPrimitive`'s own doc comment for the shared gate-read/unwired convention. */
export const orPrimitive: LoguePrimitive = {
  id: 'logue/logic/or',
  pure: true,
  outletPolarity: 'gate',
  stateBytesPerInstance: 0, // stateless, memberDecls is empty
  description: 'Outputs 1 when either gate input is open.',
  inlets: [
    { name: 'a', role: 'control' },
    { name: 'b', role: 'control' }
  ],
  memberDecls: () => '',
  renderExpr: (_suffix, inlets) =>
    `(((${inlets.a ?? '0.f'}) >= 0.5f) || ((${inlets.b ?? '0.f'}) >= 0.5f) ? 1.f : 0.f)`,
  advanceStatement: () => ''
}

/** Logic XOR -- see `andPrimitive`'s own doc comment for the shared gate-read/unwired convention. */
export const xorPrimitive: LoguePrimitive = {
  id: 'logue/logic/xor',
  pure: true,
  outletPolarity: 'gate',
  stateBytesPerInstance: 0, // stateless, memberDecls is empty
  description: 'Outputs 1 when exactly one gate input is open.',
  inlets: [
    { name: 'a', role: 'control' },
    { name: 'b', role: 'control' }
  ],
  memberDecls: () => '',
  renderExpr: (_suffix, inlets) =>
    `((((${inlets.a ?? '0.f'}) >= 0.5f) != ((${inlets.b ?? '0.f'}) >= 0.5f)) ? 1.f : 0.f)`,
  advanceStatement: () => ''
}

/**
 * Called from `renderExpr` (the "mutation lives in a static helper, `advanceStatement` is a
 * no-op" shape every next-sample-depends-on-this-sample primitive in this file already uses --
 * `onepole_step`/`ad_env_step`/`sample_hold_step` are the precedent). Opens (`*state=1`) once
 * `value` reaches `high`, closes (`*state=0`) once it drops to `low`; anywhere strictly BETWEEN
 * the two, the previous state just holds -- the entire point of a hysteresis band, unlike a
 * plain `logue/logic/greater-than`, which chatters on a noisy/slowly-changing signal hovering
 * right at a single threshold.
 */
const SCHMITT_STEP_HELPER: HelperBlock = {
  key: 'schmitt_step',
  code: `  static float schmitt_step(float *state, float value, float high, float low)
  {
    if (value >= high) *state = 1.f;
    else if (value <= low) *state = 0.f;
    return *state;
  }
`
}

/**
 * A hysteresis comparator -- the real reason to reach for this over a plain
 * `logue/logic/greater-than`: a signal hovering right at a single fixed threshold (sensor noise,
 * a slow LFO lingering near its own midpoint) makes a plain comparator's output chatter rapidly
 * open/closed; `HYSTERESIS` carves out a dead band around `THRESHOLD` (`high = THRESHOLD +
 * HYSTERESIS`, `low = THRESHOLD - HYSTERESIS`) so the output only flips once the signal commits
 * to genuinely crossing all the way through it. Reuses `THRESHOLD_PARAM` directly (same shared
 * object `greaterThanPrimitive`/`lessThanPrimitive`/`equalPrimitive` already use, same "shared
 * spec across primitives" precedent `COARSE_PARAM`/`FINE_PARAM` already set for every
 * oscillator) -- this primitive's own `THRESHOLD` means exactly the same thing.
 *
 * Deliberately no wired `b` operand the way `greater-than`/`less-than`/`equal` have: those add
 * ONE additive term to ONE threshold; this primitive has TWO derived edges, so a wired operand
 * would need to shift both symmetrically or independently, disproportionate complexity for what
 * a lower-priority phase-4 primitive needs. No `noteOn` reset -- this tracks a continuous
 * control signal's own open/closed state across the whole instrument's lifetime, the same
 * "no note-triggered state of its own" reasoning `logue/filter/svf`/every plain filter already
 * has, not an envelope-shaped primitive.
 */
export const schmittPrimitive: LoguePrimitive = {
  id: 'logue/logic/schmitt',
  outletPolarity: 'gate',
  stateBytesPerInstance: 12, // threshold_ + hysteresis_ + state_, 3 floats
  description:
    'A hysteresis comparator -- opens above THRESHOLD+HYSTERESIS, closes below THRESHOLD-HYSTERESIS, ignoring noise in between.',
  inlets: [{ name: 'a', role: 'control' }],
  memberDecls: (suffix) =>
    `  float threshold_${suffix};\n  float hysteresis_${suffix};\n  float state_${suffix};\n`,
  initStatement: (suffix) => `    state_${suffix} = 0.f;\n`,
  renderExpr: (suffix, inlets) =>
    `schmitt_step(&state_${suffix}, ${inlets.a ?? '0.f'}, threshold_${suffix} + hysteresis_${suffix}, threshold_${suffix} - hysteresis_${suffix})`,
  advanceStatement: () => '',
  helpers: [SCHMITT_STEP_HELPER],
  params: [
    THRESHOLD_PARAM,
    {
      name: 'HYSTERESIS',
      min: 0,
      max: 100,
      default: 5,
      setStatement: (suffix, valueExpr) => `hysteresis_${suffix} = ${valueExpr} * 0.01f;`
    }
  ]
}

/**
 * Called from `renderExpr`, same "mutation in a static helper" shape as `schmitt_step` above.
 * `open` is this registry's usual `>=0.5f` gate read (this file's own gate-convention doc comment,
 * above `thresholdExpr`) re-derived from the raw wired value HERE rather than passed in
 * pre-thresholded, so the helper stays the single source of truth for both the open/closed state
 * AND the edge comparison. A signal already open at the very first sample (e.g. wired straight
 * to an always-on constant) reads as a rising edge on that first sample too -- `*prevOpen` starts
 * at `0.f` (see `initStatement`), so "closed" is this primitive's own genuine initial state, and
 * transitioning out of it is a real edge, the same "power-on trigger" any real edge detector
 * exhibits, not a bug to special-case away.
 *
 * `ad_env_step`, `ahd_env_step` and `trig_hold_step` inline the same two-line edge check on
 * purpose (considered and declined 2026-09-28): calling this from them would make a per-sample
 * helper call another helper, the xd `-Os` shape behind the formant/granular hangs, and even an
 * always-inline version changes their generated code (staling the CPU table) for three lines.
 */
const EDGE_STEP_HELPER: HelperBlock = {
  key: 'edge_step',
  code: `  static float edge_step(float *prevOpen, float value)
  {
    float isOpen = (value >= 0.5f) ? 1.f : 0.f;
    float triggered = (isOpen > *prevOpen) ? 1.f : 0.f;
    *prevOpen = isOpen;
    return triggered;
  }
`
}

/**
 * Emits a one-sample trigger pulse on each rising edge of a gate signal -- turns a signal that
 * STAYS open (e.g. a held `logue/logic/greater-than` output, or a slow LFO's own gate-thresholded
 * reading) into a brief, one-shot EVENT instead. Disclosed limitation, honestly: nothing else in
 * this registry currently listens for a wired one-shot trigger the way a sequencer step or a
 * retriggered envelope would (`logue/env/ad`/`logue/env/ahd` only ever fire from the platform's
 * real `noteOn`/`noteOff` hooks, never a wired signal) -- so today this is genuinely useful for
 * an audible one-sample click (fed into a `logue/gain/vca` or `logue/filter/comb` as a percussive
 * excitation), or as a building block feeding further `logue/logic/*` combinational logic, rather
 * than for retriggering an envelope. No `noteOn` reset, same reasoning as `logue/logic/schmitt`
 * above -- this tracks edges in a continuous control signal, not a per-note event.
 */
export const edgePrimitive: LoguePrimitive = {
  id: 'logue/logic/edge',
  outletPolarity: 'gate',
  stateBytesPerInstance: 4, // prevOpen_, 1 float
  description:
    'Emits a one-sample trigger pulse on each rising edge (0->1 transition) of a gate signal.',
  inlets: [{ name: 'in', role: 'control' }],
  memberDecls: (suffix) => `  float prevOpen_${suffix};\n`,
  initStatement: (suffix) => `    prevOpen_${suffix} = 0.f;\n`,
  renderExpr: (suffix, inlets) => `edge_step(&prevOpen_${suffix}, ${inlets.in ?? '0.f'})`,
  advanceStatement: () => '',
  helpers: [EDGE_STEP_HELPER]
}

const CHANCE_STEP_HELPER: HelperBlock = {
  key: 'chance_step',
  code: `  // On each rising edge of trig, draws once (an LCG, uniform 0..100) whether this gate passes;
  // the output follows trig for as long as it stays open if it did, and stays 0 if not. A leaf.
  static float chance_step(uint32_t *seed, float *prevTrig, float *pass, float trig, float chancePercent)
  {
    const float open = trig >= 0.5f ? 1.f : 0.f;
    if (open > *prevTrig)
    {
      *seed = *seed * 1664525u + 1013904223u;
      *pass = (float)(*seed >> 8) * (100.f / 16777216.f) < chancePercent ? 1.f : 0.f;
    }
    *prevTrig = open;
    return open * *pass;
  }
`
}

const CHANCE_INLET_DEPTH = 50

/**
 * `logue/logic/chance`: lets each gate through with a probability -- CHANCE percent, drawn once
 * at the rising edge, so a gate passes whole or not at all. Axoloti grain-mill's "random" mode
 * (half its clock ticks trigger a grain) is CHANCE 50 on the clock. `chance` additive.
 */
export const chancePrimitive: LoguePrimitive = {
  id: 'logue/logic/chance',
  outletPolarity: 'gate',
  stateBytesPerInstance: 16, // seed_, prevTrig_, pass_, chancePercent_
  description:
    'Lets each gate through with a probability: CHANCE percent, decided at its rising edge.',
  searchTerms: ['probability', 'random', 'trigger'],
  inlets: [
    { name: 'trig', role: 'control' },
    { name: 'chance', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  uint32_t seed_${suffix};\n  float prevTrig_${suffix};\n  float pass_${suffix};\n  float chancePercent_${suffix};\n`,
  initStatement: (suffix) =>
    `    seed_${suffix} = ${hashSuffixToSeed(suffix)}u;\n    prevTrig_${suffix} = 0.f;\n    pass_${suffix} = 0.f;\n`,
  renderExpr: (suffix, inlets) => {
    const chance =
      inlets.chance !== undefined
        ? additiveInletExpr('chancePercent', suffix, inlets.chance, CHANCE_INLET_DEPTH)
        : `chancePercent_${suffix}`
    return `chance_step(&seed_${suffix}, &prevTrig_${suffix}, &pass_${suffix}, ${inlets.trig ?? '0.f'}, ${chance})`
  },
  advanceStatement: () => '',
  helpers: [CLAMPF_HELPER, CHANCE_STEP_HELPER],
  params: [
    {
      name: 'CHANCE',
      unit: PERCENT,
      modulatedBy: { inlet: 'chance', shape: 'additive' },
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `chancePercent_${suffix} = ${valueExpr};`
    }
  ]
}

const ROUND_ROBIN_OUTLETS = 8

const ROUND_ROBIN_STEP_HELPER: HelperBlock = {
  key: 'round_robin_step',
  code: `  // Each rising edge of trig moves to the next of voices outlets (the first edge to the first);
  // returns which one is current, or -1 while trig is closed. A leaf.
  static int round_robin_step(float trig, float *prevTrig, int *current, int voices)
  {
    const float open = trig >= 0.5f ? 1.f : 0.f;
    if (open > *prevTrig)
    {
      *current = *current + 1;
      if (*current >= voices || *current < 0) *current = 0;
    }
    *prevTrig = open;
    return open >= 0.5f ? *current : -1;
  }
`
}

/**
 * `logue/logic/round-robin`: hands each gate on `trig` to the next of its outlets `o1`..`oN` in
 * turn (N = VOICES, 2..8; the others stay 0), so one clock plays N voices one after another --
 * grain-mill's counter + demux. The gate passes whole (open while `trig` is), to whichever outlet
 * was current at its rising edge.
 */
export const roundRobinPrimitive: LoguePrimitive = {
  id: 'logue/logic/round-robin',
  outletPolarity: 'gate',
  stateBytesPerInstance: 12, // prevTrig_, current_, voices_
  description:
    'Sends each gate to the next of its outlets in turn, o1 up to VOICES, then back to o1: one clock playing several voices.',
  inlets: [{ name: 'trig', role: 'control' }],
  outlets: Array.from({ length: ROUND_ROBIN_OUTLETS }, (_, i) => ({ name: `o${i + 1}` })),
  memberDecls: (suffix) =>
    `  float prevTrig_${suffix};\n  int current_${suffix};\n  int voices_${suffix};\n`,
  initStatement: (suffix) => `    prevTrig_${suffix} = 0.f;\n    current_${suffix} = -1;\n`,
  renderExpr: () => {
    throw new Error(
      'logue/logic/round-robin is multi-outlet -- use renderOutletStatements, not renderExpr'
    )
  },
  renderOutletStatements: (suffix, inlets) => {
    const outs = Array.from({ length: ROUND_ROBIN_OUTLETS }, (_, i) => `y_${suffix}_o${i + 1}`)
    return (
      `      const int rr_${suffix} = round_robin_step(${inlets.trig ?? '0.f'}, &prevTrig_${suffix}, &current_${suffix}, voices_${suffix});\n` +
      outs.map((y, i) => `      float ${y} = rr_${suffix} == ${i} ? 1.f : 0.f;\n`).join('') +
      `      ${outs.map((y) => `(void)${y};`).join(' ')}\n`
    )
  },
  advanceStatement: () => '',
  helpers: ROUND_ROBIN_STEP_HELPER,
  params: [
    {
      name: 'VOICES',
      min: 2,
      max: ROUND_ROBIN_OUTLETS,
      default: ROUND_ROBIN_OUTLETS,
      step: 1,
      setStatement: (suffix, valueExpr) => `voices_${suffix} = (int)(${valueExpr});`
    }
  ]
}

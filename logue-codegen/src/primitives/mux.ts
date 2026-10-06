import type { HelperBlock, LoguePrimitive } from './types'
import { CLAMPF_HELPER } from './shared'

/**
 * A hard (non-crossfading) input select -- outputs `i2` when the select gate reads true
 * (`>=0.5f`, this file's own gate convention, see the doc comment above `thresholdExpr`), `i1`
 * otherwise. Genuinely different from `logue/mix/crossfader`: that primitive BLENDS smoothly
 * between two inputs and is the right tool for an audible fade; this one SWITCHES
 * instantaneously, which clicks/pops when switching a continuous audio signal mid-waveform -- a
 * real, disclosed consequence of a hard switch, not something this primitive smooths over. Most
 * useful for switching between two CONTROL signals (e.g. two different LFO shapes feeding the
 * same cutoff) or a deliberately percussive hard-cut audio effect, not an audible crossfade
 * (reach for `crossfader` there instead).
 *
 * `SELECT` (0-100, default 0 -- selects `i1`) is the dial fallback; a wired `sel` inlet FULLY
 * REPLACES it (same "position with a signal" shape `crossfader`'s own `fade`/`vca`'s own `gain`
 * already use, not the additive-nudge shape `width`/`rate`/etc. use) -- a select is a discrete
 * choice, not a depth to nudge. Both `i1`/`i2` left unwired read as silence, same convention as
 * every other signal inlet in this registry.
 */
export const mux2Primitive: LoguePrimitive = {
  id: 'logue/mux/mux2',
  outletPolarity: 'inherit',
  stateBytesPerInstance: 4, // selectPercent_, 1 float
  description:
    'Hard-switches between two signals based on a select gate (clicks on audio -- use crossfader for a smooth fade).',
  inlets: [
    { name: 'i1', role: 'audio' },
    { name: 'i2', role: 'audio' },
    { name: 'sel', role: 'control' }
  ],
  memberDecls: (suffix) => `  float selectPercent_${suffix};\n`,
  renderExpr: (suffix, inlets) => {
    const selectExpr =
      inlets.sel !== undefined ? `((${inlets.sel}) >= 0.5f)` : `(selectPercent_${suffix} >= 50.f)`
    return `(${selectExpr} ? (${inlets.i2 ?? '0.f'}) : (${inlets.i1 ?? '0.f'}))`
  },
  advanceStatement: () => '',
  params: [
    {
      name: 'SELECT',
      modulatedBy: {
        inlet: 'sel',
        shape: 'replace',
        expects: { range: 'a gate: below 0.5 picks i1, from 0.5 on i2' }
      },
      select: { count: 2, scale: 100, onThreshold: 50, label: 'In', choiceInlets: ['i1', 'i2'] },
      min: 0,
      max: 100,
      default: 0,
      // Snaps the canvas dial to the two choices; the DSP still thresholds at 50, so an older
      // in-between value plays as before.
      step: 100,
      setStatement: (suffix, valueExpr) => `selectPercent_${suffix} = ${valueExpr};`
    }
  ]
}

/**
 * Resolves a 4-way select's own rounded index from a raw float and returns the matching one of
 * `i1..i4` -- a real helper (unlike `mux2`'s plain ternary) because selecting among 4 branches
 * from a CONTINUOUS wired signal needs rounding to a whole index first (the same "round to the
 * nearest integer, don't truncate" lesson `harmonic_ratio`'s own doc comment already establishes
 * -- truncating would bias every index boundary the same direction instead of landing on the
 * nearest one), and a `switch`/multi-branch result doesn't fit `renderExpr`'s single-expression
 * style the way one comparison does. Clamped defensively to `[0,3]` after rounding -- a wired
 * source isn't guaranteed to already be within the rescaled range the caller expects.
 */
const MUX4_SELECT_HELPER: HelperBlock = {
  key: 'mux4_select',
  code: `  static float mux4_select(float rawIndex, float i1, float i2, float i3, float i4)
  {
    int idx = (int)(rawIndex + 0.5f);
    if (idx < 0) idx = 0;
    if (idx > 3) idx = 3;
    switch (idx)
    {
      case 0: return i1;
      case 1: return i2;
      case 2: return i3;
      default: return i4;
    }
  }
`
}

/**
 * A 4-way hard select, `mux2`'s sibling -- one `INDEX` dial (`0..3`, integer-stepped via `step:
 * 1` so it's a genuine "which input" count, not a percent) or a wired `index` signal choosing
 * which of `i1..i4` passes through, via `mux4_select` above.
 *
 * A wired `index` FULLY REPLACES the dial (same "position with a signal" shape `mux2`'s own
 * `sel` uses) and is read in this registry's default BIPOLAR `-1..1` domain (the same domain
 * `constant`/every oscillator/LFO already use) -- rescaled linearly to `0..3` before rounding, so
 * `-1` lands on `i1` and `+1` lands on `i4`. Same disclosed hard-switch-clicks-on-audio caveat as
 * `mux2`.
 */
export const mux4Primitive: LoguePrimitive = {
  id: 'logue/mux/mux4',
  outletPolarity: 'inherit',
  stateBytesPerInstance: 4, // indexRaw_, 1 float
  description: 'Hard-switches between four signals based on a dialed or wired index.',
  inlets: [
    { name: 'i1', role: 'audio' },
    { name: 'i2', role: 'audio' },
    { name: 'i3', role: 'audio' },
    { name: 'i4', role: 'audio' },
    { name: 'index', role: 'control' }
  ],
  memberDecls: (suffix) => `  float indexRaw_${suffix};\n`,
  renderExpr: (suffix, inlets) => {
    const rawIndexExpr =
      inlets.index !== undefined
        ? `((clampf(${inlets.index}, -1.f, 1.f) + 1.f) * 1.5f)`
        : `indexRaw_${suffix}`
    return `mux4_select(${rawIndexExpr}, ${inlets.i1 ?? '0.f'}, ${inlets.i2 ?? '0.f'}, ${inlets.i3 ?? '0.f'}, ${inlets.i4 ?? '0.f'})`
  },
  advanceStatement: () => '',
  helpers: [MUX4_SELECT_HELPER, CLAMPF_HELPER],
  params: [
    {
      name: 'INDEX',
      modulatedBy: {
        inlet: 'index',
        shape: 'replace',
        expects: {
          range: '−1..1, spread across i1..i4',
          warnFrom: ['unipolar', 'gate'],
          warning:
            'A 0..1 signal here only reaches i3 and i4: the index reads −1..1. Put a unipolar to bipolar in between.'
        }
      },
      select: { count: 4, scale: 1, label: 'In', choiceInlets: ['i1', 'i2', 'i3', 'i4'] },
      min: 0,
      max: 3,
      default: 0,
      step: 1,
      setStatement: (suffix, valueExpr) => `indexRaw_${suffix} = ${valueExpr};`
    }
  ]
}

/**
 * The mux family's routing counterpart -- one input, `sel` (or a dial `SELECT`, same "wired
 * fully replaces dial" shape `mux2`'s own `sel` uses) chooses whether `in` reaches `o0` (false)
 * or `o1` (true); the OTHER outlet reads silence (`0.f`), the same convention every unwired
 * inlet in this registry already uses -- deliberately simpler than Axoloti's own `demux 2` (which
 * took separate `d0`/`d1` "default" inlets for the non-selected outlet) since this registry has
 * no real use for a non-zero idle value on an unselected branch. Same disclosed
 * hard-switch-clicks-on-audio caveat as `mux2`. The third primitive in this registry to need
 * `renderOutletStatements` (`logue/filter/svf`/`logue/filter/formant` are the other two) --
 * unlike those two, there's no shared per-sample state update that must run exactly once, so this
 * needs no helper function, just two independent ternary statements.
 */
export const demux2Primitive: LoguePrimitive = {
  id: 'logue/mux/demux2',
  outletPolarity: 'inherit',
  stateBytesPerInstance: 4, // selectPercent_, 1 float
  description: 'Routes one signal to one of two outputs based on a select gate.',
  inlets: [
    { name: 'in', role: 'audio' },
    { name: 'sel', role: 'control' }
  ],
  outlets: [{ name: 'o0' }, { name: 'o1' }],
  memberDecls: (suffix) => `  float selectPercent_${suffix};\n`,
  renderExpr: () => {
    throw new Error(
      'logue/mux/demux2 is multi-outlet -- use renderOutletStatements, not renderExpr'
    )
  },
  renderOutletStatements: (suffix, inlets) => {
    const selectExpr =
      inlets.sel !== undefined ? `((${inlets.sel}) >= 0.5f)` : `(selectPercent_${suffix} >= 50.f)`
    const inExpr = inlets.in ?? '0.f'
    return (
      `      float y_${suffix}_o0 = (${selectExpr}) ? 0.f : (${inExpr});\n` +
      `      float y_${suffix}_o1 = (${selectExpr}) ? (${inExpr}) : 0.f;\n` +
      `      (void)y_${suffix}_o0; (void)y_${suffix}_o1;\n`
    )
  },
  advanceStatement: () => '',
  params: [
    {
      name: 'SELECT',
      modulatedBy: {
        inlet: 'sel',
        shape: 'replace',
        expects: { range: 'a gate: below 0.5 sends to o0, from 0.5 on o1' }
      },
      select: { count: 2, scale: 100, onThreshold: 50, label: 'Out' },
      min: 0,
      max: 100,
      default: 0,
      // Snaps the canvas dial to the two choices; the DSP still thresholds at 50, so an older
      // in-between value plays as before.
      step: 100,
      setStatement: (suffix, valueExpr) => `selectPercent_${suffix} = ${valueExpr};`
    }
  ]
}

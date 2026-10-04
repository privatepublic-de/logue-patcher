// Presentation metadata a primitive's param/inlet specs carry (primitives.ts) -- no imports,
// so the registry itself can use these.

/**
 * `logue/filter/comb`/`logue/filter/svf`'s own `TRACK`, and `logue/osc/saw`'s own `TZFM`, are
 * each a plain on/off mode switch encoded as a raw 0-100 number (the real *logue manifest format
 * has no boolean param type, so the RAW value stays a number even though the canvas renders it
 * as a checkbox -- see `BooleanParamWidget` below) -- all three primitives' own doc comments call
 * it "a plain runtime threshold, not a blend", confirmed against the actual generated C++:
 * `combCutoffSamplesExpr`/`svfGExpr`/`sawIncrementExpr` (primitives.ts) all branch on the exact
 * same `<member>_<suffix> >= TRACK_ON_RAW_THRESHOLD` comparison. `TRACK_ON_THRESHOLD` mirrors
 * that literal (kept as ONE shared constant so the checkbox's own on/off reading and the OTHER
 * params this file gates can never independently drift onto two different numbers) -- moved from
 * an original `50` to `1` once NTS-1 mkII's own `k_unit_param_type_onoff` device display
 * (`value==0 -> "OFF"`, else `"ON"`) needed to exactly match the DSP's own on/off condition, not
 * just approximate it (see `TRACK_ON_RAW_THRESHOLD` in `primitives/shared.ts`).
 */
export const TRACK_ON_THRESHOLD = 1

/**
 * A param whose primitive renders it as a checkbox instead of a rotary dial (ParamDial.tsx).
 * `onValue`/`offValue` are the raw numbers a check/uncheck commits going forward -- clean,
 * canonical values, not whatever arbitrary number happened to be there before. `threshold` is
 * how an ALREADY-authored raw value (an old patch, hand-edited XML, or a value set live from a
 * real hardware Param-slot knob) is read back as checked/unchecked -- matching the exact runtime
 * comparison the generated C++ uses, so a legacy `TRACK=62` reads as checked, not some third,
 * ambiguous state.
 */
export interface BooleanParamWidget {
  onValue: number
  offValue: number
  threshold: number
  /** This checkbox's own label -- distinct from `spec.name` since "TRACK" alone reads as a knob
   *  name, not an action, and a checkbox needs a verb-shaped label to read naturally. */
  label: string
}

/**
 * 'inert-when-on': this param has NO effect once the gate param is ON -- e.g. `comb`'s `CUTOFF`/
 * `svf`'s `CUTOFF`, both entirely replaced by a played-note-derived value once `TRACK` engages
 * (confirmed: `combCutoffSamplesExpr`/`svfGExpr`'s own ternaries never read the percent/wired-inlet
 * path at all in that branch). 'inert-when-off': the opposite -- e.g. both primitives' `COARSE`/
 * `FINE`, declared unconditionally but only ever read inside `transposedW0Expr`, which neither
 * primitive's free-running branch calls at all.
 */
export type ParamTrackGateDirection = 'inert-when-on' | 'inert-when-off'

export interface ParamTrackGate {
  /** The sibling param name (on the SAME node) whose value this one is gated by. */
  gateParam: string
  /** The gate param's own spec default, used as a fallback when this node has no explicit
   *  ParamValue for it yet (a freshly-placed instance) -- both known cases are 0, kept explicit
   *  rather than assumed so a future differently-defaulted gate doesn't silently misread. */
  gateDefault: number
  threshold: number
  direction: ParamTrackGateDirection
  /** Why this param is currently inert -- the tooltip on the dial's compact gated icon. */
  label: string
}

/** `raw` is the gate param's OWN current raw value (already resolved with its default applied). */
export function isTrackGated(gate: ParamTrackGate, raw: number): boolean {
  const on = raw >= gate.threshold
  return gate.direction === 'inert-when-on' ? on : !on
}

/**
 * `PrimitiveParamSpec.modulatedBy`: which inlet (if any) affects a param's raw value when wired,
 * and how. Not derivable from the spec -- it lives in each primitive's own `renderExpr` string
 * logic -- so it's declared next to the param it describes, where a change to that inlet's
 * handling is hard to miss. Only the canvas reads it (`ParamDial.tsx`'s wired indicator, `ObjectNode.tsx`'s inlet marker);
 * `logue-primitivePresentation.spec.ts` fails for an inlet nobody's `modulatedBy` names.
 */
export type ParamModulationShape = 'replace' | 'additive'

export interface ParamModulation {
  /** The `PrimitiveInletSpec.name` this param's value is affected by once wired. */
  inlet: string
  /**
   * 'replace': a wired inlet's value is used verbatim in place of the dial's own raw value --
   * the dial has NO further effect once wired (e.g. `lowpass-cheap`'s `CUTOFF`/`cutoff`).
   * 'additive': a wired inlet's value is added to the dial's own raw value (then clamped back
   * into the param's declared range) -- the dial still matters, it's an offset on top of it, not
   * a substitute (e.g. `sine-lfo`'s `RATE`/`rate`).
   */
  shape: ParamModulationShape
  /** Extra caveat text for a case the plain shape label alone would undersell. */
  note?: string
  /** 'replace' only: what the wire should carry, since the dial no longer shows it. */
  expects?: InletExpectation
  /**
   * 'additive' only: how far a wired +-1 moves the dial, in the param's own units. Unset, it is
   * half the param's range -- the house rule (`additiveDepthOf`); set only where codegen uses
   * another one (the whole-range cutoffs/fade/timbre/dcw/SHAPE). Display-only, but
   * `logue-additiveDepth.spec.ts` checks it against the generated code.
   */
  depth?: number
  /** 'additive' only: the sum isn't clamped to the param's range (an operand, logic `b`). */
  unclamped?: boolean
}

/** How far a wired +-1 moves an additive inlet's dial (see `ParamModulation.depth`). */
export function additiveDepthOf(spec: {
  min: number
  max: number
  modulatedBy?: ParamModulation
}): number {
  return spec.modulatedBy?.depth ?? (spec.max - spec.min) / 2
}

/**
 * Shown in the inlet marker's and the overridden dial's tooltips (`range`), and as a warning on a
 * wire whose resolved signal shape (`wirePolarity.ts`) is in `warnFrom` -- for a shape that
 * doesn't break the unit but does something the dial's name doesn't suggest.
 */
export interface InletExpectation {
  range: string
  warnFrom?: ('audio' | 'unipolar' | 'bipolar' | 'gate')[]
  warning?: string
}

/**
 * `PrimitiveParamSpec.unit`: a real-world display unit for a param's raw spec-domain value, for params where the raw 0-100 (or -N..N) number genuinely corresponds to
 * something a synth player would recognize (Hz, ms/s, dB, semitones, cents) -- as opposed to the
 * MAJORITY of params in this registry, which use a deliberately uncalibrated "cheap, not
 * scientifically-tuned" warp (`lowpass-cheap`'s own `cutoff_warp`, `comb`'s free-running `DELAY`,
 * etc. -- see their own doc comments in primitives.ts) where a precise physical unit would
 * overstate an accuracy the DSP doesn't actually have. Every formula below is copied VERBATIM
 * from the matching helper in primitives.ts (cited per unit) -- NOT mechanically derived, so it
 * must be kept in sync by hand whenever that helper's own constants change.
 */
export interface ParamUnit {
  /** Format a raw spec-domain value (already clamped to the param's own min/max) for display. */
  toDisplay(raw: number): string
  /**
   * Parse a user-typed string, in this unit, back to a raw spec-domain value -- undefined for
   * unparseable input, matching ParamDial.tsx's own existing "invalid edit is silently discarded"
   * behavior for the plain-number case. The caller still clamps the result to the param's own
   * min/max, same as every other commit path.
   */
  parseInput(text: string): number | undefined
}

/**
 * A unit that depends on another param of the same node (`math/scale`'s FACTOR display on its
 * RANGE). The spec's plain `unit` stays the one at that param's default, for callers that only
 * know the primitive.
 */
export interface ParamUnitDependency {
  param: string
  unitFor(value: number): ParamUnit
}

function formatNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2)
}

/**
 * For a param whose raw value already IS the real-world unit (COARSE is already semitones, FINE
 * is already cents, WIDTH/FADE are already a plain percent) -- pure display formatting, no
 * conversion math at all. `showSign` puts an explicit `+` on a positive value, matching how a
 * pitch-trim control conventionally reads (`+3 st`, not `3 st`) -- only used for the two signed
 * (semitone/cent) cases, never the unsigned 0-100 percent ones.
 */
function identityUnit(suffix: string, showSign = false): ParamUnit {
  return {
    toDisplay(raw) {
      const sign = showSign && raw > 0 ? '+' : ''
      return `${sign}${formatNumber(raw)}${suffix}`
    },
    // Number.parseFloat already stops at the first non-numeric character and accepts a leading
    // `+`/`-`, so it round-trips this unit's own `toDisplay` output (e.g. "+3 st", "62%") as-is.
    parseInput(text) {
      const n = Number.parseFloat(text)
      return Number.isFinite(n) ? n : undefined
    }
  }
}

/**
 * Mirrors `LFO_RATE_HELPER`/`lfo_rate_from_percent` (primitives.ts) EXACTLY: `hz = 0.1 + t^3*19.9`
 * where `t = percent/100`. That helper's own return value is a per-sample phase increment
 * (`hz/48000`), not Hz itself -- this unit stops one step earlier, at the Hz the helper computes
 * before that final division, since Hz is what a synth player reads a rate as.
 */
function lfoHzUnit(): ParamUnit {
  const toHz = (raw: number): number => 0.1 + Math.pow(raw * 0.01, 3) * 19.9
  const toRaw = (hz: number): number => Math.cbrt(Math.max(0, hz - 0.1) / 19.9) * 100
  return {
    toDisplay(raw) {
      return `${toHz(raw).toFixed(2)} Hz`
    },
    parseInput(text) {
      const n = Number.parseFloat(text)
      return Number.isFinite(n) ? toRaw(n) : undefined
    }
  }
}

/**
 * Mirrors `FAST_LFO_RATE_HELPER`/`fast_lfo_rate_from_percent` (primitives.ts) EXACTLY:
 * `hz = 0.1 + t^4*1999.9`. Switches to kHz at/above 1000 Hz, and shows fewer decimals as the
 * value grows, since the dial spans ~14 octaves.
 */
function fastLfoHzUnit(): ParamUnit {
  const toHz = (raw: number): number => 0.1 + Math.pow(raw * 0.01, 4) * 1999.9
  const toRaw = (hz: number): number => Math.pow(Math.max(0, hz - 0.1) / 1999.9, 0.25) * 100
  return {
    toDisplay(raw) {
      const hz = toHz(raw)
      if (hz >= 1000) return `${(hz / 1000).toFixed(2)} kHz`
      return `${hz.toFixed(hz >= 100 ? 0 : hz >= 10 ? 1 : 2)} Hz`
    },
    parseInput(text) {
      const match = text.trim().match(/^(-?[\d.]+)\s*(khz|hz)?$/i)
      if (!match) return undefined
      const n = Number.parseFloat(match[1])
      if (!Number.isFinite(n)) return undefined
      return toRaw(match[2]?.toLowerCase() === 'khz' ? n * 1000 : n)
    }
  }
}

/**
 * Mirrors `ENV_RATE_HELPER`/`env_rate_from_percent` (primitives.ts) EXACTLY: `ms = 5 + t*1995`
 * where `t = percent/100`. Switches to seconds at/above 1000ms (`1.20 s`, not `1200 ms`) --
 * matching how most envelope editors display a long stage, not a property of the underlying math.
 * `parseInput` accepts an explicit `ms`/`s` suffix (case-insensitive) and treats a bare number as
 * milliseconds, the base unit the formula itself works in.
 */
// `delaySamplesExpr` (primitives/util.ts): 0.1 ms + 19.9 ms * t^2.
function delayMsUnit(): ParamUnit {
  return {
    toDisplay: (raw) => `${(0.1 + 19.9 * (raw / 100) ** 2).toFixed(2)} ms`,
    parseInput(text) {
      const n = Number.parseFloat(text)
      if (!Number.isFinite(n)) return undefined
      return Math.sqrt(Math.max(0, n - 0.1) / 19.9) * 100
    }
  }
}

/** `lo + span * t^2` ms for a 0-100 raw t: fine resolution at the short end. */
function squaredMsUnit(lo: number, span: number): ParamUnit {
  return {
    toDisplay(raw) {
      const ms = lo + span * (raw / 100) ** 2
      return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(ms < 10 ? 2 : 1)} ms`
    },
    parseInput(text) {
      const n = Number.parseFloat(text)
      if (!Number.isFinite(n)) return undefined
      const ms = /s\s*$/i.test(text) && !/ms\s*$/i.test(text) ? n * 1000 : n
      return Math.sqrt(Math.max(0, ms - lo) / span) * 100
    }
  }
}

// `bass_glide_coeff` (primitives/osc.ts): 2000 ms * t^2, 0 = no glide.
function bassGlideMsUnit(): ParamUnit {
  return {
    toDisplay(raw) {
      const ms = 2000 * (raw / 100) ** 2
      if (ms <= 0) return 'Off'
      return ms >= 1000
        ? `${(ms / 1000).toFixed(2)} s`
        : `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`
    },
    parseInput(text) {
      const match = /(-?\d+(?:\.\d+)?)\s*(ms|s)?/i.exec(text.trim())
      if (!match) return /^off$/i.test(text.trim()) ? 0 : undefined
      const n = Number.parseFloat(match[1])
      if (!Number.isFinite(n)) return undefined
      const ms = match[2]?.toLowerCase() === 's' ? n * 1000 : n
      return Math.sqrt(Math.max(0, ms) / 2000) * 100
    }
  }
}

// `bass_tone_g` (primitives/osc.ts): the lowpass sits at 1 + 31*t^2 times the played pitch.
function bassToneMultipleUnit(): ParamUnit {
  return {
    toDisplay: (raw) => `${(1 + 31 * (raw / 100) ** 2).toFixed(1)}x pitch`,
    parseInput(text) {
      const n = Number.parseFloat(text)
      if (!Number.isFinite(n)) return undefined
      return Math.sqrt(Math.max(0, n - 1) / 31) * 100
    }
  }
}

// `freqShiftIncExpr` (primitives/util.ts): +-2000 Hz * s^3 for a -100..100 raw s, so the slow
// barber-pole range near 0 gets most of a knob's travel.
function freqShiftHzUnit(): ParamUnit {
  return {
    toDisplay(raw) {
      const hz = 2000 * (raw / 100) ** 3
      const sign = hz > 0 ? '+' : hz < 0 ? '-' : ''
      const mag = Math.abs(hz)
      if (mag >= 1000) return `${sign}${(mag / 1000).toFixed(2)} kHz`
      return `${sign}${mag.toFixed(mag >= 100 ? 0 : mag >= 10 ? 1 : 2)} Hz`
    },
    parseInput(text) {
      const match = text.trim().match(/^([+-]?[\d.]+)\s*(khz|hz)?$/i)
      if (!match) return undefined
      const n = Number.parseFloat(match[1])
      if (!Number.isFinite(n)) return undefined
      const hz = match[2]?.toLowerCase() === 'khz' ? n * 1000 : n
      return Math.cbrt(hz / 2000) * 100
    }
  }
}

// A 0-based choice shown by name; typing the name, or its 1-based number, selects it.
function namedChoiceUnit(names: string[]): ParamUnit {
  return {
    toDisplay: (raw) => names[Math.round(raw)] ?? String(raw),
    parseInput(text) {
      const t = text.trim().toLowerCase()
      const byName = names.findIndex((n) => n.toLowerCase() === t)
      if (byName >= 0) return byName
      const n = Number.parseInt(t.replace(/^\D+/, ''), 10)
      return Number.isFinite(n) ? n - 1 : undefined
    }
  }
}

// `mseg_rate_from_percent` (primitives/env.ts): 0 = one sample (a step), then `8000*t^3` ms.
function msegStageMsUnit(): ParamUnit {
  const toMs = (raw: number): number => 8000 * Math.pow(raw * 0.01, 3)
  return {
    toDisplay(raw) {
      const ms = toMs(raw)
      return ms >= 1000
        ? `${(ms / 1000).toFixed(2)} s`
        : `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`
    },
    parseInput(text) {
      const match = /(-?\d+(?:\.\d+)?)\s*(ms|s)?/i.exec(text.trim())
      if (!match) return undefined
      const n = Number.parseFloat(match[1])
      if (!Number.isFinite(n) || n < 0) return undefined
      const ms = match[2]?.toLowerCase() === 's' ? n * 1000 : n
      return Math.cbrt(ms / 8000) * 100
    }
  }
}

// `msegTimeScaleExpr` (primitives/env.ts): 0.1x at 0, 1x at 50, 10x at 100, linear on each side.
function msegTimeScaleUnit(): ParamUnit {
  const toScale = (raw: number): number =>
    raw < 50 ? 0.1 + 0.9 * (raw / 50) : 1 + 9 * ((raw - 50) / 50)
  return {
    toDisplay: (raw) => `${toScale(raw).toFixed(2)}x`,
    parseInput(text) {
      const n = Number.parseFloat(text)
      if (!Number.isFinite(n)) return undefined
      return n < 1 ? ((n - 0.1) / 0.9) * 50 : 50 + ((n - 1) / 9) * 50
    }
  }
}

/**
 * A plain multiplier `raw * scale`, shown as `0.50x`/`-1.00x` so the dial reads as the factor
 * it applies rather than a bare -100..100. A typed number is the factor (`0.5`, `-0.25x`).
 */
function factorUnit(scale: number): ParamUnit {
  return {
    toDisplay: (raw) => `${(raw * scale).toFixed(2)}x`,
    parseInput(text) {
      const n = Number.parseFloat(text)
      return Number.isFinite(n) ? n / scale : undefined
    }
  }
}

function envMsUnit(): ParamUnit {
  const toMs = (raw: number): number => 5 + raw * 0.01 * 1995
  const toRaw = (ms: number): number => ((ms - 5) / 1995) * 100
  return {
    toDisplay(raw) {
      const ms = toMs(raw)
      return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`
    },
    parseInput(text) {
      const match = /(-?\d+(?:\.\d+)?)\s*(ms|s)?/i.exec(text.trim())
      if (!match) return undefined
      const n = Number.parseFloat(match[1])
      if (!Number.isFinite(n)) return undefined
      const ms = match[2]?.toLowerCase() === 's' ? n * 1000 : n
      return toRaw(ms)
    }
  }
}

/**
 * A plain linear gain (`gain = intercept + slope*raw`) shown as dB (`20*log10(gain)`) -- the
 * `intercept`/`slope` pair mirrors one primitive's own `setStatement`/`driveGainExpr` formula
 * (cited per call site below), so this is one shared implementation of "linear gain -> dB" rather
 * than three near-duplicates. `gain <= 0` (only reachable on `vca`'s own `GAIN=0`, since the two
 * `DRIVE` params both have a `1.0` floor) displays as `-∞ dB` and refuses to parse back --
 * matching ParamDial.tsx's "invalid edit is silently discarded" rule, since there's no finite raw
 * value that produces exactly zero gain to solve for from a dB target of `-Infinity`.
 */
function linearDbUnit(intercept: number, slope: number): ParamUnit {
  const toGain = (raw: number): number => intercept + slope * raw
  return {
    toDisplay(raw) {
      const gain = toGain(raw)
      if (gain <= 0) return '-∞ dB'
      const db = 20 * Math.log10(gain)
      return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`
    },
    parseInput(text) {
      const n = Number.parseFloat(text)
      if (!Number.isFinite(n)) return undefined
      const gain = 10 ** (n / 20)
      return (gain - intercept) / slope
    }
  }
}

/**
 * Mirrors `combCutoffSamplesExpr`'s free-running branch (primitives.ts) EXACTLY: `samples =
 * (int)(1 + (100-raw)*5.10)` (raw is the 0-100 `CUTOFF` value directly, not normalized first) --
 * note the `100-raw` flip, since `CUTOFF` (unlike phase 16's own `DELAY`) follows this registry's
 * usual "higher = brighter/shorter" filter-cutoff convention, at the platform's real fixed 48kHz
 * sample rate. Only correct for `TRACK<1` -- the tracked branch replaces this entirely with a
 * played-note-derived length, which has no static value to show; ParamDial.tsx is responsible
 * for not calling this unit's `toDisplay` at all while `TRACK` gates it off (see
 * `@logue-codegen/paramTrackGate`), not this function.
 */
function combCutoffMsUnit(): ParamUnit {
  const toSamples = (raw: number): number => Math.trunc(1 + (100 - raw) * 5.1)
  const toMs = (raw: number): number => toSamples(raw) / 48
  const toRaw = (ms: number): number => 100 - (ms * 48 - 1) / 5.1
  return {
    toDisplay(raw) {
      return `${toMs(raw).toFixed(2)} ms`
    },
    parseInput(text) {
      const n = Number.parseFloat(text)
      return Number.isFinite(n) ? toRaw(n) : undefined
    }
  }
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** A MIDI note number shown as a name (60 = C4, the convention the *logue devices use); accepts a
 *  typed name ("A3", "f#2") or a plain number. */
function noteNameUnit(): ParamUnit {
  return {
    toDisplay(raw) {
      const n = Math.round(raw)
      return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`
    },
    parseInput(text) {
      const m = text.trim().match(/^([a-gA-G])(#?)(-?\d+)$/)
      if (m) {
        const pc = NOTE_NAMES.indexOf(m[1].toUpperCase() + m[2])
        return pc < 0 ? undefined : (Number(m[3]) + 1) * 12 + pc
      }
      const n = Number.parseFloat(text)
      return Number.isFinite(n) ? n : undefined
    }
  }
}

export const SEMITONES = identityUnit(' st', true)
export const CENTS = identityUnit(' ct', true)
export const PERCENT = identityUnit('%')
export const LFO_HZ = lfoHzUnit()
export const FAST_LFO_HZ = fastLfoHzUnit()
export const ENV_MS = envMsUnit()
export const MSEG_STAGE_MS = msegStageMsUnit()
export const DELAY_MS = delayMsUnit()
export const FREQ_SHIFT_HZ = freqShiftHzUnit()
export const ALLPASS_MS = squaredMsUnit(0.5, 99.5)
export const FOLLOWER_ATTACK_MS = squaredMsUnit(0.1, 99.9)
export const FOLLOWER_RELEASE_MS = squaredMsUnit(1, 1999)
export const MSEG_MODE_NAME = namedChoiceUnit(['Oneshot', 'Sustain', 'Loop', 'Cycle'])
export const SYNC_SHAPE_NAME = namedChoiceUnit(['Saw', 'Pulse', 'Tri', 'Sine'])
/** `logue/mix/stereo-crossfader`'s LAW choices, in select order. */
export const STEREO_XFADE_LAWS = ['Power', 'Linear']
export const STEREO_XFADE_LAW_NAME = namedChoiceUnit(STEREO_XFADE_LAWS)
/** `logue/osc/noise`'s COLOR choices, in select order. */
export const NOISE_COLOR_NAMES = ['White', 'Pink', 'Brown', 'Violet']
export const NOISE_COLOR_NAME = namedChoiceUnit(NOISE_COLOR_NAMES)
/** `logue/osc/lfsr`'s MODE choices, in select order. */
export const LFSR_MODE_NAMES = ['Long', 'Short']
export const LFSR_MODE_NAME = namedChoiceUnit(LFSR_MODE_NAMES)
/** `logue/osc/sample`'s LOOP and INTERP choices (NTS-1 mkII: 7 characters at most). */
export const SAMPLE_LOOP_NAMES = ['Off', 'Forward', 'PingPng']
export const SAMPLE_LOOP_NAME = namedChoiceUnit(['Off', 'Forward', 'Ping-pong'])
export const SAMPLE_INTERP_NAMES = ['Linear', 'None']
export const SAMPLE_INTERP_NAME = namedChoiceUnit(SAMPLE_INTERP_NAMES)
/** `logue/util/slew`'s MODE choices, in select order. */
export const SLEW_MODE_NAMES = ['Linear', 'Exp']
export const SLEW_MODE_NAME = namedChoiceUnit(['Linear', 'Exponential'])
export const WAVETABLE_MORPH_NAMES = ['Smooth', 'Step']
export const WAVETABLE_MORPH_NAME = namedChoiceUnit(WAVETABLE_MORPH_NAMES)
/** `logue/osc/phase-dist`'s waves, in the CZ's own order (NTS-1 mkII: 7 characters at most). */
export const PD_WAVE_NAMES = [
  'Saw',
  'Square',
  'Pulse',
  'DblSine',
  'SawPuls',
  'Reso 1',
  'Reso 2',
  'Reso 3'
]
export const PD_WAVE_NAME = namedChoiceUnit(PD_WAVE_NAMES)
export const PD_WAVE2_NAMES = ['Off', ...PD_WAVE_NAMES]
export const PD_WAVE2_NAME = namedChoiceUnit(PD_WAVE2_NAMES)
export const BASS_GLIDE_MS = bassGlideMsUnit()
export const BASS_TONE_MULTIPLE = bassToneMultipleUnit()
export const QUANTIZE_SCALE = namedChoiceUnit([
  'Chromatic',
  'Major',
  'Minor',
  'Dorian',
  'Mixolydian',
  'Harm minor',
  'Maj pent',
  'Min pent',
  'Whole',
  'Octaves'
])
export const ROOT_NOTE = namedChoiceUnit([
  'C',
  'Db',
  'D',
  'Eb',
  'E',
  'F',
  'Gb',
  'G',
  'Ab',
  'A',
  'Bb',
  'B'
])
export const LONG_DELAY_RANGE_NAME = namedChoiceUnit(['0.34 s', '1.4 s', '2.7 s', '5.5 s'])
export const GRAIN_MAXLEN_NAME = namedChoiceUnit(['0.34 s', '0.68 s', '1.4 s'])
export const BUFFER_LENGTH_NAME = namedChoiceUnit(['0.68 s', '1.4 s', '2.7 s', '5.5 s'])
export const TEMPO_DIVISION_NAME = namedChoiceUnit([
  '1/16',
  '1/8T',
  '1/8',
  '1/8D',
  '1/4T',
  '1/4',
  '1/4D',
  '1/2',
  '1/2D',
  '1/1'
])
export const STAGE_NUMBER = namedChoiceUnit(Array.from({ length: 6 }, (_, i) => `St ${i + 1}`))
export const MSEG_TIME_SCALE = msegTimeScaleUnit()

/**
 * `logue/env/one-knob-adsr`'s SHAPE stations, short to long, and the 3-letter forms NTS-1 mkII
 * shows between two of them ("Plk-Mlt"; `-` rather than `>`, which the display
 * may not have). SHAPE 0..100 runs over the 13 stations (one every
 * 8.33); within a fifth of a station's spacing of it the shape is exactly that station
 * (`knob_env_value`, primitives/env.ts -- keep the two mappings in step).
 */
export const KNOB_ENV_SHAPE_NAMES = [
  'Blip',
  'Pluck',
  'Mallet',
  'Piano',
  'Keys',
  'Gate',
  'Organ',
  'Brass',
  'Strings',
  'Bowed',
  'Swell',
  'Pad',
  'Drone'
]
const KNOB_ENV_SHAPE_SHORT = [
  'Blp',
  'Plk',
  'Mlt',
  'Pno',
  'Key',
  'Gat',
  'Org',
  'Brs',
  'Str',
  'Bow',
  'Swl',
  'Pad',
  'Drn'
]
const KNOB_ENV_STATIONS_PER_PERCENT = (KNOB_ENV_SHAPE_NAMES.length - 1) / 100
const KNOB_ENV_PLATEAU = 0.2

/** Which stations SHAPE sits between: one index when it's on a station's plateau. */
function knobEnvStations(raw: number): [number] | [number, number] {
  const last = KNOB_ENV_SHAPE_NAMES.length - 1
  const pos = Math.min(Math.max(raw, 0), 100) * KNOB_ENV_STATIONS_PER_PERCENT
  const i = Math.min(Math.floor(pos), last - 1)
  const f = pos - i
  if (f <= KNOB_ENV_PLATEAU) return [i]
  if (f >= 1 - KNOB_ENV_PLATEAU) return [i + 1]
  return [i, i + 1]
}

function knobEnvShapeUnit(): ParamUnit {
  return {
    toDisplay(raw) {
      const s = knobEnvStations(raw)
      return s.length === 1
        ? KNOB_ENV_SHAPE_NAMES[s[0]]
        : `${KNOB_ENV_SHAPE_NAMES[s[0]]}–${KNOB_ENV_SHAPE_NAMES[s[1]]}`
    },
    parseInput(text) {
      const t = text.trim().toLowerCase()
      const i = KNOB_ENV_SHAPE_NAMES.findIndex((n) => n.toLowerCase() === t)
      if (i >= 0) return Math.round(i / KNOB_ENV_STATIONS_PER_PERCENT)
      const n = Number.parseFloat(t)
      return Number.isFinite(n) ? n : undefined
    }
  }
}

export const KNOB_ENV_SHAPE = knobEnvShapeUnit()

/** NTS-1 mkII's label for every SHAPE value 0..100 (`PrimitiveParamSpec.nts1mkiiStrings`). */
export const KNOB_ENV_SHAPE_DEVICE_STRINGS = Array.from({ length: 101 }, (_, v) => {
  const s = knobEnvStations(v)
  return s.length === 1
    ? KNOB_ENV_SHAPE_NAMES[s[0]]
    : `${KNOB_ENV_SHAPE_SHORT[s[0]]}-${KNOB_ENV_SHAPE_SHORT[s[1]]}`
})
export const COMB_CUTOFF_MS = combCutoffMsUnit()
export const NOTE_NAME = noteNameUnit()
// `scalePrimitive`: `factor_ = FACTOR * 0.01f * range_`, `range_` = 1/2/4/8 by RANGE.
export const SCALE_RANGES = [1, 2, 4, 8]
export const SCALE_RANGE_NAME = namedChoiceUnit(SCALE_RANGES.map((r) => `${r}x`))
export const SCALE_FACTOR = factorUnit(0.01)
export const SCALE_FACTOR_BY_RANGE: ParamUnitDependency = {
  param: 'RANGE',
  unitFor: (value) => factorUnit(0.01 * (SCALE_RANGES[Math.round(value)] ?? 1))
}
// `gain_<suffix> = value * 0.04f` -- `vcaPrimitive`'s own `GAIN` setStatement (primitives.ts),
// widened from the original `*0.01f` alongside `logue/filter/formant`'s own gain complaint --
// see that primitive's own doc comment for why (a real, disclosed rescale, not a display-only
// change: `GAIN=100` now means +12dB, not +0dB).
export const VCA_GAIN_DB = linearDbUnit(0, 0.04)
/**
 * A sound source's LEVEL (`osc/noise`, `osc/lfsr`): stored 0..100 (the xd's manifest takes no
 * negative typeless range), 100 = 0 dB, then `LEVEL_RANGE_DB / 100` dB per step down to -48 dB
 * at 1; 0 is off. The noise sources sit 10-15 dB above an effect's input (measured,
 * `scripts/measureRadioLevels.ts`), so a hiss under the signal is around -30 dB.
 */
export const LEVEL_RANGE_DB = 48
export const LEVEL_DB: ParamUnit = {
  toDisplay(raw) {
    if (raw <= 0) return 'Off'
    const db = ((raw - 100) * LEVEL_RANGE_DB) / 100
    return `${db.toFixed(1)} dB`
  },
  parseInput(text) {
    if (/^\s*off\s*$/i.test(text)) return 0
    const db = Number.parseFloat(text)
    if (!Number.isFinite(db)) return undefined
    return Math.min(100, Math.max(1, 100 + (db * 100) / LEVEL_RANGE_DB))
  }
}

// `logue/mix/mix2`/`stereo-mix2`'s GAIN1/GAIN2: raw * 0.01, so 100 is 0 dB and 1 is -40 dB.
export const MIX_GAIN_DB = linearDbUnit(0, 0.01)
/** `logue/env/follower`'s SENS: a gain of 1 + 0.15 * raw (0..+24 dB) before the clamp to 1,
 *  shown as what it decides -- the input level that reaches full output, 0 .. -24 dB. Typing
 *  "-18" or "18" both mean full output at -18 dB. */
export const FOLLOWER_SENS_DB: ParamUnit = {
  toDisplay(raw) {
    const db = -20 * Math.log10(1 + 0.15 * raw)
    return `full at ${db.toFixed(1)} dB`
  },
  parseInput(text) {
    const n = Number.parseFloat(text.replace(/^\s*full\s*at\s*/i, ''))
    if (!Number.isFinite(n)) return undefined
    return (10 ** (Math.abs(n) / 20) - 1) / 0.15
  }
}
// `driveGainExpr(..., 0.07)` -- primitives.ts:1738 (`wavefolderPrimitive`'s own call site).
export const WAVEFOLDER_DRIVE_DB = linearDbUnit(1, 0.07)
// `driveGainExpr(..., 0.09)` -- primitives.ts:1789 (`saturatorPrimitive`'s own call site).
export const SOFTCLIP_DRIVE_DB = linearDbUnit(1, 0.09)

function trackWidget(label: string): BooleanParamWidget {
  return { onValue: 100, offValue: 0, threshold: TRACK_ON_THRESHOLD, label }
}

export const TRACK_WIDGET = trackWidget('Track note')
export const SYNC_WIDGET = trackWidget('Sync pitch')
export const TZFM_WIDGET = trackWidget('TZ FM')
export const RETRIG_WIDGET = trackWidget('Restart')
export const TEMPO_SYNC_WIDGET = trackWidget('Sync tempo')
export const FREEZE_WIDGET = trackWidget('Freeze')
export const EXP_DECAY_WIDGET = trackWidget('Exp decay')
export const REVERSE_WIDGET = trackWidget('Reverse')

function gate(
  gateParam: string,
  gateDefault: number,
  direction: ParamTrackGateDirection,
  label: string
): ParamTrackGate {
  return { gateParam, gateDefault, threshold: TRACK_ON_THRESHOLD, direction, label }
}

/** A free-running control that the played note replaces while `TRACK` is on. */
export const PITCH_TRACKED_GATE = gate('TRACK', 0, 'inert-when-on', 'Pitch-tracked')
/** A pitch control only read while `TRACK` is on. */
export const NEEDS_TRACK_GATE = gate('TRACK', 0, 'inert-when-off', 'Needs Track')
/** `logue/osc/sample`'s ROOT: TRACK defaults on there (every key is ROOT while it's off). */
export const NEEDS_TRACK_ON_BY_DEFAULT_GATE = gate('TRACK', 100, 'inert-when-off', 'Needs Track')
/** `logue/osc/lfsr`'s free RATE, replaced by the note while `TRACK` (default on) is on. */
export const PITCH_TRACKED_ON_BY_DEFAULT_GATE = gate('TRACK', 100, 'inert-when-on', 'Pitch-tracked')
/** `logue/osc/granular`'s free-running-grain controls, unused while `SYNC` (default on) is on. */
export const UNUSED_WHILE_SYNC_GATE = gate('SYNC', 100, 'inert-when-on', 'Off while Sync')
/** `logue/util/long-delay`'s free time, replaced by DIVISION while `SYNC` (default off) is on. */
export const FREE_TIME_GATE = gate('SYNC', 0, 'inert-when-on', 'Off while synced')
/** `logue/util/long-delay`'s DIVISION, read only while `SYNC` is on. */
export const NEEDS_TEMPO_SYNC_GATE = gate('SYNC', 0, 'inert-when-off', 'Needs Sync')

/**
 * `PrimitiveParamSpec.select`: a hard select (`mux2`/`demux2` SELECT, `mux4` INDEX), shown on the
 * device as `count` discrete choices. `scale` lands device 1 on 100 for `mux2`/`demux2`, whose
 * own threshold is `>=50`. Deliberately opt-in, not a `step: 1` rule: showing an input number is
 * only honest where raw 0 means "the first one". `label` prefixes NTS-1 mkII's choice strings.
 */
export interface SelectParam {
  count: number
  scale: number
  onThreshold?: number
  label: string
  /** NTS-1 mkII's choice strings in place of "<label> 1..N" (keep them to ~7 characters). The xd
   *  has no strings for a typeless param, so it still shows 1..N. */
  names?: string[]
  /**
   * The inlets each choice picks (a mux's i1..iN): on NTS-1 mkII a choice whose inlet is wired is
   * shown as the name of the node wired there (cut to `CHOICE_NAME_MAX_LEN`), so a patch labels
   * its own selector by naming its sources (`resolveExposedParams`).
   */
  choiceInlets?: string[]
}

/** What the NTS-1 mkII's display shows of a choice string (`QUANTIZE_SCALE_NAMES`' limit). */
export const CHOICE_NAME_MAX_LEN = 7

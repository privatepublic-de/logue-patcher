import { findBooleanWidget } from './paramTrackGate'
import { findPrimitiveParamSpec } from './primitives'

/**
 * Which params get an NTS-1 mkII on-device unit type (`PrimitiveParamSpec.nts1mkiiType`). The
 * SDK's `unit_param_t` has a `type` enum (percent/dB/cents/semi/hertz/msec/onoff/...) plus
 * `frac`/`frac_mode`, but the device only renders `raw / 2^frac` or `raw / 10^frac` with a fixed
 * suffix: a plain linear scale, no curves. So a param gets a type only when its raw value already
 * IS the real-world unit (`frac`/`frac_mode` stay 0 for every param emitted today).
 *
 * Declined for good, although `@logue-codegen/paramUnits` shows these units in the app:
 * - comb `CUTOFF` (ms): only meaningful while `TRACK` is off (`@logue-codegen/paramTrackGate`),
 *   and a param has one static type.
 * - `GAIN`/`DRIVE` (dB): storing dB raw would need an `exp10f`/`powf` per sample to get back to
 *   linear gain, against the no-libm rule.
 * - LFO `RATE`, envelope `ATTACK`/`DECAY` (Hz/ms): storing Hz/ms raw would silently change the
 *   meaning of every saved value and break the shared +-50 percent-domain additive inlet shape
 *   (`RATE_INLET_DEPTH`, ...), only to help someone reading the device menu without the app.
 *
 * minilogue xd has no per-param type -- see `resolveMinilogueXdDeviceParam` below, a general rule
 * plus a short list of discrete selects, since its manifest schema has only two types.
 */
export interface ParamDeviceType {
  /** NTS-1 mkII's own `k_unit_param_type_*` enum member, spelled WITHOUT the
   *  `k_unit_param_type_` prefix (e.g. `'semi'` for `k_unit_param_type_semi`). */
  nts1mkii: string
}

export function findParamDeviceType(
  primitiveId: string,
  paramName: string
): ParamDeviceType | undefined {
  const spec = findPrimitiveParamSpec(primitiveId, paramName)
  if (spec?.booleanWidget) return { nts1mkii: 'onoff' }
  return spec?.nts1mkiiType ? { nts1mkii: spec.nts1mkiiType } : undefined
}

/**
 * How one exposed param appears on a device: the manifest/header row's own range and type, plus
 * `scale`, which the generated `setParameter` case multiplies the incoming device value by to get
 * back into the param's own authored (spec) domain. The device range can differ from the spec's
 * so a discrete choice shows as a few clean steps instead of a 0-100 sweep, while stored
 * documents and the canvas keep the spec's range untouched.
 */
export interface DeviceParam {
  min: number
  max: number
  /** minilogue xd: the manifest's `'%'` or typeless `''`. NTS-1 mkII: a `k_unit_param_type_*`
   *  member without the prefix (`'none'`, `'onoff'`, `'strings'`, ...). */
  type: string
  scale: number
  /** A two-step param (select or toggle): the spec value from which it reads as device `1`,
   *  matching the DSP's own threshold -- so a stored `TRACK=30` bakes in as ON, not rounded off. */
  onThreshold?: number
  /** NTS-1 mkII `'strings'` only: the label for each device value from `min`. */
  strings?: readonly string[]
  /** NTS-1 mkII only: the header row's `frac`/`frac_mode` (display scaling; 0 when unset). */
  frac?: number
  fracMode?: 0 | 1
}

/** A spec-domain value (a param's authored default) converted into its device domain. */
export function toDeviceValue(device: DeviceParam, specValue: number): number {
  if (device.onThreshold !== undefined) return specValue >= device.onThreshold ? 1 : 0
  return Math.round(specValue / device.scale)
}

type ParamSpecShape = { name: string; min: number; max: number }

/**
 * Hard selects, keyed by primitive and param. `scale` lands device 1 on 100 for `mux2`/`demux2`,
 * whose own threshold is `>=50`. Deliberately a curated list, not a `step: 1` rule: showing an
 * input number is only honest where raw 0 means "the first one".
 */

/**
 * minilogue xd's own manifest schema has only two types (`'%'` and typeless `''`), and Korg's
 * README says a typeless value is displayed offset by 1 (a `0-9` range shows as `1-10`). So:
 * - Most params get `'%'` over their spec range, which avoids the offset. A negative-range param
 *   (`COARSE`/`FINE`, `util/constant`'s bipolar `VALUE`) gets `'%'` too: typeless ranges must be
 *   positive, and Korg's own `dummy-osc` declares its bipolar param `[-100, 100, "%"]`. Typeless
 *   negative ranges broke on a real xd (2026-09-27): shown as -99, then stuck at 101.
 * - A hard select (`PrimitiveParamSpec.select`) is typeless over `0..N-1`, so the +1 offset shows the input
 *   number 1..N. A typeless value arrives as the raw declared integer, not normalized: Korg's
 *   own xd `waves` declares `["Wave A", 0, 45, ""]` and uses `value % cnt` as the wave index.
 * - A boolean widget (`@logue-codegen/paramTrackGate`'s `BooleanParamWidget`, e.g. comb/svf's
 *   `TRACK`) is `'%'` over `0..1` -- two steps reading 0%/1% for off/on (typeless would read
 *   1/2), scaled back to the widget's own `onValue`. Every widget's `offValue` is 0, so a plain
 *   multiply is exact. xd has no on/off type at all.
 * Neither remap is confirmed on a real xd yet -- the display rules are from the README only.
 */
export function resolveMinilogueXdDeviceParam(
  primitiveId: string,
  spec: ParamSpecShape
): DeviceParam {
  const select = findPrimitiveParamSpec(primitiveId, spec.name)?.select
  if (select) {
    return {
      min: 0,
      max: select.count - 1,
      type: '',
      scale: select.scale,
      onThreshold: select.onThreshold
    }
  }
  const widget = findBooleanWidget(primitiveId, spec.name)
  if (widget) {
    return { min: 0, max: 1, type: '%', scale: widget.onValue, onThreshold: widget.threshold }
  }
  return { min: spec.min, max: spec.max, type: '%', scale: 1 }
}

/**
 * NTS-1 mkII: a hard select is `k_unit_param_type_strings` over `0..N-1`, labelled "In 1".."In N"
 * ("Out 1"/"Out 2" for `demux2`) through the generated `unit_get_param_str_value` -- Korg's own
 * `dummy-delfx` declares `{0, 3, 0, 1, k_unit_param_type_strings, ...}` the same way. A boolean
 * widget is `onoff` over `0..1` instead of `0..100`, so the knob flips once rather than reading ON
 * for 99% of its travel. Everything else keeps its spec range and its `nts1mkiiType`.
 * Not yet confirmed on real NTS-1 mkII hardware.
 */
export function resolveNts1mkiiDeviceParam(primitiveId: string, spec: ParamSpecShape): DeviceParam {
  const select = findPrimitiveParamSpec(primitiveId, spec.name)?.select
  if (select) {
    return {
      min: 0,
      max: select.count - 1,
      type: 'strings',
      scale: select.scale,
      onThreshold: select.onThreshold,
      strings:
        select.names ?? Array.from({ length: select.count }, (_, i) => `${select.label} ${i + 1}`)
    }
  }
  const widget = findBooleanWidget(primitiveId, spec.name)
  if (widget) {
    return { min: 0, max: 1, type: 'onoff', scale: widget.onValue, onThreshold: widget.threshold }
  }
  const strings = findPrimitiveParamSpec(primitiveId, spec.name)?.nts1mkiiStrings
  if (strings) return { min: spec.min, max: spec.max, type: 'strings', scale: 1, strings }
  return {
    min: spec.min,
    max: spec.max,
    type: findParamDeviceType(primitiveId, spec.name)?.nts1mkii ?? 'none',
    scale: 1
  }
}

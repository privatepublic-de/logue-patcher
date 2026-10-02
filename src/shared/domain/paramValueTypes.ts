/**
 * Deliberately a duplicate literal type, not imported from `patch.ts` -- `patch.ts` already
 * imports `ParamValue` from this file, so importing back would be circular. Same "zero-import
 * leaf" precedent as `logue-codegen/primitives.ts`'s own `LoguePlatform`.
 */
export type LogueParamPlatform = 'nts1mkii' | 'minilogue-xd'

/**
 * A param's exposed device slot, kept independently per platform -- a document is one
 * platform-agnostic graph (no document-level "current platform" concept at all), so the same
 * param can (and often will) sit at a different slot -- or be
 * exposed on only one platform at all -- edited for both at once via `ParamMatrixOverlay.tsx`.
 * `undefined` under a given key = not exposed on that platform.
 */
export type LogueParamSlot = Partial<Record<LogueParamPlatform, number>>

/**
 * A fixed hardware control a param can follow instead of owning a menu slot. An oscillator's:
 * the Shape knob and its second (Shift/Alt) function on both devices, and the minilogue xd
 * multi-engine's own filter Cutoff/Resonance knobs (read-only for a unit, xd only). An effect's:
 * its Time and Depth knobs, and `mix` -- the dry/wet control, NTS-1 mkII delay/reverb's MIX
 * (B knob with DEL/REV held) and the xd delay/reverb's Shift+Depth. Which unit kind has which is
 * `logue-codegen/src/unitKinds.ts`' `knobs`.
 */
export type LogueKnob = 'shape' | 'shape-2' | 'cutoff' | 'resonance' | 'time' | 'depth' | 'mix'

export const LOGUE_KNOBS: readonly LogueKnob[] = [
  'shape',
  'shape-2',
  'cutoff',
  'resonance',
  'time',
  'depth',
  'mix'
]

/** Per platform, like `LogueParamSlot`: the knob a param follows on that platform. */
export type LogueKnobBinding = Partial<Record<LogueParamPlatform, LogueKnob>>

/**
 * A parameter value on a patch object instance's `params` array. `value` is kept as a raw
 * string (the on-device-range number as text) rather than parsed to a number here -- callers
 * parse it themselves, so nothing has to worry about reformatting numeric precision it didn't
 * need to touch.
 */
export interface ParamValue {
  name: string
  value: string
  /**
   * Slot(s) this param is exposed at on an EXPORTED logue-sdk unit, one independent value per
   * platform. `undefined` (or a platform key absent from the map) = not exposed to that
   * platform's logue unit. An explicit index per platform, not a boolean, because logue param
   * order IS the physical knob mapping (e.g. NTS-1 mkII hardwires params 0/1 to the A/B knobs) --
   * a knob assignment silently shifting because an unrelated node was added elsewhere in the
   * graph would be a real defect.
   */
  logueParamIndex?: LogueParamSlot
  /**
   * The fixed knob this param follows, per platform: its value is set from the knob's position
   * every block, over the param's whole range. Several params may follow one knob. Exclusive
   * with `logueParamIndex`/`logueFollow` on the same platform.
   */
  logueKnob?: LogueKnobBinding
  /**
   * The menu slot this param follows, per platform, without owning it: the param exposed AT that
   * slot (the lead) defines the device row, and this one is set from the lead's position, mapped
   * into its own range. Exclusive with `logueParamIndex`/`logueKnob` on the same platform.
   */
  logueFollow?: LogueParamSlot
  /**
   * The exported manifest/param-table name for a `freeLabel` param (`logue-codegen`'s
   * `PrimitiveParamSpec.freeLabel`) -- only `logue/sense/param` reads this; every other
   * primitive's param uses its own fixed `PrimitiveParamSpec.name` instead.
   */
  label?: string
  /**
   * Set only on a param INSIDE a subpatch definition (`.loguesub`): promotes it onto the
   * definition's own outer interface under `outerName`. The per-instance value, device slots and
   * device menu label then live on each placed instance's own `ParamValue` keyed by `outerName`
   * (see `logue-codegen/src/subpatches.ts`). Stored explicitly, not derived from node+param name,
   * so renaming the inner node afterwards doesn't break every instance that already uses it.
   */
  subpatchExpose?: { outerName: string }
}

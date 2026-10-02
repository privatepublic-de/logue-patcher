import {
  findAliasedFieldValue,
  findLoguePrimitive,
  type LoguePlatform,
  type PrimitiveParamSpec
} from './primitives'
import {
  resolveMinilogueXdDeviceParam,
  resolveNts1mkiiDeviceParam,
  type DeviceParam
} from './paramDeviceType'
import type { ResolvedActiveInstance, ResolvedPrimitiveInstance } from './oscInstances'
import { CHOICE_NAME_MAX_LEN } from './paramPresentation'
import { floatLit } from './primitives/shared'
import type { LogueKnob, ParamValue } from '../../src/shared/domain/paramValueTypes'

/**
 * Shared between every platform's oscillator generator -- binding a node's own
 * `ParamValue.logueParamIndex` to its primitive's matching `PrimitiveParamSpec` has nothing
 * platform-specific about it EXCEPT the max param count (10 for an NTS-1 mkII osc, 6 for a
 * minilogue xd osc -- both real, confirmed platform limits) and whether the platform enforces
 * a fixed on-device name buffer (NTS-1 mkII's `UNIT_PARAM_NAME_LEN`; minilogue xd's
 * `manifest.json` params are plain JSON strings with no such fixed-size C struct, so no
 * equivalent check applies there -- passing `maxNameLength: undefined` skips it rather than
 * inventing a limit that isn't real).
 */

export class InvalidLogueParamError extends Error {}

/**
 * Resolves the raw numeric value a placed instance's own `ParamValue` authors for one of its
 * primitive's params -- previously every instance of a primitive
 * silently seeded the SAME hardcoded `spec.default`, with no way for two placed filters (say) to
 * have different baked-in cutoffs. Falls back to `spec.default` only when the node has no
 * matching `ParamValue` at all (the common case: a freshly placed primitive, or a param never
 * touched in the Inspector) -- once a `ParamValue` exists, ITS `value` always wins, matching
 * `resolveExposedParams`'s own "an existing ParamValue's fields always take effect" posture.
 * Validated here (not left to fail silently as a garbage C++ literal or a runtime clamp) because
 * this bakes a compile-time literal into generated code -- a bad value should be a clear export-
 * time error, not a mysterious build failure or a silently wrong sound.
 */
export function resolveParamDefaultValue(
  instance: ResolvedPrimitiveInstance,
  spec: PrimitiveParamSpec
): number {
  const primitive = findLoguePrimitive(instance.id)!
  const paramValue = findAliasedFieldValue(primitive.renamedParams, spec.name, instance.node.params)
  if (!paramValue) return spec.default

  const parsed = Number(paramValue.value)
  if (!Number.isFinite(parsed)) {
    throw new InvalidLogueParamError(
      `Param "${spec.name}" on node "${instance.node.name ?? instance.suffix}" has a non-numeric value "${paramValue.value}".`
    )
  }
  if (parsed < spec.min || parsed > spec.max) {
    throw new InvalidLogueParamError(
      `Param "${spec.name}" on node "${instance.node.name ?? instance.suffix}" has value ${parsed}, outside its declared range [${spec.min}, ${spec.max}].`
    )
  }
  return parsed
}

export interface ExposedParamBinding {
  index: number
  instanceSuffix: string
  paramName: string
  min: number
  max: number
  default: number
  setStatement: string
  /** How this param appears on the resolved platform's device -- see `DeviceParam`
   *  (`@logue-codegen/paramDeviceType`). `setStatement` already applies its `scale`; `min`/
   *  `max`/`default` above stay in the param's own spec domain. */
  device: DeviceParam
}

/**
 * Binds each placed instance's own `ParamValue.logueParamIndex[platform]` (when set) to its
 * primitive's matching `PrimitiveParamSpec` -- the phase-0 design resolution's `logueParamIndex`
 * decision (question 1): an explicit slot, not a boolean, because logue param order IS the
 * physical knob mapping. Exposure is independent per platform (`ParamValue.logueParamIndex` is a
 * per-platform map, not one shared slot) -- `platform` says
 * which platform's own slot this call resolves; a param exposed only on the OTHER platform reads
 * as not-exposed here, exactly as if it were never assigned at all. Gaps are fine (unclaimed
 * slots below the highest exposed index get each platform's own "unused" sentinel, per that same
 * design resolution); a DUPLICATE index is rejected with a named error identifying both
 * conflicting params.
 */
export function resolveExposedParams(
  instances: Array<
    ResolvedPrimitiveInstance & Partial<Pick<ResolvedActiveInstance, 'inletSources'>>
  >,
  platform: LoguePlatform,
  maxParamCount: number,
  maxNameLength?: number
): Map<number, ExposedParamBinding> {
  const byIndex = new Map<number, ExposedParamBinding>()
  const nameBySuffix = new Map(instances.map((i) => [i.suffix, i.node.name ?? i.suffix]))
  for (const inst of instances) {
    const primitive = findLoguePrimitive(inst.id)!
    for (const spec of primitive.params ?? []) {
      const paramValue = findAliasedFieldValue(primitive.renamedParams, spec.name, inst.node.params)
      if (!paramValue) continue
      const index = paramValue.logueParamIndex?.[platform]
      if (index === undefined) continue
      rejectStructural(inst, spec, `exposed at Param slot ${index}`)
      if (maxParamCount === 0) {
        throw new InvalidLogueParamError(
          `${spec.name} on node "${inst.node.name ?? inst.suffix}" is a menu param, but this kind of unit has no menu params on this platform -- put it on one of the panel knobs instead (Param Matrix).`
        )
      }

      // logue/sense/param's one spec has no inherent semantic
      // name (unlike CUTOFF/GAIN/etc), so its EXPORTED name comes from what the user typed,
      // not the spec's own internal binding key ("VALUE"). Resolved up front so every check
      // below (name-length, slot-conflict message) already sees the real exported name.
      // A non-freeLabel param can still carry a `label`: the flattener stamps a promoted
      // subpatch param's outer name (or the instance's own edited label) onto its leaf param, so
      // the device menu shows that rather than the inner primitive's fixed spec name.
      const displayName = spec.freeLabel
        ? (paramValue.label?.trim() ?? '')
        : paramValue.label?.trim() || spec.name
      if (spec.freeLabel && displayName.length === 0) {
        throw new InvalidLogueParamError(
          `Param on node "${inst.node.name ?? inst.suffix}" is exposed at logueParamIndex ${index} but has no label -- a freely-labeled param needs a non-empty label before it can reach the manifest.`
        )
      }

      if (maxNameLength !== undefined && displayName.length > maxNameLength) {
        throw new InvalidLogueParamError(
          `Param "${displayName}" on node "${inst.node.name ?? inst.suffix}" is ${displayName.length} characters, exceeding the real on-device limit of ${maxNameLength}.`
        )
      }
      if (!Number.isInteger(index) || index < 0 || index >= maxParamCount) {
        throw new InvalidLogueParamError(
          `Param "${displayName}" on node "${inst.node.name ?? inst.suffix}" has logueParamIndex ${index}, outside the valid range [0, ${maxParamCount - 1}] for this platform.`
        )
      }
      const existing = byIndex.get(index)
      if (existing) {
        throw new InvalidLogueParamError(
          `Param slot ${index} is claimed by both "${existing.paramName}" (on "${existing.instanceSuffix}") and "${displayName}" (on "${inst.suffix}") -- each exposed param needs a unique logueParamIndex.`
        )
      }

      // Keyed by the param's own internal binding name (`spec.name`), not `displayName` -- a
      // freeLabel param's user-typed label has no bearing on how the device shows it.
      const device =
        platform === 'minilogue-xd'
          ? resolveMinilogueXdDeviceParam(inst.id, spec)
          : withWiredChoiceNames(
              resolveNts1mkiiDeviceParam(inst.id, spec),
              spec,
              inst,
              nameBySuffix
            )
      byIndex.set(index, {
        index,
        instanceSuffix: inst.suffix,
        paramName: displayName,
        min: spec.min,
        max: spec.max,
        default: resolveParamDefaultValue(inst, spec),
        setStatement: spec.setStatement(
          inst.suffix,
          device.scale === 1 ? 'value' : `(value * ${device.scale})`
        ),
        device
      })
    }
  }
  return byIndex
}

/**
 * A selector's choices named by what is wired into them (`SelectParam.choiceInlets`: a mux's
 * i1..iN): the source node's name, cut to what the NTS-1 mkII shows; an unwired choice keeps its
 * "In N". So a patch labels its own selector by naming the nodes feeding it -- renaming one of
 * them renames the choice on the device. `_` shows as a space: node names can't hold one.
 */
function withWiredChoiceNames(
  device: DeviceParam,
  spec: PrimitiveParamSpec,
  inst: Partial<Pick<ResolvedActiveInstance, 'inletSources'>>,
  nameBySuffix: ReadonlyMap<string, string>
): DeviceParam {
  const inlets = spec.select?.choiceInlets
  if (!inlets || !device.strings || !inst.inletSources) return device
  const strings = device.strings.map((fallback, k) => {
    const source = inst.inletSources![inlets[k]]
    return source
      ? (nameBySuffix.get(source.suffix) ?? source.suffix)
          .replace(/_/g, ' ')
          .slice(0, CHOICE_NAME_MAX_LEN)
      : fallback
  })
  return { ...device, strings }
}

/**
 * Guards against a real, reachable user mistake: place two oscillators, expose the same-named
 * param on both, wire only one to `logue/io/audio-out` (or into any chain that reaches it).
 * Since `resolveExposedParams` is scoped to just the active (output-reachable) instances -- an
 * inactive instance's own state/renderExpr is pruned from the generated code entirely, see
 * `oscBody.ts` -- exposing a param on an inactive instance would otherwise silently vanish from
 * the manifest with no error at all: a physical knob/menu the user set up would map to nothing,
 * the exact "I turned the control and nothing happened" failure class that cost a real
 * multi-fix debugging loop earlier in this project's minilogue-xd pulse-width work -- except this
 * time it would be caused by a wiring mistake, not a codegen bug, so it should throw up front
 * rather than repeat that experience.
 */
export function rejectExposedParamsOnInactiveInstances(
  instances: ResolvedPrimitiveInstance[],
  activeInstances: ResolvedPrimitiveInstance[],
  platform: LoguePlatform
): void {
  const activeNames = new Set(
    activeInstances
      .map((inst) => inst.node.name)
      .filter((name): name is string => name !== undefined)
  )
  for (const inst of instances) {
    if (inst.node.name !== undefined && activeNames.has(inst.node.name)) continue
    const primitive = findLoguePrimitive(inst.id)!
    for (const spec of primitive.params ?? []) {
      const paramValue = findAliasedFieldValue(primitive.renamedParams, spec.name, inst.node.params)
      const control =
        paramValue?.logueParamIndex?.[platform] !== undefined
          ? 'a logueParamIndex'
          : paramValue?.logueKnob?.[platform] !== undefined
            ? `a ${paramValue.logueKnob[platform]} knob binding`
            : paramValue?.logueFollow?.[platform] !== undefined
              ? 'a Param slot to follow'
              : undefined
      if (control) {
        throw new InvalidLogueParamError(
          `Param "${spec.name}" on node "${inst.node.name ?? inst.suffix}" has ${control} for this platform, but that node isn't wired to logue/io/audio-out -- an exposed param on an unwired node would map a physical control to nothing. Wire the node to the output, or remove the exposure.`
        )
      }
    }
  }
}

export { floatLit }

/**
 * One statement setting `spec` from a control position `p` (a C expression, 0..1) over the
 * param's whole range, in its spec domain: a select or checkbox is split into equal zones of the
 * travel (so every choice gets the same share of the knob), a stepped param is rounded to its
 * step. All positive, so `(int32_t)(x + 0.5f)` rounds without libm.
 */
export function positionToParamStatement(
  suffix: string,
  spec: PrimitiveParamSpec,
  p: string
): string {
  if (spec.select) {
    const { count, scale } = spec.select
    return `{ int32_t k = (int32_t)(${p} * ${floatLit(count)}); if (k > ${count - 1}) k = ${count - 1}; ${spec.setStatement(suffix, `((float)k * ${floatLit(scale)})`)} }`
  }
  if (spec.booleanWidget) {
    const { onValue, offValue } = spec.booleanWidget
    return spec.setStatement(
      suffix,
      `(${p} >= 0.5f ? ${floatLit(onValue)} : ${floatLit(offValue)})`
    )
  }
  const range = spec.max - spec.min
  if (spec.step !== undefined && spec.step > 0) {
    const steps = Math.round(range / spec.step)
    return spec.setStatement(
      suffix,
      `(${floatLit(spec.min)} + (float)(int32_t)(${p} * ${floatLit(steps)} + 0.5f) * ${floatLit(spec.step)})`
    )
  }
  return spec.setStatement(suffix, `(${floatLit(spec.min)} + ${p} * ${floatLit(range)})`)
}

/** The inverse of `positionToParamStatement` for a stored value: the position (0..1) that
 *  yields it, the middle of its zone for a select or checkbox. */
export function paramValueToPosition(spec: PrimitiveParamSpec, value: number): number {
  if (spec.select) {
    const { count, scale, onThreshold } = spec.select
    const index =
      onThreshold !== undefined ? (value >= onThreshold ? 1 : 0) : Math.round(value / scale)
    return (Math.min(Math.max(index, 0), count - 1) + 0.5) / count
  }
  if (spec.booleanWidget) return value >= spec.booleanWidget.threshold ? 0.75 : 0.25
  const range = spec.max - spec.min
  return range > 0 ? (value - spec.min) / range : 0
}

export type { LogueKnob }

/** The Osc-class member each generator keeps each knob's current 0..1 position in (updated
 *  before every block), so a binding reads the same value `logue/sense/*` does. */
export const KNOB_POSITION_MEMBER: Record<LogueKnob, string> = {
  shape: 'shape01_',
  'shape-2': 'shape2_01_',
  cutoff: 'cutoff01_',
  resonance: 'resonance01_',
  time: 'time01_',
  depth: 'depth01_',
  mix: 'mix01_'
}

export interface KnobBinding {
  knob: LogueKnob
  instanceSuffix: string
  paramName: string
  /** Sets the param from the knob's position member, run at the start of every block. */
  statement: string
  /** Where the knob would sit to give this param its authored value. */
  initPosition: number
}

interface ParamBindingRef {
  inst: ResolvedPrimitiveInstance
  spec: PrimitiveParamSpec
  paramValue: ParamValue
}

function eachBoundParam(instances: ResolvedPrimitiveInstance[]): ParamBindingRef[] {
  const refs: ParamBindingRef[] = []
  for (const inst of instances) {
    const primitive = findLoguePrimitive(inst.id)!
    for (const spec of primitive.params ?? []) {
      const paramValue = findAliasedFieldValue(primitive.renamedParams, spec.name, inst.node.params)
      if (paramValue) refs.push({ inst, spec, paramValue })
    }
  }
  return refs
}

function describeParam(ref: ParamBindingRef): string {
  return `Param "${ref.spec.name}" on node "${ref.inst.node.name ?? ref.inst.suffix}"`
}

function rejectStructural(
  inst: ResolvedPrimitiveInstance,
  spec: PrimitiveParamSpec,
  control: string
): void {
  if (!spec.structural) return
  throw new InvalidLogueParamError(
    `${describeParam({ inst, spec, paramValue: { name: spec.name, value: '' } })} is ${control}, but it's fixed when the unit is built (it sets its size) -- remove that device control.`
  )
}

/**
 * Every active param following a fixed knob on `platform`, in graph order. Each one is rejected
 * when it also owns or follows a menu slot on the same platform (two writers of one member), or
 * names a knob the unit doesn't have (`knobs`, the unit kind's).
 */
export function resolveKnobBindings(
  instances: ResolvedPrimitiveInstance[],
  platform: LoguePlatform,
  knobs: readonly LogueKnob[]
): KnobBinding[] {
  const bindings: KnobBinding[] = []
  for (const ref of eachBoundParam(instances)) {
    const { inst, spec, paramValue } = ref
    const knob = paramValue.logueKnob?.[platform]
    const slot = paramValue.logueParamIndex?.[platform]
    const follow = paramValue.logueFollow?.[platform]
    if (knob !== undefined && (slot !== undefined || follow !== undefined)) {
      throw new InvalidLogueParamError(
        `${describeParam(ref)} follows the ${knob} knob and also ${slot !== undefined ? `owns Param slot ${slot}` : `follows Param slot ${follow}`} on this platform -- a param can have only one device control.`
      )
    }
    if (slot !== undefined && follow !== undefined) {
      throw new InvalidLogueParamError(
        `${describeParam(ref)} owns Param slot ${slot} and also follows Param slot ${follow} on this platform -- a param can have only one device control.`
      )
    }
    if (knob === undefined) continue
    rejectStructural(inst, spec, `bound to the ${knob} knob`)
    if (!knobs.includes(knob)) {
      throw new InvalidLogueParamError(
        `${describeParam(ref)} follows the ${knob} knob, which this platform doesn't give this kind of unit.`
      )
    }
    bindings.push({
      knob,
      instanceSuffix: inst.suffix,
      paramName: spec.name,
      statement: positionToParamStatement(inst.suffix, spec, KNOB_POSITION_MEMBER[knob]),
      initPosition: paramValueToPosition(spec, resolveParamDefaultValue(inst, spec))
    })
  }
  return bindings
}

/**
 * Appends every param following a menu slot to that slot's `setStatement`: the lead's device
 * value is turned into a position over the lead's own device range, and each follower is set
 * from that position over its own range. A follower of a slot nobody owns is rejected -- the
 * device row would have no definition. Run after the platform's reserved slots are known, so
 * the error for NTS-1 mkII's slots 0/1 can point at the knob binding instead.
 */
export function attachSlotFollowers(
  exposedParams: Map<number, ExposedParamBinding>,
  instances: ResolvedPrimitiveInstance[],
  platform: LoguePlatform,
  reservedKnobSlots: ReadonlyMap<number, LogueKnob> = new Map()
): void {
  const followers = new Map<number, string[]>()
  for (const ref of eachBoundParam(instances)) {
    const index = ref.paramValue.logueFollow?.[platform]
    if (index === undefined) continue
    rejectStructural(ref.inst, ref.spec, `following Param slot ${index}`)
    const knob = reservedKnobSlots.get(index)
    if (knob !== undefined) {
      throw new InvalidLogueParamError(
        `${describeParam(ref)} follows Param slot ${index}, which is this platform's fixed ${knob} knob -- bind it to that knob instead.`
      )
    }
    const lead = exposedParams.get(index)
    if (!lead) {
      throw new InvalidLogueParamError(
        `${describeParam(ref)} follows Param slot ${index}, but no param is exposed at that slot on this platform to lead it.`
      )
    }
    const list = followers.get(index) ?? []
    list.push(positionToParamStatement(ref.inst.suffix, ref.spec, 'p'))
    followers.set(index, list)
  }
  for (const [index, statements] of followers) {
    const lead = exposedParams.get(index)!
    const { min, max } = lead.device
    const offset = min === 0 ? 'value' : min < 0 ? `(value + ${-min})` : `(value - ${min})`
    const position = max > min ? `(float)${offset} * (1.f / ${floatLit(max - min)})` : '0.f'
    exposedParams.set(index, {
      ...lead,
      setStatement: `${lead.setStatement} { const float p = ${position}; ${statements.join(' ')} }`
    })
  }
}

/**
 * The members holding each knob's position that `init()` starts at a bound param's authored
 * value, in emission order. Only knobs whose position the unit stores are here: an oscillator's
 * Shape pair and an effect's Time/Depth/Mix (all set from `setParameter`); the xd's
 * cutoff/resonance are read fresh every block. Shape's static position and its Mod-LFO-combined
 * reading both start there.
 */
export const KNOB_INIT_MEMBERS: Partial<Record<LogueKnob, readonly string[]>> = {
  shape: ['shapeParam01_', 'shape01_'],
  'shape-2': ['shape2_01_'],
  time: ['time01_'],
  depth: ['depth01_'],
  mix: ['mix01_']
}

/** For each knob with a stored position (`KNOB_INIT_MEMBERS`) and a bound param: the first
 *  binding's starting position. */
export function knobInitPositions(bindings: KnobBinding[]): Partial<Record<LogueKnob, number>> {
  const positions: Partial<Record<LogueKnob, number>> = {}
  for (const b of bindings) {
    if (KNOB_INIT_MEMBERS[b.knob] !== undefined && positions[b.knob] === undefined) {
      positions[b.knob] = b.initPosition
    }
  }
  return positions
}

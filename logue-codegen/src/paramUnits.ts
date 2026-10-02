import { findParamTrackGate } from './paramTrackGate'
import { findPrimitiveParamSpec, presentationKeyOf, type PrimitiveParamSpec } from './primitives'
import type { ParamUnit, ParamUnitDependency } from './paramPresentation'

export type { ParamUnit } from './paramPresentation'

export function findParamUnit(primitiveId: string, paramName: string): ParamUnit | undefined {
  return findPrimitiveParamSpec(primitiveId, paramName)?.unit
}

/**
 * The unit a param's dial/field shows, following a promoted subpatch param through to the leaf
 * primitive param it edits. A promoted param whose leaf unit is TRACK-gated shows no unit: the
 * gate lives on the inner node, whose current value the instance can't see, so a unit there
 * could be the wrong one (e.g. ms on a comb CUTOFF that's actually pitch-tracking).
 */
export function findDisplayUnit(
  primitiveId: string,
  spec: Pick<PrimitiveParamSpec, 'name' | 'promotedFrom'>
): ParamUnit | undefined {
  const leaf = presentationKeyOf(primitiveId, spec)
  if (spec.promotedFrom && findParamTrackGate(leaf.primitiveId, leaf.paramName)) return undefined
  // Same for a unit that follows another param: the instance can't see the inner node's value.
  if (spec.promotedFrom && findPrimitiveParamSpec(leaf.primitiveId, leaf.paramName)?.unitDependsOn)
    return undefined
  return findParamUnit(leaf.primitiveId, leaf.paramName)
}

/** What a param's unit follows, with that param's default -- undefined for a promoted param
 *  (see `findDisplayUnit`) and for the many whose unit stands alone. */
export function findUnitDependency(
  primitiveId: string,
  spec: Pick<PrimitiveParamSpec, 'name' | 'promotedFrom'>
): (ParamUnitDependency & { default: number }) | undefined {
  if (spec.promotedFrom) return undefined
  const dependency = findPrimitiveParamSpec(primitiveId, spec.name)?.unitDependsOn
  const other = dependency && findPrimitiveParamSpec(primitiveId, dependency.param)
  return dependency && other ? { ...dependency, default: other.default } : undefined
}

/** The unit for the other param's current raw value (a `ParamValue.value`, maybe absent). */
export function dependentUnit(
  dependency: ParamUnitDependency & { default: number },
  raw: string | number | undefined
): ParamUnit {
  const n = raw === undefined ? NaN : Number(raw)
  return dependency.unitFor(Number.isFinite(n) ? n : dependency.default)
}

import type { BooleanParamWidget, ParamTrackGate } from './paramPresentation'
import { findPrimitiveInletSpec, findPrimitiveParamSpec } from './primitives'

export {
  TRACK_ON_THRESHOLD,
  isTrackGated,
  type BooleanParamWidget,
  type ParamTrackGate,
  type ParamTrackGateDirection
} from './paramPresentation'

export function findBooleanWidget(
  primitiveId: string,
  paramName: string
): BooleanParamWidget | undefined {
  return findPrimitiveParamSpec(primitiveId, paramName)?.booleanWidget
}

export function findParamTrackGate(
  primitiveId: string,
  paramName: string
): ParamTrackGate | undefined {
  return findPrimitiveParamSpec(primitiveId, paramName)?.trackGate
}

/**
 * The inlet-side counterpart of `findParamTrackGate`: comb's `tune`/svf's `cutoff` only matter with
 * `TRACK` off and `pitch` only with it on, so the ports get the same badge their dials do (a
 * user-reported "aren't these two inlets redundant?"). Looked up by `PrimitiveInletSpec.name`,
 * a separate namespace from param names even where they collide (`cutoff` vs `CUTOFF`).
 */
export function findInletTrackGate(
  primitiveId: string,
  inletName: string
): ParamTrackGate | undefined {
  return findPrimitiveInletSpec(primitiveId, inletName)?.trackGate
}

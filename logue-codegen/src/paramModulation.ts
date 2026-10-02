import type { ParamModulation } from './paramPresentation'
import { findPrimitiveParamSpec, type LoguePrimitive } from './primitives'

export type { ParamModulation, ParamModulationShape } from './paramPresentation'

export function findParamModulation(
  primitiveId: string,
  paramName: string
): ParamModulation | undefined {
  return findPrimitiveParamSpec(primitiveId, paramName)?.modulatedBy
}

/** The dial a wired inlet acts on, and how -- the inlet-side view of `modulatedBy`. Undefined for
 *  an inlet that drives no dial (an audio input, an operand, a trigger). */
export function findInletModulation(
  primitive: Pick<LoguePrimitive, 'params'>,
  inletName: string
): { paramName: string; modulation: ParamModulation } | undefined {
  const spec = primitive.params?.find((p) => p.modulatedBy?.inlet === inletName)
  return spec?.modulatedBy && { paramName: spec.name, modulation: spec.modulatedBy }
}

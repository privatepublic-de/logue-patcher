import type { LoguePlatform, PatchDocument } from '../../src/shared/domain/patch'
import {
  assertPrimitivesSupportModule,
  assertPrimitivesSupportPlatform,
  resolveAudioGraph,
  PLATFORM_DISPLAY_NAME,
  UnsupportedLogueNodeError,
  type ResolvedAudioGraph
} from './oscInstances'
import {
  attachSlotFollowers,
  rejectExposedParamsOnInactiveInstances,
  resolveExposedParams,
  resolveKnobBindings,
  type ExposedParamBinding,
  type KnobBinding,
  type LogueKnob
} from './oscParams'
import { flattenSubpatches, type SubpatchDefinitions } from './subpatches'
import { BUS_LOOP_HINT, resolveBuses } from './buses'
import { findLoguePrimitive } from './primitives'
import { findUnitKind, MODULE_LABEL } from './unitKinds'

/**
 * A document as codegen sees it: subpatches flattened, then buses chained (`buses.ts`). Every
 * consumer goes through this, so the gauges and the build agree on what a unit contains.
 */
export function flattenUnit(
  doc: PatchDocument,
  subpatches: SubpatchDefinitions,
  maxLabelLength?: number
): PatchDocument {
  return resolveBuses(flattenSubpatches(doc, subpatches, maxLabelLength))
}

/**
 * Subpatches flattened, the graph resolved, and every active primitive checked against
 * `platform` -- the common front of both generators and both estimators. Throws the usual
 * `UnsupportedLogueNodeError`s, also for a module `unitKinds.ts` has no entry for on `platform`
 * (so an effect document reads as "can't build yet" instead of building as an oscillator).
 * `maxLabelLength` only shortens defaulted promoted-param labels.
 */
export function resolvePlatformGraph(
  doc: PatchDocument,
  subpatches: SubpatchDefinitions,
  platform: LoguePlatform,
  maxLabelLength?: number
): ResolvedAudioGraph {
  const module = doc.settings.logueTarget?.module ?? 'osc'
  if (!findUnitKind(platform, module)) {
    throw new UnsupportedLogueNodeError(
      `${MODULE_LABEL[module]} units can't be built for the ${PLATFORM_DISPLAY_NAME[platform]} yet.`
    )
  }
  const flat = flattenUnit(doc, subpatches, maxLabelLength)
  let graph: ResolvedAudioGraph
  try {
    graph = resolveAudioGraph(flat)
  } catch (e) {
    if (
      e instanceof UnsupportedLogueNodeError &&
      e.message.startsWith('Graph has a feedback loop') &&
      flat.nodes.some((n) => n.kind === 'obj' && findLoguePrimitive(n.type)?.internal)
    ) {
      throw new UnsupportedLogueNodeError(e.message + BUS_LOOP_HINT)
    }
    throw e
  }
  assertPrimitivesSupportPlatform(graph.activeInstances, platform)
  assertPrimitivesSupportModule(graph.activeInstances, module)
  return graph
}

/** `resolvePlatformGraph` plus the device params, validated for `platform`: what a generator
 *  needs. Slot followers are already folded into their lead's `setStatement`.
 *  `reservedKnobSlots`: menu slots that are really a fixed knob (NTS-1 mkII's 0/1). */
export function resolveUnit(
  doc: PatchDocument,
  subpatches: SubpatchDefinitions,
  platform: LoguePlatform,
  limits: {
    maxParamCount: number
    maxLabelLength?: number
    reservedKnobSlots?: ReadonlyMap<number, LogueKnob>
  }
): ResolvedAudioGraph & {
  exposedParams: Map<number, ExposedParamBinding>
  knobBindings: KnobBinding[]
} {
  const graph = resolvePlatformGraph(doc, subpatches, platform, limits.maxLabelLength)
  rejectExposedParamsOnInactiveInstances(graph.instances, graph.activeInstances, platform)
  const exposedParams = resolveExposedParams(
    graph.activeInstances,
    platform,
    limits.maxParamCount,
    limits.maxLabelLength
  )
  const module = doc.settings.logueTarget?.module ?? 'osc'
  const knobBindings = resolveKnobBindings(
    graph.activeInstances,
    platform,
    findUnitKind(platform, module)!.knobs
  )
  attachSlotFollowers(exposedParams, graph.activeInstances, platform, limits.reservedKnobSlots)
  return { ...graph, exposedParams, knobBindings }
}

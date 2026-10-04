import type {
  FieldAlias,
  HelperBlock,
  InstanceNodeData,
  LoguePrimitive,
  PrimitiveInletSpec,
  PrimitiveParamSpec
} from './types'
import {
  adEnvelopePrimitive,
  adsrEnvelopePrimitive,
  ahdEnvelopePrimitive,
  followerPrimitive,
  multistageEnvelopePrimitive,
  oneKnobAdsrPrimitive
} from './env'
import {
  allpassPrimitive,
  combFilterPrimitive,
  formantFilterPrimitive,
  highpassCheapFilterPrimitive,
  hilbertPrimitive,
  lowpassCheapFilterPrimitive,
  pluckedStringPrimitive,
  svfFilterPrimitive
} from './filter'
import { vcaPrimitive } from './gain'
import {
  fastSquareLfoPrimitive,
  lfoRampDownPrimitive,
  lfoRampUpPrimitive,
  lfoSinePrimitive,
  lfoSquarePrimitive,
  lfoTrianglePrimitive,
  randomStepsPrimitive
} from './lfo'
import {
  andPrimitive,
  chancePrimitive,
  edgePrimitive,
  equalPrimitive,
  greaterThanPrimitive,
  lessThanPrimitive,
  orPrimitive,
  roundRobinPrimitive,
  schmittPrimitive,
  xorPrimitive
} from './logic'
import {
  absPrimitive,
  addPrimitive,
  clampPrimitive,
  curvePrimitive,
  negatePrimitive,
  oneMinusPrimitive,
  maxPrimitive,
  minPrimitive,
  multiplyPrimitive,
  scalePrimitive,
  subtractPrimitive
} from './math'
import {
  crossfaderPrimitive,
  mixer2Primitive,
  panPrimitive,
  stereoCrossfaderPrimitive,
  stereoMixer2Primitive,
  widthPrimitive
} from './mix'
import { demux2Primitive, mux2Primitive, mux4Primitive } from './mux'
import {
  additiveOscPrimitive,
  bassSupportPrimitive,
  granularOscPrimitive,
  lfsrPrimitive,
  noisePrimitive,
  phaseDistOscPrimitive,
  pluckExciterPrimitive,
  pulseOscPrimitive,
  samplePrimitive,
  wavetablePrimitive,
  sawOscPrimitive,
  sineOscPrimitive,
  squareOscPrimitive,
  syncOscPrimitive,
  triangleOscPrimitive
} from './osc'
import {
  senseControlPrimitive,
  senseCutoffPrimitive,
  senseGatePrimitive,
  senseVelocityPrimitive,
  senseParamPrimitive,
  sensePitchPrimitive,
  senseResonancePrimitive,
  senseShape2Primitive,
  senseShapePrimitive,
  senseTempoPrimitive
} from './sense'
import { saturatorPrimitive, wavefolderPrimitive } from './shape'
import {
  bipolarToUnipolarPrimitive,
  bufferPrimitive,
  bufferTapPrimitive,
  constantPrimitive,
  grainPrimitive,
  delayPrimitive,
  freqShiftPrimitive,
  glidePrimitive,
  slewPrimitive,
  longDelayPrimitive,
  quantizePrimitive,
  reverseTapPrimitive,
  sampleDelayPrimitive,
  sampleHoldPrimitive,
  unipolarToBipolarPrimitive
} from './util'

/**
 * Given the helper blocks a graph's placed primitives directly reference, returns the full
 * deduped set including every transitive `dependsOn` -- so `Osc::process()`'s generated saw/
 * square primitives, which call the shared `polyblep()`, always get it emitted even though
 * neither declares it as ITS OWN `helpers` entry.
 */
/** Every helper the given active instances call directly -- each primitive's static `helpers`
 *  plus its node-aware `instanceHelpers`. The one place both codegen (`oscBody.ts`) and the RAM
 *  estimate (`estimateOscStateCost.ts`) read helpers from, so they can't disagree. */
export function directHelpersOf(
  instances: { id: string; node: InstanceNodeData }[]
): HelperBlock[] {
  return instances.flatMap((inst) => {
    const primitive = findLoguePrimitive(inst.id)!
    const helpers = primitive.helpers
    const own = helpers === undefined ? [] : Array.isArray(helpers) ? helpers : [helpers]
    return [...own, ...(primitive.instanceHelpers?.(inst.node) ?? [])]
  })
}

const PRIMITIVES: LoguePrimitive[] = [
  sineOscPrimitive,
  sawOscPrimitive,
  squareOscPrimitive,
  pulseOscPrimitive,
  triangleOscPrimitive,
  additiveOscPrimitive,
  granularOscPrimitive,
  samplePrimitive,
  wavetablePrimitive,
  mixer2Primitive,
  multiplyPrimitive,
  crossfaderPrimitive,
  stereoMixer2Primitive,
  stereoCrossfaderPrimitive,
  lowpassCheapFilterPrimitive,
  highpassCheapFilterPrimitive,
  vcaPrimitive,
  adEnvelopePrimitive,
  ahdEnvelopePrimitive,
  adsrEnvelopePrimitive,
  oneKnobAdsrPrimitive,
  multistageEnvelopePrimitive,
  lfoSinePrimitive,
  lfoTrianglePrimitive,
  lfoSquarePrimitive,
  lfoRampUpPrimitive,
  lfoRampDownPrimitive,
  fastSquareLfoPrimitive,
  randomStepsPrimitive,
  noisePrimitive,
  lfsrPrimitive,
  wavefolderPrimitive,
  saturatorPrimitive,
  combFilterPrimitive,
  pluckedStringPrimitive,
  pluckExciterPrimitive,
  syncOscPrimitive,
  phaseDistOscPrimitive,
  bassSupportPrimitive,
  svfFilterPrimitive,
  formantFilterPrimitive,
  sensePitchPrimitive,
  senseControlPrimitive,
  senseShapePrimitive,
  senseShape2Primitive,
  senseCutoffPrimitive,
  senseResonancePrimitive,
  senseParamPrimitive,
  senseGatePrimitive,
  senseVelocityPrimitive,
  constantPrimitive,
  unipolarToBipolarPrimitive,
  bipolarToUnipolarPrimitive,
  negatePrimitive,
  oneMinusPrimitive,
  curvePrimitive,
  addPrimitive,
  subtractPrimitive,
  scalePrimitive,
  minPrimitive,
  maxPrimitive,
  clampPrimitive,
  absPrimitive,
  greaterThanPrimitive,
  lessThanPrimitive,
  equalPrimitive,
  andPrimitive,
  orPrimitive,
  xorPrimitive,
  mux2Primitive,
  mux4Primitive,
  demux2Primitive,
  schmittPrimitive,
  edgePrimitive,
  sampleHoldPrimitive,
  glidePrimitive,
  slewPrimitive,
  sampleDelayPrimitive,
  delayPrimitive,
  longDelayPrimitive,
  quantizePrimitive,
  allpassPrimitive,
  followerPrimitive,
  senseTempoPrimitive,
  hilbertPrimitive,
  freqShiftPrimitive,
  bufferPrimitive,
  bufferTapPrimitive,
  grainPrimitive,
  reverseTapPrimitive,
  panPrimitive,
  widthPrimitive,
  chancePrimitive,
  roundRobinPrimitive
]

const REGISTRY: Record<string, LoguePrimitive> = Object.fromEntries(
  PRIMITIVES.map((p) => [p.id, p])
)

/**
 * Old primitive id -> current id for pure id renames and merges (behavior for given param/inlet
 * values unchanged). `findLoguePrimitive` consults it so a file saved under an old id still
 * resolves, instead of silently falling back to wiring-inferred ports. Since only the id moved,
 * resolving through it is always safe; a change to what a primitive's own fields mean is recorded
 * as `FieldAlias` entries (`renamedParams`/`renamedInlets`) on the primitive instead. The two
 * layers compose: a file old enough to say `logue/delay/comb` also carries comb's old
 * `FEEDBACK`/`DELAY` names, and both resolve against the current id.
 *
 * The name "sample-hold" moved: old `logue/lfo/sample-hold` is now `logue/lfo/random-steps`, and
 * the triggered `logue/util/sample-hold` was `logue/util/trig-hold`. Old files stay unambiguous
 * because the categories differ. History: docs/HISTORY.md.
 */
const RENAMED_PRIMITIVE_IDS: Record<string, string> = {
  'logue/sense/shift-shape': 'logue/sense/shape-2',
  'logue/sense/shape-alt': 'logue/sense/shape-2',
  'logue/noise/white': 'logue/osc/noise',
  'logue/delay/comb': 'logue/filter/comb',
  'logue/filter/lowpass': 'logue/filter/lowpass-cheap',
  'logue/util/invert': 'logue/math/negate',
  'logue/math/invert': 'logue/math/negate',
  'logue/util/curve': 'logue/math/curve',
  'logue/mix/ringmod': 'logue/math/multiply',
  'logue/lfo/sample-hold': 'logue/lfo/random-steps',
  'logue/util/trig-hold': 'logue/util/sample-hold'
}

/** The current id a (possibly stale) node `type` string resolves to -- itself, unchanged, when
 *  it's not a known old id. Exported so the UI can detect "this node's own raw `type` isn't the
 *  canonical id" (`canonicalPrimitiveId(node.type) !== node.type`) and show an informational
 *  "renamed" badge, distinct from `findUnresolvedReferences`'s own genuinely-broken case. */
export function canonicalPrimitiveId(nodeType: string): string {
  return RENAMED_PRIMITIVE_IDS[nodeType] ?? nodeType
}

/** Every old id that resolves to `id` through `RENAMED_PRIMITIVE_IDS` or is `supersededBy` it
 *  -- so palette search can still find a primitive by the name a user already knows it by (e.g.
 *  "ringmod", or "shape" for `sense/control`). */
export function formerPrimitiveIds(id: string): string[] {
  return [
    ...Object.keys(RENAMED_PRIMITIVE_IDS).filter((oldId) => RENAMED_PRIMITIVE_IDS[oldId] === id),
    ...PRIMITIVES.filter((p) => p.supersededBy === id).map((p) => p.id)
  ]
}

export function findLoguePrimitive(nodeType: string): LoguePrimitive | undefined {
  return REGISTRY[nodeType] ?? REGISTRY[canonicalPrimitiveId(nodeType)]
}

/** A registry primitive's param spec by name -- the home of its presentation metadata. */
export function findPrimitiveParamSpec(
  primitiveId: string,
  paramName: string
): PrimitiveParamSpec | undefined {
  return findLoguePrimitive(primitiveId)?.params?.find((p) => p.name === paramName)
}

export function findPrimitiveInletSpec(
  primitiveId: string,
  inletName: string
): PrimitiveInletSpec | undefined {
  return findLoguePrimitive(primitiveId)?.inlets?.find((i) => i.name === inletName)
}

export function recognizedLoguePrimitiveIds(): string[] {
  return PRIMITIVES.map((p) => p.id)
}

/**
 * Finds the entry in `items` (a node's own `ParamValue[]`, or a net's raw wired inlet names) whose
 * `name` matches `currentName` -- either directly, or, failing that, via a value-preserving
 * `FieldAlias` targeting it (see that interface's own doc comment for why a non-value-preserving
 * alias is deliberately excluded here rather than silently applied). Generic over `{name: string}`
 * because a net's raw inlet names aren't `ParamValue`-shaped.
 */
export function findAliasedFieldValue<T extends { name: string }>(
  aliases: FieldAlias[] | undefined,
  currentName: string,
  items: readonly T[]
): T | undefined {
  const direct = items.find((item) => item.name === currentName)
  if (direct) return direct
  const alias = aliases?.find((a) => a.to === currentName && a.valuePreserving)
  return alias ? items.find((item) => item.name === alias.from) : undefined
}

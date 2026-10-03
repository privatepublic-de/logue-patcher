/**
 * Barrel for the *logue primitive registry (the code lives in `primitives/`), so every import
 * site stays `.../primitives`.
 *
 * Every primitive is shared verbatim by both platform generators. Korg's own minilogue xd
 * `waves.cpp` does all its DSP in plain `float` and calls `f32_to_q31()` once at the output
 * write, and `osc_sinf`/`clip1m1f`/`osc_w0f_for_note`/the 10-bit param conversion are identical
 * between the xd's and NTS-1 mkII's `osc_api.h`. Q31 is only the xd's output buffer format, so
 * the generators differ in their outer shell, never in DSP math.
 *
 * A primitive is plain generated C++ against `osc_api.h`: per-instance state plus a per-sample
 * expression inside `Osc::process()`. There is no audio-rate/control-rate type: an inlet reads
 * another instance's per-sample float whether it carries audio or modulation.
 */

export {
  type PrimitiveInletSpec,
  type LogueInletRole,
  type LoguePlatform,
  type WirePolarityBucket,
  type PrimitiveOutletPolarity,
  type ResolvedWireBucket,
  type PolarityRefineContext,
  type PrimitiveOutletSpec,
  findSingleWiredSource,
  outletPolarityOf,
  isBufferInlet,
  isBufferOutlet,
  findParamSpec,
  resolveDeclaredOutletName,
  type FieldAlias,
  type LoguePrimitive,
  type InstanceNodeData,
  type HelperBlock,
  type PrimitiveParamSpec,
  presentationKeyOf,
  snapToStep
} from './primitives/types'
export { resolveHelperChain } from './primitives/shared'
export {
  adEnvelopePrimitive,
  ahdEnvelopePrimitive,
  multistageEnvelopePrimitive
} from './primitives/env'
export {
  lowpassCheapFilterPrimitive,
  highpassCheapFilterPrimitive,
  combFilterPrimitive,
  pluckedStringPrimitive,
  svfFilterPrimitive,
  formantFilterPrimitive
} from './primitives/filter'
export { vcaPrimitive } from './primitives/gain'
export {
  lfoSinePrimitive,
  lfoTrianglePrimitive,
  lfoSquarePrimitive,
  lfoRampUpPrimitive,
  lfoRampDownPrimitive,
  fastSquareLfoPrimitive,
  randomStepsPrimitive
} from './primitives/lfo'
export {
  greaterThanPrimitive,
  lessThanPrimitive,
  equalPrimitive,
  andPrimitive,
  orPrimitive,
  xorPrimitive,
  schmittPrimitive,
  edgePrimitive,
  chancePrimitive,
  roundRobinPrimitive
} from './primitives/logic'
export {
  multiplyPrimitive,
  negatePrimitive,
  oneMinusPrimitive,
  curvePrimitive,
  addPrimitive,
  subtractPrimitive,
  scalePrimitive,
  minPrimitive,
  maxPrimitive,
  clampPrimitive,
  absPrimitive
} from './primitives/math'
export {
  mixer2Primitive,
  crossfaderPrimitive,
  panPrimitive,
  widthPrimitive,
  stereoMixer2Primitive,
  stereoCrossfaderPrimitive
} from './primitives/mix'
export { mux2Primitive, mux4Primitive, demux2Primitive } from './primitives/mux'
export {
  sineOscPrimitive,
  sawOscPrimitive,
  squareOscPrimitive,
  pulseOscPrimitive,
  triangleOscPrimitive,
  additiveOscPrimitive,
  noisePrimitive,
  granularOscPrimitive,
  samplePrimitive,
  pluckExciterPrimitive,
  syncOscPrimitive,
  bassSupportPrimitive
} from './primitives/osc'
export {
  sensePitchPrimitive,
  senseShapePrimitive,
  senseShape2Primitive,
  senseCutoffPrimitive,
  senseResonancePrimitive,
  senseParamPrimitive,
  senseGatePrimitive,
  senseVelocityPrimitive
} from './primitives/sense'
export { wavefolderPrimitive, saturatorPrimitive } from './primitives/shape'
export {
  constantPrimitive,
  unipolarToBipolarPrimitive,
  bipolarToUnipolarPrimitive,
  sampleHoldPrimitive,
  glidePrimitive,
  sampleDelayPrimitive,
  delayPrimitive,
  quantizePrimitive,
  bufferPrimitive,
  bufferTapPrimitive,
  grainPrimitive,
  bufferRef
} from './primitives/util'
export {
  directHelpersOf,
  canonicalPrimitiveId,
  formerPrimitiveIds,
  findLoguePrimitive,
  findPrimitiveParamSpec,
  findPrimitiveInletSpec,
  recognizedLoguePrimitiveIds,
  findAliasedFieldValue
} from './primitives/registry'

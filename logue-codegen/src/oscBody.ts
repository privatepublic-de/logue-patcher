import {
  directHelpersOf,
  findLoguePrimitive,
  isBufferInlet,
  resolveHelperChain
} from './primitives'
import { withBlockInvariantVars } from './primitives/shared'
import type { ResolvedActiveInstance, ResolvedSource } from './oscInstances'
import {
  floatLit,
  KNOB_INIT_MEMBERS,
  knobInitPositions,
  resolveParamDefaultValue,
  type ExposedParamBinding,
  type KnobBinding,
  type LogueKnob
} from './oscParams'

/**
 * The pieces every platform's oscillator generator needs to splice into its OWN class/function
 * shape -- shared because the pieces themselves (member decls, per-sample math, param
 * defaults/switch, shared helper functions) are genuinely identical text regardless of
 * platform (see `primitives.ts`'s doc comment on why: every primitive here is plain float
 * math). What's NOT shared is the surrounding class/function wrapper itself -- NTS-1 mkII's
 * `Osc` is a `Processor`-derived class with virtual overrides; minilogue xd's is a plain
 * struct with free `OSC_*` functions calling into it (verified against the real
 * `waves.hpp`/`waves.cpp` reference example) -- genuinely different shapes, not worth forcing
 * into one template just because the inner content happens to match.
 */
export interface OscBodyPieces {
  memberDecls: string
  /** Every primitive's own params seed their internal state from the placed instance's own authored value (falling back to the spec's default when unset -- see `resolveParamDefaultValue`), independent of whether that param is ever exposed via `logueParamIndex`. */
  paramDefaultInits: string
  /** Each active instance's own `initStatement` (e.g. zeroing a phase accumulator) -- omitted entirely for a stateless primitive (e.g. a mixer). */
  stateInits: string
  helperCode: string
  /**
   * One `float y_<suffix> = <renderExpr>;` per active instance, in topological order (an
   * instance's own inlet-suppliers' statements always precede it -- see `oscInstances.ts`'s
   * `resolveAudioGraph`) -- this is the real per-sample chain: each instance's `renderExpr`
   * reads its wired inlets by referencing an EARLIER statement's own `y_<suffix>` variable,
   * never by re-inlining that upstream instance's expression text.
   */
  computeStatements: string
  /** The final active instance's own computed variable (`y_<suffix>`) -- what a real net chain actually wires to `logue/io/audio-out`. Never a sum over every active instance; the moment two chains need to reach the output, that needs an explicit mixer instance (see `logue/mix/mix2`), not an implicit join. */
  outputExpr: string
  advanceStatements: string
  /** `switch (index) { case N: ...; break; ... default: break; }`, or a platform-appropriate no-op body when nothing is exposed. */
  setParameterCases: string
  hasExposedParams: boolean
  /** Each active instance's own `noteOnStatement` (e.g. retriggering an envelope) -- empty for every primitive that doesn't declare one, in which case the platform's real note-on hook is still emitted (both generators always wire it), just with an empty, harmless body. */
  noteOnStatements: string
  /** The note-off counterpart (phase 29) -- same shape as `noteOnStatements`: empty for every primitive that doesn't declare a `noteOffStatement`, in which case the platform's real note-off hook is still emitted, just with an empty, harmless body. */
  noteOffStatements: string
  /** Every knob-bound param set from its knob, then every active instance's `blockConstants` as
   *  `const float` locals -- all ahead of the sample loop, knobs first so the constants see them. */
  blockStatements: string
  /** For each fixed knob with a bound param: its starting position, so the first bound param
   *  keeps its authored value until the device reports the knob. Empty with nothing bound. */
  knobInits: string
  /** An active primitive reads the note-on velocity (`LoguePrimitive.readsVelocity`). */
  readsVelocity: boolean
}

/**
 * An instance's own wired inlets, resolved to the upstream instance's `y_<suffix>` (or, for a
 * non-default outlet of a multi-outlet source, `y_<suffix>_<outlet>`) variable name -- shared by
 * `computeStatements`/`advanceStatements` below, both of which reach a primitive's own callbacks
 * with the SAME resolved shape. Safe to branch on the literal string `'out'` here specifically
 * because `oscInstances.ts`'s `resolveSourceOutlet` already validated/normalized it -- by the time
 * an `inletSources` entry exists, `outlet` is always one of the source primitive's own REAL
 * declared names (defaulting to `'out'` for every single-outlet primitive), never a raw/unchecked
 * net field.
 */
function resolveInletVars(inst: ResolvedActiveInstance): Record<string, string | undefined> {
  const primitive = findLoguePrimitive(inst.id)!
  const inletVars: Record<string, string | undefined> = {}
  for (const [inletName, source] of Object.entries(inst.inletSources)) {
    // A buffer wire has no per-sample variable: the reader gets the writer's suffix and builds
    // its member names from it (`bufferRef`, `primitives/util.ts`).
    inletVars[inletName] = isBufferInlet(primitive, inletName) ? source.suffix : sourceVar(source)
  }
  return inletVars
}

/** The C variable a resolved source's value lives in (`ResolvedSource`'s naming rule). */
export function sourceVar(source: ResolvedSource): string {
  return source.outlet === 'out' ? `y_${source.suffix}` : `y_${source.suffix}_${source.outlet}`
}

/**
 * Where each active instance's SDRAM share (`LoguePrimitive.sdramFloats`) sits in the unit's one
 * block, in graph order -- shared by the effect generator and the RAM estimate so they can't
 * disagree about the size.
 */
export function sdramLayout(activeInstances: ResolvedActiveInstance[]): {
  regions: Array<{ suffix: string; nodeName: string; offset: number; floats: number }>
  totalFloats: number
} {
  const regions: Array<{ suffix: string; nodeName: string; offset: number; floats: number }> = []
  let totalFloats = 0
  for (const inst of activeInstances) {
    const floats = findLoguePrimitive(inst.id)!.sdramFloats?.(inst.node) ?? 0
    if (floats === 0) continue
    regions.push({
      suffix: inst.suffix,
      nodeName: inst.node.name ?? inst.suffix,
      offset: totalFloats,
      floats
    })
    totalFloats += floats
  }
  return { regions, totalFloats }
}

/**
 * The active instances computed once per block instead of per sample: `pure` ones whose wired
 * inlets all come from instances in this set (so, in the end, only from params and knobs). One
 * pass in topological order -- a source emitted later (through a deferred inlet) just isn't
 * hoisted. Their values can only change between blocks, so the output is identical; a knob-only
 * math chain (grain-mill's envelope curve on the xd) then costs nothing per sample.
 */
export function hoistedSuffixes(activeInstances: ResolvedActiveInstance[]): Set<string> {
  const hoisted = new Set<string>()
  for (const inst of activeInstances) {
    if (!findLoguePrimitive(inst.id)!.pure) continue
    if (Object.values(inst.inletSources).every((source) => hoisted.has(source.suffix))) {
      hoisted.add(inst.suffix)
    }
  }
  return hoisted
}

/** The variables a hoisted instance's outputs live in (`sourceVar` per declared outlet). */
function hoistedVars(
  activeInstances: ResolvedActiveInstance[],
  hoisted: ReadonlySet<string>
): Set<string> {
  const vars = new Set<string>()
  for (const inst of activeInstances) {
    if (!hoisted.has(inst.suffix)) continue
    const outlets = findLoguePrimitive(inst.id)!.outlets ?? [{ name: 'out' }]
    for (const outlet of outlets) vars.add(sourceVar({ suffix: inst.suffix, outlet: outlet.name }))
  }
  return vars
}

/** Every primitive hook runs knowing which wired inlets carry a per-block value
 *  (`withBlockInvariantVars`), so their conversions can become block constants too. */
export function buildOscBodyPieces(
  ...args: Parameters<typeof buildOscBodyPiecesUnscoped>
): OscBodyPieces {
  const hoisted = hoistedSuffixes(args[0])
  return withBlockInvariantVars(hoistedVars(args[0], hoisted), () =>
    buildOscBodyPiecesUnscoped(...args)
  )
}

function buildOscBodyPiecesUnscoped(
  activeInstances: ResolvedActiveInstance[],
  exposedParams: Map<number, ExposedParamBinding>,
  /** Which of the sink (last active instance)'s own outlets actually reaches `logue/io/audio-out` -- see `ResolvedAudioGraph.sinkOutlet`. Defaults to `'out'` so every pre-existing single-outlet-only caller/test keeps working unchanged. */
  sinkOutlet: string = 'out',
  /** The platform's note-on velocity (raw 0..127) as a C expression, if it has one. */
  velocityExpr?: string,
  knobBindings: KnobBinding[] = []
): OscBodyPieces {
  const memberDecls = activeInstances
    .map((inst) => findLoguePrimitive(inst.id)!.memberDecls(inst.suffix))
    .join('')
  const advanceStatements = activeInstances
    .map((inst) =>
      findLoguePrimitive(inst.id)!.advanceStatement(inst.suffix, resolveInletVars(inst))
    )
    .join('')
  const stateInits = activeInstances
    .map((inst) => findLoguePrimitive(inst.id)!.initStatement?.(inst.suffix, inst.node) ?? '')
    .join('')
  const paramDefaultInits = activeInstances
    .flatMap((inst) =>
      (findLoguePrimitive(inst.id)!.params ?? []).map((spec) => {
        const value = resolveParamDefaultValue(inst, spec)
        return `    ${spec.setStatement(inst.suffix, String(value))}\n`
      })
    )
    .join('')

  const hoisted = hoistedSuffixes(activeInstances)
  const computeStatement = (inst: ResolvedActiveInstance): string => {
    const primitive = findLoguePrimitive(inst.id)!
    if (primitive.renderOutletStatements) {
      return primitive.renderOutletStatements(inst.suffix, resolveInletVars(inst))
    }
    return `      float y_${inst.suffix} = ${primitive.renderExpr(inst.suffix, resolveInletVars(inst))};\n`
  }
  // After the knob reads (they set the params these read), before the block constants.
  const blockStatements =
    knobBindings.map((b) => `    ${b.statement}\n`).join('') +
    activeInstances
      .filter((inst) => hoisted.has(inst.suffix))
      .map(computeStatement)
      .join('') +
    activeInstances
      .flatMap(
        (inst) =>
          findLoguePrimitive(inst.id)!.blockConstants?.(inst.suffix, resolveInletVars(inst)) ?? []
      )
      .map((c) => `    const float ${c.name} = ${c.expr};\n`)
      .join('')

  const initPositions = knobInitPositions(knobBindings)
  const knobInits = Object.entries(KNOB_INIT_MEMBERS)
    .flatMap(([knob, members]) => {
      const position = initPositions[knob as LogueKnob]
      return position === undefined
        ? []
        : members!.map((member) => `    ${member} = ${floatLit(position)};\n`)
    })
    .join('')

  const computeStatements = activeInstances
    .filter((inst) => !hoisted.has(inst.suffix))
    .map(computeStatement)
    .join('')
  // An effect's outputs come from `stereoSinks` instead, and its graph may have no instance.
  const sink = activeInstances[activeInstances.length - 1]
  const outputExpr = sink ? sourceVar({ suffix: sink.suffix, outlet: sinkOutlet }) : ''

  const helperCode = resolveHelperChain(directHelpersOf(activeInstances))
    .map((h) => h.code)
    .join('\n')

  const setParameterCases = Array.from(exposedParams.values())
    .sort((a, b) => a.index - b.index)
    .map((b) => `    case ${b.index}: ${b.setStatement} break;\n`)
    .join('')

  const noteOnStatements = activeInstances
    .map(
      (inst) =>
        findLoguePrimitive(inst.id)!.noteOnStatement?.(inst.suffix, { velocity: velocityExpr }) ??
        ''
    )
    .join('')
  const noteOffStatements = activeInstances
    .map((inst) => findLoguePrimitive(inst.id)!.noteOffStatement?.(inst.suffix) ?? '')
    .join('')

  return {
    memberDecls,
    paramDefaultInits,
    stateInits,
    helperCode,
    computeStatements,
    outputExpr,
    advanceStatements,
    setParameterCases,
    hasExposedParams: exposedParams.size > 0,
    noteOnStatements,
    noteOffStatements,
    blockStatements,
    knobInits,
    readsVelocity: activeInstances.some((inst) => findLoguePrimitive(inst.id)!.readsVelocity)
  }
}

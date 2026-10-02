import type { LogueModule, PatchDocument, ObjNode, Net } from '../../src/shared/domain/patch'
import {
  findLoguePrimitive,
  isBufferInlet,
  isBufferOutlet,
  recognizedLoguePrimitiveIds,
  resolveDeclaredOutletName,
  type LoguePlatform,
  type LoguePrimitive
} from './primitives'
import { isEffectModule, MODULE_LABEL } from './unitKinds'

/**
 * Shared between every platform's oscillator generator (`nts1mkii/generateOscUnit.ts`,
 * `minilogue-xd/generateOscUnit.ts`) -- graph validation has nothing platform-specific about
 * it, per the phase-0 design resolution (question 2): a logue unit is one flat DSP callback
 * regardless of which platform it targets, so "which node kinds/types are even allowed" is a
 * cross-platform question. What differs per platform (max param count, packaging) lives in
 * each platform's own generator, not here.
 */

export class UnsupportedLogueNodeError extends Error {}

/**
 * A pseudo-object (no `LoguePrimitive` registry entry, no `renderExpr` of its own) representing
 * the platform's single real audio output -- the answer to "maybe we should now go deeper into
 * the logue objects library and building graphs ... right to a logue-output object". Placed via
 * `LoguePrimitivePalette.tsx` exactly like a real primitive
 * (a plain `obj` node with this fixed `type`), but `resolvePrimitiveInstances` recognizes and
 * skips it rather than rejecting it as unrecognized -- `resolveAudioGraph` below is what actually
 * validates/uses it.
 */
export const LOGUE_AUDIO_OUT_TYPE = 'logue/io/audio-out'

/** Inspector.tsx's documentation blurb for this pseudo-object -- it has no `LoguePrimitive`
 *  registry entry of its own (see this file's own doc comment above) for `LoguePrimitive.
 *  description` to live on, so it gets a standalone constant instead. */
export const LOGUE_AUDIO_OUT_DESCRIPTION =
  "The unit's final audio output -- every audible signal must eventually reach here."

/**
 * An effect's audio input: a pseudo-object like `logue/io/audio-out` (no registry entry), a
 * source with no inlets. Its outlets are the incoming left and right samples and their average.
 * Only an effect document may have one, at most one, and only at the top level.
 */
export const LOGUE_AUDIO_IN_TYPE = 'logue/io/audio-in'
export const LOGUE_AUDIO_IN_OUTLETS = ['l', 'r', 'mono'] as const
export const LOGUE_AUDIO_IN_DESCRIPTION =
  'The audio coming into the effect: left, right, and their average (mono).'

/** The document's fixed audio endpoints: placed by `newDoc`, never deleted or replaced. */
export function isFixedIoNodeType(type: string): boolean {
  return type === LOGUE_AUDIO_OUT_TYPE || type === LOGUE_AUDIO_IN_TYPE
}

export interface ResolvedPrimitiveInstance {
  suffix: string
  id: string
  node: ObjNode
}

/**
 * Returns every recognized PRIMITIVE instance -- whether or not it's
 * actually wired to anything -- so `resolveAudioGraph` has the full candidate set to resolve a
 * net's source name against; a primitive placed but never wired to `logue/io/audio-out` is
 * valid (inert, like an unwired object in a real patcher), not an error.
 */
export function resolvePrimitiveInstances(doc: PatchDocument): ResolvedPrimitiveInstance[] {
  if (doc.nodes.length === 0) {
    throw new UnsupportedLogueNodeError(
      'Graph is empty -- a logue unit needs at least one recognized primitive object.'
    )
  }

  const instances: ResolvedPrimitiveInstance[] = []
  doc.nodes.forEach((node, index) => {
    // Comments are canvas annotations -- offered in the palette as "generates no
    // code", so they're skipped, not rejected. (This used to throw: a leftover from the Axoloti
    // fork, where the rejected kinds were patcher/zombie nodes that no longer exist.)
    if (node.kind !== 'obj') return
    const objNode = node as ObjNode
    if (objNode.type === LOGUE_AUDIO_OUT_TYPE || objNode.type === LOGUE_AUDIO_IN_TYPE) return
    const primitive = findLoguePrimitive(objNode.type)
    if (!primitive) {
      throw new UnsupportedLogueNodeError(
        `Node "${objNode.name ?? objNode.type}" has type "${objNode.type}", which isn't a recognized logue primitive. ` +
          `Recognized types: ${recognizedLoguePrimitiveIds().join(', ')}.`
      )
    }
    // A stable, unique-per-node suffix for generated member variables/locals -- the node's own
    // name when present (matches this project's general "canvas node id = .axp node name"
    // convention, `nodeId.ts`), falling back to a positional index for an unnamed node.
    const suffix = sanitizeSuffix(objNode.name ?? `n${index}`)
    instances.push({ suffix, id: primitive.id, node: objNode })
  })
  return instances
}

function sanitizeSuffix(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_')
}

/**
 * An active instance's own inlet, resolved to whichever upstream ACTIVE instance's computed
 * value feeds it -- keyed by inlet name (see `PrimitiveInletSpec`), value is that upstream
 * instance's own `suffix` plus which of its `outlets` was actually wired (`oscBody.ts` turns this
 * into the actual `y_<suffix>` / `y_<suffix>_<outlet>` variable reference -- see
 * `resolveSourceOutlet` below for how `outlet` is validated/normalized). An inlet with no entry
 * here was left unwired -- the primitive's own `renderExpr` decides its fallback.
 */
export interface ResolvedActiveInstance extends ResolvedPrimitiveInstance {
  inletSources: Record<string, ResolvedSource>
}

/**
 * A wired source, as `oscBody.ts` names its variable: `y_<suffix>` for a single-outlet
 * primitive's `'out'`, else `y_<suffix>_<outlet>`. `logue/io/audio-in` is a source too (its own
 * node name as `suffix`, `'l'`/`'r'`/`'mono'` as `outlet`) although it's no active instance: the
 * generator declares those three variables itself.
 */
export interface ResolvedSource {
  suffix: string
  outlet: string
}

export interface ResolvedAudioGraph {
  /** Every recognized primitive placed on canvas, whether wired to the output or not -- kept only for `rejectExposedParamsOnInactiveInstances` (`oscParams.ts`), which needs the full set to catch a param exposed on a node that isn't reachable from the output. */
  instances: ResolvedPrimitiveInstance[]
  /**
   * Every instance that actually contributes to the output, in topological order -- each
   * instance's own inlet-suppliers appear strictly earlier in this array than the instance
   * itself, so a straightforward left-to-right emission (see `oscBody.ts`) never references a
   * variable before it's computed. In an oscillator document the LAST entry is always the one
   * instance directly wired to `logue/io/audio-out`; an effect's outputs are in `stereoSinks`,
   * and its list may be empty (audio-in wired straight to audio-out). An instance NOT in this
   * list is unreachable from the output (inert -- see `resolvePrimitiveInstances`'s doc comment)
   * and gets no codegen at all, matching this project's existing "no auto-sum, no free cycles for
   * an unwired object" precedent.
   */
  activeInstances: ResolvedActiveInstance[]
  /**
   * Which of the sink instance's own `outlets` is actually wired to `logue/io/audio-out` -- see
   * `resolveSourceOutlet`'s own doc comment for what this string means for a single- vs.
   * multi-outlet primitive. `oscBody.ts`'s `buildOscBodyPieces` needs this to build the right
   * `outputExpr` (`y_<sink.suffix>` vs. `y_<sink.suffix>_<sinkOutlet>`). Oscillator documents
   * only (`'out'`, unused, for an effect).
   */
  sinkOutlet: string
  /** Effect documents only: what feeds audio-out's `l` and `r` (`r` is `l` when unwired). */
  stereoSinks?: { l: ResolvedSource; r: ResolvedSource }
  /** Effect documents only, and only when something reads it: the audio-in node's suffix. */
  audioInSuffix?: string
}

/** One net's resolved source: which upstream node, and which of its RAW (unvalidated) `outlet` names -- see `resolveSourceOutlet` for turning this into an actual codegen-safe outlet name. */
interface ResolvedNetSource {
  obj: string
  outlet: string | undefined
}

/**
 * Resolves whatever single source feeds one named inlet of one node, via real `doc.nets`
 * wiring -- shared by both `logue/io/audio-out`'s own single `in` inlet and every ordinary
 * primitive's own declared inlets (`PrimitiveInletSpec`), since "what feeds this one named
 * inlet" is the identical question either way, regardless of whether that inlet carries an
 * audio signal or a control signal (see `primitives.ts`'s doc comment on why there's no
 * separate type for those). Returns `undefined` for an unwired inlet -- not an error by itself;
 * callers decide whether that's fatal (fatal for `logue/io/audio-out`'s `in`, fine for anything
 * else, where the primitive's own `renderExpr` supplies a fallback). Throws if more than one
 * distinct (node, outlet) pair feeds the SAME inlet (fan-in) -- wiring two signals into one
 * inlet needs an explicit mixer object, never an implicit sum. Keyed by node+outlet, not just
 * node, so two DIFFERENT outlets of the same multi-outlet source (e.g. an SVF's own `lp` and
 * `bp`) still correctly count as two distinct sources, not a false dedup.
 */
function resolveInletSource(
  nodeName: string,
  inletNames: string[],
  nets: Net[]
): ResolvedNetSource | undefined {
  const found = new Map<string, ResolvedNetSource>()
  for (const net of nets) {
    if (
      !net.dests.some(
        (d) => d.obj === nodeName && d.inlet !== undefined && inletNames.includes(d.inlet)
      )
    )
      continue
    for (const s of net.sources)
      found.set(`${s.obj}:${s.outlet ?? ''}`, { obj: s.obj, outlet: s.outlet })
  }
  if (found.size > 1) {
    const names = [...found.values()].map((s) => (s.outlet ? `${s.obj}.${s.outlet}` : s.obj))
    throw new UnsupportedLogueNodeError(
      `Inlet "${inletNames[0]}" of "${nodeName}" is fed by more than one source (${names.join(', ')}) -- wire an explicit mixer object instead of connecting multiple sources into one inlet.`
    )
  }
  return found.size === 1 ? [...found.values()][0] : undefined
}

/**
 * The raw net-endpoint inlet names that should all resolve to `inletSpec` -- the current name
 * itself, plus any VALUE-PRESERVING `renamedInlets` alias's old name (safe to auto-resolve, see
 * `FieldAlias`'s own doc comment). A NON-value-preserving alias's old name is deliberately
 * excluded -- silently rewiring it would carry a value whose MEANING changed across the rename
 * (e.g. comb's `delay`->`cutoff` direction inversion) into the new inlet unchanged, producing a
 * wrong result with no error; `unresolvedReferences.ts`'s `findUnresolvedReferences` surfaces
 * that case instead, for the user to re-check by ear.
 */
function acceptedInletNames(primitive: LoguePrimitive, inletName: string): string[] {
  const aliases =
    primitive.renamedInlets
      ?.filter((a) => a.to === inletName && a.valuePreserving)
      .map((a) => a.from) ?? []
  return [inletName, ...aliases]
}

/**
 * Turns a net's own RAW `outlet` field into the actual codegen outlet name to key a `y_<suffix>_*`
 * variable reference by -- NOT a straight passthrough, because `NetSource.outlet` is an
 * unvalidated string that can carry a stale/legacy name with no relationship to what the SOURCE
 * primitive actually declares today. The actual resolution/fallback rules (including the legacy
 * `'out'` case) live in `resolveDeclaredOutletName` (`primitives.ts`), shared verbatim with
 * `toFlowGraph.ts`'s own edge-validity check so codegen and canvas can never disagree about which
 * nets are fine; this wrapper only adds the hard, named error a genuinely unrecognized name gets
 * here (never a silent guess), since a silently-wrong tap would be a real, hard-to-notice wiring
 * bug, not a merely cosmetic one.
 */
function resolveSourceOutlet(
  sourceInstance: ResolvedPrimitiveInstance,
  rawOutlet: string | undefined,
  viaLabel: string
): string {
  const primitive = findLoguePrimitive(sourceInstance.id)!
  const resolved = resolveDeclaredOutletName(primitive, rawOutlet)
  if (resolved === undefined) {
    const declaredOutlets = primitive.outlets ?? [{ name: 'out' }]
    throw new UnsupportedLogueNodeError(
      `"${viaLabel}" is wired from "${sourceInstance.node.name ?? sourceInstance.suffix}"'s outlet ` +
        `"${rawOutlet}", which "${primitive.id}" doesn't declare (has: ${declaredOutlets.map((o) => o.name).join(', ')}).`
    )
  }
  return resolved
}

/**
 * Resolves the full active (output-reachable) instance graph, in topological order, via real
 * `doc.nets` wiring -- generalizes the earlier single-edge-only resolver into a real multi-node
 * DAG walk: an arbitrary chain of primitives, each optionally reading one or more upstream
 * instances through its own declared inlets, ultimately reaching `logue/io/audio-out`.
 *
 * Two real constraints enforced here, both deliberate: one net per inlet (fan-in is a hard error
 * -- `resolveInletSource` above), and no cycles except through a `delayedInlets` inlet
 * (`logue/util/sample-delay`): that inlet is only read after the whole sample is computed, so
 * its source is visited afterwards (a queue, since doing so can reach further delays) instead of
 * ordering the graph. A buffer wire (a `buffer`-role inlet) is queued the same way. Any other
 * loop throws.
 */
export function resolveAudioGraph(doc: PatchDocument): ResolvedAudioGraph {
  const instances = resolvePrimitiveInstances(doc)
  const byName = new Map<string, ResolvedPrimitiveInstance>()
  for (const inst of instances) {
    if (inst.node.name !== undefined) byName.set(inst.node.name, inst)
  }

  const effect = isEffectModule(doc.settings.logueTarget?.module ?? 'osc')
  const audioOutNode = singleIoNode(doc, LOGUE_AUDIO_OUT_TYPE, 'output')
  if (!audioOutNode) {
    throw new UnsupportedLogueNodeError(
      `Graph has no "${LOGUE_AUDIO_OUT_TYPE}" node -- place one and wire a primitive's outlet to it before exporting.`
    )
  }
  const audioOutLabel = audioOutNode.name ?? LOGUE_AUDIO_OUT_TYPE
  const audioInNode = singleIoNode(doc, LOGUE_AUDIO_IN_TYPE, 'input')
  if (audioInNode && !effect) {
    throw new UnsupportedLogueNodeError(
      `"${audioInNode.name ?? LOGUE_AUDIO_IN_TYPE}" is an effect's audio input -- an oscillator has none, it makes its own sound.`
    )
  }
  let audioInSuffix: string | undefined

  // An unnamed node's `node.name` is `undefined` and can never equal a net's (always-string)
  // `obj` reference, so an unnamed audio-out could never actually be wired -- only reachable via
  // hand-edited XML (the canvas always assigns a name via `uniqueNodeName`); falls through to
  // the same "not connected" error below rather than a distinct message.
  const sinkSourceOf = (inlet: string): ResolvedNetSource | undefined =>
    audioOutNode.name !== undefined
      ? resolveInletSource(audioOutNode.name, [inlet], doc.nets)
      : undefined
  const sinkSources = effect
    ? { l: sinkSourceOf('l'), r: sinkSourceOf('r'), in: sinkSourceOf('in') }
    : { in: sinkSourceOf('in') }
  if (effect && sinkSources.in !== undefined) {
    throw new UnsupportedLogueNodeError(
      `"${audioOutLabel}" is wired to "in", but an effect's output is stereo -- wire its "l" (and "r") inlet instead.`
    )
  }
  const mainSink = effect ? sinkSources.l : sinkSources.in
  if (mainSink === undefined) {
    throw new UnsupportedLogueNodeError(
      effect
        ? `"${audioOutLabel}" has nothing on its "l" inlet -- wire the effect's left (or only) output to it before exporting.`
        : `"${audioOutLabel}" isn't connected -- wire a primitive's outlet to it before exporting.`
    )
  }

  // `buffer`: the inlet takes a buffer wire (`isBufferInlet`), which must come from a buffer
  // outlet -- and a buffer outlet may feed nothing else.
  function resolveSource(
    source: ResolvedNetSource,
    viaLabel: string,
    buffer = false
  ): ResolvedSource {
    if (audioInNode?.name !== undefined && source.obj === audioInNode.name) {
      if (!(LOGUE_AUDIO_IN_OUTLETS as readonly string[]).includes(source.outlet ?? '')) {
        throw new UnsupportedLogueNodeError(
          `"${viaLabel}" is wired from "${source.obj}"'s outlet "${source.outlet}", which "${LOGUE_AUDIO_IN_TYPE}" doesn't declare (has: ${LOGUE_AUDIO_IN_OUTLETS.join(', ')}).`
        )
      }
      if (buffer) throw bufferMismatch(viaLabel, source.obj, true)
      audioInSuffix = sanitizeSuffix(source.obj)
      return { suffix: audioInSuffix, outlet: source.outlet! }
    }
    const upstream = visit(source.obj, viaLabel)
    const outlet = resolveSourceOutlet(upstream, source.outlet, viaLabel)
    if (isBufferOutlet(findLoguePrimitive(upstream.id)!, outlet) !== buffer) {
      throw bufferMismatch(viaLabel, source.obj, buffer)
    }
    return { suffix: upstream.suffix, outlet }
  }

  const activeInstances: ResolvedActiveInstance[] = []
  const resolved = new Map<string, ResolvedActiveInstance>()
  const visiting = new Set<string>()
  const deferred: Array<{
    active: ResolvedActiveInstance
    inletName: string
    source: ResolvedNetSource
    viaLabel: string
    buffer: boolean
  }> = []

  function visit(nodeName: string, viaLabel: string): ResolvedActiveInstance {
    const cached = resolved.get(nodeName)
    if (cached) return cached
    const inst = byName.get(nodeName)
    if (!inst) {
      throw new UnsupportedLogueNodeError(
        `"${viaLabel}" is wired from "${nodeName}", which isn't a recognized logue primitive.`
      )
    }
    if (visiting.has(nodeName)) {
      throw new UnsupportedLogueNodeError(
        `Graph has a feedback loop through "${nodeName}" -- a loop has to pass through a "logue/util/sample-delay" (one-sample delay).`
      )
    }
    visiting.add(nodeName)

    const primitive = findLoguePrimitive(inst.id)!
    const problem = primitive.instanceProblem?.(inst.node)
    if (problem !== undefined) {
      throw new UnsupportedLogueNodeError(`"${nodeName}": ${problem}`)
    }
    const inletSources: Record<string, { suffix: string; outlet: string }> = {}
    const delayedHere: Array<{
      inletName: string
      source: ResolvedNetSource
      buffer: boolean
    }> = []
    for (const inletSpec of primitive.inlets ?? []) {
      const source = resolveInletSource(
        nodeName,
        acceptedInletNames(primitive, inletSpec.name),
        doc.nets
      )
      if (source === undefined) continue
      // A buffer wire orders nothing either: a reader reads what the writer stored in earlier
      // samples (the writer stores in `advanceStatement`), so a grain's output may feed its own
      // buffer's input.
      const buffer = isBufferInlet(primitive, inletSpec.name)
      if (buffer || primitive.delayedInlets?.includes(inletSpec.name)) {
        delayedHere.push({ inletName: inletSpec.name, source, buffer })
        continue
      }
      inletSources[inletSpec.name] = resolveSource(source, `${nodeName}.${inletSpec.name}`)
    }

    visiting.delete(nodeName)
    const active: ResolvedActiveInstance = { ...inst, inletSources }
    resolved.set(nodeName, active)
    activeInstances.push(active)
    for (const d of delayedHere) {
      deferred.push({ active, ...d, viaLabel: `${nodeName}.${d.inletName}` })
    }
    return active
  }

  const mainResolved = resolveSource(mainSink, effect ? `${audioOutLabel}.l` : audioOutLabel)
  const rightSink = effect ? sinkSources.r : undefined
  const stereoSinks = effect
    ? {
        l: mainResolved,
        r: rightSink ? resolveSource(rightSink, `${audioOutLabel}.r`) : mainResolved
      }
    : undefined
  while (deferred.length > 0) {
    const { active, inletName, source, viaLabel, buffer } = deferred.shift()!
    active.inletSources[inletName] = resolveSource(source, viaLabel, buffer)
  }

  return {
    instances,
    activeInstances,
    sinkOutlet: effect ? 'out' : mainResolved.outlet,
    ...(stereoSinks ? { stereoSinks } : {}),
    ...(audioInSuffix !== undefined ? { audioInSuffix } : {})
  }
}

function bufferMismatch(viaLabel: string, sourceName: string, wantBuffer: boolean): Error {
  return new UnsupportedLogueNodeError(
    wantBuffer
      ? `"${viaLabel}" takes a buffer wire, but "${sourceName}" doesn't send one -- wire a "logue/util/buffer"'s "buf" outlet to it.`
      : `"${viaLabel}" is wired from "${sourceName}"'s buffer outlet -- a buffer wire can only go to a buffer inlet (like a "logue/util/buffer-tap"'s "buf").`
  )
}

/** The document's one `type` node, or none; more than one is an error. */
function singleIoNode(doc: PatchDocument, type: string, what: string): ObjNode | undefined {
  const nodes = doc.nodes.filter(
    (n): n is ObjNode => n.kind === 'obj' && (n as ObjNode).type === type
  )
  if (nodes.length > 1) {
    throw new UnsupportedLogueNodeError(
      `Graph has ${nodes.length} "${type}" nodes -- a logue unit has exactly one real audio ${what}.`
    )
  }
  return nodes[0]
}

/**
 * Local to this dependency-free package (no import from `src/renderer/`'s own
 * `PLATFORM_LABEL`) -- just for turning a raw `LoguePlatform` id into the same human-readable
 * name the UI shows everywhere else, so a thrown error reads "NTS-1 mkII", not the internal
 * "nts1mkii" id.
 */
export const PLATFORM_DISPLAY_NAME: Record<LoguePlatform, string> = {
  'minilogue-xd': 'minilogue xd',
  nts1mkii: 'NTS-1 mkII'
}

/**
 * Every primitive before the `logue/sense/*` family works identically on both platforms
 * (plain float, shared API), so this check never fired before.
 * Called by both generators right after `resolveAudioGraph`: rejects an active instance whose
 * primitive declares `platforms` and doesn't include the target, with a clear, named error
 * instead of silently emitting uncompilable/meaningless code for a primitive that reads a raw
 * field from the WRONG platform's own SDK struct shape.
 */
export function assertPrimitivesSupportPlatform(
  activeInstances: ResolvedActiveInstance[],
  platform: LoguePlatform
): void {
  for (const inst of activeInstances) {
    const primitive = findLoguePrimitive(inst.id)!
    if (primitive.platforms && !primitive.platforms.includes(platform)) {
      throw new UnsupportedLogueNodeError(
        `"${primitive.id}" (node "${inst.node.name ?? inst.suffix}") isn't supported on ${PLATFORM_DISPLAY_NAME[platform]} yet.`
      )
    }
  }
}

/** Like `assertPrimitivesSupportPlatform`, for `LoguePrimitive.modules`. */
export function assertPrimitivesSupportModule(
  activeInstances: ResolvedActiveInstance[],
  module: LogueModule
): void {
  for (const inst of activeInstances) {
    const primitive = findLoguePrimitive(inst.id)!
    if (primitive.modules && !primitive.modules.includes(module)) {
      throw new UnsupportedLogueNodeError(
        `"${primitive.id}" (node "${inst.node.name ?? inst.suffix}") only works in ${primitive.modules.map((m) => MODULE_LABEL[m].toLowerCase()).join('/')} units -- it reads what a ${MODULE_LABEL[module].toLowerCase()} doesn't get.`
      )
    }
  }
}

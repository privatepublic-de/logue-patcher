import type { ObjNode, PatchDocument } from '@shared/domain/patch'
import { LOGUE_SUBPATCH_INLET_TYPE } from '@logue-codegen/subpatches'
import {
  busNameOf,
  busNodeRole,
  busOutletsOf,
  busRoleOf,
  isBusNodeType,
  isStereoBusNodeType,
  isStereoOnBus
} from '@logue-codegen/buses'
import {
  findSingleWiredSource,
  isBufferInlet,
  outletPolarityOf,
  resolveDeclaredOutletName,
  type ResolvedWireBucket
} from '@logue-codegen/primitives'
import { resolveNodePrimitive } from '../state/subpatchLibraryStore'
import { nodeId } from '../state/nodeId'

// `'neutral'` -- the RESOLVER-ONLY bucket no primitive declares: two of a combiner's own
// audio-role inlets (e.g. `mix2`'s `in1`/`in2`) resolve to different buckets, or resolution hit a
// cycle. `portColors.ts` paints it the neutral gray `PORT_COLOR_NEUTRAL` uses for "any source".
export type { ResolvedWireBucket }

/**
 * Backward-walks `doc.nets` to classify a node's own outlet for wire/dot colour, so a pass-
 * through/combiner primitive (a filter, VCA, mixer, math/mux node -- anything declaring
 * `outletPolarity: 'inherit'`, see that field's own doc comment) reads as whatever's ACTUALLY
 * flowing through it rather than a fixed guess. Returns a closure (not a single-call function) so
 * `toFlowGraph.ts` can memoize across the one `patchDocToFlow` projection it's computed for --
 * `doc.nets`/`typeById` don't change mid-projection, and a fanned-out source (one outlet feeding
 * several destinations) would otherwise re-walk the same upstream chain once per destination.
 *
 * `typeById` is passed in rather than re-derived from `doc.nodes` -- `toFlowGraph.ts` already
 * builds exactly this map while projecting nodes, and node identity/type resolution belongs in
 * exactly one place (same reasoning `wireColor` in `toFlowGraph.ts` already follows for
 * category).
 */
export function createWirePolarityResolver(
  doc: PatchDocument,
  typeById: Map<string, string | undefined>
): (nodeName: string, outletName: string) => ResolvedWireBucket {
  const memo = new Map<string, ResolvedWireBucket>()
  // A "currently being resolved" guard, not just the memo -- `doc.nets` can describe a real cycle
  // mid-edit (codegen's own `resolveAudioGraph` throws on one; this canvas-side resolver has to
  // stay defensive instead, the same reason `PatchCanvas.tsx` tolerates an otherwise-invalid
  // document). A cycle resolves to `'neutral'`, not a guess.
  const visiting = new Set<string>()

  function keyOf(nodeName: string, outletName: string): string {
    return `${nodeName}\u0000${outletName}`
  }

  function resolve(nodeName: string, outletName: string): ResolvedWireBucket {
    const key = keyOf(nodeName, outletName)
    const cached = memo.get(key)
    if (cached) return cached
    if (visiting.has(key)) return 'neutral'
    visiting.add(key)
    const result = resolveUncached(nodeName, outletName)
    visiting.delete(key)
    memo.set(key, result)
    return result
  }

  function resolveUncached(nodeName: string, outletName: string): ResolvedWireBucket {
    // Inside a definition, an inlet port that feeds a buffer inlet brings a buffer wire in.
    if (typeById.get(nodeName) === LOGUE_SUBPATCH_INLET_TYPE && feedsBufferInlet(nodeName)) {
      return 'buffer'
    }
    if (busNodeRole(typeById.get(nodeName) ?? '') === 'receive')
      return busBucket(nodeName, outletName)
    const primitive = resolveNodePrimitive(typeById.get(nodeName) ?? '')
    // No registry entry (the audio-out sink, which has no outlets anyway; a stale/hand-edited
    // node; a legacy Axoloti type) -- same "legacy patches look exactly as they did" fallback
    // every other port colour in this app already uses.
    if (!primitive) return 'audio'

    // A subpatch instance says exactly which inlets each outlet passes through (`inheritFrom`);
    // a hand-written primitive inherits from every audio-role inlet.
    const { declared, inheritInlets } = outletPolarityOf(primitive, outletName)
    if (declared !== 'inherit') return declared

    const inherited = inheritInlets
      .map((inletName) => inletBucket(nodeName, inletName))
      .filter((bucket): bucket is ResolvedWireBucket => bucket !== undefined)
    // Nothing wired to inherit from -- these primitives are predominantly used for audio, so
    // that's the unsurprising default (matches every pass-through node's pre-existing colour).
    // All wired audio-role inlets agree -- propagate that bucket. Genuine disagreement (e.g.
    // `mix2` fed one bipolar and one gate source) has no single correct answer, so it's 'neutral'
    // rather than a guess.
    const result: ResolvedWireBucket =
      inherited.length === 0 ? 'audio' : new Set(inherited).size === 1 ? inherited[0] : 'neutral'
    if (!primitive.refinePolarity) return result
    const node = doc.nodes.find((n) => n.kind === 'obj' && n.name === nodeName)
    const params = node?.kind === 'obj' ? node.params : []
    return (
      primitive.refinePolarity({
        inlet: (inletName) => inletBucket(nodeName, inletName),
        param: (paramName) => {
          const stored = Number(params.find((p) => p.name === paramName)?.value)
          if (Number.isFinite(stored)) return stored
          return primitive.params?.find((spec) => spec.name === paramName)?.default ?? 0
        }
      }) ?? result
    )
  }

  /** A receive carries what its bus's sends in this document carry (a send inside a subpatch
   *  isn't seen; with none, audio like any unwired pass-through). Stereo: the same side. */
  function busBucket(nodeName: string, outletName: string): ResolvedWireBucket {
    const receive = doc.nodes.find((n) => n.kind === 'obj' && n.name === nodeName)
    if (receive?.kind !== 'obj') return 'audio'
    const bus = busNameOf(receive)
    const stereo = isStereoBusNodeType(receive.type)
    const side = stereo ? outletName : undefined
    const inherited = doc.nodes
      .filter(
        (n): n is ObjNode =>
          n.kind === 'obj' &&
          busRoleOf(n) === 'send' &&
          busNameOf(n) === bus &&
          isStereoOnBus(n) === stereo
      )
      .map((send) =>
        // A send node carries what's wired into it; a mixer sending directly, its own outlet.
        isBusNodeType(send.type)
          ? inletBucket(send.name ?? '', side ?? 'in')
          : resolve(send.name ?? '', side ?? busOutletsOf(send.type)![0])
      )
      .filter((bucket): bucket is ResolvedWireBucket => bucket !== undefined)
    return inherited.length === 0
      ? 'audio'
      : new Set(inherited).size === 1
        ? inherited[0]
        : 'neutral'
  }

  /** What arrives at one inlet, `undefined` while it's unwired. A buffer wire into a signal
   *  inlet is an error (dashed), not something to pass on, so it counts as unwired here. */
  function inletBucket(nodeName: string, inletName: string): ResolvedWireBucket | undefined {
    // A fan-in conflict is ignored here -- that's `toFlowGraph.ts`'s dashed-edge job.
    const source = findSingleWiredSource(doc.nets, nodeName, inletName)
    if (!source) return undefined
    const sourcePrimitive = resolveNodePrimitive(typeById.get(source.obj) ?? '')
    const resolvedOutletName = sourcePrimitive
      ? (resolveDeclaredOutletName(sourcePrimitive, source.outlet) ?? source.outlet ?? 'out')
      : (source.outlet ?? 'out')
    const bucket = resolve(source.obj, resolvedOutletName)
    return bucket === 'buffer' ? undefined : bucket
  }

  function feedsBufferInlet(nodeName: string): boolean {
    return doc.nets.some(
      (net) =>
        net.sources.some((src) => src.obj === nodeName) &&
        net.dests.some((d) => {
          const inner = resolveNodePrimitive(typeById.get(d.obj) ?? '')
          return inner !== undefined && d.inlet !== undefined && isBufferInlet(inner, d.inlet)
        })
    )
  }

  return resolve
}

/** Whether a param edit changed how `nodeName`'s own outlets resolve -- only a primitive with
 *  `refinePolarity` reads params, so anything else answers `false` without walking. The canvas
 *  projects wire colours and warnings once per mount, and a param edit doesn't remount it. */
export function outletPolarityChanged(
  before: PatchDocument,
  after: PatchDocument,
  nodeName: string
): boolean {
  const node = after.nodes.find((n) => n.kind === 'obj' && n.name === nodeName)
  if (node?.kind !== 'obj') return false
  const primitive = resolveNodePrimitive(node.type)
  if (!primitive?.refinePolarity) return false
  const outlets = (primitive.outlets ?? [{ name: 'out' }]).map((o) => o.name)
  const resolveIn = (doc: PatchDocument): ((name: string, outlet: string) => ResolvedWireBucket) =>
    createWirePolarityResolver(
      doc,
      new Map(doc.nodes.map((n, i) => [nodeId(n, i), n.kind === 'obj' ? n.type : undefined]))
    )
  const was = resolveIn(before)
  const now = resolveIn(after)
  return outlets.some((outlet) => was(nodeName, outlet) !== now(nodeName, outlet))
}

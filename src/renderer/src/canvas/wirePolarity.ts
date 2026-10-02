import type { PatchDocument } from '@shared/domain/patch'
import { LOGUE_SUBPATCH_INLET_TYPE } from '@logue-codegen/subpatches'
import {
  findSingleWiredSource,
  isBufferInlet,
  outletPolarityOf,
  resolveDeclaredOutletName,
  type WirePolarityBucket
} from '@logue-codegen/primitives'
import { resolveNodePrimitive } from '../state/subpatchLibraryStore'

/**
 * `WirePolarityBucket` plus `'neutral'` -- a fifth, RESOLVER-ONLY value no primitive ever
 * declares (see `PrimitiveOutletPolarity`), produced only when there's genuinely nothing single
 * and correct to say: two of a combiner's own audio-role inlets (e.g. `logue/mix/mix2`'s `in1`/
 * `in2`) resolve to different buckets, or resolution hit a cycle. `portColors.ts` paints this the
 * same neutral gray `PORT_COLOR_NEUTRAL` already uses for "accepts any source".
 */
export type ResolvedWireBucket = WirePolarityBucket | 'neutral'

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
    const primitive = resolveNodePrimitive(typeById.get(nodeName) ?? '')
    // No registry entry (the audio-out sink, which has no outlets anyway; a stale/hand-edited
    // node; a legacy Axoloti type) -- same "legacy patches look exactly as they did" fallback
    // every other port colour in this app already uses.
    if (!primitive) return 'audio'

    // A subpatch instance says exactly which inlets each outlet passes through (`inheritFrom`);
    // a hand-written primitive inherits from every audio-role inlet.
    const { declared, inheritInlets } = outletPolarityOf(primitive, outletName)
    if (declared !== 'inherit') return declared

    const inherited: ResolvedWireBucket[] = []
    for (const inletName of inheritInlets) {
      // A fan-in conflict is ignored here -- that's `toFlowGraph.ts`'s dashed-edge job.
      const source = findSingleWiredSource(doc.nets, nodeName, inletName)
      if (!source) continue
      const sourcePrimitive = resolveNodePrimitive(typeById.get(source.obj) ?? '')
      const resolvedOutletName = sourcePrimitive
        ? (resolveDeclaredOutletName(sourcePrimitive, source.outlet) ?? source.outlet ?? 'out')
        : (source.outlet ?? 'out')
      const bucket = resolve(source.obj, resolvedOutletName)
      // A buffer wire into a signal inlet is an error (dashed), not something to pass on.
      if (bucket !== 'buffer') inherited.push(bucket)
    }
    // Nothing wired to inherit from -- these primitives are predominantly used for audio, so
    // that's the unsurprising default (matches every pass-through node's pre-existing colour).
    if (inherited.length === 0) return 'audio'
    const distinct = new Set(inherited)
    // All wired audio-role inlets agree -- propagate that bucket. Genuine disagreement (e.g.
    // `mix2` fed one bipolar and one gate source) has no single correct answer, so it's 'neutral'
    // rather than a guess.
    return distinct.size === 1 ? inherited[0] : 'neutral'
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

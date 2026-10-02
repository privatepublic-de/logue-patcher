import type { ObjNode, PatchDocument } from '../../src/shared/domain/patch'
import {
  findLoguePrimitive,
  canonicalPrimitiveId,
  resolveDeclaredOutletName,
  type LoguePrimitive
} from './primitives'
import { LOGUE_AUDIO_IN_TYPE, LOGUE_AUDIO_OUT_TYPE } from './oscInstances'
import { isSubpatchInstanceType } from './subpatches'

/**
 * Detects a node's own stale references against the CURRENT primitive registry -- added
 * 2026-09-21 alongside `RENAMED_PRIMITIVE_IDS`/`FieldAlias` (`primitives.ts`) after a real,
 * twice-repeated incident: a rename/merge left an old `.loguepatch` file's `node.type`/
 * `ParamValue.name`/net inlet name silently unresolvable, with NOTHING in the UI indicating
 * anything was wrong -- `ports.ts`'s tier-3 wiring-inference fallback made an unrecognized type
 * look like an ordinary (if generic) node, a stale `ParamValue.name` just silently fell back to
 * the spec default (`resolveParamDefaultValue`), and a net wired to a stale inlet name simply
 * never became a rendered edge at all (its dest inlet doesn't match any of the resolved
 * primitive's declared inlets, so it's dropped, not shown as broken). Both `comb.loguepatch` and
 * `formant.loguepatch` hit this before being fixed by hand; this module is what would have
 * surfaced the problem immediately instead of needing a debugging session.
 *
 * Deliberately a SEPARATE module from `primitives/` (which only imports types from
 * `shared/domain/`) -- this reads whole `PatchDocument`s, like `oscInstances.ts` does.
 */

export type UnresolvedReferenceKind =
  | 'unrecognized-type'
  | 'missing-subpatch'
  | 'renamed-type'
  | 'stale-param'
  | 'stale-inlet'
  | 'stale-outlet'
  /** `LoguePrimitive.instanceProblem` -- e.g. a granular node with no sample loaded. `note`
   *  carries the primitive's own message. */
  | 'instance-problem'

export interface UnresolvedReference {
  kind: UnresolvedReferenceKind
  /** The raw, possibly-stale name actually stored on disk -- a `node.type`, a `ParamValue.name`,
   *  or a net's `NetDest.inlet`. */
  rawName: string
  /**
   * The current name it resolves/renamed to, when known. Always set for `'renamed-type'` (a
   * successful, transparent resolution -- purely informational). Set for `'stale-param'`/
   * `'stale-inlet'` only when a NON-value-preserving `FieldAlias` matched (see that interface's
   * own doc comment) -- absent when `rawName` isn't recognized as any old name at all.
   */
  renamedTo?: string
  /** Why this needs manual attention -- present whenever `renamedTo` came from a non-value-
   *  preserving alias (mirrors that `FieldAlias`'s own `note`). Absent for `'renamed-type'`
   *  (nothing to explain, the id-level rename is always value-preserving) and for a totally
   *  unrecognized name with no alias match at all (nothing more specific to say). */
  note?: string
}

/**
 * Per-node report; an empty array means nothing wrong. Checks three independent things, in
 * order, stopping early only when the type itself doesn't resolve (nothing else to compare
 * params/inlets against without a resolved primitive spec):
 *
 * 1. `node.type` -- unrecognized even via `RENAMED_PRIMITIVE_IDS` (`'unrecognized-type'`), or
 *    recognized only via that table (`'renamed-type'`, informational).
 * 2. Every `ParamValue` the node actually carries, against the resolved primitive's own
 *    `params` -- a name matching neither a current spec nor a value-preserving `renamedParams`
 *    alias is stale (`'stale-param'`).
 * 3. Every net endpoint actually wired to this node by name (`doc.nets`, scanned since a stale
 *    wire has no other way to be found -- it produced no port/edge to begin with), against the
 *    resolved primitive's own `inlets` -- same value-preserving-alias exemption as params
 *    (`'stale-inlet'`).
 */
export function findUnresolvedReferences(
  doc: PatchDocument,
  node: ObjNode,
  // The canvas passes its subpatch-aware resolver, so a `sub/*` instance is checked against its
  // definition's CURRENT interface exactly like a primitive against its spec.
  resolvePrimitive: (type: string) => LoguePrimitive | undefined = findLoguePrimitive
): UnresolvedReference[] {
  const results: UnresolvedReference[] = []
  // The audio-out (and audio-in) pseudo-object deliberately has no `LoguePrimitive` registry entry at all (see
  // `LOGUE_AUDIO_OUT_TYPE`'s own doc comment) -- every other resolver in this codebase special-
  // cases it the same way (`ports.ts`, `oscInstances.ts`'s `resolvePrimitiveInstances`) before
  // treating an unresolved type as a problem; skipping that check here would flag every single
  // patch's own output node as "unrecognized", a false positive on the one node type that's
  // always guaranteed to be there.
  if (node.type === LOGUE_AUDIO_OUT_TYPE || node.type === LOGUE_AUDIO_IN_TYPE) return results
  const primitive = resolvePrimitive(node.type)
  if (!primitive) {
    results.push({
      kind: isSubpatchInstanceType(node.type) ? 'missing-subpatch' : 'unrecognized-type',
      rawName: node.type
    })
    return results
  }
  if (canonicalPrimitiveId(node.type) !== node.type) {
    results.push({ kind: 'renamed-type', rawName: node.type, renamedTo: primitive.id })
  }
  const problem = primitive.instanceProblem?.(node)
  if (problem !== undefined) {
    results.push({ kind: 'instance-problem', rawName: node.type, note: problem })
  }

  for (const paramValue of node.params) {
    if (primitive.params?.some((spec) => spec.name === paramValue.name)) continue
    const alias = primitive.renamedParams?.find((a) => a.from === paramValue.name)
    if (alias?.valuePreserving) continue
    results.push({
      kind: 'stale-param',
      rawName: paramValue.name,
      renamedTo: alias?.to,
      // A primitive just ignores an unknown param; a subpatch instance's Export fails on it
      // (see `flattenSubpatches`), since it's almost always a promoted param renamed in the
      // definition, whose value and device slot would otherwise silently vanish.
      note:
        alias?.note ??
        (isSubpatchInstanceType(node.type)
          ? "The subpatch doesn't expose it any more (renamed or removed?), so Export fails until you rename it back in the subpatch or remove this value."
          : undefined)
    })
  }

  if (node.name !== undefined) {
    const wiredInletNames = new Set<string>()
    for (const net of doc.nets) {
      for (const dest of net.dests) {
        if (dest.obj === node.name && dest.inlet !== undefined) wiredInletNames.add(dest.inlet)
      }
    }
    for (const inletName of wiredInletNames) {
      if (primitive.inlets?.some((spec) => spec.name === inletName)) continue
      const alias = primitive.renamedInlets?.find((a) => a.from === inletName)
      if (alias?.valuePreserving) continue
      results.push({
        kind: 'stale-inlet',
        rawName: inletName,
        renamedTo: alias?.to,
        note: alias?.note
      })
    }
    const staleOutlets = new Set<string>()
    for (const net of doc.nets) {
      for (const source of net.sources) {
        if (source.obj !== node.name) continue
        if (resolveDeclaredOutletName(primitive, source.outlet) === undefined) {
          staleOutlets.add(source.outlet ?? '')
        }
      }
    }
    for (const outletName of staleOutlets)
      results.push({ kind: 'stale-outlet', rawName: outletName })
  }

  return results
}

import type { PatchDocument } from '../../src/shared/domain/patch'
import {
  directHelpersOf,
  findLoguePrimitive,
  resolveHelperChain,
  type LoguePlatform
} from './primitives'
import { UnsupportedLogueNodeError } from './oscInstances'
import { resolvePlatformGraph } from './resolveUnit'
import type { SubpatchDefinitions } from './subpatches'
import { findUnitKind, isEffectModule } from './unitKinds'
import { CODE_HELPER_BYTES, CODE_SIZE_TABLE, type CodeSize } from './codeSizeTable'
import type { ResolvedActiveInstance } from './oscInstances'
import { sdramLayout } from './oscBody'

/**
 * A live RAM estimate for the current graph: what the unit loads, code and state together, since
 * both devices put them in one budget. Two halves of different kinds:
 * - State is exact, not estimated: every primitive's hand-counted `stateBytesPerInstance`, each
 *   deduped helper's embedded table once (`HelperBlock.sharedBytes`, e.g. `logue/osc/additive`'s
 *   wavetables), the always-declared members (`UnitKind.fixedBaselineBytes`) and the SDRAM
 *   pointers. `scripts/measureCodeSizes.ts` checks the per-instance numbers against real bss.
 * - Code is measured, not modelled: the kind's `fixedCodeBytes` and each primitive's entry in
 *   `codeSizeTable.ts` (real builds of one and two instances, wired and unwired, with shared
 *   out-of-line helpers counted once). Against whole builds it's -7%..+23%, usually over
 *   (`scripts/checkCodeSizeEstimate.ts`); history in docs/HISTORY.md.
 */

export interface InstanceStateCost {
  /** The placed node's own display name (falls back to its codegen suffix if unnamed). */
  nodeName: string
  primitiveId: string
  bytes: number
}

export interface HelperStateCost {
  helperKey: string
  bytes: number
}

export interface OscStateCostEstimate {
  /**
   * One entry per OUTPUT-REACHABLE instance, in the same topological order
   * `resolveAudioGraph.activeInstances` returns them -- a node not wired to
   * `logue/io/audio-out` gets no codegen at all (see that function's own doc comment) and
   * correctly contributes nothing here either, matching the existing tested guarantee that a
   * pruned sibling's state var never appears in generated output.
   */
  perInstance: InstanceStateCost[]
  /**
   * One entry per DEDUPED active helper that embeds a `static const` table
   * (`HelperBlock.sharedBytes`) -- resolved via the exact same `resolveHelperChain` call
   * `oscBody.ts` itself uses to decide what actually gets emitted, so this can never disagree
   * with real codegen about which helpers are active or how many times each is counted. A
   * helper referenced by 5 active instances (or 1) still appears here exactly once, since its
   * own embedded table is only ever emitted once either way -- unlike `perInstance`, this list
   * does NOT scale with instance count.
   */
  sharedHelpers: HelperStateCost[]
  /** The unit's always-declared members (`UnitKind.fixedBaselineBytes`), whatever the graph. */
  baselineBytes: number
  /**
   * The unit kind's measured fixed code (`UnitKind.fixedCodeBytes`): what an otherwise empty
   * generated unit loads besides the baseline members.
   */
  codeBaselineBytes: number
  /**
   * The primitives' code, from real builds (`codeSizeTable.ts`): each instance of a primitive
   * costs its entry's `first` for the first one and `extra` for each further one; the
   * out-of-line functions they call (`helpers`: a `*_step` leaf, `note_w0`, a libm routine) are
   * counted once for the unit. `unmeasured` lists primitives with no entry, counted as 0.
   */
  code: {
    perInstance: InstanceStateCost[]
    helpers: HelperStateCost[]
    unmeasured: string[]
  }
  /** Members, SDRAM pointers and embedded tables: exact, hand-counted, checked against builds. */
  stateBytes: number
  /** `codeBaselineBytes` plus the primitives' measured code. */
  codeBytes: number
  totalBytes: number
  /** The pool code and state share: `UnitKind.ramBytes` (sources on each `unitKinds.ts` entry). */
  budgetBytes: number
  /**
   * Effects only: the unit's SDRAM, where delay lines live (`LoguePrimitive.sdramFloats`, laid
   * out by `sdramLayout` exactly as the generator does), against its budget
   * (`UnitKind.sdramBytes`). The pointer each instance keeps to its share is in `totalBytes`.
   */
  sdram?: {
    perInstance: InstanceStateCost[]
    usedBytes: number
    budgetBytes: number
  }
}

export type OscStateCostResult =
  | { status: 'ok'; estimate: OscStateCostEstimate }
  /** Mirrors whatever `resolveAudioGraph`/`assertPrimitivesSupportPlatform` themselves consider
   *  fatal (empty graph, unconnected output, fan-in conflict, a cycle, a primitive unsupported on
   *  this platform, ...) -- the same class of "nothing meaningful to estimate yet" state
   *  Export/Build already surface via their own `error` UI, reused here rather than duplicated. */
  | { status: 'incomplete'; reason: string }

/**
 * Recompute against a specific platform, not once per document -- `assertPrimitivesSupportPlatform`
 * means a graph can resolve cleanly for one platform and throw for the other (e.g. a
 * `logue/sense/cutoff` instance, minilogue-xd-only), so this can't be a single document-level
 * result. Same "recompute live against `buildPlatform`" pattern `BuildPanel.tsx`'s own
 * `exposureWarnings`/`unitNameTooLong` already use.
 */
export function estimateOscStateCost(
  doc: PatchDocument,
  platform: LoguePlatform,
  subpatches: SubpatchDefinitions = new Map()
): OscStateCostResult {
  try {
    const graph = resolvePlatformGraph(doc, subpatches, platform)
    const perInstance: InstanceStateCost[] = graph.activeInstances.map((inst) => {
      const primitive = findLoguePrimitive(inst.id)!
      return {
        nodeName: inst.node.name ?? inst.suffix,
        primitiveId: primitive.id,
        bytes: primitive.stateBytesPerInstance
      }
    })
    // Same `directHelpersOf -> resolveHelperChain` call `oscBody.ts`'s own
    // `helperCode` uses, so "which helpers are actually emitted" can't drift between codegen and
    // this estimate.
    const sharedHelpers: HelperStateCost[] = resolveHelperChain(
      directHelpersOf(graph.activeInstances)
    )
      .filter((h) => h.sharedBytes !== undefined && h.sharedBytes > 0)
      .map((h) => ({ helperKey: h.key, bytes: h.sharedBytes! }))
    // resolvePlatformGraph has already rejected a module without an entry.
    const kind = findUnitKind(platform, doc.settings.logueTarget?.module ?? 'osc')!
    const baselineBytes = kind.fixedBaselineBytes
    const codeBaselineBytes = kind.fixedCodeBytes ?? 0
    const code = primitiveCode(graph.activeInstances, platform, isEffectModule(kind.module))
    const { regions, totalFloats } = sdramLayout(graph.activeInstances)
    const pointerBytes = regions.length * 4
    const stateBytes =
      baselineBytes +
      pointerBytes +
      perInstance.reduce((sum, i) => sum + i.bytes, 0) +
      sharedHelpers.reduce((sum, h) => sum + h.bytes, 0)
    const codeBytes =
      codeBaselineBytes +
      code.perInstance.reduce((sum, i) => sum + i.bytes, 0) +
      code.helpers.reduce((sum, h) => sum + h.bytes, 0)
    return {
      status: 'ok',
      estimate: {
        perInstance,
        sharedHelpers,
        baselineBytes,
        codeBaselineBytes,
        code,
        stateBytes,
        codeBytes,
        totalBytes: stateBytes + codeBytes,
        budgetBytes: kind.ramBytes,
        ...(kind.sdramBytes !== undefined
          ? {
              sdram: {
                perInstance: regions.map((r) => ({
                  nodeName: r.nodeName,
                  primitiveId: graph.activeInstances.find((i) => i.suffix === r.suffix)!.id,
                  bytes: r.floats * 4
                })),
                usedBytes: totalFloats * 4,
                budgetBytes: kind.sdramBytes
              }
            }
          : {})
      }
    }
  } catch (err) {
    if (err instanceof UnsupportedLogueNodeError) {
      return { status: 'incomplete', reason: err.message }
    }
    throw err
  }
}

function primitiveCode(
  instances: ResolvedActiveInstance[],
  platform: LoguePlatform,
  effect: boolean
): OscStateCostEstimate['code'] {
  const context = `${platform}:${effect ? 'fx' : 'osc'}` as const
  const column = CODE_SIZE_TABLE[context]
  const helpers = new Set<string>()
  const seen = new Set<string>()
  const unmeasured = new Set<string>()
  const perInstance = instances.map((inst) => {
    // Through the rename map, like everything else that reads an instance's primitive.
    const primitive = findLoguePrimitive(inst.id)!
    const id = primitive.id
    const entry = column[id]
    if (!entry) {
      unmeasured.add(id)
      return { nodeName: inst.node.name ?? inst.suffix, primitiveId: id, bytes: 0 }
    }
    // Measured with every inlet wired and with none; a partly wired instance lies in between
    // (an unwired input's work becomes a block constant, or folds away).
    const inlets = primitive.inlets ?? []
    const wired = inlets.filter((i) => inst.inletSources[i.name] !== undefined).length
    const share = inlets.length === 0 ? 1 : wired / inlets.length
    const low = entry.unwired ?? entry
    const pick = (size: CodeSize): number => (seen.has(id) ? size.extra : size.first)
    const bytes = Math.round(pick(low) + (pick(entry) - pick(low)) * share)
    for (const helper of (share > 0 ? entry : low).helpers) helpers.add(helper)
    seen.add(id)
    return { nodeName: inst.node.name ?? inst.suffix, primitiveId: id, bytes }
  })
  return {
    perInstance,
    helpers: [...helpers].map((helperKey) => ({
      helperKey,
      bytes: CODE_HELPER_BYTES[context][helperKey] ?? 0
    })),
    unmeasured: [...unmeasured]
  }
}

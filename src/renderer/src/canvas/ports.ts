import type { LogueModule, PatchNode, Net } from '@shared/domain/patch'
import { resolveDeclaredOutletName, type LogueInletRole } from '@logue-codegen/primitives'
import {
  LOGUE_AUDIO_IN_OUTLETS,
  LOGUE_AUDIO_IN_TYPE,
  LOGUE_AUDIO_OUT_TYPE
} from '@logue-codegen/oscInstances'
import { isEffectModule } from '@logue-codegen/unitKinds'
import { LOGUE_SUBPATCH_INLET_TYPE, LOGUE_SUBPATCH_OUTLET_TYPE } from '@logue-codegen/subpatches'
import { resolveNodePrimitive } from '../state/subpatchLibraryStore'

/** No DataTypeKind domain survives Axoloti removal -- every logue signal is plain float
 *  (see resolvePorts' own doc comment), so a port carries a name plus, for an inlet, the
 *  display-only signal-path/modulation role its primitive declares (see
 *  `PrimitiveInletSpec.role`). Emphatically not a revived type domain -- it changes nothing
 *  but how portColors.ts paints the dot and the cable landing on it, except a `buffer` inlet,
 *  which only takes a buffer wire (`portKindsAgree`). */
export interface PortInfo {
  name: string
  /**
   * Absent on every outlet, and on an inlet whose role genuinely isn't knowable -- one outlet
   * can fan out to both an audio and a control inlet, so a SOURCE has no single role, and the
   * infer-from-wiring fallback below has no primitive spec to read one from. Both fall back to
   * the neutral colour rather than guessing.
   */
  role?: LogueInletRole
  /** Display text instead of `name` (`PrimitiveInletSpec.label`). */
  label?: string
  /** A port a wire still references but the node no longer declares (a subpatch definition
   *  that dropped it, a Replace with... onto a type without it) -- kept as a handle (drawn
   *  broken) so the wire stays visible and can be disconnected, instead of vanishing. */
  stale?: boolean
}

/**
 * A buffer wire (`util/buffer`'s `buf`, a reference to its ring) may only land on a
 * `buffer`-role inlet, and a buffer inlet takes nothing else -- the one pairing codegen rejects
 * by kind (`oscInstances.ts`), so the canvas refuses it while connecting and dashes it in a file.
 */
export function portKindsAgree(
  outletBucket: string | undefined,
  inletRole: LogueInletRole | undefined,
  sourceType?: string,
  targetType?: string
): boolean {
  // A subpatch's own port nodes carry whatever the instance is wired with.
  if (sourceType === LOGUE_SUBPATCH_INLET_TYPE || targetType === LOGUE_SUBPATCH_OUTLET_TYPE) {
    return true
  }
  return (outletBucket === 'buffer') === (inletRole === 'buffer')
}

export interface ResolvedPorts {
  inlets: PortInfo[]
  outlets: PortInfo[]
}

/**
 * Resolves a node's inlet/outlet handles, in priority order:
 *  1. A logue primitive/pseudo-object (`logue/osc/*`, `logue/io/audio-out`) -- fixed ports from
 *     `logue-codegen`'s own primitive registry, the only ports any node has post-Axoloti-removal.
 *  2. Fallback: infer from what's actually wired in this patch's own nets. Covers a node whose
 *     `type` doesn't resolve against the primitive registry (e.g. a stale/hand-edited file) --
 *     without it, cables would have nothing to visually anchor to.
 */
export function resolvePorts(
  node: PatchNode,
  nodeName: string,
  nets: Net[],
  /** The document's module: an effect's audio-out is stereo. */
  module: LogueModule = 'osc'
): ResolvedPorts {
  // Fixed, always-present ports (not inferred from wiring) so the graph-based codegen this
  // exists for (`oscInstances.ts`'s `resolveAudioGraph`) has somewhere to actually draw a wire
  // TO/FROM before any net exists yet.
  if (node.kind === 'obj') {
    if (node.type === LOGUE_AUDIO_OUT_TYPE) {
      // The one true audio sink -- nothing else it could be.
      return isEffectModule(module)
        ? {
            inlets: [
              { name: 'l', role: 'audio' },
              { name: 'r', role: 'audio' }
            ],
            outlets: []
          }
        : { inlets: [{ name: 'in', role: 'audio' }], outlets: [] }
    }
    if (node.type === LOGUE_AUDIO_IN_TYPE) {
      return { inlets: [], outlets: LOGUE_AUDIO_IN_OUTLETS.map((name) => ({ name })) }
    }
    const primitive = resolveNodePrimitive(node.type)
    if (primitive) {
      const declared: ResolvedPorts = {
        inlets: (primitive.inlets ?? []).map((inlet) => ({
          name: inlet.name,
          role: inlet.role,
          ...(inlet.label !== undefined ? { label: inlet.label } : {})
        })),
        outlets: (primitive.outlets ?? [{ name: 'out' }]).map((outlet) => ({ name: outlet.name }))
      }
      const wired = wiredPortNames(nodeName, nets)
      const staleInlets = [...wired.inlets]
        .filter((name) => !declared.inlets.some((p) => p.name === name))
        .map((name) => ({ name, stale: true }))
      // Resolved the way codegen and the edges do: a single-outlet node answers to any name.
      const staleOutlets = [...wired.outlets]
        .filter((name) => resolveDeclaredOutletName(primitive, name) === undefined)
        .map((name) => ({ name, stale: true }))
      return {
        inlets: [...declared.inlets, ...staleInlets],
        outlets: [...declared.outlets, ...staleOutlets]
      }
    }
  }

  const { inlets, outlets } = wiredPortNames(nodeName, nets)
  // No `role` here on purpose: with no primitive spec to read one from, this node's inlets have
  // no knowable role, and a guess would be worse than the neutral colour (see PortInfo.role).
  return {
    inlets: [...inlets].map((name) => ({ name })),
    outlets: [...outlets].map((name) => ({ name }))
  }
}

function wiredPortNames(
  nodeName: string,
  nets: Net[]
): { inlets: Set<string>; outlets: Set<string> } {
  const inlets = new Set<string>()
  const outlets = new Set<string>()
  for (const net of nets) {
    for (const s of net.sources) if (s.obj === nodeName && s.outlet) outlets.add(s.outlet)
    for (const d of net.dests) if (d.obj === nodeName && d.inlet) inlets.add(d.inlet)
  }
  return { inlets, outlets }
}

/** Whether some net currently lands on this exact node+inlet -- same `d.obj === nodeName`
 *  matching `resolvePorts`' own wiring-inference fallback above uses, extracted so `ParamDial.tsx`
 *  can ask the same question `@logue-codegen/paramModulation` needs answered without duplicating
 *  the net-walk. */
export function isInletWired(nets: Net[], nodeName: string, inletName: string): boolean {
  return nets.some((net) => net.dests.some((d) => d.obj === nodeName && d.inlet === inletName))
}

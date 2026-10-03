import type { Node, Edge } from '@xyflow/react'
import type { CommentNode, PatchDocument, PatchNode } from '@shared/domain/patch'
import {
  findUnresolvedReferences,
  type UnresolvedReference
} from '@logue-codegen/unresolvedReferences'
import { nodeId } from './nodeId'
import { portKindsAgree, resolvePorts, type PortInfo, type ResolvedPorts } from '../canvas/ports'
import { colorForBucket } from '../canvas/portColors'
import { wireWarning } from '../canvas/wireWarnings'
import { createWirePolarityResolver, type ResolvedWireBucket } from '../canvas/wirePolarity'
import { isFixedIoNodeType } from '@logue-codegen/oscInstances'
import { resolveDeclaredOutletName } from '@logue-codegen/primitives'
import { resolveNodePrimitive } from './subpatchLibraryStore'

export interface ObjectNodeData extends Record<string, unknown> {
  node: PatchNode
  index: number
  inlets: PortInfo[]
  outlets: PortInfo[]
  /**
   * Per-inlet colour for whichever inlets are currently wired (keyed by inlet name; an unwired
   * inlet has no entry) -- ObjectNode.tsx's own Handle falls back to `colorForRole` only when an
   * inlet's own name is absent from this map. Once a cable lands on an inlet, that inlet's own
   * dot should read as an extension of the cable feeding it (the SOURCE outlet's own resolved
   * bucket colour, the same value assigned to the edge itself below) rather than a generic role
   * colour -- the two would otherwise disagree the moment a genuine control chain (e.g.
   * `logue/sense/shape` -> `logue/math/curve` -> a filter's `cutoff`) wires into an inlet whose
   * own declared role happens to be `audio` (`logue/math/curve`'s `in`, a generic passthrough for
   * either kind of signal). Computed here (not in ObjectNode.tsx) because it needs `doc.nets`,
   * not just this one node; recomputed on every projection, same freshness guarantee
   * `inlets`/`outlets` already rely on (`PatchCanvas.tsx` remounts on every structural mutation).
   */
  inletColors: Record<string, string>
  /**
   * Per-outlet colour (keyed by outlet name), resolved via `wirePolarity.ts` -- unlike
   * `inletColors`, this doesn't depend on whether the outlet is itself wired to anything
   * downstream, only on what's wired INTO this node's own inlets upstream, so it's computed
   * right alongside `inlets`/`outlets` rather than during the nets loop below. Needed per-OUTLET
   * (not a single colour for the whole node) because `logue/sense/*`'s `unipolar`/`bipolar` pair
   * genuinely differ from each other on the exact same node.
   */
  outletColors: Record<string, string>
  /** The raw bucket behind each `outletColors` entry (same keys) -- `ObjectNode.tsx` needs this,
   *  not just the colour, to also pick the outlet dot's SHAPE (`outletShapeClassForBucket`). */
  outletBuckets: Record<string, ResolvedWireBucket>
  /** See `unresolvedReferences.ts` -- computed here (not in ObjectNode.tsx itself) because it
   *  needs `doc.nets`, not just this one node; `[]` for the common case of nothing wrong.
   *  Recomputed on every projection, same freshness guarantee `inlets`/`outlets` already rely on
   *  (`PatchCanvas.tsx` remounts on every structural mutation). */
  unresolvedReferences: UnresolvedReference[]
  /** `NetEdgeData.warning` again, keyed by the inlet it lands on, for the inlet's own marker. */
  inletWarnings: Record<string, string>
}

/** Per-edge styling data, resolved once here so TypedEdge just paints it. */
export interface NetEdgeData extends Record<string, unknown> {
  netIndex: number
  destIndex: number
  color: string
  /** Dashed, matching the original's "connected but not a valid net" rendering -- see Net.isValidNet() in Net.java. */
  invalid: boolean
  /** A wire whose signal shape doesn't suit the replacing inlet it lands on
   *  (`InletExpectation.warnFrom`), e.g. a bipolar LFO into a VCA's `gain`. */
  warning?: string
}

export interface CommentNodeData extends Record<string, unknown> {
  node: CommentNode
  index: number
}

export type ObjectFlowNode = Node<ObjectNodeData, 'object'>
export type CommentFlowNode = Node<CommentNodeData, 'comment'>

/**
 * Projects the domain PatchDocument into React Flow's Node[]/Edge[] shape. This is a
 * one-way, recomputed-on-change projection, not a synced copy: the domain doc stays the
 * source of truth (see patchStore.ts), and PatchCanvas only writes back the specific
 * mutations a user interaction implies (move/connect/delete), never round-trips React
 * Flow's own internal state into the store wholesale.
 */
export function patchDocToFlow(
  doc: PatchDocument,
  selectedNodeId: string | null = null
): { nodes: (ObjectFlowNode | CommentFlowNode)[]; edges: Edge[] } {
  const portsById = new Map<string, ResolvedPorts>()
  const typeById = new Map<string, string | undefined>()
  const objectNodesById = new Map<string, ObjectFlowNode>()

  const nodes: (ObjectFlowNode | CommentFlowNode)[] = doc.nodes.map((n, index) => {
    const id = nodeId(n, index)
    typeById.set(id, n.kind === 'obj' ? n.type : undefined)
    // PatchCanvasSession remounts on every reloadNonce bump (see PatchCanvas.tsx) --
    // seeding React Flow's *initial* selection from the store here means it starts correct,
    // so its own onSelectionChange doesn't immediately fire with an empty selection and
    // wipe out selectedNodeId right after the remount (a real bug: this used to clear the
    // Inspector after literally every param edit, since setParamField bumps reloadNonce).
    const selected = id === selectedNodeId
    if (n.kind === 'comment') {
      const commentNode: CommentFlowNode = {
        id,
        type: 'comment',
        position: { x: n.x, y: n.y },
        selected,
        data: { node: n, index }
      }
      return commentNode
    }
    const ports = resolvePorts(n, id, doc.nets, doc.settings.logueTarget?.module)
    portsById.set(id, ports)
    const objectNode: ObjectFlowNode = {
      id,
      type: 'object',
      position: { x: n.x, y: n.y },
      selected,
      // The fixed audio-out sink (and an effect's audio-in) is never deletable (patchStore.ts's
      // `deleteNodes` already refuses, but this stops React Flow's own Backspace/Delete handling
      // from even attempting it -- no attempt-then-silently-restore flicker for a plain delete).
      deletable: !(n.kind === 'obj' && isFixedIoNodeType(n.type)),
      data: {
        node: n,
        index,
        inlets: ports.inlets,
        outlets: ports.outlets,
        // Filled in below, once the nets loop has resolved every wired inlet's own colour --
        // this object is the SAME one `data` refers to (not a copy), so mutating it in place
        // there is visible here without a second pass over `nodes`.
        inletColors: {},
        // Filled in just below, once `typeById` is fully populated -- resolving a node's own
        // outlet colour can need to look up an UPSTREAM node's type, and that node may appear
        // later in `doc.nodes` than this one (array order isn't topological).
        outletColors: {},
        outletBuckets: {},
        inletWarnings: {},
        unresolvedReferences:
          n.kind === 'obj' ? findUnresolvedReferences(doc, n, resolveNodePrimitive) : []
      }
    }
    objectNodesById.set(id, objectNode)
    return objectNode
  })

  // One resolver per projection, shared by the outlet-colour pass below and the edge-colour pass
  // further down -- its own internal memo means a fanned-out source (one outlet feeding several
  // destinations) is only ever walked once, not once per destination (see `wirePolarity.ts`).
  const resolvePolarity = createWirePolarityResolver(doc, typeById)
  for (const [id, objectNode] of objectNodesById) {
    for (const outlet of objectNode.data.outlets) {
      const bucket = resolvePolarity(id, outlet.name)
      objectNode.data.outletColors[outlet.name] = colorForBucket(bucket)
      objectNode.data.outletBuckets[outlet.name] = bucket
    }
  }

  const edges: Edge[] = []
  doc.nets.forEach((net, netIndex) => {
    net.sources.forEach((source, sourceIndex) => {
      // Resolve the net's raw outlet field the SAME way codegen does (`resolveDeclaredOutletName`,
      // shared with `oscInstances.ts`'s own `resolveSourceOutlet`) -- otherwise a net authored
      // before its source primitive grew multiple outlets (e.g. a `logue/sense/*` reading, still
      // carrying the old implicit `'out'`) would resolve fine at Export/Build time but render as a
      // broken/dashed edge here, a real, misleading disagreement between the two. A node whose
      // type doesn't resolve to a registry primitive at all (stale/hand-edited) keeps the raw name
      // unchanged -- `ports.ts`'s own wiring-inference fallback already collects that exact string
      // as a real outlet name in that case, nothing to resolve against.
      const sourcePrimitive = resolveNodePrimitive(typeById.get(source.obj) ?? '')
      const resolvedOutletName = sourcePrimitive
        ? (resolveDeclaredOutletName(sourcePrimitive, source.outlet) ?? source.outlet)
        : source.outlet
      const outlet = portsById.get(source.obj)?.outlets.find((o) => o.name === resolvedOutletName)
      net.dests.forEach((dest, destIndex) => {
        const inlet = portsById.get(dest.obj)?.inlets.find((i) => i.name === dest.inlet)
        // Matches Net.isValidNet() (Net.java): exactly one source, and both ends must actually
        // resolve to a real port. There's no per-type conversion check left to make (a logue
        // signal has one plain-float domain, not Axoloti's frac32/int32/bool32/charptr32 set).
        const invalid =
          net.sources.length !== 1 ||
          !outlet ||
          !inlet ||
          !!outlet.stale ||
          !!inlet.stale ||
          !portKindsAgree(
            objectNodesById.get(source.obj)?.data.outletBuckets[outlet.name],
            inlet.role,
            typeById.get(source.obj),
            typeById.get(dest.obj)
          )
        // Reuses the exact same resolver call (memoized) the outlet-colour pass above already
        // made for this source+outlet -- a wire and the dot it leaves from can never disagree by
        // construction. `resolvedOutletName` can be `undefined` for a genuinely broken reference
        // (see `outlet` above); `'out'` is a harmless placeholder there since `resolvePolarity`
        // already falls back to the audio bucket for anything that doesn't resolve to a real
        // primitive/outlet.
        const bucket = resolvePolarity(source.obj, resolvedOutletName ?? 'out')
        const color = colorForBucket(bucket)
        const warning =
          !invalid && dest.inlet !== undefined
            ? wireWarning(
                doc,
                bucket,
                { obj: source.obj, outlet: resolvedOutletName ?? 'out' },
                { obj: dest.obj, inlet: dest.inlet }
              )
            : undefined
        const data: NetEdgeData = {
          netIndex,
          destIndex,
          color,
          invalid,
          warning
        }
        if (warning && dest.inlet) {
          const destNode = objectNodesById.get(dest.obj)
          if (destNode) destNode.data.inletWarnings[dest.inlet] = warning
        }
        // A valid, resolved landing inlet takes over this wire's own colour for its dot (see
        // ObjectNodeData.inletColors' own doc comment) -- an invalid net (bad fan-in, or either
        // end unresolved) has no real single source to inherit from, so its destination inlet
        // (if it even resolved) is left at its ordinary role colour instead of a guess.
        if (!invalid && dest.inlet) {
          const destNode = objectNodesById.get(dest.obj)
          if (destNode) destNode.data.inletColors[dest.inlet] = color
        }
        // Elevate a selected object's own cables above every unselected node/edge, so a
        // highlighted net still reads clearly where it happens to route under some other
        // node's body -- but stay well below elevateNodesOnSelect's own z (1000 for the
        // selected node itself), never above it. This value is used VERBATIM (PatchCanvas.tsx
        // deliberately doesn't pass elevateEdgesOnSelect -- see its doc comment for why: that
        // built-in prop doesn't just gate on this, it ADDS the connected node's own z on top,
        // which put a node's cables above its own body the moment it got selected). The
        // endpoint node is exactly the one whose knobs/sliders the user is about to interact
        // with (selecting it is usually the first half of a click-then-drag on one of its
        // widgets), so its own cables must always stay under it.
        const touchesSelected =
          selectedNodeId !== null && (source.obj === selectedNodeId || dest.obj === selectedNodeId)
        edges.push({
          id: `net-${netIndex}-s${sourceIndex}-d${destIndex}`,
          type: 'typed',
          source: source.obj,
          sourceHandle: resolvedOutletName,
          target: dest.obj,
          targetHandle: dest.inlet,
          zIndex: touchesSelected ? 500 : 0,
          data
        })
      })
    })
  })

  return { nodes, edges }
}

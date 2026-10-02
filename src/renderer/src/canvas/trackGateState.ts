import type { PatchDocument } from '@shared/domain/patch'
import { isTrackGated, type ParamTrackGate } from '@logue-codegen/paramTrackGate'
import { useOptionalPatchStore } from '../state/patchStore'
import { nodeId } from '../state/nodeId'

/** Whether `gate`'s switch (e.g. TRACK) on node `id` currently makes the gated dial/inlet inert. */
export function isNodeTrackGated(
  doc: PatchDocument | null,
  id: string,
  gate: ParamTrackGate | undefined
): boolean {
  if (!gate) return false
  const node = doc?.nodes.find((n, i) => nodeId(n, i) === id)
  const raw =
    node?.kind === 'obj' ? node.params.find((p) => p.name === gate.gateParam)?.value : undefined
  const n = raw === undefined ? NaN : Number(raw)
  return isTrackGated(gate, Number.isFinite(n) ? n : gate.gateDefault)
}

/**
 * The same, read live from the store: a canvas node's own `data.node` is a mount-time snapshot
 * for param values (only a structural change remounts it), so flipping TRACK on the same node
 * would otherwise leave its gated dials and inlets stale.
 */
export function useIsTrackGated(id: string, gate: ParamTrackGate | undefined): boolean {
  return useOptionalPatchStore((s) => isNodeTrackGated(s.rootDoc, id, gate))
}

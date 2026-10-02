import type { PatchNode } from '@shared/domain/patch'

/**
 * The stable identity React Flow (and this app's own net-editing logic) addresses a node
 * by. Deliberately the same string a net's `source.obj`/`dest.obj` already uses -- .axp
 * nets reference nodes by `name`, not by array position (verified against
 * patch/object/iolet/IoletInstance.java's `obj` attribute) -- so reusing `name` as the
 * canvas node id means net endpoints and canvas node ids are the same key, with no separate
 * index<->name translation layer to keep in sync.
 *
 * Nodes without a name (most commonly comments, which aren't wired into nets) fall back to
 * a position-derived id that's only used for React's own reconciliation, never persisted.
 */
export function nodeId(node: PatchNode, index: number): string {
  return node.name ?? `__unnamed_${index}`
}

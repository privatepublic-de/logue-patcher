import type { PatchNode } from '@shared/domain/patch'

/**
 * The type label ObjectNode.tsx's `titlebar` shows above an instance's name -- an `obj`'s own
 * `type` string (e.g. "logue/osc/sine"). A `comment` has no meaningful one (never
 * rendered via ObjectNode at all) and get `undefined`. Shared with Inspector.tsx so the side
 * panel's own "Type" row always agrees with what the canvas node itself displays.
 */
export function nodeTypeLabel(node: PatchNode): string | undefined {
  return node.kind === 'obj' ? node.type : undefined
}

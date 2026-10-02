import type { Node } from '@xyflow/react'
import { GRID_SIZE } from '../state/patchStore'

/**
 * Capture range for a magnetic alignment guide (flow-space px, either axis): a dragged node's
 * raw coordinate engages the snap once within this distance of a neighboring node's own
 * coordinate on that axis.
 */
export const SNAP_CAPTURE_PX = 6

/**
 * Once snapped, the raw coordinate must move this far past the snapped target before the guide
 * releases -- the hysteresis gap that lets a user "drag further to leave" per the feature
 * request. Reuses GRID_SIZE (the existing paste/nudge grid step) as a familiar, already-tuned
 * distance rather than inventing a second unrelated constant.
 */
export const SNAP_RELEASE_PX = GRID_SIZE

/**
 * Axis-agnostic core shared by computeYSnap/computeXSnap: computes the coordinate a dragged node
 * should visually snap to on one axis, given every other node's own coordinate on that axis as
 * candidates and whichever coordinate (if any) it's currently snapped to from the previous drag
 * frame. Hysteresis: staying snapped only requires being within `release` of the CURRENT target
 * (a wider band than engaging a fresh snap), so small jitter near the target doesn't flicker the
 * guide on/off every frame. Returns null (no snap) when nothing is within range.
 */
function computeAxisSnap(
  raw: number,
  candidates: readonly number[],
  currentSnap: number | null,
  capture: number,
  release: number
): number | null {
  if (currentSnap !== null && candidates.includes(currentSnap)) {
    if (Math.abs(raw - currentSnap) <= release) return currentSnap
  }

  let nearest: number | null = null
  let nearestDist = Infinity
  for (const c of candidates) {
    const dist = Math.abs(raw - c)
    if (dist < nearestDist) {
      nearestDist = dist
      nearest = c
    }
  }
  return nearest !== null && nearestDist <= capture ? nearest : null
}

/** Y-axis wrapper around computeAxisSnap -- see that function's own doc comment for the mechanism. */
export function computeYSnap(
  rawY: number,
  candidateYs: readonly number[],
  currentSnapY: number | null,
  capture: number = SNAP_CAPTURE_PX,
  release: number = SNAP_RELEASE_PX
): number | null {
  return computeAxisSnap(rawY, candidateYs, currentSnapY, capture, release)
}

/** X-axis wrapper around computeAxisSnap -- see that function's own doc comment for the mechanism. */
export function computeXSnap(
  rawX: number,
  candidateXs: readonly number[],
  currentSnapX: number | null,
  capture: number = SNAP_CAPTURE_PX,
  release: number = SNAP_RELEASE_PX
): number | null {
  return computeAxisSnap(rawX, candidateXs, currentSnapX, capture, release)
}

/**
 * Every stationary node's Y eligible as a snap target for the node(s) currently being dragged
 * -- excludes comments (React Flow type 'comment'; not a meaningful alignment target,
 * see codegen's position-based instance order) and excludes whatever's in `draggedIds` (a node
 * can't snap against itself, or against another node moving together with it in the same
 * multi-select drag). Shared by onNodeDrag (live) and onNodeDragStop (final commit) so both
 * compute the identical candidate set.
 */
export function candidateSnapYs(nodes: readonly Node[], draggedIds: ReadonlySet<string>): number[] {
  return nodes.filter((n) => n.type !== 'comment' && !draggedIds.has(n.id)).map((n) => n.position.y)
}

/**
 * Every stationary node's X eligible as a snap target for the node(s) currently being dragged --
 * same exclusions as candidateSnapYs (comments are position-order-irrelevant on
 * either axis, and a node can't snap against itself or a co-dragged sibling).
 */
export function candidateSnapXs(nodes: readonly Node[], draggedIds: ReadonlySet<string>): number[] {
  return nodes.filter((n) => n.type !== 'comment' && !draggedIds.has(n.id)).map((n) => n.position.x)
}

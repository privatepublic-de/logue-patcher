import { resolveNodePrimitive } from '../state/subpatchLibraryStore'
import { GRID_SIZE } from '../state/patchStore'
import { isCompactPrimitive } from './compactNode'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Breathing room kept between a new node and anything already on the canvas. */
const NODE_GAP = GRID_SIZE
/** Kept clear of the visible area's edges so a new node never lands half-clipped. */
const VIEW_PADDING = GRID_SIZE * 2

/** Area of `a` and `b` intersecting once `b` is grown by `gap` on every side (0 = clear). */
function overlapArea(a: Rect, b: Rect, gap: number): number {
  const w = Math.min(a.x + a.width, b.x + b.width + gap) - Math.max(a.x, b.x - gap)
  const h = Math.min(a.y + a.height, b.y + b.height + gap) - Math.max(a.y, b.y - gap)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * The top-left (flow coordinates, snapped to GRID_SIZE) for a node of `size` inside `view` that
 * overlaps none of `occupied`, nearest the view's center. Candidates are the grid points of the
 * view sorted by distance, so the result is deterministic. In a view with no free spot left it
 * takes the one overlapping existing nodes least, so repeated inserts still spread out instead of
 * stacking; a node bigger than the view is just centered.
 */
export function findFreeSpot(
  view: Rect,
  occupied: Rect[],
  size: { width: number; height: number }
): { x: number; y: number } {
  const snap = (v: number): number => Math.round(v / GRID_SIZE) * GRID_SIZE
  const minX = view.x + VIEW_PADDING
  const minY = view.y + VIEW_PADDING
  const maxX = view.x + view.width - VIEW_PADDING - size.width
  const maxY = view.y + view.height - VIEW_PADDING - size.height
  const centerX = view.x + view.width / 2 - size.width / 2
  const centerY = view.y + view.height / 2 - size.height / 2
  const fallback = { x: snap(Math.max(minX, centerX)), y: snap(Math.max(minY, centerY)) }
  if (maxX < minX || maxY < minY) return fallback

  const candidates: { x: number; y: number; d: number }[] = []
  for (let x = Math.ceil(minX / GRID_SIZE) * GRID_SIZE; x <= maxX; x += GRID_SIZE) {
    for (let y = Math.ceil(minY / GRID_SIZE) * GRID_SIZE; y <= maxY; y += GRID_SIZE) {
      candidates.push({ x, y, d: (x - centerX) ** 2 + (y - centerY) ** 2 })
    }
  }
  candidates.sort((a, b) => a.d - b.d)
  let best = fallback
  let bestArea = Infinity
  for (const c of candidates) {
    const box = { x: c.x, y: c.y, width: size.width, height: size.height }
    const area = occupied.reduce((sum, o) => sum + overlapArea(box, o, NODE_GAP), 0)
    if (area === 0) return { x: c.x, y: c.y }
    if (area < bestArea) {
      best = { x: c.x, y: c.y }
      bestArea = area
    }
  }
  return best
}

/**
 * A new node's footprint before it has rendered (nothing to measure yet), from the same rows
 * ObjectNode.tsx draws: a header, one row per port, one dial row per param. Only needs to be
 * roughly right -- it decides where free space is, not the node's real size.
 */
export function estimateNodeSize(type: string): { width: number; height: number } {
  if (type === 'patch/comment') return { width: 140, height: 40 }
  if (isCompactPrimitive(type)) return { width: 110, height: 30 }
  const spec = resolveNodePrimitive(type)
  const ports = Math.max(spec?.inlets?.length ?? 0, spec?.outlets?.length ?? 1)
  const params = spec?.params?.length ?? 0
  return { width: 150, height: 60 + ports * 18 + params * 37 }
}

type InsertPositionProvider = (type: string) => { x: number; y: number } | null

let provider: InsertPositionProvider | null = null

/**
 * The sidebar palette sits outside the canvas's ReactFlowProvider, so it can't read the viewport
 * itself; the mounted canvas registers this lookup instead. Returns an unregister function that
 * only clears the slot if it still holds this provider (a remount registers its successor first).
 */
export function registerInsertPositionProvider(fn: InsertPositionProvider): () => void {
  provider = fn
  return () => {
    if (provider === fn) provider = null
  }
}

/** Where a new `type` node should go in the currently visible canvas, or null with no canvas. */
export function findInsertPosition(type: string): { x: number; y: number } | null {
  return provider?.(type) ?? null
}

import type { Viewport } from '@xyflow/react'
import type { Size as NodeSize } from './autoArrange'

export type { NodeSize }

/**
 * Real, DOM-measured node footprints (React Flow's own `node.measured`, populated via
 * ResizeObserver once a node actually renders) -- kept here, outside React state, so
 * PatchWorkspace's "Rearrange" button (a sibling of PatchCanvasSession, not a descendant)
 * can read them synchronously at click time without threading a ref/callback through
 * PatchCanvas. Keyed by `${sessionKey}:${nodeId}`, where sessionKey identifies the
 * tab+file+subpatch-level a measurement was taken in -- the same identity components
 * PatchCanvas.tsx's own remount `key` uses (minus reloadNonce/scanNonce, which don't change
 * node geometry) -- so a same-named node in an unrelated tab or subpatch level can never
 * masquerade as a stale measurement for the one actually being rearranged.
 */
const measurements = new Map<string, NodeSize>()

export function buildCanvasSessionKey(tabId: string, filePath: string | null): string {
  return `${tabId}-${filePath ?? 'untitled'}`
}

export function recordNodeMeasurement(sessionKey: string, nodeId: string, size: NodeSize): void {
  measurements.set(`${sessionKey}:${nodeId}`, size)
}

export function getSessionMeasurements(sessionKey: string): Map<string, NodeSize> {
  const prefix = `${sessionKey}:`
  const result = new Map<string, NodeSize>()
  for (const [key, size] of measurements) {
    if (key.startsWith(prefix)) result.set(key.slice(prefix.length), size)
  }
  return result
}

/**
 * Last-known zoom/pan per session, keyed the same way as `measurements` above -- lives outside
 * React/the store so it survives PatchCanvasSession's own remount-on-`reloadNonce` (see
 * PatchCanvas.tsx's doc comment): every structural edit (add/remove a net, delete a node, an
 * attrib/param edit, etc) used to snap the canvas back to a fresh `fitView` because that was the
 * ONLY viewport React Flow had ever been given. Recorded continuously via `onMove` so even a
 * remount that lands mid-gesture (e.g. a keyboard shortcut fired while still panning) doesn't
 * lose the in-progress viewport.
 */
const viewports = new Map<string, Viewport>()

export function recordViewport(sessionKey: string, viewport: Viewport): void {
  viewports.set(sessionKey, viewport)
}

export function getSessionViewport(sessionKey: string): Viewport | undefined {
  return viewports.get(sessionKey)
}

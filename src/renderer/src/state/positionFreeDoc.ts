import { useState } from 'react'
import type { PatchDocument, PatchNode } from '@shared/domain/patch'

function sameExceptPosition(a: PatchNode, b: PatchNode): boolean {
  if (a === b) return true
  const aKeys = Object.keys(a) as (keyof PatchNode)[]
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every((k) => k === 'x' || k === 'y' || a[k] === b[k])
}

/** True when `next` differs from `prev` in node positions only (or not at all). */
export function differsOnlyInPositions(prev: PatchDocument, next: PatchDocument): boolean {
  if (prev === next) return true
  if (prev.nets !== next.nets || prev.settings !== next.settings || prev.notes !== next.notes) {
    return false
  }
  if (prev.nodes.length !== next.nodes.length) return false
  return prev.nodes.every((n, i) => sameExceptPosition(n, next.nodes[i]))
}

/**
 * Returns the previously returned document while only node positions change, so a memo keyed on
 * it (codegen-side analysis, which never reads x/y) skips every drag frame of a node move.
 */
export function usePositionFreeDoc(doc: PatchDocument | null): PatchDocument | null {
  const [kept, setKept] = useState(doc)
  if (kept !== doc && (doc === null || kept === null || !differsOnlyInPositions(kept, doc))) {
    // React's "adjust state while rendering" pattern: re-runs this render with the new value.
    setKept(doc)
    return doc
  }
  return kept
}

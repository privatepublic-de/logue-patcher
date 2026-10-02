import { useCallback, useEffect, useRef, useState } from 'react'

interface UseSidebarResizeOptions {
  /** Undefined until the persisted setting has loaded (see App.tsx) -- the hook just keeps
   *  whatever width it already has until a real value arrives, so there's no flash-to-default
   *  before the async settings read resolves. */
  persistedWidth: number | undefined
  defaultWidth: number
  min: number
  max: number
  /** Which edge of the panel the handle sits on -- a 'left' sidebar's handle is on its right
   *  edge (dragging right grows it), a 'right' sidebar's handle is on its left edge (dragging
   *  left grows it), so the sign of the drag delta needs to flip between the two. */
  side: 'left' | 'right'
  onCommit: (width: number) => void
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/**
 * Drag-to-resize for `.app-sidebar-left`/`.app-sidebar-right` (both previously fixed-width, see
 * the UI audit this addresses). Mirrors `useParamDrag.ts`'s established shape (width state +
 * a ref mirroring it for the pointermove closure, window-level pointermove/pointerup so the
 * drag survives the pointer leaving the thin handle, a `dragging` flag for the handle's own
 * hover/active styling) but is otherwise unrelated -- a plain single-axis pixel drag, no
 * value/tick domain. `onCommit` fires once per gesture, on pointerup, not per pointermove, so
 * persisting to disk (an IPC round-trip) can't fire dozens of times during one drag.
 */
export function useSidebarResize({
  persistedWidth,
  defaultWidth,
  min,
  max,
  side,
  onCommit
}: UseSidebarResizeOptions): {
  width: number
  dragging: boolean
  onPointerDown: (e: React.PointerEvent) => void
} {
  const [width, setWidth] = useState(() => clamp(persistedWidth ?? defaultWidth, min, max))
  const widthRef = useRef(width)
  const [dragging, setDragging] = useState(false)
  const onCommitRef = useRef(onCommit)

  useEffect(() => {
    onCommitRef.current = onCommit
  }, [onCommit])

  // Applies the persisted width once it finishes loading (it arrives async, after this hook's
  // first render already used `defaultWidth`) -- see the doc comment on `persistedWidth` above.
  // Only reacts to the persisted value itself changing, not to min/max (constant at runtime).
  const [appliedPersistedWidth, setAppliedPersistedWidth] = useState(persistedWidth)
  if (persistedWidth !== appliedPersistedWidth) {
    setAppliedPersistedWidth(persistedWidth)
    if (persistedWidth !== undefined) setWidth(clamp(persistedWidth, min, max))
  }

  useEffect(() => {
    widthRef.current = width
  }, [width])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      setDragging(true)
      const startX = e.clientX
      const startWidth = widthRef.current
      // Without this, a fast drag selects the sidebar's own text (labels, tree entries) the
      // same way a fast double-click-drag would anywhere else on the page.
      const previousUserSelect = document.body.style.userSelect
      document.body.style.userSelect = 'none'

      function handleMove(ev: PointerEvent): void {
        const dx = ev.clientX - startX
        const next = clamp(startWidth + (side === 'left' ? dx : -dx), min, max)
        widthRef.current = next
        setWidth(next)
      }
      function handleUp(): void {
        window.removeEventListener('pointermove', handleMove)
        window.removeEventListener('pointerup', handleUp)
        document.body.style.userSelect = previousUserSelect
        setDragging(false)
        onCommitRef.current(widthRef.current)
      }
      window.addEventListener('pointermove', handleMove)
      window.addEventListener('pointerup', handleUp)
    },
    [min, max, side]
  )

  return { width, dragging, onPointerDown }
}

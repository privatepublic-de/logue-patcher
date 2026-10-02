import { useCallback, useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

// Drag a `.modal` by its `.modal__header`, kept fully inside the window. The offset is a CSS
// `translate` on top of the overlay's flex centering and lives only in a ref (no re-render per
// pointer move); a freshly mounted modal element starts centered again.
export function useDraggableModal(): {
  modalRef: (el: HTMLDivElement | null) => void
  onHeaderPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
} {
  const elRef = useRef<HTMLDivElement | null>(null)
  const offset = useRef({ x: 0, y: 0 })

  const moveTo = useCallback((x: number, y: number): void => {
    const el = elRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const baseLeft = rect.left - offset.current.x
    const baseTop = rect.top - offset.current.y
    // When the modal is bigger than the window, the min bound wins so its header stays reachable.
    const clampedX = Math.max(-baseLeft, Math.min(x, window.innerWidth - baseLeft - rect.width))
    const clampedY = Math.max(-baseTop, Math.min(y, window.innerHeight - baseTop - rect.height))
    offset.current = { x: clampedX, y: clampedY }
    el.style.translate = `${clampedX}px ${clampedY}px`
  }, [])

  const modalRef = useCallback((el: HTMLDivElement | null): void => {
    elRef.current = el
    offset.current = { x: 0, y: 0 }
  }, [])

  useEffect(() => {
    const reclamp = (): void => moveTo(offset.current.x, offset.current.y)
    window.addEventListener('resize', reclamp)
    return () => window.removeEventListener('resize', reclamp)
  }, [moveTo])

  const onHeaderPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      if (e.button !== 0) return
      if ((e.target as Element).closest('button, input, select, textarea, a')) return
      e.preventDefault()
      const header = e.currentTarget
      header.setPointerCapture(e.pointerId)
      const startX = e.clientX - offset.current.x
      const startY = e.clientY - offset.current.y
      let moved = false

      const onMove = (ev: PointerEvent): void => {
        moved = true
        moveTo(ev.clientX - startX, ev.clientY - startY)
      }
      const onUp = (): void => {
        header.removeEventListener('pointermove', onMove)
        header.removeEventListener('pointerup', onUp)
        header.removeEventListener('pointercancel', onUp)
        if (!moved) return
        // A drag released over the backdrop must not count as the backdrop click that closes the
        // modal; the click (if any) follows pointerup before any timer runs.
        const swallow = (ev: MouseEvent): void => ev.stopPropagation()
        window.addEventListener('click', swallow, true)
        setTimeout(() => window.removeEventListener('click', swallow, true), 0)
      }
      header.addEventListener('pointermove', onMove)
      header.addEventListener('pointerup', onUp)
      header.addEventListener('pointercancel', onUp)
    },
    [moveTo]
  )

  return { modalRef, onHeaderPointerDown }
}

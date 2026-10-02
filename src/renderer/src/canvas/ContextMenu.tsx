import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clampToViewport } from '../util/viewportClamp'

export interface ContextMenuItem {
  label: string
  onClick: () => void
  disabled?: boolean
  checked?: boolean
  /** Small colored dot rendered before the label -- a CSS color value (e.g. a `var(--perf-color-red)` token). Used by the performance-widget color menu so a color reads before it's committed, rather than by name alone. */
  swatchColor?: string
}

interface ContextMenuProps {
  screenPos: { x: number; y: number }
  items: ContextMenuItem[]
  onClose: () => void
}

/**
 * Generic right-click menu -- backs the node/jack/param context menus (see PatchCanvas.tsx's
 * single delegated `onContextMenu` handler, which computes `items` per target kind and hands
 * them here). Closes on Escape or any click outside itself; a `checked` item renders as a
 * checkbox row (used only by the param menu's "parameter on parent").
 */
function ContextMenu({ screenPos, items, onClose }: ContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLUListElement>(null)
  const [pos, setPos] = useState(screenPos)

  // Runs after every commit (not just on screenPos change) since the menu's own size can
  // shift with its content (e.g. a swatch/checkbox column) independent of where it opened --
  // the prev/clamped equality check below is what keeps this from looping forever.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const clamped = clampToViewport(screenPos.x, screenPos.y, rect.width, rect.height)
    setPos((prev) => (prev.x === clamped.x && prev.y === clamped.y ? prev : clamped))
  })

  useEffect(() => {
    function handlePointerDown(e: PointerEvent): void {
      const target = e.target as HTMLElement
      if (!target.closest('.context-menu')) onClose()
    }
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [onClose])

  return (
    <ul
      ref={menuRef}
      className="context-menu nodrag nopan"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <li key={item.label}>
          <button
            className="context-menu__item"
            disabled={item.disabled}
            onClick={() => {
              item.onClick()
              onClose()
            }}
          >
            {item.checked !== undefined && (
              <span className="context-menu__check">{item.checked ? '✓' : ''}</span>
            )}
            {item.swatchColor && (
              <span
                className="context-menu__swatch"
                style={{ backgroundColor: item.swatchColor }}
              />
            )}
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  )
}

export default ContextMenu

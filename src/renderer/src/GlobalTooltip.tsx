import { useEffect, useLayoutEffect, useRef, useState } from 'react'

const SHOW_DELAY_MS = 500

const EDGE_MARGIN_PX = 8
const ANCHOR_GAP_PX = 6

interface TooltipState {
  text: string
  anchor: DOMRect
  /** `data-tooltip-side="right"`: a wrapping popover beside the anchor instead of a tooltip
   *  centered above/below it -- for longer text on items hugging the window's left edge (the
   *  palette). */
  right: boolean
}

/** Placement from the tooltip's real measured size, so a long one never runs past the window. */
function placeTooltip(
  anchor: DOMRect,
  right: boolean,
  width: number,
  height: number
): { left: number; top: number } {
  const maxLeft = window.innerWidth - width - EDGE_MARGIN_PX
  const maxTop = window.innerHeight - height - EDGE_MARGIN_PX
  const clamp = (v: number, max: number): number => Math.max(EDGE_MARGIN_PX, Math.min(v, max))
  if (right) {
    const fitsRight = anchor.right + 8 + width <= window.innerWidth - EDGE_MARGIN_PX
    const left = fitsRight ? anchor.right + 8 : anchor.left - 8 - width
    return { left: clamp(left, maxLeft), top: clamp(anchor.top, maxTop) }
  }
  const spaceAbove = anchor.top - ANCHOR_GAP_PX - EDGE_MARGIN_PX
  const spaceBelow = window.innerHeight - anchor.bottom - ANCHOR_GAP_PX - EDGE_MARGIN_PX
  // Above by default; below when it doesn't fit above but does below (or there's more room).
  const above = height <= spaceAbove || (height > spaceBelow && spaceAbove >= spaceBelow)
  const top = above ? anchor.top - ANCHOR_GAP_PX - height : anchor.bottom + ANCHOR_GAP_PX
  const left = anchor.left + anchor.width / 2 - width / 2
  return { left: clamp(left, maxLeft), top: clamp(top, maxTop) }
}

/**
 * A single delegated tooltip for every `data-tooltip`-bearing element app-wide, replacing
 * reliance on the native `title` attribute. Chromium's own tooltip controller has a real,
 * reproducible bug: once its tooltip is dismissed by moving the mouse away, re-hovering the
 * SAME element shortly after often fails to re-show it at all -- a native quirk this app's own
 * markup can't fix, reported live against this exact app (TabBar's New Patch button, every SD
 * file manager icon button).
 *
 * Rendered as a plain `position: fixed` element, not a React portal -- nothing in this app's
 * CSS establishes a fixed-position containing block via transform/filter/perspective on any
 * ancestor (verified before writing this), so a fixed-position child escapes ALL ancestor
 * clipping on its own, including the scrollable containers (`.tab-bar`'s `overflow-x: auto`,
 * `.sd-panel`'s `overflow: hidden`) that an in-place/absolutely-positioned CSS tooltip would
 * otherwise get clipped by.
 */
function GlobalTooltip(): React.JSX.Element | null {
  const [state, setState] = useState<TooltipState | null>(null)
  const timerRef = useRef<number | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Rendered hidden first, then placed once its real size is known.
  useLayoutEffect(() => {
    if (!state || !tooltipRef.current) {
      setPos(null)
      return
    }
    const { width, height } = tooltipRef.current.getBoundingClientRect()
    setPos(placeTooltip(state.anchor, state.right, width, height))
  }, [state])

  useEffect(() => {
    const clearTimer = (): void => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    const handleOver = (e: MouseEvent): void => {
      const target = (e.target as HTMLElement)?.closest?.('[data-tooltip]') as HTMLElement | null
      if (!target) return
      const text = target.getAttribute('data-tooltip')
      if (!text) return
      clearTimer()
      timerRef.current = window.setTimeout(() => {
        // The anchor can be detached by an async re-render (e.g. PatchCanvas's own remount-on-
        // mutation) with no mouse event ever firing -- a stale target here would otherwise
        // measure as a zero-rect and pin a phantom tooltip at the top-left.
        if (!target.isConnected) return
        setState({
          text,
          anchor: target.getBoundingClientRect(),
          right: target.getAttribute('data-tooltip-side') === 'right'
        })
      }, SHOW_DELAY_MS)
    }

    const handleOut = (e: MouseEvent): void => {
      const target = (e.target as HTMLElement)?.closest?.('[data-tooltip]')
      if (!target) return
      const related = e.relatedTarget as Node | null
      if (related && target.contains(related)) return
      clearTimer()
      setState(null)
    }

    // A click can remove or replace the hovered element synchronously (a modal's own close
    // button, a toggle button swapping icons) with the pointer never actually moving off it --
    // no mouseout is ever dispatched in that case, leaving a stale tooltip stuck on screen.
    // Capture phase so this runs before the click's own handler (e.g. before a modal unmounts).
    const handleDown = (): void => {
      clearTimer()
      setState(null)
    }

    // Capture-phase + bubbling mouseover/mouseout (unlike mouseenter/mouseleave, these bubble,
    // which is what makes one delegated pair of listeners here work for every button app-wide).
    document.addEventListener('mouseover', handleOver)
    document.addEventListener('mouseout', handleOut)
    document.addEventListener('mousedown', handleDown, true)
    return () => {
      document.removeEventListener('mouseover', handleOver)
      document.removeEventListener('mouseout', handleOut)
      document.removeEventListener('mousedown', handleDown, true)
      clearTimer()
    }
  }, [])

  if (!state) return null

  const className =
    'global-tooltip' +
    (state.right ? ' global-tooltip--side' : '') +
    (state.text.includes('\n') ? ' global-tooltip--multiline' : '')
  return (
    <div
      ref={tooltipRef}
      className={className}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {state.text}
    </div>
  )
}

export default GlobalTooltip

/**
 * Keeps a `position: fixed` popup (context menu, object search overlay) fully on-screen.
 * Callers don't know their own rendered size before layout, so this takes the desired
 * top-left plus a measured width/height and slides the origin back inside the viewport --
 * never off the top/left edge, and never past the bottom/right edge when the popup fits.
 */
export function clampToViewport(
  x: number,
  y: number,
  width: number,
  height: number,
  margin = 8
): { x: number; y: number } {
  const maxX = window.innerWidth - width - margin
  const maxY = window.innerHeight - height - margin
  return {
    x: Math.max(margin, Math.min(x, maxX)),
    y: Math.max(margin, Math.min(y, maxY))
  }
}

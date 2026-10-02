import { describe, expect, it } from 'vitest'
import { estimateNodeSize, findFreeSpot } from '../src/renderer/src/canvas/freeSpot'
import { GRID_SIZE } from '../src/renderer/src/state/patchStore'

const view = { x: 1000, y: 2000, width: 800, height: 600 }
const size = { width: 150, height: 100 }

function inside(p: { x: number; y: number }): boolean {
  return (
    p.x >= view.x &&
    p.y >= view.y &&
    p.x + size.width <= view.x + view.width &&
    p.y + size.height <= view.y + view.height
  )
}

describe('findFreeSpot', () => {
  it('centers the node in an empty view, snapped to the grid', () => {
    const p = findFreeSpot(view, [], size)
    expect(inside(p)).toBe(true)
    expect(p.x % GRID_SIZE).toBe(0)
    expect(p.y % GRID_SIZE).toBe(0)
    expect(Math.abs(p.x + size.width / 2 - (view.x + view.width / 2))).toBeLessThanOrEqual(
      GRID_SIZE
    )
    expect(Math.abs(p.y + size.height / 2 - (view.y + view.height / 2))).toBeLessThanOrEqual(
      GRID_SIZE
    )
  })

  it('stays inside the view and clear of a node occupying the center', () => {
    const blocker = { x: 1250, y: 2150, width: 300, height: 300 }
    const p = findFreeSpot(view, [blocker], size)
    expect(inside(p)).toBe(true)
    const clear =
      p.x + size.width <= blocker.x ||
      blocker.x + blocker.width <= p.x ||
      p.y + size.height <= blocker.y ||
      blocker.y + blocker.height <= p.y
    expect(clear).toBe(true)
  })

  it('ignores nodes outside the view entirely', () => {
    const offscreen = { x: 0, y: 0, width: 500, height: 500 }
    expect(findFreeSpot(view, [offscreen], size)).toEqual(findFreeSpot(view, [], size))
  })

  it('still returns a visible spot when the view is fully occupied', () => {
    const p = findFreeSpot(view, [{ ...view }], size)
    expect(inside(p)).toBe(true)
  })
})

describe('findFreeSpot in a crowded view', () => {
  it('spreads repeated inserts out instead of stacking them on one point', () => {
    const occupied: { x: number; y: number; width: number; height: number }[] = []
    const big = { width: 300, height: 400 }
    for (let i = 0; i < 6; i++) occupied.push({ ...findFreeSpot(view, occupied, big), ...big })
    const spots = new Set(occupied.map((o) => `${o.x},${o.y}`))
    expect(spots.size).toBe(occupied.length)
  })
})

describe('estimateNodeSize', () => {
  it('grows with a primitive’s params and ports', () => {
    const sine = estimateNodeSize('logue/osc/sine')
    const comb = estimateNodeSize('logue/filter/comb')
    expect(comb.height).toBeGreaterThan(sine.height)
  })
})

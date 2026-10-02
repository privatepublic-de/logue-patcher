import type { ObjNode, PatchDocument, PatchNode } from '@shared/domain/patch'
import { LOGUE_AUDIO_IN_TYPE, LOGUE_AUDIO_OUT_TYPE } from '@logue-codegen/oscInstances'
import { LOGUE_SUBPATCH_INLET_TYPE, LOGUE_SUBPATCH_OUTLET_TYPE } from '@logue-codegen/subpatches'
import { nodeId } from '../state/nodeId'
import { autoArrangeNodes, comparePosition, estimateNodeSize, type Size } from './autoArrange'
import { resolvePorts } from './ports'

/**
 * Lays a patch out by its signal flow (a layered, Sugiyama-style layout), the way a patch is
 * tidied by hand: sources on the left, the output on the right, each node one column before
 * its first reader, and each input's chain in its own band.
 *
 * - Feedback wires are found by a depth-first walk from the sources, following outlets in
 *   port order: a wire back to a node still on the walk is feedback and may run right to left.
 *   Cutting a `delayedInlets` wire instead would be wrong: `util/buffer`'s `in` is delayed but is
 *   the main forward path, and its source would land after the whole graph.
 * - Columns are "as late as possible" (a control chain ends right before what it drives), with
 *   the outputs (`audio-out`, a definition's outlet ports) in the last column. A node that feeds
 *   nothing sits right after its last input.
 * - A definition's inlet/outlet port nodes keep their top-to-bottom order: it is the order of
 *   every instance's ports (`subpatchPortNodes`).
 * - Heights are a tree layout of a walk back from the outputs through each node's inlets in port
 *   order: what feeds an earlier inlet gets the band above, and bands don't overlap, so each
 *   chain keeps its own strip (grain-mill: buffer, clock, motion, voices, envelope, top to
 *   bottom). A node lines up with its nearest input, so a chain (8 voices on a bus) is one row.
 *   Two earlier versions (2026-10-01) ordered each column by that walk and then either reduced
 *   crossings (saved 19 of grain-mill's 116, nearly all among the voice fan-outs) or pulled nodes
 *   toward their wires: both let independent chains drift into each other's columns. Long and
 *   fan-out wires take no space: they pass behind nodes.
 * - Comments keep their offset from the node they were nearest to, nudged into the nearest free
 *   space (placed after the nodes are spread, so they don't push nodes aside); unwired nodes go
 *   in a row underneath.
 *
 * The result is finished with `autoArrangeNodes` on the same sizes it loads with, so opening the
 * saved file doesn't move anything again.
 */

const COLUMN_GAP = 80
const BAND_GAP = 40
const UNWIRED_ROW_GAP = 100
/** `autoArrange.ts`' margins: a comment placed this far from everything isn't moved on load. */
const MARGIN_X = 40
const MARGIN_Y = 30
const COMMENT_SEARCH = 400
const COLUMN_SNAP = 50

interface LayoutNode {
  id: string
  index: number
  node: ObjNode
  size: Size
  inlets: string[]
  outlets: string[]
}

interface Edge {
  from: string
  outlet: number
  to: string
  inlet: number
}

function isOutputNode(node: ObjNode): boolean {
  return node.type === LOGUE_AUDIO_OUT_TYPE || node.type === LOGUE_SUBPATCH_OUTLET_TYPE
}

function isInputPort(node: ObjNode): boolean {
  return node.type === LOGUE_SUBPATCH_INLET_TYPE
}

function isPinnedPort(node: ObjNode): boolean {
  return isInputPort(node) || node.type === LOGUE_SUBPATCH_OUTLET_TYPE
}

/** Where the walk that finds feedback starts: the signal's own way in. Starting at a modulator
 *  instead (grain-mill's clock) reaches the loop sideways and cuts it in the wrong place. */
function isSignalInput(node: ObjNode): boolean {
  return node.type === LOGUE_AUDIO_IN_TYPE || isInputPort(node)
}

export function layoutByFlow(doc: PatchDocument, measuredSizes?: Map<string, Size>): PatchNode[] {
  const module = doc.settings.logueTarget?.module ?? 'osc'
  const sizes = new Map<string, Size>()
  const nodes = new Map<string, LayoutNode>()
  doc.nodes.forEach((node, index) => {
    const id = nodeId(node, index)
    const estimate = estimateNodeSize(node, id, doc.nets)
    const measured = measuredSizes?.get(id)
    // The load-time pass spaces by its own estimate, so never space by less than that.
    const size = {
      width: Math.max(estimate.width, measured?.width ?? 0),
      height: Math.max(estimate.height, measured?.height ?? 0)
    }
    sizes.set(id, size)
    if (node.kind !== 'obj') return
    const ports = resolvePorts(node, id, doc.nets, module)
    nodes.set(id, {
      id,
      index,
      node,
      size,
      inlets: ports.inlets.map((p) => p.name),
      outlets: ports.outlets.map((p) => p.name)
    })
  })

  const edges: Edge[] = []
  for (const net of doc.nets) {
    for (const source of net.sources) {
      const from = nodes.get(source.obj)
      if (!from) continue
      for (const dest of net.dests) {
        const to = nodes.get(dest.obj)
        if (!to || to === from) continue
        edges.push({
          from: from.id,
          outlet: Math.max(0, from.outlets.indexOf(source.outlet ?? from.outlets[0])),
          to: to.id,
          inlet: Math.max(0, to.inlets.indexOf(dest.inlet ?? to.inlets[0]))
        })
      }
    }
  }

  const byPosition = (a: LayoutNode, b: LayoutNode): number => comparePosition(a.node, b.node)
  // A port node always takes its column, wired or not: in the bottom row it would move to the end
  // of every instance's port list.
  const wired = [...nodes.values()].filter(
    (n) => isPinnedPort(n.node) || edges.some((e) => e.from === n.id || e.to === n.id)
  )
  const unwired = [...nodes.values()].filter((n) => !wired.includes(n)).sort(byPosition)

  const forward = forwardEdges(wired, edges, byPosition)
  const column = assignColumns(wired, forward)
  const xOf = columnPositions(wired, column)
  const yOf = placeRows(wired, forward, column, byPosition)

  const placed = new Map<string, { x: number; y: number }>()
  for (const n of wired) placed.set(n.id, { x: xOf[column.get(n.id)!], y: yOf.get(n.id)! })
  placeUnwired(unwired, placed, nodes)

  // Spread before the comments go in, so a comment never pushes a column or row aside.
  const objects = doc.nodes.flatMap((node, index) => {
    const pos = placed.get(nodeId(node, index))
    return pos && node.kind === 'obj'
      ? [{ ...node, x: Math.round(pos.x), y: Math.round(pos.y) }]
      : []
  })
  const spread = new Map(
    autoArrangeNodes({ ...doc, nodes: objects }, sizes).map((n) => [n.name, n])
  )
  const result = doc.nodes.map((node) =>
    node.kind === 'obj' && node.name !== undefined ? (spread.get(node.name) ?? node) : node
  )
  placeComments(doc.nodes, result, sizes)

  return autoArrangeNodes({ ...doc, nodes: result }, sizes)
}

/** The wires that run left to right: all but the ones closing a loop (see the module doc). */
function forwardEdges(
  wired: LayoutNode[],
  edges: Edge[],
  byPosition: (a: LayoutNode, b: LayoutNode) => number
): Edge[] {
  const outgoing = new Map<string, Edge[]>()
  for (const e of edges) outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e])
  const hasInput = new Set(edges.map((e) => e.to))
  const roots = [
    ...wired.filter((n) => isSignalInput(n.node)).sort(byPosition),
    ...wired.filter((n) => !isSignalInput(n.node) && !hasInput.has(n.id)).sort(byPosition),
    // Nodes only reachable inside a loop with no source in front of it.
    ...[...wired].sort(byPosition)
  ]
  const nodeById = new Map(wired.map((n) => [n.id, n]))
  const state = new Map<string, 'active' | 'done'>()
  const back = new Set<Edge>()
  const visit = (id: string): void => {
    state.set(id, 'active')
    const out = [...(outgoing.get(id) ?? [])].sort(
      (a, b) =>
        a.outlet - b.outlet ||
        a.inlet - b.inlet ||
        byPosition(nodeById.get(a.to)!, nodeById.get(b.to)!)
    )
    for (const e of out) {
      const s = state.get(e.to)
      if (s === 'active') back.add(e)
      else if (s === undefined) visit(e.to)
    }
    state.set(id, 'done')
  }
  for (const root of roots) if (!state.has(root.id)) visit(root.id)
  return edges.filter((e) => !back.has(e))
}

function assignColumns(wired: LayoutNode[], forward: Edge[]): Map<string, number> {
  const preds = new Map<string, string[]>()
  const succs = new Map<string, string[]>()
  for (const e of forward) {
    preds.set(e.to, [...(preds.get(e.to) ?? []), e.from])
    succs.set(e.from, [...(succs.get(e.from) ?? []), e.to])
  }
  const order = topologicalOrder(wired, preds, succs)

  const earliest = new Map<string, number>()
  for (const id of order) {
    const node = wired.find((n) => n.id === id)!
    earliest.set(
      id,
      isInputPort(node.node)
        ? 0
        : Math.max(-1, ...(preds.get(id) ?? []).map((p) => earliest.get(p)!)) + 1
    )
  }
  const last = Math.max(0, ...earliest.values())

  const column = new Map<string, number>()
  for (const id of [...order].reverse()) {
    const node = wired.find((n) => n.id === id)!
    const readers = succs.get(id) ?? []
    if (isInputPort(node.node)) column.set(id, 0)
    else if (isOutputNode(node.node)) column.set(id, last)
    else if (readers.length === 0) column.set(id, earliest.get(id)!)
    else column.set(id, Math.min(...readers.map((r) => column.get(r)!)) - 1)
  }
  // An output placed in the last column can leave its feeder far to the left; an input port at 0
  // can sit after a reader moved left by its other inputs. Keep every forward wire rightwards.
  for (const id of order) {
    const node = wired.find((n) => n.id === id)!
    if (isInputPort(node.node)) continue
    const after = Math.max(-1, ...(preds.get(id) ?? []).map((p) => column.get(p)!)) + 1
    if (column.get(id)! < after) column.set(id, after)
  }
  return column
}

function topologicalOrder(
  wired: LayoutNode[],
  preds: Map<string, string[]>,
  succs: Map<string, string[]>
): string[] {
  const remaining = new Map(wired.map((n) => [n.id, (preds.get(n.id) ?? []).length]))
  const ready = wired.filter((n) => remaining.get(n.id) === 0).map((n) => n.id)
  const order: string[] = []
  while (ready.length > 0) {
    const id = ready.shift()!
    order.push(id)
    for (const s of succs.get(id) ?? []) {
      remaining.set(s, remaining.get(s)! - 1)
      if (remaining.get(s) === 0) ready.push(s)
    }
  }
  return order
}

/** Each column's x: as wide as its widest node, a gap apart. */
function columnPositions(wired: LayoutNode[], column: Map<string, number>): number[] {
  const widths: number[] = []
  for (const n of wired) {
    const c = column.get(n.id)!
    widths[c] = Math.max(widths[c] ?? 0, n.size.width)
  }
  const xs: number[] = []
  let x = 0
  for (let c = 0; c < widths.length; c++) {
    xs.push(x)
    if (widths[c]) x += widths[c] + COLUMN_GAP
  }
  return xs
}

/**
 * Heights, as a tree layout of the walk back from the outputs (see the module doc): a node's
 * not-yet-placed inputs are its children, each with its band (the subtree it leads), stacked in
 * inlet order. A band is a rigid block slid up until it meets the band above in some column both
 * use, so a short band tucks in beside a tall one but never drifts into its columns. The node
 * lines up (top edges) with the child it's nearest to (fewest columns apart, then the earlier
 * inlet); its inputs all sit in columns left of it, so its own column is free. Lining up the ports
 * instead made a chain whose outlet sits higher than the next inlet (grain-mill's voices, `l`
 * into `bus-l`) climb a step per node.
 */
function placeRows(
  wired: LayoutNode[],
  forward: Edge[],
  column: Map<string, number>,
  byPosition: (a: LayoutNode, b: LayoutNode) => number
): Map<string, number> {
  const inputs = new Map<string, Edge[]>()
  const hasReader = new Set<string>()
  for (const e of forward) {
    inputs.set(e.to, [...(inputs.get(e.to) ?? []), e])
    hasReader.add(e.from)
  }
  const nodeById = new Map(wired.map((n) => [n.id, n]))
  const claimed = new Set<string>()

  const stack = (bands: Band[]): Band => {
    const merged: Band = { y: new Map(), contour: new Map() }
    let previousTop = -Infinity
    for (const band of bands) {
      let offset = -Infinity
      for (const [c, span] of band.contour) {
        const above = merged.contour.get(c)
        if (above) offset = Math.max(offset, above.bottom + BAND_GAP - span.top)
      }
      // Never above the band before it: the order of the inlets stays the order on screen.
      const top = Math.min(...[...band.contour.values()].map((s) => s.top))
      offset = Math.max(offset, previousTop - top, merged.y.size === 0 ? -top : -Infinity)
      for (const [id, value] of band.y) merged.y.set(id, value + offset)
      for (const [c, span] of band.contour) {
        const at = merged.contour.get(c)
        const moved = { top: span.top + offset, bottom: span.bottom + offset }
        merged.contour.set(
          c,
          at
            ? { top: Math.min(at.top, moved.top), bottom: Math.max(at.bottom, moved.bottom) }
            : moved
        )
      }
      previousTop = top + offset
    }
    return merged
  }

  const place = (id: string): Band => {
    const ins = [...(inputs.get(id) ?? [])].sort((a, b) => a.inlet - b.inlet || a.outlet - b.outlet)
    const children: Edge[] = []
    for (const e of ins) {
      if (claimed.has(e.from)) continue
      claimed.add(e.from)
      children.push(e)
    }
    const band = stack(children.map((e) => place(e.from)))
    const span = (e: Edge): number => column.get(id)! - column.get(e.from)!
    const nearest = [...children].sort((a, b) => span(a) - span(b))[0]
    const at = nearest ? band.y.get(nearest.from)! : 0
    band.y.set(id, at)
    band.contour.set(column.get(id)!, { top: at, bottom: at + nodeById.get(id)!.size.height })
    return band
  }

  const roots: Band[] = []
  for (const root of [
    ...wired.filter((n) => isOutputNode(n.node)).sort(byPosition),
    ...wired.filter((n) => !hasReader.has(n.id)).sort(byPosition),
    ...[...wired].sort(byPosition)
  ]) {
    if (claimed.has(root.id)) continue
    claimed.add(root.id)
    roots.push(place(root.id))
  }
  const y = stack(roots).y

  // A definition's port nodes share their column; give them its heights in port order.
  const portOrder = wired.filter((n) => isPinnedPort(n.node)).sort(byPosition)
  for (const c of new Set(portOrder.map((n) => column.get(n.id)!))) {
    const ports = portOrder.filter((n) => column.get(n.id) === c)
    const heights = ports.map((n) => y.get(n.id)!).sort((a, b) => a - b)
    ports.forEach((n, i) => y.set(n.id, heights[i]))
  }
  const top = Math.min(...y.values())
  for (const [id, value] of y) y.set(id, value - top)
  return y
}

/** Where a subtree's nodes sit, and the height range it takes in each column it uses. */
interface Band {
  y: Map<string, number>
  contour: Map<number, { top: number; bottom: number }>
}

function placeUnwired(
  unwired: LayoutNode[],
  placed: Map<string, { x: number; y: number }>,
  nodes: Map<string, LayoutNode>
): void {
  let bottom = 0
  for (const [id, pos] of placed) bottom = Math.max(bottom, pos.y + nodes.get(id)!.size.height)
  let x = 0
  const y = placed.size > 0 ? bottom + UNWIRED_ROW_GAP : 0
  for (const n of unwired) {
    placed.set(n.id, { x, y })
    x += n.size.width + COLUMN_GAP
  }
}

/** A comment moves with the node it was nearest to (box to box), keeping its offset. */
function placeComments(before: PatchNode[], after: PatchNode[], sizes: Map<string, Size>): void {
  const objIndexes = before.flatMap((n, i) => (n.kind === 'obj' ? [i] : []))
  before.forEach((comment, ci) => {
    if (comment.kind !== 'comment' || objIndexes.length === 0) return
    const csize = sizes.get(nodeId(comment, ci))!
    let nearest = objIndexes[0]
    let nearestDistance = Infinity
    for (const i of objIndexes) {
      const n = before[i]
      const size = sizes.get(nodeId(n, i))!
      const dx = Math.max(0, n.x - (comment.x + csize.width), comment.x - (n.x + size.width))
      const dy = Math.max(0, n.y - (comment.y + csize.height), comment.y - (n.y + size.height))
      const distance = Math.hypot(dx, dy)
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearest = i
      }
    }
    const anchorBefore = before[nearest]
    const anchorAfter = after[nearest]
    const x = Math.round(anchorAfter.x + comment.x - anchorBefore.x)
    const y = Math.round(anchorAfter.y + comment.y - anchorBefore.y)
    const boxes = after.flatMap((n, i) =>
      i === ci || (n.kind === 'comment' && i > ci) ? [] : [{ n, size: sizes.get(nodeId(n, i))! }]
    )
    // autoArrange.ts snaps x values within 50 px of each other into one column (to its smallest
    // x), so a comment just left of a column would drag that column along.
    const free = (cx: number, cy: number): boolean =>
      boxes.every(({ n }) => n.x === cx || Math.abs(n.x - cx) > COLUMN_SNAP) &&
      boxes.every(
        ({ n, size }) =>
          cx + csize.width + MARGIN_X <= n.x ||
          n.x + size.width + MARGIN_X <= cx ||
          cy + csize.height + MARGIN_Y <= n.y ||
          n.y + size.height + MARGIN_Y <= cy
      )
    // The nearest free spot; failing that the final spread pass makes room.
    const candidates: { dx: number; dy: number }[] = []
    for (let dx = -COMMENT_SEARCH; dx <= COMMENT_SEARCH; dx += 10)
      for (let dy = -COMMENT_SEARCH; dy <= COMMENT_SEARCH; dy += 10) candidates.push({ dx, dy })
    candidates.sort((a, b) => Math.hypot(a.dx, a.dy) - Math.hypot(b.dx, b.dy))
    const spot = candidates.find(({ dx, dy }) => free(x + dx, y + dy)) ?? { dx: 0, dy: 0 }
    after[ci] = { ...comment, x: x + spot.dx, y: y + spot.dy }
  })
}

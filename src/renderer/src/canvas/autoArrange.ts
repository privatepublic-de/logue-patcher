import type { PatchDocument, PatchNode } from '@shared/domain/patch'
import { nodeId } from '../state/nodeId'
import { resolvePorts, type ResolvedPorts } from './ports'
import { headerTypeLabel, isCompactPrimitive } from './compactNode'

/** Ascending y, then ascending x as a tiebreaker -- this module's own sweep-ordering key, not read by anything else post-Axoloti-removal. */
export function comparePosition(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return a.y - b.y || a.x - b.x
}

/**
 * Spreads out overlapping nodes (legacy Axoloti coordinates were laid out for much smaller nodes
 * than this app renders) while keeping the layout's shape -- neither a topological layout nor a
 * grid repack.
 *
 * Each axis gets a monotone remap of its distinct coordinate values (ties stay tied), so every
 * node's (y, x) rank (`comparePosition`) survives by construction and `verifyOrderPreserved` only
 * double-checks it. No codegen reads node order any more; the guarantee is kept because it's free.
 * Each level moves by `max(originalGap, gapNeededForARealCollision)`, so gaps that were already
 * big enough stay put and running it twice is a no-op. The x-sweep runs first; the y-sweep
 * separates what it couldn't (e.g. a vertical stack sharing one x level).
 *
 * Before the sweeps, `separateCoincidentPositions` nudges exactly-coincident nodes apart by
 * sub-pixel offsets (rounded away) so the y-sweep sees distinct levels, and `clusterColumns`
 * snaps each visual column to one shared x (single-link clustering on x, since hand-dragged
 * columns scatter by 10-60px). Without that, an x push moved some column members and left others
 * behind, tearing a vertical signal chain apart; snapped column-mates are separated by the
 * y-sweep instead.
 */

const MIN_NODE_WIDTH = 140
const HEADER_PADDING_X = 16
const HEADER_PADDING_Y = 12
const TITLE_LINE_HEIGHT = 15
const PORTS_PADDING_Y = 8
const PORT_ROW_HEIGHT = 12
const PORT_ROW_GAP = 2
const PORT_COL_GAP = 12
const PORT_COL_PADDING = 20
const PARAMS_PADDING_Y = 8
const PARAM_ROW_HEIGHT = 13
const PARAMS_PADDING_X = 16
const BORDERS = 3
const CHAR_WIDTH_BOLD_12 = 7
const CHAR_WIDTH_SMALL_10 = 6
const COMPACT_PADDING_X = 24
const TITLE_GAP = 6

const COMMENT_MAX_WIDTH = 220
const COMMENT_PADDING_X = 20
const COMMENT_PADDING_Y = 12
const COMMENT_LINE_HEIGHT = 15
const COMMENT_CHAR_WIDTH_12 = 7

const HORIZONTAL_MARGIN = 40
const VERTICAL_MARGIN = 30
/** Sub-pixel; only needs to give exactly-coincident nodes distinct sweep levels, never to be visible after Math.round. */
const COINCIDENT_NUDGE = 1e-4

export interface Size {
  width: number
  height: number
}

function estimateCommentSize(text: string): Size {
  const contentWidth = Math.min(
    COMMENT_MAX_WIDTH - COMMENT_PADDING_X,
    Math.max(40, text.length * COMMENT_CHAR_WIDTH_12)
  )
  const charsPerLine = Math.max(1, Math.floor(contentWidth / COMMENT_CHAR_WIDTH_12))
  const lineCount = text
    .split('\n')
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)), 0)
  return {
    width: contentWidth + COMMENT_PADDING_X,
    height: lineCount * COMMENT_LINE_HEIGHT + COMMENT_PADDING_Y
  }
}

/** Mirrors ObjectNode.tsx's rendering closely enough for spacing purposes -- an approximation of real DOM layout (not a measurement), since this runs on domain data with no DOM access. */
function estimateObjectSize(node: PatchNode, ports: ResolvedPorts): Size {
  // The type shares the name's row and only takes the space left over, so the name alone sets
  // the header's width and height.
  const title = node.name ?? ''
  const params = node.kind === 'obj' ? node.params : []

  if (node.kind === 'obj' && isCompactPrimitive(node.type) && params.length === 0) {
    return {
      width:
        title.length * CHAR_WIDTH_BOLD_12 +
        TITLE_GAP +
        headerTypeLabel(node.type).length * CHAR_WIDTH_SMALL_10 +
        COMPACT_PADDING_X +
        BORDERS,
      height: HEADER_PADDING_Y - 4 + TITLE_LINE_HEIGHT + BORDERS + (ports.inlets.length > 1 ? 8 : 0)
    }
  }

  const titleWidth = title.length * CHAR_WIDTH_BOLD_12 + HEADER_PADDING_X
  const inletColWidth =
    Math.max(0, ...ports.inlets.map((p) => p.name.length * CHAR_WIDTH_SMALL_10)) + PORT_COL_PADDING
  const outletColWidth =
    Math.max(0, ...ports.outlets.map((p) => p.name.length * CHAR_WIDTH_SMALL_10)) + PORT_COL_PADDING
  const portsWidth =
    ports.inlets.length + ports.outlets.length > 0
      ? inletColWidth + outletColWidth + PORT_COL_GAP
      : 0
  const paramWidth =
    Math.max(
      0,
      ...params.map((p) => (p.name.length + String(p.value).length + 1) * CHAR_WIDTH_SMALL_10)
    ) + PARAMS_PADDING_X

  const width = Math.max(MIN_NODE_WIDTH, titleWidth, portsWidth, paramWidth)

  const headerHeight = HEADER_PADDING_Y + TITLE_LINE_HEIGHT
  const portRows = Math.max(ports.inlets.length, ports.outlets.length)
  const portsHeight =
    portRows > 0
      ? PORTS_PADDING_Y + portRows * PORT_ROW_HEIGHT + (portRows - 1) * PORT_ROW_GAP
      : PORTS_PADDING_Y
  const paramsHeight = params.length > 0 ? PARAMS_PADDING_Y + params.length * PARAM_ROW_HEIGHT : 0

  return { width, height: headerHeight + portsHeight + paramsHeight + BORDERS }
}

export function estimateNodeSize(node: PatchNode, id: string, nets: PatchDocument['nets']): Size {
  if (node.kind === 'comment') return estimateCommentSize(node.text)
  return estimateObjectSize(node, resolvePorts(node, id, nets))
}

/**
 * Recomputes x/y for every node in `doc` (one level -- callers apply this per currently-
 * navigated document, matching how position order is itself scoped per-document for
 * subpatches). Spreads nodes apart to fit their real rendered footprint while leaving
 * each node's rank in the (y, x) position-sort exactly as it was -- see module doc comment.
 *
 * `measuredSizes`, when given, is React Flow's own DOM-measured footprint per node id
 * (nodeMeasurements.ts) -- preferred over `estimateNodeSize`'s text-length approximation
 * whenever a real measurement exists, since the estimate is (by its own doc comment) only
 * ever an approximation of ObjectNode.tsx's actual CSS layout and can undershoot the real
 * box (long param values, wide port names, font metrics the estimate doesn't model
 * precisely) -- an undershoot silently eats into HORIZONTAL_MARGIN/VERTICAL_MARGIN and
 * produces real, on-screen overlap despite `verifyOrderPreserved` passing (that guard only
 * protects codegen ordering, not visual spacing). A node with no measurement yet (never
 * rendered, e.g. this doc hasn't been opened as a tab) still falls back to the estimate.
 */
interface Item {
  id: string
  size: Size
  x: number
  y: number
}

/** Exactly-coincident nodes share both axes' sweep level, so neither sweep alone can separate them. Nudges each duplicate after the first in a run (`rankOrderedItems` must already be sorted by `comparePosition`, so a run of exact ties is contiguous and in original array order) by an increasing sub-pixel offset -- just enough to give the y-sweep a distinct level to work with. */
function separateCoincidentPositions(rankOrderedItems: Item[]): void {
  let runStart = 0
  for (let i = 1; i <= rankOrderedItems.length; i++) {
    const samePosition =
      i < rankOrderedItems.length &&
      rankOrderedItems[i].x === rankOrderedItems[runStart].x &&
      rankOrderedItems[i].y === rankOrderedItems[runStart].y
    if (!samePosition) {
      for (let k = runStart + 1; k < i; k++) {
        rankOrderedItems[k].y += (k - runStart) * COINCIDENT_NUDGE
      }
      runStart = i
    }
  }
}

/**
 * Smaller than the smallest realistic post-arrange column gap (`MIN_NODE_WIDTH +
 * HORIZONTAL_MARGIN` = 180, or a tiny comment's own floor of ~60+40=100) -- so a fresh
 * pass never re-merges two columns the previous pass just separated, keeping the
 * "running this twice is a no-op" property from the module doc.
 */
const COLUMN_CLUSTER_TOLERANCE = 50

/**
 * Single-link clusters items into visual columns by original x, scanned ascending: a gap
 * to the previous item larger than `COLUMN_CLUSTER_TOLERANCE` always starts a new column.
 * A candidate is also refused (forced into a new column) if it shares an EXACT y with a
 * node already in the run -- two nodes tied on y rely on x as `comparePosition`'s
 * tiebreaker, so folding them onto one shared x would make their relative order unstable
 * (`verifyOrderPreserved` would throw). Returns each item's column's representative x --
 * the column's minimum original x, which is why the caller must run this on x-ascending-
 * sorted input: cluster boundaries then only ever increase, keeping column order monotone
 * with the original x order for free.
 *
 * Deliberately single-link (chain), not bounded to a fixed span from the cluster's first
 * member: a real trio's own x can already scatter by 60-80px (e.g. resonator.axp's
 * `dial_2`/`resobp_2`/`*_2` span 61px), which a tight from-representative bound would
 * split apart again -- chaining through small hops is what actually captures it. The
 * accepted tradeoff: an unrelated node that happens to sit within tolerance of a real
 * column's edge (e.g. that same patch's standalone `pitch` control knob, 18px from
 * `dial_2`) rides along when that column moves. Harmless -- it only affects how far a
 * node moves together with its nearest neighbors, never order or overlap -- and avoiding
 * it in general would need dataflow-graph awareness this function deliberately doesn't
 * have (see the module doc's "cluster existing columns, don't re-derive from nets" scope).
 */
function clusterColumns(items: Item[]): Map<Item, number> {
  const byX = [...items].sort((a, b) => a.x - b.x)
  const columnOf = new Map<Item, number>()
  let columnStart = 0
  const closeColumn = (end: number): void => {
    const repX = byX[columnStart].x
    for (let k = columnStart; k < end; k++) columnOf.set(byX[k], repX)
  }
  for (let i = 1; i < byX.length; i++) {
    const gapOk = byX[i].x - byX[i - 1].x <= COLUMN_CLUSTER_TOLERANCE
    const sameRowConflict = byX.slice(columnStart, i).some((member) => member.y === byX[i].y)
    if (!gapOk || sameRowConflict) {
      closeColumn(i)
      columnStart = i
    }
  }
  closeColumn(byX.length)
  return columnOf
}

function xGapOk(a: Item, b: Item): boolean {
  const [left, right] = a.x <= b.x ? [a, b] : [b, a]
  return right.x - left.x >= left.size.width + HORIZONTAL_MARGIN
}

function yGapOk(a: Item, b: Item): boolean {
  const [top, bottom] = a.y <= b.y ? [a, b] : [b, a]
  return bottom.y - top.y >= top.size.height + VERTICAL_MARGIN
}

/** A pair only needs a sweep to actually move anything if, left alone, their boxes (plus margin) would truly collide on BOTH axes -- a pair separated on either axis already never overlaps, since a sweep only ever grows a gap (see below), never shrinks one. */
function needsFix(a: Item, b: Item): boolean {
  return !xGapOk(a, b) && !yGapOk(a, b)
}

/**
 * Monotone per-axis remap: groups items by their distinct old coordinate ("level"),
 * then assigns each level a new coordinate via a forward sweep, `max(gap to previous
 * level's new value using the ORIGINAL gap, gap required by any pair needing separation
 * whose lower item sits at an earlier level)`. Old order (and old ties) survive by
 * construction; a level with no under-sized gap keeps its exact original coordinate
 * (relative to the first level, which is anchored -- never reset to 0).
 */
function sweepAxis(
  items: Item[],
  getCoord: (item: Item) => number,
  setCoord: (item: Item, value: number) => void,
  requiredGap: (lowerItem: Item) => number,
  pairsNeedingFix: [Item, Item][]
): void {
  const distinctValues = [...new Set(items.map(getCoord))].sort((a, b) => a - b)
  const levelOfValue = new Map(distinctValues.map((v, i) => [v, i]))
  const levelOfItem = new Map(items.map((item) => [item, levelOfValue.get(getCoord(item))!]))

  const incoming = new Map<number, { fromLevel: number; gap: number }[]>()
  for (const [a, b] of pairsNeedingFix) {
    const levelA = levelOfItem.get(a)!
    const levelB = levelOfItem.get(b)!
    if (levelA === levelB) continue
    const [lowerItem, lowerLevel, higherLevel] =
      levelA < levelB ? ([a, levelA, levelB] as const) : ([b, levelB, levelA] as const)
    const list = incoming.get(higherLevel) ?? []
    list.push({ fromLevel: lowerLevel, gap: requiredGap(lowerItem) })
    incoming.set(higherLevel, list)
  }

  const newValueByLevel: number[] = [distinctValues[0]]
  for (let level = 1; level < distinctValues.length; level++) {
    let value = newValueByLevel[level - 1] + (distinctValues[level] - distinctValues[level - 1])
    for (const constraint of incoming.get(level) ?? []) {
      value = Math.max(value, newValueByLevel[constraint.fromLevel] + constraint.gap)
    }
    newValueByLevel[level] = value
  }

  for (const item of items) setCoord(item, newValueByLevel[levelOfItem.get(item)!])
}

export function autoArrangeNodes(
  doc: PatchDocument,
  measuredSizes?: Map<string, Size>
): PatchNode[] {
  // clusterColumns' closeColumn indexes byX[0] unconditionally at the end of its sweep --
  // real for any non-empty input, but a genuinely empty document (a brand-new patch, or one
  // whose only node just got deleted) has nothing to index and would throw. Real latent bug,
  // not something Axoloti removal introduced -- surfaced by a fixture (hw-test.axp) whose only
  // node was a now-unsupported kind, leaving it with zero nodes after parsing.
  if (doc.nodes.length === 0) return []
  const withMeta = doc.nodes.map((node, index) => {
    const id = nodeId(node, index)
    const size = measuredSizes?.get(id) ?? estimateNodeSize(node, id, doc.nets)
    return { node, index, id, size }
  })

  const ranked = [...withMeta].sort((a, b) => comparePosition(a.node, b.node))
  const items: Item[] = ranked.map((r) => ({ id: r.id, size: r.size, x: r.node.x, y: r.node.y }))
  separateCoincidentPositions(items)

  const columnOf = clusterColumns(items)
  for (const item of items) item.x = columnOf.get(item)!

  const initialPairsNeedingFix: [Item, Item][] = []
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (needsFix(items[i], items[j])) initialPairsNeedingFix.push([items[i], items[j]])
    }
  }

  // Same-column pairs already share an exact x (see clusterColumns) -- letting the x-sweep
  // "fix" them would just re-split a column that's meant to move as one unit, so they skip
  // straight to the y-sweep, the only axis that can legitimately separate two stacked nodes.
  const crossColumnPairs = initialPairsNeedingFix.filter(
    ([a, b]) => columnOf.get(a) !== columnOf.get(b)
  )
  const sameColumnPairs = initialPairsNeedingFix.filter(
    ([a, b]) => columnOf.get(a) === columnOf.get(b)
  )

  sweepAxis(
    items,
    (item) => item.x,
    (item, value) => (item.x = value),
    (lowerItem) => lowerItem.size.width + HORIZONTAL_MARGIN,
    crossColumnPairs
  )

  const stillNeedingFix = crossColumnPairs.filter(([a, b]) => needsFix(a, b))

  sweepAxis(
    items,
    (item) => item.y,
    (item, value) => (item.y = value),
    (lowerItem) => lowerItem.size.height + VERTICAL_MARGIN,
    [...stillNeedingFix, ...sameColumnPairs]
  )

  const positionById = new Map(items.map((item) => [item.id, { x: item.x, y: item.y }]))
  const newNodes = doc.nodes.map((node, index) => {
    const pos = positionById.get(nodeId(node, index))
    return pos ? { ...node, x: Math.round(pos.x), y: Math.round(pos.y) } : node
  })

  verifyOrderPreserved(
    ranked.map((r) => r.id),
    newNodes
  )

  return newNodes
}

/**
 * Applies `autoArrangeNodes` at every level of a full document tree -- the given doc plus
 * every nested `patcher` node's own `subPatch`, recursively. Used on file load (see
 * patchStore.ts's `loadDoc`) to fix node overlap up front: opening a legacy `.axp` places
 * nodes at the ORIGINAL tool's raw coordinates (tuned for its ~60x40px Swing frames), which
 * this app's much larger rendered nodes (CSS `.patch-node` min-width 140px, real port/param
 * rows) overlap badly at -- not just visually, but for real hit-testing (a click meant for
 * one node's edge handle can land on a neighboring node's body instead, since React Flow
 * gives every node's DOM box priority over the edges/canvas behind it). `autoArrangeNodes`
 * is itself a no-op wherever a gap is already big enough (see its own doc comment), so
 * running this unconditionally on every load never disturbs an already-fine layout and is
 * fully deterministic (opening the same file twice yields the identical result both times).
 */
export function autoArrangeDocumentTree(doc: PatchDocument): PatchDocument {
  return { ...doc, nodes: autoArrangeNodes(doc) }
}

/** Guards the (y, x) rank-preservation invariant the module doc above describes -- throws rather than silently shipping a layout that reorders nodes, even though no current codegen path reads that order. */
function verifyOrderPreserved(oldRankedIds: string[], newNodes: PatchNode[]): void {
  const newRankedIds = newNodes
    .map((node, index) => ({ id: nodeId(node, index), node }))
    .sort((a, b) => comparePosition(a.node, b.node))
    .map((x) => x.id)
  const unchanged =
    newRankedIds.length === oldRankedIds.length &&
    newRankedIds.every((id, i) => id === oldRankedIds[i])
  if (!unchanged) {
    throw new Error(
      'autoArrangeNodes: rearranged layout would change position-based execution order'
    )
  }
}

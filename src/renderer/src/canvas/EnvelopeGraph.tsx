import { useRef, useState } from 'react'
import type { ObjNode } from '@shared/domain/patch'
import { findDisplayUnit } from '@logue-codegen/paramUnits'
import { findLoguePrimitive } from '@logue-codegen/primitives'
import { useOptionalPatchStore } from '../state/patchStore'
import { nodeId as computeNodeId } from '../state/nodeId'

export const ENVELOPE_GRAPH_PRIMITIVE = 'logue/env/multistage'
const STAGES = 6
/** The params the graph edits, so ObjectNode doesn't also draw them as dials. */
export const ENVELOPE_GRAPH_PARAMS = new Set(
  Array.from({ length: STAGES }, (_, i) => [`L${i + 1}`, `T${i + 1}`]).flat()
)

// Defaults come from the primitive's own specs, for params not stored on the node yet.
const SPECS = findLoguePrimitive(ENVELOPE_GRAPH_PRIMITIVE)?.params ?? []
const specDefault = (name: string): number => SPECS.find((p) => p.name === name)?.default ?? 0
const MODE_UNIT = findDisplayUnit(ENVELOPE_GRAPH_PRIMITIVE, { name: 'MODE' })
const TIME_UNIT = findDisplayUnit(ENVELOPE_GRAPH_PRIMITIVE, { name: 'T1' })

const W = 228
const H = 96
const PAD_X = 8
const PAD_Y = 8
// The x axis follows the T dials (not linear time: times are cubic), scaled so the whole shape
// fills the graph, but never zoomed in past MIN_SPAN of dial travel. The scale is frozen while a
// point is dragged, so the other points don't slide under the pointer.
const SPAN = W - 2 * PAD_X
const MIN_SPAN = 60

function numOr(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) ? n : fallback
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** The same bend `mseg_step` applies (primitives/env.ts). */
function bend(t: number, curve: number): number {
  const u = 1 - t
  return curve >= 0 ? t + curve * (1 - u * u * u - t) : t - curve * (t * t * t - t)
}

const yOf = (level: number): number => PAD_Y + ((100 - level) / 200) * (H - 2 * PAD_Y)

/**
 * The breakpoint editor for `logue/env/multistage`: each point is a stage's end, at its level
 * (L1-L6, vertical) and after its time (T1-T6, horizontal). Dragging writes both params through
 * `setLogueParam` inside one gesture, so a drag is one undo step. The other params (CURVE, MODE,
 * HOLD, LOOP, TIME, DEPTH) stay dials; the graph reads them live to draw the curve, the hold
 * point and the loop range.
 */
function EnvelopeGraph({ id }: { id: string }): React.JSX.Element | null {
  const params = useOptionalPatchStore((s) => {
    const node = s.rootDoc?.nodes.find((n, i) => computeNodeId(n, i) === id)
    return node?.kind === 'obj' ? (node as ObjNode).params : undefined
  })
  const setLogueParam = useOptionalPatchStore((s) => s.setLogueParam)
  const beginGesture = useOptionalPatchStore((s) => s.beginGesture)
  const endGesture = useOptionalPatchStore((s) => s.endGesture)
  const [active, setActive] = useState<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [frozenPxPerT, setFrozenPxPerT] = useState<number | null>(null)
  const dragRef = useRef<{
    x: number
    y: number
    level: number
    time: number
    pxPerT: number
  } | null>(null)

  if (!params) return null
  const raw = (name: string): string | undefined => params.find((p) => p.name === name)?.value
  const value = (name: string): number => numOr(raw(name), specDefault(name))
  const stageNumbers = Array.from({ length: STAGES }, (_, i) => i + 1)
  const levels = stageNumbers.map((n) => clamp(value(`L${n}`), -100, 100))
  const times = stageNumbers.map((n) => clamp(value(`T${n}`), 0, 100))
  const curve = clamp(value('CURVE'), -100, 100) / 100
  const mode = clamp(Math.round(value('MODE')), 0, 3)
  const hold = clamp(Math.round(value('HOLD')), 0, STAGES - 1)
  const loop = Math.min(clamp(Math.round(value('LOOP')), 0, STAGES - 1), hold)

  const pxPerT =
    frozenPxPerT ??
    SPAN /
      Math.max(
        MIN_SPAN,
        times.reduce((sum, t) => sum + t, 0)
      )
  const xs: number[] = [PAD_X]
  for (const t of times) xs.push(xs[xs.length - 1] + t * pxPerT)
  const points = levels.map((l, i) => ({ x: xs[i + 1], y: yOf(l) }))

  let path = `M ${xs[0]} ${yOf(0)}`
  let prev = 0
  levels.forEach((l, i) => {
    for (let k = 1; k <= 16; k++) {
      const t = k / 16
      path += ` L ${xs[i] + (xs[i + 1] - xs[i]) * t} ${yOf(prev + (l - prev) * bend(t, curve))}`
    }
    prev = l
  })

  const write = (name: string, value: number): void => {
    const current = params.find((p) => p.name === name)
    setLogueParam(id, name, String(value), current?.logueParamIndex, current?.label)
  }

  const onPointerDown = (i: number) => (e: React.PointerEvent<SVGCircleElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    ;(e.target as SVGCircleElement).setPointerCapture(e.pointerId)
    beginGesture()
    setActive(i)
    setFrozenPxPerT(pxPerT)
    dragRef.current = { x: e.clientX, y: e.clientY, level: levels[i], time: times[i], pxPerT }
  }
  const onPointerMove = (i: number) => (e: React.PointerEvent<SVGCircleElement>) => {
    const start = dragRef.current
    if (active !== i || !start) return
    // The canvas may be zoomed: convert screen pixels to graph units via the rendered size.
    const svg = (e.target as SVGCircleElement).ownerSVGElement
    const scale = svg ? W / svg.getBoundingClientRect().width : 1
    const fine = e.shiftKey ? 0.2 : 1
    const dx = (e.clientX - start.x) * scale * fine
    const dy = (e.clientY - start.y) * scale * fine
    const level = Math.round(clamp(start.level - (dy / (H - 2 * PAD_Y)) * 200, -100, 100))
    const time = Math.round(clamp(start.time + dx / start.pxPerT, 0, 100))
    if (level !== levels[i]) write(`L${i + 1}`, level)
    if (time !== times[i]) write(`T${i + 1}`, time)
  }
  const onPointerUp = (i: number) => (e: React.PointerEvent<SVGCircleElement>) => {
    if (active !== i) return
    ;(e.target as SVGCircleElement).releasePointerCapture(e.pointerId)
    dragRef.current = null
    setActive(null)
    setFrozenPxPerT(null)
    endGesture()
  }

  const shown = active ?? hover
  const readout =
    shown === null
      ? (MODE_UNIT?.toDisplay(mode) ?? String(mode))
      : `${shown + 1}: ${levels[shown]}% · ${TIME_UNIT ? TIME_UNIT.toDisplay(times[shown]) : times[shown]}`
  const holdPoint = points[hold]
  const looping = mode === 2 || mode === 3

  return (
    <div className="envelope-graph nodrag nopan">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <line className="envelope-graph__axis" x1={0} x2={W} y1={yOf(0)} y2={yOf(0)} />
        {looping && (
          <rect
            className="envelope-graph__loop"
            x={xs[loop]}
            y={PAD_Y}
            width={Math.max(2, xs[hold + 1] - xs[loop])}
            height={H - 2 * PAD_Y}
          >
            <title>{`Loops stages ${loop + 1}-${hold + 1}`}</title>
          </rect>
        )}
        {mode === 1 && (
          <line
            className="envelope-graph__hold"
            x1={holdPoint.x}
            x2={holdPoint.x}
            y1={PAD_Y}
            y2={H - PAD_Y}
          >
            <title>{`Holds at stage ${hold + 1} while the gate is high`}</title>
          </line>
        )}
        <path className="envelope-graph__curve" d={path} />
        {points.map((p, i) => (
          <circle
            key={i}
            className={
              'envelope-graph__point' + (shown === i ? ' envelope-graph__point--active' : '')
            }
            cx={p.x}
            cy={p.y}
            r={shown === i ? 5 : 4}
            onPointerDown={onPointerDown(i)}
            onPointerMove={onPointerMove(i)}
            onPointerUp={onPointerUp(i)}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover((h) => (h === i ? null : h))}
          >
            <title>{`Stage ${i + 1}: drag up/down for L${i + 1}, left/right for T${i + 1} (Shift: fine)`}</title>
          </circle>
        ))}
      </svg>
      <div className="envelope-graph__readout">{readout}</div>
    </div>
  )
}

export default EnvelopeGraph

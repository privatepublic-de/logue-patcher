import { useCallback } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useStore,
  type EdgeProps,
  type ReactFlowState
} from '@xyflow/react'
import type { NetEdgeData } from '../state/toFlowGraph'
import { PORT_COLOR_AUDIO } from './portColors'

/** Wires not touching the selection recede so the selected nodes' own cables stand out in a busy patch. */
const DIM_WIRE_OPACITY = 0.28

/** A fan-in net (more than one source) is dashed rather than hidden -- still draws the wire, it just can't be a real single-source connection. */
function TypedEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data
}: EdgeProps): React.JSX.Element {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition
  })
  const { color, invalid, warning } = (data as NetEdgeData | undefined) ?? {
    color: PORT_COLOR_AUDIO,
    invalid: false
  }
  const strokeWidth = selected ? 2.5 : 1.5
  // Read from the store rather than baked into edge data: a selection click never remounts
  // the canvas, and this also covers a multi-node selection.
  const touchesSelectedNode = useStore(
    useCallback(
      (s: ReactFlowState) =>
        Boolean(s.nodeLookup.get(source)?.selected || s.nodeLookup.get(target)?.selected),
      [source, target]
    )
  )
  const bright = selected || touchesSelectedNode

  return (
    <>
      {/* Selection halo -- a wider, translucent stroke in the app's one selection accent
          color (same `--color-accent` a selected node's border uses, see main.css's
          `.patch-node--selected`), UNDER the wire's own type-colored line. A thicker line
          alone reads too similarly to an ordinary high-value/thick cable at a glance;
          pairing the halo with the node-selection color keeps "this is selected" legible
          regardless of the wire's own hue. Purely decorative -- pointer-events stay off so
          it never steals a click meant for the real edge path underneath. */}
      {selected && (
        <path
          d={path}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={strokeWidth + 5}
          strokeOpacity={0.45}
          strokeLinecap="round"
          style={{ pointerEvents: 'none' }}
        />
      )}
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: color,
          strokeWidth,
          strokeOpacity: bright ? 1 : DIM_WIRE_OPACITY,
          strokeDasharray: invalid ? '6 4' : undefined
        }}
      />
      {warning && (
        <EdgeLabelRenderer>
          <div
            className="typed-edge__warning nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            data-tooltip={warning}
            aria-label={`check this wire: ${warning}`}
          >
            !
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export default TypedEdge

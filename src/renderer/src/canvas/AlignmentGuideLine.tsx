import { useViewport } from '@xyflow/react'

interface AlignmentGuideLineProps {
  /** Flow-space X currently snapped to, or null while no drag is snapped on that axis. */
  flowX: number | null
  /** Flow-space Y currently snapped to, or null while no drag is snapped on that axis. */
  flowY: number | null
}

/**
 * The magnetic-alignment guides shown while dragging a node near a neighbor's X and/or Y --
 * a horizontal line for a Y snap, a vertical one for an X snap, either or both rendered at once
 * (e.g. a node snapped to one neighbor's Y and a different neighbor's X simultaneously).
 * Positioned via the live viewport transform (not screenToFlowPosition/getBoundingClientRect) so
 * each tracks pan/zoom exactly like React Flow's own nodes/edges, confined to the wrapping canvas
 * div (`position: absolute`, unlike GlobalTooltip.tsx's app-wide `position: fixed` -- this guide
 * is only meaningful within the currently-focused canvas, not the whole window).
 */
function AlignmentGuideLine({ flowX, flowY }: AlignmentGuideLineProps): React.JSX.Element | null {
  const { x, y, zoom } = useViewport()
  if (flowX === null && flowY === null) return null
  return (
    <>
      {flowY !== null && (
        <div
          className="alignment-guide-line alignment-guide-line--h"
          style={{ top: flowY * zoom + y }}
        />
      )}
      {flowX !== null && (
        <div
          className="alignment-guide-line alignment-guide-line--v"
          style={{ left: flowX * zoom + x }}
        />
      )}
    </>
  )
}

export default AlignmentGuideLine

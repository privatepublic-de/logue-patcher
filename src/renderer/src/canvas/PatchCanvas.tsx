import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  ControlButton,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type NodeTypes,
  type EdgeTypes,
  type Node,
  type Edge,
  type OnNodesDelete,
  type OnEdgesDelete,
  type OnSelectionChangeFunc,
  type OnMove,
  type IsValidConnection
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { usePatchStore, usePatchTabId, usePatchStoreApi, GRID_SIZE } from '../state/patchStore'
import { serializeSelectionForClipboard } from '../state/patchDocHelpers'
import { patchDocToFlow, type NetEdgeData, type ObjectNodeData } from '../state/toFlowGraph'
import { portKindsAgree } from './ports'
import { nodeId } from '../state/nodeId'
import {
  buildCanvasSessionKey,
  recordNodeMeasurement,
  getSessionMeasurements,
  recordViewport,
  getSessionViewport
} from './nodeMeasurements'
import ObjectNode from './ObjectNode'
import CommentNode from './CommentNode'
import TypedEdge from './TypedEdge'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import ObjectInsertPopup from './ObjectInsertPopup'
import { estimateNodeSize, findFreeSpot, registerInsertPositionProvider } from './freeSpot'
import AlignmentGuideLine from './AlignmentGuideLine'
import { Redo2, Undo2, Workflow } from 'lucide-react'
import { useArrangeActions } from './useArrangeActions'
import { computeYSnap, candidateSnapYs, computeXSnap, candidateSnapXs } from './alignmentGuide'
import { COMMENT_ENTRY, insertArgsFor, PALETTE_DRAG_TYPE } from '../browser/loguePrimitiveCatalog'
import { isFixedIoNodeType } from '@logue-codegen/oscInstances'
import { isSubpatchInstanceType } from '@logue-codegen/subpatches'
import { useSubpatchLibraryStore } from '../state/subpatchLibraryStore'
import { openSubpatchDefinition } from '../state/openSubpatchDefinition'

const nodeTypes: NodeTypes = { object: ObjectNode, comment: CommentNode }
const edgeTypes: EdgeTypes = { typed: TypedEdge }

interface PatchCanvasSessionProps {
  initialNodes: Node[]
  initialEdges: Edge[]
  sessionKey: string
}

interface ContextMenuState {
  screenPos: { x: number; y: number }
  items: ContextMenuItem[]
}

interface InsertPopupState {
  screenPos: { x: number; y: number }
  flowPos: { x: number; y: number }
}

interface ReplacePopupState {
  screenPos: { x: number; y: number }
  targetId: string
  /** The node's own current type plus `LOGUE_AUDIO_OUT_TYPE` -- computed once at menu-open time (see `handleContextMenu`), so the popup never has to re-look-up the node it's replacing. */
  excludeIds: string[]
}

/**
 * The actual interactive canvas for one "session" (one loaded document at one reload
 * generation -- see PatchCanvas below). useNodesState/useEdgesState own moment-to-moment
 * interaction state (drag position, selection); patchStore only receives the specific
 * committed mutation each gesture implies, on `onNodeDragStop`/`onConnect`/`on*Delete`, not
 * a wholesale sync of React Flow's internal state back into the domain document.
 */
function PatchCanvasSession({
  initialNodes,
  initialEdges,
  sessionKey
}: PatchCanvasSessionProps): React.JSX.Element {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  // Feeds autoArrange.ts's real footprint sizing (see nodeMeasurements.ts) -- React Flow
  // populates `node.measured` via its own ResizeObserver once a node actually renders, which
  // is the ONLY accurate source of a node's on-screen size (the alternative, estimating from
  // text length, is what made rearranged nodes overlap in the first place). Re-runs on every
  // `nodes` change (not just once at mount) so a node's measurement stays current across
  // whatever in-session state changes this array (selection, a keyboard nudge) before the
  // next full remount recomputes it from scratch anyway.
  useEffect(() => {
    for (const n of nodes) {
      if (n.measured?.width && n.measured?.height) {
        recordNodeMeasurement(sessionKey, n.id, {
          width: n.measured.width,
          height: n.measured.height
        })
      }
    }
  }, [nodes, sessionKey])
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  // Flow-space X/Y the alignment guides are currently snapped to, or null mid-drag with no snap
  // engaged on that axis. Live here (not refs) so AlignmentGuideLine re-renders as they change;
  // recomputed fresh every onNodeDrag frame from that frame's raw pointer-driven position (see
  // alignmentGuide.ts's doc comment) rather than accumulated, so they can never drift from what
  // the pointer is actually doing. Independent of each other -- a drag can snap on neither, one,
  // or both axes simultaneously.
  const [snapX, setSnapX] = useState<number | null>(null)
  const [snapY, setSnapY] = useState<number | null>(null)
  const [insertPopup, setInsertPopup] = useState<InsertPopupState | null>(null)
  const [replacePopup, setReplacePopup] = useState<ReplacePopupState | null>(null)

  const moveNode = usePatchStore((s) => s.moveNode)
  const insertSpecialObject = usePatchStore((s) => s.insertSpecialObject)
  const replaceNode = usePatchStore((s) => s.replaceNode)
  const logueTarget = usePatchStore((s) => s.rootDoc?.settings.logueTarget)
  const beginGesture = usePatchStore((s) => s.beginGesture)
  const endGesture = usePatchStore((s) => s.endGesture)
  const addNet = usePatchStore((s) => s.addNet)
  const removeNetDests = usePatchStore((s) => s.removeNetDests)
  const removeNetEndpoint = usePatchStore((s) => s.removeNetEndpoint)
  const deleteNetAt = usePatchStore((s) => s.deleteNetAt)
  const deleteNodes = usePatchStore((s) => s.deleteNodes)
  const setSelectedNodeId = usePatchStore((s) => s.setSelectedNodeId)
  const setSelectedNodeIds = usePatchStore((s) => s.setSelectedNodeIds)
  const setPendingEditNodeId = usePatchStore((s) => s.setPendingEditNodeId)
  const openParamMatrix = usePatchStore((s) => s.openParamMatrix)
  const pasteFromClipboard = usePatchStore((s) => s.pasteFromClipboard)
  const duplicateNodes = usePatchStore((s) => s.duplicateNodes)
  const insertComment = usePatchStore((s) => s.insertComment)
  const canUndo = usePatchStore((s) => s.past.length > 0)
  const canRedo = usePatchStore((s) => s.future.length > 0)
  const undo = usePatchStore((s) => s.undo)
  const redo = usePatchStore((s) => s.redo)
  const arrange = useArrangeActions()
  const patchStoreApi = usePatchStoreApi()
  const { screenToFlowPosition, setCenter, getZoom, getNodes, fitView } = useReactFlow()

  // View › Zoom to Fit. Only the mounted (active) tab's canvas exists, so it's always that one.
  useEffect(
    () => window.axoloti.events.onMenuZoomToFit(() => void fitView({ duration: 200 })),
    [fitView]
  )

  // Lets the sidebar palette drop new nodes into free space inside the visible viewport (see
  // freeSpot.ts). Reads live nodes/viewport at call time, so it registers once per mount.
  const wrapperRef = useRef<HTMLDivElement>(null)
  useEffect(
    () =>
      registerInsertPositionProvider((type) => {
        const el = wrapperRef.current
        if (!el) return null
        const r = el.getBoundingClientRect()
        const topLeft = screenToFlowPosition({ x: r.left, y: r.top })
        const bottomRight = screenToFlowPosition({ x: r.right, y: r.bottom })
        const view = {
          x: topLeft.x,
          y: topLeft.y,
          width: bottomRight.x - topLeft.x,
          height: bottomRight.y - topLeft.y
        }
        const cached = getSessionMeasurements(sessionKey)
        const occupied = getNodes().map((n) => {
          const size =
            n.measured?.width && n.measured.height
              ? { width: n.measured.width, height: n.measured.height }
              : (cached.get(n.id) ??
                estimateNodeSize((n.data as { node?: { type?: string } }).node?.type ?? ''))
          return { x: n.position.x, y: n.position.y, ...size }
        })
        // The minimap and zoom controls float over the canvas, so a node placed under them
        // would be hidden just the same as one outside the view.
        for (const overlay of el.querySelectorAll('.react-flow__minimap, .react-flow__controls')) {
          const o = overlay.getBoundingClientRect()
          const a = screenToFlowPosition({ x: o.left, y: o.top })
          const b = screenToFlowPosition({ x: o.right, y: o.bottom })
          occupied.push({ x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y })
        }
        return findFreeSpot(view, occupied, estimateNodeSize(type))
      }),
    [screenToFlowPosition, getNodes, sessionKey]
  )

  // Preserves zoom/pan across this session's own remounts (see nodeMeasurements.ts's
  // recordViewport/getSessionViewport doc comment) -- read once at mount time only, matching
  // initialNodes/initialEdges's own "seed once, let React Flow own it after" pattern above.
  const initialViewport = getSessionViewport(sessionKey)
  const handleMove: OnMove = useCallback(
    (_event, viewport) => {
      recordViewport(sessionKey, viewport)
    },
    [sessionKey]
  )

  // Last pointer position over the canvas, in *screen* coordinates (see the onMouseMove handler
  // on the wrapping div below) -- converted to flow-space via screenToFlowPosition only at paste
  // or quick-add time, so panning/zooming since the last mouse move is accounted for
  // automatically. Cmd/Ctrl+V and the quick-add shortcuts have no other way to know "where"
  // (unlike a real mouse drop/click event).
  const lastPointerScreenPos = useRef<{ x: number; y: number } | null>(null)
  // Space is only claimed while the pointer is actually over the canvas -- the keydown listener
  // is window-wide, and elsewhere Space must keep activating a focused button.
  const pointerOverCanvas = useRef(false)
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    lastPointerScreenPos.current = { x: e.clientX, y: e.clientY }
    pointerOverCanvas.current = true
  }, [])
  const handleMouseLeave = useCallback(() => {
    pointerOverCanvas.current = false
  }, [])

  /**
   * Click/drag-to-pan on the minimap, implemented by hand rather than via `<MiniMap>`'s own
   * built-in `pannable`/`zoomable` props -- those ARE set (below) but do nothing in this app's
   * actual build: confirmed live (a real trusted click, drag, AND wheel event dispatched
   * directly at the minimap's own `<svg>` produce zero viewport change, while the exact same
   * wheel event over the main canvas works fine, and the minimap's own `svg.__zoom` internal
   * d3 state DOES update from a wheel event -- so d3-zoom's own event wiring is intact, but
   * whatever the minimap's internal `panZoom` closure resolves to never actually moves the
   * real viewport). Matches a known, still-open upstream xyflow/React-19 report (an internal
   * `useStore`-supplied `panZoom` reference that Controls/MiniMap capture once via `useEffect`
   * apparently going stale) -- xyflow/xyflow discussion #4901, reproducing on this exact
   * `@xyflow/react@12.11.3` (even the latest published 12.11.6 is unchanged). Rather than
   * chase or wait on an upstream fix, this reimplements the interaction against the PUBLIC,
   * always-fresh-from-the-store `useReactFlow()` API (`setCenter`/`getZoom`, the same
   * mechanism the working main-canvas zoom already goes through) instead of the internal
   * `panZoom` object MiniMap's own closure holds onto.
   *
   * `minimapWrapperRef` only exists for DOM access (a `querySelector` down to the real
   * `<svg class="react-flow__minimap-svg">` `<MiniMap>` itself renders) -- `display: contents`
   * keeps it invisible to layout, so it doesn't disturb `<MiniMap>`'s own `position: absolute`
   * placement (via React Flow's internal `<Panel>`), which resolves against the nearest
   * positioned ancestor regardless of this wrapper's own box.
   */
  const minimapWrapperRef = useRef<HTMLDivElement | null>(null)
  // Only ever non-null while a drag started by handleMinimapPointerDown is active -- lets the
  // unmount effect below tear down an orphaned window listener pair if this session remounts
  // (key change: a file switch, an unrelated edit bumping reloadNonce) while the user's pointer
  // is still down, which would otherwise leak a listener referencing a useReactFlow() instance
  // whose underlying store no longer exists.
  const minimapDragCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    return () => minimapDragCleanupRef.current?.()
  }, [])
  const minimapPointToFlow = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const svg = minimapWrapperRef.current?.querySelector(
        'svg.react-flow__minimap-svg'
      ) as SVGSVGElement | null
      if (!svg) return null
      const ctm = svg.getScreenCTM()
      if (!ctm) return null
      const pt = svg.createSVGPoint()
      pt.x = clientX
      pt.y = clientY
      const transformed = pt.matrixTransform(ctm.inverse())
      return { x: transformed.x, y: transformed.y }
    },
    []
  )
  const handleMinimapPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const jumpTo = (clientX: number, clientY: number): void => {
        const pos = minimapPointToFlow(clientX, clientY)
        if (pos) setCenter(pos.x, pos.y, { zoom: getZoom(), duration: 0 })
      }
      jumpTo(e.clientX, e.clientY)
      const handleMove = (ev: PointerEvent): void => jumpTo(ev.clientX, ev.clientY)
      const handleUp = (): void => {
        window.removeEventListener('pointermove', handleMove)
        window.removeEventListener('pointerup', handleUp)
        minimapDragCleanupRef.current = null
      }
      window.addEventListener('pointermove', handleMove)
      window.addEventListener('pointerup', handleUp)
      minimapDragCleanupRef.current = handleUp
    },
    [minimapPointToFlow, setCenter, getZoom]
  )

  /** Copies of `ids` placed just right of them (their measured bounding box), top-aligned. */
  const duplicateBeside = useCallback(
    (ids: string[]): void => {
      const doc = patchStoreApi.getState().rootDoc
      if (!doc) return
      // A document has exactly one audio-out (and an effect one audio-in).
      const fixed = new Set(
        doc.nodes
          .map((n, i) => (n.kind === 'obj' && isFixedIoNodeType(n.type) ? nodeId(n, i) : null))
          .filter((id): id is string => id !== null)
      )
      const chosen = getNodes().filter((n) => ids.includes(n.id) && !fixed.has(n.id))
      if (chosen.length === 0) return
      const box = (n: (typeof chosen)[number]): { x: number; y: number; w: number; h: number } => ({
        x: n.position.x,
        y: n.position.y,
        w: n.measured?.width ?? 140,
        h: n.measured?.height ?? 80
      })
      const left = Math.min(...chosen.map((n) => box(n).x))
      const top = Math.min(...chosen.map((n) => box(n).y))
      const right = Math.max(...chosen.map((n) => box(n).x + box(n).w))
      const bottom = Math.max(...chosen.map((n) => box(n).y + box(n).h))
      // Beside the originals, then a grid step lower at a time until the copy covers no node.
      const x = right + GRID_SIZE * 2
      const others = getNodes()
        .filter((n) => !ids.includes(n.id))
        .map(box)
      const clear = (y: number): boolean =>
        others.every(
          (o) =>
            x + (right - left) + GRID_SIZE <= o.x ||
            o.x + o.w + GRID_SIZE <= x ||
            y + (bottom - top) + GRID_SIZE <= o.y ||
            o.y + o.h + GRID_SIZE <= y
        )
      let y = top
      for (let step = 0; step < 400 && !clear(y); step++) y += GRID_SIZE
      duplicateNodes(
        chosen.map((n) => n.id),
        { x, y }
      )
    },
    [patchStoreApi, getNodes, duplicateNodes]
  )

  // Canvas-level keyboard shortcuts -- copy/cut/paste (Cmd/Ctrl+C/X/V), a plain-comment
  // shortcut (C/Cmd+5), and arrow-key nudging. Mirrors PatchWorkspace.tsx's undo/redo
  // handler's input-focus guard throughout (a text field's own native editing, and any
  // context menu, must never be hijacked) and reads the live selection off React Flow's own
  // local `nodes` state and the live active document fresh off the store at keydown time, not
  // a stale closure.
  useEffect(() => {
    function isTextInputFocused(): boolean {
      const active = document.activeElement
      return !!active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)
    }
    // A selectable (but non-input) span -- the toolbar file path, the compile log -- has no
    // activeElement of its own, so isTextInputFocused() alone doesn't see it; without this, Cmd+C
    // over a real text selection there would still hijack the clipboard with node XML instead of
    // letting the browser's native copy win.
    function hasActiveTextSelection(): boolean {
      return (window.getSelection()?.toString().length ?? 0) > 0
    }
    function insertCommentAtCursor(): void {
      const pos = lastPointerScreenPos.current
      if (!pos) return
      const flowPos = screenToFlowPosition(pos)
      insertComment(flowPos.x, flowPos.y)
    }
    function handleKeyDown(e: KeyboardEvent): void {
      // A focused widget already handled it -- e.g. a dial's arrow keys, which would otherwise
      // also nudge its (selected) node.
      if (e.defaultPrevented || isTextInputFocused() || contextMenu) return
      const cmdOrCtrl = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()

      if (cmdOrCtrl) {
        if (key === 'c' || key === 'x') {
          if (hasActiveTextSelection()) return
          const selectedIds = nodes.filter((n) => n.selected).map((n) => n.id)
          if (selectedIds.length === 0) return
          e.preventDefault()
          const { rootDoc } = patchStoreApi.getState()
          if (!rootDoc) return
          const xml = serializeSelectionForClipboard(rootDoc, selectedIds)
          void window.axoloti.clipboard.writeText(xml)
          if (key === 'x') deleteNodes(selectedIds)
        } else if (key === 'v') {
          e.preventDefault()
          void window.axoloti.clipboard.readText().then((xml) => {
            const cursorFlowPos = lastPointerScreenPos.current
              ? screenToFlowPosition(lastPointerScreenPos.current)
              : null
            pasteFromClipboard(xml, cursorFlowPos)
          })
        } else if (key === 'd') {
          const selectedIds = nodes.filter((n) => n.selected).map((n) => n.id)
          if (selectedIds.length === 0) return
          e.preventDefault()
          duplicateBeside(selectedIds)
        } else if (key === '5') {
          // Cmd/Ctrl+5 -- alias for plain C.
          e.preventDefault()
          insertCommentAtCursor()
        }
        return
      }

      if (key === ' ') {
        const pos = lastPointerScreenPos.current
        if (!logueTarget || !pointerOverCanvas.current || !pos || e.repeat) return
        e.preventDefault()
        setInsertPopup({ screenPos: pos, flowPos: screenToFlowPosition(pos) })
      } else if (key === 'c') {
        e.preventDefault()
        insertCommentAtCursor()
      } else if (
        key === 'arrowup' ||
        key === 'arrowdown' ||
        key === 'arrowleft' ||
        key === 'arrowright'
      ) {
        const selected = nodes.filter((n) => n.selected)
        if (selected.length === 0) return
        e.preventDefault()
        // axoloti-1.0.12 reverses the usual convention on purpose (PatchGUI.java keyPressed):
        // the unmodified nudge is the coarse 14px grid step, and Shift is the *fine* 1px one.
        const step = e.shiftKey ? 1 : GRID_SIZE
        const [dx, dy] =
          key === 'arrowup'
            ? [0, -step]
            : key === 'arrowdown'
              ? [0, step]
              : key === 'arrowleft'
                ? [-step, 0]
                : [step, 0]
        // Unlike a mouse drag (where React Flow's own onNodesChange already moves the node
        // visually before onNodeDragStop ever persists it), nothing moves the on-screen position
        // for a keyboard nudge unless this does it explicitly -- moveNode alone only updates the
        // store, which (deliberately, to keep dragging smooth) doesn't bump reloadNonce/remount
        // the canvas, so a nudge would otherwise persist with zero visible feedback. Found live.
        const selectedIds = new Set(selected.map((n) => n.id))
        setNodes((nds) =>
          nds.map((n) =>
            selectedIds.has(n.id)
              ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
              : n
          )
        )
        for (const n of selected) {
          moveNode(n.id, n.position.x + dx, n.position.y + dy)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    nodes,
    contextMenu,
    patchStoreApi,
    deleteNodes,
    pasteFromClipboard,
    duplicateBeside,
    insertComment,
    moveNode,
    setNodes,
    screenToFlowPosition,
    logueTarget
  ])

  // One delegated right-click handler for node/jack/param context menus, rather than wiring
  // React Flow's onNodeContextMenu/onEdgeContextMenu (neither covers a jack target -- see the
  // feature's plan). `data-port-name`/`data-port-direction` (ObjectNode.tsx's port divs) is the
  // sub-node target marker; `data-param-name` (ParamDial.tsx's own root div)
  // is the param-value target marker; a plain `.react-flow__node[data-id]`
  // match with no port/param target is the whole-node menu. Checked in that order since a param
  // widget is nested INSIDE the node element, so `nodeEl` always also matches -- `portEl`/
  // `paramEl` must each be checked (and returned from) before falling through to the generic
  // node-level items below.
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement
      const portEl = target.closest<HTMLElement>('[data-port-name]')
      const paramEl = target.closest<HTMLElement>('[data-param-name]')
      const nodeEl = target.closest<HTMLElement>('.react-flow__node[data-id]')
      if (!nodeEl) return
      e.preventDefault()
      const screenPos = { x: e.clientX, y: e.clientY }
      const targetId = nodeEl.getAttribute('data-id')!

      const { rootDoc } = patchStoreApi.getState()
      if (!rootDoc) return
      const node = rootDoc.nodes.find((n, i) => nodeId(n, i) === targetId)
      if (!node) return

      if (portEl) {
        const portName = portEl.getAttribute('data-port-name')!
        const direction = portEl.getAttribute('data-port-direction') === 'in' ? 'dest' : 'source'
        const netIndex = rootDoc.nets.findIndex((net) =>
          direction === 'source'
            ? net.sources.some((s) => s.obj === targetId && s.outlet === portName)
            : net.dests.some((d) => d.obj === targetId && d.inlet === portName)
        )
        if (netIndex < 0) return
        setContextMenu({
          screenPos,
          items: [
            {
              label: 'Disconnect',
              onClick: () => removeNetEndpoint(netIndex, direction, targetId, portName)
            },
            { label: 'Delete net', onClick: () => deleteNetAt(netIndex) }
          ]
        })
        return
      }

      if (paramEl) {
        const paramName = paramEl.getAttribute('data-param-name')!
        setContextMenu({
          screenPos,
          items: [
            {
              label: 'Configure in Param Matrix…',
              onClick: () => openParamMatrix({ nodeId: targetId, paramName })
            }
          ]
        })
        return
      }

      const items: ContextMenuItem[] = []
      if (node.kind === 'comment') {
        items.push({ label: 'Edit text', onClick: () => setPendingEditNodeId(targetId) })
      } else {
        items.push({ label: 'Edit instance name', onClick: () => setPendingEditNodeId(targetId) })
        if (isSubpatchInstanceType(node.type)) {
          items.push({
            label: 'Edit subpatch',
            onClick: () => void openSubpatchDefinition(node.type)
          })
        }
        // Only meaningful for a *logue-target document (there's no primitive registry to offer
        // a replacement from otherwise -- same gate LoguePrimitivePalette.tsx/ObjectInsertPopup
        // already use) and never for the fixed audio-out sink (see replaceNode's own doc
        // comment for why).
        if (logueTarget && !isFixedIoNodeType(node.type)) {
          items.push({
            label: 'Replace with…',
            onClick: () =>
              setReplacePopup({
                screenPos,
                targetId,
                excludeIds: [node.type]
              })
          })
        }
      }
      // The fixed audio-out sink (and audio-in) is never deletable (patchStore.ts's `deleteNodes`
      // already refuses it) -- omitted here too, rather than offered and silently doing nothing.
      // Nor duplicable: a document has exactly one of each.
      if (!isFixedIoNodeType(node.type)) {
        // Right-clicking one of several selected nodes duplicates them all, wires between them
        // included, like ⌘D.
        const selected = getNodes()
          .filter((n) => n.selected)
          .map((n) => n.id)
        const ids = selected.length > 1 && selected.includes(targetId) ? selected : [targetId]
        items.push({
          label: ids.length > 1 ? `Duplicate ${ids.length} Nodes (⌘D)` : 'Duplicate (⌘D)',
          onClick: () => duplicateBeside(ids)
        })
        items.push({ label: 'Delete', onClick: () => deleteNodes([targetId]) })
      }
      setContextMenu({ screenPos, items })
    },
    [
      patchStoreApi,
      removeNetEndpoint,
      deleteNetAt,
      setPendingEditNodeId,
      deleteNodes,
      logueTarget,
      openParamMatrix,
      getNodes,
      duplicateBeside
    ]
  )

  // Double-click-empty-canvas object insert (proposed as the discoverable equivalent of the
  // sidebar palette's click-to-insert, landing the new node exactly where the user double-
  // clicked instead of the palette's own cascading-grid guess). Only wired for a logue-target
  // document -- there's no library to browse for a plain (possibly legacy-Axoloti) graph post-
  // Axoloti-removal, so `LoguePrimitivePalette.tsx` doesn't render for one either.
  // `.react-flow__node`/`.react-flow__edge` are excluded so this never fires for a double-click
  // that lands on a node's own non-`stopPropagation`-guarded chrome (e.g. its body padding,
  // outside the title/param-value spans that already claim the gesture for renaming/editing).
  const handlePaneDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!logueTarget) return
      const target = e.target as HTMLElement
      if (target.closest('.react-flow__node') || target.closest('.react-flow__edge')) return
      const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      setInsertPopup({ screenPos: { x: e.clientX, y: e.clientY }, flowPos })
    },
    [logueTarget, screenToFlowPosition]
  )

  /** A palette/popup catalog entry (a primitive, a subpatch, a preset or the comment) at `pos`. */
  const insertEntryAt = useCallback(
    (id: string, pos: { x: number; y: number }): void => {
      if (id === COMMENT_ENTRY.id) {
        insertComment(pos.x, pos.y)
        return
      }
      const { type, shortId, params } = insertArgsFor(id)
      insertSpecialObject(type, shortId, pos.x, pos.y, params)
    },
    [insertComment, insertSpecialObject]
  )

  // A palette entry dragged onto the canvas lands under the pointer (its title bar, roughly,
  // hence the small offset) rather than in the free spot a click would pick.
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(PALETTE_DRAG_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      const id = e.dataTransfer.getData(PALETTE_DRAG_TYPE)
      if (!id) return
      e.preventDefault()
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      insertEntryAt(id, { x: pos.x - 20, y: pos.y - 12 })
    },
    [screenToFlowPosition, insertEntryAt]
  )

  // Magnetic alignment guides (both axes): recomputed every drag frame from that frame's raw
  // pointer-driven position (React Flow's own `node`/`nodes` callback args, already updated by
  // its internal onNodesChange before this fires -- see PatchCanvas's remount doc comment on
  // why store state isn't used here). Comments (React Flow type 'comment') never
  // engage or offer either guide -- they're excluded from codegen's position-based instance
  // order entirely (autoArrange.ts's own comparePosition), so neither their X nor Y is a
  // meaningful alignment target and dragging one should feel exactly as free as it does today.
  // X and Y snap independently of each other -- each axis picks its own nearest candidate and
  // applies its own delta, so a drag can snap on one axis, the other, both, or neither.
  const onNodeDrag = useCallback(
    (_event: unknown, node: Node, draggedNodes: Node[]) => {
      if (node.type === 'comment') return
      const draggedIds = new Set(draggedNodes.map((n) => n.id))
      const rawX = node.position.x
      const rawY = node.position.y
      const snappedX = computeXSnap(rawX, candidateSnapXs(nodes, draggedIds), snapX)
      const snappedY = computeYSnap(rawY, candidateSnapYs(nodes, draggedIds), snapY)
      setSnapX(snappedX)
      setSnapY(snappedY)
      const deltaX = snappedX !== null ? snappedX - rawX : 0
      const deltaY = snappedY !== null ? snappedY - rawY : 0
      if (deltaX !== 0 || deltaY !== 0) {
        setNodes((nds) =>
          nds.map((n) =>
            draggedIds.has(n.id)
              ? { ...n, position: { x: n.position.x + deltaX, y: n.position.y + deltaY } }
              : n
          )
        )
      }
    },
    [nodes, snapX, snapY, setNodes]
  )

  // Persists every node the gesture actually moved, not just the primary dragged one -- a
  // multi-select drag previously only committed the single node React Flow reports as arg 2,
  // silently reverting the rest of the selection's on-screen move the next time anything
  // remounts the canvas. beginGesture/endGesture keeps this whole gesture as a single undo
  // step regardless of how many nodes moved.
  //
  // Recomputes the snap here rather than trusting `node`/`draggedNodes`' own `position` -- React
  // Flow tracks each drag's position internally from the pointer delta since drag-start (its own
  // `dragItems`, @xyflow/system's XYDrag), entirely independent of the visual correction
  // `onNodeDrag` applies via `setNodes` above, and its own final `onNodesChange` (firing right
  // before this handler) writes that raw, uncorrected position back into local `nodes` state --
  // silently undoing onNodeDrag's mid-drag correction. Two real bugs found live from this: (1)
  // the drop position settling at the raw cursor Y instead of the snapped one shown during drag
  // (moveNode alone isn't enough -- it commits to the store, which deliberately doesn't bump
  // reloadNonce/remount on a plain move, so nothing else re-syncs local state to match), fixed by
  // re-deriving the snap from the same raw value independently and applying it to local state via
  // setNodes here too, exactly like onNodeDrag does; (2) is the same underlying reason a bare
  // `moveNode(node.id, ...)` using arg 2 only ever fixed up the single primary node.
  const onNodeDragStop = useCallback(
    (_event: unknown, node: Node, draggedNodes: Node[]) => {
      beginGesture()
      const draggedIds = new Set(draggedNodes.map((n) => n.id))
      const snappedX =
        node.type === 'comment'
          ? null
          : computeXSnap(node.position.x, candidateSnapXs(nodes, draggedIds), snapX)
      const snappedY =
        node.type === 'comment'
          ? null
          : computeYSnap(node.position.y, candidateSnapYs(nodes, draggedIds), snapY)
      const deltaX = snappedX !== null ? snappedX - node.position.x : 0
      const deltaY = snappedY !== null ? snappedY - node.position.y : 0
      if (deltaX !== 0 || deltaY !== 0) {
        setNodes((nds) =>
          nds.map((n) =>
            draggedIds.has(n.id)
              ? { ...n, position: { x: n.position.x + deltaX, y: n.position.y + deltaY } }
              : n
          )
        )
      }
      for (const n of draggedNodes) {
        moveNode(n.id, n.position.x + deltaX, n.position.y + deltaY)
      }
      endGesture()
      setSnapX(null)
      setSnapY(null)
    },
    [nodes, snapX, snapY, moveNode, setNodes, beginGesture, endGesture]
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      addNet(
        { obj: connection.source, outlet: connection.sourceHandle ?? undefined },
        { obj: connection.target, inlet: connection.targetHandle ?? undefined }
      )
    },
    [addNet]
  )

  // A buffer wire can't be drawn to a signal inlet (or the reverse): refused while dragging, so
  // the mistake never reaches the document.
  const isValidConnection: IsValidConnection = useCallback(
    (connection) => {
      const data = (id: string): ObjectNodeData | undefined => {
        const n = nodes.find((node) => node.id === id)
        return n?.type === 'object' ? (n.data as ObjectNodeData) : undefined
      }
      const source = data(connection.source)
      const target = data(connection.target)
      if (!source || !target) return true
      const bucket = connection.sourceHandle
        ? source.outletBuckets[connection.sourceHandle]
        : undefined
      const role = target.inlets.find((i) => i.name === connection.targetHandle)?.role
      const typeOf = (d: ObjectNodeData): string | undefined =>
        d.node.kind === 'obj' ? d.node.type : undefined
      return portKindsAgree(bucket, role, typeOf(source), typeOf(target))
    },
    [nodes]
  )

  const onNodesDelete: OnNodesDelete = useCallback(
    (deleted) => deleteNodes(deleted.map((n) => n.id)),
    [deleteNodes]
  )

  const onEdgesDelete: OnEdgesDelete = useCallback(
    (deleted) => {
      const pairs = deleted
        .map((e) => e.data as NetEdgeData | undefined)
        .filter((d): d is NetEdgeData => d !== undefined)
        .map((d) => ({ netIndex: d.netIndex, destIndex: d.destIndex }))
      removeNetDests(pairs)
    },
    [removeNetDests]
  )

  const onSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: selected }) => {
      const id = selected.length === 1 ? selected[0].id : null
      setSelectedNodeId(id)
      setSelectedNodeIds(selected.map((n) => n.id))
      // patchDocToFlow only bakes zIndex into edges at PatchCanvasSession mount time (see its
      // key below) -- an ordinary selection click never remounts, so without this, elevation
      // would only ever reflect whatever was selected the last time the canvas remounted.
      // Kept below elevateNodesOnSelect's 1000 (see patchDocToFlow's matching comment) so a
      // node's own cables never outrank the node itself for pointer hit-testing.
      setEdges((eds) =>
        eds.map((e) => {
          const zIndex = id !== null && (e.source === id || e.target === id) ? 500 : 0
          return e.zIndex === zIndex ? e : { ...e, zIndex }
        })
      )
    },
    [setSelectedNodeId, setSelectedNodeIds, setEdges]
  )

  return (
    <div
      ref={wrapperRef}
      style={{ width: '100%', height: '100%', position: 'relative' }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onContextMenu={handleContextMenu}
      onDoubleClick={handlePaneDoubleClick}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onSelectionChange={onSelectionChange}
        onMove={handleMove}
        colorMode="dark"
        fitView={!initialViewport}
        defaultViewport={initialViewport}
        // The object-insert popup above replaces React Flow's own double-click-to-zoom for a
        // logue-target document -- otherwise every double-click meant to open the popup would
        // also zoom the canvas. A plain (non-logue) document has no popup to open, so it keeps
        // the default zoom gesture.
        zoomOnDoubleClick={!logueTarget}
        // Space opens the object search (see handleKeyDown), so it can't also be React Flow's
        // default hold-to-pan key.
        panActivationKeyCode={null}
        proOptions={{ hideAttribution: true }}
        // Deliberately NOT using the built-in elevateEdgesOnSelect: @xyflow/system's
        // getElevatedEdgeZIndex doesn't just apply it to an edge's own selected state, it ADDS
        // the connected node's own (possibly elevateNodesOnSelect-boosted) z on top of
        // whatever zIndex we give the edge -- so a cable touching the currently-selected node
        // always ends up above that node's own body (1000 + our zIndex), regardless of what
        // number we pick. That's exactly the wire-blocks-the-knob-I-just-selected bug: clicking
        // a node to reach one of its dials/sliders selects it first, which used to send its own
        // cables to the top. patchDocToFlow's baked-in zIndex (500 for a touching-selected-node
        // edge, 0 otherwise -- see its doc comment) already gives a highlighted net enough
        // clearance over other unselected nodes/edges for the crossing-wire-halo effect this
        // prop was added for; it just needs to be used verbatim, not added onto a node's z.
      >
        <Background />
        {/* Every canvas control in one stack: zoom/fit/lock, then the edit ones that used to be a
            toolbar strip. aria-disabled, not `disabled`: a disabled button fires no mouseover,
            which would kill GlobalTooltip; the handlers re-check instead. */}
        <Controls>
          <ControlButton
            className="canvas-controls__group-start"
            onClick={() => canUndo && undo()}
            aria-disabled={!canUndo}
            data-tooltip="Undo (⌘Z)"
            aria-label="Undo"
          >
            <Undo2 />
          </ControlButton>
          <ControlButton
            onClick={() => canRedo && redo()}
            aria-disabled={!canRedo}
            data-tooltip="Redo (⌘⇧Z)"
            aria-label="Redo"
          >
            <Redo2 />
          </ControlButton>
          <ControlButton
            onClick={arrange.byFlow}
            data-tooltip="Arrange by signal flow (⌥⌘A) -- spread out overlaps is in the Arrange menu"
            aria-label="Arrange by signal flow"
          >
            <Workflow />
          </ControlButton>
        </Controls>
        <div
          ref={minimapWrapperRef}
          style={{ display: 'contents' }}
          onPointerDown={handleMinimapPointerDown}
        >
          <MiniMap pannable={false} zoomable={false} />
        </div>
      </ReactFlow>
      <AlignmentGuideLine flowX={snapX} flowY={snapY} />
      {contextMenu && (
        <ContextMenu
          screenPos={contextMenu.screenPos}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
      {insertPopup && logueTarget && (
        <ObjectInsertPopup
          screenPos={insertPopup.screenPos}
          includeComment
          onInsert={(id) => insertEntryAt(id, insertPopup.flowPos)}
          onClose={() => setInsertPopup(null)}
        />
      )}
      {replacePopup && logueTarget && (
        <ObjectInsertPopup
          screenPos={replacePopup.screenPos}
          excludeIds={replacePopup.excludeIds}
          onInsert={(id) => replaceNode(replacePopup.targetId, id)}
          onClose={() => setReplacePopup(null)}
        />
      )}
    </div>
  )
}

/**
 * Remounts PatchCanvasSession (via `key`) whenever the store's document identity changes for
 * reasons *other* than the canvas's own edits -- a fresh file load or an insert. Plain node
 * moves don't bump reloadNonce, so dragging stays smooth without remounting; everything else
 * remounts, getting guaranteed-correct derived state (in particular, edge->net index mapping)
 * instead of hand-rolled incremental sync. Zoom/pan is NOT lost across this remount -- see
 * nodeMeasurements.ts's recordViewport/getSessionViewport, which PatchCanvasSession reads/
 * writes outside React state for exactly this reason. Selection is NOT lost on remount either
 * -- `patchDocToFlow` seeds React Flow's initial node state from the store's own
 * `selectedNodeId` (see its doc comment): a real bug this pass fixed, since every param edit
 * bumps reloadNonce, and without this, React Flow's post-remount "nothing selected" state
 * would immediately overwrite the store's selection, closing the Inspector after every single
 * field edit.
 */
function PatchCanvas(): React.JSX.Element {
  const tabId = usePatchTabId()
  const api = usePatchStoreApi()
  // Deliberately not subscribed to `rootDoc`/`selectedNodeId`: the seed below is only read at
  // mount, so re-rendering on every dial frame or move would rebuild it for nothing.
  const hasDoc = usePatchStore((s) => s.rootDoc !== null)
  const filePath = usePatchStore((s) => s.filePath)
  const reloadNonce = usePatchStore((s) => s.reloadNonce)
  // A saved definition changes its instances' ports/params without touching this document, so
  // the library's own version is part of the remount key too.
  const libraryVersion = useSubpatchLibraryStore((s) => s.version)
  // Identifies this tab+file for nodeMeasurements.ts.
  const sessionKey = buildCanvasSessionKey(tabId, filePath)
  const remountKey = `${sessionKey}-${reloadNonce}-${libraryVersion}`

  const seed = useMemo(() => {
    const { rootDoc, selectedNodeId } = api.getState()
    return rootDoc ? patchDocToFlow(rootDoc, selectedNodeId) : null
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed exactly when the session remounts
  }, [api, remountKey, hasDoc])

  if (!seed) {
    return <div className="canvas-placeholder">Open a patch to get started.</div>
  }

  return (
    // ReactFlowProvider is required for PatchCanvasSession's own useReactFlow() call
    // (screenToFlowPosition, for cursor-relative paste placement) -- <ReactFlow> only extends
    // context to ITS OWN children, not to the sibling component that renders it.
    <ReactFlowProvider>
      <PatchCanvasSession
        // tabId first: two tabs can otherwise share an identical filePath/nonce combination
        // (e.g. two blank "untitled" tabs), which would silently skip a needed remount when
        // switching between them -- see CLAUDE.md's PatchCanvas-remount notes.
        key={remountKey}
        initialNodes={seed.nodes}
        initialEdges={seed.edges}
        sessionKey={sessionKey}
      />
    </ReactFlowProvider>
  )
}

export default PatchCanvas

import { useEffect, useMemo, useState } from 'react'
import { Copy, GripVertical, Info, Plus, X } from 'lucide-react'
import type { LoguePlatform } from '@shared/domain/patch'
import { UNIT_PARAM_NAME_MAX_LEN } from '@logue-codegen/nts1mkii/generateOscUnit'
import { useOptionalPatchStore } from '../state/patchStore'
import { useSubpatchLibraryStore } from '../state/subpatchLibraryStore'
import { useTargetPlatformStore } from '../state/targetPlatformStore'
import {
  describeDeviceControl,
  deviceLayout,
  hasDeviceControl,
  KNOB_LABEL,
  layoutModuleOf,
  listKnobAssignments,
  listParamMatrixRows,
  PLATFORM_LABEL,
  type DeviceControls,
  type FixedKnob,
  type ParamMatrixRow
} from '../state/exposedLogueParams'
import { useDraggableModal } from '../useDraggableModal'
import PlatformToggle from '../build/PlatformToggle'

type SetLogueParam = (
  id: string,
  paramName: string,
  value: string,
  logueParamIndex?: ParamMatrixRow['currentSlot'],
  label?: string
) => void

/** logue-sdk `platform/minilogue-xd/README.md`: "Up to about 10 characters can be displayed in
 *  the edit menu" -- longer names still load, just cut off on screen. */
const XD_PARAM_NAME_DISPLAY_LEN = 10

function rowKey(row: { nodeId: string; paramName: string }): string {
  return `${row.nodeId}\u0000${row.paramName}`
}

function matrixRowDomId(nodeId: string, paramName: string): string {
  return `param-matrix-row-${nodeId}-${paramName}`
}

type ParamRef = { nodeId: string; paramName: string; value: string }

const refOf = (row: ParamMatrixRow): ParamRef => ({
  nodeId: row.nodeId,
  paramName: row.paramName,
  value: row.currentValue
})

const controlsOf = (row: ParamMatrixRow): DeviceControls => ({
  logueParamIndex: row.currentSlot,
  logueKnob: row.currentKnob,
  logueFollow: row.currentFollow
})

/** A param (or subpatch instance) a knob or slot drives: click selects its node, x unbinds. */
function BoundChip({
  text,
  wiredTo,
  tooltip,
  focused,
  domId,
  onSelect,
  onRemove
}: {
  text: string
  wiredTo?: string[]
  tooltip: string
  focused?: boolean
  domId?: string
  onSelect: () => void
  onRemove?: () => void
}): React.JSX.Element {
  return (
    <span
      id={domId}
      className={'param-matrix__bound' + (focused ? ' param-matrix__bound--focused' : '')}
    >
      <span className="param-matrix__bound-text" onClick={onSelect} data-tooltip={tooltip}>
        {text}
        {wiredTo && wiredTo.length > 0 && (
          <span className="param-matrix__bound-wires"> → {wiredTo.join(', ')}</span>
        )}
      </span>
      {onRemove && (
        <button
          type="button"
          className="param-matrix__bound-remove"
          aria-label={`Remove ${text}`}
          data-tooltip="Remove"
          onClick={onRemove}
        >
          <X size={10} />
        </button>
      )}
    </span>
  )
}

function otherPlatformOf(platform: LoguePlatform): LoguePlatform {
  return platform === 'nts1mkii' ? 'minilogue-xd' : 'nts1mkii'
}

/**
 * A param's device name, editable for EVERY param (not just `logue/sense/param`): codegen already
 * uses `label || spec name` for all of them. The label is one value shared by both platforms.
 * Uncontrolled + blur commit; the caller keys it on the stored label so an undo remounts it.
 */
function DeviceNameField({
  row,
  setLogueParam
}: {
  row: ParamMatrixRow
  setLogueParam: SetLogueParam
}): React.JSX.Element {
  const [text, setText] = useState((row.currentLabel ?? '').trim())
  const length = text.length
  // The typed label is never cut (only a defaulted one is), so an over-long one fails an NTS-1
  // mkII export -- worth flagging whichever platform is being edited right now.
  const tooLongForNts = row.currentSlot?.nts1mkii !== undefined && length > UNIT_PARAM_NAME_MAX_LEN
  // Only a display limit (the SDK README's "up to about 10 characters"), so a soft warning.
  const longForXd =
    row.currentSlot?.['minilogue-xd'] !== undefined && length > XD_PARAM_NAME_DISPLAY_LEN
  // Rejected by the xd generator (would break manifest.json).
  const hasQuote = text.includes('"')
  const missing = row.requiresLabel && length === 0
  const invalid = missing || tooLongForNts || hasQuote

  return (
    <div className="param-matrix__name">
      <input
        type="text"
        className={
          'param-matrix__name-input' +
          (invalid
            ? ' param-matrix__name-input--invalid'
            : longForXd
              ? ' param-matrix__name-input--warn'
              : '')
        }
        defaultValue={row.currentLabel ?? ''}
        placeholder={row.requiresLabel ? 'Name required' : row.paramName}
        aria-label={`Device name for ${row.nodeName} ${row.paramName}`}
        data-tooltip={
          missing
            ? 'This param needs a name before it can be exported'
            : hasQuote
              ? 'Names can\'t contain a " character'
              : tooLongForNts
                ? `${PLATFORM_LABEL.nts1mkii} allows at most ${UNIT_PARAM_NAME_MAX_LEN} characters`
                : longForXd
                  ? `The ${PLATFORM_LABEL['minilogue-xd']} displays only about ${XD_PARAM_NAME_DISPLAY_LEN} characters`
                  : 'Name shown on the device -- leave empty for the default'
        }
        onChange={(e) => setText(e.target.value.trim())}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            e.stopPropagation()
            e.currentTarget.value = row.currentLabel ?? ''
            setText((row.currentLabel ?? '').trim())
            e.currentTarget.blur()
          }
        }}
        onBlur={(e) => {
          const trimmed = e.target.value.trim()
          const label =
            trimmed === '' || (!row.freeLabel && trimmed === row.paramName) ? undefined : trimmed
          setLogueParam(row.nodeId, row.paramName, row.currentValue, row.currentSlot, label)
        }}
      />
      {(tooLongForNts || longForXd) && (
        <span
          className={
            'param-matrix__name-count' + (tooLongForNts ? '' : ' param-matrix__name-count--warn')
          }
        >
          {length}/{tooLongForNts ? UNIT_PARAM_NAME_MAX_LEN : XD_PARAM_NAME_DISPLAY_LEN}
        </span>
      )}
    </div>
  )
}

/**
 * The device param editor, one platform at a time. The top list IS the device's controls: first
 * the fixed knobs (each listing every param put on it, any number), then the menu params in
 * device order (row n = the n-th assignable slot), each with the params following it. Drag a
 * menu row by its grip to reorder, x to remove; everything is laid out again through the store's
 * layout actions, which keep slots gap-free -- so minilogue xd's contiguity rule can't be broken
 * from here, and an NTS-1 mkII gap left by older files closes on the first edit. Below it, every
 * other param: click to add it as a menu param, or drag it onto a knob, or onto a menu param to
 * follow that one. A subpatch definition gets the knob rows only (it never owns a menu slot).
 *
 * Replaced an earlier every-param x every-platform grid whose per-cell up/down arrows swapped
 * slot numbers while the rows stayed put -- the device order was never actually visible.
 */
function ParamMatrixOverlay(): React.JSX.Element | null {
  const { modalRef, onHeaderPointerDown } = useDraggableModal()
  const rootDoc = useOptionalPatchStore((s) => s.rootDoc)
  const paramMatrix = useOptionalPatchStore((s) => s.paramMatrix)
  const closeParamMatrix = useOptionalPatchStore((s) => s.closeParamMatrix)
  const setLogueParam = useOptionalPatchStore((s) => s.setLogueParam)
  const setPlatformSlotOrder = useOptionalPatchStore((s) => s.setPlatformSlotOrder)
  const setKnobBinding = useOptionalPatchStore((s) => s.setKnobBinding)
  const setSlotFollow = useOptionalPatchStore((s) => s.setSlotFollow)
  const setSelectedNodeId = useOptionalPatchStore((s) => s.setSelectedNodeId)
  const platform = useTargetPlatformStore((s) => s.platform)
  const setPlatform = useTargetPlatformStore((s) => s.setPlatform)
  const [filterText, setFilterText] = useState('')
  // Dragging is armed from the grip only, so text selection inside the name field still works.
  const [armedKey, setArmedKey] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ from: number; insertAt: number | null } | null>(null)
  // A pool chip being dragged onto a knob (bind) or a menu param (follow), and the row under it.
  const [poolDrag, setPoolDrag] = useState<ParamMatrixRow | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  // A saved definition changes its instances' promoted params without touching `rootDoc`.
  const libraryVersion = useSubpatchLibraryStore((s) => s.version)
  const rows = useMemo(
    () => (rootDoc ? listParamMatrixRows(rootDoc) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rootDoc, libraryVersion]
  )
  const knobAssignments = useMemo(
    () => (rootDoc ? listKnobAssignments(rootDoc, platform) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rootDoc, libraryVersion, platform]
  )

  const focus = paramMatrix?.focus ?? null

  // Opened for a param assigned only on the other platform: show it where it actually lives.
  useEffect(() => {
    if (!focus) return
    const row = rows.find((r) => r.nodeId === focus.nodeId && r.paramName === focus.paramName)
    if (!row) return
    const current = useTargetPlatformStore.getState().platform
    const other = otherPlatformOf(current)
    const unsupportedHere = row.platforms !== undefined && !row.platforms.includes(current)
    const onlyOnOther =
      hasDeviceControl(controlsOf(row), other) && !hasDeviceControl(controlsOf(row), current)
    if (unsupportedHere || onlyOnOther) setPlatform(other)
    // Only for a fresh focus target, not on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nodeId, focus?.paramName])

  useEffect(() => {
    if (!focus) return
    document.getElementById(matrixRowDomId(focus.nodeId, focus.paramName))?.scrollIntoView({
      block: 'center'
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nodeId, focus?.paramName, platform])

  useEffect(() => {
    if (!armedKey) return
    const disarm = (): void => setArmedKey(null)
    window.addEventListener('mouseup', disarm)
    return () => window.removeEventListener('mouseup', disarm)
  }, [armedKey])

  if (!paramMatrix || !rootDoc || !knobAssignments) return null

  const isSubpatchDoc = rootDoc.settings.subpatch === true
  const other = otherPlatformOf(platform)
  const layout = deviceLayout(platform, layoutModuleOf(rootDoc))
  const reserved = [...layout.reserved.entries()].sort((a, b) => a[0] - b[0])
  // NTS-1 mkII's reserved slots ARE its fixed knobs (an oscillator's Shape pair, an effect's
  // TIME/DEPTH/MIX); the xd's knobs sit outside its 6 params.
  const reservedSlotOf = (knob: FixedKnob): number | undefined => layout.reservedSlotOf[knob]
  const capacity = layout.maxSlots - reserved.length
  // A definition, or a unit with no menu params at all (the xd's effects): knobs only.
  const knobsOnly = isSubpatchDoc || (layout.buildable && layout.maxSlots === 0)
  const assigned = isSubpatchDoc
    ? []
    : rows
        .filter((r) => r.currentSlot?.[platform] !== undefined)
        .sort((a, b) => a.currentSlot![platform]! - b.currentSlot![platform]!)
  const full = assigned.length >= capacity
  const assignedOnOther = rows
    .filter((r) => r.currentSlot?.[other] !== undefined)
    .filter((r) => !r.platforms || r.platforms.includes(platform))
    .sort((a, b) => a.currentSlot![other]! - b.currentSlot![other]!)
  const followersOf = (lead: ParamMatrixRow): ParamMatrixRow[] =>
    rows.filter((r) => r.currentFollow?.[platform] === lead.currentSlot![platform])

  const commit = (order: ParamMatrixRow[]): void => setPlatformSlotOrder(platform, order.map(refOf))

  const q = filterText.trim().toLowerCase()
  // A follower of a slot nobody owns (possible in a file edited elsewhere) is offered again:
  // it has no working control, and any layout edit drops the stale follow.
  const ownedSlots = new Set(assigned.map((r) => r.currentSlot![platform]))
  const orphaned = (r: ParamMatrixRow): boolean =>
    r.currentSlot?.[platform] === undefined &&
    r.currentKnob?.[platform] === undefined &&
    r.currentFollow?.[platform] !== undefined &&
    !ownedSlots.has(r.currentFollow[platform])
  const available = rows
    .filter((r) => !hasDeviceControl(controlsOf(r), platform) || orphaned(r))
    .filter((r) => !r.platforms || r.platforms.includes(platform))
    .filter(
      (r) =>
        q === '' ||
        r.nodeName.toLowerCase().includes(q) ||
        r.paramName.toLowerCase().includes(q) ||
        r.displayName.toLowerCase().includes(q)
    )
  const availableByNode = new Map<string, ParamMatrixRow[]>()
  for (const row of [...available].sort((a, b) => a.nodeName.localeCompare(b.nodeName))) {
    const list = availableByNode.get(row.nodeId) ?? []
    list.push(row)
    availableByNode.set(row.nodeId, list)
  }

  const isFocused = (row: { nodeId: string; paramName?: string }): boolean =>
    focus?.nodeId === row.nodeId && focus.paramName === row.paramName

  const finishDrag = (): void => {
    setDrag(null)
    setArmedKey(null)
  }
  const finishPoolDrag = (): void => {
    setPoolDrag(null)
    setDropTarget(null)
  }

  const onDrop = (): void => {
    if (!drag || drag.insertAt === null) return finishDrag()
    const { from, insertAt } = drag
    const to = insertAt > from ? insertAt - 1 : insertAt
    if (to !== from) {
      const next = [...assigned]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      commit(next)
    }
    finishDrag()
  }

  /** Drag handlers making a row accept a pool chip. */
  const poolDropHandlers = (
    targetKey: string,
    accept: (row: ParamMatrixRow) => void
  ): Pick<React.HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'> => ({
    onDragOver: (e) => {
      if (!poolDrag) return
      e.preventDefault()
      e.stopPropagation()
      if (dropTarget !== targetKey) setDropTarget(targetKey)
    },
    onDragLeave: () => {
      if (dropTarget === targetKey) setDropTarget(null)
    },
    onDrop: (e) => {
      if (!poolDrag) return
      e.preventDefault()
      e.stopPropagation()
      accept(poolDrag)
      finishPoolDrag()
    }
  })

  const fixedKnobNames = layout.knobs
    .filter((knob) => reservedSlotOf(knob) !== undefined)
    .map((knob) => KNOB_LABEL[knob][platform])
  // The how-it-works text lives in tooltips; only a state the user can't otherwise see (a
  // subpatch, an unbuildable or knobs-only unit, every slot used) stays as a line of its own.
  const footnoteIsNotice = isSubpatchDoc || !layout.buildable || knobsOnly
  const footnote = isSubpatchDoc
    ? `A subpatch has no menu params of its own -- promote params in the Inspector, then assign them on each placed instance. A knob here drives every instance.`
    : !layout.buildable
      ? `This kind of unit can't be built for the ${PLATFORM_LABEL[platform]} yet.`
      : knobsOnly
        ? `This kind of unit has no menu params on the ${PLATFORM_LABEL[platform]} -- only its knobs, above.`
        : reserved.length === 0
          ? `The ${PLATFORM_LABEL[platform]} shows these as Param 1–${layout.maxSlots} in this order; its knobs are not Params. Drag to reorder.`
          : `Param ${reserved.map(([i]) => i + 1).join('/')} are the fixed ${fixedKnobNames.join(', ')} on every unit; your params follow in this order. Drag to reorder.`

  return (
    <div className="modal-overlay modal-overlay--top-anchored" onClick={closeParamMatrix}>
      <div ref={modalRef} className="modal param-matrix-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header" onPointerDown={onHeaderPointerDown}>
          <span>Device Params</span>
          <button onClick={closeParamMatrix} aria-label="Close" data-tooltip="Close">
            <X size={14} />
          </button>
        </div>
        <div className="modal__body param-matrix-modal__body">
          <div className="param-matrix__toolbar">
            <PlatformToggle
              ariaLabel="Device"
              tooltip={(p) => `Edit ${PLATFORM_LABEL[p]}'s params (also the Build target)`}
            />
            <span className="param-matrix__count">
              {!knobsOnly && `${assigned.length} of ${capacity} used`}
              {!footnoteIsNotice && (
                <span className="param-matrix__info" data-tooltip={footnote} aria-label={footnote}>
                  <Info size={13} />
                </span>
              )}
            </span>
          </div>

          <div className="param-matrix__scroll">
            <ol
              className="param-matrix__slots"
              onDragOver={(e) => drag && e.preventDefault()}
              onDrop={onDrop}
            >
              {layout.knobs.map((knob) => {
                const slot = reservedSlotOf(knob)
                const targetKey = `knob-${knob}`
                const entries = knobAssignments[knob]
                return (
                  <li
                    key={targetKey}
                    className={
                      'param-matrix__slot param-matrix__slot--fixed' +
                      (dropTarget === targetKey ? ' param-matrix__slot--drop-target' : '')
                    }
                    {...poolDropHandlers(targetKey, (row) =>
                      setKnobBinding(platform, refOf(row), knob)
                    )}
                  >
                    <span className="param-matrix__grip" />
                    <span className="param-matrix__slot-number">
                      {slot === undefined ? '' : slot + 1}
                    </span>
                    <span
                      className="param-matrix__fixed-text"
                      data-tooltip={
                        slot === undefined
                          ? `The ${PLATFORM_LABEL[platform]}'s own knob, not one of the Params -- drag a param here to put it on this knob`
                          : `${layout.reserved.get(slot)} -- drag a param here to put it on this knob`
                      }
                    >
                      {KNOB_LABEL[knob][platform]}
                    </span>
                    <span className="param-matrix__routes">
                      {entries.length === 0 && (
                        <span className="param-matrix__routes--none">
                          {poolDrag ? 'drop to put it on this knob' : 'not used'}
                        </span>
                      )}
                      {entries.map((entry) => (
                        <BoundChip
                          key={`${entry.nodeId}-${entry.paramName ?? ''}`}
                          domId={
                            entry.paramName !== undefined
                              ? matrixRowDomId(entry.nodeId, entry.paramName)
                              : undefined
                          }
                          focused={isFocused(entry)}
                          text={
                            entry.insideSubpatch
                              ? `${entry.nodeName} (inside)`
                              : entry.paramName === undefined
                                ? entry.nodeName
                                : `${entry.nodeName} · ${entry.paramName}`
                          }
                          wiredTo={entry.wiredTo}
                          tooltip={
                            entry.insideSubpatch
                              ? `Bound inside the ${entry.nodeName} subpatch -- select it`
                              : entry.legacy
                                ? `An older reader of this knob -- reopen the file to update it`
                                : 'Select this node on canvas'
                          }
                          onSelect={() => setSelectedNodeId(entry.nodeId)}
                          onRemove={
                            entry.paramName === undefined
                              ? undefined
                              : () => {
                                  const row = rows.find(
                                    (r) =>
                                      r.nodeId === entry.nodeId && r.paramName === entry.paramName
                                  )
                                  if (row) setKnobBinding(platform, refOf(row), null)
                                }
                          }
                        />
                      ))}
                    </span>
                  </li>
                )
              })}
              {assigned.map((row, i) => {
                const key = rowKey(row)
                const targetKey = `slot-${key}`
                const followers = followersOf(row)
                const dropBefore = drag?.insertAt === i && drag.from !== i && drag.from !== i - 1
                const dropAfter =
                  i === assigned.length - 1 && drag?.insertAt === assigned.length && drag.from !== i
                const pool = poolDropHandlers(targetKey, (dropped) =>
                  setSlotFollow(platform, refOf(dropped), {
                    nodeId: row.nodeId,
                    paramName: row.paramName
                  })
                )
                return (
                  <li
                    key={key}
                    id={matrixRowDomId(row.nodeId, row.paramName)}
                    className={
                      'param-matrix__slot' +
                      (isFocused(row) ? ' param-matrix__slot--focused' : '') +
                      (drag?.from === i ? ' param-matrix__slot--dragging' : '') +
                      (dropBefore ? ' param-matrix__slot--drop-before' : '') +
                      (dropAfter ? ' param-matrix__slot--drop-after' : '') +
                      (dropTarget === targetKey ? ' param-matrix__slot--drop-target' : '')
                    }
                    draggable={armedKey === key}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', key)
                      setDrag({ from: i, insertAt: null })
                    }}
                    onDragOver={(e) => {
                      if (poolDrag) return pool.onDragOver!(e)
                      if (!drag) return
                      e.preventDefault()
                      const rect = e.currentTarget.getBoundingClientRect()
                      const insertAt = e.clientY < rect.top + rect.height / 2 ? i : i + 1
                      if (insertAt !== drag.insertAt) setDrag({ ...drag, insertAt })
                    }}
                    onDragLeave={pool.onDragLeave}
                    onDrop={(e) => {
                      if (poolDrag) pool.onDrop!(e)
                    }}
                    onDragEnd={finishDrag}
                  >
                    <span
                      className="param-matrix__grip"
                      onMouseDown={() => setArmedKey(key)}
                      data-tooltip="Drag to reorder"
                    >
                      <GripVertical size={14} />
                    </span>
                    <span className="param-matrix__slot-number">
                      {row.currentSlot![platform]! + 1}
                    </span>
                    <span
                      className="param-matrix__source"
                      onClick={() => setSelectedNodeId(row.nodeId)}
                      data-tooltip="Select this node on canvas"
                    >
                      {row.nodeName} · {row.paramName}
                    </span>
                    <DeviceNameField
                      key={`${key}-${row.currentLabel ?? ''}`}
                      row={row}
                      setLogueParam={setLogueParam}
                    />
                    <span
                      className="param-matrix__other"
                      data-tooltip={
                        hasDeviceControl(controlsOf(row), other)
                          ? `${describeDeviceControl(controlsOf(row), other)} on ${PLATFORM_LABEL[other]}`
                          : `Not assigned on ${PLATFORM_LABEL[other]}`
                      }
                    >
                      {hasDeviceControl(controlsOf(row), other)
                        ? `${PLATFORM_LABEL[other]} ${describeDeviceControl(controlsOf(row), other)}`
                        : ''}
                    </span>
                    <button
                      type="button"
                      className="param-matrix__icon-button"
                      aria-label="Remove from device"
                      data-tooltip={
                        followers.length > 0
                          ? 'Remove from device (its followers too)'
                          : 'Remove from device'
                      }
                      onClick={() => commit(assigned.filter((r) => rowKey(r) !== key))}
                    >
                      <X size={12} />
                    </button>
                    {(followers.length > 0 || dropTarget === targetKey) && (
                      <span className="param-matrix__followers">
                        {followers.map((f) => (
                          <BoundChip
                            key={rowKey(f)}
                            domId={matrixRowDomId(f.nodeId, f.paramName)}
                            focused={isFocused(f)}
                            text={`↳ ${f.nodeName} · ${f.paramName}`}
                            tooltip={`Follows ${row.displayName}, mapped into its own range -- select it`}
                            onSelect={() => setSelectedNodeId(f.nodeId)}
                            onRemove={() => setSlotFollow(platform, refOf(f), null)}
                          />
                        ))}
                        {dropTarget === targetKey && (
                          <span className="param-matrix__routes--none">
                            drop to follow {row.displayName}
                          </span>
                        )}
                      </span>
                    )}
                  </li>
                )
              })}
              {!knobsOnly && assigned.length === 0 && (
                <li className="param-matrix__slot param-matrix__slot--empty">
                  <span>No menu params on the {PLATFORM_LABEL[platform]} yet.</span>
                  {/* The likely next step when the other device is already laid out. */}
                  {assignedOnOther.length > 0 && (
                    <button
                      type="button"
                      className="param-matrix__copy-order"
                      onClick={() => commit(assignedOnOther)}
                    >
                      <Copy size={12} />
                      Use the {PLATFORM_LABEL[other]}&apos;s {assignedOnOther.length}
                    </button>
                  )}
                </li>
              )}
            </ol>
            {footnoteIsNotice && <p className="param-matrix__footnote">{footnote}</p>}

            <div className="param-matrix__add">
              <div className="param-matrix__add-header">
                <span
                  className="param-matrix__add-title"
                  data-tooltip={
                    knobsOnly
                      ? 'Drag a param onto a knob above.'
                      : 'Click a param to add it as a menu param, or drag it onto a knob, or onto a menu param to follow it.'
                  }
                >
                  {knobsOnly ? 'Put a param on a knob' : 'Add a param'}
                  <Info size={12} />
                </span>
                <input
                  type="text"
                  className="param-matrix__filter"
                  placeholder="Filter by node or param…"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                />
              </div>
              {full && !knobsOnly && (
                <p className="param-matrix__footnote">
                  All {capacity} menu slots are used -- drag a param onto a knob, or onto a menu
                  param to follow it.
                </p>
              )}
              {[...availableByNode.entries()].map(([nodeKey, params]) => (
                <div key={nodeKey} className="param-matrix__add-node">
                  <span
                    className="param-matrix__add-node-name"
                    onClick={() => setSelectedNodeId(nodeKey)}
                    data-tooltip="Select this node on canvas"
                  >
                    {params[0].nodeName}
                  </span>
                  <div className="param-matrix__chips">
                    {params.map((row) => {
                      const elsewhere = hasDeviceControl(controlsOf(row), other)
                      const clickAdds = !knobsOnly && !full
                      return (
                        <button
                          key={rowKey(row)}
                          id={matrixRowDomId(row.nodeId, row.paramName)}
                          type="button"
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = 'link'
                            e.dataTransfer.setData('text/plain', rowKey(row))
                            setPoolDrag(row)
                          }}
                          onDragEnd={finishPoolDrag}
                          className={
                            'param-matrix__chip' +
                            (clickAdds ? '' : ' param-matrix__chip--drag-only') +
                            (isFocused(row) ? ' param-matrix__chip--focused' : '') +
                            (elsewhere ? ' param-matrix__chip--elsewhere' : '')
                          }
                          data-tooltip={
                            (clickAdds
                              ? `Add to the ${PLATFORM_LABEL[platform]}, or drag onto a knob`
                              : 'Drag onto a knob' + (knobsOnly ? '' : ' or a menu param')) +
                            (elsewhere
                              ? ` -- already ${describeDeviceControl(controlsOf(row), other)} on ${PLATFORM_LABEL[other]}`
                              : '')
                          }
                          onClick={() => clickAdds && commit([...assigned, row])}
                        >
                          <Plus size={10} />
                          {row.paramName}
                          {row.displayName !== row.paramName && (
                            <span className="param-matrix__chip-label">“{row.displayName}”</span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
              {availableByNode.size === 0 && (
                <p className="param-matrix__footnote">
                  {q !== ''
                    ? 'No params match this filter.'
                    : rows.length === 0
                      ? 'No params on this document yet -- place a *logue primitive first.'
                      : 'Every param already has a device control.'}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ParamMatrixOverlay

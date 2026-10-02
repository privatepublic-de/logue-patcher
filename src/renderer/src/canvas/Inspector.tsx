import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Grid3x3, Upload } from 'lucide-react'
import { useOptionalPatchStore } from '../state/patchStore'
import { nodeId } from '../state/nodeId'
import { nodeTypeLabel } from './nodeTypeLabel'
import {
  findAliasedFieldValue,
  presentationKeyOf,
  snapToStep,
  type PrimitiveParamSpec
} from '@logue-codegen/primitives'
import {
  LOGUE_AUDIO_IN_DESCRIPTION,
  LOGUE_AUDIO_IN_TYPE,
  LOGUE_AUDIO_OUT_DESCRIPTION,
  LOGUE_AUDIO_OUT_TYPE
} from '@logue-codegen/oscInstances'
import { defaultPromotedParamName, isSubpatchInstanceType } from '@logue-codegen/subpatches'
import {
  resolveNodePrimitive,
  subpatchEntry,
  useSubpatchLibraryStore
} from '../state/subpatchLibraryStore'
import { openSubpatchDefinition } from '../state/openSubpatchDefinition'
import {
  findUnresolvedReferences,
  type UnresolvedReference
} from '@logue-codegen/unresolvedReferences'
import {
  describeUnresolvedReference,
  summarizeUnresolvedReference
} from './describeUnresolvedReference'
import {
  dependentUnit,
  findDisplayUnit,
  findUnitDependency,
  type ParamUnit
} from '@logue-codegen/paramUnits'
import {
  findBooleanWidget,
  findParamTrackGate,
  type BooleanParamWidget,
  type ParamTrackGate
} from '@logue-codegen/paramTrackGate'
import type { PatchDocument } from '@shared/domain/patch'
import type { LogueParamSlot, LogueKnobBinding } from '@shared/domain/paramValueTypes'
import { describeExposedSlots } from '../state/exposedLogueParams'
import { isNodeTrackGated } from './trackGateState'
import { stripLoguePrefix } from '../browser/loguePrimitiveCatalog'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import SampleSection from './SampleSection'
import { SlotBadges } from './ParamDial'
import WarningLine from '../build/WarningLine'
import { hasDeviceControl, ALL_LOGUE_PLATFORMS } from '../state/exposedLogueParams'
import type { ParamValue } from '@shared/domain/paramValueTypes'
import type { SampleLoopMode } from '@logue-codegen/sample/playbackOrder'

/**
 * A selected node's editable properties: Name, Type (shown without the `logue/` root segment, as
 * on the canvas titlebar via `stripLoguePrefix`; the full id is in the `title`), one row per
 * declared param, and last the primitive's user-facing `description` (`logue/io/audio-out` has no
 * registry entry, so it's special-cased, see `LOGUE_AUDIO_OUT_DESCRIPTION` in oscInstances.ts).
 *
 * Device slots and device labels are edited only in `ParamMatrixOverlay.tsx`, so there is one
 * editor for both platforms and nothing to disagree with it: each row's device tag (the canvas
 * dial's own `SlotBadges`, or a faint grid icon when there's none) or a right-click opens it
 * focused on that param.
 */

function ParamRow({
  nodeIdValue,
  spec,
  unit,
  trackGate,
  booleanWidget,
  paramValue,
  setLogueParam,
  rootDoc,
  onContextMenu,
  openParamMatrix,
  nodeName,
  setSubpatchExpose
}: {
  nodeIdValue: string
  spec: PrimitiveParamSpec
  /** See ParamDial.tsx's own `unit` prop -- kept in sync with the canvas dial's own display so
   *  this field and that knob never disagree about what a param's number means. */
  unit: ParamUnit | undefined
  /** See ParamDial.tsx's own `trackGate` prop -- only used here to suppress `unit` while gated
   *  (showing e.g. "5.31 ms" for a currently pitch-tracked CUTOFF would be wrong); this field
   *  doesn't get the canvas dial's own ring/badge treatment, just the plain number back. */
  trackGate: ParamTrackGate | undefined
  /** See ParamDial.tsx's own `booleanWidget` prop -- kept in sync with the canvas dial's own
   *  checkbox rendering for the same param. */
  booleanWidget: BooleanParamWidget | undefined
  paramValue:
    | {
        value: string
        logueParamIndex?: LogueParamSlot
        logueKnob?: LogueKnobBinding
        logueFollow?: LogueParamSlot
        label?: string
        subpatchExpose?: { outerName: string }
      }
    | undefined
  setLogueParam: (
    id: string,
    paramName: string,
    value: string,
    logueParamIndex?: LogueParamSlot,
    label?: string
  ) => void
  rootDoc: PatchDocument
  /** Right-click anywhere on this row -- opens `ParamMatrixOverlay.tsx` focused on this param.
   *  Inspector.tsx owns the actual menu/overlay state
   *  (see its own `contextMenu` local state) since a menu needs to render once, not per-row. */
  onContextMenu: (screenPos: { x: number; y: number }, paramName: string) => void
  /** The row's own explicit Param Matrix button (phase 6) calls this directly -- no menu step,
   *  unlike the right-click above, since a visible button is already an explicit choice. */
  openParamMatrix: (focus: { nodeId: string; paramName: string }) => void
  nodeName: string
  /** Set only while editing a subpatch definition: there a param can't get a device slot (the
   *  definition never owns one), so the row offers promotion onto the subpatch's outer
   *  interface instead of the Param Matrix. */
  setSubpatchExpose?: (id: string, paramName: string, outerName: string | null) => void
}): React.JSX.Element {
  const exposedAs = paramValue?.subpatchExpose?.outerName
  const currentValue = paramValue?.value ?? String(spec.default)
  // The FULL per-platform map, passed through unchanged whenever this row edits value/label/
  // checkbox -- this row no longer edits the slot itself at all (phase 6, ParamMatrixOverlay.tsx
  // is the one place that happens now), so nothing here ever produces a NEW map anymore.
  const currentIndexMap = paramValue?.logueParamIndex
  // '' for every non-freeLabel param (nothing else ever sets `label`) -- read-only here (phase 7
  // moved the actual editor into ParamMatrixOverlay.tsx's own Param column), just passed through
  // unchanged on every value/checkbox edit below so editing either one never clobbers the other.
  const currentLabel = paramValue?.label ?? ''
  const gated = isNodeTrackGated(rootDoc, nodeIdValue, trackGate)
  const effectiveUnit = gated ? undefined : unit
  const shownValue = effectiveUnit ? effectiveUnit.toDisplay(Number(currentValue)) : currentValue

  const inputId = useId()
  const rangeTooltip = `${spec.name}: ${spec.min} to ${spec.max}`
  const hasControl =
    !!paramValue && ALL_LOGUE_PLATFORMS.some((p) => hasDeviceControl(paramValue, p))

  // `display: contents`: the row's cells sit in `.inspector__params`' grid, so every value field
  // lines up whatever the label's length. Right-clicks still bubble up to it.
  return (
    <div
      className="inspector__param-row"
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu({ x: e.clientX, y: e.clientY }, spec.name)
      }}
    >
      <label className="inspector__param-label" htmlFor={inputId} data-tooltip={rangeTooltip}>
        {booleanWidget ? booleanWidget.label : spec.name}
      </label>
      {booleanWidget ? (
        <span className="inspector__param-value">
          <input
            id={inputId}
            type="checkbox"
            className="param-widget__checkbox-input"
            key={`${nodeIdValue}-${spec.name}-value-${currentValue}`}
            defaultChecked={Number(currentValue) >= booleanWidget.threshold}
            onChange={(e) =>
              setLogueParam(
                nodeIdValue,
                spec.name,
                String(e.target.checked ? booleanWidget.onValue : booleanWidget.offValue),
                currentIndexMap,
                currentLabel || undefined
              )
            }
          />
        </span>
      ) : (
        // A unit-bearing param (@logue-codegen/paramUnits) is a plain text field showing/accepting
        // e.g. "+18.1 dB" or "1995 ms" -- a native number input can't hold that text, and
        // min/max no longer mean anything in the unit's own domain. An unparseable edit is
        // silently discarded (falls back to `currentValue`), matching ParamDial.tsx.
        // `effectiveUnit` (not `unit`) so a track-gated param (e.g. CUTOFF while TRACK is on)
        // shows its plain raw number here too, instead of a unit that's currently meaningless.
        <input
          id={inputId}
          className="inspector__param-value inspector__param-input"
          type={effectiveUnit ? 'text' : 'number'}
          min={effectiveUnit ? undefined : spec.min}
          max={effectiveUnit ? undefined : spec.max}
          data-tooltip={rangeTooltip}
          // Keying on the CURRENT value (not just node+param) forces a remount -- and so a
          // fresh `defaultValue` -- whenever this param changes from elsewhere (e.g. dragging
          // the same param's ParamDial.tsx knob directly on the canvas node), which a plain
          // uncontrolled input would otherwise show stale until next manually edited here.
          // The shown text is in the key too: a unit can change with another param (RANGE).
          key={`${nodeIdValue}-${spec.name}-value-${currentValue}-${shownValue}`}
          defaultValue={shownValue}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          onBlur={(e) => {
            // Unitless case: pass the raw text straight through -- except a `spec.step` param
            // (e.g. COARSE) still gets snapped, matching ParamDial.tsx's own commit path, so
            // typing "3.5" here can't leave a fractional value the dial itself would never
            // produce. Unit case: parse the typed unit back to the param's own raw domain,
            // discarding an unparseable edit (falls back to `currentValue`), then snap the same
            // way.
            const next = effectiveUnit
              ? (() => {
                  const parsed = effectiveUnit.parseInput(e.target.value)
                  return parsed !== undefined && Number.isFinite(parsed)
                    ? String(snapToStep(parsed, spec.step))
                    : currentValue
                })()
              : !spec.step
                ? e.target.value
                : (() => {
                    const parsed = Number.parseFloat(e.target.value)
                    return Number.isFinite(parsed)
                      ? String(snapToStep(parsed, spec.step))
                      : e.target.value
                  })()
            setLogueParam(nodeIdValue, spec.name, next, currentIndexMap, currentLabel || undefined)
          }}
        />
      )}
      {setSubpatchExpose ? (
        <>
          <button
            type="button"
            className={
              'inspector__param-device' +
              (exposedAs ? ' inspector__param-device--active' : ' inspector__param-device--unset')
            }
            aria-pressed={!!exposedAs}
            onClick={() =>
              setSubpatchExpose(
                nodeIdValue,
                spec.name,
                exposedAs ? null : defaultPromotedParamName(nodeName, spec.name)
              )
            }
            data-tooltip={
              exposedAs
                ? `Exposed on the subpatch as "${exposedAs}" -- click to stop exposing it`
                : 'Expose on subpatch -- show this param as a dial on every placed instance'
            }
            aria-label={`Expose ${spec.name} on subpatch`}
          >
            <Upload size={12} />
          </button>
          {exposedAs && (
            <label className="inspector__promoted-name">
              <span>as</span>
              <input
                key={`${nodeIdValue}-${spec.name}-exposed-${exposedAs}`}
                defaultValue={exposedAs}
                onBlur={(e) =>
                  setSubpatchExpose(
                    nodeIdValue,
                    spec.name,
                    e.target.value.trim() || defaultPromotedParamName(nodeName, spec.name)
                  )
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
              />
            </label>
          )}
        </>
      ) : spec.structural ? (
        <span />
      ) : (
        // The canvas dial's own device tags ("n1 5", "xd SHP"), so the row says what the
        // control is; with none, a faint grid icon that shows on hover. Either opens the Matrix.
        <button
          type="button"
          className={
            'inspector__param-device' + (hasControl ? '' : ' inspector__param-device--unset')
          }
          onClick={() => openParamMatrix({ nodeId: nodeIdValue, paramName: spec.name })}
          data-tooltip={(() => {
            const described = describeExposedSlots(paramValue)
            return described
              ? `${described} -- click to change it in the Device Param Matrix`
              : 'No device control -- click to assign one in the Device Param Matrix'
          })()}
          aria-label={`Configure ${spec.name} in Param Matrix`}
        >
          {hasControl ? <SlotBadges controls={paramValue} /> : <Grid3x3 size={12} />}
        </button>
      )}
    </div>
  )
}

/** Clamped to a few lines until "More" -- reference text, so it shouldn't push edits out of view. */
function Description({ text }: { text: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const ref = useRef<HTMLParagraphElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && !expanded) setOverflows(el.scrollHeight > el.clientHeight + 1)
  }, [text, expanded])
  return (
    <div className="inspector__description-block">
      <p
        ref={ref}
        className={'inspector__description' + (expanded ? '' : ' inspector__description--clamped')}
      >
        {text}
      </p>
      {(overflows || expanded) && (
        <button
          type="button"
          className="build-panel__hint-link inspector__description-toggle"
          onClick={() => setExpanded((x) => !x)}
        >
          {expanded ? 'Less' : 'More'}
        </button>
      )}
    </div>
  )
}

function Inspector(): React.JSX.Element {
  const rootDoc = useOptionalPatchStore((s) => s.rootDoc)
  const selectedNodeId = useOptionalPatchStore((s) => s.selectedNodeId)
  const selectedNodeIds = useOptionalPatchStore((s) => s.selectedNodeIds)
  const renameNode = useOptionalPatchStore((s) => s.renameNode)
  const setLogueParam = useOptionalPatchStore((s) => s.setLogueParam)
  const openParamMatrix = useOptionalPatchStore((s) => s.openParamMatrix)
  const setSubpatchExpose = useOptionalPatchStore((s) => s.setSubpatchExpose)
  const removeParamValue = useOptionalPatchStore((s) => s.removeParamValue)
  const setNodeSample = useOptionalPatchStore((s) => s.setNodeSample)
  useSubpatchLibraryStore((s) => s.version)
  const inSubpatch = rootDoc?.settings.subpatch === true
  const [collapsed, setCollapsed] = useState(false)
  // A single right-click menu shared by every ParamRow below -- rendered once here (not
  // per-row) since only one can ever be open at a time. Its one item opens
  // ParamMatrixOverlay.tsx focused on whichever param was right-clicked.
  const [contextMenu, setContextMenu] = useState<{
    screenPos: { x: number; y: number }
    items: ContextMenuItem[]
  } | null>(null)

  const selectedNode =
    rootDoc && selectedNodeId
      ? rootDoc.nodes.find((n, i) => nodeId(n, i) === selectedNodeId)
      : undefined

  // `selectedNodeId` is already null whenever more than one node is selected (see
  // PatchCanvas.tsx's onSelectionChange), so every show*-flag below naturally stays false
  // during a multi-select without any extra gating -- only the collapsed-title/hint text needs
  // this count.
  const multiSelectCount = selectedNodeIds.length > 1 ? selectedNodeIds.length : 0
  const hasSelection = !!selectedNode || multiSelectCount > 0

  // Comments have no meaningful `name` (they're edited on-canvas via their own text instead,
  // see CommentNode.tsx) -- every obj node gets this field.
  const showNameField = !!selectedNode && selectedNode.kind !== 'comment'
  const typeLabel = selectedNode && nodeTypeLabel(selectedNode)
  // The "logue/" root is implied everywhere a *logue type shows in this app (every id this
  // app can insert has it, see stripLoguePrefix's own doc comment) -- ObjectNode.tsx's own
  // titlebar already strips it, this just matches that convention. `title` below keeps the
  // FULL id (untouched) as a hover tooltip, so the raw type is still one hover away.
  const displayTypeLabel =
    typeLabel && typeLabel.startsWith('logue/') ? stripLoguePrefix(typeLabel) : typeLabel
  const selectedPrimitive =
    selectedNode?.kind === 'obj' ? resolveNodePrimitive(selectedNode.type) : undefined
  // Promotion edits the DEFINITION's own inner params; a subpatch instance's params are already
  // the promoted ones, so they re-promote only when this is itself inside a definition.
  const promotable = inSubpatch && selectedNode?.kind === 'obj'
  const paramSpecs = selectedPrimitive?.params ?? []
  // See `unresolvedReferences.ts`'s own doc comment for the incident this closes: a renamed/
  // merged primitive id, or a param/inlet name a rename left behind, used to fail completely
  // silently -- this is the one place a selected node's own problems get spelled out in full
  // (`ObjectNode.tsx`'s canvas badge is the at-a-glance counterpart, this is the explanation).
  const unresolvedReferences: UnresolvedReference[] =
    rootDoc && selectedNode?.kind === 'obj'
      ? findUnresolvedReferences(rootDoc, selectedNode, resolveNodePrimitive)
      : []
  // `logue/io/audio-out` is a pseudo-object with no LoguePrimitive registry entry of its own
  // (see LOGUE_AUDIO_OUT_DESCRIPTION's own doc comment) -- special-cased here rather than
  // adding a fake registry entry just to carry one string.
  const description =
    selectedNode?.kind === 'obj'
      ? selectedNode.type === LOGUE_AUDIO_OUT_TYPE
        ? LOGUE_AUDIO_OUT_DESCRIPTION
        : selectedNode.type === LOGUE_AUDIO_IN_TYPE
          ? LOGUE_AUDIO_IN_DESCRIPTION
          : selectedPrimitive?.description
      : undefined
  const hasAnyContent =
    showNameField || paramSpecs.length > 0 || !!description || unresolvedReferences.length > 0

  const collapsedStatus =
    multiSelectCount > 0
      ? `${multiSelectCount} selected`
      : selectedNode
        ? selectedNode.name || selectedNode.kind
        : 'Nothing selected'

  return (
    <div
      className={
        'inspector' +
        (hasSelection ? ' inspector--selected' : '') +
        (collapsed ? ' inspector--collapsed' : '')
      }
    >
      <div
        className="inspector__toolbar"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand Inspector' : 'Collapse Inspector'}
        onClick={() => setCollapsed((c) => !c)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          setCollapsed((c) => !c)
        }}
      >
        <span className="inspector__toggle" aria-hidden="true">
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </span>
        <span className="inspector__title">Inspector</span>
        {collapsed && <span className="inspector__toolbar-status">{collapsedStatus}</span>}
        {/* Document-wide, so it stays put regardless of selection or collapse. Inside the
            toggle row, hence stopPropagation -- a click here must not also collapse the panel.
            aria-disabled rather than `disabled` so GlobalTooltip still gets its mouseover. */}
        <button
          type="button"
          className="inspector__toolbar-button"
          aria-disabled={!rootDoc}
          onClick={(e) => {
            e.stopPropagation()
            if (rootDoc) openParamMatrix()
          }}
          onKeyDown={(e) => e.stopPropagation()}
          data-tooltip="Device Param Matrix -- every exposed param, both platforms at once"
          aria-label="Open Device Param Matrix"
        >
          <Grid3x3 size={12} />
        </button>
      </div>
      {!collapsed && multiSelectCount > 0 && (
        <span className="inspector__hint">{multiSelectCount} objects selected</span>
      )}
      {!collapsed && multiSelectCount === 0 && !hasAnyContent && (
        <span className="inspector__hint">
          {selectedNode ? 'Nothing to configure here' : 'Nothing selected'}
        </span>
      )}
      {!collapsed && displayTypeLabel && (
        <div className="inspector__type" title={typeLabel}>
          {displayTypeLabel}
          {typeLabel && isSubpatchInstanceType(typeLabel) && (
            <button
              type="button"
              className="build-panel__hint-link inspector__edit-subpatch"
              onClick={() => void openSubpatchDefinition(typeLabel)}
            >
              Edit subpatch
            </button>
          )}
        </div>
      )}
      {!collapsed &&
        typeLabel &&
        isSubpatchInstanceType(typeLabel) &&
        subpatchEntry(typeLabel)?.source === 'local' && (
          <span className="inspector__hint" title={subpatchEntry(typeLabel)!.filePath}>
            From this patch&apos;s folder (overrides the library):{' '}
            {subpatchEntry(typeLabel)!.filePath.split('/').pop()}
          </span>
        )}
      {!collapsed && unresolvedReferences.length > 0 && (
        <div className="inspector__unresolved-list">
          {unresolvedReferences.map((ref, i) => (
            <WarningLine
              key={i}
              summary={summarizeUnresolvedReference(ref)}
              tone={ref.kind === 'renamed-type' ? 'info' : 'warning'}
            >
              {describeUnresolvedReference(ref)}
              {ref.kind === 'stale-param' && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="build-panel__hint-link"
                    onClick={() => removeParamValue(selectedNodeId!, ref.rawName)}
                  >
                    Remove
                  </button>
                </>
              )}
            </WarningLine>
          ))}
        </div>
      )}
      {!collapsed && showNameField && selectedNode && (
        <label className="inspector__field inspector__field--inline">
          <span>Name</span>
          <input
            key={selectedNode.name}
            defaultValue={selectedNode.name ?? ''}
            onBlur={(e) => renameNode(selectedNodeId!, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
          />
        </label>
      )}
      {!collapsed && selectedNode?.kind === 'obj' && paramSpecs.length > 0 && rootDoc && (
        <div className="inspector__params">
          {paramSpecs.map((spec) => {
            // A promoted param shows the unit/widget of the primitive param it really edits.
            const leaf = selectedPrimitive && presentationKeyOf(selectedPrimitive.id, spec)
            const unitDependency =
              selectedPrimitive && findUnitDependency(selectedPrimitive.id, spec)
            return (
              <ParamRow
                key={spec.name}
                nodeIdValue={selectedNodeId!}
                spec={spec}
                unit={
                  unitDependency
                    ? dependentUnit(
                        unitDependency,
                        selectedNode.params.find((p) => p.name === unitDependency.param)?.value
                      )
                    : selectedPrimitive && findDisplayUnit(selectedPrimitive.id, spec)
                }
                trackGate={selectedPrimitive && findParamTrackGate(selectedPrimitive.id, spec.name)}
                booleanWidget={leaf && findBooleanWidget(leaf.primitiveId, leaf.paramName)}
                paramValue={findAliasedFieldValue(
                  selectedPrimitive?.renamedParams,
                  spec.name,
                  selectedNode.params
                )}
                setLogueParam={setLogueParam}
                rootDoc={rootDoc}
                openParamMatrix={openParamMatrix}
                nodeName={selectedNode.name ?? ''}
                setSubpatchExpose={promotable ? setSubpatchExpose : undefined}
                onContextMenu={(screenPos, paramName) => {
                  const exposed = selectedNode.params.find(
                    (p) => p.name === paramName
                  )?.subpatchExpose
                  setContextMenu({
                    screenPos,
                    items: [
                      promotable
                        ? {
                            label: exposed ? 'Stop exposing on subpatch' : 'Expose on subpatch',
                            onClick: () =>
                              setSubpatchExpose(
                                selectedNodeId!,
                                paramName,
                                exposed
                                  ? null
                                  : defaultPromotedParamName(selectedNode.name ?? '', paramName)
                              )
                          }
                        : {
                            label: 'Configure in Param Matrix…',
                            onClick: () => openParamMatrix({ nodeId: selectedNodeId!, paramName })
                          }
                    ]
                  })
                }}
              />
            )
          })}
        </div>
      )}
      {!collapsed && selectedNode?.kind === 'obj' && selectedPrimitive?.sampleImport && (
        <SampleSection
          key={selectedNodeId}
          kind={selectedPrimitive.sampleImport}
          sample={selectedNode.sample}
          loopMode={sampleLoopModeOf(selectedNode.params)}
          reverse={Number(selectedNode.params.find((p) => p.name === 'REVERSE')?.value ?? 0) >= 1}
          onSampleChange={(sample, rootNote) => setNodeSample(selectedNodeId!, sample, rootNote)}
        />
      )}
      {/* Always last -- a brief, plain-language blurb (LoguePrimitive.description) explaining
          what the selected primitive actually does, for a user who doesn't already know this
          registry by heart. Bottom-of-panel placement is deliberate: Name/params are things a
          user EDITS, this is read-only reference text, so it stays out of the way of the
          editable fields above it. */}
      {/* Keyed per node so More/Less resets on a new selection -- with its own suffix: SampleSection
          above is keyed by the bare node id, and two siblings sharing a key made React duplicate
          the sample section on every click and leave stale ones behind. */}
      {!collapsed && description && (
        <Description key={`${selectedNodeId}:description`} text={description} />
      )}
      {contextMenu && (
        <ContextMenu
          screenPos={contextMenu.screenPos}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}

/** `logue/osc/sample`'s LOOP select (0 Off, 1 Forward, 2 Ping-pong), for the sample preview. */
function sampleLoopModeOf(params: readonly ParamValue[]): SampleLoopMode {
  const value = Math.round(Number(params.find((p) => p.name === 'LOOP')?.value ?? 0))
  return value >= 2 ? 'pingpong' : value === 1 ? 'forward' : 'off'
}

export default Inspector

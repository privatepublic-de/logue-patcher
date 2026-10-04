import { CircleOff } from 'lucide-react'
import { useCallback, useState, type RefObject } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { ObjectFlowNode } from '../state/toFlowGraph'
import {
  colorForRole,
  inletShapeClassForRole,
  outletShapeClassForBucket,
  withAlpha
} from './portColors'
import { useOptionalPatchStore } from '../state/patchStore'
import { useInlineEdit } from './useInlineEdit'
import { nodeTypeLabel } from './nodeTypeLabel'
import { headerTypeLabel, isCompactPrimitive } from './compactNode'
import {
  categoryForPrimitiveId,
  colorForCategory,
  PLATFORM_LABEL,
  restrictedPlatforms
} from '../browser/loguePrimitiveCatalog'
import { isSubpatchInstanceType } from '@logue-codegen/subpatches'
import { busNodeRole, sendsDirectToBus } from '@logue-codegen/buses'
import { presentationKeyOf, type PrimitiveParamSpec } from '@logue-codegen/primitives'
import { resolveNodePrimitive, useSubpatchLibraryStore } from '../state/subpatchLibraryStore'
import { openSubpatchDefinition } from '../state/openSubpatchDefinition'
import { describeUnresolvedReference } from './describeUnresolvedReference'
import {
  findInletModulation,
  findParamModulation,
  type ParamModulation
} from '@logue-codegen/paramModulation'
import { findDisplayUnit, findUnitDependency } from '@logue-codegen/paramUnits'
import {
  findBooleanWidget,
  findInletTrackGate,
  findParamTrackGate,
  type ParamTrackGate
} from '@logue-codegen/paramTrackGate'
import ParamDial from './ParamDial'
import DeviceControlPicker from './DeviceControlPicker'
import EnvelopeGraph, { ENVELOPE_GRAPH_PARAMS, ENVELOPE_GRAPH_PRIMITIVE } from './EnvelopeGraph'
import { useIsTrackGated } from './trackGateState'
import { useTargetPlatformStore } from '../state/targetPlatformStore'
import { nodeId as computeNodeId } from '../state/nodeId'
import { DEVICE_CONTROL_ID, describeDeviceControl } from '../state/exposedLogueParams'

/**
 * COARSE and FINE always come together and are short, so they share one row to save node
 * height. Only the adjacent spec pair is joined, so a node's dial order never changes.
 */
function groupTuningPairs(specs: PrimitiveParamSpec[]): PrimitiveParamSpec[][] {
  const groups: PrimitiveParamSpec[][] = []
  for (let i = 0; i < specs.length; i++) {
    if (specs[i].name === 'COARSE' && specs[i + 1]?.name === 'FINE') {
      groups.push([specs[i], specs[i + 1]])
      i++
    } else groups.push([specs[i]])
  }
  return groups
}

/**
 * The inlet-row counterpart to ParamDial.tsx's own gated icon (reason in its tooltip) --
 * `@logue-codegen/paramTrackGate`'s `findInletTrackGate` doc comment explains why an inlet needs
 * this at all (a wire into `comb`'s `tune`, `svf`'s `cutoff`, or either's `pitch` can currently do nothing depending
 * on `TRACK`, with no indication otherwise). A separate component (not inlined in ObjectNode's
 * own `.map()`) so `useIsTrackGated` is a real hook call, not one made conditionally per array
 * item.
 */
function InletTrackBadge({
  id,
  gate
}: {
  id: string
  gate: ParamTrackGate
}): React.JSX.Element | null {
  if (!useIsTrackGated(id, gate)) return null
  return (
    <span
      className="param-widget__gated-icon"
      data-tooltip={`${gate.label} — a wire here has no effect right now`}
      aria-label={gate.label}
    >
      <CircleOff size={10} aria-hidden="true" />
    </span>
  )
}

/**
 * Says, before anything is wired, what a wire into this inlet will do to its dial: add to it
 * (`±`, the dial still sets the centre) or replace it (`⇥`, the dial stops mattering). ParamDial.tsx's
 * "Modulated"/"Overridden" badge says the same once a wire is there.
 */
function InletModulationMarker({
  paramName,
  modulation,
  warning
}: {
  paramName: string
  modulation: ParamModulation
  /** The wire landing here doesn't suit this inlet (`NetEdgeData.warning`). */
  warning?: string
}): React.JSX.Element {
  const replaces = modulation.shape === 'replace'
  const tooltip = replaces
    ? `A wire here replaces the ${paramName} dial — the dial has no effect while wired` +
      (modulation.expects ? `. Expects ${modulation.expects.range}.` : '')
    : `A wire here adds to the ${paramName} dial — the dial still sets the centre` +
      (modulation.note ? ` (${modulation.note})` : '')
  if (warning) {
    return (
      <span
        className="patch-node__inlet-mod patch-node__inlet-mod--warn"
        data-tooltip={warning}
        aria-label={`check this wire: ${warning}`}
      >
        !
      </span>
    )
  }
  return (
    <span
      className={
        'patch-node__inlet-mod ' +
        (replaces ? 'patch-node__inlet-mod--replace' : 'patch-node__inlet-mod--add')
      }
      data-tooltip={tooltip}
      aria-label={replaces ? `replaces ${paramName}` : `adds to ${paramName}`}
    >
      {replaces ? '⇥' : '±'}
    </span>
  )
}

/**
 * A port's name label is suppressed entirely when its object has exactly one inlet (or exactly
 * one outlet) -- matching `InletInstanceView`/`OutletInstanceView.java`'s real `if (...size() > 1)
 * add(label)` (`axoloti/swingui/patch/object/{inlet,outlet}/`, the shipped Swing UI; see
 * Knob.tsx's doc comment on why the parallel, never-released `axoloti/piccolo/**` port isn't a
 * source of truth). The common single-in/single-out case (most audio-processing objects) shows a
 * bare colored jack with no text in the real app.
 *
 * The header is ONE category-tinted row on every node (user's call, 2026-10-02): the instance
 * name in bold on the left (double-click to rename), the type small and muted on the right. It
 * used to be two rows, the Axoloti way (a type strip above the name), which cost every node a
 * line; showing only one of them when the name is the default was rejected -- nodes would differ
 * in layout for an invisible reason, and the name would have nowhere to be edited. The type takes
 * only the space left over (it never widens a node) and gives way to the badges first. A
 * compact primitive (compactNode.ts) is that row alone, with its jacks on the row's edges.
 */
function ObjectNode({ id, data, selected }: NodeProps<ObjectFlowNode>): React.JSX.Element {
  const {
    node,
    inlets,
    outlets,
    inletColors,
    outletColors,
    outletBuckets,
    unresolvedReferences,
    inletWarnings
  } = data
  // A bus node is titled by its bus, and its title edits the bus; the node's own name (its
  // identity, what nets address) stays in the Inspector.
  const busRole = node.kind === 'obj' ? busNodeRole(node.type) : undefined
  const busName = node.kind === 'obj' ? (node.bus ?? '') : ''
  const shownBus = busName || '(no bus)'
  const title = busRole
    ? busRole === 'send'
      ? `→ ${shownBus}`
      : `${shownBus} →`
    : (node.name ?? '(unnamed)')
  const rawType = nodeTypeLabel(node)
  // Only a *logue primitive's id has a category worth tinting/shortening -- a legacy Axoloti
  // type (e.g. "env/adsr") already has no "logue/" root and no entry in CATEGORY_COLORS.
  const isSubpatch = rawType !== undefined && isSubpatchInstanceType(rawType)
  const isLogueType = (rawType?.startsWith('logue/') ?? false) || isSubpatch
  const category = isLogueType ? categoryForPrimitiveId(rawType!) : undefined
  const subtitle = isLogueType ? headerTypeLabel(rawType!) : rawType
  const titlebarStyle = category
    ? { backgroundColor: withAlpha(colorForCategory(category), 0.3) }
    : undefined

  const renameNode = useOptionalPatchStore((s) => s.renameNode)
  const setNodeBus = useOptionalPatchStore((s) => s.setNodeBus)
  const { editing, startEditing, commitEdit, cancelEdit, inputRef } = useInlineEdit(id, (next) =>
    busRole ? setNodeBus(id, next) : renameNode(id, next)
  )

  // Subscribed so a saved definition re-renders its instances' params even without a remount.
  useSubpatchLibraryStore((s) => s.version)
  const primitive = node.kind === 'obj' ? resolveNodePrimitive(node.type) : undefined
  const hasInletMarkers =
    primitive !== undefined && inlets.some((port) => findInletModulation(primitive, port.name))
  const hasEnvelopeGraph = primitive?.id === ENVELOPE_GRAPH_PRIMITIVE
  // The graph edits the stage levels/times, so they aren't drawn as dials too.
  const paramSpecs = (primitive?.params ?? []).filter(
    (spec) => !hasEnvelopeGraph || !ENVELOPE_GRAPH_PARAMS.has(spec.name)
  )

  // A pure fact about the primitive itself (no
  // "currently viewed platform" left to read at all) -- an advisory badge only, never blocking:
  // this primitive can be placed and wired regardless of platform support (insertion isn't gated
  // by it), and being unsupported here doesn't by itself mean a build would fail -- only an
  // ACTIVE (output-wired) instance's own unsupported primitive does that
  // (`assertPrimitivesSupportPlatform`, checked at export/build time, not here). This badge
  // states a fact about the primitive, not a build outcome. `[]` for a platform-agnostic
  // primitive (most of the registry), same "nothing to show" meaning as before.
  const ownPlatforms = node.kind === 'obj' ? restrictedPlatforms(node.type) : []

  // See `unresolvedReferences.ts` -- split so a real problem (unrecognized type, a stale param/
  // inlet whose value/wire is silently doing nothing) gets the warning-tinted badge, while an
  // old id that resolved fine through `RENAMED_PRIMITIVE_IDS` gets a quieter, informational one
  // (same "advisory, not build-blocking" posture as `ownPlatforms` above -- neither of these
  // badges by itself means the ACTIVE graph will fail to build; `assertPrimitivesSupportPlatform`/
  // `resolveAudioGraph` are still the real checks, at export/build time).
  // A device control shows which control it is on the build target -- read live, since the
  // Param Matrix's edits don't remount the canvas -- and dims when it has none there.
  const buildPlatform = useTargetPlatformStore((s) => s.platform)
  const controlValue = useOptionalPatchStore((s) => {
    if (primitive?.id !== DEVICE_CONTROL_ID) return undefined
    const live = s.rootDoc?.nodes.find((n, i) => computeNodeId(n, i) === id)
    return live?.kind === 'obj' ? live.params.find((p) => p.name === 'VALUE') : undefined
  })
  const isDeviceControl = primitive?.id === DEVICE_CONTROL_ID
  // Promoted out of a definition, each placed instance assigns it.
  const promotedControl = controlValue?.subpatchExpose !== undefined
  const controlOnTarget = !isDeviceControl
    ? ''
    : promotedControl
      ? 'per instance'
      : describeDeviceControl(controlValue, buildPlatform)
  const [pickerOpen, setPickerOpen] = useState(false)
  const closePicker = useCallback(() => setPickerOpen(false), [])

  const brokenReferences = unresolvedReferences.filter((r) => r.kind !== 'renamed-type')
  const onlyInformationalReference =
    brokenReferences.length === 0 && unresolvedReferences.length > 0

  const titleElement = editing ? (
    <input
      ref={inputRef as RefObject<HTMLInputElement>}
      className="patch-node__title-input nodrag nopan"
      autoFocus
      defaultValue={busRole ? busName : (node.name ?? '')}
      onBlur={(e) => commitEdit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') cancelEdit()
      }}
      onPointerDown={(e) => e.stopPropagation()}
    />
  ) : (
    <span
      className="patch-node__title"
      data-tooltip={
        busRole
          ? `Bus "${busName}" (node ${node.name ?? ''}) -- double-click to change the bus`
          : undefined
      }
      onDoubleClick={(e) => {
        e.stopPropagation()
        startEditing()
      }}
    >
      {title}
    </span>
  )

  // A badge (an issue, "Renamed", "Only on") needs the full header, so such a node stays full
  // size; so does one whose saved ports no longer match its primitive (a stale wire's jack).
  const compact =
    node.kind === 'obj' &&
    isCompactPrimitive(node.type) &&
    inlets.length <= 2 &&
    outlets.length === 1 &&
    node.params.length === 0 &&
    unresolvedReferences.length === 0 &&
    ownPlatforms.length === 0

  if (compact) {
    const outlet = outlets[0]
    // Two operands share the left edge, a above b; the jack's tooltip names it.
    const inletTops = inlets.length === 2 ? ['30%', '70%'] : ['50%']
    return (
      <div
        className={`patch-node patch-node--compact${inlets.length === 2 ? ' patch-node--compact-2' : ''}${selected ? ' patch-node--selected' : ''}`}
      >
        <div className="patch-node__title-row" style={titlebarStyle}>
          {inlets.map((inlet, i) => (
            <span
              key={inlet.name}
              className="patch-node__compact-jack patch-node__compact-jack--in"
              data-port-name={inlet.name}
              data-port-direction="in"
            >
              <Handle
                type="target"
                position={Position.Left}
                id={inlet.name}
                className={
                  `patch-node__handle ${inletShapeClassForRole(inlet.role)}` +
                  (inlet.stale ? ' patch-node__handle--stale' : '')
                }
                data-tooltip={inlets.length > 1 ? (inlet.label ?? inlet.name) : undefined}
                style={{
                  top: inletTops[i],
                  backgroundColor: inletColors[inlet.name] ?? colorForRole(inlet.role)
                }}
              />
            </span>
          ))}
          {titleElement}
          <span className="patch-node__type" data-tooltip={rawType}>
            {subtitle}
          </span>
          <span
            className="patch-node__compact-jack patch-node__compact-jack--out"
            data-port-name={outlet.name}
            data-port-direction="out"
          >
            <Handle
              type="source"
              position={Position.Right}
              id={outlet.name}
              className={`patch-node__handle ${outletShapeClassForBucket(outletBuckets[outlet.name])}${outlet.stale ? ' patch-node__handle--stale' : ''}`}
              style={{ backgroundColor: outletColors[outlet.name] }}
            />
          </span>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`patch-node${selected ? ' patch-node--selected' : ''}${isSubpatch ? ' patch-node--subpatch' : ''}${isDeviceControl && !controlOnTarget ? ' patch-node--unbound-control' : ''}`}
      // The title and each dial own their own double-click (rename / type a value) and stop it
      // there, so anywhere else on a subpatch instance opens its definition.
      onDoubleClick={
        isSubpatch && rawType
          ? (e) => {
              e.stopPropagation()
              void openSubpatchDefinition(rawType)
            }
          : undefined
      }
      title={isSubpatch ? 'Double-click to edit this subpatch' : undefined}
    >
      <div className="patch-node__header">
        <div className="patch-node__title-row" style={titlebarStyle}>
          {titleElement}
          {subtitle && (
            <span className="patch-node__type" data-tooltip={rawType}>
              {subtitle}
            </span>
          )}
          {node.kind === 'obj' && sendsDirectToBus(node) && (
            <span
              className="patch-node__bus-badge"
              data-tooltip={`Also sends its output onto bus "${node.bus}" (change it in the Inspector)`}
            >
              → {node.bus || '(no name)'}
            </span>
          )}
          {/* One combined badge, not one per platform -- see restrictedPlatforms' own doc
              comment on why "Only on X" specifically shouldn't be rendered per-item. */}
          {ownPlatforms.length > 0 && (
            <span
              className="patch-node__platform-badge"
              title={`${rawType} only has a ${ownPlatforms.map((p) => PLATFORM_LABEL[p]).join('/')} equivalent -- an active (output-wired) instance of it will fail to build for any other platform`}
            >
              Only on {ownPlatforms.map((p) => PLATFORM_LABEL[p]).join(', ')}
            </span>
          )}
          {isDeviceControl && (
            <span className="patch-node__control-anchor">
              <button
                type="button"
                className={
                  'patch-node__control-badge nodrag nopan' +
                  (controlOnTarget ? '' : ' patch-node__control-badge--unbound')
                }
                disabled={promotedControl}
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  setPickerOpen((open) => !open)
                }}
                title={
                  promotedControl
                    ? 'Promoted: each placed instance of this subpatch assigns it'
                    : controlOnTarget
                      ? `${controlOnTarget} on the ${PLATFORM_LABEL[buildPlatform]} -- click to change`
                      : `No device control on the ${PLATFORM_LABEL[buildPlatform]}: it outputs its VALUE as a constant there. Click to choose one.`
                }
              >
                {controlOnTarget || `Not on ${PLATFORM_LABEL[buildPlatform]}`}
              </button>
              {pickerOpen && !promotedControl && (
                <DeviceControlPicker nodeId={id} paramName="VALUE" onClose={closePicker} />
              )}
            </span>
          )}
          {brokenReferences.length > 0 && (
            <span
              className="patch-node__unresolved-badge"
              title={unresolvedReferences.map(describeUnresolvedReference).join('\n')}
            >
              {brokenReferences.length === 1 ? '1 issue' : `${brokenReferences.length} issues`}
            </span>
          )}
          {onlyInformationalReference && (
            <span
              className="patch-node__unresolved-badge patch-node__unresolved-badge--info"
              title={unresolvedReferences.map(describeUnresolvedReference).join('\n')}
            >
              Renamed
            </span>
          )}
        </div>
      </div>

      <div className="patch-node__ports">
        <div className="patch-node__port-col">
          {inlets.map((port) => {
            const inletGate = primitive && findInletTrackGate(primitive.id, port.name)
            const inletMod = primitive && findInletModulation(primitive, port.name)
            return (
              <div
                key={port.name}
                className="patch-node__port"
                data-port-name={port.name}
                data-port-direction="in"
              >
                {/* Square for a control inlet, round for an audio one, a ring for a buffer -- a shape cue independent
                    of colour, since a small dot's colour is the first thing to go when the
                    canvas is zoomed out (and is unavailable entirely to a colour-blind user).
                    Colour itself prefers the WIRE actually feeding this inlet (inletColors,
                    toFlowGraph.ts -- the source outlet's own colour, so a landed cable and the
                    dot it lands on always agree) and only falls back to the generic role colour
                    (neutral gray for control / uniform audio) while the inlet is unwired. */}
                <Handle
                  type="target"
                  position={Position.Left}
                  id={port.name}
                  className={
                    `patch-node__handle ${inletShapeClassForRole(port.role)}` +
                    (port.stale ? ' patch-node__handle--stale' : '')
                  }
                  style={{ backgroundColor: inletColors[port.name] ?? colorForRole(port.role) }}
                />
                {inletMod ? (
                  <InletModulationMarker {...inletMod} warning={inletWarnings[port.name]} />
                ) : (
                  // Keeps every label in the column lined up once any inlet has a marker.
                  hasInletMarkers && <span className="patch-node__inlet-mod" aria-hidden="true" />
                )}
                {inlets.length > 1 && (
                  <span className="patch-node__port-label">{port.label ?? port.name}</span>
                )}
                {inletGate && <InletTrackBadge id={id} gate={inletGate} />}
              </div>
            )
          })}
          {/* The outlet column is pulled out via `position: absolute` (see
              `.patch-node__ports`'s own doc comment), so it contributes nothing to this node's
              auto height -- a primitive with more outlets than inlets (first real case:
              `logue/sense/*`'s `unipolar`/`bipolar`, 0 inlets) would otherwise have its outlet
              rows overflow past the node's own visible border. These reserve the missing height
              directly in the (still normal-flow) inlet column, reusing the real handle/label
              markup so the reserved height matches a genuine row's exactly. */}
          {Array.from({ length: Math.max(0, outlets.length - inlets.length) }).map((_, i) => (
            <div key={`spacer-${i}`} className="patch-node__port patch-node__port--spacer">
              <span className="patch-node__handle" />
              <span className="patch-node__port-label">&nbsp;</span>
            </div>
          ))}
        </div>
        <div className="patch-node__port-col patch-node__port-col--outlets">
          {outlets.map((port) => (
            <div
              key={port.name}
              className="patch-node__port patch-node__port--outlet"
              data-port-name={port.name}
              data-port-direction="out"
            >
              {outlets.length > 1 && <span className="patch-node__port-label">{port.name}</span>}
              {/* Shape mirrors the inlet convention above (round/square), plus a third diamond
                  shape for `gate` -- see `outletShapeClassForBucket`'s own doc comment. Colour
                  and shape both come from the SAME resolved bucket (`outletBuckets`), computed
                  once in toFlowGraph.ts, so a dot's colour and its shape can never disagree. */}
              <Handle
                type="source"
                position={Position.Right}
                id={port.name}
                className={`patch-node__handle ${outletShapeClassForBucket(outletBuckets[port.name])}${port.stale ? ' patch-node__handle--stale' : ''}`}
                style={{ backgroundColor: outletColors[port.name] }}
              />
            </div>
          ))}
        </div>
      </div>

      {hasEnvelopeGraph && <EnvelopeGraph id={id} />}
      {paramSpecs.length > 0 && (
        <div className="patch-node__params">
          {groupTuningPairs(paramSpecs).map((group) => {
            const dials = group.map((spec) => {
              // A promoted param shows the unit/widget of the primitive param it really edits.
              const leaf = primitive && presentationKeyOf(primitive.id, spec)
              return (
                <ParamDial
                  key={spec.name}
                  id={id}
                  spec={spec}
                  modulation={primitive && findParamModulation(primitive.id, spec.name)}
                  unit={primitive && findDisplayUnit(primitive.id, spec)}
                  unitDependency={primitive && findUnitDependency(primitive.id, spec)}
                  trackGate={primitive && findParamTrackGate(primitive.id, spec.name)}
                  booleanWidget={leaf && findBooleanWidget(leaf.primitiveId, leaf.paramName)}
                  labelFallback={isSubpatch ? spec.name : undefined}
                />
              )
            })
            return dials.length === 1 ? (
              dials[0]
            ) : (
              <div key={group[0].name} className="patch-node__param-pair">
                {dials}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default ObjectNode

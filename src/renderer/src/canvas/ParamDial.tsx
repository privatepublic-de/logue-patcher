import { memo, useCallback, useRef, useState } from 'react'
import { CircleOff } from 'lucide-react'
import {
  findAliasedFieldValue,
  snapToStep,
  type PrimitiveParamSpec
} from '@logue-codegen/primitives'
import { resolveNodePrimitive } from '../state/subpatchLibraryStore'
import type { ParamModulation } from '@logue-codegen/paramModulation'
import { dependentUnit, type findUnitDependency, type ParamUnit } from '@logue-codegen/paramUnits'
import type { BooleanParamWidget, ParamTrackGate } from '@logue-codegen/paramTrackGate'
import type { LogueKnob } from '@shared/domain/paramValueTypes'
import { useOptionalPatchStore } from '../state/patchStore'
import { nodeId as computeNodeId } from '../state/nodeId'
import {
  ALL_LOGUE_PLATFORMS,
  describeDeviceControl,
  describeExposedSlots,
  hasDeviceControl,
  type DeviceControls
} from '../state/exposedLogueParams'
import { PLATFORM_LABEL, PLATFORM_TAG } from '../browser/loguePrimitiveCatalog'
import { isInletWired } from './ports'
import { useIsTrackGated } from './trackGateState'
import { PORT_COLOR_BIPOLAR, withAlpha } from './portColors'

/**
 * Small, hint-like markers for a param's own device slot -- one per platform that actually has
 * one, shown/hidden independently (resolved with the
 * user: two compact tags rather than one badge trying to say two numbers at once). The real
 * status text (which platform, which slot number) lives entirely in the `title` tooltip; the
 * badge itself is deliberately terse (`PLATFORM_TAG`, not `PLATFORM_LABEL`) so it doesn't compete
 * with the value/label it sits beside. Renders nothing at all when no platform has a slot,
 * matching every other "absent, not a muted placeholder" badge in this file.
 */
/** A knob's badge text, as short as a slot number. */
const KNOB_TAG: Record<LogueKnob, Record<'nts1mkii' | 'minilogue-xd', string>> = {
  shape: { nts1mkii: 'SHP', 'minilogue-xd': 'SHP' },
  'shape-2': { nts1mkii: 'ALT', 'minilogue-xd': 'SH+' },
  cutoff: { nts1mkii: 'CUT', 'minilogue-xd': 'CUT' },
  resonance: { nts1mkii: 'RES', 'minilogue-xd': 'RES' },
  time: { nts1mkii: 'TIM', 'minilogue-xd': 'TIM' },
  depth: { nts1mkii: 'DEP', 'minilogue-xd': 'DEP' },
  mix: { nts1mkii: 'MIX', 'minilogue-xd': 'MIX' }
}

function controlTag(controls: DeviceControls, platform: 'nts1mkii' | 'minilogue-xd'): string {
  const slot = controls.logueParamIndex?.[platform]
  if (slot !== undefined) return String(slot + 1)
  const knob = controls.logueKnob?.[platform]
  if (knob !== undefined) return KNOB_TAG[knob][platform]
  return `↳${controls.logueFollow![platform]! + 1}`
}

export function SlotBadges({
  controls
}: {
  controls: DeviceControls | undefined
}): React.JSX.Element | null {
  if (!controls) return null
  const exposed = ALL_LOGUE_PLATFORMS.filter((platform) => hasDeviceControl(controls, platform))
  if (exposed.length === 0) return null
  return (
    <>
      {exposed.map((platform) => (
        <span
          key={platform}
          className="param-widget__slot-badge"
          title={`${describeDeviceControl(controls, platform)} on ${PLATFORM_LABEL[platform]}`}
        >
          {PLATFORM_TAG[platform]} {controlTag(controls, platform)}
        </span>
      ))}
    </>
  )
}

/** The same "Param N on <platform>" facts `SlotBadges` renders as compact tags, spelled out in
 *  full for a `title` tooltip (`describeExposedSlots`, shared with `Inspector.tsx` so the two
 *  UIs can't phrase the same slot map two different ways) -- prefixed with a dash when non-empty,
 *  nothing at all when no platform has a slot. */
function slotTooltipFragment(controls: DeviceControls | undefined): string {
  const described = describeExposedSlots(controls)
  return described ? ` — ${described}` : ''
}

interface ParamDialProps {
  id: string
  spec: PrimitiveParamSpec
  /** Which inlet (if any) affects this param's value once wired, and how -- see
   *  `@logue-codegen/paramModulation`'s own doc comment. Undefined for a param no primitive's
   *  own inlets ever touch (most of them). */
  modulation?: ParamModulation
  /** A real-world unit (Hz/ms/dB/semitones/...) to format this param's raw value as -- see
   *  `@logue-codegen/paramUnits`'s own doc comment on why only SOME params get one. Undefined
   *  falls back to the plain raw number, same as before this existed. */
  unit?: ParamUnit
  /** The unit follows another param of this node (`findUnitDependency`); read live, like the
   *  value, and used over `unit`. */
  unitDependency?: ReturnType<typeof findUnitDependency>
  /** This param has no effect (or a different one) depending on a SIBLING param's own current
   *  value -- see `@logue-codegen/paramTrackGate`'s own doc comment. Undefined for every param
   *  not gated by another one on the same node (most of them). */
  trackGate?: ParamTrackGate
  /** Render a checkbox instead of a rotary dial -- see `@logue-codegen/paramTrackGate`'s own
   *  `BooleanParamWidget` doc comment for why (a plain on/off mode switch, not a continuous
   *  control, even though the raw stored value is still a 0-100 number). */
  booleanWidget?: BooleanParamWidget
  /** The dial's title for a `freeLabel` param without a device menu name of its own -- a promoted
   *  subpatch param's outer name (which the device menu also falls back to). Defaults to the spec
   *  name (`VALUE` for `logue/sense/control`). */
  labelFallback?: string
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function numOr(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) ? n : fallback
}

// Dial angles are degrees clockwise from 12 o'clock, the same frame `deg` below rotates in.
function dialPoint(deg: number, r: number): string {
  const rad = (deg * Math.PI) / 180
  return `${(10 + r * Math.sin(rad)).toFixed(3)} ${(10 - r * Math.cos(rad)).toFixed(3)}`
}

/** A range that crosses 0 reads as signed, so the arc grows from 0 instead of from `min` --
 *  otherwise a bipolar dial parked at 0 looks exactly like a unipolar one half-way up. */
function zeroArcPath(fromDeg: number, toDeg: number): string | undefined {
  if (Math.abs(toDeg - fromDeg) < 0.5) return undefined
  const r = 8.5
  const largeArc = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0
  const sweep = toDeg > fromDeg ? 1 : 0
  return `M ${dialPoint(fromDeg, r)} A ${r} ${r} 0 ${largeArc} ${sweep} ${dialPoint(toDeg, r)}`
}

/** Dials with more positions than this get no ticks: they'd merge into a solid ring at 18px. */
const MAX_DIAL_TICKS = 16

/** The dial angles of a discrete param's positions (a select's choices, or every `step` of a
 *  stepped param), or none for a continuous one or one with too many positions to mark. */
function discreteTickAngles(spec: PrimitiveParamSpec): number[] {
  const span = spec.max - spec.min
  if (span <= 0) return []
  const count = spec.select
    ? spec.select.count
    : spec.step
      ? Math.floor(span / spec.step + 1e-9) + 1
      : 0
  if (count < 2 || count > MAX_DIAL_TICKS) return []
  // A select spreads its choices over the whole range (mux2's two sit at 0 and 100).
  const stepSize = spec.select ? span / (count - 1) : spec.step!
  return Array.from({ length: count }, (_, i) => -135 + ((i * stepSize) / span) * 270)
}

function formatValue(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2)
}

/**
 * The on-canvas dial for one `PrimitiveParamSpec`, the node-level counterpart of Inspector.tsx's
 * `ParamRow`. Drag vertically (Shift/Ctrl/Cmd for fine), use the arrow keys, or double-click the
 * value to type one; with a `unit` (`@logue-codegen/paramUnits`) the value is shown and typed in
 * that unit, but the stored value is always the raw `min..max` number.
 *
 * Reads its value from the live store rather than React Flow's mount-time node `data`, because
 * `setLogueParam` never bumps `reloadNonce`. Every commit passes the full per-platform
 * `logueParamIndex` map back unchanged, so editing a value never clobbers a slot assigned in
 * `ParamMatrixOverlay.tsx`; `SlotBadges` shows one tag per platform that has a slot.
 *
 * `data-param-name` on the root lets `PatchCanvas.tsx`'s delegated `onContextMenu` tell a
 * right-click on this param from one on the node.
 */
function ParamDial({
  id,
  spec,
  modulation,
  unit: staticUnit,
  unitDependency,
  trackGate,
  booleanWidget,
  labelFallback
}: ParamDialProps): React.JSX.Element {
  // Whether some net currently lands on the specific inlet `modulation` names -- read straight
  // off the live store, same as every other field below, so wiring/unwiring a cable updates this
  // dial's own visual state immediately.
  const wired = useOptionalPatchStore((s) =>
    modulation ? (s.rootDoc ? isInletWired(s.rootDoc.nets, id, modulation.inlet) : false) : false
  )
  // Live, like `wired` above -- see `useIsTrackGated`.
  const gated = useIsTrackGated(id, trackGate)
  // `findAliasedFieldValue` below (not a plain `.find`) so a param that was renamed (e.g. comb's
  // `FEEDBACK`->`GAIN`) still shows the value it was actually authored under, matching what
  // codegen bakes in (`oscParams.ts`'s own alias-aware lookup) -- otherwise this dial would show
  // the spec's plain default while the generated code used the old, real value underneath it.
  // One selector for the whole `ParamValue`: `setLogueParam` keeps every untouched param's object
  // identity, so this only re-renders the dial whose own param changed.
  const paramValue = useOptionalPatchStore((s) => {
    const node = s.rootDoc?.nodes.find((n, i) => computeNodeId(n, i) === id)
    if (node?.kind !== 'obj') return undefined
    const renamedParams = resolveNodePrimitive(node.type)?.renamedParams
    return findAliasedFieldValue(renamedParams, spec.name, node.params)
  })
  const rawValue = paramValue?.value
  const dependencyRaw = useOptionalPatchStore((s) => {
    if (!unitDependency) return undefined
    const node = s.rootDoc?.nodes.find((n, i) => computeNodeId(n, i) === id)
    return node?.kind === 'obj'
      ? node.params.find((p) => p.name === unitDependency.param)?.value
      : undefined
  })
  const unit = unitDependency ? dependentUnit(unitDependency, dependencyRaw) : staticUnit
  // The FULL per-platform slot map -- `SlotBadges` above renders one marker per platform that
  // actually has a slot.
  const logueParamIndexMap = paramValue?.logueParamIndex
  // Read unconditionally so a value/index-only commit below never clobbers an authored label.
  const label = paramValue?.label
  const setLogueParam = useOptionalPatchStore((s) => s.setLogueParam)
  const beginGesture = useOptionalPatchStore((s) => s.beginGesture)
  const endGesture = useOptionalPatchStore((s) => s.endGesture)

  const value = clamp(numOr(rawValue, spec.default), spec.min, spec.max)
  // One drag-pixel (or one arrow-key press) moves 1% of the param's own range -- there's no
  // per-param "tick" concept here the way axoloti's real-unit tags implied one.
  const tick = (spec.max - spec.min) / 100 || 1

  const [dragging, setDragging] = useState(false)
  const [editing, setEditing] = useState(false)
  const dragStartRef = useRef({ y: 0, value: 0 })

  const commit = useCallback(
    (next: number) => {
      setLogueParam(
        id,
        spec.name,
        String(snapToStep(clamp(next, spec.min, spec.max), spec.step)),
        logueParamIndexMap,
        label
      )
    },
    [id, spec.name, spec.min, spec.max, spec.step, logueParamIndexMap, label, setLogueParam]
  )

  // A free-label param's name only reaches the device as a menu param, and is edited in the Param
  // Matrix next to that slot; the dial shows it only then (a knob has its own fixed name).
  const onMenuSlot = ALL_LOGUE_PLATFORMS.some((p) => logueParamIndexMap?.[p] !== undefined)
  const displayName =
    spec.freeLabel && onMenuSlot && label?.trim() ? label.trim() : (labelFallback ?? spec.name)
  const needsName = spec.freeLabel === true && !spec.promotedFrom && onMenuSlot && !label?.trim()
  const openParamMatrix = useOptionalPatchStore((s) => s.openParamMatrix)

  const onPointerDown = (e: React.PointerEvent): void => {
    // Left-button only, matching the original Knob.tsx's own guard -- a right-click also fires
    // `pointerdown`, which would otherwise drag the value while a context menu is being opened.
    if (e.button !== 0) return
    e.stopPropagation()
    setDragging(true)
    beginGesture()
    dragStartRef.current = { y: e.clientY, value }

    function handleMove(ev: PointerEvent): void {
      const dy = Math.round(dragStartRef.current.y - ev.clientY)
      const fine = ev.shiftKey || ev.ctrlKey || ev.metaKey
      commit(dragStartRef.current.value + (fine ? tick * 0.1 : tick) * dy)
    }
    function handleUp(): void {
      setDragging(false)
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      endGesture()
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const fine = e.shiftKey
    const coarse = e.ctrlKey || e.metaKey
    // A stepped param (e.g. COARSE's whole semitones) has nothing finer than `spec.step` to move
    // by, so `fine` is meaningless there -- unlike the plain tick-based case below, whose 1%-of-
    // range granularity has no such floor. `commit` still snaps the result either way; this just
    // keeps every arrow press an actual, visible change instead of one `fine` (or plain, for a
    // narrow range) press rounding straight back to the value it started from.
    const step = spec.step
      ? coarse
        ? spec.step * 5
        : spec.step
      : fine
        ? tick * 0.1
        : coarse
          ? tick * 5
          : tick
    // Stops propagation too: React Flow's own keyboard handling (and the canvas's nudge) would
    // otherwise also move the selected node 5px per arrow press.
    const consume = (): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        consume()
        commit(value + step)
        return
      case 'ArrowDown':
      case 'ArrowLeft':
        consume()
        commit(value - step)
        return
      case 'Home':
        consume()
        commit(spec.min)
        return
      case 'End':
        consume()
        commit(spec.max)
        return
      case 'Enter':
        consume()
        setEditing(true)
        return
    }
  }

  const normalized = (value - spec.min) / (spec.max - spec.min || 1)
  const deg = -135 + normalized * 270
  const signed = spec.min < 0 && spec.max > 0
  const zeroDeg = -135 + ((0 - spec.min) / (spec.max - spec.min)) * 270
  const arcPath = signed ? zeroArcPath(zeroDeg, deg) : undefined
  const tickAngles = discreteTickAngles(spec)

  // Two independent sources can make this dial's own raw value not the whole story --
  // `trackGate` (a SIBLING param's own state, e.g. comb/svf's TRACK) always wins over
  // `modulation` (a wired inlet) when both could apply (e.g. comb's TUNE is both wireable AND
  // track-gated -- the tracked branch ignores the wire entirely, so gating has to take priority,
  // not just visually compete). `dimmed` covers "this dial has literally zero effect right now"
  // (a wired 'replace' OR any active track-gate, which is ALWAYS fully inert by nature -- unlike
  // wire modulation, there's no "additive" track-gate shape); `badgeNeutral` keeps the amber ring/
  // badge reserved for what it already means elsewhere in this app (a control-ROLE WIRE is
  // responsible) -- a track-gate isn't wire-related at all, so it gets a plain neutral badge and
  // no ring, rather than overloading that colour with a second, unrelated meaning.
  const caveat =
    trackGate && gated
      ? {
          dimmed: true,
          badgeText: trackGate.label,
          badgeNeutral: true,
          // An icon, not the label as text: a word-sized badge crowded the dials, and the gate's
          // reason reads fine as the icon's own tooltip.
          badgeIcon: true,
          tooltipNote: ` — ${trackGate.label.toLowerCase()}; this dial has no effect right now`
        }
      : modulation && wired
        ? modulation.shape === 'replace'
          ? {
              dimmed: true,
              badgeText: 'Overridden',
              badgeNeutral: false,
              badgeIcon: false,
              tooltipNote:
                ' — overridden by a wired input; this dial has no effect while wired' +
                (modulation.expects ? ` (expects ${modulation.expects.range})` : '')
            }
          : {
              dimmed: false,
              badgeText: 'Modulated',
              badgeNeutral: false,
              badgeIcon: false,
              tooltipNote:
                ' — modulated by a wired input; this dial still applies' +
                (modulation.note ? ` (${modulation.note})` : '')
            }
        : undefined

  // A unit display would be actively wrong for a dial that's currently inert -- e.g. showing a
  // stale "4.20 Hz" for a wire-overridden RATE, or "5.31 ms" for a comb TUNE that TRACK has
  // fully replaced with a played-note length. Suppressing it whenever `dimmed` is true covers
  // BOTH the new track-gate case and a pre-existing gap in the wire-`replace` case (e.g. vca's
  // GAIN, unit-bearing AND wire-replaceable, previously kept showing a now-meaningless dB number
  // once wired) in one place.
  const effectiveUnit = caveat?.dimmed ? undefined : unit
  const knobDialStyle =
    caveat && !caveat.badgeNeutral
      ? { borderColor: withAlpha(PORT_COLOR_BIPOLAR, 0.55) }
      : undefined

  if (booleanWidget) {
    const isOn = value >= booleanWidget.threshold
    return (
      <div
        className="param-widget param-widget--checkbox nodrag nopan"
        data-param-name={spec.name}
        title={`${booleanWidget.label}: ${isOn ? 'on' : 'off'}` + slotTooltipFragment(paramValue)}
      >
        <input
          type="checkbox"
          className="param-widget__checkbox-input"
          checked={isOn}
          onChange={() => commit(isOn ? booleanWidget.offValue : booleanWidget.onValue)}
          onPointerDown={(e) => e.stopPropagation()}
        />
        <div className="param-widget__labels">
          <div className="param-widget__value-row">
            <span className="param-widget__label">{booleanWidget.label}</span>
            <div className="param-widget__value-row-badges">
              <SlotBadges controls={paramValue} />
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={
        `param-widget param-widget--knob nodrag nopan${dragging ? ' param-widget--dragging' : ''}` +
        (caveat?.dimmed ? ' param-widget--dial-inert' : '')
      }
      data-param-name={spec.name}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      tabIndex={0}
      title={
        (effectiveUnit
          ? `${label || spec.name}: ${effectiveUnit.toDisplay(value)} (raw ${value}, ${spec.min}-${spec.max})`
          : `${label || spec.name}: ${value} (${spec.min}-${spec.max})`) +
        slotTooltipFragment(paramValue) +
        (caveat?.tooltipNote ?? '')
      }
    >
      <div className="param-widget__knob-dial" style={knobDialStyle}>
        {(signed || tickAngles.length > 0) && (
          <svg className="param-widget__knob-arc" viewBox="0 0 20 20" aria-hidden="true">
            {tickAngles.length > 0 && (
              <path
                className="param-widget__knob-tick"
                d={tickAngles
                  .map((a) => `M ${dialPoint(a, 10)} L ${dialPoint(a, 7.5)}`)
                  .join(' ')}
              />
            )}
            {signed && (
              <path
                className="param-widget__knob-arc-zero"
                d={`M ${dialPoint(zeroDeg, 10)} L ${dialPoint(zeroDeg, 7)}`}
              />
            )}
            {arcPath && <path className="param-widget__knob-arc-value" d={arcPath} />}
          </svg>
        )}
        <div className="param-widget__knob-indicator" style={{ transform: `rotate(${deg}deg)` }} />
      </div>
      <div className="param-widget__labels">
        <span className="param-widget__label">
          {displayName}
          {needsName && (
            <button
              type="button"
              className="param-widget__needs-name nodrag nopan"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                openParamMatrix({ nodeId: id, paramName: spec.name })
              }}
              title="This param is a device menu param but has no name yet -- Export fails until it has one. Name it in the Param Matrix."
            >
              needs a name
            </button>
          )}
        </span>
        <div className="param-widget__value-row">
          {editing ? (
            <input
              className="param-widget__unit-value-input nodrag nopan"
              autoFocus
              defaultValue={effectiveUnit ? effectiveUnit.toDisplay(value) : String(value)}
              onFocus={(e) => e.currentTarget.select()}
              onPointerDown={(e) => e.stopPropagation()}
              onBlur={(e) => {
                const parsed = effectiveUnit
                  ? effectiveUnit.parseInput(e.target.value)
                  : Number.parseFloat(e.target.value)
                if (parsed !== undefined && Number.isFinite(parsed)) commit(parsed)
                setEditing(false)
              }}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') e.currentTarget.blur()
                else if (e.key === 'Escape') setEditing(false)
              }}
            />
          ) : (
            <span
              className="param-widget__unit-value param-widget__unit-value--raw"
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation()
                setEditing(true)
              }}
            >
              {effectiveUnit ? effectiveUnit.toDisplay(value) : formatValue(value)}
            </span>
          )}
          {/* Trailing badge group, right-aligned onto the SAME row as the value rather than its
              own line -- a full extra row per badge was too disruptive once more than one or two
              params on a node had one (the slot
              badges moved here from their own row below, for the same reason). `margin-left: auto`
              lives on the WRAPPER, not each badge, so the group moves as one unit and an empty
              wrapper (nothing exposed, no caveat) costs nothing. */}
          <div className="param-widget__value-row-badges">
            {/* Which device slot(s) this param is exposed to (`ParamMatrixOverlay.tsx`'s own
                Param column) -- previously only visible by opening Inspector or hovering this
                dial's own tooltip, found too obscure by a real user report once more than a
                couple of params were exposed across a graph. Renders nothing at all when
                unexposed on either platform (the common case), rather than a muted placeholder,
                so an exposed param's badge is never ambiguous with an absent one. */}
            <SlotBadges controls={paramValue} />
            {/* Redundant, colour-blind-safe text cue for the knob-dial ring above -- the badge
                text says outright what the ring's dimmed/undimmed state only implies, matching
                this project's existing two-cue convention for the port dots (ObjectNode.tsx).
                Neutral (grey) for a track-gate, since that's a sibling PARAM's own state, not a
                wire -- reusing the amber ring/badge colour for it would overload what amber
                already means everywhere else in this app. Renders nothing when there's no
                caveat, same "absent, not a muted placeholder" rule the slot badges follow. */}
            {caveat?.badgeIcon && (
              <span
                className="param-widget__gated-icon"
                data-tooltip={`${caveat.badgeText} — this dial has no effect right now`}
                aria-label={caveat.badgeText}
              >
                <CircleOff size={10} aria-hidden="true" />
              </span>
            )}
            {caveat && !caveat.badgeIcon && (
              <span
                className="param-widget__wired-badge"
                style={
                  caveat.badgeNeutral
                    ? undefined
                    : {
                        color: withAlpha(PORT_COLOR_BIPOLAR, 0.85),
                        backgroundColor: withAlpha(PORT_COLOR_BIPOLAR, 0.16)
                      }
                }
              >
                {caveat.badgeText}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Its props are registry/table lookups, so a node re-rendering on every drag frame skips its dials.
export default memo(ParamDial)

import { useEffect, useMemo, useRef } from 'react'
import type { LogueKnob, ParamValue } from '@shared/domain/paramValueTypes'
import { useOptionalPatchStore } from '../state/patchStore'
import { currentPlatformLayout } from '../state/patchDocHelpers'
import { nodeId as nodeIdOf } from '../state/nodeId'
import {
  ALL_LOGUE_PLATFORMS,
  deviceLayout,
  KNOB_LABEL,
  layoutModuleOf,
  listParamMatrixRows,
  PLATFORM_LABEL
} from '../state/exposedLogueParams'

type Platform = (typeof ALL_LOGUE_PLATFORMS)[number]

const leadKey = (nodeId: string, paramName: string): string => `${nodeId}\u0000${paramName}`

/** The `<select>` value for one platform's current control of `pv`; `leadAt` names the param
 *  owning a slot (a follower of an unowned slot reads as none). */
function selectedOption(
  pv: ParamValue | undefined,
  platform: Platform,
  leadAt: (slot: number) => string | undefined
): string {
  if (pv?.logueParamIndex?.[platform] !== undefined) return 'slot'
  const knob = pv?.logueKnob?.[platform]
  if (knob !== undefined) return `knob:${knob}`
  const follow = pv?.logueFollow?.[platform]
  const lead = follow === undefined ? undefined : leadAt(follow)
  return lead === undefined ? 'none' : `follow:${lead}`
}

/**
 * The device control of one param, both platforms at once -- opened from a `logue/sense/control`
 * node's badge, so choosing "this is the Shape knob" doesn't need the Param Matrix. Every change
 * goes through the same store actions as the Matrix (one undo step each). Names and menu order
 * stay the Matrix's job; a link opens it at this param. Inside a subpatch definition only knobs
 * are offered, since a definition never owns a menu slot.
 */
function DeviceControlPicker({
  nodeId,
  paramName,
  onClose
}: {
  nodeId: string
  paramName: string
  onClose: () => void
}): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const rootDoc = useOptionalPatchStore((s) => s.rootDoc)
  const setPlatformSlotOrder = useOptionalPatchStore((s) => s.setPlatformSlotOrder)
  const setKnobBinding = useOptionalPatchStore((s) => s.setKnobBinding)
  const setSlotFollow = useOptionalPatchStore((s) => s.setSlotFollow)
  const openParamMatrix = useOptionalPatchStore((s) => s.openParamMatrix)
  const rows = useMemo(() => (rootDoc ? listParamMatrixRows(rootDoc) : []), [rootDoc])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  if (!rootDoc) return null
  const node = rootDoc.nodes.find((n, i) => nodeIdOf(n, i) === nodeId)
  const pv = node?.kind === 'obj' ? node.params.find((p) => p.name === paramName) : undefined
  const self = rows.find((r) => r.nodeId === nodeId && r.paramName === paramName)
  const paramRef = { nodeId, paramName, value: self?.currentValue ?? pv?.value ?? '50' }
  const inDefinition = rootDoc.settings.subpatch === true

  const leadAtFor =
    (platform: Platform) =>
    (slot: number): string | undefined => {
      const lead = rows.find((r) => r.currentSlot?.[platform] === slot)
      return lead && leadKey(lead.nodeId, lead.paramName)
    }

  const choose = (platform: Platform, option: string): void => {
    const current = selectedOption(pv, platform, leadAtFor(platform))
    if (option === current) return
    const layout = currentPlatformLayout(rootDoc, platform)
    const isSelf = (r: { nodeId: string; paramName: string }): boolean =>
      r.nodeId === nodeId && r.paramName === paramName
    if (option === 'none') {
      if (current === 'slot')
        setPlatformSlotOrder(
          platform,
          layout.order.filter((r) => !isSelf(r))
        )
      else if (current.startsWith('knob:')) setKnobBinding(platform, paramRef, null)
      else if (current.startsWith('follow:')) setSlotFollow(platform, paramRef, null)
    } else if (option === 'slot') {
      setPlatformSlotOrder(platform, [...layout.order.filter((r) => !isSelf(r)), paramRef])
    } else if (option.startsWith('knob:')) {
      setKnobBinding(platform, paramRef, option.slice('knob:'.length) as LogueKnob)
    } else if (option.startsWith('follow:')) {
      const [leadNode, leadParam] = option.slice('follow:'.length).split('\u0000')
      setSlotFollow(platform, paramRef, { nodeId: leadNode, paramName: leadParam })
    }
  }

  return (
    <div
      ref={ref}
      className="device-control-picker nodrag nopan nowheel"
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {ALL_LOGUE_PLATFORMS.map((platform) => {
        const current = selectedOption(pv, platform, leadAtFor(platform))
        const leads = rows
          .filter((r) => r.currentSlot?.[platform] !== undefined)
          .filter((r) => !(r.nodeId === nodeId && r.paramName === paramName))
          .sort((a, b) => a.currentSlot![platform]! - b.currentSlot![platform]!)
        const layout = deviceLayout(platform, rootDoc ? layoutModuleOf(rootDoc) : undefined)
        const capacity = layout.maxSlots - layout.reserved.size
        const full = leads.length >= capacity
        if (!layout.buildable) {
          return (
            <label key={platform} className="device-control-picker__row">
              <span className="device-control-picker__device">{PLATFORM_LABEL[platform]}</span>
              <select value="none" disabled>
                <option value="none">Not buildable here yet</option>
              </select>
            </label>
          )
        }
        return (
          <label key={platform} className="device-control-picker__row">
            <span className="device-control-picker__device">{PLATFORM_LABEL[platform]}</span>
            <select value={current} onChange={(e) => choose(platform, e.target.value)}>
              <option value="none">None (constant VALUE)</option>
              {layout.knobs.map((knob) => (
                <option key={knob} value={`knob:${knob}`}>
                  {KNOB_LABEL[knob][platform]}
                </option>
              ))}
              {!inDefinition && (layout.maxSlots > 0 || current === 'slot') && (
                <option value="slot" disabled={current !== 'slot' && full}>
                  {current === 'slot'
                    ? `Menu param (Param ${pv!.logueParamIndex![platform]! + 1})`
                    : full
                      ? `Menu param (all ${capacity} used)`
                      : 'Menu param (added last)'}
                </option>
              )}
              {!inDefinition &&
                leads.map((r) => (
                  <option
                    key={leadKey(r.nodeId, r.paramName)}
                    value={`follow:${leadKey(r.nodeId, r.paramName)}`}
                  >
                    Follows “{r.displayName}” (Param {r.currentSlot![platform]! + 1})
                  </option>
                ))}
            </select>
          </label>
        )
      })}
      <button
        type="button"
        className="build-panel__hint-link device-control-picker__matrix"
        onClick={() => {
          onClose()
          openParamMatrix({ nodeId, paramName })
        }}
      >
        Names and order: Param Matrix…
      </button>
    </div>
  )
}

export default DeviceControlPicker

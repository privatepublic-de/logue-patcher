import type { LogueModule, PatchDocument } from '@shared/domain/patch'
import type {
  LogueKnob,
  LogueKnobBinding,
  LogueParamSlot,
  ParamValue
} from '@shared/domain/paramValueTypes'
import { findAliasedFieldValue, findLoguePrimitive } from '@logue-codegen/primitives'
import { resolveAudioGraph } from '@logue-codegen/oscInstances'
import { supersededKnobBinding } from '@logue-codegen/renamedFields'
import { findUnitKind, UNIT_KINDS } from '@logue-codegen/unitKinds'
import { isSubpatchInstanceType } from '@logue-codegen/subpatches'
import { flattenUnit } from '@logue-codegen/resolveUnit'
import { resolveNodePrimitive, subpatchDefinitions } from './subpatchLibraryStore'
import { nodeId } from './nodeId'

/** Every platform this app currently targets, in the order platform toggles list them -- the one
 *  place a full "for each platform" loop needs a concrete list
 *  (`patchStore.ts`'s per-platform auto-exposure, `BuildPanel.tsx`'s own build-target selector)
 *  rather than a single resolved platform. */
export const ALL_LOGUE_PLATFORMS = ['nts1mkii', 'minilogue-xd'] as const

/** Defined here (not `browser/loguePrimitiveCatalog.ts`, which re-exports it) so
 *  `describeExposedSlots` below can use it without that module importing this one back --
 *  `loguePrimitiveCatalog.ts` already imports `ALL_LOGUE_PLATFORMS` from here, so this file is
 *  the lower-level one of the pair. */
export const PLATFORM_LABEL: Record<'nts1mkii' | 'minilogue-xd', string> = {
  nts1mkii: 'NTS-1 mkII',
  'minilogue-xd': 'minilogue xd'
}

/** A param's device controls, one per platform: a menu slot, a fixed knob, or following a slot. */
export type DeviceControls = Pick<ParamValue, 'logueParamIndex' | 'logueKnob' | 'logueFollow'>

/** The device control `controls` has on `platform`, if any. */
export function hasDeviceControl(
  controls: DeviceControls | undefined,
  platform: 'nts1mkii' | 'minilogue-xd'
): boolean {
  return (
    controls?.logueParamIndex?.[platform] !== undefined ||
    controls?.logueKnob?.[platform] !== undefined ||
    controls?.logueFollow?.[platform] !== undefined
  )
}

/** "Param 3", "SHAPE knob", "follows Param 3" -- one platform's device control, or ''. */
export function describeDeviceControl(
  controls: DeviceControls | undefined,
  platform: 'nts1mkii' | 'minilogue-xd'
): string {
  const slot = controls?.logueParamIndex?.[platform]
  if (slot !== undefined) return `Param ${slot + 1}`
  const knob = controls?.logueKnob?.[platform]
  if (knob !== undefined) return KNOB_LABEL[knob][platform]
  const follow = controls?.logueFollow?.[platform]
  if (follow !== undefined) return `follows Param ${follow + 1}`
  return ''
}

/**
 * "Param N on <platform>" (or "SHAPE knob on ...", "follows Param N on ...") for whichever
 * platform(s) actually have a device control, comma-joined -- the shared phrasing
 * `ParamDial.tsx`'s own tooltip and its compact `SlotBadges`, and `Inspector.tsx`'s matrix-button
 * tooltip, all use so the two UIs can't describe the same controls two different ways (resolved
 * with the user: one phrasing, reused everywhere). Empty string when no platform has one.
 */
export function describeExposedSlots(controls: DeviceControls | undefined): string {
  return ALL_LOGUE_PLATFORMS.filter((platform) => hasDeviceControl(controls, platform))
    .map(
      (platform) => `${describeDeviceControl(controls, platform)} on ${PLATFORM_LABEL[platform]}`
    )
    .join(', ')
}

/**
 * What one platform offers a document of `module`'s kind, as the Param Matrix and the device
 * control picker lay it out -- read from `unitKinds.ts`, the same entry the generators check
 * against, so the UI never offers a slot or knob Export would reject.
 */
export interface DeviceLayout {
  /** Every param slot, the reserved ones included. 0 where the pair can't be built. */
  maxSlots: number
  /** Slots the device owns (a fixed knob's row, declared on every unit), described. */
  reserved: Map<number, string>
  /** The reserved slot a knob is, where it is one (NTS-1 mkII's Shape pair and effect knobs). */
  reservedSlotOf: Partial<Record<LogueKnob, number>>
  /** The fixed knobs a param can be bound to, in the Matrix's order. */
  knobs: readonly LogueKnob[]
  /** False for a pair with no unit kind yet (the minilogue xd's effects). */
  buildable: boolean
}

/**
 * `module` undefined is a subpatch definition: it never owns a menu slot, and may end up in
 * either kind of patch, so it's offered every knob any unit on `platform` has.
 */
export function deviceLayout(
  platform: 'nts1mkii' | 'minilogue-xd',
  module: LogueModule | undefined
): DeviceLayout {
  if (module === undefined) {
    const knobs = [
      ...new Set(UNIT_KINDS.filter((k) => k.platform === platform).flatMap((k) => k.knobs))
    ]
    return { maxSlots: 0, reserved: new Map(), reservedSlotOf: {}, knobs, buildable: true }
  }
  const kind = findUnitKind(platform, module)
  if (!kind)
    return { maxSlots: 0, reserved: new Map(), reservedSlotOf: {}, knobs: [], buildable: false }
  return {
    maxSlots: kind.maxParams,
    reserved: new Map(
      kind.reservedSlots.map((slot) => [
        slot.index,
        `${PLATFORM_LABEL[platform]} ${slot.panelName} knob (fixed on every unit)`
      ])
    ),
    reservedSlotOf: Object.fromEntries(kind.reservedSlots.map((slot) => [slot.knob, slot.index])),
    knobs: kind.knobs,
    buildable: true
  }
}

/** The document's module as the Matrix sees it: none for a subpatch definition. */
export function layoutModuleOf(doc: PatchDocument): LogueModule | undefined {
  return doc.settings.subpatch ? undefined : (doc.settings.logueTarget?.module ?? 'osc')
}

/** The name a param reaches the device menu under: its `label` when it has one (a `freeLabel`
 *  param's typed name, or a promoted subpatch param's per-instance name), else the spec name --
 *  the same rule `oscParams.ts`'s `resolveExposedParams` applies at export time. */
function deviceMenuName(specName: string, paramValue: { label?: string } | undefined): string {
  return paramValue?.label?.trim() || specName
}

export const DEVICE_CONTROL_ID = 'logue/sense/control'

export interface CrossPlatformExposureWarning {
  nodeName: string
  displayName: string
  otherPlatform: 'nts1mkii' | 'minilogue-xd'
}

/**
 * A real, common consequence of per-platform param slots:
 * a param exposed while viewing one platform simply has no slot on the OTHER one -- correct by
 * design ("only existing param inputs are compiled for the selected build target"), but silent
 * otherwise. A build for `targetPlatform` that skips a param exposed only on the other platform
 * produces no error at all today (`resolveExposedParams` just sees an unset index, the ordinary
 * "not exposed" case) -- this scan exists purely to surface that BEFORE the user is surprised by
 * a unit with fewer knobs than they set up. Scoped to ACTIVE instances only, same
 * `resolveAudioGraph` reachability `resolveExposedParams`/`rejectExposedParamsOnInactiveInstances`
 * already use -- an inactive/unwired node's own exposure is a separate, already-hard-errored
 * concern (see `rejectExposedParamsOnInactiveInstances`), not this scan's job. Swallows a
 * graph-resolution failure (missing/duplicate audio-out, unsupported node, etc.) rather than
 * throwing -- that's the real export/build call's own job to report; this is advisory-only and
 * must never block or duplicate that error.
 */
export function computeCrossPlatformExposureWarnings(
  rootDoc: PatchDocument,
  targetPlatform: 'nts1mkii' | 'minilogue-xd'
): CrossPlatformExposureWarning[] {
  let activeInstances: ReturnType<typeof resolveAudioGraph>['activeInstances']
  try {
    ;({ activeInstances } = resolveAudioGraph(flattenUnit(rootDoc, subpatchDefinitions())))
  } catch {
    return []
  }
  const otherPlatform = targetPlatform === 'nts1mkii' ? 'minilogue-xd' : 'nts1mkii'
  const warnings: CrossPlatformExposureWarning[] = []
  for (const inst of activeInstances) {
    const primitive = findLoguePrimitive(inst.id)
    // A device control's own "unassigned here" warning (`listUnboundDeviceControls`) says more.
    if (!primitive || inst.id === DEVICE_CONTROL_ID) continue
    for (const spec of primitive.params ?? []) {
      const paramValue = findAliasedFieldValue(primitive.renamedParams, spec.name, inst.node.params)
      if (
        !hasDeviceControl(paramValue, otherPlatform) ||
        hasDeviceControl(paramValue, targetPlatform)
      ) {
        continue
      }
      const displayName = deviceMenuName(spec.name, paramValue)
      warnings.push({ nodeName: inst.node.name ?? inst.suffix, displayName, otherPlatform })
    }
  }
  return warnings
}

export interface ParamMatrixRow {
  nodeId: string
  nodeName: string
  paramName: string
  /** `ParamValue.label` for a `freeLabel` spec, else the spec's own fixed `name` -- same
   *  resolution `oscParams.ts`'s `resolveExposedParams` uses. */
  displayName: string
  /** `PrimitiveParamSpec.freeLabel` -- `logue/sense/param` and promoted subpatch params. Every
   *  param's device name is editable (`ParamValue.label`, else the spec name); this only decides
   *  whether there is a spec name to fall back on. */
  freeLabel: boolean
  /** A `freeLabel` param with no default name to fall back on (`logue/sense/param`) -- Export
   *  fails while its label is empty. A promoted subpatch param is `freeLabel` too, but falls
   *  back to its outer name. */
  requiresLabel: boolean
  /** `LoguePrimitive.platforms` of the param's node -- undefined means both. */
  platforms: readonly ('nts1mkii' | 'minilogue-xd')[] | undefined
  /** The param's own current raw value (or its spec default, for a param never touched --
   *  same fallback `oscParams.ts`'s `resolveParamDefaultValue` uses), carried along so a cell
   *  edit can round-trip it into `setLogueParam` without a second document lookup. */
  currentValue: string
  currentLabel: string | undefined
  currentSlot: LogueParamSlot | undefined
  currentKnob: LogueKnobBinding | undefined
  currentFollow: LogueParamSlot | undefined
}

/**
 * One row per param on EVERY placed primitive
 * instance in the document (not just already-exposed ones):
 * the whole point of the matrix overlay is to be the one place assignment happens, not a
 * viewer that only shows what Inspector.tsx already set up elsewhere. A document with several
 * multi-param oscillators is still only tens of rows -- `ParamMatrixOverlay.tsx`'s own filter
 * box is what keeps that browsable, not filtering the row set itself.
 *
 * Sorted exposed-on-either-platform first (then alphabetically by node/param name within each
 * group), so the common "what's already assigned" glance still lands at the top without
 * scrolling or filtering -- only browsing every unassigned param needs either of those.
 */
export function listParamMatrixRows(rootDoc: PatchDocument): ParamMatrixRow[] {
  // A subpatch definition never owns a menu slot -- its params reach the device menu only through
  // promotion, assigned per placed instance. It can put a param on a fixed knob (shared hardware),
  // so its unpromoted params are listed for that.
  const inDefinition = rootDoc.settings.subpatch === true
  const rows: ParamMatrixRow[] = []
  rootDoc.nodes.forEach((node, i) => {
    if (node.kind !== 'obj') return
    const id = nodeId(node, i)
    const primitive = resolveNodePrimitive(node.type)
    if (!primitive) return
    for (const spec of primitive.params ?? []) {
      const paramValue = findAliasedFieldValue(primitive.renamedParams, spec.name, node.params)
      if (inDefinition && paramValue?.subpatchExpose) continue
      // Sizes something when the unit is built (long-delay's RANGE): no device control allowed.
      if (spec.structural) continue
      const displayName = deviceMenuName(spec.name, paramValue)
      rows.push({
        nodeId: id,
        nodeName: node.name ?? id,
        paramName: spec.name,
        displayName,
        freeLabel: spec.freeLabel === true,
        requiresLabel: spec.freeLabel === true && !spec.promotedFrom,
        platforms: primitive.platforms,
        currentValue: paramValue?.value ?? String(spec.default),
        currentLabel: paramValue?.label,
        currentSlot: paramValue?.logueParamIndex,
        currentKnob: paramValue?.logueKnob,
        currentFollow: paramValue?.logueFollow
      })
    }
  })
  const controlsOf = (row: ParamMatrixRow): DeviceControls => ({
    logueParamIndex: row.currentSlot,
    logueKnob: row.currentKnob,
    logueFollow: row.currentFollow
  })
  const isExposed = (row: ParamMatrixRow): boolean =>
    ALL_LOGUE_PLATFORMS.some((platform) => hasDeviceControl(controlsOf(row), platform))
  rows.sort((a, b) => {
    const exposedDiff = Number(isExposed(b)) - Number(isExposed(a))
    if (exposedDiff !== 0) return exposedDiff
    return a.nodeName === b.nodeName
      ? a.paramName.localeCompare(b.paramName)
      : a.nodeName.localeCompare(b.nodeName)
  })
  return rows
}

/**
 * The slots `count` params take when laid out in list order on `platform`: consecutive from
 * Param 1, stepping over the platform's reserved slots, cut off at the platform's maximum. Always
 * gap-free, so a list-ordered layout satisfies minilogue xd's contiguity rule by construction.
 */
export function slotsForOrder(
  platform: 'nts1mkii' | 'minilogue-xd',
  module: LogueModule | undefined,
  count: number
): number[] {
  const { maxSlots, reserved } = deviceLayout(platform, module)
  const slots: number[] = []
  for (let i = 0; i < maxSlots && slots.length < count; i++) {
    if (!reserved.has(i)) slots.push(i)
  }
  return slots
}

/** The fixed hardware controls a param can follow (`LogueKnob`); kept under its older name for
 *  the Matrix, which calls them all knobs. */
export type FixedKnob = LogueKnob

export const KNOB_LABEL: Record<LogueKnob, Record<'nts1mkii' | 'minilogue-xd', string>> = {
  shape: { nts1mkii: 'SHAPE knob', 'minilogue-xd': 'SHAPE knob' },
  'shape-2': { nts1mkii: 'ALT-SHAPE knob', 'minilogue-xd': 'SHIFT+SHAPE knob' },
  cutoff: { nts1mkii: 'FILTER CUTOFF', 'minilogue-xd': 'FILTER CUTOFF' },
  resonance: { nts1mkii: 'FILTER RESONANCE', 'minilogue-xd': 'FILTER RESONANCE' },
  time: { nts1mkii: 'TIME knob', 'minilogue-xd': 'TIME knob' },
  depth: { nts1mkii: 'DEPTH knob', 'minilogue-xd': 'DEPTH knob' },
  mix: { nts1mkii: 'MIX (B knob with DEL/REV held)', 'minilogue-xd': 'SHIFT+DEPTH knob' }
}

/** One thing a fixed knob drives in `rootDoc` on one platform. */
export interface KnobAssignment {
  nodeId: string
  nodeName: string
  /** The bound param -- unset for a subpatch instance (`insideSubpatch`) or a superseded
   *  sense node (`legacy`), which read the knob without a binding the Matrix can edit here. */
  paramName?: string
  /** Where a bound `logue/sense/control` (or legacy reader) is wired to, as "node · inlet". */
  wiredTo?: string[]
  /** The knob is bound somewhere inside this subpatch instance's definition, at any depth. */
  insideSubpatch?: boolean
  legacy?: boolean
}

/** Every param bound to each of `platform`'s knobs in `rootDoc`, in document order, plus every
 *  subpatch instance whose definition binds that knob inside. */
export function listKnobAssignments(
  rootDoc: PatchDocument,
  platform: 'nts1mkii' | 'minilogue-xd'
): Record<LogueKnob, KnobAssignment[]> {
  const assignments: Record<LogueKnob, KnobAssignment[]> = {
    shape: [],
    'shape-2': [],
    cutoff: [],
    resonance: [],
    time: [],
    depth: [],
    mix: []
  }
  const defs = subpatchDefinitions()
  const knobsOfNode = (node: PatchDocument['nodes'][number]): Array<[LogueKnob, string?]> => {
    if (node.kind !== 'obj') return []
    const legacy = supersededKnobBinding(node.type)?.[platform]
    if (legacy) return [[legacy]]
    return node.params
      .filter((p) => p.logueKnob?.[platform] !== undefined)
      .map((p) => [p.logueKnob![platform]!, p.name])
  }
  const knobsInside = (type: string, seen: Set<string>): Set<LogueKnob> => {
    const found = new Set<LogueKnob>()
    const def = defs.get(type)
    if (!def || seen.has(type)) return found
    seen.add(type)
    for (const node of def.nodes) {
      for (const [knob] of knobsOfNode(node)) found.add(knob)
      if (node.kind === 'obj' && isSubpatchInstanceType(node.type)) {
        for (const k of knobsInside(node.type, seen)) found.add(k)
      }
    }
    return found
  }
  const nodeNames = new Map<string, string>()
  rootDoc.nodes.forEach((node, i) => nodeNames.set(nodeId(node, i), node.name ?? nodeId(node, i)))
  const wiresFrom = (name: string): string[] =>
    rootDoc.nets
      .filter((net) => net.sources.some((s) => s.obj === name))
      .flatMap((net) =>
        net.dests.map((d) => {
          const dest = nodeNames.get(d.obj) ?? d.obj
          return d.inlet ? `${dest} · ${d.inlet}` : dest
        })
      )

  rootDoc.nodes.forEach((node, i) => {
    if (node.kind !== 'obj') return
    const id = nodeId(node, i)
    const name = node.name ?? id
    // A promoted param inside a definition is the instance's to bind, not the definition's.
    const promotedHere = (paramName: string | undefined): boolean =>
      rootDoc.settings.subpatch === true &&
      node.params.some((p) => p.name === paramName && p.subpatchExpose)
    for (const [knob, paramName] of knobsOfNode(node)) {
      if (promotedHere(paramName)) continue
      const reads =
        paramName === undefined || findLoguePrimitive(node.type)?.id === DEVICE_CONTROL_ID
      assignments[knob].push({
        nodeId: id,
        nodeName: name,
        paramName,
        legacy: paramName === undefined || undefined,
        wiredTo: reads ? wiresFrom(name) : undefined
      })
    }
    if (isSubpatchInstanceType(node.type)) {
      for (const knob of knobsInside(node.type, new Set())) {
        assignments[knob].push({ nodeId: id, nodeName: name, insideSubpatch: true })
      }
    }
  })
  return assignments
}

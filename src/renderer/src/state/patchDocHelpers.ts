import type { PatchDocument, PatchNode, ObjNode } from '@shared/domain/patch'
import type {
  ParamValue,
  LogueParamSlot,
  LogueParamPlatform,
  LogueKnob
} from '@shared/domain/paramValueTypes'
import { serializePatchFile } from '@shared/json/patchCodec'
import { nodeId } from './nodeId'
import { autoArrangeDocumentTree } from '../canvas/autoArrange'
import type { PrimitiveParamSpec } from '@logue-codegen/primitives'
import { normalizeRenamedFields } from '@logue-codegen/renamedFields'
import {
  defaultPromotedParamName,
  isSubpatchInstanceType,
  LOGUE_SUBPATCH_INLET_TYPE,
  LOGUE_SUBPATCH_OUTLET_TYPE
} from '@logue-codegen/subpatches'
import { ALL_LOGUE_PLATFORMS } from './exposedLogueParams'

// Pure document helpers behind patchStore.ts's actions: no store access, so they're testable
// and reusable on their own.

export function withNodes(doc: PatchDocument, nodes: PatchNode[]): PatchDocument {
  return { ...doc, nodes }
}

/**
 * Fixes node-overlap from Axoloti's original tiny node footprint automatically on file
 * load (see autoArrange.ts's `autoArrangeDocumentTree` doc comment) -- previously this only
 * ran from the manual "Rearrange" button, so every freshly-opened legacy file rendered with
 * adjacent nodes' DOM boxes overlapping by tens of pixels, breaking click/drag hit-testing
 * near node edges. No DOM measurements exist yet at load time either, so this only ever uses
 * `estimateNodeSize`'s approximation (still enough to fix the gross whole-node-overlap
 * case) -- never marks the doc dirty, and never blocks a load if `autoArrangeNodes`'s own
 * order-preservation guard throws, since a cosmetic fix must never turn a real file into
 * one that "fails to open."
 */
export function arrangeForLoad(doc: PatchDocument): PatchDocument {
  const current = normalizeRenamedFields(doc)
  try {
    return autoArrangeDocumentTree(current)
  } catch {
    return current
  }
}

/** Appends `_<n>` until `base` no longer collides with anything in `taken` -- shared by `uniqueNodeName` and paste's own batch-renaming (see `pasteFromClipboard`), which grows `taken` as it claims each new name so pasted siblings never collide with each other either. */
export function disambiguateName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  let i = 1
  while (taken.has(`${base}_${i}`)) i++
  return `${base}_${i}`
}

/**
 * `excludeName` lets a rename check for collisions against every *other* node without the node's
 * own current name always forcing a spurious `_1` suffix onto itself.
 */
export function uniqueNodeName(doc: PatchDocument, base: string, excludeName?: string): string {
  const existing = new Set(
    doc.nodes.map((n) => n.name).filter((n): n is string => n !== undefined && n !== excludeName)
  )
  const safeBase = base.replace(/[^a-zA-Z0-9_]/g, '_') || 'obj'
  return disambiguateName(safeBase, existing)
}

/**
 * Value equality for a per-platform slot map -- `setLogueParam`'s own no-op check can't use `===`
 * here the way it safely could when `logueParamIndex` was a flat number, since two callers
 * legitimately building "the same" map (e.g. re-deriving it rather than reusing one object
 * reference) would otherwise wrongly count as a change and cost an undo entry for nothing.
 */
/** A per-platform map (slots, knob bindings) with `platform`'s entry removed; `undefined` once
 *  empty, so a cleared binding leaves no `{}` behind in the saved file. */
export function withoutPlatform<T>(
  map: Partial<Record<LogueParamPlatform, T>> | undefined,
  platform: LogueParamPlatform
): Partial<Record<LogueParamPlatform, T>> | undefined {
  if (map?.[platform] === undefined) return map
  const next = { ...map }
  delete next[platform]
  return Object.keys(next).length > 0 ? next : undefined
}

export function logueParamSlotsEqual(
  a: LogueParamSlot | undefined,
  b: LogueParamSlot | undefined
): boolean {
  return a?.nts1mkii === b?.nts1mkii && a?.['minilogue-xd'] === b?.['minilogue-xd']
}

/**
 * A freshly placed/replaced node's `freeLabel` param (logue/sense/control's VALUE). In a root
 * patch it starts with no device control: which control it should be (a knob, a menu param, or
 * following one) is a choice made in the Param Matrix, and until then the node's "Not on <device>"
 * badge and the Build panel say it outputs a constant. (It used to take the next free menu slot on
 * every platform, which made Export fail until it was named.) Inside a subpatch definition, which
 * never owns a menu slot, it is promoted onto the subpatch's outer interface instead, where each
 * instance can assign it. A subpatch instance's own promoted params are `freeLabel` too (for their
 * per-instance label) but are left unassigned: which of them reach the device is each instance's
 * own choice.
 */
export function initialFreeLabelParam(
  doc: PatchDocument,
  type: string,
  nodeName: string,
  spec: PrimitiveParamSpec
): ParamValue {
  const base = { name: spec.name, value: String(spec.default) }
  if (doc.settings.subpatch && !isSubpatchInstanceType(type)) {
    return { ...base, subpatchExpose: { outerName: defaultPromotedParamName(nodeName, spec.name) } }
  }
  return base
}

/** An untitled subpatch definition: one inlet and one outlet, no audio-out (a definition sends
 *  its signal out through its outlet nodes instead). Carries `logueTarget` like any logue
 *  document so the palette and insert popup work in it. */
export function newSubpatchDocument(): PatchDocument {
  const port = (type: string, name: string, x: number): ObjNode => ({
    kind: 'obj',
    type,
    name,
    x,
    y: 180,
    params: []
  })
  return {
    nodes: [
      port(LOGUE_SUBPATCH_INLET_TYPE, 'in', 60),
      port(LOGUE_SUBPATCH_OUTLET_TYPE, 'out', 480)
    ],
    nets: [],
    settings: { logueTarget: { module: 'osc' }, subpatch: true },
    notes: ''
  }
}

/**
 * Builds a clipboard-ready JSON fragment for a copy/cut of `selectedIds` within `doc` -- reuses
 * this app's own `.loguepatch` serializer (`serializePatchFile`), wrapped as a tiny synthetic
 * `PatchDocument` (`doc.settings`/empty notes carried along only because `PatchSettings` is
 * required; `pasteFromClipboard` discards both again). A net survives only if it still has at
 * least one source AND one dest after dropping any endpoint outside the selection -- mirrors
 * `deleteNodes`'s own both-sides-required filter.
 */
export function serializeSelectionForClipboard(doc: PatchDocument, selectedIds: string[]): string {
  const idSet = new Set(selectedIds)
  const nodes = doc.nodes.filter((n, i) => idSet.has(nodeId(n, i)))
  const nameSet = new Set(nodes.map((n) => n.name).filter((n): n is string => n !== undefined))
  const nets = doc.nets
    .map((net) => ({
      sources: net.sources.filter((s) => nameSet.has(s.obj)),
      dests: net.dests.filter((d) => nameSet.has(d.obj))
    }))
    .filter((net) => net.sources.length > 0 && net.dests.length > 0)
  return serializePatchFile({ nodes, nets, settings: doc.settings, notes: '' })
}

/** A param by its node id and name; `value` seeds a `ParamValue` it doesn't have yet. */
export interface DeviceParamRef {
  nodeId: string
  paramName: string
  value: string
}

/**
 * Every device control on one platform, as the Param Matrix edits it: the menu params in device
 * order, the params on a fixed knob, and the params following another one's slot (by the lead's
 * identity, not a slot number, so a follower moves with its lead when the order changes).
 */
export interface PlatformControlLayout {
  order: DeviceParamRef[]
  knobs: Array<DeviceParamRef & { knob: LogueKnob }>
  follows: Array<DeviceParamRef & { lead: { nodeId: string; paramName: string } }>
}

const paramKey = (nodeIdValue: string, paramName: string): string =>
  `${nodeIdValue}\u0000${paramName}`

/** `doc`'s current layout on `platform` (order by slot; a follower of an unowned slot dropped). */
export function currentPlatformLayout(
  doc: PatchDocument,
  platform: LogueParamPlatform
): PlatformControlLayout {
  const bySlot: Array<DeviceParamRef & { slot: number }> = []
  const knobs: PlatformControlLayout['knobs'] = []
  const followSlots: Array<DeviceParamRef & { slot: number }> = []
  doc.nodes.forEach((n, i) => {
    if (n.kind !== 'obj') return
    const id = nodeId(n, i)
    for (const p of n.params) {
      const ref = { nodeId: id, paramName: p.name, value: p.value }
      const slot = p.logueParamIndex?.[platform]
      const knob = p.logueKnob?.[platform]
      const follow = p.logueFollow?.[platform]
      if (slot !== undefined) bySlot.push({ ...ref, slot })
      else if (knob !== undefined) knobs.push({ ...ref, knob })
      else if (follow !== undefined) followSlots.push({ ...ref, slot: follow })
    }
  })
  bySlot.sort((a, b) => a.slot - b.slot)
  const follows: PlatformControlLayout['follows'] = []
  for (const f of followSlots) {
    const lead = bySlot.find((b) => b.slot === f.slot)
    if (lead) {
      follows.push({
        nodeId: f.nodeId,
        paramName: f.paramName,
        value: f.value,
        lead: { nodeId: lead.nodeId, paramName: lead.paramName }
      })
    }
  }
  return {
    order: bySlot.map(({ nodeId: id, paramName, value }) => ({ nodeId: id, paramName, value })),
    knobs,
    follows
  }
}

/**
 * `doc`'s nodes with `platform`'s device controls replaced by `layout` -- every param gets at
 * most one of slot / knob / follow there (a param listed twice keeps the first of those three),
 * the order is laid out gap-free by `slotsFor`, a follower whose lead has no slot is dropped, and
 * every other platform's controls are untouched. `null` when nothing changes.
 */
export function applyPlatformLayout(
  doc: PatchDocument,
  platform: LogueParamPlatform,
  layout: PlatformControlLayout,
  slotsFor: (count: number) => number[]
): PatchNode[] | null {
  const slots = slotsFor(layout.order.length)
  const slotByKey = new Map<string, number>()
  layout.order.slice(0, slots.length).forEach((r, n) => {
    slotByKey.set(paramKey(r.nodeId, r.paramName), slots[n])
  })
  const knobByKey = new Map<string, LogueKnob>()
  for (const r of layout.knobs) {
    const key = paramKey(r.nodeId, r.paramName)
    if (!slotByKey.has(key)) knobByKey.set(key, r.knob)
  }
  const followByKey = new Map<string, number>()
  for (const r of layout.follows) {
    const key = paramKey(r.nodeId, r.paramName)
    const leadSlot = slotByKey.get(paramKey(r.lead.nodeId, r.lead.paramName))
    if (leadSlot !== undefined && !slotByKey.has(key) && !knobByKey.has(key)) {
      followByKey.set(key, leadSlot)
    }
  }
  const seeds = new Map<string, DeviceParamRef>()
  for (const r of [...layout.order, ...layout.knobs, ...layout.follows]) {
    seeds.set(paramKey(r.nodeId, r.paramName), r)
  }

  const set = <T>(
    map: Partial<Record<LogueParamPlatform, T>> | undefined,
    v: T | undefined
  ): Partial<Record<LogueParamPlatform, T>> | undefined =>
    v === undefined ? withoutPlatform(map, platform) : { ...map, [platform]: v }

  let changed = false
  const nodes = doc.nodes.map((n, i) => {
    if (n.kind !== 'obj') return n
    const id = nodeId(n, i)
    let nodeChanged = false
    const params = n.params.map((p) => {
      const key = paramKey(id, p.name)
      const slot = slotByKey.get(key)
      const knob = knobByKey.get(key)
      const follow = followByKey.get(key)
      if (
        p.logueParamIndex?.[platform] === slot &&
        p.logueKnob?.[platform] === knob &&
        p.logueFollow?.[platform] === follow
      ) {
        return p
      }
      nodeChanged = true
      const next: ParamValue = { ...p }
      const logueParamIndex = set(p.logueParamIndex, slot)
      const logueKnob = set(p.logueKnob, knob)
      const logueFollow = set(p.logueFollow, follow)
      if (logueParamIndex) next.logueParamIndex = logueParamIndex
      else delete next.logueParamIndex
      if (logueKnob) next.logueKnob = logueKnob
      else delete next.logueKnob
      if (logueFollow) next.logueFollow = logueFollow
      else delete next.logueFollow
      return next
    })
    for (const [key, seed] of seeds) {
      if (seed.nodeId !== id || params.some((p) => p.name === seed.paramName)) continue
      const slot = slotByKey.get(key)
      const knob = knobByKey.get(key)
      const follow = followByKey.get(key)
      if (slot === undefined && knob === undefined && follow === undefined) continue
      nodeChanged = true
      params.push({
        name: seed.paramName,
        value: seed.value,
        ...(slot !== undefined && { logueParamIndex: { [platform]: slot } }),
        ...(knob !== undefined && { logueKnob: { [platform]: knob } }),
        ...(follow !== undefined && { logueFollow: { [platform]: follow } })
      })
    }
    if (!nodeChanged) return n
    changed = true
    return { ...n, params }
  })
  return changed ? nodes : null
}

/**
 * `doc` with every slot-following that has lost its lead (no param owns that slot on that
 * platform any more) cleared -- run after an edit that can remove a lead (deleting a node,
 * replacing its type, removing a param entry), since a follower of nothing fails Export and is
 * invisible in the Param Matrix. Returns `doc` itself when nothing was orphaned.
 */
export function dropOrphanedFollows(doc: PatchDocument): PatchDocument {
  const owned = new Set<string>()
  for (const n of doc.nodes) {
    if (n.kind !== 'obj') continue
    for (const p of n.params) {
      for (const platform of ALL_LOGUE_PLATFORMS) {
        const slot = p.logueParamIndex?.[platform]
        if (slot !== undefined) owned.add(`${platform}:${slot}`)
      }
    }
  }
  let changed = false
  const nodes = doc.nodes.map((n) => {
    if (n.kind !== 'obj') return n
    let nodeChanged = false
    const params = n.params.map((p) => {
      let follow = p.logueFollow
      for (const platform of ALL_LOGUE_PLATFORMS) {
        const slot = follow?.[platform]
        if (slot !== undefined && !owned.has(`${platform}:${slot}`)) {
          follow = withoutPlatform(follow, platform)
        }
      }
      if (follow === p.logueFollow) return p
      nodeChanged = true
      const next: ParamValue = { ...p }
      if (follow) next.logueFollow = follow
      else delete next.logueFollow
      return next
    })
    if (!nodeChanged) return n
    changed = true
    return { ...n, params }
  })
  return changed ? withNodes(doc, nodes) : doc
}

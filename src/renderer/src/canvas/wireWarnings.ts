import type { ObjNode, PatchDocument } from '@shared/domain/patch'
import { findInletModulation } from '@logue-codegen/paramModulation'
import { additiveDepthOf } from '@logue-codegen/paramPresentation'
import { resolveDeclaredOutletName } from '@logue-codegen/primitives'
import { resolveNodePrimitive } from '../state/subpatchLibraryStore'
import { nodeId } from '../state/nodeId'
import { createWirePolarityResolver, type ResolvedWireBucket } from './wirePolarity'

/** Primitives whose outlets read a device knob's position (`sense/control` and the superseded
 *  readers it replaced) -- a physical control, where a dead stretch of travel is never wanted. */
const KNOB_READERS = new Set([
  'logue/sense/control',
  'logue/sense/shape',
  'logue/sense/shape-2',
  'logue/sense/cutoff',
  'logue/sense/resonance',
  'logue/sense/param'
])

function objByName(doc: PatchDocument, name: string): ObjNode | undefined {
  const node = doc.nodes.find((n) => n.kind === 'obj' && n.name === name)
  return node?.kind === 'obj' ? node : undefined
}

/** A `sense/control` only moves once it has a device control on some platform. */
function readsAKnob(node: ObjNode): boolean {
  if (!KNOB_READERS.has(node.type)) return false
  if (node.type !== 'logue/sense/control') return true
  return node.params.some((p) =>
    [p.logueParamIndex, p.logueKnob, p.logueFollow].some(
      (control) => control !== undefined && Object.keys(control).length > 0
    )
  )
}

const fmt = (n: number): string => String(Math.round(n * 10) / 10)

/**
 * A knob reading wired straight into an additive inlet whose clamp swallows part of the knob's
 * travel: `dial + x * depth` leaves the param's range for some of `x`'s, and over that stretch
 * the knob does nothing (the Radio patch: a bipolar Depth reading into a crossfader `fade` with
 * FADE at 50 sat at 0 below a quarter of the knob and at 100 above three quarters). LFOs and
 * envelopes aren't checked: clipping their swing can be the sound (user's call, 2026-10-03).
 */
export function knobDeadZoneWarning(
  doc: PatchDocument,
  source: { obj: string; outlet: string },
  dest: { obj: string; inlet: string }
): string | undefined {
  const sourceNode = objByName(doc, source.obj)
  if (!sourceNode || !readsAKnob(sourceNode)) return undefined
  if (source.outlet !== 'unipolar' && source.outlet !== 'bipolar') return undefined
  const destNode = objByName(doc, dest.obj)
  const destPrimitive = destNode && resolveNodePrimitive(destNode.type)
  const found = destPrimitive && findInletModulation(destPrimitive, dest.inlet)
  const spec =
    found && destPrimitive.params?.find((p) => p.name === found.paramName && p.modulatedBy)
  if (!spec || found.modulation.shape !== 'additive' || found.modulation.unclamped) return undefined

  const stored = Number(destNode.params.find((p) => p.name === spec.name)?.value)
  const dial = Number.isFinite(stored) ? stored : spec.default
  const depth = additiveDepthOf(spec)
  const range = (outlet: string): [number, number] => (outlet === 'bipolar' ? [-1, 1] : [0, 1])
  const [x0, x1] = range(source.outlet)
  const share = (from: number, to: number): number =>
    Math.min(1, Math.max(0, (to - from) / (x1 - x0)))
  // The knob positions (as x) where the sum leaves the range.
  const low = share(x0, (spec.min - dial) / depth)
  const high = share((spec.max - dial) / depth, x1)
  if (low + high < 0.02) return undefined

  const dead = [
    low >= 0.01 && `at ${fmt(spec.min)} for the first ${Math.round(low * 100)} %`,
    high >= 0.01 && `at ${fmt(spec.max)} for the last ${Math.round(high * 100)} %`
  ].filter(Boolean)
  // The dials that keep `dial + x * depth` inside the range over the outlet's whole swing.
  const fits = (outlet: string): [number, number] | undefined => {
    const [a, b] = range(outlet)
    const lo = spec.min - a * depth
    const hi = spec.max - b * depth
    return lo <= hi ? [lo, hi] : undefined
  }
  const here = fits(source.outlet)
  const otherOutlet = source.outlet === 'bipolar' ? 'unipolar' : 'bipolar'
  const there = fits(otherOutlet)
  const dialText = ([lo, hi]: [number, number]): string =>
    lo === hi ? `at ${fmt(lo)}` : `between ${fmt(lo)} and ${fmt(hi)}`
  const fix = here
    ? `Set ${spec.name} ${dialText(here)} to use the whole travel.`
    : there
      ? `For the whole travel, wire the ${otherOutlet} outlet and set ${spec.name} ${dialText(there)}.`
      : ''
  return `Part of the knob does nothing here: ${spec.name} stays ${dead.join(' and ')} of its travel. ${fix}`.trim()
}

/** Every wire's warning in one place: the inlet's own `expects.warnFrom`, else a knob dead zone. */
export function wireWarning(
  doc: PatchDocument,
  bucket: ResolvedWireBucket,
  source: { obj: string; outlet: string },
  dest: { obj: string; inlet: string }
): string | undefined {
  const destType = objByName(doc, dest.obj)?.type
  const destPrimitive = destType ? resolveNodePrimitive(destType) : undefined
  const expects =
    destPrimitive && findInletModulation(destPrimitive, dest.inlet)?.modulation.expects
  if (bucket !== 'neutral' && bucket !== 'buffer' && expects?.warnFrom?.includes(bucket)) {
    return expects.warning
  }
  return knobDeadZoneWarning(doc, source, dest)
}

/** The warnings on every wire into `nodeName`, keyed by inlet. */
function warningsInto(doc: PatchDocument, nodeName: string): Map<string, string | undefined> {
  const typeById = new Map(
    doc.nodes.map((n, i) => [nodeId(n, i), n.kind === 'obj' ? n.type : undefined])
  )
  const resolve = createWirePolarityResolver(doc, typeById)
  const result = new Map<string, string | undefined>()
  for (const net of doc.nets) {
    if (net.sources.length !== 1) continue
    const [src] = net.sources
    const srcPrimitive = resolveNodePrimitive(typeById.get(src.obj) ?? '')
    const outlet =
      (srcPrimitive && resolveDeclaredOutletName(srcPrimitive, src.outlet)) ?? src.outlet ?? 'out'
    for (const d of net.dests) {
      if (d.obj !== nodeName || d.inlet === undefined) continue
      result.set(
        d.inlet,
        wireWarning(
          doc,
          resolve(src.obj, outlet),
          { obj: src.obj, outlet },
          { obj: d.obj, inlet: d.inlet }
        )
      )
    }
  }
  return result
}

/** Whether an edit to `nodeName` changed a warning on a wire into it -- a dial a wire's dead zone
 *  depends on is read live, but warnings are projected per canvas mount. */
export function inletWarningsChanged(
  before: PatchDocument,
  after: PatchDocument,
  nodeName: string
): boolean {
  const was = warningsInto(before, nodeName)
  const now = warningsInto(after, nodeName)
  return [...now].some(([inlet, warning]) => was.get(inlet) !== warning)
}

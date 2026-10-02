import type { Net, ObjNode, PatchDocument, PatchNode } from '../../src/shared/domain/patch'
import type { LogueKnobBinding } from '../../src/shared/domain/paramValueTypes'
import { canonicalPrimitiveId, findLoguePrimitive } from './primitives'

const SENSE_CONTROL_ID = 'logue/sense/control'

/** The knob each superseded knob-reading sense primitive read, as a `sense/control` binding: on
 *  every platform the old primitive ran on. `sense/cutoff`/`sense/resonance` aren't here: the
 *  xd's filter knobs never reach an oscillator (`unitKinds.ts`), so they become an unbound
 *  control, which the canvas badges as having no device control. */
const SUPERSEDED_KNOB_READERS: Record<string, LogueKnobBinding> = {
  'logue/sense/shape': { 'minilogue-xd': 'shape', nts1mkii: 'shape' },
  'logue/sense/shape-2': { 'minilogue-xd': 'shape-2', nts1mkii: 'shape-2' }
}

/** The knob a superseded knob-reading node type (old ids included) reads, per platform. */
export function supersededKnobBinding(nodeType: string): LogueKnobBinding | undefined {
  return SUPERSEDED_KNOB_READERS[canonicalPrimitiveId(nodeType)]
}

/**
 * A superseded sense node as the `sense/control` that reads the same thing: a knob reader becomes
 * a control bound to that knob (VALUE 0, so the knob starts where the old reader started), and
 * `sense/param` keeps its VALUE entry -- value, label, slots -- unchanged. Outlet names are the
 * same, so every wire stays valid.
 */
function migrateSupersededSenseNode(node: ObjNode, id: string): ObjNode | undefined {
  if (findLoguePrimitive(id)?.supersededBy !== SENSE_CONTROL_ID) return undefined
  const knob = SUPERSEDED_KNOB_READERS[id]
  if (knob) {
    return {
      ...node,
      type: SENSE_CONTROL_ID,
      params: [{ name: 'VALUE', value: '0', logueKnob: knob }]
    }
  }
  return { ...node, type: SENSE_CONTROL_ID }
}

/**
 * Rewrites every old primitive id and every value-preserving `renamedParams`/`renamedInlets`
 * alias to the current name, so the editor only ever sees current names. Codegen already
 * resolves these aliases on its own, but the canvas draws a wire by its stored inlet name (an old
 * one looked broken) and `setLogueParam` edits a param by its stored name (turning a dial whose
 * value was stored under an old name added a second entry, without the old one's device slot).
 * Run when a document is opened or pasted. Aliases that change meaning (`valuePreserving: false`)
 * are left alone so `findUnresolvedReferences` still flags them. A param is not renamed if the
 * node also stores the current name (that entry already wins). A `supersededBy` sense primitive
 * becomes the `sense/control` that reads the same device control. Returns `doc` itself when
 * nothing changed.
 */
export function normalizeRenamedFields(doc: PatchDocument): PatchDocument {
  let changed = false
  const inletRenames = new Map<string, Map<string, string>>()
  const nodes = doc.nodes.map((node): PatchNode => {
    if (node.kind !== 'obj') return node
    const primitive = findLoguePrimitive(node.type)
    if (!primitive) return node
    const type = canonicalPrimitiveId(node.type)
    const migrated = migrateSupersededSenseNode(node, type)
    if (migrated) {
      changed = true
      return migrated
    }
    const stored = new Set(node.params.map((p) => p.name))
    const params = node.params.map((p) => {
      const alias = primitive.renamedParams?.find((a) => a.from === p.name && a.valuePreserving)
      return alias && !stored.has(alias.to) ? { ...p, name: alias.to } : p
    })
    const inlets = new Map(
      (primitive.renamedInlets ?? []).filter((a) => a.valuePreserving).map((a) => [a.from, a.to])
    )
    if (inlets.size > 0 && node.name !== undefined) inletRenames.set(node.name, inlets)
    if (type === node.type && params.every((p, i) => p === node.params[i])) return node
    changed = true
    return { ...node, type, params }
  })
  const nets = doc.nets.map((net): Net => {
    const dests = net.dests.map((d) => {
      const to = d.inlet === undefined ? undefined : inletRenames.get(d.obj)?.get(d.inlet)
      return to === undefined ? d : { ...d, inlet: to }
    })
    if (dests.every((d, i) => d === net.dests[i])) return net
    changed = true
    return { ...net, dests }
  })
  return changed ? { ...doc, nodes, nets } : doc
}

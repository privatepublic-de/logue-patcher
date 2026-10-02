import type { PatchDocument, PatchNode } from '../domain/patch'

/** The file version whose inlets below became additive (`PATCH_FILE_VERSION` 4). */
export const ADDITIVE_DIAL_INLETS_FILE_VERSION = 4

/**
 * Inlets that REPLACED their dial when wired before file version 4 and add to it (at depth 100,
 * the dial's whole range) since. Keyed by node type, including the old id `lowpass-cheap` had,
 * since this runs on the raw decoded document before any rename is applied. Hand-kept rather
 * than read off the primitive registry: it records what the old format meant, which must not
 * move when a primitive changes later.
 */
const FORMER_REPLACE_INLETS: Record<string, { inlet: string; param: string }> = {
  'logue/filter/lowpass': { inlet: 'cutoff', param: 'CUTOFF' },
  'logue/filter/lowpass-cheap': { inlet: 'cutoff', param: 'CUTOFF' },
  'logue/filter/highpass-cheap': { inlet: 'cutoff', param: 'CUTOFF' },
  'logue/filter/svf': { inlet: 'cutoff', param: 'CUTOFF' },
  'logue/mix/crossfader': { inlet: 'fade', param: 'FADE' },
  'logue/osc/additive': { inlet: 'timbre', param: 'TIMBRE' }
}

/**
 * Sets the dial to 0 on every wired former-replace inlet of a pre-v4 document, so it keeps
 * sounding the same: old `clamp(wire, 0..1)` equals new `clamp(dial + wire, 0..1)` exactly at
 * dial 0. The dial was dead while wired, so nothing audible is lost, except: a definition's inlet
 * fed by an inlet port, whose instance leaves that port unwired, used to hear the dial and now
 * hears 0 (no single value is right for both; the wired case is what the port exists for); a
 * promoted param keeps each instance's own value, which now adds; and a param with a device
 * control becomes a live control. A param entry is added when the file relied on the default.
 */
export function migrateAdditiveDialInlets(doc: PatchDocument): PatchDocument {
  const wired = new Set<string>()
  for (const net of doc.nets) for (const d of net.dests) wired.add(`${d.obj}\u0000${d.inlet}`)
  let changed = false
  const nodes = doc.nodes.map((node): PatchNode => {
    if (node.kind !== 'obj' || node.name === undefined) return node
    const former = FORMER_REPLACE_INLETS[node.type]
    if (!former || !wired.has(`${node.name}\u0000${former.inlet}`)) return node
    const existing = node.params.find((p) => p.name === former.param)
    if (existing?.value === '0') return node
    changed = true
    return {
      ...node,
      params: existing
        ? node.params.map((p) => (p === existing ? { ...p, value: '0' } : p))
        : [...node.params, { name: former.param, value: '0' }]
    }
  })
  return changed ? { ...doc, nodes } : doc
}

import type { LoguePlatform, PatchDocument } from '../../src/shared/domain/patch'
import { UnsupportedLogueNodeError } from './oscInstances'
import { findAliasedFieldValue, findLoguePrimitive } from './primitives'
import { resolvePlatformGraph } from './resolveUnit'
import type { SubpatchDefinitions } from './subpatches'

export interface UnboundDeviceControl {
  /** The flattened node name (`f1_ctl` for one inside subpatch instance `f1`). */
  nodeName: string
  /** What it outputs instead: its authored VALUE, 0..100. */
  value: number
}

/**
 * Every active `logue/sense/control` with no device control on `platform` -- it builds, as the
 * constant VALUE, which is worth a warning since a device control that reaches nothing is almost
 * always a forgotten assignment (typically one made only for the other device). Empty for a graph
 * `platform` can't build; the generators report that themselves.
 */
export function listUnboundDeviceControls(
  doc: PatchDocument,
  subpatches: SubpatchDefinitions,
  platform: LoguePlatform
): UnboundDeviceControl[] {
  let activeInstances
  try {
    ;({ activeInstances } = resolvePlatformGraph(doc, subpatches, platform))
  } catch (e) {
    if (e instanceof UnsupportedLogueNodeError) return []
    throw e
  }
  const unbound: UnboundDeviceControl[] = []
  for (const inst of activeInstances) {
    if (inst.id !== 'logue/sense/control') continue
    const primitive = findLoguePrimitive(inst.id)!
    const spec = primitive.params![0]
    const pv = findAliasedFieldValue(primitive.renamedParams, spec.name, inst.node.params)
    if (
      pv?.logueParamIndex?.[platform] !== undefined ||
      pv?.logueKnob?.[platform] !== undefined ||
      pv?.logueFollow?.[platform] !== undefined
    ) {
      continue
    }
    const value = Number(pv?.value)
    unbound.push({
      nodeName: inst.node.name ?? inst.suffix,
      value: Number.isFinite(value) ? value : spec.default
    })
  }
  return unbound
}

import { describe, it, expect } from 'vitest'
import {
  findLoguePrimitive,
  isBufferOutlet,
  recognizedLoguePrimitiveIds,
  type LoguePrimitive
} from '../logue-codegen/src/primitives'
import { findBooleanWidget } from '../logue-codegen/src/paramTrackGate'
import { generateOscUnit } from '../logue-codegen/src/nts1mkii/generateOscUnit'
import { generateOldGenOscUnit } from '../logue-codegen/src/minilogue-xd/generateOscUnit'
import { generateFxUnit } from '../logue-codegen/src/nts1mkii/generateFxUnit'
import { generateOldGenFxUnit } from '../logue-codegen/src/minilogue-xd/generateFxUnit'
import { LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import { isEffectModule } from '../logue-codegen/src/unitKinds'
import type { ParamValue } from '../src/shared/domain/paramValueTypes'
import type { LoguePlatform, Net, ObjNode, PatchDocument } from '../src/shared/domain/patch'
import { testSampleFor } from './support/testSample'

/**
 * Golden output for every primitive on both platforms: the whole generated source for the node
 * alone, with every inlet wired (one `util/constant` per inlet, so each inlet's read is
 * distinguishable), with each boolean widget flipped, and with every param exposed in turn (so
 * the manifest/header param types are covered too). A refactor of the registry that claims to be
 * output-neutral must leave these files untouched.
 */

const NODE = 'n'
const PLATFORM_SLOTS: Record<LoguePlatform, { first: number; count: number }> = {
  nts1mkii: { first: 2, count: 8 },
  'minilogue-xd': { first: 0, count: 6 }
}

function node(p: LoguePrimitive, params: ParamValue[]): ObjNode {
  return {
    kind: 'obj',
    type: p.id,
    name: NODE,
    x: 0,
    y: 0,
    params,
    sample: testSampleFor(p)
  }
}

/** An effect-only primitive (`modules` without `osc`) is shown in a delay effect. */
const onlyInEffects = (p: LoguePrimitive): boolean => !!p.modules && !p.modules.includes('osc')

/**
 * A buffer writer (whose outlet is a buffer wire, not a signal) reaches the output through a
 * `util/buffer-tap`; a buffer inlet is wired from a `util/buffer` rather than a constant.
 */
function doc(p: LoguePrimitive, params: ParamValue[], wired: boolean): PatchDocument {
  const firstOutlet = p.outlets?.[0]?.name ?? 'out'
  const effect = onlyInEffects(p)
  const out = { obj: 'audio-out', inlet: effect ? 'l' : 'in' }
  const constants: ObjNode[] = []
  const nets: Net[] = []
  if (isBufferOutlet(p, firstOutlet)) {
    constants.push({
      kind: 'obj',
      type: 'logue/util/buffer-tap',
      name: 'tap',
      x: 0,
      y: 0,
      params: []
    })
    nets.push(
      { sources: [{ obj: NODE, outlet: firstOutlet }], dests: [{ obj: 'tap', inlet: 'buf' }] },
      { sources: [{ obj: 'tap', outlet: 'out' }], dests: [out] }
    )
  } else {
    nets.push({ sources: [{ obj: NODE, outlet: firstOutlet }], dests: [out] })
  }
  if (wired) {
    for (const inlet of p.inlets ?? []) {
      const name = `c_${inlet.name}`
      const buffer = inlet.role === 'buffer'
      constants.push({
        kind: 'obj',
        type: buffer ? 'logue/util/buffer' : 'logue/util/constant',
        name,
        x: 0,
        y: 0,
        params: buffer ? [] : [{ name: 'VALUE', value: '37' }]
      })
      nets.push({
        sources: [{ obj: name, outlet: buffer ? 'buf' : 'out' }],
        dests: [{ obj: NODE, inlet: inlet.name }]
      })
    }
  }
  return {
    nodes: [
      node(p, params),
      ...constants,
      { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'audio-out', x: 0, y: 0, params: [] }
    ],
    nets,
    settings: { logueTarget: { module: effect ? 'delfx' : 'osc' } },
    notes: ''
  }
}

// unit.cc and the xd manifest only vary with exposed params, so the other variants skip them.
function render(platform: LoguePlatform, d: PatchDocument, withParams = true): string {
  if (isEffectModule(d.settings.logueTarget!.module) && platform === 'minilogue-xd') {
    const out = generateOldGenFxUnit(d, { name: 'snap' })
    return `// fx.cpp\n${out.fxCpp}`
  }
  if (isEffectModule(d.settings.logueTarget!.module)) {
    const out = generateFxUnit(d, { name: 'snap' })
    const unit = withParams ? `\n// unit.cc\n${out.unitCc}` : ''
    return `// header.c\n${out.headerC}\n// fx.h\n${out.fxH}${unit}`
  }
  if (platform === 'nts1mkii') {
    const out = generateOscUnit(d, { name: 'snap' })
    const unit = withParams ? `\n// unit.cc\n${out.unitCc}` : ''
    return `// header.c\n${out.headerC}\n// osc.h\n${out.oscH}${unit}`
  }
  const out = generateOldGenOscUnit(d, { name: 'snap' })
  const manifest = withParams ? `// manifest.json\n${out.manifestJson}\n` : ''
  return `${manifest}// osc.cpp\n${out.oscCpp}`
}

function variants(p: LoguePrimitive, platform: LoguePlatform): Array<[string, PatchDocument]> {
  const specs = p.params ?? []
  const out: Array<[string, PatchDocument]> = [
    ['unwired', doc(p, [], false)],
    ['wired', doc(p, [], true)]
  ]
  for (const spec of specs) {
    if (!findBooleanWidget(p.id, spec.name)) continue
    const flipped = spec.default >= 50 ? '0' : '100'
    const params = [{ name: spec.name, value: flipped }]
    out.push([`${spec.name}=${flipped} unwired`, doc(p, params, false)])
    out.push([`${spec.name}=${flipped} wired`, doc(p, params, true)])
  }
  // An xd effect has no menu slots at all.
  if (onlyInEffects(p) && platform === 'minilogue-xd') return out
  // A delay effect's menu slots start after TIME/DPTH/MIX; a structural param has no slot.
  const { first, count } = onlyInEffects(p) ? { first: 3, count: 8 } : PLATFORM_SLOTS[platform]
  const exposable = specs.filter((spec) => !spec.structural)
  for (let start = 0; start < exposable.length; start += count) {
    const chunk = exposable.slice(start, start + count)
    const params: ParamValue[] = chunk.map((spec, i) => ({
      name: spec.name,
      value: String(spec.default),
      logueParamIndex: { [platform]: first + i },
      label: spec.freeLabel ? 'Label' : undefined
    }))
    out.push([`exposed ${chunk.map((s) => s.name).join(',')}`, doc(p, params, false)])
  }
  return out
}

describe('primitive codegen snapshots', () => {
  for (const id of recognizedLoguePrimitiveIds()) {
    const p = findLoguePrimitive(id)!
    for (const platform of ['nts1mkii', 'minilogue-xd'] as const) {
      if (p.platforms && !p.platforms.includes(platform)) continue
      it(`${id} on ${platform}`, async () => {
        const text = variants(p, platform)
          .map(([label, d]) => `//// ${label}\n${render(platform, d, label.startsWith('exposed'))}`)
          .join('\n')
        const file = `./__snapshots__/primitives/${id.slice('logue/'.length).replace('/', '.')}.${platform}.txt`
        await expect(text).toMatchFileSnapshot(file)
      })
    }
  }

  it('wiring each inlet changes the generated source', () => {
    for (const id of recognizedLoguePrimitiveIds()) {
      const p = findLoguePrimitive(id)!
      const platform = p.platforms?.[0] ?? 'nts1mkii'
      const unwired = render(platform, doc(p, [], false))
      for (const inlet of p.inlets ?? []) {
        const one: PatchDocument = doc(p, [], true)
        one.nets = one.nets.filter(
          (n) => n.dests[0].obj !== NODE || n.dests[0].inlet === inlet.name
        )
        one.nodes = one.nodes.filter(
          (n) => !n.name?.startsWith('c_') || n.name === `c_${inlet.name}`
        )
        expect(render(platform, one), `${id} inlet ${inlet.name}`).not.toBe(unwired)
      }
    }
  })
})

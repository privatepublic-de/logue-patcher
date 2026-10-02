#!/usr/bin/env node
/**
 * ONE-OFF migration: converts an old `.axlogue` file (this app's pre-JSON, Axoloti-XML-derived
 * format) into the new `.loguepatch` JSON format. Deliberately
 * self-contained (plain JS, `fast-xml-parser` imported directly) rather than depending on the
 * now-deleted `shared/xml/patchCodec.ts`, which was built around a tag-collision/document-order
 * preservation problem that only matters for arbitrary legacy Axoloti `.axp` files -- a real
 * `.axlogue` document this app itself ever wrote never has that problem (every param this app
 * ever wrote used the same placeholder XML tag, `int32`, and its own codegen never reads param
 * order), so a plain, order-agnostic XML parse is safe here.
 *
 * Usage: node scripts/migrate-axlogue-to-loguepatch.mjs <file.axlogue> [<file2.axlogue> ...]
 * Writes a sibling <name>.loguepatch next to each input file; does not touch the original.
 */

import { XMLParser } from 'fast-xml-parser'
import { readFileSync, writeFileSync } from 'node:fs'

function asArray(v) {
  if (v === undefined) return []
  return Array.isArray(v) ? v : [v]
}

function attr(node, name) {
  const v = node?.['@_' + name]
  return v === undefined ? undefined : String(v)
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  cdataPropName: '#cdata',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false
})

function decodeParams(node) {
  const wrapper = node.params
  if (!wrapper) return []
  const params = []
  for (const [tag, value] of Object.entries(wrapper)) {
    if (tag.startsWith('@_') || tag.startsWith('#')) continue
    for (const p of asArray(value)) {
      const out = { name: attr(p, 'name') ?? '', value: attr(p, 'value') ?? '' }
      const idx = attr(p, 'logueParamIndex')
      if (idx !== undefined) out.logueParamIndex = Number(idx)
      const label = attr(p, 'label')
      if (label !== undefined) out.label = label
      params.push(out)
    }
  }
  return params
}

function decodeBase(node) {
  return {
    type: attr(node, 'type') ?? '',
    name: attr(node, 'name'),
    x: Number(attr(node, 'x') ?? '0'),
    y: Number(attr(node, 'y') ?? '0')
  }
}

function migrate(inputPath) {
  const xml = readFileSync(inputPath, 'utf-8')
  const parsed = parser.parse(xml)
  const rootKey = Object.keys(parsed).find((k) => !k.startsWith('?'))
  const root = parsed[rootKey]

  const nodes = [
    ...asArray(root.obj).map((n) => ({ kind: 'obj', ...decodeBase(n), params: decodeParams(n) })),
    ...asArray(root.comment).map((n) => ({
      kind: 'comment',
      ...decodeBase(n),
      text: attr(n, 'text') ?? ''
    })),
    ...asArray(root.hyperlink).map((n) => ({ kind: 'hyperlink', ...decodeBase(n) }))
  ]

  const nets = asArray(root.nets?.net).map((n) => ({
    sources: asArray(n.source).map((s) => {
      const out = { obj: attr(s, 'obj') ?? '' }
      const outlet = attr(s, 'outlet')
      if (outlet !== undefined) out.outlet = outlet
      return out
    }),
    dests: asArray(n.dest).map((d) => {
      const out = { obj: attr(d, 'obj') ?? '' }
      const inlet = attr(d, 'inlet')
      if (inlet !== undefined) out.inlet = inlet
      return out
    })
  }))

  const platform = root.settings?.LogueTargetPlatform
  const targetModule = root.settings?.LogueTargetModule
  const settings = {}
  if ((platform === 'nts1mkii' || platform === 'minilogue-xd') && targetModule === 'osc') {
    settings.logueTarget = { platform, module: targetModule }
  }

  const notes =
    root.notes?.['#cdata'] ?? (typeof root.notes === 'string' ? root.notes : undefined) ?? ''

  const outputPath = inputPath.replace(/\.axlogue$/, '') + '.loguepatch'
  writeFileSync(
    outputPath,
    JSON.stringify({ version: 1, nodes, nets, settings, notes }, null, 2) + '\n'
  )
  console.log(`${inputPath} -> ${outputPath}`)
}

const inputs = process.argv.slice(2)
if (inputs.length === 0) {
  console.error('Usage: node scripts/migrate-axlogue-to-loguepatch.mjs <file.axlogue> [...]')
  process.exit(1)
}
for (const input of inputs) migrate(input)

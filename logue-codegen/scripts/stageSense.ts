/**
 * One-off verification script, NOT part of the shipped package:
 * stages two real minilogue xd projects for a real Docker build --
 *  1. a keyboard-tracking filter (saw -> filter, cutoff wired from logue/sense/pitch), the
 *     flagship example this phase exists for.
 *  2. a logue/sense/param instance with a real authored label, exposed to a knob slot, proving
 *     the exported manifest.json's freely-typed name is real Korg-toolchain-parseable JSON, not
 *     just something this project's own JSON.parse happens to accept.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/minilogue-xd'

const targets = [
  {
    dirName: 'axomodern-poc-mxd-sense-tracking-filter',
    unitName: 'poc mxd tracking',
    doc: {
      nodes: [
        { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/sense/pitch', name: 'pitch1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/filter/lowpass-cheap', name: 'filt1', x: 0, y: 0, params: [{ name: 'CUTOFF', value: '0' }] },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      nets: [
        { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'filt1', inlet: 'in' }] },
        { sources: [{ obj: 'pitch1', outlet: 'out' }], dests: [{ obj: 'filt1', inlet: 'cutoff' }] },
        { sources: [{ obj: 'filt1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    } as PatchDocument
  },
  {
    dirName: 'axomodern-poc-mxd-sense-param-label',
    unitName: 'poc mxd sense param',
    doc: {
      nodes: [
        { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
        {
          kind: 'obj',
          type: 'logue/sense/param',
          name: 'blend1',
          x: 0,
          y: 0,
          params: [
            {
              name: 'VALUE',
              value: '50',
              logueParamIndex: { 'minilogue-xd': 0 },
              label: 'Wave Blend'
            }
          ]
        },
        { kind: 'obj', type: 'logue/gain/vca', name: 'vca1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      nets: [
        { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'in' }] },
        { sources: [{ obj: 'blend1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'gain' }] },
        { sources: [{ obj: 'vca1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    } as PatchDocument
  }
]

for (const target of targets) {
  const result = generateOldGenOscUnit(target.doc, { name: target.unitName })
  const projectDir = join(platformDir, target.dirName)
  mkdirSync(join(projectDir, 'ld'), { recursive: true })
  mkdirSync(join(projectDir, 'tpl'), { recursive: true })

  writeFileSync(join(projectDir, 'manifest.json'), result.manifestJson)
  writeFileSync(join(projectDir, 'project.mk'), result.projectMk)
  writeFileSync(join(projectDir, 'osc.cpp'), result.oscCpp)
  writeFileSync(join(projectDir, 'Makefile'), result.makefile)
  writeFileSync(join(projectDir, 'tpl', '_unit.c'), result.unitC)
  writeFileSync(join(projectDir, 'ld', 'rules.ld'), result.rulesLd)
  writeFileSync(join(projectDir, 'ld', 'userosc.ld'), result.useroscLd)
  writeFileSync(join(projectDir, 'ld', 'osc_api.syms'), result.oscApiSyms)

  console.log(`Staged ${target.dirName} into ${projectDir}`)
}

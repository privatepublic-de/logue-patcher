/**
 * One-off verification script, NOT part of the shipped package:
 * generates a real saw -> lowpass filter -> audio-out minilogue xd unit (a wired control inlet
 * driving the filter's cutoff from a second oscillator, and a static-cutoff variant) and stages
 * both into fresh logue-sdk project directories for a real Docker build.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/minilogue-xd'

const targets = [
  {
    dirName: 'axomodern-poc-mxd-filter-static',
    unitName: 'poc mxd filter static',
    doc: {
      nodes: [
        { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
        {
          kind: 'obj',
          type: 'logue/filter/lowpass-cheap',
          name: 'filt1',
          x: 0,
          y: 0,
          params: [{ name: 'CUTOFF', value: '15' }]
        },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      nets: [
        { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'filt1', inlet: 'in' }] },
        { sources: [{ obj: 'filt1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    } as PatchDocument
  },
  {
    dirName: 'axomodern-poc-mxd-filter-wired-cutoff',
    unitName: 'poc mxd filter wired',
    doc: {
      nodes: [
        { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/osc/sine', name: 'lfo1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/filter/lowpass-cheap', name: 'filt1', x: 0, y: 0, params: [{ name: 'CUTOFF', value: '0' }] },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      nets: [
        { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'filt1', inlet: 'in' }] },
        { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'filt1', inlet: 'cutoff' }] },
        { sources: [{ obj: 'filt1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
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

/**
 * One-off verification script for the feedback comb filter/delay, updated for the
 * CUTOFF/GAIN/DAMPING redesign. Stages two real minilogue xd projects for
 * a real Docker build:
 *  1. a Karplus-Strong-ish pluck: white noise through the comb filter at a real, high GAIN and a
 *     fixed CUTOFF -- exercises the circular buffer/feedback loop under sustained, long-running
 *     resonance (the RAM-budget-relevant path, not just a quick passthrough check).
 *  2. a saw with a sine-lfo wired into both cutoff and gain at once -- exercises both wireable
 *     inlets simultaneously (a flanger-ish sweeping resonance), with DAMPING left at its default.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/minilogue-xd'

const targets = [
  {
    dirName: 'axomodern-poc-mxd-comb-pluck',
    unitName: 'poc mxd comb pluck',
    doc: {
      nodes: [
        { kind: 'obj', type: 'logue/osc/noise', name: 'noise1', x: 0, y: 0, params: [] },
        {
          kind: 'obj',
          type: 'logue/filter/comb',
          name: 'comb1',
          x: 0,
          y: 0,
          params: [
            { name: 'CUTOFF', value: '60' },
            { name: 'GAIN', value: '95' }
          ]
        },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      nets: [
        { sources: [{ obj: 'noise1', outlet: 'out' }], dests: [{ obj: 'comb1', inlet: 'in' }] },
        { sources: [{ obj: 'comb1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    } as PatchDocument
  },
  {
    dirName: 'axomodern-poc-mxd-comb-wired',
    unitName: 'poc mxd comb wired',
    doc: {
      nodes: [
        { kind: 'obj', type: 'logue/osc/saw', name: 'osc1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/lfo/sine-lfo', name: 'lfo1', x: 0, y: 0, params: [] },
        {
          kind: 'obj',
          type: 'logue/filter/comb',
          name: 'comb1',
          x: 0,
          y: 0,
          params: [{ name: 'GAIN', value: '30' }]
        },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      nets: [
        { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'comb1', inlet: 'in' }] },
        { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'comb1', inlet: 'cutoff' }] },
        { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'comb1', inlet: 'gain' }] },
        { sources: [{ obj: 'comb1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
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

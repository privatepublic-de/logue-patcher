/**
 * One-off verification script for the wavefolder + soft-clip saturator and their wireable
 * `drive` inlets. Stages three real minilogue xd projects for a real Docker build:
 *  1. a saw run through the wavefolder at full DRIVE -- exercises the loop-based mirror fold
 *     under a genuinely large pre-gain (up to 8x), where a real signal folds multiple times.
 *  2. the same saw through the soft-clip saturator at full DRIVE -- exercises the rational
 *     tanh-ish curve, confirming it stays bounded and doesn't fold back.
 *  3. a saw through the wavefolder with a sine-lfo wired into `drive` -- the fold amount
 *     wobbles over time instead of sitting at a fixed dial value.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/minilogue-xd'

const targets = [
  {
    dirName: 'axomodern-poc-mxd-wavefolder',
    unitName: 'poc mxd fold',
    doc: {
      nodes: [
        { kind: 'obj', type: 'logue/osc/saw', name: 'osc1', x: 0, y: 0, params: [] },
        {
          kind: 'obj',
          type: 'logue/shape/wavefolder',
          name: 'fold1',
          x: 0,
          y: 0,
          params: [{ name: 'DRIVE', value: '100' }]
        },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      nets: [
        { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'fold1', inlet: 'in' }] },
        { sources: [{ obj: 'fold1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    } as PatchDocument
  },
  {
    dirName: 'axomodern-poc-mxd-softclip',
    unitName: 'poc mxd sat',
    doc: {
      nodes: [
        { kind: 'obj', type: 'logue/osc/saw', name: 'osc1', x: 0, y: 0, params: [] },
        {
          kind: 'obj',
          type: 'logue/shape/soft-clip',
          name: 'sat1',
          x: 0,
          y: 0,
          params: [{ name: 'DRIVE', value: '100' }]
        },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      nets: [
        { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'sat1', inlet: 'in' }] },
        { sources: [{ obj: 'sat1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    } as PatchDocument
  },
  {
    dirName: 'axomodern-poc-mxd-wavefolder-wired-drive',
    unitName: 'poc mxd fold wobble',
    doc: {
      nodes: [
        { kind: 'obj', type: 'logue/osc/saw', name: 'osc1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/lfo/sine-lfo', name: 'lfo1', x: 0, y: 0, params: [] },
        {
          kind: 'obj',
          type: 'logue/shape/wavefolder',
          name: 'fold1',
          x: 0,
          y: 0,
          params: [{ name: 'DRIVE', value: '30' }]
        },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      nets: [
        { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'fold1', inlet: 'in' }] },
        { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'fold1', inlet: 'drive' }] },
        { sources: [{ obj: 'fold1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
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

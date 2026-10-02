/**
 * One-off verification script for the "optimize existing primitives" work (coarse/fine tuning,
 * pitch/rate/width/gain inlets), NOT part of the shipped package. Stages
 * two real minilogue xd projects for a real Docker build:
 *  1. coarse+12 on a saw (should measurably double frequency) plus a sine-lfo's own rate
 *     modulated by SHAPE, feeding a pulse's width -- exercises pitch/width/rate all wired at once.
 *  2. mix2 with asymmetric GAIN1/GAIN2.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/minilogue-xd'

const targets = [
  {
    dirName: 'axomodern-poc-mxd-optimize-coarse',
    unitName: 'poc mxd coarse12',
    doc: {
      nodes: [
        {
          kind: 'obj',
          type: 'logue/osc/saw',
          name: 'saw1',
          x: 0,
          y: 0,
          params: [{ name: 'COARSE', value: '12' }]
        },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      nets: [{ sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
      settings: {},
      notes: ''
    } as PatchDocument
  },
  {
    dirName: 'axomodern-poc-mxd-optimize-pitch-width-rate',
    unitName: 'poc mxd pwr',
    doc: {
      nodes: [
        { kind: 'obj', type: 'logue/sense/pitch', name: 'pitch1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/sense/shape', name: 'shape1', x: 0, y: 0, params: [] },
        {
          kind: 'obj',
          type: 'logue/lfo/sine-lfo',
          name: 'lfo1',
          x: 0,
          y: 0,
          params: [{ name: 'RATE', value: '10' }]
        },
        { kind: 'obj', type: 'logue/osc/pulse', name: 'pulse1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      nets: [
        { sources: [{ obj: 'shape1', outlet: 'out' }], dests: [{ obj: 'lfo1', inlet: 'rate' }] },
        { sources: [{ obj: 'pitch1', outlet: 'out' }], dests: [{ obj: 'pulse1', inlet: 'pitch' }] },
        { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'pulse1', inlet: 'width' }] },
        { sources: [{ obj: 'pulse1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    } as PatchDocument
  },
  {
    dirName: 'axomodern-poc-mxd-optimize-mix-gains',
    unitName: 'poc mxd mixgain',
    doc: {
      nodes: [
        { kind: 'obj', type: 'logue/osc/sine', name: 'a', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/osc/saw', name: 'b', x: 0, y: 0, params: [] },
        {
          kind: 'obj',
          type: 'logue/mix/mix2',
          name: 'mixer',
          x: 0,
          y: 0,
          params: [
            { name: 'GAIN1', value: '100' },
            { name: 'GAIN2', value: '25' }
          ]
        },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      nets: [
        { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in1' }] },
        { sources: [{ obj: 'b', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in2' }] },
        { sources: [{ obj: 'mixer', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
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

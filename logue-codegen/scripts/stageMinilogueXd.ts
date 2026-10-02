/**
 * One-off phase-4 verification script, NOT part of the shipped package: generates real
 * minilogue xd oscillator source (manifest.json/osc.cpp + the embedded fixed scaffold) via
 * generateOldGenOscUnit and stages it into a fresh logue-sdk project directory, for a real
 * Docker build.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/minilogue-xd'

const targets = [
  {
    dirName: 'axomodern-poc-mxd-saw',
    unitName: 'poc mxd saw',
    doc: {
      nodes: [
        { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      nets: [{ sources: [{ obj: 'saw1' }], dests: [{ obj: 'out' }] }],
      settings: {},
      notes: ''
    } as PatchDocument
  },
  {
    dirName: 'axomodern-poc-mxd-pulse',
    unitName: 'poc mxd pulse',
    doc: {
      nodes: [
        {
          kind: 'obj',
          type: 'logue/osc/pulse',
          name: 'pulse1',
          x: 0,
          y: 0,
          params: [{ name: 'WIDTH', value: '512', logueParamIndex: { 'minilogue-xd': 0 } }]
        },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      nets: [{ sources: [{ obj: 'pulse1' }], dests: [{ obj: 'out' }] }],
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

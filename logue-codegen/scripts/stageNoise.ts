/**
 * One-off verification script for the LCG white noise source.
 * Stages one real minilogue xd project: two simultaneous noise instances (should decorrelate via
 * their own baked per-instance seed), run through the wavefolder just to exercise noise feeding
 * a real downstream primitive too, not just straight to audio-out.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/minilogue-xd'

const target = {
  dirName: 'axomodern-poc-mxd-noise',
  unitName: 'poc mxd noise',
  doc: {
    nodes: [
      { kind: 'obj', type: 'logue/osc/noise', name: 'noiseA', x: 0, y: 0, params: [] },
      { kind: 'obj', type: 'logue/osc/noise', name: 'noiseB', x: 0, y: 0, params: [] },
      { kind: 'obj', type: 'logue/mix/mix2', name: 'mixer', x: 0, y: 0, params: [] },
      { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
    ],
    nets: [
      { sources: [{ obj: 'noiseA', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in1' }] },
      { sources: [{ obj: 'noiseB', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in2' }] },
      { sources: [{ obj: 'mixer', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
    ],
    settings: {},
    notes: ''
  } as PatchDocument
}

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

/**
 * One-off verification script for the ring modulator + highpass filter, NOT part of the shipped
 * package. Stages one real minilogue xd project for a real
 * Docker build: two saws (a fixed carrier, a second one detuned via COARSE) ring-modulated
 * together, then through the new highpass -- exercises both new primitives wired in the same
 * graph, plus the highpass's wireable cutoff control inlet fed by a sine-lfo.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/minilogue-xd'

const target = {
  dirName: 'axomodern-poc-mxd-ringmod-highpass',
  unitName: 'poc mxd rm hp',
  doc: {
    nodes: [
      { kind: 'obj', type: 'logue/osc/saw', name: 'carrier', x: 0, y: 0, params: [] },
      {
        kind: 'obj',
        type: 'logue/osc/saw',
        name: 'modulator',
        x: 0,
        y: 0,
        params: [{ name: 'COARSE', value: '7' }]
      },
      { kind: 'obj', type: 'logue/math/multiply', name: 'rm', x: 0, y: 0, params: [] },
      { kind: 'obj', type: 'logue/lfo/sine-lfo', name: 'lfo1', x: 0, y: 0, params: [] },
      { kind: 'obj', type: 'logue/filter/highpass-cheap', name: 'hp1', x: 0, y: 0, params: [] },
      { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
    ],
    nets: [
      { sources: [{ obj: 'carrier', outlet: 'out' }], dests: [{ obj: 'rm', inlet: 'in1' }] },
      { sources: [{ obj: 'modulator', outlet: 'out' }], dests: [{ obj: 'rm', inlet: 'in2' }] },
      { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'hp1', inlet: 'cutoff' }] },
      { sources: [{ obj: 'rm', outlet: 'out' }], dests: [{ obj: 'hp1', inlet: 'in' }] },
      { sources: [{ obj: 'hp1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
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

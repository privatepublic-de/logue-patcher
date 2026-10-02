/**
 * One-off verification script for the constant/DC source. Stages
 * one real minilogue xd project: two constants set fixed pitch offsets on a ring-mod pair --
 * a carrier detuned by a fixed +7 semitones (VALUE=29, since 0.2917*24 ~= 7) and a modulator
 * detuned by a fixed -12 semitones (VALUE=-50, since -0.5*24 = -12 exactly), demonstrating the
 * headline use case: fixed pitches for ring-mod/FM oscillators without wiring in an LFO or a
 * sense primitive that would also do unwanted work of its own.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/minilogue-xd'

const target = {
  dirName: 'axomodern-poc-mxd-constant',
  unitName: 'poc mxd constant',
  doc: {
    nodes: [
      { kind: 'obj', type: 'logue/osc/saw', name: 'carrier', x: 0, y: 0, params: [] },
      { kind: 'obj', type: 'logue/osc/saw', name: 'modulator', x: 0, y: 0, params: [] },
      {
        kind: 'obj',
        type: 'logue/util/constant',
        name: 'carrierDetune',
        x: 0,
        y: 0,
        params: [{ name: 'VALUE', value: '29' }]
      },
      {
        kind: 'obj',
        type: 'logue/util/constant',
        name: 'modDetune',
        x: 0,
        y: 0,
        params: [{ name: 'VALUE', value: '-50' }]
      },
      { kind: 'obj', type: 'logue/math/multiply', name: 'rm', x: 0, y: 0, params: [] },
      { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
    ],
    nets: [
      {
        sources: [{ obj: 'carrierDetune', outlet: 'out' }],
        dests: [{ obj: 'carrier', inlet: 'pitch' }]
      },
      {
        sources: [{ obj: 'modDetune', outlet: 'out' }],
        dests: [{ obj: 'modulator', inlet: 'pitch' }]
      },
      { sources: [{ obj: 'carrier', outlet: 'out' }], dests: [{ obj: 'rm', inlet: 'in1' }] },
      { sources: [{ obj: 'modulator', outlet: 'out' }], dests: [{ obj: 'rm', inlet: 'in2' }] },
      { sources: [{ obj: 'rm', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
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

/**
 * One-off verification script for linear FM (implemented as phase modulation). Stages one real
 * minilogue xd project for a real Docker build: a classic
 * two-operator FM patch -- a sine carrier phase-modulated by a second sine (detuned via COARSE
 * for an inharmonic bell-like spectrum), FM_DEPTH baked at a real, non-default, non-trivial
 * value (60) to actually exercise the new pm_wrap/fmDepth machinery, not just its zero default.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/minilogue-xd'

const target = {
  dirName: 'axomodern-poc-mxd-linear-fm',
  unitName: 'poc mxd fm bell',
  doc: {
    nodes: [
      {
        kind: 'obj',
        type: 'logue/osc/sine',
        name: 'carrier',
        x: 0,
        y: 0,
        params: [{ name: 'FM_DEPTH', value: '60' }]
      },
      {
        kind: 'obj',
        type: 'logue/osc/sine',
        name: 'modulator',
        x: 0,
        y: 0,
        params: [{ name: 'COARSE', value: '19' }]
      },
      { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
    ],
    nets: [
      { sources: [{ obj: 'modulator', outlet: 'out' }], dests: [{ obj: 'carrier', inlet: 'fm' }] },
      { sources: [{ obj: 'carrier', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
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

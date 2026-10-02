/**
 * One-off verification script for the comb filter pitch-tracking mode. Stages one real minilogue
 * xd project: a real Karplus-Strong pluck -- white noise into
 * the comb filter with TRACK=100, so the string's delay length tracks the played note (via the
 * SAME note_w0 machinery every oscillator uses) instead of a fixed dial percentage. Deliberately
 * does NOT wire logue/sense/pitch into the comb's own `pitch` inlet -- an earlier draft of this
 * script did exactly that, which double-counts the base note (already unconditionally part of
 * the tracked formula) at the wrong scale; `pitch` is reserved for an OPTIONAL additive bend on
 * top of tracking (e.g. an LFO for vibrato), not for turning tracking on in the first place.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/minilogue-xd'

const target = {
  dirName: 'axomodern-poc-mxd-comb-pitch-tracking',
  unitName: 'poc mxd comb ks',
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
          { name: 'GAIN', value: '96' },
          { name: 'TRACK', value: '100' }
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

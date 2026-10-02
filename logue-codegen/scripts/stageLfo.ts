/**
 * One-off verification script, NOT part of the shipped package:
 * generates a real saw -> filter (cutoff modulated by an LFO) -> audio-out minilogue xd unit --
 * the LFO's own free-running rate is independent of the played note's pitch.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const doc: PatchDocument = {
  nodes: [
    { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
    {
      kind: 'obj',
      type: 'logue/lfo/sine-lfo',
      name: 'lfo1',
      x: 0,
      y: 0,
      params: [{ name: 'RATE', value: '30' }]
    },
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
}

const result = generateOldGenOscUnit(doc, { name: 'poc mxd lfo filter' })
const projectDir =
  '/Users/peter/Documents/GitHub/logue-sdk/platform/minilogue-xd/axomodern-poc-mxd-lfo'

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

console.log(`Staged axomodern-poc-mxd-lfo into ${projectDir}`)
console.log(result.oscCpp)

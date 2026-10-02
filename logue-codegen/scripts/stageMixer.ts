/**
 * One-off verification script, NOT part of the shipped package:
 * generates a real two-oscillator -> mixer -> audio-out minilogue xd unit (the first real
 * multi-node wired graph this project's codegen has ever produced) and stages it into a fresh
 * logue-sdk project directory for a real Docker build.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const doc: PatchDocument = {
  nodes: [
    { kind: 'obj', type: 'logue/osc/sine', name: 'a', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/osc/saw', name: 'b', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/mix/mix2', name: 'mixer', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [
    { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in1' }] },
    { sources: [{ obj: 'b', outlet: 'out' }], dests: [{ obj: 'mixer', inlet: 'in2' }] },
    { sources: [{ obj: 'mixer', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ],
  settings: {},
  notes: ''
}

const result = generateOldGenOscUnit(doc, { name: 'poc mxd mixer' })
const projectDir =
  '/Users/peter/Documents/GitHub/logue-sdk/platform/minilogue-xd/axomodern-poc-mxd-mixer'

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

console.log(`Staged axomodern-poc-mxd-mixer into ${projectDir}`)

/**
 * Verification for the VCA GAIN rescale (0-100% now maps to 0-4x/`*0.04f`, was 0-1x/`*0.01f`,
 * default moved 100->25 to keep unity-by-default) -- the real fix for a user-reported
 * "logue/filter/formant's output is very quiet, especially at high RESONANCE" complaint. Stages
 * a real minilogue xd project chaining a high-RESONANCE formant filter into a VCA with GAIN
 * pushed well past the old 100%-is-unity ceiling, confirming the new scale compiles clean and
 * the manifest (still declaring GAIN's own range as a plain 0-100, unchanged) still passes the
 * real minilogue xd Librarian's own +-100 range constraint.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/minilogue-xd'

const doc: PatchDocument = {
  nodes: [
    { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
    {
      kind: 'obj',
      type: 'logue/filter/formant',
      name: 'formant1',
      x: 0,
      y: 0,
      params: [{ name: 'RESONANCE', value: '90' }]
    },
    {
      kind: 'obj',
      type: 'logue/gain/vca',
      name: 'vca1',
      x: 0,
      y: 0,
      params: [{ name: 'GAIN', value: '90' }]
    },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [
    { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'formant1', inlet: 'in' }] },
    { sources: [{ obj: 'formant1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'in' }] },
    { sources: [{ obj: 'vca1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ],
  settings: {},
  notes: ''
}

const result = generateOldGenOscUnit(doc, { name: 'poc mxd vca boost' })
const projectDir = join(platformDir, 'axomodern-poc-mxd-vca-boost')
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
console.log(`Staged ${projectDir}`)
console.log('manifest.json GAIN row:', result.manifestJson.match(/"GAIN"[^}]*}/)?.[0])

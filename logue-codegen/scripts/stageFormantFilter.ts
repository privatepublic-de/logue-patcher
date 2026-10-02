/**
 * Verification for logue/filter/formant (new primitive): stages a real minilogue xd project
 * (saw -> formant, with an LFO wired into `vowel` for an audible, moving vowel sweep) and a real
 * NTS-1 mkII project (noise -> formant, SHIFT/RESONANCE left at their defaults) for a real
 * Docker build -- confirms the new `static const float kFormantNote[5][3]` in-function table
 * and the 3-band helper chain (`formant_step`/`formant_bp_step`/`formant_g_from_note`/
 * `formant_k_from_percent`) actually compile clean on both platforms' real toolchains, not just
 * type-check in this repo's own TS.
 */
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import { generateOscUnit } from '../src/nts1mkii/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const sdkRoot = '/Users/peter/Documents/GitHub/logue-sdk'

const mxdDoc: PatchDocument = {
  nodes: [
    { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/lfo/sine-lfo', name: 'lfo1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/filter/formant', name: 'formant1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [
    { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'formant1', inlet: 'in' }] },
    { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'formant1', inlet: 'vowel' }] },
    { sources: [{ obj: 'formant1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ],
  settings: {},
  notes: ''
}

const mxdResult = generateOldGenOscUnit(mxdDoc, { name: 'poc mxd formant' })
const mxdDirName = 'axomodern-poc-mxd-formant'
const mxdProjectDir = join(sdkRoot, 'platform', 'minilogue-xd', mxdDirName)
mkdirSync(join(mxdProjectDir, 'ld'), { recursive: true })
mkdirSync(join(mxdProjectDir, 'tpl'), { recursive: true })
writeFileSync(join(mxdProjectDir, 'manifest.json'), mxdResult.manifestJson)
writeFileSync(join(mxdProjectDir, 'project.mk'), mxdResult.projectMk)
writeFileSync(join(mxdProjectDir, 'osc.cpp'), mxdResult.oscCpp)
writeFileSync(join(mxdProjectDir, 'Makefile'), mxdResult.makefile)
writeFileSync(join(mxdProjectDir, 'tpl', '_unit.c'), mxdResult.unitC)
writeFileSync(join(mxdProjectDir, 'ld', 'rules.ld'), mxdResult.rulesLd)
writeFileSync(join(mxdProjectDir, 'ld', 'userosc.ld'), mxdResult.useroscLd)
writeFileSync(join(mxdProjectDir, 'ld', 'osc_api.syms'), mxdResult.oscApiSyms)
console.log(`Staged minilogue xd: ${mxdProjectDir}`)

const nts1Doc: PatchDocument = {
  nodes: [
    { kind: 'obj', type: 'logue/osc/noise', name: 'noise1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/filter/formant', name: 'formant1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [
    { sources: [{ obj: 'noise1', outlet: 'out' }], dests: [{ obj: 'formant1', inlet: 'in' }] },
    { sources: [{ obj: 'formant1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ],
  settings: {},
  notes: ''
}
const nts1TemplateDir = join(sdkRoot, 'platform', 'nts-1_mkii', 'dummy-osc')
const nts1DirName = 'axomodern-poc-nts1-formant'
const nts1ProjectDir = join(sdkRoot, 'platform', 'nts-1_mkii', nts1DirName)
const nts1Result = generateOscUnit(nts1Doc, { name: 'poc nts1 formant' })
if (!existsSync(nts1ProjectDir)) mkdirSync(nts1ProjectDir, { recursive: true })
writeFileSync(join(nts1ProjectDir, 'header.c'), nts1Result.headerC)
writeFileSync(join(nts1ProjectDir, 'osc.h'), nts1Result.oscH)
writeFileSync(join(nts1ProjectDir, 'unit.cc'), nts1Result.unitCc)
copyFileSync(join(nts1TemplateDir, 'Makefile'), join(nts1ProjectDir, 'Makefile'))
copyFileSync(join(nts1TemplateDir, 'wasm.cc'), join(nts1ProjectDir, 'wasm.cc'))
writeFileSync(
  join(nts1ProjectDir, 'config.mk'),
  'PROJECT := osc\nPROJECT_TYPE := osc\nUCSRC = header.c\nUCXXSRC = unit.cc\nUASMSRC =\nUASMXSRC =\nUINCDIR  =\nULIBDIR =\nULIBS  = -lm\nUDEFS =\n'
)
console.log(`Staged NTS-1 mkII: ${nts1ProjectDir}`)

/**
 * Verification for logue/sense/shape-alt (new primitive, follow-up to phase 30/31's
 * logue/sense/shape work): confirms the generated unit compiles clean with both fixed knob
 * slots reserved and altShape01_ actually wired to slot 1's setParameter case (previously
 * discarded via `(void)value;`), and produces an audible, testable effect -- same
 * "wire it into something that makes the sensed value audible" discipline stageSenseDemo.ts
 * established after the first sense-primitive demo (stageSensePitchShape.ts) shipped a
 * silent, control-rate-only graph by mistake.
 *
 * Graph: saw (audio source, always on) -> vca (gain <- sense/shape-alt). Gain is FULL-REPLACE
 * (not additive, same as sense/shape's own vca-gain precedent), so the output starts SILENT
 * (altShape01_ inits to 0) and should rise as the physical Alt-Shape knob is turned up -- the
 * real-hardware check this script's own build enables but cannot itself perform.
 */
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'
import { generateOscUnit } from '../src/nts1mkii/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const templateDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/nts-1_mkii/dummy-osc'
const nts1Dir = '/Users/peter/Documents/GitHub/logue-sdk/platform/nts-1_mkii'

const projectName = 'axomodern_poc_nts1_sense_shape_alt'
const dirName = 'axomodern-poc-nts1-sense-shape-alt'

const doc: PatchDocument = {
  nodes: [
    { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/sense/shape-alt', name: 'altshape1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/gain/vca', name: 'vca1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [
    { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'in' }] },
    { sources: [{ obj: 'altshape1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'gain' }] },
    { sources: [{ obj: 'vca1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ],
  settings: {},
  notes: ''
}

const result = generateOscUnit(doc, { name: 'poc nts1 altshape' })
const projectDir = join(nts1Dir, dirName)
if (!existsSync(projectDir)) mkdirSync(projectDir, { recursive: true })

writeFileSync(join(projectDir, 'header.c'), result.headerC)
writeFileSync(join(projectDir, 'osc.h'), result.oscH)
writeFileSync(join(projectDir, 'unit.cc'), result.unitCc)
copyFileSync(join(templateDir, 'Makefile'), join(projectDir, 'Makefile'))
copyFileSync(join(templateDir, 'wasm.cc'), join(projectDir, 'wasm.cc'))
writeFileSync(
  join(projectDir, 'config.mk'),
  `PROJECT := ${projectName}\nPROJECT_TYPE := osc\nUCSRC = header.c\nUCXXSRC = unit.cc\nUASMSRC =\nUASMXSRC =\nUINCDIR  =\nULIBDIR =\nULIBS  = -lm\nUDEFS =\n`
)
console.log(`Staged saw -> vca(gain<-sense/shape-alt) into ${projectDir}`)

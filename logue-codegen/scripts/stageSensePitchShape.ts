/**
 * One-off verification script, NOT part of the shipped package: stages a real NTS-1 mkII project
 * exercising both logue/sense/pitch and logue/sense/shape (the two primitives widened from
 * minilogue-xd-only to both platforms) for a real Docker
 * build -- proving the generated osc.h/unit.cc/header.c actually compiles against the real SDK
 * headers, not just that this project's own TS believes it's well-formed.
 */
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'
import { generateOscUnit } from '../src/nts1mkii/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const templateDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/nts-1_mkii/dummy-osc'
const nts1Dir = '/Users/peter/Documents/GitHub/logue-sdk/platform/nts-1_mkii'

const projectName = 'axomodern_poc_nts1_sense'
const dirName = 'axomodern-poc-nts1-sense'

const doc: PatchDocument = {
  nodes: [
    { kind: 'obj', type: 'logue/sense/pitch', name: 'pitch1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/sense/shape', name: 'shape1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/mix/mix2', name: 'mix1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [
    { sources: [{ obj: 'pitch1', outlet: 'out' }], dests: [{ obj: 'mix1', inlet: 'in1' }] },
    { sources: [{ obj: 'shape1', outlet: 'out' }], dests: [{ obj: 'mix1', inlet: 'in2' }] },
    { sources: [{ obj: 'mix1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ],
  settings: {},
  notes: ''
}

const result = generateOscUnit(doc, { name: 'poc nts1 sense' })
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
console.log(`Staged logue/sense/pitch + logue/sense/shape into ${projectDir}`)

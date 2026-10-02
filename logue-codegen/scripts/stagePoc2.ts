/**
 * One-off phase-2 verification script, NOT part of the shipped package: generates real
 * output for a one-node "logue/osc/sine" graph via `generateOscUnit` and stages it into a
 * fresh logue-sdk project directory, so the GENERATED code (not phase 1's hand-written
 * reference) can be built via the real Docker toolchain and verified in websim.
 */
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'
import { generateOscUnit } from '../src/nts1mkii/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const doc: PatchDocument = {
  nodes: [
    { kind: 'obj', type: 'logue/osc/sine', name: 'sine1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [{ sources: [{ obj: 'sine1' }], dests: [{ obj: 'out' }] }],
  settings: {},
  notes: ''
}

const result = generateOscUnit(doc, { name: 'axo poc2' })

const projectDir = join(
  '/Users/peter/Documents/GitHub/logue-sdk/platform/nts-1_mkii/axomodern-poc2'
)
const templateDir = join('/Users/peter/Documents/GitHub/logue-sdk/platform/nts-1_mkii/dummy-osc')

if (!existsSync(projectDir)) mkdirSync(projectDir, { recursive: true })

writeFileSync(join(projectDir, 'header.c'), result.headerC)
writeFileSync(join(projectDir, 'osc.h'), result.oscH)
writeFileSync(join(projectDir, 'unit.cc'), result.unitCc)
copyFileSync(join(templateDir, 'Makefile'), join(projectDir, 'Makefile'))
copyFileSync(join(templateDir, 'wasm.cc'), join(projectDir, 'wasm.cc'))

writeFileSync(
  join(projectDir, 'config.mk'),
  `PROJECT := axomodern_poc2\nPROJECT_TYPE := osc\nUCSRC = header.c\nUCXXSRC = unit.cc\nUASMSRC =\nUASMXSRC =\nUINCDIR  =\nULIBDIR =\nULIBS  = -lm\nUDEFS =\n`
)

console.log(`Staged generated logue unit sources into ${projectDir}`)

/**
 * One-off phase-2 verification script, NOT part of the shipped package: stages the
 * pulse-with-exposed-WIDTH-param graph for a real Docker build + websim check.
 */
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'
import { generateOscUnit } from '../src/nts1mkii/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const doc: PatchDocument = {
  nodes: [
    {
      kind: 'obj',
      type: 'logue/osc/pulse',
      name: 'pulse1',
      x: 0,
      y: 0,
      params: [{ name: 'WIDTH', value: '512', logueParamIndex: { nts1mkii: 0 } }]
    },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [{ sources: [{ obj: 'pulse1' }], dests: [{ obj: 'out' }] }],
  settings: {},
  notes: ''
}

const result = generateOscUnit(doc, { name: 'poc pulse' })

const projectDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/nts-1_mkii/axomodern-poc-pulse'
const templateDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/nts-1_mkii/dummy-osc'

if (!existsSync(projectDir)) mkdirSync(projectDir, { recursive: true })

writeFileSync(join(projectDir, 'header.c'), result.headerC)
writeFileSync(join(projectDir, 'osc.h'), result.oscH)
writeFileSync(join(projectDir, 'unit.cc'), result.unitCc)
copyFileSync(join(templateDir, 'Makefile'), join(projectDir, 'Makefile'))
copyFileSync(join(templateDir, 'wasm.cc'), join(projectDir, 'wasm.cc'))
writeFileSync(
  join(projectDir, 'config.mk'),
  `PROJECT := axomodern_poc_pulse\nPROJECT_TYPE := osc\nUCSRC = header.c\nUCXXSRC = unit.cc\nUASMSRC =\nUASMXSRC =\nUINCDIR  =\nULIBDIR =\nULIBS  = -lm\nUDEFS =\n`
)

console.log(`Staged pulse-with-WIDTH-param into ${projectDir}`)

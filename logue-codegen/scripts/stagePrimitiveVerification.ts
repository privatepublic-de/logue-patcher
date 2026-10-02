/**
 * One-off phase-2 verification script, NOT part of the shipped package: generates real output
 * for a one-node graph of EACH new primitive (saw/square/triangle -- sine already verified by
 * stagePoc2.ts) and stages each into its own fresh logue-sdk project directory, so every
 * primitive added to the library gets the same real Docker-build + websim numeric check the
 * first slice held itself to.
 */
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'
import { generateOscUnit } from '../src/nts1mkii/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const templateDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/nts-1_mkii/dummy-osc'
const nts1Dir = '/Users/peter/Documents/GitHub/logue-sdk/platform/nts-1_mkii'

// unit_header.name is a real, fixed-size 19-char on-device buffer (UNIT_NAME_LEN,
// platform/nts-1_mkii/common/runtime.h) -- found via a real Docker build, now enforced by
// generateOscUnit's own validation. Keep
// this script's own C-identifier-shaped PROJECT names separate from the shorter on-device name.
const targets = [
  {
    type: 'logue/osc/saw',
    projectName: 'axomodern_poc_saw',
    dirName: 'axomodern-poc-saw',
    unitName: 'poc saw'
  },
  {
    type: 'logue/osc/square',
    projectName: 'axomodern_poc_square',
    dirName: 'axomodern-poc-square',
    unitName: 'poc square'
  },
  {
    type: 'logue/osc/triangle',
    projectName: 'axomodern_poc_triangle',
    dirName: 'axomodern-poc-triangle',
    unitName: 'poc triangle'
  }
]

for (const target of targets) {
  const doc: PatchDocument = {
    nodes: [
      { kind: 'obj', type: target.type, name: 'n1', x: 0, y: 0, params: [] },
      { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
    ],
    nets: [{ sources: [{ obj: 'n1' }], dests: [{ obj: 'out' }] }],
    settings: {},
    notes: ''
  }
  const result = generateOscUnit(doc, { name: target.unitName })
  const projectDir = join(nts1Dir, target.dirName)
  if (!existsSync(projectDir)) mkdirSync(projectDir, { recursive: true })

  writeFileSync(join(projectDir, 'header.c'), result.headerC)
  writeFileSync(join(projectDir, 'osc.h'), result.oscH)
  writeFileSync(join(projectDir, 'unit.cc'), result.unitCc)
  copyFileSync(join(templateDir, 'Makefile'), join(projectDir, 'Makefile'))
  copyFileSync(join(templateDir, 'wasm.cc'), join(projectDir, 'wasm.cc'))
  writeFileSync(
    join(projectDir, 'config.mk'),
    `PROJECT := ${target.projectName}\nPROJECT_TYPE := osc\nUCSRC = header.c\nUCXXSRC = unit.cc\nUASMSRC =\nUASMXSRC =\nUINCDIR  =\nULIBDIR =\nULIBS  = -lm\nUDEFS =\n`
  )
  console.log(`Staged ${target.type} into ${projectDir}`)
}

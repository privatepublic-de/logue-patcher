/**
 * One-off verification script for the `logue/lfo/*` `trig` phase-reset inlet (2026-09-27):
 * `sense/gate` resets a sine LFO and a sample-hold. Stages real projects for both platforms.
 *
 * Local build:
 *   cd <staged-dir> && GCC_BIN_PATH=/opt/homebrew/bin make -j8 && GCC_BIN_PATH=/opt/homebrew/bin make install
 */
import { writeFileSync, mkdirSync, copyFileSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import { generateOscUnit } from '../src/nts1mkii/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformRoot = '/Users/peter/Documents/GitHub/logue-sdk/platform'

// sense/gate resets a sine LFO (AM on a sine osc via multiply) and a S&H (on the osc's pitch).
const doc: PatchDocument = {
  nodes: [
    { kind: 'obj', type: 'logue/sense/gate', name: 'gate1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/lfo/sine-lfo', name: 'lfo1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/lfo/random-steps', name: 'sh1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/osc/sine', name: 'sine1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/math/multiply', name: 'rm1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [
    {
      sources: [{ obj: 'gate1', outlet: 'out' }],
      dests: [
        { obj: 'lfo1', inlet: 'trig' },
        { obj: 'sh1', inlet: 'trig' }
      ]
    },
    { sources: [{ obj: 'sh1', outlet: 'out' }], dests: [{ obj: 'sine1', inlet: 'pitch' }] },
    { sources: [{ obj: 'sine1', outlet: 'out' }], dests: [{ obj: 'rm1', inlet: 'in1' }] },
    { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'rm1', inlet: 'in2' }] },
    { sources: [{ obj: 'rm1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ],
  settings: {},
  notes: ''
}

// minilogue xd
{
  const result = generateOldGenOscUnit(doc, { name: 'poc mxd lfo trig' })
  const projectDir = join(platformRoot, 'minilogue-xd', 'axomodern-poc-mxd-lfo-trig')
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
  console.log(`Staged minilogue xd into ${projectDir}`)
}

// NTS-1 mkII
{
  const result = generateOscUnit(doc, { name: 'poc lfo trig' })
  const templateDir = join(platformRoot, 'nts-1_mkii', 'dummy-osc')
  const projectDir = join(platformRoot, 'nts-1_mkii', 'axomodern-poc-nts1-lfo-trig')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'header.c'), result.headerC, 'utf-8')
  writeFileSync(join(projectDir, 'osc.h'), result.oscH, 'utf-8')
  writeFileSync(join(projectDir, 'unit.cc'), result.unitCc, 'utf-8')
  copyFileSync(join(templateDir, 'Makefile'), join(projectDir, 'Makefile'))
  copyFileSync(join(templateDir, 'wasm.cc'), join(projectDir, 'wasm.cc'))
  writeFileSync(
    join(projectDir, 'config.mk'),
    'PROJECT := osc\nPROJECT_TYPE := osc\nUCSRC = header.c\nUCXXSRC = unit.cc\nUASMSRC =\nUASMXSRC =\nUINCDIR  =\nULIBDIR =\nULIBS  = -lm\nUDEFS =\n',
    'utf-8'
  )
  console.log(`Staged NTS-1 mkII into ${projectDir}`)
}

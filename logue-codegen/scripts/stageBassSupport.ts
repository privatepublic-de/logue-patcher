/**
 * One-off verification script for `logue/osc/bass-support` (2026-09-29): the bass oscillator with its
 * drive swept by a sine LFO and RANGE/MODE/SHAPE/GLIDE exposed. Stages real projects for both platforms.
 *
 * Local build:
 *   cd <staged-dir> && GCC_BIN_PATH=/opt/homebrew/bin make -j8 && GCC_BIN_PATH=/opt/homebrew/bin make install
 */
import { writeFileSync, mkdirSync, copyFileSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import { generateOscUnit } from '../src/nts1mkii/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'
import type { ParamValue } from '../../src/shared/domain/paramValueTypes'

const platformRoot = '/Users/peter/Documents/GitHub/logue-sdk/platform'

const p = (name: string, value: string, slot?: number): ParamValue => ({
  name,
  value,
  ...(slot === undefined ? {} : { logueParamIndex: { 'minilogue-xd': slot, nts1mkii: slot + 2 } })
})
export const doc: PatchDocument = {
  nodes: [
    { kind: 'obj', type: 'logue/lfo/sine-lfo', name: 'lfo1', x: 0, y: 0, params: [] },
    {
      kind: 'obj',
      type: 'logue/osc/bass-support',
      name: 'bass1',
      x: 0,
      y: 0,
      params: [p('COARSE', '0', 0), p('SHAPE', '67', 1), p('GLIDE', '30', 2)]
    },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [
    { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'bass1', inlet: 'drive' }] },
    { sources: [{ obj: 'bass1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ],
  settings: {},
  notes: ''
}

// minilogue xd
{
  const result = generateOldGenOscUnit(doc, { name: 'poc mxd bass' })
  const projectDir = join(platformRoot, 'minilogue-xd', 'axomodern-poc-mxd-bass')
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
  const result = generateOscUnit(doc, { name: 'poc bass' })
  const templateDir = join(platformRoot, 'nts-1_mkii', 'dummy-osc')
  const projectDir = join(platformRoot, 'nts-1_mkii', 'axomodern-poc-nts1-bass')
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

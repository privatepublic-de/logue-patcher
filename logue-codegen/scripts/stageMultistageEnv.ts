/**
 * One-off verification script for `logue/env/multistage` (2026-09-28): the envelope (loop mode)
 * bends a saw's pitch, and its eoc pulse clocks a sample-hold of noise into a VCA. TIME and DEPTH
 * are exposed. Stages real projects for both platforms.
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

const env = (name: string, value: string, slot?: number): ParamValue => ({
  name,
  value,
  ...(slot === undefined ? {} : { logueParamIndex: { 'minilogue-xd': slot, nts1mkii: slot + 2 } })
})
export const doc: PatchDocument = {
  nodes: [
    {
      kind: 'obj',
      type: 'logue/env/multistage',
      name: 'mseg1',
      x: 0,
      y: 0,
      params: [env('MODE', '2'), env('L2', '-60'), env('TIME', '50', 0), env('DEPTH', '50', 1)]
    },
    { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/osc/noise', name: 'noise1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/util/sample-hold', name: 'sh1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/gain/vca', name: 'vca1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [
    { sources: [{ obj: 'mseg1', outlet: 'env' }], dests: [{ obj: 'saw1', inlet: 'pitch' }] },
    { sources: [{ obj: 'mseg1', outlet: 'eoc' }], dests: [{ obj: 'sh1', inlet: 'trig' }] },
    { sources: [{ obj: 'noise1', outlet: 'out' }], dests: [{ obj: 'sh1', inlet: 'in' }] },
    { sources: [{ obj: 'sh1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'gain' }] },
    { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'in' }] },
    { sources: [{ obj: 'vca1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ],
  settings: {},
  notes: ''
}

// minilogue xd
{
  const result = generateOldGenOscUnit(doc, { name: 'poc mxd mseg' })
  const projectDir = join(platformRoot, 'minilogue-xd', 'axomodern-poc-mxd-mseg')
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
  const result = generateOscUnit(doc, { name: 'poc mseg' })
  const templateDir = join(platformRoot, 'nts-1_mkii', 'dummy-osc')
  const projectDir = join(platformRoot, 'nts-1_mkii', 'axomodern-poc-nts1-mseg')
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

/**
 * One-off verification script for `logue/util/quantize` (2026-09-29): random steps quantized to a
 * scale drive a saw's pitch, and the change trigger plays each note through an AD envelope on a
 * VCA. SCALE/ROOT exposed. Stages real projects for both platforms.
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
    { kind: 'obj', type: 'logue/lfo/random-steps', name: 'rnd1', x: 0, y: 0, params: [] },
    {
      kind: 'obj',
      type: 'logue/util/quantize',
      name: 'q1',
      x: 0,
      y: 0,
      params: [p('SCALE', '7', 0), p('ROOT', '2', 1)]
    },
    { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/env/ad', name: 'env1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/gain/vca', name: 'vca1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [
    { sources: [{ obj: 'rnd1', outlet: 'out' }], dests: [{ obj: 'q1', inlet: 'in' }] },
    { sources: [{ obj: 'q1', outlet: 'pitch' }], dests: [{ obj: 'saw1', inlet: 'pitch' }] },
    { sources: [{ obj: 'q1', outlet: 'trig' }], dests: [{ obj: 'env1', inlet: 'trig' }] },
    { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'in' }] },
    { sources: [{ obj: 'env1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'gain' }] },
    { sources: [{ obj: 'vca1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ],
  settings: {},
  notes: ''
}

// minilogue xd
{
  const result = generateOldGenOscUnit(doc, { name: 'poc mxd quant' })
  const projectDir = join(platformRoot, 'minilogue-xd', 'axomodern-poc-mxd-quant')
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
  const result = generateOscUnit(doc, { name: 'poc quant' })
  const templateDir = join(platformRoot, 'nts-1_mkii', 'dummy-osc')
  const projectDir = join(platformRoot, 'nts-1_mkii', 'axomodern-poc-nts1-quant')
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

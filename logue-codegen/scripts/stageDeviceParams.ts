/**
 * One-off verification script for device-side param ranges (2026-09-27): exposed mux4 INDEX,
 * mux2 SELECT and comb TRACK -- xd typeless/"%" two-step rows, NTS-1 mkII strings/onoff rows
 * with a generated unit_get_param_str_value. Stages real projects for both platforms.
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

const exposed = (name: string, value: string, xd: number, nts: number): ParamValue => ({
  name,
  value,
  logueParamIndex: { 'minilogue-xd': xd, nts1mkii: nts }
})

// Exposed selects and a toggle: mux4 INDEX, mux2 SELECT, comb TRACK.
const doc: PatchDocument = {
  nodes: [
    { kind: 'obj', type: 'logue/osc/sine', name: 'sine1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
    {
      kind: 'obj',
      type: 'logue/mux/mux4',
      name: 'mx4',
      x: 0,
      y: 0,
      params: [exposed('INDEX', '0', 0, 2)]
    },
    {
      kind: 'obj',
      type: 'logue/mux/mux2',
      name: 'mx2',
      x: 0,
      y: 0,
      params: [exposed('SELECT', '0', 1, 3)]
    },
    {
      kind: 'obj',
      type: 'logue/filter/comb',
      name: 'comb1',
      x: 0,
      y: 0,
      params: [exposed('TRACK', '0', 2, 4)]
    },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [
    { sources: [{ obj: 'sine1', outlet: 'out' }], dests: [{ obj: 'mx4', inlet: 'i1' }] },
    {
      sources: [{ obj: 'saw1', outlet: 'out' }],
      dests: [
        { obj: 'mx4', inlet: 'i2' },
        { obj: 'mx2', inlet: 'i2' }
      ]
    },
    { sources: [{ obj: 'mx4', outlet: 'out' }], dests: [{ obj: 'mx2', inlet: 'i1' }] },
    { sources: [{ obj: 'mx2', outlet: 'out' }], dests: [{ obj: 'comb1', inlet: 'in' }] },
    { sources: [{ obj: 'comb1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ],
  settings: {},
  notes: ''
}

// minilogue xd
{
  const result = generateOldGenOscUnit(doc, { name: 'poc mxd devparams' })
  const projectDir = join(platformRoot, 'minilogue-xd', 'axomodern-poc-mxd-devparams')
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
  const result = generateOscUnit(doc, { name: 'poc devparams' })
  const templateDir = join(platformRoot, 'nts-1_mkii', 'dummy-osc')
  const projectDir = join(platformRoot, 'nts-1_mkii', 'axomodern-poc-nts1-devparams')
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

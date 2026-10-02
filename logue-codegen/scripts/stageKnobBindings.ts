/**
 * One-off verification script for fixed-knob bindings and menu-slot followers (2026-09-29):
 * a stepped COARSE on Shape, a select (multistage MODE) and a checkbox (svf TRACK) on the second
 * knob or the xd's filter Cutoff knob, an svf CUTOFF following a constant's menu slot, and a
 * `sense/control` that is a menu param on NTS-1 mkII and the Resonance knob on the xd.
 * Stages real projects for both platforms.
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

const doc: PatchDocument = {
  nodes: [
    {
      kind: 'obj',
      type: 'logue/osc/saw',
      name: 'saw1',
      x: 0,
      y: 0,
      params: [
        { name: 'COARSE', value: '0', logueKnob: { 'minilogue-xd': 'shape', nts1mkii: 'shape' } }
      ]
    },
    {
      kind: 'obj',
      type: 'logue/filter/svf',
      name: 'f',
      x: 0,
      y: 0,
      params: [
        { name: 'CUTOFF', value: '60', logueFollow: { 'minilogue-xd': 0, nts1mkii: 2 } },
        { name: 'TRACK', value: '0', logueKnob: { 'minilogue-xd': 'cutoff', nts1mkii: 'shape-2' } }
      ]
    },
    {
      kind: 'obj',
      type: 'logue/env/multistage',
      name: 'm',
      x: 0,
      y: 0,
      params: [
        { name: 'MODE', value: '1', logueKnob: { 'minilogue-xd': 'shape-2', nts1mkii: 'shape-2' } }
      ]
    },
    {
      kind: 'obj',
      type: 'logue/util/constant',
      name: 'c',
      x: 0,
      y: 0,
      params: [{ name: 'VALUE', value: '0', logueParamIndex: { 'minilogue-xd': 0, nts1mkii: 2 } }]
    },
    {
      kind: 'obj',
      type: 'logue/sense/control',
      name: 'ctl',
      x: 0,
      y: 0,
      params: [
        {
          name: 'VALUE',
          value: '40',
          label: 'Depth',
          logueParamIndex: { nts1mkii: 3 },
          logueKnob: { 'minilogue-xd': 'resonance' }
        }
      ]
    },
    { kind: 'obj', type: 'logue/gain/vca', name: 'a', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [
    { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'f', inlet: 'in' }] },
    { sources: [{ obj: 'c', outlet: 'out' }], dests: [{ obj: 'f', inlet: 'resonance' }] },
    { sources: [{ obj: 'f', outlet: 'lp' }], dests: [{ obj: 'a', inlet: 'in' }] },
    { sources: [{ obj: 'm', outlet: 'env' }], dests: [{ obj: 'a', inlet: 'gain' }] },
    { sources: [{ obj: 'ctl', outlet: 'bipolar' }], dests: [{ obj: 'm', inlet: 'depth' }] },
    { sources: [{ obj: 'a', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ],
  settings: {},
  notes: ''
}

// minilogue xd
{
  const result = generateOldGenOscUnit(doc, { name: 'poc mxd knobs' })
  const projectDir = join(platformRoot, 'minilogue-xd', 'axomodern-poc-mxd-knobs')
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
  const result = generateOscUnit(doc, { name: 'poc knobs' })
  const templateDir = join(platformRoot, 'nts-1_mkii', 'dummy-osc')
  const projectDir = join(platformRoot, 'nts-1_mkii', 'axomodern-poc-nts1-knobs')
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

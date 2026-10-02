/**
 * One-off verification script for `logue/osc/granular` (2026-09-26). Stages real projects for
 * both platforms with a 16384-sample (16 KB) noise sample -- the xd-safe default import size --
 * so a real local build measures the actual `.rodata` table cost and per-instance `.bss`
 * against the RAM estimator.
 *
 * Local build (a local ARM toolchain must be installed, e.g. `brew install --cask
 * gcc-arm-embedded`):
 *   cd <staged-dir> && GCC_BIN_PATH=/opt/homebrew/bin make -j8 && GCC_BIN_PATH=/opt/homebrew/bin make install
 */
import { writeFileSync, mkdirSync, copyFileSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import { generateOscUnit } from '../src/nts1mkii/generateOscUnit'
import { bytesToBase64 } from '../src/sample/base64'
import { mulawEncode } from '../src/sample/mulaw'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformRoot = '/Users/peter/Documents/GitHub/logue-sdk/platform'

const bytes = new Uint8Array(16384)
let seed = 12345
for (let i = 0; i < bytes.length; i++) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  bytes[i] = mulawEncode((seed / 0x7fffffff) * 1.6 - 0.8)
}

const doc: PatchDocument = {
  nodes: [
    {
      kind: 'obj',
      type: 'logue/osc/granular',
      name: 'gran1',
      x: 0,
      y: 0,
      params: [
        { name: 'POSITION', value: '0', logueParamIndex: { 'minilogue-xd': 0, nts1mkii: 2 } }
      ],
      sample: { sourceName: 'noise', rate: 16000, encoding: 'mulaw8', data: bytesToBase64(bytes) }
    },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [{ sources: [{ obj: 'gran1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
  settings: {},
  notes: ''
}

// minilogue xd
{
  const result = generateOldGenOscUnit(doc, { name: 'poc mxd granular' })
  const projectDir = join(platformRoot, 'minilogue-xd', 'axomodern-poc-mxd-granular')
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
  const result = generateOscUnit(doc, { name: 'poc nts1 granular' })
  const templateDir = join(platformRoot, 'nts-1_mkii', 'dummy-osc')
  const projectDir = join(platformRoot, 'nts-1_mkii', 'axomodern-poc-nts1-granular')
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

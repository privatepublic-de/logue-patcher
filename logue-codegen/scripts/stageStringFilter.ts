/**
 * One-off verification script for `logue/filter/string` (the Karplus-Strong plucked-string
 * resonator, added 2026-09-24). Stages real projects for both platforms for a real build --
 * used to confirm both the minilogue xd and NTS-1 mkII generators produce code that actually
 * compiles and installs, not just that `generateOldGenOscUnit`/`generateOscUnit` return a
 * string. See CLAUDE.md's own `logue/filter/string` gotcha entry for the measured RAM and
 * code-size numbers this script was used to obtain, most recently re-run 2026-09-25 after
 * `STRING_MAX_DELAY_SAMPLES` doubled 1024->2048 to fix a real low-register pitch-tracking
 * report (8300 bytes bss on minilogue xd, 8344 on NTS-1 mkII, both real local builds).
 *
 *  1. minilogue xd: white noise excites the string, always pitch-tracked (no TRACK toggle to
 *     set) -- exercises the circular buffer + damping/allpass/DC-blocker state under sustained
 *     ringing, the RAM-budget-relevant path.
 *  2. NTS-1 mkII: the same patch, staged against that platform's own generator/template.
 *
 * Local build (a local ARM toolchain must be installed, e.g. `brew install --cask
 * gcc-arm-embedded`):
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
    { kind: 'obj', type: 'logue/osc/noise', name: 'noise1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/filter/string', name: 'string1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [
    { sources: [{ obj: 'noise1', outlet: 'out' }], dests: [{ obj: 'string1', inlet: 'in' }] },
    { sources: [{ obj: 'string1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ],
  settings: {},
  notes: ''
}

// minilogue xd
{
  const result = generateOldGenOscUnit(doc, { name: 'poc mxd string' })
  const projectDir = join(platformRoot, 'minilogue-xd', 'axomodern-poc-mxd-string')
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
  const result = generateOscUnit(doc, { name: 'poc nts1 string' })
  const templateDir = join(platformRoot, 'nts-1_mkii', 'dummy-osc')
  const projectDir = join(platformRoot, 'nts-1_mkii', 'axomodern-poc-nts1-string')
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

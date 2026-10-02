/**
 * One-off verification script for `logue/env/one-knob-adsr` (2026-10-02): a saw through a VCA
 * whose gain is the envelope; SHAPE on the first menu param and TIME on the second, and a slow
 * sine LFO wired into `shape` in a second unit (the control-rate path). Stages and builds real
 * projects for both platforms and prints the calls below the xd's `process`.
 *
 *   npx tsx logue-codegen/scripts/stageOneKnobAdsr.ts
 */
import { execFileSync } from 'child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import { generateOscUnit } from '../src/nts1mkii/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformRoot = '/Users/peter/Documents/GitHub/logue-sdk/platform'
const gccBin = process.env.GCC_BIN_PATH ?? '/opt/homebrew/bin'

function doc(withLfo: boolean): PatchDocument {
  const d: PatchDocument = {
    nodes: [
      {
        kind: 'obj',
        type: 'logue/env/one-knob-adsr',
        name: 'env1',
        x: 0,
        y: 0,
        params: [
          { name: 'SHAPE', value: '17', logueParamIndex: { 'minilogue-xd': 0, nts1mkii: 2 } },
          { name: 'TIME', value: '50', logueParamIndex: { 'minilogue-xd': 1, nts1mkii: 3 } }
        ]
      },
      { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
      { kind: 'obj', type: 'logue/gain/vca', name: 'vca1', x: 0, y: 0, params: [] },
      { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
    ],
    nets: [
      { sources: [{ obj: 'env1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'gain' }] },
      { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'in' }] },
      { sources: [{ obj: 'vca1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
    ],
    settings: {},
    notes: ''
  }
  if (withLfo) {
    d.nodes.push({ kind: 'obj', type: 'logue/lfo/sine-lfo', name: 'lfo1', x: 0, y: 0, params: [] })
    d.nets.push({
      sources: [{ obj: 'lfo1', outlet: 'out' }],
      dests: [{ obj: 'env1', inlet: 'shape' }]
    })
  }
  return d
}

function make(dir: string): void {
  execFileSync('make', ['-j8'], {
    cwd: dir,
    env: { ...process.env, GCC_BIN_PATH: gccBin },
    stdio: ['ignore', 'ignore', 'inherit']
  })
  execFileSync('make', ['install'], {
    cwd: dir,
    env: { ...process.env, GCC_BIN_PATH: gccBin },
    stdio: ['ignore', 'ignore', 'inherit']
  })
}

for (const [tag, withLfo] of [
  ['oneknob', false],
  ['oneknob-lfo', true]
] as const) {
  {
    const r = generateOldGenOscUnit(doc(withLfo), { name: `lp ${tag}` })
    const dir = join(platformRoot, 'minilogue-xd', `lp-xd-${tag}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(join(dir, 'ld'), { recursive: true })
    mkdirSync(join(dir, 'tpl'), { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), r.manifestJson)
    writeFileSync(join(dir, 'project.mk'), r.projectMk)
    writeFileSync(join(dir, 'osc.cpp'), r.oscCpp)
    writeFileSync(join(dir, 'Makefile'), r.makefile)
    writeFileSync(join(dir, 'tpl', '_unit.c'), r.unitC)
    writeFileSync(join(dir, 'ld', 'rules.ld'), r.rulesLd)
    writeFileSync(join(dir, 'ld', 'userosc.ld'), r.useroscLd)
    writeFileSync(join(dir, 'ld', 'osc_api.syms'), r.oscApiSyms)
    make(dir)
    const dis = execFileSync(
      join(gccBin, 'arm-none-eabi-objdump'),
      ['-d', '-C', join(dir, 'build', 'osc.elf')],
      { encoding: 'utf8' }
    )
    const size = execFileSync(join(gccBin, 'arm-none-eabi-size'), [join(dir, 'build', 'osc.elf')], {
      encoding: 'utf8'
    })
    const calls = new Set(Array.from(dis.matchAll(/\tbl\s+\S+ <([^>]+)>/g), (m) => m[1]))
    console.log(`xd ${tag}: calls ${[...calls].join(', ')}\n${size}`)
  }
  {
    const r = generateOscUnit(doc(withLfo), { name: `lp ${tag}` })
    const templateDir = join(platformRoot, 'nts-1_mkii', 'dummy-osc')
    const dir = join(platformRoot, 'nts-1_mkii', `lp-nts1-${tag}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'header.c'), r.headerC)
    writeFileSync(join(dir, 'osc.h'), r.oscH)
    writeFileSync(join(dir, 'unit.cc'), r.unitCc)
    copyFileSync(join(templateDir, 'Makefile'), join(dir, 'Makefile'))
    copyFileSync(join(templateDir, 'wasm.cc'), join(dir, 'wasm.cc'))
    copyFileSync(join(templateDir, 'config.mk'), join(dir, 'config.mk'))
    execFileSync('sed', [
      '-i',
      '',
      `s/^PROJECT := .*/PROJECT := lp_${tag.replace('-', '_')}/`,
      join(dir, 'config.mk')
    ])
    make(dir)
    console.log(`nts1mkii ${tag}: built`)
  }
}

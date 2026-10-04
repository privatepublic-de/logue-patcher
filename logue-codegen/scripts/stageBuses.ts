/**
 * One-off verification script for buses (2026-10-04, `docs/PLAN-buses.md`). Stages and builds a
 * real oscillator for both platforms and prints the calls below the xd's `process` and its size:
 *  - `buses`: saw, square and sine each through a send onto bus "mix" (sent from the canvas in
 *    that order, chained by name), one receive into the output; the saw's send GAIN on the Shape
 *    knob, the square's as menu param 1 (xd) / 3 (NTS-1 mkII).
 *
 *   npx tsx logue-codegen/scripts/stageBuses.ts
 */
import { execFileSync } from 'child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import { generateOscUnit } from '../src/nts1mkii/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'
import type { LogueKnob, ParamValue } from '../../src/shared/domain/paramValueTypes'

const platformRoot = '/Users/peter/Documents/GitHub/logue-sdk/platform'
const gccBin = process.env.GCC_BIN_PATH ?? '/opt/homebrew/bin'

type Node = PatchDocument['nodes'][number]
type Param = ParamValue
const obj = (type: string, name: string, params: Param[] = []): Node => ({
  kind: 'obj',
  type,
  name,
  x: 0,
  y: 0,
  params
})
const net = (
  from: string,
  outlet: string,
  to: string,
  inlet: string
): PatchDocument['nets'][number] => ({
  sources: [{ obj: from, outlet }],
  dests: [{ obj: to, inlet }]
})
const both = (v: LogueKnob): { 'minilogue-xd': LogueKnob; nts1mkii: LogueKnob } => ({
  'minilogue-xd': v,
  nts1mkii: v
})

function send(name: string, params: Param[] = []): Node {
  return { ...obj('logue/mix/send', name, params), bus: 'mix' } as Node
}

const UNITS: Record<string, () => PatchDocument> = {
  buses: () => ({
    nodes: [
      obj('logue/osc/saw', 'saw'),
      obj('logue/osc/square', 'sq'),
      obj('logue/osc/sine', 'sine'),
      send('s_saw', [{ name: 'GAIN', value: '80', logueKnob: both('shape') }]),
      send('s_sq', [
        { name: 'GAIN', value: '60', logueParamIndex: { 'minilogue-xd': 0, nts1mkii: 2 } }
      ]),
      send('s_sine'),
      { ...obj('logue/mix/receive', 'rx'), bus: 'mix' } as Node,
      obj('logue/io/audio-out', 'out')
    ],
    nets: [
      net('saw', 'out', 's_saw', 'in'),
      net('sq', 'out', 's_sq', 'in'),
      net('sine', 'out', 's_sine', 'in'),
      net('rx', 'out', 'out', 'in')
    ],
    settings: {},
    notes: ''
  })
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

for (const [tag, build] of Object.entries(UNITS)) {
  {
    const r = generateOldGenOscUnit(build(), { name: `lp ${tag}` })
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
    const r = generateOscUnit(build(), { name: `lp ${tag}` })
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

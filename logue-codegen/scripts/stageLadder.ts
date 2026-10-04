/**
 * One-off verification script for `logue/filter/ladder` (2026-10-04). Stages and builds real
 * projects for both platforms and prints the calls below the xd's `process` and each size:
 *  - `ladder`: saw -> ladder -> out, CUTOFF on the Shape knob, RESONANCE on the second knob,
 *    DRIVE, TRACK and FB_DRIVE as menu params 1/2/3.
 *  - `ladder-env`: the same with an ADSR into `cutoff` (dial at 20, so the envelope opens it)
 *    and an LFO into `resonance` (the per-sample coefficient path).
 *  - `ladder-osc`: no input, TRACK on, RESONANCE on the Shape knob from 100: the filter's own
 *    self-oscillation as the voice (it takes a moment to start at low notes).
 *
 *   npx tsx logue-codegen/scripts/stageLadder.ts
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

function ladderDoc(
  ladderParams: Param[],
  withSaw: boolean,
  extra: Node[] = [],
  extraNets: PatchDocument['nets'] = []
): PatchDocument {
  const nodes: Node[] = [
    obj('logue/filter/ladder', 'lad', ladderParams),
    obj('logue/io/audio-out', 'out'),
    ...extra
  ]
  const nets = [net('lad', 'out', 'out', 'in'), ...extraNets]
  if (withSaw) {
    nodes.push(obj('logue/osc/saw', 'saw'))
    nets.push(net('saw', 'out', 'lad', 'in'))
  }
  return { nodes, nets, settings: {}, notes: '' }
}

const UNITS: Record<string, () => PatchDocument> = {
  ladder: () =>
    ladderDoc(
      [
        { name: 'CUTOFF', value: '60', logueKnob: both('shape') },
        { name: 'RESONANCE', value: '40', logueKnob: both('shape-2') },
        { name: 'DRIVE', value: '0', logueParamIndex: { 'minilogue-xd': 0, nts1mkii: 2 } },
        { name: 'TRACK', value: '0', logueParamIndex: { 'minilogue-xd': 1, nts1mkii: 3 } },
        { name: 'FB_DRIVE', value: '0', logueParamIndex: { 'minilogue-xd': 2, nts1mkii: 4 } }
      ],
      true
    ),
  'ladder-env': () =>
    ladderDoc(
      [
        { name: 'CUTOFF', value: '20' },
        { name: 'RESONANCE', value: '60', logueKnob: both('shape-2') },
        { name: 'DRIVE', value: '30', logueKnob: both('shape') }
      ],
      true,
      [obj('logue/env/adsr', 'env'), obj('logue/lfo/sine-lfo', 'lfo')],
      [net('env', 'out', 'lad', 'cutoff'), net('lfo', 'out', 'lad', 'resonance')]
    ),
  'ladder-osc': () =>
    ladderDoc(
      [
        { name: 'RESONANCE', value: '100', logueKnob: both('shape') },
        { name: 'TRACK', value: '100' }
      ],
      false
    )
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

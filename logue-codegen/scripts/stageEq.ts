/**
 * One-off verification script for `logue/filter/eq-band`, `logue/filter/tilt` and svf's
 * `notch` outlet (2026-10-05). Stages and builds real projects for both platforms and prints the
 * calls below the xd's `process` and each size:
 *  - `eq`: saw -> eq-band -> tilt -> out. eq FREQ on the Shape knob, GAIN on the second knob;
 *    TYPE, Q, TILT and CENTER as menu params 1-4 (NTS-1 mkII: 3-6).
 *  - `eq-lfo`: the same with a sine LFO into eq `freq`, another into `gain` and `q`, and one into
 *    tilt's `tilt` (the control-rate paths). TYPE and TILT on the knobs.
 *  - `notch`: noise -> svf `notch` -> out, CUTOFF on the Shape knob, RESONANCE on the second.
 *
 *   npx tsx logue-codegen/scripts/stageEq.ts
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

function chain(
  eqParams: Param[],
  tiltParams: Param[],
  extra: Node[] = [],
  extraNets: PatchDocument['nets'] = []
): PatchDocument {
  return {
    nodes: [
      obj('logue/osc/saw', 'saw'),
      obj('logue/filter/eq-band', 'eq', eqParams),
      obj('logue/filter/tilt', 'tilt', tiltParams),
      obj('logue/io/audio-out', 'out'),
      ...extra
    ],
    nets: [
      net('saw', 'out', 'eq', 'in'),
      net('eq', 'out', 'tilt', 'in'),
      net('tilt', 'out', 'out', 'in'),
      ...extraNets
    ],
    settings: {},
    notes: ''
  }
}

const UNITS: Record<string, () => PatchDocument> = {
  eq: () =>
    chain(
      [
        { name: 'FREQ', value: '50', logueKnob: both('shape') },
        { name: 'GAIN', value: '50', logueKnob: both('shape-2') },
        { name: 'TYPE', value: '0', logueParamIndex: { 'minilogue-xd': 0, nts1mkii: 2 } },
        { name: 'Q', value: '25', logueParamIndex: { 'minilogue-xd': 1, nts1mkii: 3 } }
      ],
      [
        { name: 'TILT', value: '0', logueParamIndex: { 'minilogue-xd': 2, nts1mkii: 4 } },
        { name: 'CENTER', value: '50', logueParamIndex: { 'minilogue-xd': 3, nts1mkii: 5 } }
      ]
    ),
  'eq-lfo': () =>
    chain(
      [
        { name: 'TYPE', value: '0', logueKnob: both('shape') },
        { name: 'FREQ', value: '50' },
        { name: 'GAIN', value: '0' },
        { name: 'Q', value: '50' }
      ],
      [{ name: 'TILT', value: '0', logueKnob: both('shape-2') }],
      [
        obj('logue/lfo/sine-lfo', 'lfo1'),
        obj('logue/lfo/sine-lfo', 'lfo2'),
        obj('logue/lfo/sine-lfo', 'lfo3')
      ],
      [
        net('lfo1', 'out', 'eq', 'freq'),
        net('lfo2', 'out', 'eq', 'gain'),
        net('lfo2', 'out', 'eq', 'q'),
        net('lfo3', 'out', 'tilt', 'tilt')
      ]
    ),
  notch: () => ({
    nodes: [
      obj('logue/osc/noise', 'n'),
      obj('logue/filter/svf', 'svf', [
        { name: 'CUTOFF', value: '50', logueKnob: both('shape') },
        { name: 'RESONANCE', value: '0', logueKnob: both('shape-2') }
      ]),
      obj('logue/io/audio-out', 'out')
    ],
    nets: [net('n', 'out', 'svf', 'in'), net('svf', 'notch', 'out', 'in')],
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
      `s/^PROJECT := .*/PROJECT := lp_${tag.replaceAll('-', '_')}/`,
      join(dir, 'config.mk')
    ])
    make(dir)
    console.log(`nts1mkii ${tag}: built`)
  }
}

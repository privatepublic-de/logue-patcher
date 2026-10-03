/**
 * One-off verification script for `logue/osc/noise`'s COLOR and `logue/osc/lfsr` (2026-10-03).
 * Three units per platform: `noise` (COLOR as a menu param, so every colour is live code), `lfsr`
 * (MODE and TRACK as menu params, RATE on the Shape knob: the per-block path) and `lfsr-lfo`
 * (a sine LFO into `pitch`: the per-sample path). Stages and builds real projects for both
 * platforms and prints the calls below the xd's `process` and the sizes.
 *
 *   npx tsx logue-codegen/scripts/stageNoiseTypes.ts
 */
import { execFileSync } from 'child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import { generateOscUnit } from '../src/nts1mkii/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformRoot = '/Users/peter/Documents/GitHub/logue-sdk/platform'
const gccBin = process.env.GCC_BIN_PATH ?? '/opt/homebrew/bin'

type Tag = 'noise' | 'lfsr' | 'lfsr-lfo'

function doc(tag: Tag): PatchDocument {
  const node: PatchDocument['nodes'][number] =
    tag === 'noise'
      ? {
          kind: 'obj',
          type: 'logue/osc/noise',
          name: 'n1',
          x: 0,
          y: 0,
          params: [
            { name: 'COLOR', value: '1', logueParamIndex: { 'minilogue-xd': 0, nts1mkii: 2 } }
          ]
        }
      : {
          kind: 'obj',
          type: 'logue/osc/lfsr',
          name: 'n1',
          x: 0,
          y: 0,
          params: [
            { name: 'MODE', value: '1', logueParamIndex: { 'minilogue-xd': 0, nts1mkii: 2 } },
            { name: 'TRACK', value: '100', logueParamIndex: { 'minilogue-xd': 1, nts1mkii: 3 } },
            {
              name: 'RATE',
              value: '50',
              logueKnob: { 'minilogue-xd': 'shape', nts1mkii: 'shape' }
            }
          ]
        }
  const d: PatchDocument = {
    nodes: [node, { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }],
    nets: [{ sources: [{ obj: 'n1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
    settings: {},
    notes: ''
  }
  if (tag === 'lfsr-lfo') {
    d.nodes.push({ kind: 'obj', type: 'logue/lfo/sine-lfo', name: 'lfo1', x: 0, y: 0, params: [] })
    d.nets.push({
      sources: [{ obj: 'lfo1', outlet: 'out' }],
      dests: [{ obj: 'n1', inlet: 'pitch' }]
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

for (const tag of ['noise', 'lfsr', 'lfsr-lfo'] as const) {
  {
    const r = generateOldGenOscUnit(doc(tag), { name: `lp ${tag}` })
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
    const r = generateOscUnit(doc(tag), { name: `lp ${tag}` })
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

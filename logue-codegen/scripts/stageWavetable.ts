/**
 * One-off verification script for `logue/osc/wavetable` (docs/PLAN-wavetable.md, phase 2). Stages
 * and builds real projects for both platforms and prints the calls below the xd's `process`, the
 * linked sizes and the RAM estimate next to them:
 *  - `wt`: POSITION on the Shape knob, MORPH a menu param (the per-block path);
 *  - `wt-lfo`: `pitch` from a sine LFO and `position` from a triangle LFO (the per-sample paths);
 *  - NTS-1 mkII only, `wt-64x256` and `wt-32x512`: the larger table shapes the import offers.
 * Tables are `wavetableFixture`'s, or, with WAVETABLE_WAV=<file>, imported from that file.
 *
 *   npx tsx logue-codegen/scripts/stageWavetable.ts
 */
import { execFileSync } from 'child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { estimateOscStateCost } from '../src/estimateOscStateCost'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import { generateOscUnit } from '../src/nts1mkii/generateOscUnit'
import { importWavetable } from '../src/sample/importWavetable'
import type { LoguePlatform, PatchDocument, SampleAsset } from '../../src/shared/domain/patch'
import { wavetableFixture } from './wavetableFixture'

const platformRoot = '/Users/peter/Documents/GitHub/logue-sdk/platform'
const gccBin = process.env.GCC_BIN_PATH ?? '/opt/homebrew/bin'

function table(frames: number, length: number): SampleAsset {
  const wav = process.env.WAVETABLE_WAV
  return wav
    ? importWavetable(new Uint8Array(readFileSync(wav)), 'wav', frames, length).asset
    : wavetableFixture(frames, length)
}

function doc(sample: SampleAsset, modulated: boolean): PatchDocument {
  const d: PatchDocument = {
    nodes: [
      {
        kind: 'obj',
        type: 'logue/osc/wavetable',
        name: 'wt1',
        x: 0,
        y: 0,
        sample,
        params: [
          { name: 'MORPH', value: '0', logueParamIndex: { 'minilogue-xd': 0, nts1mkii: 2 } },
          {
            name: 'POSITION',
            value: '0',
            logueKnob: { 'minilogue-xd': 'shape', nts1mkii: 'shape' }
          }
        ]
      },
      { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
    ],
    nets: [{ sources: [{ obj: 'wt1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
    settings: {},
    notes: ''
  }
  if (modulated) {
    d.nodes.push(
      {
        kind: 'obj',
        type: 'logue/lfo/sine-lfo',
        name: 'lfo1',
        x: 0,
        y: 0,
        params: [{ name: 'RATE', value: '60' }]
      },
      {
        kind: 'obj',
        type: 'logue/lfo/triangle-lfo',
        name: 'lfo2',
        x: 0,
        y: 0,
        params: [{ name: 'RATE', value: '40' }]
      }
    )
    d.nets.push(
      { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'wt1', inlet: 'pitch' }] },
      { sources: [{ obj: 'lfo2', outlet: 'out' }], dests: [{ obj: 'wt1', inlet: 'position' }] }
    )
  }
  return d
}

function make(dir: string): void {
  for (const target of [[], ['install']]) {
    execFileSync('make', ['-j8', ...target], {
      cwd: dir,
      env: { ...process.env, GCC_BIN_PATH: gccBin },
      stdio: ['ignore', 'ignore', 'inherit']
    })
  }
}

function sizeOf(elf: string): string {
  return execFileSync(join(gccBin, 'arm-none-eabi-size'), [elf], { encoding: 'utf8' }).trim()
}

function estimate(d: PatchDocument, platform: LoguePlatform): string {
  const ram = estimateOscStateCost(d, platform)
  return ram.status === 'ok'
    ? `estimate ${ram.estimate.totalBytes} B (state ${ram.estimate.stateBytes}, code ${ram.estimate.codeBytes}) of ${ram.estimate.budgetBytes}`
    : ram.reason
}

function stageXd(tag: string, d: PatchDocument): void {
  const r = generateOldGenOscUnit(d, { name: `lp ${tag}` })
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
  const elf = join(dir, 'build', 'osc.elf')
  const dis = execFileSync(join(gccBin, 'arm-none-eabi-objdump'), ['-d', '-C', elf], {
    encoding: 'utf8'
  })
  const calls = new Set(Array.from(dis.matchAll(/\tbl\s+\S+ <([^>]+)>/g), (m) => m[1]))
  console.log(
    `xd ${tag}: calls ${[...calls].join(', ')}\n${sizeOf(elf)}\n${estimate(d, 'minilogue-xd')}\n`
  )
}

function stageNts1(tag: string, d: PatchDocument): void {
  const r = generateOscUnit(d, { name: `lp ${tag}` })
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
    `s/^PROJECT := .*/PROJECT := lp_${tag.replace(/-/g, '_')}/`,
    join(dir, 'config.mk')
  ])
  make(dir)
  const elf = readdirSync(join(dir, 'build')).find((f) => f.endsWith('.elf'))!
  console.log(`nts1mkii ${tag}:\n${sizeOf(join(dir, 'build', elf))}\n${estimate(d, 'nts1mkii')}\n`)
}

const base = table(32, 256)
for (const [tag, modulated] of [
  ['wt', false],
  ['wt-lfo', true]
] as const) {
  stageXd(tag, doc(base, modulated))
  stageNts1(tag, doc(base, modulated))
}
stageNts1('wt-64x256', doc(table(64, 256), false))
stageNts1('wt-32x512', doc(table(32, 512), false))

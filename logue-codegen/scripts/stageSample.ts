/**
 * One-off verification script for `logue/osc/sample` (docs/PLAN-sample.md, phase 2). Stages and
 * builds real projects for both platforms and prints the calls below the xd's `process` and the
 * sizes:
 *  - `smp`: a 16K-sample linear 8-bit tone at 32 kHz with a loop, START on the Shape knob, LOOP
 *    (Off/Forward/Ping-pong), INTERP and REVERSE as menu params (the per-block path);
 *  - `smp-lfo`: the same with `pitch` from a sine LFO and `trig` from a square LFO (the
 *    control-rate and per-sample paths);
 *  - NTS-1 mkII only, `smp-<n>k`: the same as `smp` with an n K-sample sample, to find the
 *    largest length the import may offer (49 152 B is the platform's RAM load limit).
 *
 *   npx tsx logue-codegen/scripts/stageSample.ts
 */
import { execFileSync } from 'child_process'
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import { generateOscUnit } from '../src/nts1mkii/generateOscUnit'
import { bytesToBase64 } from '../src/sample/base64'
import type { PatchDocument, SampleAsset } from '../../src/shared/domain/patch'

const platformRoot = '/Users/peter/Documents/GitHub/logue-sdk/platform'
const gccBin = process.env.GCC_BIN_PATH ?? '/opt/homebrew/bin'
const RATE = 32000

/** A decaying harmonic tone at middle C, settling into a loop of whole periods at the end. */
function toneSample(length: number): SampleAsset {
  const hz = 261.6256
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    const t = i / RATE
    let v = 0
    for (let h = 1; h <= 6; h++)
      v += (Math.sin(2 * Math.PI * hz * h * t) * Math.exp(-t * h * 2)) / h
    bytes[i] = Math.round(Math.max(-1, Math.min(1, v * 0.7)) * 127) & 0xff
  }
  const period = RATE / hz
  const loopLength = Math.round(Math.floor(2000 / period) * period)
  return {
    sourceName: 'tone.wav',
    rate: RATE,
    encoding: 'pcm8',
    data: bytesToBase64(bytes),
    loopStart: length - loopLength,
    loopEnd: length
  }
}

function doc(length: number, modulated: boolean): PatchDocument {
  const d: PatchDocument = {
    nodes: [
      {
        kind: 'obj',
        type: 'logue/osc/sample',
        name: 'smp1',
        x: 0,
        y: 0,
        sample: toneSample(length),
        params: [
          { name: 'LOOP', value: '1', logueParamIndex: { 'minilogue-xd': 0, nts1mkii: 2 } },
          { name: 'INTERP', value: '0', logueParamIndex: { 'minilogue-xd': 1, nts1mkii: 3 } },
          { name: 'REVERSE', value: '0', logueParamIndex: { 'minilogue-xd': 2, nts1mkii: 4 } },
          { name: 'START', value: '0', logueKnob: { 'minilogue-xd': 'shape', nts1mkii: 'shape' } }
        ]
      },
      { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
    ],
    nets: [{ sources: [{ obj: 'smp1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
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
        type: 'logue/lfo/square-lfo',
        name: 'clk1',
        x: 0,
        y: 0,
        params: [{ name: 'RATE', value: '40' }]
      }
    )
    d.nets.push(
      { sources: [{ obj: 'lfo1', outlet: 'out' }], dests: [{ obj: 'smp1', inlet: 'pitch' }] },
      { sources: [{ obj: 'clk1', outlet: 'out' }], dests: [{ obj: 'smp1', inlet: 'trig' }] }
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
  console.log(`xd ${tag}: calls ${[...calls].join(', ')}\n${sizeOf(elf)}\n`)
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
  console.log(`nts1mkii ${tag}:\n${sizeOf(join(dir, 'build', elf))}\n`)
}

for (const [tag, modulated] of [
  ['smp', false],
  ['smp-lfo', true]
] as const) {
  stageXd(tag, doc(16384, modulated))
  stageNts1(tag, doc(16384, modulated))
}
for (const k of [32, 40, 44]) stageNts1(`smp-${k}k`, doc(k * 1024, false))

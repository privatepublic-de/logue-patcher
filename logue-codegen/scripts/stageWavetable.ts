/**
 * One-off verification script for `logue/osc/wavetable` (docs/PLAN-wavetable.md, phase 2). Stages
 * and builds real projects for both platforms and prints the calls below the xd's `process`, the
 * linked sizes and the RAM estimate next to them:
 *  - `wt`: POSITION on the Shape knob, MORPH a menu param (the per-block path);
 *  - `wt-lfo`: `pitch` from a sine LFO and `position` from a triangle LFO (the per-sample paths);
 *  - NTS-1 mkII only, `wt-64x256` and `wt-32x512`: the larger table shapes the import offers.
 * Tables are `wavetableFixture`'s, or, with WAVETABLE_WAV=<file>, imported from that file.
 *
 * `--hardware` (needs WAVETABLE_WAV) instead builds the listening set for phase 4 and copies the
 * units to HW_OUT (default ~/Documents/logue-patches/build-results/wavetable-hw):
 *  - `WT Shape`: POSITION on the Shape knob (scan it by hand, or with the device's Mod LFO on
 *    Shape -- the original granular complaint), MORPH as menu param 1;
 *  - `WT Scan`: a triangle LFO sweeping POSITION over every frame, its RATE on the Shape knob;
 *  - `GR Scan`: granular SYNC on the same file with the same sweep, for comparison;
 *  - NTS-1 mkII only, `WT 64`: 64 frames, POSITION on Shape.
 *
 *   npx tsx logue-codegen/scripts/stageWavetable.ts [--hardware]
 */
import { execFileSync } from 'child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { estimateOscCpuCost } from '../src/estimateOscCpuCost'
import { estimateOscStateCost } from '../src/estimateOscStateCost'
import { importWavSample } from '../src/sample/importSample'
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

function stageXd(tag: string, d: PatchDocument, name = `lp ${tag}`): string {
  const r = generateOldGenOscUnit(d, { name })
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
  const cpu = estimateOscCpuCost(d)
  const cpuText =
    cpu.status === 'ok'
      ? `cpu ${Math.round(cpu.estimate.cyclesPerVoice)}..${Math.round(cpu.estimate.maxCyclesPerVoice)}`
      : cpu.reason
  console.log(
    `xd ${tag}: calls ${[...calls].join(', ')}\n${sizeOf(elf)}\n${estimate(d, 'minilogue-xd')}, ${cpuText}\n`
  )
  return join(dir, 'osc.mnlgxdunit')
}

function stageNts1(tag: string, d: PatchDocument, name = `lp ${tag}`): string {
  const r = generateOscUnit(d, { name })
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
  return join(
    dir,
    readdirSync(dir).find((f) => f.endsWith('.nts1mkiiunit'))!
  )
}

/** An oscillator node, a POSITION sweep (triangle LFO, RATE on the Shape knob) and the output.
 *  `depth` is the oscillator's additive POSITION depth: the sweep covers 0..100 either way. */
function scanDoc(osc: PatchDocument['nodes'][number], depth: 100 | 50): PatchDocument {
  const nodes: PatchDocument['nodes'] = [
    osc,
    {
      kind: 'obj',
      type: 'logue/lfo/triangle-lfo',
      name: 'scan',
      x: 0,
      y: 0,
      params: [
        { name: 'RATE', value: '30', logueKnob: { 'minilogue-xd': 'shape', nts1mkii: 'shape' } }
      ]
    },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ]
  const nets: PatchDocument['nets'] = [
    { sources: [{ obj: osc.name! }], dests: [{ obj: 'out', inlet: 'in' }] }
  ]
  if (depth === 100) {
    // POSITION 0 plus a 0..1 sweep x 100.
    nodes.push({
      kind: 'obj',
      type: 'logue/util/bipolar-to-unipolar',
      name: 'uni',
      x: 0,
      y: 0,
      params: []
    })
    nets.push(
      { sources: [{ obj: 'scan' }], dests: [{ obj: 'uni', inlet: 'in' }] },
      { sources: [{ obj: 'uni' }], dests: [{ obj: osc.name!, inlet: 'position' }] }
    )
  } else {
    // POSITION 50 plus a -1..1 sweep x 50.
    nets.push({ sources: [{ obj: 'scan' }], dests: [{ obj: osc.name!, inlet: 'position' }] })
  }
  return { nodes, nets, settings: {}, notes: '' }
}

if (process.argv.includes('--hardware')) {
  const wav = process.env.WAVETABLE_WAV
  if (!wav) throw new Error('--hardware needs WAVETABLE_WAV=<file>')
  const out =
    process.env.HW_OUT ?? join(homedir(), 'Documents/logue-patches/build-results/wavetable-hw')
  mkdirSync(out, { recursive: true })
  const bytes = new Uint8Array(readFileSync(wav))
  const vocal = importWavetable(bytes, 'wav', 32, 256).asset
  const morph = { name: 'MORPH', value: '0', logueParamIndex: { 'minilogue-xd': 0, nts1mkii: 2 } }
  const wtNode = (
    sample: SampleAsset,
    position: number,
    onKnob: boolean
  ): PatchDocument['nodes'][number] => ({
    kind: 'obj',
    type: 'logue/osc/wavetable',
    name: 'wt',
    x: 0,
    y: 0,
    sample,
    params: [
      morph,
      {
        name: 'POSITION',
        value: String(position),
        ...(onKnob
          ? { logueKnob: { 'minilogue-xd': 'shape' as const, nts1mkii: 'shape' as const } }
          : {})
      }
    ]
  })
  const shapeDoc = (sample: SampleAsset): PatchDocument => {
    const d = doc(sample, false)
    d.nodes[0] = wtNode(sample, 0, true)
    d.nets = [{ sources: [{ obj: 'wt' }], dests: [{ obj: 'out', inlet: 'in' }] }]
    return d
  }
  const granular: PatchDocument['nodes'][number] = {
    kind: 'obj',
    type: 'logue/osc/granular',
    name: 'gr',
    x: 0,
    y: 0,
    sample: importWavSample(bytes, 'wav', 16384).asset,
    params: [{ name: 'POSITION', value: '50' }]
  }
  const units: [string, string, string][] = []
  const both = (tag: string, name: string, d: PatchDocument): void => {
    units.push([stageXd(tag, d, name), `${name}.mnlgxdunit`, 'xd'])
    units.push([stageNts1(tag, d, name), `${name}.nts1mkiiunit`, 'nts1mkii'])
  }
  both('hw-wt-shape', 'WT Shape', shapeDoc(vocal))
  both('hw-wt-scan', 'WT Scan', scanDoc(wtNode(vocal, 0, false), 100))
  both('hw-gr-scan', 'GR Scan', scanDoc(granular, 50))
  units.push([
    stageNts1('hw-wt-64', shapeDoc(importWavetable(bytes, 'wav', 64, 256).asset), 'WT 64'),
    'WT 64.nts1mkiiunit',
    'nts1mkii'
  ])
  for (const [from, name] of units) copyFileSync(from, join(out, name))
  console.log(`units in ${out}:\n  ${units.map((u) => u[1]).join('\n  ')}`)
} else {
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
}

/**
 * One-off verification for `logue/filter/formant`'s per-block coefficients (2026-10-06). Stages
 * and builds real projects for both platforms; for the xd it prints every call target and which
 * of them make calls themselves (`process -> leaf` is the hardware-proven shape; the formant crash
 * of 2026-09-19 had formant -> helper -> note_w0 at `-Os`) and the size/bss.
 *  - `fmt-res`: the original crash repro, a saw -> formant with `resonance` wired from a knob.
 *  - `fmt-triple`: vowel/shift/resonance from the Shape knob, the second knob and a menu param
 *    (the shape that exposed the first fix as partial).
 *  - `fmt-lfo`: LFOs into all four inlets (the control-rate path).
 *  - `fmt-two`: two formants in series, one still (VOWEL on Shape), one with an LFO on `vowel`.
 *
 *   npx tsx logue-codegen/scripts/stageFormant.ts
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
const obj = (type: string, name: string, params: ParamValue[] = []): Node => ({
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
const onKnob = (name: string, knob: LogueKnob): Node =>
  obj('logue/sense/control', name, [{ name: 'VALUE', value: '50', logueKnob: both(knob) }])
const lfo = (name: string, rate: number): Node =>
  obj('logue/lfo/sine-lfo', name, [{ name: 'RATE', value: String(rate) }])

function chain(formants: Node[], extra: Node[], extraNets: PatchDocument['nets']): PatchDocument {
  const nets = [net('saw', 'out', formants[0].name!, 'in')]
  for (let i = 1; i < formants.length; i++)
    nets.push(net(formants[i - 1].name!, 'out', formants[i].name!, 'in'))
  nets.push(net(formants[formants.length - 1].name!, 'out', 'out', 'in'), ...extraNets)
  return {
    nodes: [obj('logue/osc/saw', 'saw'), ...formants, obj('logue/io/audio-out', 'out'), ...extra],
    nets,
    settings: {},
    notes: ''
  }
}

const UNITS: Record<string, () => PatchDocument> = {
  'fmt-res': () =>
    chain(
      [obj('logue/filter/formant', 'f')],
      [onKnob('k', 'shape')],
      [net('k', 'bipolar', 'f', 'resonance')]
    ),
  'fmt-triple': () =>
    chain(
      [obj('logue/filter/formant', 'f')],
      [
        onKnob('k1', 'shape'),
        onKnob('k2', 'shape-2'),
        obj('logue/sense/control', 'p', [
          {
            name: 'VALUE',
            value: '50',
            label: 'Res',
            logueParamIndex: { 'minilogue-xd': 0, nts1mkii: 2 }
          }
        ])
      ],
      [
        net('k1', 'bipolar', 'f', 'vowel'),
        net('k2', 'bipolar', 'f', 'shift'),
        net('p', 'bipolar', 'f', 'resonance')
      ]
    ),
  'fmt-lfo': () =>
    chain(
      [obj('logue/filter/formant', 'f')],
      [lfo('l1', 40), lfo('l2', 25), lfo('l3', 55), lfo('l4', 15)],
      [
        net('l1', 'out', 'f', 'vowel'),
        net('l2', 'out', 'f', 'shift'),
        net('l3', 'out', 'f', 'resonance'),
        net('l4', 'out', 'f', 'character')
      ]
    ),
  'fmt-two': () =>
    chain(
      [obj('logue/filter/formant', 'f1'), obj('logue/filter/formant', 'f2')],
      [onKnob('k', 'shape'), lfo('l', 40)],
      [net('k', 'bipolar', 'f1', 'vowel'), net('l', 'out', 'f2', 'vowel')]
    )
}

function make(dir: string): void {
  for (const target of [[], ['install']])
    execFileSync('make', target.length ? target : ['-j8'], {
      cwd: dir,
      env: { ...process.env, GCC_BIN_PATH: gccBin },
      stdio: ['ignore', 'ignore', 'inherit']
    })
}

/** Each function's own `bl` targets, from `objdump -d`. */
function callGraph(dis: string): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>()
  let current = ''
  for (const line of dis.split('\n')) {
    const fn = /^[0-9a-f]+ <(.+)>:$/.exec(line)
    if (fn) {
      current = fn[1]
      graph.set(current, new Set())
      continue
    }
    const bl = /\tbl\s+\S+ <([^>+]+)>/.exec(line)
    if (bl && current) graph.get(current)!.add(bl[1])
  }
  return graph
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
    const graph = callGraph(dis)
    const below = [...(graph.get('Osc::process(long*, unsigned long)') ?? [])].map((callee) => {
      const own = [...(graph.get(callee) ?? [])]
      return own.length ? `${callee} -> ${own.join(', ')}` : `${callee} (leaf)`
    })
    console.log(`xd ${tag}: below process: ${below.join('; ') || 'none'}\n${size}`)
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

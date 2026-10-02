/**
 * Stages one oscillator unit per primitive/feature that has never been heard on a device
 * (2026-09-30, CLAUDE.md's "No hardware pass yet" notes), for both platforms, and builds them:
 * platform/nts-1_mkii/lp-osc-* and platform/minilogue-xd/lp-osc-*. Prints each unit's built
 * size, the RAM estimate and (xd) the CPU estimate, so nothing likely to hang goes on a device
 * unannounced.
 *
 * Controls: Shape / Alt-Shape (NTS-1 mkII) = Shape / Shift+Shape (xd) as noted per unit, then
 * menu params in order (NTS-1 mkII Param 3.., xd Param 1..).
 *
 * Usage: npx tsx logue-codegen/scripts/stageOscHardwareUnits.ts
 */
import { execFileSync } from 'child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { generateMinilogueXdProject } from '../src/minilogue-xd/projectFiles'
import { generateNts1MkiiProject, nts1mkiiConfigMk } from '../src/nts1mkii/projectFiles'
import { estimateOscStateCost } from '../src/estimateOscStateCost'
import { cpuZone, estimateOscCpuCost } from '../src/estimateOscCpuCost'
import { LOGUE_AUDIO_OUT_TYPE } from '../src/oscInstances'
import {
  LOGUE_SUBPATCH_INLET_TYPE,
  LOGUE_SUBPATCH_OUTLET_TYPE,
  type SubpatchDefinitions
} from '../src/subpatches'
import { bytesToBase64 } from '../src/sample/base64'
import { mulawEncode } from '../src/sample/mulaw'
import type { LoguePlatform, Net, ObjNode, PatchDocument } from '../../src/shared/domain/patch'
import type { LogueKnob, ParamValue } from '../../src/shared/domain/paramValueTypes'

const platformRoot = join(
  process.env.LOGUE_SDK ?? join(homedir(), 'Documents/GitHub/logue-sdk'),
  'platform'
)
const gccBin = process.env.GCC_BIN_PATH ?? '/opt/homebrew/bin'

function obj(name: string, type: string, params: ParamValue[] = []): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params }
}
function wire(from: string, outlet: string, to: string, inlet: string): Net {
  return { sources: [{ obj: from, outlet }], dests: [{ obj: to, inlet }] }
}
const OUT = obj('out', LOGUE_AUDIO_OUT_TYPE)

/** A param on a panel knob, on both devices (Shape / Shift-Shape exist on both). */
function knob(name: string, value: string, which: LogueKnob): ParamValue {
  return { name, value, logueKnob: { nts1mkii: which, 'minilogue-xd': which } }
}
/** A param as the i-th menu param: NTS-1 mkII Param 3+i, xd Param 1+i. */
function menu(name: string, value: string, i: number): ParamValue {
  return { name, value, logueParamIndex: { nts1mkii: 2 + i, 'minilogue-xd': i } }
}

interface Unit {
  dir: string
  name: string
  platforms: LoguePlatform[]
  doc: PatchDocument
  subpatches?: SubpatchDefinitions
}
const BOTH: LoguePlatform[] = ['nts1mkii', 'minilogue-xd']

function osc(nodes: ObjNode[], nets: Net[]): PatchDocument {
  return { nodes: [...nodes, OUT], nets, settings: { logueTarget: { module: 'osc' } }, notes: '' }
}

/** A harmonic tone whose brightness sweeps over its length, 16 kHz mu-law. */
function toneSample(): ObjNode['sample'] {
  const n = 16384
  const bytes = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / 16000
    const bright = i / n
    let v = 0
    for (let h = 1; h <= 12; h++)
      v += (Math.pow(bright, (h - 1) / 6) / h) * Math.sin(2 * Math.PI * 220 * h * t)
    bytes[i] = mulawEncode(0.45 * v)
  }
  return { sourceName: 'tone', rate: 16000, encoding: 'mulaw8', data: bytesToBase64(bytes) }
}

const SUB_VOICE: PatchDocument = {
  nodes: [
    obj('saw', 'logue/osc/saw', [
      { name: 'COARSE', value: '0', subpatchExpose: { outerName: 'Pitch' } }
    ]),
    obj('lp', 'logue/filter/lowpass-cheap', [
      { name: 'CUTOFF', value: '60', subpatchExpose: { outerName: 'Cutoff' } }
    ]),
    obj('out', LOGUE_SUBPATCH_OUTLET_TYPE)
  ],
  nets: [wire('saw', 'out', 'lp', 'in'), wire('lp', 'out', 'out', 'in')],
  settings: { subpatch: true },
  notes: ''
}
void LOGUE_SUBPATCH_INLET_TYPE

const granular = obj('g', 'logue/osc/granular', [
  knob('POSITION', '0', 'shape'),
  knob('SMEAR', '30', 'shape-2'),
  menu('SIZE', '33', 0),
  menu('DENSITY', '50', 1),
  menu('WINDOW', '50', 2),
  menu('SYNC', '100', 3)
])
granular.sample = toneSample()

const units: Unit[] = [
  {
    // Shape = SYNC (the slave's interval), Shift = SHAPE (saw/pulse/tri/sine); menu WIDTH.
    dir: 'lp-osc-sync',
    name: 'LP Sync',
    platforms: BOTH,
    doc: osc(
      [
        obj('s', 'logue/osc/sync', [
          knob('SYNC', '12', 'shape'),
          knob('SHAPE', '0', 'shape-2'),
          menu('WIDTH', '50', 0)
        ])
      ],
      [wire('s', 'out', 'out', 'in')]
    )
  },
  {
    // Shape = SHAPE, Shift = DRIVE; menu COARSE, GLIDE, RETRIG, TONE, SUB, ASYM.
    dir: 'lp-osc-bass',
    name: 'LP Bass',
    platforms: BOTH,
    doc: osc(
      [
        obj('b', 'logue/osc/bass-support', [
          knob('SHAPE', '67', 'shape'),
          knob('DRIVE', '40', 'shape-2'),
          menu('COARSE', '0', 0),
          menu('GLIDE', '0', 1),
          menu('RETRIG', '100', 2),
          menu('TONE', '40', 3),
          menu('SUB', '30', 4),
          menu('ASYM', '30', 5)
        ])
      ],
      [wire('b', 'out', 'out', 'in')]
    )
  },
  {
    // A saw through the vowel filter: Shape = VOWEL, Shift = CHARACTER; menu SHIFT, RESONANCE.
    dir: 'lp-osc-formant',
    name: 'LP Formant',
    platforms: BOTH,
    doc: osc(
      [
        obj('saw', 'logue/osc/saw'),
        obj('f', 'logue/filter/formant', [
          knob('VOWEL', '50', 'shape'),
          knob('CHARACTER', '0', 'shape-2'),
          menu('SHIFT', '0', 0),
          menu('RESONANCE', '60', 1)
        ])
      ],
      [wire('saw', 'out', 'f', 'in'), wire('f', 'out', 'out', 'in')]
    )
  },
  {
    // The six-stage envelope sweeping a lowpass on a saw. Shape = TIME, Shift = DEPTH;
    // menu MODE (one-shot/sustain/loop/cycle), HOLD, LOOP, CURVE.
    dir: 'lp-osc-mseg',
    name: 'LP MSEG',
    platforms: BOTH,
    doc: osc(
      [
        obj('saw', 'logue/osc/saw'),
        obj('env', 'logue/env/multistage', [
          knob('TIME', '50', 'shape'),
          knob('DEPTH', '100', 'shape-2'),
          menu('MODE', '1', 0),
          menu('HOLD', '1', 1),
          menu('LOOP', '0', 2),
          menu('CURVE', '0', 3)
        ]),
        obj('lp', 'logue/filter/svf', [
          { name: 'CUTOFF', value: '0' },
          { name: 'RESONANCE', value: '50' }
        ])
      ],
      [
        wire('saw', 'out', 'lp', 'in'),
        wire('env', 'env', 'lp', 'cutoff'),
        wire('lp', 'lp', 'out', 'in')
      ]
    )
  },
  {
    // A saw through util/delay with a sine LFO on its time: chorus/flanger. Shape = MIX,
    // Shift = FEEDBACK; menu TIME, LFO RATE.
    dir: 'lp-osc-chorus',
    name: 'LP Chorus',
    platforms: BOTH,
    doc: osc(
      [
        obj('saw', 'logue/osc/saw'),
        obj('lfo', 'logue/lfo/sine-lfo', [menu('RATE', '20', 1)]),
        obj('d', 'logue/util/delay', [
          knob('MIX', '50', 'shape'),
          knob('FEEDBACK', '0', 'shape-2'),
          menu('TIME', '30', 0)
        ])
      ],
      [
        wire('saw', 'out', 'd', 'in'),
        wire('lfo', 'out', 'd', 'time'),
        wire('d', 'out', 'out', 'in')
      ]
    )
  },
  {
    // Random steps quantized to a scale play the saw; every new note retriggers an AD envelope
    // on a VCA. Shape = step RATE; menu SCALE, ROOT.
    dir: 'lp-osc-quantize',
    name: 'LP Quantize',
    platforms: BOTH,
    doc: osc(
      [
        obj('steps', 'logue/lfo/random-steps', [knob('RATE', '20', 'shape')]),
        obj('q', 'logue/util/quantize', [menu('SCALE', '1', 0), menu('ROOT', '0', 1)]),
        obj('saw', 'logue/osc/saw'),
        obj('env', 'logue/env/ad', [
          { name: 'ATTACK', value: '0' },
          { name: 'DECAY', value: '30' }
        ]),
        obj('vca', 'logue/gain/vca')
      ],
      [
        wire('steps', 'out', 'q', 'in'),
        wire('q', 'pitch', 'saw', 'pitch'),
        wire('q', 'trig', 'env', 'trig'),
        wire('saw', 'out', 'vca', 'in'),
        wire('env', 'out', 'vca', 'gain'),
        wire('vca', 'out', 'out', 'in')
      ]
    )
  },
  {
    // fast-square clocks a sample-and-hold of a triangle LFO, which steps the saw's pitch.
    // Shape = clock RATE, Shift = WIDTH; menu TRACK (clock at the played note), LFO RATE.
    dir: 'lp-osc-clock-sh',
    name: 'LP Clock S&H',
    platforms: BOTH,
    doc: osc(
      [
        obj('clk', 'logue/lfo/fast-square', [
          knob('RATE', '30', 'shape'),
          knob('WIDTH', '50', 'shape-2'),
          menu('TRACK', '0', 0)
        ]),
        obj('tri', 'logue/lfo/triangle-lfo', [menu('RATE', '15', 1)]),
        obj('sh', 'logue/util/sample-hold'),
        obj('saw', 'logue/osc/saw')
      ],
      [
        wire('tri', 'out', 'sh', 'in'),
        wire('clk', 'out', 'sh', 'trig'),
        wire('sh', 'out', 'saw', 'pitch'),
        wire('saw', 'out', 'out', 'in')
      ]
    )
  },
  {
    // The 6-frame additive oscillator: Shape = TIMBRE (morphs the frames).
    dir: 'lp-osc-additive',
    name: 'LP Additive',
    platforms: BOTH,
    doc: osc(
      [obj('a', 'logue/osc/additive', [knob('TIMBRE', '30', 'shape')])],
      [wire('a', 'out', 'out', 'in')]
    )
  },
  {
    // A pitch-tracked svf (svf_tan since 2026-09-30) on a saw: at high RESONANCE the peak should
    // sit on the played note. Shape = RESONANCE, Shift = COARSE (the peak's interval).
    dir: 'lp-osc-svf-track',
    name: 'LP SVF Track',
    platforms: BOTH,
    doc: osc(
      [
        obj('saw', 'logue/osc/saw'),
        obj('f', 'logue/filter/svf', [
          { name: 'TRACK', value: '100' },
          knob('RESONANCE', '90', 'shape'),
          knob('COARSE', '0', 'shape-2')
        ])
      ],
      [wire('saw', 'out', 'f', 'in'), wire('f', 'lp', 'out', 'in')]
    )
  },
  {
    // Two instances of a subpatch (saw -> lowpass, CUTOFF and COARSE promoted) a fifth apart.
    // Shape = both Cutoffs; menu the second voice's Pitch.
    dir: 'lp-osc-subpatch',
    name: 'LP Subpatch',
    platforms: BOTH,
    doc: osc(
      [
        obj('v1', 'sub/voice', [knob('Cutoff', '60', 'shape')]),
        obj('v2', 'sub/voice', [knob('Cutoff', '60', 'shape'), menu('Pitch', '7', 0)]),
        obj('m', 'logue/mix/mix2')
      ],
      [wire('v1', 'out', 'm', 'in1'), wire('v2', 'out', 'm', 'in2'), wire('m', 'out', 'out', 'in')]
    ),
    subpatches: new Map([['sub/voice', SUB_VOICE]])
  },
  {
    // Only for how the device shows each param kind: INDEX (4-way select), SELECT (2-way),
    // TRACK (a checkbox), COARSE (+-24), FINE (+-50). Sound: INDEX picks saw/square/noise/
    // silence, SELECT swaps that for the square, TRACK makes the lowpass follow the note. Kept
    // cheap (xd CPU), since it's about the display.
    dir: 'lp-osc-params',
    name: 'LP Params',
    platforms: BOTH,
    doc: osc(
      [
        obj('saw', 'logue/osc/saw', [menu('COARSE', '0', 3), menu('FINE', '0', 4)]),
        obj('sq', 'logue/osc/square'),
        obj('noise', 'logue/osc/noise'),
        obj('m4', 'logue/mux/mux4', [menu('INDEX', '0', 0)]),
        obj('m2', 'logue/mux/mux2', [menu('SELECT', '0', 1)]),
        obj('f', 'logue/filter/svf', [{ name: 'RESONANCE', value: '40' }, menu('TRACK', '0', 2)])
      ],
      [
        wire('saw', 'out', 'm4', 'i1'),
        wire('sq', 'out', 'm4', 'i2'),
        wire('noise', 'out', 'm4', 'i3'),
        wire('m4', 'out', 'm2', 'i1'),
        wire('sq', 'out', 'm2', 'i2'),
        wire('m2', 'out', 'f', 'in'),
        wire('f', 'lp', 'out', 'in')
      ]
    )
  },
  {
    // Granular on NTS-1 mkII (confirmed on the xd): a baked 1 s tone that brightens along its
    // length. Shape = POSITION, Alt = SMEAR; menu SIZE, DENSITY, WINDOW, SYNC.
    dir: 'lp-osc-granular',
    name: 'LP Granular',
    platforms: ['nts1mkii'],
    doc: osc([granular], [wire('g', 'out', 'out', 'in')])
  },
  {
    // Does sense/velocity read the NTS-1 mkII's key velocity? Into the saw's pitch (0..+24 st),
    // since the device already scales the level by velocity itself (user, 2026-09-30).
    dir: 'lp-osc-velocity',
    name: 'LP Velocity',
    platforms: ['nts1mkii'],
    doc: osc(
      [obj('saw', 'logue/osc/saw'), obj('vel', 'logue/sense/velocity')],
      [wire('vel', 'unipolar', 'saw', 'pitch'), wire('saw', 'out', 'out', 'in')]
    )
  }
  // The xd filter-knob unit is gone: those knobs never reach an oscillator (unitKinds.ts), so a
  // binding to them no longer builds.
]

function stage(unit: Unit, platform: LoguePlatform): string {
  const root = join(platformRoot, platform === 'nts1mkii' ? 'nts-1_mkii' : 'minilogue-xd')
  const dir = join(root, unit.dir)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const doc: PatchDocument = {
    ...unit.doc,
    settings: { ...unit.doc.settings, unitName: unit.name }
  }
  if (platform === 'minilogue-xd') {
    const { files } = generateMinilogueXdProject(doc, unit.name, unit.subpatches)
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
    return dir
  }
  const project = generateNts1MkiiProject(doc, unit.name, unit.subpatches)
  for (const [name, text] of Object.entries(project.files)) writeFileSync(join(dir, name), text)
  writeFileSync(join(dir, 'config.mk'), nts1mkiiConfigMk(project))
  copyFileSync(join(root, 'dummy-osc', 'Makefile'), join(dir, 'Makefile'))
  copyFileSync(join(root, 'dummy-osc', 'wasm.cc'), join(dir, 'wasm.cc'))
  return dir
}

function builtBytes(dir: string, platform: LoguePlatform): number {
  const elf = join(dir, 'build', 'osc.elf')
  if (platform === 'nts1mkii') {
    const row = execFileSync(join(gccBin, 'arm-none-eabi-size'), [elf]).toString().split('\n')[1]
    const [text, data, bss] = row.trim().split(/\s+/).map(Number)
    return text + data + bss
  }
  return execFileSync(join(gccBin, 'arm-none-eabi-size'), ['-A', elf])
    .toString()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([name, size]) => name?.startsWith('.') && /^\d+$/.test(size ?? ''))
    .filter(([name]) => !/^\.(debug|comment|ARM\.attributes)/.test(name))
    .reduce((sum, [, size]) => sum + Number(size), 0)
}

for (const unit of units) {
  for (const platform of unit.platforms) {
    const dir = stage(unit, platform)
    const label = `${platform === 'nts1mkii' ? 'nts1' : 'xd  '} ${unit.dir.padEnd(24)}`
    try {
      execFileSync('make', ['-j8'], {
        cwd: dir,
        env: { ...process.env, GCC_BIN_PATH: gccBin },
        stdio: 'pipe'
      })
      execFileSync('make', ['install'], {
        cwd: dir,
        env: { ...process.env, GCC_BIN_PATH: gccBin },
        stdio: 'pipe'
      })
    } catch (e) {
      const out = [(e as { stdout?: Buffer }).stdout, (e as { stderr?: Buffer }).stderr]
        .map((b) => b?.toString() ?? '')
        .join('\n')
      console.log(
        `FAIL ${label} ${out
          .split('\n')
          .filter((l) => /error/i.test(l))
          .slice(0, 2)
          .join(' | ')}`
      )
      continue
    }
    const ram = estimateOscStateCost(unit.doc, platform, unit.subpatches)
    const cpu = estimateOscCpuCost(unit.doc, unit.subpatches, platform)
    const ramText =
      ram.status === 'ok'
        ? `est ${ram.estimate.totalBytes}/${ram.estimate.budgetBytes}`
        : ram.reason
    const cpuText =
      cpu.status === 'ok'
        ? `cpu ${Math.round(cpu.estimate.cyclesPerVoice)}${cpu.estimate.maxCyclesPerVoice !== cpu.estimate.cyclesPerVoice ? `..${Math.round(cpu.estimate.maxCyclesPerVoice)}` : ''} (${cpuZone(cpu.estimate.maxCyclesPerVoice, platform).zone})`
        : cpu.reason
    console.log(
      `ok   ${label} built ${String(builtBytes(dir, platform)).padStart(6)} B  ${ramText}  ${cpuText}`
    )
  }
}

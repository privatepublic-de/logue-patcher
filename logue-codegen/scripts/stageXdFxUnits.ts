/**
 * Phase 7 of "effect patches" (2026-09-30): stages generated minilogue xd effect units
 * (`minilogue-xd/generateFxUnit.ts`) into platform/minilogue-xd/lp-xdfx-* for a hardware pass,
 * or sweeps every primitive through a real ARM build of an xd effect unit.
 *
 * The xd's effect link is static against main_api.syms alone, so an `osc_*` or libm symbol the
 * device doesn't have fails the link itself -- no import scan needed. What the sweep checks:
 * - each module's pass-through, whose size is unitKinds.ts' fixedCodeBytes;
 * - every insertable primitive an effect may use, one delfx unit each (audio-in mono into its
 *   first inlet, its first outlet to L): does it link, its SRAM use (text + data + bss: code,
 *   tables and state share the 6 KB modfx / 12 KB delfx/revfx region), and the call shape below
 *   `_hook_process` -- only leaf calls there (CLAUDE.md: two real xd oscillator hangs had a
 *   deeper `-Os` call chain; the effects MCU is a different chip, the compiler isn't).
 *
 * Usage: npx tsx logue-codegen/scripts/stageXdFxUnits.ts [--sweep]
 *   then, for the hardware units, in each staged folder:
 *   GCC_BIN_PATH=/opt/homebrew/bin make && GCC_BIN_PATH=/opt/homebrew/bin make install
 */
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { generateMinilogueXdProject } from '../src/minilogue-xd/projectFiles'
import { parsePatchFile } from '../../src/shared/json/patchCodec'
import { findUnitKind } from '../src/unitKinds'
import { findLoguePrimitive, recognizedLoguePrimitiveIds } from '../src/primitives'
import { LOGUE_AUDIO_IN_TYPE, LOGUE_AUDIO_OUT_TYPE } from '../src/oscInstances'
import type { LogueModule, Net, ObjNode, PatchDocument } from '../../src/shared/domain/patch'
import type { LogueKnob, ParamValue } from '../../src/shared/domain/paramValueTypes'
import { bufferPartners } from './bufferPartners'
import { exampleSubpatches, examplesDir } from './exampleSubpatches'

const root = join(
  process.env.LOGUE_SDK ?? join(homedir(), 'Documents/GitHub/logue-sdk'),
  'platform',
  'minilogue-xd'
)
const gccBin = process.env.GCC_BIN_PATH ?? '/opt/homebrew/bin'

function obj(name: string, type: string, params: ParamValue[] = []): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params }
}
function wire(from: string, outlet: string, to: string, inlet: string): Net {
  return { sources: [{ obj: from, outlet }], dests: [{ obj: to, inlet }] }
}
function doc(module: LogueModule, nodes: ObjNode[], nets: Net[]): PatchDocument {
  return { nodes, nets, settings: { logueTarget: { module } }, notes: '' }
}
const IN = obj('in', LOGUE_AUDIO_IN_TYPE)
const OUT = obj('out', LOGUE_AUDIO_OUT_TYPE)
const pass = (module: LogueModule): PatchDocument =>
  doc(module, [IN, OUT], [wire('in', 'l', 'out', 'l'), wire('in', 'r', 'out', 'r')])
/** A knob binding on the xd only: an NTS-1 mkII-only binding is what the xd would ignore. */
const onKnob = (knob: LogueKnob): Pick<ParamValue, 'logueKnob'> => ({
  logueKnob: { 'minilogue-xd': knob }
})

function stage(
  dirName: string,
  unitName: string,
  d: PatchDocument,
  subpatches = new Map<string, PatchDocument>()
): string {
  const dir = join(root, dirName)
  rmSync(dir, { recursive: true, force: true })
  const { files } = generateMinilogueXdProject(d, unitName, subpatches)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

interface Inspection {
  sramBytes: number
  /** Calls below `_hook_process` that themselves call something: the shape to avoid. */
  deepCalls: string[]
}

function buildAndInspect(dir: string): Inspection {
  execFileSync('make', ['-j8'], {
    cwd: dir,
    env: { ...process.env, GCC_BIN_PATH: gccBin },
    stdio: 'pipe'
  })
  const elf = join(dir, 'build', 'fx.elf')
  // Per section: `size`'s bss column would also count the NOLOAD .sdram block.
  const sramBytes = execFileSync(join(gccBin, 'arm-none-eabi-size'), ['-A', elf])
    .toString()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      ([name, size]) => name?.startsWith('.') && name !== '.sdram' && /^\d+$/.test(size ?? '')
    )
    .filter(([name]) => !/^\.(ARM\.attributes|comment|debug)/.test(name))
    .reduce((sum, [, size]) => sum + Number(size), 0)
  const disasm = execFileSync(join(gccBin, 'arm-none-eabi-objdump'), ['-d', elf]).toString()
  const calls = new Map<string, string[]>()
  let current = ''
  for (const line of disasm.split('\n')) {
    const fn = /^[0-9a-f]+ <([^>]+)>:$/.exec(line)
    if (fn) {
      current = fn[1]
      calls.set(current, [])
      continue
    }
    const bl = /\tbl\s+[0-9a-f]+ <([^>+]+)/.exec(line)
    if (bl && current) calls.get(current)!.push(bl[1])
  }
  // Fx::process is the loop; GCC may or may not inline it into the hook.
  const roots = new Set(
    [...calls.keys()].filter((fn) => fn === '_hook_process' || fn.startsWith('_ZN2Fx7process'))
  )
  const direct = [...roots].flatMap((fn) => calls.get(fn) ?? []).filter((fn) => !roots.has(fn))
  const deepCalls = [...new Set(direct)].filter((callee) => (calls.get(callee) ?? []).length > 0)
  return { sramBytes, deepCalls }
}

function linkError(e: unknown): string {
  const out = [(e as { stdout?: Buffer }).stdout, (e as { stderr?: Buffer }).stderr]
    .map((b) => b?.toString() ?? '')
    .join('\n')
  const overflow = /region `SRAM' overflowed by (\d+) bytes/.exec(out)
  if (overflow) return `SRAM overflowed by ${overflow[1]} B`
  return out
    .split('\n')
    .filter((l) => /error|undefined reference/i.test(l))
    .slice(0, 3)
    .join(' | ')
}

if (process.argv.includes('--sweep')) {
  const failures: string[] = []
  for (const module of ['modfx', 'delfx', 'revfx'] as const) {
    const kind = findUnitKind('minilogue-xd', module)!
    const { sramBytes } = buildAndInspect(stage('lp-xdfx-sweep', 'sweep', pass(module)))
    const expected = (kind.fixedCodeBytes ?? 0) + kind.fixedBaselineBytes
    const ok = sramBytes === expected
    console.log(
      `${ok ? 'ok  ' : 'BAD '} ${module} pass-through: ${sramBytes} B of ${kind.ramBytes} (unitKinds.ts: ${expected})`
    )
    if (!ok) failures.push(`${module} fixedCodeBytes`)
  }
  const modfxBytes = findUnitKind('minilogue-xd', 'modfx')!.ramBytes
  const delfxBytes = findUnitKind('minilogue-xd', 'delfx')!.ramBytes
  for (const id of recognizedLoguePrimitiveIds()) {
    const p = findLoguePrimitive(id)!
    if (p.supersededBy || (p.modules && !p.modules.includes('delfx'))) continue
    if (p.platforms && !p.platforms.includes('minilogue-xd')) continue
    if (id === 'logue/osc/granular') continue // needs an imported sample (instanceProblem)
    const inlet = p.inlets?.[0]
    const partners = bufferPartners(p, 'p', { obj: 'in', outlet: 'mono' })
    const from = inlet && partners.sourceFor(inlet)
    const d = doc(
      'delfx',
      [IN, obj('p', id), ...partners.nodes, OUT],
      [
        ...partners.nets,
        ...(inlet && from ? [wire(from.obj, from.outlet, 'p', inlet.name)] : []),
        wire(partners.output.obj, partners.output.outlet, 'out', 'l')
      ]
    )
    try {
      const { sramBytes, deepCalls } = buildAndInspect(stage('lp-xdfx-sweep', 'sweep', d))
      const fits = sramBytes > modfxBytes ? 'too big for modfx' : ''
      const tag = deepCalls.length ? 'DEEP' : fits ? 'big ' : 'ok  '
      console.log(
        `${tag} ${id.padEnd(34)} ${String(sramBytes).padStart(6)} B${fits ? `  ${fits}` : ''}${deepCalls.length ? `  calls below process: ${deepCalls.join(', ')}` : ''}`
      )
      if (deepCalls.length) failures.push(id)
    } catch (e) {
      const message = linkError(e)
      // A size limit, not a codegen fault (additive's 12 KB of wavetables): reported, not failed.
      const tooBig = message.startsWith('SRAM overflowed')
      console.log(
        `${tooBig ? 'big ' : 'FAIL'} ${id.padEnd(34)} ${message} (a delfx has ${delfxBytes} B)`
      )
      if (!tooBig) failures.push(id)
    }
  }
  rmSync(join(root, 'lp-xdfx-sweep'), { recursive: true, force: true })
  console.log(
    failures.length
      ? `\n${failures.length} failed: ${failures.join(', ')}`
      : '\nall primitives link, with only leaf calls below process'
  )
  process.exit(failures.length ? 1 : 0)
}

function echo(name: string, params: ParamValue[]): ObjNode {
  return obj(name, 'logue/util/long-delay', params)
}

const staged = [
  stage('lp-xdfx-pass', 'LP FX Pass', pass('delfx')),
  // Shift+Depth fades dry -> lowpass; Time is the cutoff.
  stage(
    'lp-xdfx-lpmix',
    'LP FX LP Mix',
    doc(
      'delfx',
      [
        IN,
        obj('lp', 'logue/filter/lowpass-cheap', [
          { name: 'CUTOFF', value: '100', ...onKnob('time') }
        ]),
        obj('x', 'logue/mix/crossfader', [{ name: 'FADE', value: '50', ...onKnob('mix') }]),
        OUT
      ],
      [
        wire('in', 'mono', 'x', 'in1'),
        wire('in', 'mono', 'lp', 'in'),
        wire('lp', 'out', 'x', 'in2'),
        wire('x', 'out', 'out', 'l')
      ]
    )
  ),
  // A mod-slot ring modulator: Time = the sine's COARSE around middle C, Depth = dry -> ring.
  stage(
    'lp-xdfx-ring',
    'LP FX Ring',
    doc(
      'modfx',
      [
        IN,
        obj('s', 'logue/osc/sine', [{ name: 'COARSE', value: '0', ...onKnob('time') }]),
        obj('m', 'logue/math/multiply'),
        obj('x', 'logue/mix/crossfader', [{ name: 'FADE', value: '0', ...onKnob('depth') }]),
        OUT
      ],
      [
        wire('in', 'mono', 'm', 'in1'),
        wire('s', 'out', 'm', 'in2'),
        wire('in', 'mono', 'x', 'in1'),
        wire('m', 'out', 'x', 'in2'),
        wire('x', 'out', 'out', 'l')
      ]
    )
  ),
  // pan-mix2 (2026-10-04): input L into in1, R into in2, GAIN 100, PAN1 on Time from hard left,
  // PAN2 on Depth from hard right -- a plain pass-through at the defaults.
  stage(
    'lp-xdfx-panmix',
    'LP FX Pan Mix',
    doc(
      'modfx',
      [
        IN,
        obj('pm', 'logue/mix/pan-mix2', [
          { name: 'GAIN1', value: '100' },
          { name: 'PAN1', value: '-100', ...onKnob('time') },
          { name: 'GAIN2', value: '100' },
          { name: 'PAN2', value: '100', ...onKnob('depth') }
        ]),
        OUT
      ],
      [
        wire('in', 'l', 'pm', 'in1'),
        wire('in', 'r', 'pm', 'in2'),
        wire('pm', 'l', 'out', 'l'),
        wire('pm', 'r', 'out', 'r')
      ]
    )
  ),
  // A stereo echo pair of 2.7 s lines (2 x 512 KB): Time moves the left line only, the right
  // stays at 0.73 s, so a mono input comes out audibly stereo (with both on Time, the xd's mono
  // voice gave identical sides: user, 2026-09-30). Depth = feedback, Shift+Depth = mix.
  stage(
    'lp-xdfx-echo',
    'LP FX Echo',
    doc(
      'delfx',
      [
        IN,
        ...(['l', 'r'] as const).map((side) =>
          echo(`echo_${side}`, [
            { name: 'RANGE', value: '2' },
            side === 'l'
              ? { name: 'TIME', value: '20', ...onKnob('time') }
              : { name: 'TIME', value: '27' },
            { name: 'FEEDBACK', value: '40', ...onKnob('depth') },
            { name: 'MIX', value: '40', ...onKnob('mix') }
          ])
        ),
        OUT
      ],
      [
        wire('in', 'l', 'echo_l', 'in'),
        wire('in', 'r', 'echo_r', 'in'),
        wire('echo_l', 'out', 'out', 'l'),
        wire('echo_r', 'out', 'out', 'r')
      ]
    )
  ),
  // The same pair synced to the device tempo: Time picks the division.
  stage(
    'lp-xdfx-sync',
    'LP FX Sync',
    doc(
      'delfx',
      [
        IN,
        ...(['l', 'r'] as const).map((side) =>
          echo(`echo_${side}`, [
            { name: 'RANGE', value: '2' },
            { name: 'SYNC', value: '100' },
            { name: 'DIVISION', value: side === 'l' ? '2' : '3', ...onKnob('time') },
            { name: 'FEEDBACK', value: '40', ...onKnob('depth') },
            { name: 'MIX', value: '40', ...onKnob('mix') }
          ])
        ),
        OUT
      ],
      [
        wire('in', 'l', 'echo_l', 'in'),
        wire('in', 'r', 'echo_r', 'in'),
        wire('echo_l', 'out', 'out', 'l'),
        wire('echo_r', 'out', 'out', 'r')
      ]
    )
  ),
  // Near a reverb unit's whole 2432 KB of SDRAM: two 5.5 s lines (1 MB each) and one 1.4 s
  // (256 KB), 2304 KB. Time moves the left line, Shift+Depth mixes the 1.4 s echo in after it.
  stage(
    'lp-xdfx-full',
    'LP FX Full',
    doc(
      'revfx',
      [
        IN,
        echo('a', [
          { name: 'RANGE', value: '3' },
          { name: 'TIME', value: '60', ...onKnob('time') }
        ]),
        echo('b', [
          { name: 'RANGE', value: '3' },
          { name: 'TIME', value: '80' }
        ]),
        echo('c', [
          { name: 'RANGE', value: '1' },
          { name: 'MIX', value: '50', ...onKnob('mix') }
        ]),
        OUT
      ],
      [
        wire('in', 'l', 'a', 'in'),
        wire('in', 'r', 'b', 'in'),
        wire('a', 'out', 'c', 'in'),
        wire('c', 'out', 'out', 'l'),
        wire('b', 'out', 'out', 'r')
      ]
    )
  )
]

for (const [file, dirName] of [
  ['stereo-reverb.loguepatch', 'lp-xdfx-reverb'],
  ['auto-wah.loguepatch', 'lp-xdfx-autowah'],
  ['tempo-swell.loguepatch', 'lp-xdfx-swell'],
  ['freq-shifter.loguepatch', 'lp-xdfx-freqshift'],
  ['reverse-wash.loguepatch', 'lp-xdfx-revwash'],
  ['reverse-wash-xd.loguepatch', 'lp-xdfx-revwash-xd'],
  ['grain-mill-xd-free.loguepatch', 'lp-xdfx-grain-free'],
  ['grain-mill-xd-sync.loguepatch', 'lp-xdfx-grain-sync'],
  ['grain-mill-xd-rnd.loguepatch', 'lp-xdfx-grain-rnd'],
  ['grain-mill-xd-rndsync.loguepatch', 'lp-xdfx-grain-rndsync']
] as const) {
  const d = parsePatchFile(readFileSync(join(examplesDir, file), 'utf-8'))
  staged.push(stage(dirName, d.settings.unitName ?? dirName, d, exampleSubpatches()))
}
for (const dir of staged) console.log(dir)

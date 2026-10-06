/**
 * Phase 3 of "effect patches" (2026-09-30): stages generated NTS-1 mkII effect units (not
 * hand-written, unlike stageFxSpike.ts) for a hardware pass, or sweeps every primitive through
 * a real ARM build of an effect unit.
 *
 * Hardware units (in platform/nts-1_mkii/lp-fx-*):
 * - pass (delfx): audio-in L/R -> audio-out L/R; must be bit-transparent.
 * - lpmix (delfx): the new-document shape -- dry left into a crossfader, a lowpass on the left
 *   into its other side; TIME = the lowpass CUTOFF, MIX (DEL + B) = the crossfader. Mono out.
 * - ring (modfx): a sine ring modulator, TIME = the sine's COARSE (+-24 st around middle C,
 *   the fixed note an effect gets), DEPTH = the crossfader from dry to ring.
 * - haas (revfx): right channel through util/delay (TIME = DEPTH knob, 0.1..20 ms), left dry.
 * - panmix (modfx): L/R through logue/mix/pan-mix2; TIME pans the left input, DEPTH the right.
 * - echo / sync (delfx, phase 4): a stereo pair of 2.7 s logue/util/long-delay lines in SDRAM;
 *   TIME = time (or, synced, the DIVISION), DEPTH = FEEDBACK, MIX = MIX.
 * - slap (modfx): a 0.34 s pair (2 x 64 KB of the modfx's 256 KB), a slow sine on `time`.
 * - full (modfx): one 1.4 s line, exactly the modfx's 256 KB -- does the allocator give it all?
 * - buf1 / buf4 (delfx, grain-mill phase 1): a util/buffer read by 1 or 4 buffer-taps, freeze
 *   on DEPTH's last 5 %, with the CPU probe (see bufferTest).
 * - grain (delfx, grain-mill phase 2): one util/grain retriggered by a square LFO (GRAIN_TEST).
 * - grainmill / grainmill-cpu (delfx, phase 5): the grain-mill example; the -cpu build trades
 *   its MODE row for the CPU probe.
 *
 * `--sweep`: every insertable primitive an effect may use, one delfx unit each (audio-in mono
 * into its first inlet, its first outlet to L), built and checked with readelf: a unit may only
 * import fx_api symbols from the device (an undefined `osc_*` links fine as a shared object and
 * only fails when the device loads it). Also prints each unit's loaded size (text + data + bss)
 * against the README's Max RAM Load Size: 16 KB for modfx, 24 KB for delfx/revfx; and first
 * checks the pass-through still loads exactly what unitKinds.ts' fixedCodeBytes measured.
 *
 * Usage: npx tsx logue-codegen/scripts/stageFxUnits.ts [--sweep]
 *   then, for the hardware units, in each staged folder:
 *   GCC_BIN_PATH=/opt/homebrew/bin make && GCC_BIN_PATH=/opt/homebrew/bin make install
 */
import { execFileSync } from 'child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { generateFxUnit, type LogueFxUnitSource } from '../src/nts1mkii/generateFxUnit'
import { parsePatchFile } from '../../src/shared/json/patchCodec'
import { findUnitKind } from '../src/unitKinds'
import { findLoguePrimitive, recognizedLoguePrimitiveIds } from '../src/primitives'
import type { ObjNode, PatchDocument } from '../../src/shared/domain/patch'
import type { ParamValue } from '../../src/shared/domain/paramValueTypes'
import { bufferPartners } from './bufferPartners'
import { exampleSubpatches, examplesDir } from './exampleSubpatches'
import { bufferTest, doc, GRAIN_TEST, IN, obj, onKnob, OUT, wire } from './nts1FxProbeUnits'

const root = join(
  process.env.LOGUE_SDK ?? join(homedir(), 'Documents/GitHub/logue-sdk'),
  'platform',
  'nts-1_mkii'
)
const gccBin = process.env.GCC_BIN_PATH ?? '/opt/homebrew/bin'

const PASS_DOC = doc('delfx', [IN, OUT], [wire('in', 'l', 'out', 'l'), wire('in', 'r', 'out', 'r')])

/**
 * Adds a "CPU" menu param after the patch's own ones whose value text is a reading of the
 * Cortex-M7 cycle counter (as stageNts1CpuProbe.ts / the phase 0 spike): 0 off, 1 the effect's
 * render cycles per sample (turning the counter on), 2 all cycles per sample between render
 * calls (the budget), 3 the effect's share in percent. Nudge it to refresh the text. For
 * measuring on the device only -- never part of an app build.
 */
function withCpuProbe(fx: LogueFxUnitSource): LogueFxUnitSource {
  const n = Number(/\.num_params = (\d+),/.exec(fx.headerC)![1])
  const rows = fx.headerC.split('\n')
  const firstRow = rows.findIndex(
    (line) => line.trim().startsWith('{') && line.includes('k_unit_param_type')
  )
  const row = rows[firstRow + n]
  if (!row.includes('k_unit_param_type_none, 0, 0, 0, {""}'))
    throw new Error(`no free row ${n} for the CPU probe`)
  rows[firstRow + n] = row.replace(
    '{0, 0, 0, 0, k_unit_param_type_none, 0, 0, 0, {""}}',
    '{0, 3, 0, 0, k_unit_param_type_strings, 0, 0, 0, {"CPU"}}'
  )
  const headerC = rows.join('\n').replace(`.num_params = ${n},`, `.num_params = ${n + 1},`)
  const probe = `
// CPU probe (stageFxUnits.ts): the Cortex-M7 cycle counter, read around each render call.
#define DEMCR (*(volatile uint32_t *)0xE000EDFCu)
#define DWT_CTRL (*(volatile uint32_t *)0xE0001000u)
#define DWT_CYCCNT (*(volatile uint32_t *)0xE0001004u)
#define DWT_LAR (*(volatile uint32_t *)0xE0001FB0u)
static int32_t s_probe = 0;
static uint32_t s_probe_on = 0, s_prev_t0 = 0, s_have_prev = 0, s_fx = 0, s_tot = 0;
static char s_probe_text[16];
static const char *probe_reading(const char *label, uint32_t v)
{
  int i = 0;
  while (label[i]) { s_probe_text[i] = label[i]; ++i; }
  char tmp[12];
  int k = 0;
  do { tmp[k++] = (char)('0' + v % 10u); v /= 10u; } while (v && k < 11);
  while (k) s_probe_text[i++] = tmp[--k];
  s_probe_text[i] = 0;
  return s_probe_text;
}
`
  const unitCc = fx.unitCc
    .replace(
      'static int32_t cached_values[UNIT_MAX_PARAM_COUNT];',
      `static int32_t cached_values[UNIT_MAX_PARAM_COUNT];\n${probe}`
    )
    .replace(
      '  s_fx_instance.process(in, out, frames);',
      `  if (s_probe >= 1 && !s_probe_on) { DEMCR |= (1u << 24); DWT_LAR = 0xC5ACCE55u; DWT_CTRL |= 1u; s_probe_on = 1; }
  const uint32_t t0 = s_probe_on ? DWT_CYCCNT : 0u;
  if (s_probe_on && s_have_prev && frames) {
    const uint32_t tot = ((t0 - s_prev_t0) << 4) / frames;
    s_tot = s_tot ? s_tot + ((int32_t)(tot - s_tot) >> 4) : tot;
  }
  s_prev_t0 = t0;
  s_have_prev = s_probe_on;
  s_fx_instance.process(in, out, frames);
  if (s_probe_on && frames) {
    const uint32_t fxc = ((DWT_CYCCNT - t0) << 4) / frames;
    s_fx = s_fx ? s_fx + ((int32_t)(fxc - s_fx) >> 4) : fxc;
  }`
    )
    .replace(
      '  cached_values[id] = value;\n',
      `  cached_values[id] = value;\n  if (id == ${n}) s_probe = value;\n`
    )
    .replace(
      '__unit_callback const char *unit_get_param_str_value(',
      'static const char *generated_param_str_value('
    )
  const probeStr = `
__unit_callback const char *unit_get_param_str_value(uint8_t id, int32_t value)
{
  if (id != ${n}) return generated_param_str_value(id, value);
  if (value <= 0) return "off";
  if (!s_tot) return "wait";
  if (value == 1) return probe_reading("fx ", s_fx >> 4);
  if (value == 2) return probe_reading("tot ", s_tot >> 4);
  return probe_reading("ld% ", (s_fx * 100u) / s_tot);
}
`
  return { ...fx, headerC, unitCc: unitCc + probeStr }
}

function stage(
  dirName: string,
  unitName: string,
  d: PatchDocument,
  probe = false,
  subpatches = new Map<string, PatchDocument>()
): string {
  const module = d.settings.logueTarget!.module
  const dir = join(root, dirName)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const generated = generateFxUnit(d, { name: unitName }, subpatches)
  const fx = probe ? withCpuProbe(generated) : generated
  writeFileSync(join(dir, 'header.c'), fx.headerC)
  writeFileSync(join(dir, 'fx.h'), fx.fxH)
  writeFileSync(join(dir, 'unit.cc'), fx.unitCc)
  writeFileSync(
    join(dir, 'config.mk'),
    `PROJECT := fx\nPROJECT_TYPE := ${module}\nUCSRC = header.c\nUCXXSRC = unit.cc\nUASMSRC =\nUASMXSRC =\nUINCDIR  =\nULIBDIR =\nULIBS  = -lm\nUDEFS =\n`
  )
  copyFileSync(join(root, `dummy-${module}`, 'Makefile'), join(dir, 'Makefile'))
  copyFileSync(join(root, `dummy-${module}`, 'wasm.cc'), join(dir, 'wasm.cc'))
  return dir
}

/** Builds the staged unit; returns the undefined dynamic symbols it needs from the device and
 *  its loaded size (text + data + bss, what the README's "Max RAM Load Size" limits). */
function buildAndInspect(dir: string): { imports: string[]; loadedBytes: number } {
  execFileSync('make', ['-j8'], {
    cwd: dir,
    env: { ...process.env, GCC_BIN_PATH: gccBin },
    stdio: 'pipe'
  })
  const elf = join(dir, 'build', 'fx.elf')
  const imports = execFileSync(join(gccBin, 'arm-none-eabi-readelf'), ['--dyn-syms', '-W', elf])
    .toString()
    .split('\n')
    .filter((line) => / UND /.test(line))
    .map((line) => line.trim().split(/\s+/)[7])
    .filter((name): name is string => !!name)
  const sizeRow = execFileSync(join(gccBin, 'arm-none-eabi-size'), [elf]).toString().split('\n')[1]
  const [text, data, bss] = sizeRow.trim().split(/\s+/).map(Number)
  return { imports, loadedBytes: text + data + bss }
}

// Symbols fx_api.h / the fx runtime provide (fx_api.h's externs and LUTs).
const FX_API_SYMBOL =
  /^(fx_|k_fx_api_|wt_sine_lut_f$|log_lut_f$|tanpi_lut_f$|sqrtm2log_lut_f$|pow2_lut_f$|cubicsat_lut_f$|schetzen_lut_f$|bitres_lut_f$)/

if (process.argv.includes('--sweep')) {
  const failures: string[] = []
  // The RAM estimate's code baseline (unitKinds.ts' fixedCodeBytes) is a measurement of this
  // exact unit; say so when the generator has drifted from it.
  {
    const kind = findUnitKind('nts1mkii', 'delfx')!
    const { loadedBytes } = buildAndInspect(stage('lp-fx-sweep', 'sweep', PASS_DOC))
    const expected = (kind.fixedCodeBytes ?? 0) + kind.fixedBaselineBytes
    console.log(
      loadedBytes === expected
        ? `ok   pass-through loads ${loadedBytes} B = fixedCodeBytes + fixedBaselineBytes`
        : `BAD  pass-through loads ${loadedBytes} B, but unitKinds.ts says ${expected} -- re-measure fixedCodeBytes`
    )
    if (loadedBytes !== expected) failures.push('fixedCodeBytes')
  }
  for (const id of recognizedLoguePrimitiveIds()) {
    const p = findLoguePrimitive(id)!
    if (p.supersededBy || (p.modules && !p.modules.includes('delfx'))) continue
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
    const dir = stage('lp-fx-sweep', 'sweep', d)
    try {
      const { imports, loadedBytes } = buildAndInspect(dir)
      const foreign = imports.filter((sym) => !FX_API_SYMBOL.test(sym))
      // The same code in a modfx (16 KB) or a delfx/revfx (24 KB) unit: only the header differs.
      const fits =
        loadedBytes > 24 * 1024
          ? 'fits no slot'
          : loadedBytes > 16 * 1024
            ? 'too big for modfx'
            : ''
      const tag = foreign.length || loadedBytes > 24 * 1024 ? 'BAD ' : fits ? 'big ' : 'ok  '
      console.log(
        `${tag} ${id.padEnd(34)} ${String(loadedBytes).padStart(6)} B${fits ? `  ${fits}` : ''}${foreign.length ? `  imports ${foreign.join(', ')}` : ''}`
      )
      if (foreign.length || loadedBytes > 24 * 1024) failures.push(id)
    } catch (e) {
      const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? String(e)
      console.log(
        `FAIL ${id}: ${stderr
          .split('\n')
          .filter((l) => /error/i.test(l))
          .slice(0, 3)
          .join(' | ')}`
      )
      failures.push(id)
    }
  }
  rmSync(join(root, 'lp-fx-sweep'), { recursive: true, force: true })
  console.log(
    failures.length
      ? `\n${failures.length} failed: ${failures.join(', ')}`
      : '\nall primitives build and import only fx_api symbols'
  )
  process.exit(failures.length ? 1 : 0)
}

function echo(name: string, params: ParamValue[]): ObjNode {
  return obj(name, 'logue/util/long-delay', params)
}

const staged = [
  stage('lp-fx-pass', 'LP FX Pass', PASS_DOC),
  stage(
    'lp-fx-lpmix',
    'LP FX LP Mix',
    doc(
      'delfx',
      [
        IN,
        obj('lp', 'logue/filter/lowpass-cheap', [
          { name: 'CUTOFF', value: '100', logueKnob: { nts1mkii: 'time' } }
        ]),
        obj('x', 'logue/mix/crossfader', [
          { name: 'FADE', value: '50', logueKnob: { nts1mkii: 'mix' } }
        ]),
        OUT
      ],
      [
        wire('in', 'l', 'x', 'in1'),
        wire('in', 'l', 'lp', 'in'),
        wire('lp', 'out', 'x', 'in2'),
        wire('x', 'out', 'out', 'l')
      ]
    )
  ),
  stage(
    'lp-fx-ring',
    'LP FX Ring',
    doc(
      'modfx',
      [
        IN,
        obj('s', 'logue/osc/sine', [
          { name: 'COARSE', value: '0', logueKnob: { nts1mkii: 'time' } }
        ]),
        obj('m', 'logue/math/multiply'),
        obj('x', 'logue/mix/crossfader', [
          { name: 'FADE', value: '0', logueKnob: { nts1mkii: 'depth' } }
        ]),
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
  stage(
    'lp-fx-haas',
    'LP FX Haas',
    doc(
      'revfx',
      [
        IN,
        obj('d', 'logue/util/delay', [
          { name: 'TIME', value: '50', logueKnob: { nts1mkii: 'depth' } },
          { name: 'MIX', value: '100' }
        ]),
        OUT
      ],
      [wire('in', 'l', 'out', 'l'), wire('in', 'r', 'd', 'in'), wire('d', 'out', 'out', 'r')]
    )
  ),
  // pan-mix2 (2026-10-04): input L into in1, R into in2, GAIN 100, PAN1 on TIME from hard left,
  // PAN2 on DEPTH from hard right -- a plain pass-through at the defaults; TIME sweeps the left
  // input across, DEPTH the right one.
  stage(
    'lp-fx-panmix',
    'LP FX Pan Mix',
    doc(
      'modfx',
      [
        IN,
        obj('pm', 'logue/mix/pan-mix2', [
          { name: 'GAIN1', value: '100' },
          { name: 'PAN1', value: '-100', logueKnob: { nts1mkii: 'time' } },
          { name: 'GAIN2', value: '100' },
          { name: 'PAN2', value: '100', logueKnob: { nts1mkii: 'depth' } }
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
  )
]
staged.push(
  // Stereo 2.7 s echo: TIME/DEPTH(=FEEDBACK)/MIX on both delays.
  stage(
    'lp-fx-echo',
    'LP FX Echo',
    doc(
      'delfx',
      [
        IN,
        ...['dl', 'dr'].map((n) =>
          echo(n, [
            { name: 'RANGE', value: '2' },
            { name: 'TIME', value: '15', ...onKnob('time') },
            { name: 'FEEDBACK', value: '35', ...onKnob('depth') },
            { name: 'MIX', value: '50', ...onKnob('mix') }
          ])
        ),
        OUT
      ],
      [
        wire('in', 'l', 'dl', 'in'),
        wire('in', 'r', 'dr', 'in'),
        wire('dl', 'out', 'out', 'l'),
        wire('dr', 'out', 'out', 'r')
      ]
    )
  ),
  // Tempo-synced: TIME picks the DIVISION (10 zones), DEPTH = FEEDBACK, MIX = MIX.
  stage(
    'lp-fx-sync',
    'LP FX Sync',
    doc(
      'delfx',
      [
        IN,
        ...['dl', 'dr'].map((n) =>
          echo(n, [
            { name: 'RANGE', value: '2' },
            { name: 'SYNC', value: '100' },
            { name: 'DIVISION', value: '5', ...onKnob('time') },
            { name: 'FEEDBACK', value: '35', ...onKnob('depth') },
            { name: 'MIX', value: '50', ...onKnob('mix') }
          ])
        ),
        OUT
      ],
      [
        wire('in', 'l', 'dl', 'in'),
        wire('in', 'r', 'dr', 'in'),
        wire('dl', 'out', 'out', 'l'),
        wire('dr', 'out', 'out', 'r')
      ]
    )
  ),
  // Exactly a modfx's 256 KB of SDRAM (one 1.4 s line, mono): does the allocator give all of it?
  stage(
    'lp-fx-full',
    'LP FX Full',
    doc(
      'modfx',
      [
        IN,
        echo('d', [
          { name: 'RANGE', value: '1' },
          { name: 'TIME', value: '50', ...onKnob('time') },
          { name: 'FEEDBACK', value: '35', ...onKnob('depth') },
          { name: 'MIX', value: '50' }
        ]),
        OUT
      ],
      [wire('in', 'mono', 'd', 'in'), wire('d', 'out', 'out', 'l')]
    )
  ),
  // A 0.34 s slapback in the mod slot (2 x 64 KB), a slow sine wobbling its time (a wired
  // `time` inlet); TIME = TIME, DEPTH = FEEDBACK, MIX fixed at 40.
  stage(
    'lp-fx-slap',
    'LP FX Slap',
    doc(
      'modfx',
      [
        IN,
        obj('lfo', 'logue/lfo/sine-lfo', [{ name: 'RATE', value: '20' }]),
        obj('amt', 'logue/math/scale', [{ name: 'FACTOR', value: '2' }]),
        ...['dl', 'dr'].map((n) =>
          echo(n, [
            { name: 'RANGE', value: '0' },
            { name: 'TIME', value: '30', ...onKnob('time') },
            { name: 'FEEDBACK', value: '20', ...onKnob('depth') },
            { name: 'MIX', value: '40' }
          ])
        ),
        OUT
      ],
      [
        wire('lfo', 'out', 'amt', 'in'),
        wire('amt', 'out', 'dl', 'time'),
        wire('amt', 'out', 'dr', 'time'),
        wire('in', 'l', 'dl', 'in'),
        wire('in', 'r', 'dr', 'in'),
        wire('dl', 'out', 'out', 'l'),
        wire('dr', 'out', 'out', 'r')
      ]
    )
  )
)
staged.push(
  stage('lp-fx-grain', 'LP FX Grain', GRAIN_TEST, true),
  stage('lp-fx-buf1', 'LP FX Buf 1', bufferTest(1), true),
  stage('lp-fx-buf4', 'LP FX Buf 4', bufferTest(4), true)
)

// The example patches (writeEffectExamples.ts), with the CPU probe.
for (const [file, dirName] of [
  ['stereo-reverb.loguepatch', 'lp-fx-reverb'],
  ['auto-wah.loguepatch', 'lp-fx-autowah'],
  ['tempo-swell.loguepatch', 'lp-fx-swell'],
  ['freq-shifter.loguepatch', 'lp-fx-freqshift'],
  ['multi-tap.loguepatch', 'lp-fx-multitap']
] as const) {
  const d = parsePatchFile(readFileSync(join(examplesDir, file), 'utf-8'))
  staged.push(stage(dirName, d.settings.unitName!, d, true))
}
// grain-mill fills all 11 rows of the delay, so the probe gets MODE's (the last) in a second
// build, whose clock then stays free-running.
{
  const d = parsePatchFile(readFileSync(join(examplesDir, 'grain-mill.loguepatch'), 'utf-8'))
  staged.push(stage('lp-fx-grainmill', d.settings.unitName!, d, false, exampleSubpatches()))
  const cpu: PatchDocument = {
    ...d,
    nodes: d.nodes.map((n) =>
      n.kind === 'obj' && n.name === 'mode'
        ? { ...n, params: n.params?.map((p) => ({ name: p.name, value: p.value })) }
        : n
    )
  }
  staged.push(stage('lp-fx-grainmill-cpu', 'Grain Mill CPU', cpu, true, exampleSubpatches()))
}
// reverse-wash fills all 11 rows too: the probe build gives it WIDTH's (the last), at 100.
{
  const d = parsePatchFile(readFileSync(join(examplesDir, 'reverse-wash.loguepatch'), 'utf-8'))
  staged.push(stage('lp-fx-revwash', d.settings.unitName!, d, false))
  const cpu: PatchDocument = {
    ...d,
    nodes: d.nodes.map((n) =>
      n.kind === 'obj' && n.name === 'width'
        ? { ...n, params: n.params?.map((p) => ({ name: p.name, value: p.value })) }
        : n
    )
  }
  staged.push(stage('lp-fx-revwash-cpu', 'RevWash CPU', cpu, true))
}
for (const dir of staged) console.log(dir)

/**
 * Renders an effect document on the host (NTS-1 mkII here, the xd below): the same generated `fx.h` the device builds,
 * against the effect harness's SDK stand-ins (harness/nts1mkii-fx/, see runNts1FxHarness.ts),
 * with a silent input and no params set -- the hardware tests bake every setting into the
 * document. Returns the left output.
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'
import type { PatchDocument } from '../../../src/shared/domain/patch'
import { generateOldGenFxUnit } from '../../src/minilogue-xd/generateFxUnit'
import { generateOldGenOscUnit } from '../../src/minilogue-xd/generateOscUnit'
import { generateFxUnit } from '../../src/nts1mkii/generateFxUnit'
import { generateOscUnit } from '../../src/nts1mkii/generateOscUnit'

const harnessDir = join(
  dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'harness',
  'nts1mkii-fx'
)
const sdkCommon = join(
  process.env.LOGUE_SDK ?? join(homedir(), 'Documents/GitHub/logue-sdk'),
  'platform/nts-1_mkii/common'
)

export function renderFxOnHost(doc: PatchDocument, frames: number): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), 'lp-hwtest-host-'))
  try {
    writeFileSync(join(dir, 'fx.h'), generateFxUnit(doc, { name: 'host' }).fxH)
    writeFileSync(
      join(dir, 'main.cpp'),
      `#include <cstdio>
#include <cstring>
#include "fx.h"
int main(int, char **argv) {
  static Fx fx;
  const uint32_t sdramFloats = fx.getBufferSize();
  float *sdram = sdramFloats ? new float[sdramFloats] : nullptr;
  if (sdram) memset(sdram, 0, sdramFloats * sizeof(float));
  fx.init(sdram);
  static float in[128], out[128];
  FILE *raw = fopen(argv[1], "wb");
  for (unsigned done = 0; done < ${frames}u; done += 64) {
    fx.process(in, out, 64);
    for (unsigned i = 0; i < 64; ++i) fwrite(&out[2 * i], sizeof(float), 1, raw);
  }
  fclose(raw);
  return 0;
}
`
    )
    const exe = join(dir, 'fx')
    execFileSync('clang++', [
      '-std=c++17',
      '-O2',
      '-Wno-unknown-attributes',
      `-I${harnessDir}`,
      `-I${sdkCommon}`,
      join(dir, 'main.cpp'),
      '-o',
      exe
    ])
    execFileSync(exe, [join(dir, 'out.raw')])
    const buf = readFileSync(join(dir, 'out.raw'))
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const xdHarnessDir = join(
  dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'harness',
  'minilogue-xd-fx'
)
const xdSdkUtils = join(
  process.env.LOGUE_SDK ?? join(homedir(), 'Documents/GitHub/logue-sdk'),
  'platform/minilogue-xd/inc/utils'
)

/** The minilogue xd counterpart (harness/minilogue-xd-fx/, see runXdFxHarness.ts): a delay or
 *  reverb document, rendered in place on a silent buffer, knobs left at their authored values. */
export function renderXdFxOnHost(doc: PatchDocument, frames: number): Float32Array {
  const module = doc.settings.logueTarget!.module
  if (module !== 'delfx' && module !== 'revfx') throw new Error(`xd host render: ${module}`)
  const prefix = module.toUpperCase()
  const dir = mkdtempSync(join(tmpdir(), 'lp-hwtest-xdhost-'))
  try {
    const { fxCpp } = generateOldGenFxUnit(doc, { name: 'host' })
    writeFileSync(join(dir, 'fx.cpp'), fxCpp)
    writeFileSync(
      join(dir, 'main.cpp'),
      `#include <cstdio>
#include <cstring>
float g_bpm = 120.f;
#include "fx.cpp"
int main(int, char **argv) {
${fxCpp.includes('s_sdram[') ? '  memset(s_sdram, 0, sizeof s_sdram);\n' : ''}  ${prefix}_INIT(0, 0);
  static float buf[128];
  FILE *raw = fopen(argv[1], "wb");
  for (unsigned done = 0; done < ${frames}u; done += 64) {
    memset(buf, 0, sizeof buf);
    ${prefix}_PROCESS(buf, 64);
    for (unsigned i = 0; i < 64; ++i) fwrite(&buf[2 * i], sizeof(float), 1, raw);
  }
  fclose(raw);
  return 0;
}
`
    )
    const exe = join(dir, 'fx')
    execFileSync('clang++', [
      '-std=c++17',
      '-O2',
      '-Wno-unknown-attributes',
      `-I${xdHarnessDir}`,
      `-I${xdSdkUtils}`,
      `-I${dir}`,
      join(dir, 'main.cpp'),
      '-o',
      exe
    ])
    execFileSync(exe, [join(dir, 'out.raw')])
    const buf = readFileSync(join(dir, 'out.raw'))
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const nts1Common = sdkCommon

/**
 * The NTS-1 mkII oscillator API's firmware tables, which the SDK's own (unmodified) osc_api.h
 * reads in its inline osc_w0f_for_note and osc_sinf. The device's copies live in its firmware
 * (osc_api.syms), not in the SDK, so these are filled by formula: equal temperament from A4 =
 * 440 Hz, clamped at the header's k_note_max_hz (exactly note 138), and the half sine osc_sinf
 * indexes (129 points over pi). What's left between host and device is the firmware's tables.
 */
function nts1OscApiTables(): string {
  const hz = Array.from({ length: 152 }, (_, n) =>
    Math.min(440 * Math.pow(2, (n - 69) / 12), 23679.643054)
  )
  const sine = Array.from({ length: 129 }, (_, k) => Math.sin((Math.PI * k) / 128))
  const list = (a: number[]): string => a.map((v) => `${v.toPrecision(9)}f`).join(', ')
  return `#include <stdint.h>
extern "C" {
const uint32_t k_osc_api_platform = 0;
const uint32_t k_osc_api_version = 0;
uint32_t osc_mcu_hash(void) { return 0; }
extern const float midi_to_hz_lut_f[152] = {${list(hz)}};
extern const float wt_sine_lut_f[129] = {${list(sine)}};
extern const uint8_t wt_saw_notes[7] = {0};
extern const float wt_saw_lut_f[7 * 129] = {0};
}
`
}

/**
 * An NTS-1 mkII OSCILLATOR document on the host: the generated `osc.h` against the SDK's own
 * headers (plus `nts1OscApiTables`), one voice, `note` held from the start (setPitch + noteOn),
 * no params set. `noteOffAt` (frames) sends the note-off there. Returns the output.
 */
export function renderNts1OscOnHost(
  doc: PatchDocument,
  frames: number,
  note: number,
  noteOffAt?: number
): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), 'lp-hwtest-nts1osc-'))
  try {
    writeFileSync(join(dir, 'osc.h'), generateOscUnit(doc, { name: 'host' }).oscH)
    writeFileSync(join(dir, 'tables.cpp'), nts1OscApiTables())
    writeFileSync(
      join(dir, 'main.cpp'),
      `#include <cstdio>
#include "osc.h"
int main(int, char **argv) {
  static Osc osc;
  osc.init(nullptr);
  osc.setPitch(${note}, 0);
  osc.noteOn(${note}, 100);
  static float out[64];
  FILE *raw = fopen(argv[1], "wb");
  for (unsigned done = 0; done < ${frames}u; done += 64) {
${noteOffAt !== undefined ? `    if (done == ${Math.floor(noteOffAt / 64) * 64}u) osc.noteOff(${note});\n` : ''}    osc.process(nullptr, out, 64);
    fwrite(out, sizeof(float), 64, raw);
  }
  fclose(raw);
  return 0;
}
`
    )
    const exe = join(dir, 'osc')
    execFileSync('clang++', [
      '-std=c++17',
      '-O2',
      '-Wno-unknown-attributes',
      '-D__EMSCRIPTEN__',
      `-I${nts1Common}`,
      `-I${dir}`,
      join(dir, 'main.cpp'),
      join(dir, 'tables.cpp'),
      '-o',
      exe
    ])
    execFileSync(exe, [join(dir, 'out.raw')])
    const buf = readFileSync(join(dir, 'out.raw'))
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const xdInc = join(
  process.env.LOGUE_SDK ?? join(homedir(), 'Documents/GitHub/logue-sdk'),
  'platform/minilogue-xd/inc'
)
const xdOscHarnessDir = join(
  dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'harness',
  'minilogue-xd-osc'
)

/**
 * A minilogue xd OSCILLATOR document on the host: the generated `osc.cpp` against the SDK's own
 * userosc.h / osc_api.h (its firmware tables filled like the NTS-1 mkII's, `nts1OscApiTables`;
 * harness/minilogue-xd-osc/ stands in for CMSIS), one voice: init, note-on, then cycle blocks with `pitch` = note << 8. Q31 output converted back to float.
 */
export function renderXdOscOnHost(
  doc: PatchDocument,
  frames: number,
  note: number,
  noteOffAt?: number
): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), 'lp-hwtest-xdosc-'))
  try {
    writeFileSync(join(dir, 'osc.cpp'), generateOldGenOscUnit(doc, { name: 'host' }).oscCpp)
    writeFileSync(join(dir, 'tables.cpp'), nts1OscApiTables())
    writeFileSync(
      join(dir, 'main.cpp'),
      `#include <cstdio>
#include <cstring>
#include "osc.cpp"
int main(int, char **argv) {
  user_osc_param_t params;
  memset(&params, 0, sizeof params);
  params.pitch = (uint16_t)(${note} << 8);
  // The SDK's OSC_* macros expand to attributed definitions: call the hooks by name.
  _hook_init(0, 0);
  _hook_on(&params);
  static int32_t out[64];
  FILE *raw = fopen(argv[1], "wb");
  for (unsigned done = 0; done < ${frames}u; done += 64) {
${noteOffAt !== undefined ? `    if (done == ${Math.floor(noteOffAt / 64) * 64}u) _hook_off(&params);\n` : ''}    _hook_cycle(&params, out, 64);
    for (unsigned i = 0; i < 64; ++i) { const float f = q31_to_f32(out[i]); fwrite(&f, sizeof f, 1, raw); }
  }
  fclose(raw);
  return 0;
}
`
    )
    const exe = join(dir, 'osc')
    execFileSync('clang++', [
      '-std=c++17',
      '-O2',
      '-Wno-unknown-attributes',
      `-I${xdOscHarnessDir}`,
      `-I${xdInc}`,
      `-I${join(xdInc, 'utils')}`,
      `-I${dir}`,
      join(dir, 'main.cpp'),
      join(dir, 'tables.cpp'),
      '-o',
      exe
    ])
    execFileSync(exe, [join(dir, 'out.raw')])
    const buf = readFileSync(join(dir, 'out.raw'))
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

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
import { generateFxUnit } from '../../src/nts1mkii/generateFxUnit'

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

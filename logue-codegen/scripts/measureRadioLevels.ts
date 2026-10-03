/**
 * Phase 3 of docs/PLAN-radio-findings.md: how loud `osc/noise` is in an effect, next to the dry
 * input. Renders the Radio patch's noise path on the host (NTS-1 mkII fx shell): audio-in ->
 * env/follower -> vca gain over the noise, out R; the dry input, out L. The input is a 110 Hz
 * saw at 0.18 peak, an effect's measured input level on a real NTS-1 mkII (env/follower's
 * notes). Prints RMS in dBFS per noise COLOR, with and without the follower.
 *
 *   npx tsx logue-codegen/scripts/measureRadioLevels.ts
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'
import { generateFxUnit } from '../src/nts1mkii/generateFxUnit'
import type { Net, ObjNode, PatchDocument } from '../../src/shared/domain/patch'

const harnessDir = join(dirname(new URL(import.meta.url).pathname), '..', 'harness', 'nts1mkii-fx')
const sdkCommon = join(
  process.env.LOGUE_SDK ?? join(homedir(), 'Documents/GitHub/logue-sdk'),
  'platform/nts-1_mkii/common'
)
const FRAMES = 48000

const obj = (name: string, type: string, params: Record<string, number> = {}): ObjNode => ({
  kind: 'obj',
  type,
  name,
  x: 0,
  y: 0,
  params: Object.entries(params).map(([p, v]) => ({ name: p, value: String(v) }))
})
const wire = (from: string, outlet: string, to: string, inlet: string): Net => ({
  sources: [{ obj: from, outlet }],
  dests: [{ obj: to, inlet }]
})

function render(color: number, follower: boolean): { dry: number; noise: number } {
  const nodes = [
    obj('in', 'logue/io/audio-in'),
    obj('out', 'logue/io/audio-out'),
    obj('noise', 'logue/osc/noise', { COLOR: color }),
    obj('f', 'logue/env/follower', { ATTACK: 17, RELEASE: 57 }),
    obj('v', 'logue/gain/vca')
  ]
  const nets = [
    wire('in', 'mono', 'out', 'l'),
    follower ? wire('noise', 'out', 'v', 'in') : wire('noise', 'out', 'out', 'r'),
    ...(follower
      ? [wire('in', 'mono', 'f', 'in'), wire('f', 'out', 'v', 'gain'), wire('v', 'out', 'out', 'r')]
      : [])
  ]
  const doc: PatchDocument = {
    nodes,
    nets,
    settings: { logueTarget: { module: 'modfx' } },
    notes: ''
  }
  const dir = mkdtempSync(join(tmpdir(), 'lp-radio-levels-'))
  writeFileSync(join(dir, 'fx.h'), generateFxUnit(doc, { name: 'levels' }).fxH)
  writeFileSync(
    join(dir, 'main.cpp'),
    `#include <cmath>
#include <cstdio>
#include "fx.h"
int main() {
  static Fx fx;
  const uint32_t n = fx.getBufferSize();
  fx.init(n ? new float[n]() : nullptr);
  static float in[128], out[128];
  double dry = 0, wet = 0;
  for (unsigned done = 0; done < ${FRAMES}; done += 64) {
    for (unsigned i = 0; i < 64; ++i) {
      const float phase = fmodf((done + i) * 110.f / 48000.f, 1.f);
      in[2 * i] = in[2 * i + 1] = 0.18f * (2.f * phase - 1.f);
    }
    fx.process(in, out, 64);
    // Skip the first quarter second: the follower settling.
    if (done >= 12000)
      for (unsigned i = 0; i < 64; ++i) { dry += out[2 * i] * out[2 * i]; wet += out[2 * i + 1] * out[2 * i + 1]; }
  }
  printf("%f %f\\n", sqrt(dry / ${FRAMES - 12000}), sqrt(wet / ${FRAMES - 12000}));
  return 0;
}
`
  )
  const exe = join(dir, 'levels')
  execFileSync('clang++', [
    '-std=c++17',
    '-O1',
    '-Wno-unknown-attributes',
    `-I${harnessDir}`,
    `-I${sdkCommon}`,
    join(dir, 'main.cpp'),
    '-o',
    exe
  ])
  const [dry, noise] = execFileSync(exe).toString().trim().split(' ').map(Number)
  return { dry, noise }
}

const db = (x: number): string => (20 * Math.log10(x)).toFixed(1).padStart(6)
const COLORS = ['White', 'Pink', 'Brown', 'Violet']
for (const follower of [false, true]) {
  for (let c = 0; c < COLORS.length; c++) {
    const { dry, noise } = render(c, follower)
    console.log(
      `${follower ? 'via follower' : 'noise alone '}  ${COLORS[c].padEnd(6)}  dry ${db(dry)} dBFS  noise ${db(noise)} dBFS  noise - dry ${db(noise / dry)} dB`
    )
  }
}

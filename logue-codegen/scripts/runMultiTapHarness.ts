/**
 * One-off verification for examples/effects/multi-tap.loguepatch (2026-10-06, the bus example):
 * renders it on the host for both platforms (the effect harnesses' stand-ins, as
 * `hwtest/hostRender.ts`, but both output channels and a unit impulse into both inputs), at the
 * knobs' authored values, and checks:
 * - the dry impulse at sample 0, scaled by the dry/wet's dry gain;
 * - the four taps (the bus `taps`: four pans sending, one receive) at k/4 of the spacing, each
 *   panned as authored (equal power: l = sqrt((100 - PAN)/200), r = sqrt((100 + PAN)/200)), at
 *   the wet gain x 0.5;
 * - the feedback: the last tap's echo comes back a spacing later, quieter (DEPTH x 0.9, through
 *   the lowpass), and the output decays (finite, peak bounded).
 * Both platforms must agree to float rounding.
 *
 * Usage: npx tsx logue-codegen/scripts/runMultiTapHarness.ts
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'
import { parsePatchFile } from '../../src/shared/json/patchCodec'
import type { PatchDocument } from '../../src/shared/domain/patch'
import { generateOldGenFxUnit } from '../src/minilogue-xd/generateFxUnit'
import { generateFxUnit } from '../src/nts1mkii/generateFxUnit'

const here = dirname(new URL(import.meta.url).pathname)
const sdk = process.env.LOGUE_SDK ?? join(homedir(), 'Documents/GitHub/logue-sdk')
const FRAMES = 48000 * 4

function compileAndRun(dir: string, includes: string[]): { l: Float32Array; r: Float32Array } {
  const exe = join(dir, 'fx')
  execFileSync('clang++', [
    '-std=c++17',
    '-O1',
    '-fsanitize=address,undefined',
    '-fno-sanitize-recover=all',
    '-Wno-unknown-attributes',
    ...includes.map((i) => `-I${i}`),
    join(dir, 'main.cpp'),
    '-o',
    exe
  ])
  execFileSync(exe, [join(dir, 'out.raw')])
  const b = readFileSync(join(dir, 'out.raw'))
  const x = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
  const l = new Float32Array(x.length / 2)
  const r = new Float32Array(x.length / 2)
  for (let i = 0; i < l.length; i++) {
    l[i] = x[2 * i]
    r[i] = x[2 * i + 1]
  }
  return { l, r }
}

function renderNts1(doc: PatchDocument): { l: Float32Array; r: Float32Array } {
  const dir = mkdtempSync(join(tmpdir(), 'lp-multitap-nts1-'))
  try {
    writeFileSync(join(dir, 'fx.h'), generateFxUnit(doc, { name: 'host' }).fxH)
    writeFileSync(
      join(dir, 'main.cpp'),
      `#include <cstdio>
#include <cstring>
#include "fx.h"
int main(int, char **argv) {
  static Fx fx;
  const uint32_t n = fx.getBufferSize();
  float *sdram = n ? new float[n] : nullptr;
  if (sdram) memset(sdram, 0, n * sizeof(float));
  fx.init(sdram);
  static float in[128], out[128];
  FILE *raw = fopen(argv[1], "wb");
  for (unsigned done = 0; done < ${FRAMES}u; done += 64) {
    memset(in, 0, sizeof in);
    if (done == 0) { in[0] = 1.f; in[1] = 1.f; }
    fx.process(in, out, 64);
    fwrite(out, sizeof(float), 128, raw);
  }
  fclose(raw);
  return 0;
}
`
    )
    return compileAndRun(dir, [
      join(here, '..', 'harness', 'nts1mkii-fx'),
      join(sdk, 'platform/nts-1_mkii/common')
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function renderXd(doc: PatchDocument): { l: Float32Array; r: Float32Array } {
  const dir = mkdtempSync(join(tmpdir(), 'lp-multitap-xd-'))
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
  memset(s_sdram, 0, sizeof s_sdram);
  DELFX_INIT(0, 0);
  static float buf[128];
  FILE *raw = fopen(argv[1], "wb");
  for (unsigned done = 0; done < ${FRAMES}u; done += 64) {
    memset(buf, 0, sizeof buf);
    if (done == 0) { buf[0] = 1.f; buf[1] = 1.f; }
    DELFX_PROCESS(buf, 64);
    fwrite(buf, sizeof(float), 128, raw);
  }
  fclose(raw);
  return 0;
}
`
    )
    return compileAndRun(dir, [
      join(here, '..', 'harness', 'minilogue-xd-fx'),
      join(sdk, 'platform/minilogue-xd/inc/utils'),
      dir
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const doc = parsePatchFile(
  readFileSync(join(here, '..', '..', 'examples', 'effects', 'multi-tap.loguepatch'), 'utf-8')
)
const param = (node: string, name: string): number =>
  Number(
    doc.nodes.find((n) => n.kind === 'obj' && n.name === node)!.kind === 'obj'
      ? (
          doc.nodes.find((n) => n.kind === 'obj' && n.name === node) as {
            params: { name: string; value: string }[]
          }
        ).params.find((p) => p.name === name)!.value
      : NaN
  )

const fade = param('dry/wet', 'FADE') / 100
const dryGain = 1 - fade
const wetGain = fade * (param('wet-l', 'GAIN') / 25)
const pans = [1, 2, 3, 4].map((k) => param(`pan-${k}`, 'PAN'))
const feedback = (param('feedback', 'VALUE') / 100) * 0.9

let failures = 0
const check = (ok: boolean, what: string): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures++
}

/** The `count` largest isolated peaks of |l| + |r| after sample 0, in time order. */
function peaks(l: Float32Array, r: Float32Array, count: number): number[] {
  const mag = (i: number): number => Math.abs(l[i]) + Math.abs(r[i])
  const found: number[] = []
  const taken = (i: number): boolean => found.some((j) => Math.abs(i - j) < 64)
  const order = Array.from({ length: l.length - 1 }, (_, i) => i + 1).sort(
    (a, b) => mag(b) - mag(a)
  )
  for (const i of order) {
    if (found.length === count) break
    if (!taken(i)) found.push(i)
  }
  return found.sort((a, b) => a - b)
}

const renders = { nts1: renderNts1(doc), xd: renderXd(doc) }
for (const [platform, { l, r }] of Object.entries(renders)) {
  console.log(`-- ${platform}`)
  check(
    Math.abs(l[0] - dryGain) < 1e-4 && Math.abs(r[0] - dryGain) < 1e-4,
    `dry at 0: ${l[0].toFixed(4)} / ${r[0].toFixed(4)} (want ${dryGain.toFixed(4)})`
  )
  // Hermite-read taps spread an impulse over 4 samples: sum each echo's energy around its peak.
  const echo = (i: number, x: Float32Array): number => {
    let e = 0
    for (let j = i - 4; j <= i + 4; j++) e += x[j] * x[j]
    return Math.sqrt(e)
  }
  const taps = peaks(l, r, 4)
  // A tap's delay is 3 samples plus its share of the ring: taps at 3 + k * spacing.
  const spacing = (taps[3] - taps[0]) / 3
  console.log(`     taps at ${taps.join(', ')} samples (spacing ${(spacing / 48).toFixed(1)} ms)`)
  taps.forEach((at, k) => {
    check(
      Math.abs(at - (taps[0] + spacing * k)) <= 1,
      `tap ${k + 1} at ${at} (want ${(taps[0] + spacing * k).toFixed(0)})`
    )
    const wantL = wetGain * Math.sqrt((100 - pans[k]) / 200)
    const wantR = wetGain * Math.sqrt((100 + pans[k]) / 200)
    const gotL = echo(at, l)
    const gotR = echo(at, r)
    // The buffer is int16 and a tap's Hermite read of an impulse isn't energy-preserving: 5 %.
    check(
      Math.abs(gotL / gotR / (wantL / wantR) - 1) < 0.05,
      `tap ${k + 1} pan ${pans[k]}: l/r ${(gotL / gotR).toFixed(3)} (want ${(wantL / wantR).toFixed(3)})`
    )
  })
  // The last tap, through the lowpass and the feedback gain, re-enters the buffer and comes
  // back through every tap: at taps[3] + taps[k]. The lowpass spreads it, so compare each echo's
  // sum (the one-pole's DC gain is 1) with its first pass: the feedback gain, and nothing else.
  const sum = (x: Float32Array, at: number): number => {
    let t = 0
    for (let j = at - 8; j < at + 1500; j++) t += x[j]
    return t
  }
  taps.forEach((at, k) => {
    const back = taps[3] + at
    const ratio = (sum(l, back) + sum(r, back)) / (sum(l, at) + sum(r, at))
    check(
      Math.abs(ratio / feedback - 1) < 0.05,
      `feedback through tap ${k + 1} at ${back}: ${ratio.toFixed(3)} of its first pass (want ${feedback.toFixed(3)})`
    )
  })
  let peak = 0
  let finite = true
  for (let i = 0; i < l.length; i++) {
    finite &&= Number.isFinite(l[i]) && Number.isFinite(r[i])
    peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]))
  }
  const tail = Math.max(...Array.from(l.subarray(l.length - 48000)).map(Math.abs))
  check(
    finite && peak <= 1,
    `finite, peak ${peak.toFixed(3)}; last second's peak ${tail.toExponential(2)}`
  )
}
let maxDiff = 0
for (let i = 0; i < FRAMES; i++)
  maxDiff = Math.max(
    maxDiff,
    Math.abs(renders.nts1.l[i] - renders.xd.l[i]),
    Math.abs(renders.nts1.r[i] - renders.xd.r[i])
  )
check(maxDiff < 1e-4, `nts1 and xd agree within ${maxDiff.toExponential(2)}`)
console.log(failures ? `${failures} FAILED` : 'all passed')
process.exit(failures ? 1 : 0)

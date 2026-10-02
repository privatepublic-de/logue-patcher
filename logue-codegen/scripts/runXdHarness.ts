/**
 * Runs generated minilogue xd code natively against `harness/minilogue-xd/userosc.h` (portable
 * stand-ins for the SDK symbols), under ASan/UBSan: generates `osc.cpp` for each document,
 * renders `frames` samples at `note` and reports min/max/rms plus any non-finite sample. With
 * `RAW_DIR` set, also writes each run's raw float output there, for an exact before/after
 * comparison of a codegen change. Behaviour check only -- cycles come from measureXdCycles.ts.
 *
 * Usage: npx tsx runXdHarness.ts <docs.json>
 *   docs.json: [{ "name": "...", "doc": <PatchDocument>, "note"?: 60, "frames"?: 48000,
 *                 "params"?: ["0=512"] }, ...]
 */
import { execFileSync } from 'child_process'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

export interface HarnessJob {
  name: string
  doc: PatchDocument
  note?: number
  frames?: number
  params?: string[]
}

export interface HarnessResult {
  name: string
  min: number
  max: number
  rms: number
  nonFinite: number
}

const harnessDir = join(dirname(new URL(import.meta.url).pathname), '..', 'harness', 'minilogue-xd')

function mainCpp(job: HarnessJob): string {
  const params = (job.params ?? [])
    .map((p) => p.split('=').map(Number))
    .map(([i, v]) => `  OSC_PARAM(${i}, ${v});\n`)
    .join('')
  return `#include <cmath>
#include <cstdio>
#include <cstring>
#include "osc_real.cpp"
int main(int argc, char **argv) {
  user_osc_param_t p;
  memset(&p, 0, sizeof(p));
  p.pitch = (${job.note ?? 60} << 8);
  OSC_INIT(0, 0);
${params}  OSC_NOTEON(&p);
  const unsigned total = ${job.frames ?? 48000}, block = 64;
  static int32_t buf[64];
  double sq = 0; float mn = 1e9f, mx = -1e9f; unsigned bad = 0;
  FILE *raw = argc > 1 ? fopen(argv[1], "wb") : nullptr;
  for (unsigned done = 0; done < total; done += block) {
    OSC_CYCLE(&p, buf, block);
    for (unsigned i = 0; i < block; i++) {
      float f = q31_to_f32(buf[i]);
      if (!std::isfinite(f)) bad++;
      if (f < mn) mn = f;
      if (f > mx) mx = f;
      sq += (double)f * f;
      if (raw) fwrite(&buf[i], 4, 1, raw);
    }
  }
  if (raw) fclose(raw);
  printf("min=%.6f max=%.6f rms=%.6f nonfinite=%u\\n", mn, mx, sqrt(sq / total), bad);
}
`
}

export function runHarness(job: HarnessJob, rawOut?: string): HarnessResult {
  const dir = mkdtempSync(join(tmpdir(), 'lp-xd-harness-'))
  copyFileSync(join(harnessDir, 'userosc.h'), join(dir, 'userosc.h'))
  writeFileSync(
    join(dir, 'osc_real.cpp'),
    generateOldGenOscUnit(job.doc, { name: 'harness' }).oscCpp
  )
  writeFileSync(join(dir, 'main.cpp'), mainCpp(job))
  execFileSync(
    'c++',
    [
      '-std=c++17',
      '-O1',
      '-fsanitize=address,undefined',
      '-fno-sanitize-recover=all',
      '-I.',
      'main.cpp',
      '-o',
      'harness'
    ],
    { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] }
  )
  const out = execFileSync(join(dir, 'harness'), rawOut ? [rawOut] : [], {
    cwd: dir,
    encoding: 'utf8'
  })
  const m = /min=(\S+) max=(\S+) rms=(\S+) nonfinite=(\d+)/.exec(out)
  if (!m) throw new Error(`${job.name}: unexpected harness output:\n${out}`)
  return {
    name: job.name,
    min: Number(m[1]),
    max: Number(m[2]),
    rms: Number(m[3]),
    nonFinite: Number(m[4])
  }
}

if (process.argv[1]?.endsWith('runXdHarness.ts')) {
  const jobs = JSON.parse(readFileSync(process.argv[2], 'utf8')) as HarnessJob[]
  for (const job of jobs) {
    const raw = process.env.RAW_DIR ? join(process.env.RAW_DIR, `${job.name}.raw`) : undefined
    const r = runHarness(job, raw)
    console.log(
      `${r.name.padEnd(36)} min=${r.min.toFixed(4)} max=${r.max.toFixed(4)} rms=${r.rms.toFixed(4)} nonfinite=${r.nonFinite}`
    )
  }
}

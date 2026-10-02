/**
 * Stages patch documents as minilogue xd units in the local logue-sdk checkout, builds each with
 * the local ARM toolchain, and runs `emulateXdCycles.py` on the result -- the one pipeline behind
 * every CPU number in this project (the block-rate hook's before/after, the per-primitive cost
 * table). Emulator numbers are an ESTIMATE on its own scale (see that script's header), not a
 * hardware measurement.
 *
 * Usage: EMU_PYTHON=<python with unicorn/capstone/pyelftools> npx tsx measureXdCycles.ts <docs.json> [out.json]
 *   docs.json: [{ "name": "...", "doc": <PatchDocument>, "note"?: 60, "params"?: ["0=512"] }, ...]
 * Env: LOGUE_SDK (default ~/Documents/GitHub/logue-sdk), GCC_BIN_PATH (default /opt/homebrew/bin),
 *      SAMPLES (default 4800), PROFILE=1 (per-line profile, printed).
 */
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

export interface MeasureJob {
  name: string
  doc: PatchDocument
  note?: number
  params?: string[]
  /** Staging folder name under the SDK's minilogue-xd platform; defaults to one per job name. */
  dir?: string
}

export interface MeasureResult {
  name: string
  cyclesPerSample: number
  rms: number
  profile?: string
}

const sdk = process.env.LOGUE_SDK ?? join(homedir(), 'Documents/GitHub/logue-sdk')
const gcc = process.env.GCC_BIN_PATH ?? '/opt/homebrew/bin'
const python = process.env.EMU_PYTHON ?? 'python3'
const samples = process.env.SAMPLES ?? '4800'
const emulator = join(dirname(new URL(import.meta.url).pathname), 'emulateXdCycles.py')

export function stageXd(job: MeasureJob): string {
  const result = generateOldGenOscUnit(job.doc, { name: 'measure' })
  const dir = join(
    sdk,
    'platform',
    'minilogue-xd',
    job.dir ?? `lp-measure-${job.name.replace(/[^\w-]/g, '_')}`
  )
  mkdirSync(join(dir, 'ld'), { recursive: true })
  mkdirSync(join(dir, 'tpl'), { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), result.manifestJson)
  writeFileSync(join(dir, 'project.mk'), result.projectMk)
  writeFileSync(join(dir, 'osc.cpp'), result.oscCpp)
  writeFileSync(join(dir, 'Makefile'), result.makefile)
  writeFileSync(join(dir, 'tpl', '_unit.c'), result.unitC)
  writeFileSync(join(dir, 'ld', 'rules.ld'), result.rulesLd)
  writeFileSync(join(dir, 'ld', 'userosc.ld'), result.useroscLd)
  writeFileSync(join(dir, 'ld', 'osc_api.syms'), result.oscApiSyms)
  return dir
}

export function measure(job: MeasureJob): MeasureResult {
  const dir = stageXd(job)
  // A reused staging folder can be rewritten within make's one-second mtime resolution.
  rmSync(join(dir, 'build'), { recursive: true, force: true })
  execFileSync('make', ['-j8'], {
    cwd: dir,
    env: { ...process.env, GCC_BIN_PATH: gcc },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  const out = execFileSync(
    python,
    [
      emulator,
      join(dir, 'build', 'osc.elf'),
      String(job.note ?? 60),
      samples,
      ...(job.params ?? [])
    ],
    { encoding: 'utf8' }
  )
  const m = /cycles\/sample=\s*([\d.]+)\s+rms=([\d.]+)/.exec(out)
  if (!m) throw new Error(`${job.name}: no emulator result in:\n${out}`)
  const profile = out.split('\n').slice(1).join('\n').trim()
  return {
    name: job.name,
    cyclesPerSample: Number(m[1]),
    rms: Number(m[2]),
    profile: profile || undefined
  }
}

if (process.argv[1]?.endsWith('measureXdCycles.ts')) {
  const jobs = JSON.parse(readFileSync(process.argv[2], 'utf8')) as MeasureJob[]
  const results = jobs.map((job) => {
    const r = measure(job)
    console.log(
      `${r.name.padEnd(40)} ${r.cyclesPerSample.toFixed(0).padStart(6)} cyc/sample  rms=${r.rms.toFixed(3)}`
    )
    if (r.profile) console.log(r.profile)
    return r
  })
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(results, null, 2))
}

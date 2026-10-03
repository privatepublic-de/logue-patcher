/**
 * Where a minilogue xd effect unit's cycles go, next to what `fxCpuCostTable.ts` says: builds the
 * patch, runs `emulateXdFxCycles.py` with a per-line profile (SDRAM_PENALTY 0, every line, SDRAM
 * accesses per line) and attributes each fx.cpp line to the instance whose `_<suffix>` names it
 * uses inside `process`; a line inside a helper goes to that helper (shared by every instance
 * calling it), an SDK header's to that header, the rest of `process` to "glue". Lists each
 * counted instance with its table cost (`fxTableCosts.ts`) and its inline lines, then the other
 * buckets. Found the causes behind `checkFxCpuEstimate.ts`' misses (2026-10-03): a primitive
 * measured with an outlet unread, envelopes charged a per-sample control path they didn't take,
 * grains that capture all the time.
 *
 * Taken-branch refills are in the unit's total but on no line, so the profile's total stays
 * ~5-10 % below the whole unit's.
 *
 * Usage: EMU_PYTHON=<python with unicorn/capstone/pyelftools> npx tsx profileFxUnit.ts <patch> ...
 *   <patch>: a .loguepatch path, or a file name in examples/effects. Its folder's top-level
 *   .loguesub files are its subpatches, as in the app.
 */
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { parsePatchFile } from '../../src/shared/json/patchCodec'
import type { PatchDocument } from '../../src/shared/domain/patch'
import { examplesDir } from './exampleSubpatches'
import { atPenalty, fxTableCosts } from './fxTableCosts'
import { measureXdFx } from './measureXdFxCycles'

const DIR = 'lp-measure-fxprofile'
const here = dirname(new URL(import.meta.url).pathname)
const stage = join(
  process.env.LOGUE_SDK ?? join(homedir(), 'Documents/GitHub/logue-sdk'),
  'platform',
  'minilogue-xd',
  DIR
)
/** A function's opening line in the generated fx.cpp (class members are indented by two). */
const DECL =
  /^(?: {2})?(?:static |inline |__attribute__\(\([\w, ]+\)\) |const )*(?:void|float|int|bool|u?int\d+_t)\s+\*?(\w+)\s*\(/

function localSubpatches(patchPath: string): Map<string, PatchDocument> {
  const folder = dirname(patchPath)
  return new Map(
    readdirSync(folder)
      .filter((f) => f.endsWith('.loguesub'))
      .map((f) => [
        `sub/${f.slice(0, -'.loguesub'.length)}`,
        parsePatchFile(readFileSync(join(folder, f), 'utf-8'))
      ])
  )
}

for (const arg of process.argv.slice(2)) {
  const path = existsSync(arg) ? arg : join(examplesDir, arg)
  const doc = parsePatchFile(readFileSync(path, 'utf-8'))
  const subpatches = localSubpatches(path)
  const whole = measureXdFx(doc, DIR, subpatches)
  const profile = execFileSync(
    process.env.EMU_PYTHON ?? 'python3',
    [join(here, 'emulateXdFxCycles.py'), join(stage, 'build', 'fx.elf'), '9600'],
    {
      encoding: 'utf8',
      env: { ...process.env, PROFILE: '1', PROFILE_LINES: '0', SDRAM_PENALTY: '0' }
    }
  )
  const src = readFileSync(join(stage, 'fx.cpp'), 'utf8').split('\n')
  const table = fxTableCosts(doc, subpatches)
  // Longest first, so `voice1_env` isn't read as `voice1`.
  const suffixes = table.instances.map((i) => i.suffix).sort((a, b) => b.length - a.length)
  const functionAt: string[] = []
  let current = ''
  src.forEach((line, i) => {
    const m = DECL.exec(line)
    if (m && !line.trim().endsWith(';')) current = m[1]
    functionAt[i + 1] = current
  })

  const buckets = new Map<string, { cycles: number; sdram: number }>()
  const add = (key: string, cycles: number, sdram: number): void => {
    const b = buckets.get(key) ?? { cycles: 0, sdram: 0 }
    buckets.set(key, { cycles: b.cycles + cycles, sdram: b.sdram + sdram })
  }
  for (const line of profile.split('\n').slice(1)) {
    const m = /^\s*([\d.]+)\s+([\d.]+)\s+(\S+)/.exec(line)
    if (!m) continue
    const [file, lineNo] = m[3].split(':')
    if (file !== 'fx.cpp') {
      add(`sdk:${file}`, Number(m[1]), Number(m[2]))
      continue
    }
    const text = src[Number(lineNo) - 1] ?? ''
    const fn = functionAt[Number(lineNo)] ?? ''
    const suffix = suffixes.find((s) => new RegExp(`_${s}\\b`).test(text))
    const key =
      fn === 'process' ? (suffix ? `inst:${suffix}` : 'glue (process)') : `fn:${fn || '?'}`
    add(key, Number(m[1]), Number(m[2]))
  }

  const profiled = [...buckets.values()].reduce((sum, b) => sum + b.cycles, 0)
  console.log(
    `\n== ${arg}: whole ${whole.cycles.toFixed(0)} cycles, ${whole.sdram.toFixed(1)} SDRAM; ` +
      `profiled ${profiled.toFixed(0)}; table ${atPenalty(table.sum, 0).toFixed(0)} ` +
      `(baseline ${table.baseline.cycles})`
  )
  console.log('instance                 table variant             table      inline lines')
  for (const inst of table.instances) {
    const own = buckets.get(`inst:${inst.suffix}`) ?? { cycles: 0, sdram: 0 }
    console.log(
      `  ${inst.suffix.padEnd(22)} ${`${inst.id.slice('logue/'.length)} ${inst.label}`.padEnd(34)} ` +
        `${String(inst.cost.cycles).padStart(4)}/${inst.cost.sdram.toFixed(1).padEnd(4)} ` +
        `${own.cycles.toFixed(0).padStart(5)}/${own.sdram.toFixed(2)}`
    )
  }
  console.log('helpers, SDK headers, glue:')
  for (const [key, b] of [...buckets].sort((x, y) => y[1].cycles - x[1].cycles)) {
    if (key.startsWith('inst:') || (b.cycles < 1 && b.sdram === 0)) continue
    console.log(
      `  ${key.padEnd(40)} ${b.cycles.toFixed(0).padStart(5)} cycles ${b.sdram.toFixed(2)} SDRAM`
    )
  }
  if (table.missing.length) console.log(`not in the table: ${table.missing.join(', ')}`)
}
rmSync(stage, { recursive: true, force: true })

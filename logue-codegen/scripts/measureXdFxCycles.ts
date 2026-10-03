/**
 * Stages a patch document as a minilogue xd EFFECT unit in the local logue-sdk checkout, builds it
 * with the local ARM toolchain and runs `emulateXdFxCycles.py` on it at SDRAM_PENALTY 0 -- the
 * effect counterpart of `measureXdCycles.ts`. Returns cycles per sample at penalty 0 and the SDRAM
 * accesses per sample, so the cost at any penalty p is `cycles + p * sdram`. An ESTIMATE on the
 * emulator's own scale, not a hardware measurement.
 * Env: LOGUE_SDK, GCC_BIN_PATH, EMU_PYTHON, SAMPLES (default 9600, after the emulator's 0.5 s
 * warm-up).
 */
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { generateMinilogueXdProject } from '../src/minilogue-xd/projectFiles'
import type { SubpatchDefinitions } from '../src/subpatches'
import type { PatchDocument } from '../../src/shared/domain/patch'

const here = dirname(new URL(import.meta.url).pathname)
const sdk = process.env.LOGUE_SDK ?? join(homedir(), 'Documents/GitHub/logue-sdk')
const gcc = process.env.GCC_BIN_PATH ?? '/opt/homebrew/bin'
const python = process.env.EMU_PYTHON ?? 'python3'
const samples = process.env.SAMPLES ?? '9600'
const emulator = join(here, 'emulateXdFxCycles.py')

export interface FxCycles {
  cycles: number
  sdram: number
}

/** The unit doesn't fit the module's SRAM: a size limit, not a codegen fault. */
export class TooBigError extends Error {}

/** Staging folder under the SDK's minilogue-xd platform; rebuilt from scratch every call. */
export function measureXdFx(
  doc: PatchDocument,
  dirName: string,
  subpatches: SubpatchDefinitions = new Map()
): FxCycles {
  const dir = join(sdk, 'platform', 'minilogue-xd', dirName)
  rmSync(dir, { recursive: true, force: true })
  const { files } = generateMinilogueXdProject(doc, 'measure', subpatches)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  try {
    execFileSync('make', ['-j8'], {
      cwd: dir,
      env: { ...process.env, GCC_BIN_PATH: gcc },
      stdio: 'pipe'
    })
  } catch (err) {
    const out = [(err as { stdout?: Buffer }).stdout, (err as { stderr?: Buffer }).stderr]
      .map((b) => b?.toString() ?? '')
      .join('\n')
    const overflow = /region `SRAM' overflowed by (\d+) bytes/.exec(out)
    if (overflow) throw new TooBigError(`SRAM overflowed by ${overflow[1]} B`)
    const why = /undefined reference to `(\w+)'/.exec(out)?.[1]
    throw new Error(
      why
        ? `link error, undefined ${why}`
        : (out.split('\n').find((l) => /error/i.test(l)) ?? 'build failed')
    )
  }
  const out = execFileSync(python, [emulator, join(dir, 'build', 'fx.elf'), samples], {
    encoding: 'utf8',
    env: { ...process.env, SDRAM_PENALTY: '0' }
  })
  const m = /cycles\/sample=\s*([\d.]+)\s+sdram accesses\/sample=\s*([\d.]+)/.exec(out)
  if (!m) throw new Error(`no emulator result in:\n${out}`)
  return { cycles: Number(m[1]), sdram: Number(m[2]) }
}

/**
 * Builds a document into an NTS-1 mkII unit for a hardware test: staged in the local logue-sdk
 * checkout (platform/nts-1_mkii/<dir>) and compiled with the local ARM toolchain, like the app's
 * Build. Test units carry the harness's own developer id and a unit id per test, so the
 * current-program dump can select exactly that unit (every app-built unit has 0/0).
 */
import { execFileSync } from 'child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { PatchDocument } from '../../../src/shared/domain/patch'
import { generateNts1MkiiProject, nts1mkiiConfigMk } from '../../src/nts1mkii/projectFiles'
import type { SubpatchDefinitions } from '../../src/subpatches'

/** 'LPHT': logue-patcher hardware test (not a registered Korg developer id). */
export const HWTEST_DEV_ID = 0x4c504854

const root = join(
  process.env.LOGUE_SDK ?? join(homedir(), 'Documents/GitHub/logue-sdk'),
  'platform',
  'nts-1_mkii'
)
const gccBin = process.env.GCC_BIN_PATH ?? '/opt/homebrew/bin'

export interface BuiltUnit {
  bytes: Uint8Array
  devId: number
  unitId: number
  /** unit_header.version: major << 16 | minor << 8 | patch. */
  version: number
}

/**
 * `edit` may rewrite the generated files before the build (e.g. the CPU probe wrapper).
 */
export function buildNts1Unit(
  doc: PatchDocument,
  dir: string,
  name: string,
  unitId: number,
  subpatches: SubpatchDefinitions = new Map(),
  edit?: (files: Record<string, string>) => Record<string, string>
): BuiltUnit {
  const path = join(root, dir)
  rmSync(path, { recursive: true, force: true })
  mkdirSync(path, { recursive: true })
  const project = generateNts1MkiiProject(doc, name, subpatches, { devId: HWTEST_DEV_ID, unitId })
  const files = edit ? edit(project.files) : project.files
  for (const [file, text] of Object.entries(files)) writeFileSync(join(path, file), text)
  writeFileSync(join(path, 'config.mk'), nts1mkiiConfigMk(project))
  const template = join(root, `dummy-${project.module}`)
  copyFileSync(join(template, 'Makefile'), join(path, 'Makefile'))
  copyFileSync(join(template, 'wasm.cc'), join(path, 'wasm.cc'))
  execFileSync('make', ['-j8', 'install'], {
    cwd: path,
    env: { ...process.env, GCC_BIN_PATH: gccBin },
    stdio: 'pipe'
  })
  return {
    bytes: new Uint8Array(readFileSync(join(path, `${project.project}.nts1mkiiunit`))),
    devId: HWTEST_DEV_ID,
    unitId,
    version: 0x00010000
  }
}

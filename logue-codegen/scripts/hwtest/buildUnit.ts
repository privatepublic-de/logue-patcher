/**
 * Builds a document into a unit for a hardware test. NTS-1 mkII: staged in the local logue-sdk
 * checkout (platform/nts-1_mkii/<dir>) and compiled with the local ARM toolchain, like the app's
 * Build. Test units carry the harness's own developer id and a unit id per test, so the
 * current-program dump can select exactly that unit (every app-built unit has 0/0).
 */
import { execFileSync } from 'child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { PatchDocument } from '../../../src/shared/domain/patch'
import { generateMinilogueXdProject } from '../../src/minilogue-xd/projectFiles'
import { generateNts1MkiiProject, nts1mkiiConfigMk } from '../../src/nts1mkii/projectFiles'
import { buildMinilogueXdUnitBody } from '../../src/sysex/minilogueXdUnitBody'
import type { OldGenUnitManifest } from '../../src/sysex/unitArchive'
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

const xdRoot = join(
  process.env.LOGUE_SDK ?? join(homedir(), 'Documents/GitHub/logue-sdk'),
  'platform',
  'minilogue-xd'
)

/**
 * The minilogue xd counterpart: staged in platform/minilogue-xd/<dir> with its generated scaffold,
 * built, and returned as the body a slot upload takes (manifest + payload). An xd unit has no
 * developer id to select it by (the xd selects by slot), so a test unit is told apart by its name.
 */
export function buildXdUnit(
  doc: PatchDocument,
  dir: string,
  name: string,
  subpatches: SubpatchDefinitions = new Map(),
  edit?: (files: Record<string, string>) => Record<string, string>
): { body: Uint8Array; name: string } {
  const path = join(xdRoot, dir)
  rmSync(path, { recursive: true, force: true })
  const project = generateMinilogueXdProject(doc, name, subpatches)
  const files = edit ? edit(project.files) : project.files
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true })
    writeFileSync(join(path, file), text)
  }
  execFileSync('make', ['-j8'], {
    cwd: path,
    env: { ...process.env, GCC_BIN_PATH: gccBin },
    stdio: 'pipe'
  })
  const manifest = JSON.parse(files['manifest.json']) as OldGenUnitManifest
  const payload = new Uint8Array(readFileSync(join(path, 'build', `${project.project}.bin`)))
  return { body: buildMinilogueXdUnitBody(manifest, payload), name }
}

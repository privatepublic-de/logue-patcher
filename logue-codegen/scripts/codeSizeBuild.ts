/**
 * Builds a document into a real unit and sizes it -- shared by `measureCodeSizes.ts` (the table)
 * and `checkCodeSizeEstimate.ts` (the estimate against whole builds). The xd's SRAM region is
 * enlarged to 256K, so a unit bigger than the real one still links and can be sized.
 */
import { execFile as execFileCb } from 'child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { promisify } from 'util'
import { generateMinilogueXdProject } from '../src/minilogue-xd/projectFiles'
import { generateNts1MkiiProject, nts1mkiiConfigMk } from '../src/nts1mkii/projectFiles'
import type { LoguePlatform, PatchDocument } from '../../src/shared/domain/patch'

const execFile = promisify(execFileCb)
export const platformRoot = join(
  process.env.LOGUE_SDK ?? join(homedir(), 'Documents/GitHub/logue-sdk'),
  'platform'
)
export const gccBin = process.env.GCC_BIN_PATH ?? '/opt/homebrew/bin'

export interface Size {
  /** text + rodata + data (everything loaded but bss). */
  code: number
  bss: number
  /** Every defined function (demangled name -> bytes): out-of-line helpers are shared by every
   *  primitive that calls them, so the table counts them once per unit. */
  functions: Map<string, number>
}

async function functionSizes(elf: string): Promise<Map<string, number>> {
  const { stdout } = await execFile(
    join(gccBin, 'arm-none-eabi-nm'),
    ['-S', '-C', '--defined-only', elf],
    {
      maxBuffer: 16 * 1024 * 1024
    }
  )
  const sizes = new Map<string, number>()
  for (const line of stdout.split('\n')) {
    const m = /^[0-9a-f]+ ([0-9a-f]+) ([tTwW]) (.+)$/.exec(line.trim())
    if (m) sizes.set(m[3], parseInt(m[1], 16))
  }
  return sizes
}

/** Writes the project into `dir` for a build; the xd's SRAM region is enlarged to 256K. */
export function stage(dir: string, platform: LoguePlatform, d: PatchDocument): string {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const module = d.settings.logueTarget!.module
  if (platform === 'minilogue-xd') {
    const { files, project } = generateMinilogueXdProject(d, 'size')
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      const body = /^ld\/user\w+\.ld$/.test(path)
        ? text.replace(/(SRAM\s+\(rx\) : org = 0x[0-9A-Fa-f]+, len = )\d+K/, '$1256K')
        : text
      writeFileSync(join(dir, path), body)
    }
    return join(dir, 'build', `${project}.elf`)
  }
  const template = join(platformRoot, 'nts-1_mkii', `dummy-${module}`)
  const nts = generateNts1MkiiProject(d, 'size')
  for (const [name, text] of Object.entries(nts.files)) writeFileSync(join(dir, name), text)
  writeFileSync(join(dir, 'config.mk'), nts1mkiiConfigMk(nts))
  const project = nts.project
  copyFileSync(join(template, 'Makefile'), join(dir, 'Makefile'))
  copyFileSync(join(template, 'wasm.cc'), join(dir, 'wasm.cc'))
  return join(dir, 'build', `${project}.elf`)
}

export async function build(dir: string, platform: LoguePlatform, d: PatchDocument): Promise<Size> {
  const elf = stage(dir, platform, d)
  await execFile('make', ['-j2'], {
    cwd: dir,
    env: { ...process.env, GCC_BIN_PATH: gccBin },
    maxBuffer: 16 * 1024 * 1024
  })
  if (platform === 'nts1mkii') {
    // The same columns fixedCodeBytes was measured with: text (incl. rodata) + data, and bss.
    const { stdout } = await execFile(join(gccBin, 'arm-none-eabi-size'), [elf])
    const [text, data, bss] = stdout.split('\n')[1].trim().split(/\s+/).map(Number)
    return { code: text + data, bss, functions: await functionSizes(elf) }
  }
  const { stdout } = await execFile(join(gccBin, 'arm-none-eabi-size'), ['-A', elf])
  let code = 0
  let bss = 0
  for (const line of stdout.split('\n')) {
    const [name, size] = line.trim().split(/\s+/)
    if (!name?.startsWith('.') || !/^\d+$/.test(size ?? '')) continue
    if (/^\.(debug|comment|ARM\.attributes|sdram)/.test(name)) continue
    if (name === '.bss') bss += Number(size)
    else code += Number(size)
  }
  return { code, bss, functions: await functionSizes(elf) }
}

import { ipcMain } from 'electron'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cpus } from 'node:os'
import { IPC_CHANNELS } from '../../shared/ipc/contract'
import type { PatchDocument } from '../../shared/domain/patch'
import type { ArmToolchainInfo, LogueBuildResult } from '../../shared/ipc/contract'
import {
  generateMinilogueXdProject,
  type MinilogueXdProject
} from '@logue-codegen/minilogue-xd/projectFiles'
import {
  generateNts1MkiiProject,
  nts1mkiiConfigMk,
  type Nts1MkiiProject
} from '@logue-codegen/nts1mkii/projectFiles'
import { loadAppSettings } from '../config/appSettings'
import { deriveStagingName } from '../config/logueBuildStaging'
import { resolveBuildOutputFolder, makeRoomForDestination } from '../config/buildOutputFolder'
import { deriveBuildFileName } from '../config/buildResultNaming'
import { loadCurrentSubpatchDefinitions } from './subpatchLibrary'
import { appHomeDir } from '../config/appHome'

const execFile = promisify(execFileCb)

export class LogueSdkNotConfiguredError extends Error {}
export class LogueSdkInvalidError extends Error {}
export class ArmToolchainNotAvailableError extends Error {}
export class LogueBuildFailedError extends Error {}

/**
 * Every binary either platform's staged Makefile actually invokes via `$(GCC_BIN_PATH)/
 * arm-none-eabi-*` (see both Makefiles' own `CC`/`CXXC`/`LD`/`CP`/`AS`/`AR`/`OD`/`SZ`/`STRIP`
 * definitions) -- `strip` is NTS-1 mkII-only (minilogue xd's Makefile never defines `STRIP` at
 * all), so it's the one caller-supplied distinction here.
 */
function requiredArmToolchainBinaries(needsStrip: boolean): string[] {
  const required = [
    'arm-none-eabi-gcc',
    'arm-none-eabi-g++',
    'arm-none-eabi-objcopy',
    'arm-none-eabi-ar',
    'arm-none-eabi-objdump',
    'arm-none-eabi-size'
  ]
  if (needsStrip) required.push('arm-none-eabi-strip')
  return required
}

function armToolchainBinariesPresent(binDir: string, needsStrip: boolean): boolean {
  return requiredArmToolchainBinaries(needsStrip).every((bin) => existsSync(join(binDir, bin)))
}

/**
 * Known install locations for a local `arm-none-eabi-gcc`, probed in order when the user hasn't
 * set an explicit `armToolchainPath` override. Deliberately NOT a PATH lookup -- an Electron app
 * launched from Finder/Dock doesn't inherit the user's shell PATH (typically just `/usr/bin:/bin
 * :/usr/sbin:/sbin`), so Homebrew's `/opt/homebrew/bin` (Apple Silicon) / `/usr/local/bin`
 * (Intel) would silently never be found by a `which`-style check even when installed.
 */
function knownArmToolchainDirs(): string[] {
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin']
  // The Arm GNU Toolchain installer (developer.arm.com) lays out one versioned subdirectory per
  // install under here, e.g. `/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin` -- glob
  // rather than hardcode a version, since a fresh install could be any version.
  const armGnuRoot = '/Applications/ArmGNUToolchain'
  try {
    for (const version of readdirSync(armGnuRoot)) {
      dirs.push(join(armGnuRoot, version, 'arm-none-eabi', 'bin'))
    }
  } catch {
    // Not installed via this path -- fine, it's just one of several candidates.
  }
  return dirs
}

/**
 * Resolves which `bin` directory to point `GCC_BIN_PATH` at for a local build. An
 * explicit `armToolchainPath` setting is authoritative when present -- if it's missing required
 * binaries, that's a real misconfiguration worth failing loudly on rather than silently falling
 * back to auto-detection behind the user's back. With no override, probes `knownArmToolchainDirs`
 * and throws `ArmToolchainNotAvailableError` if none qualify.
 */
function resolveArmToolchainBinDir(homeDir: string, needsStrip: boolean): string {
  const configured = loadAppSettings(homeDir).armToolchainPath
  if (configured) {
    if (!armToolchainBinariesPresent(configured, needsStrip)) {
      throw new ArmToolchainNotAvailableError(
        `The ARM toolchain path configured in Settings ("${configured}") is missing one or more required arm-none-eabi-* binaries. Re-check the path, or clear it to auto-detect.`
      )
    }
    return configured
  }
  const found = knownArmToolchainDirs().find((dir) => armToolchainBinariesPresent(dir, needsStrip))
  if (!found) {
    throw new ArmToolchainNotAvailableError(
      'No local ARM GCC toolchain found -- install one (e.g. "brew install --cask gcc-arm-embedded") or set its bin directory in Settings.'
    )
  }
  return found
}

async function armGccVersion(binDir: string): Promise<string> {
  try {
    const { stdout } = await execFile(join(binDir, 'arm-none-eabi-gcc'), ['-dumpversion'])
    return `arm-none-eabi-gcc ${stdout.trim()}`
  } catch {
    return 'arm-none-eabi-gcc'
  }
}

/**
 * What the SDK's own containerized build boils down to once its plumbing is stripped away:
 * `cd <project>; make -jN; make install`, with `GCC_BIN_PATH` pointed at a directory containing
 * `arm-none-eabi-*`. Both Makefiles' own `GCC_BIN_PATH ?= ...` default (a vendored toolchain
 * path that's never actually present) is a dead fallback in practice, so the override is always
 * required.
 */
async function runLocalMake(projectDir: string, gccBinPath: string): Promise<void> {
  const makeBin = existsSync('/usr/bin/make') ? '/usr/bin/make' : 'make'
  const env = { ...process.env, GCC_BIN_PATH: gccBinPath }
  const jobs = String(Math.max(1, cpus().length))
  try {
    await execFile(makeBin, ['-j', jobs], {
      cwd: projectDir,
      env,
      timeout: 10 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024
    })
    await execFile(makeBin, ['install'], {
      cwd: projectDir,
      env,
      timeout: 2 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024
    })
  } catch (err) {
    const output =
      err && typeof err === 'object'
        ? [(err as { stdout?: string }).stdout, (err as { stderr?: string }).stderr]
            .filter(Boolean)
            .join('\n')
        : String(err)
    // The xd links everything into one fixed SRAM region; say what that means before the log.
    const overflow = /region `SRAM' overflowed by (\d+) bytes/.exec(output)
    if (overflow) {
      throw new LogueBuildFailedError(
        `The unit is ${overflow[1]} bytes too big for the device's memory (code, tables and state share it) -- remove or swap out a large primitive.\n\n${output.slice(-2000)}`
      )
    }
    throw new LogueBuildFailedError(`The local ARM toolchain build failed:\n${output.slice(-2000)}`)
  }
}

function assertLogueSdkCheckout(sdkPath: string): void {
  if (!existsSync(join(sdkPath, 'platform', 'minilogue-xd', 'inc'))) {
    throw new LogueSdkInvalidError(
      `"${sdkPath}" doesn't look like a real logue-sdk checkout -- platform/minilogue-xd/inc is missing. Re-check the path in Settings.`
    )
  }
}

/**
 * Real-hardware verification -- `dummy-osc` (a real, always-
 * present Korg-shipped template) is also this build's own template SOURCE (see
 * `writeStagedNts1MkiiProject`), so its presence is required, not just a generic sanity check.
 */
function assertLogueSdkCheckoutForNts1Mkii(sdkPath: string): void {
  if (!existsSync(join(sdkPath, 'platform', 'nts-1_mkii', 'dummy-osc'))) {
    throw new LogueSdkInvalidError(
      `"${sdkPath}" doesn't look like a real logue-sdk checkout -- platform/nts-1_mkii/dummy-osc is missing. Re-check the path in Settings.`
    )
  }
}

function writeStagedProject(projectDir: string, project: MinilogueXdProject): void {
  for (const [path, text] of Object.entries(project.files)) {
    mkdirSync(dirname(join(projectDir, path)), { recursive: true })
    writeFileSync(join(projectDir, path), text, 'utf-8')
  }
}

/**
 * Unlike minilogue xd's old-gen generator (which embeds its
 * WHOLE build scaffold, Makefile/linker scripts included, as literal strings -- see
 * `minilogue-xd/generateOscUnit.ts`'s own doc comment on why), NTS-1 mkII's new-gen generator
 * only ever produced `header.c`/`osc.h`/`unit.cc` -- there's no generated Makefile/`config.mk`
 * to write. This build reuses `dummy-osc`'s own real, Korg-shipped Makefile/`wasm.cc` verbatim
 * (proven correct by the `stageSense*.ts` scripts' own real builds) and
 * writes a fixed `PROJECT := osc` `config.mk` -- same "always call it `osc`" convention
 * `minilogue-xd/generateOscUnit.ts`'s own embedded Makefile already uses (`PROJECT = osc`), so
 * the built unit always lands at a predictable `osc.nts1mkiiunit` regardless of the patch's own
 * display name, matching `osc.mnlgxdunit`'s own precedent exactly.
 */
function writeStagedNts1MkiiProject(
  projectDir: string,
  sources: Nts1MkiiProject,
  templateDir: string
): void {
  mkdirSync(projectDir, { recursive: true })
  for (const [name, text] of Object.entries(sources.files)) {
    writeFileSync(join(projectDir, name), text, 'utf-8')
  }
  copyFileSync(join(templateDir, 'Makefile'), join(projectDir, 'Makefile'))
  copyFileSync(join(templateDir, 'wasm.cc'), join(projectDir, 'wasm.cc'))
  writeFileSync(join(projectDir, 'config.mk'), nts1mkiiConfigMk(sources), 'utf-8')
}

/**
 * The real, end-to-end sibling of `logueExport.ts`'s `exportMinilogueXdUnit`. Staging lives inside
 * the user's own checkout rather than an isolated temp dir because both Makefiles locate the
 * platform headers relative to the project directory (`PLATFORMDIR ?= $(abspath ..)`). Every
 * failure path throws a specific, named error whose message
 * is exactly what reaches the renderer (no generic wrapper) -- matches `logueExport.ts`'s own
 * documented "let real messages through" posture.
 */
export function registerLogueBuildIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS['logueBuild.buildMinilogueXdUnit'],
    async (
      _event,
      doc: PatchDocument,
      unitName: string,
      patchFilePath: string | null
    ): Promise<LogueBuildResult> => {
      const sdkPath = loadAppSettings(appHomeDir()).logueSdkPath
      if (!sdkPath) {
        throw new LogueSdkNotConfiguredError(
          'Set your logue-sdk checkout path in Settings (gear icon, top right) before building.'
        )
      }
      assertLogueSdkCheckout(sdkPath)
      const outputFolder = resolveBuildOutputFolder(appHomeDir())

      const armBinDir = resolveArmToolchainBinDir(appHomeDir(), false)
      const builtWith = `Local ARM GCC (${await armGccVersion(armBinDir)})`

      const project = generateMinilogueXdProject(
        doc,
        unitName,
        loadCurrentSubpatchDefinitions(patchFilePath ?? null)
      )
      const stagingName = deriveStagingName(unitName)
      const platformRoot = join(sdkPath, 'platform')
      const projectDir = join(platformRoot, 'minilogue-xd', stagingName)

      try {
        writeStagedProject(projectDir, project)

        await runLocalMake(projectDir, armBinDir)

        const builtName = `${project.project}.mnlgxdunit`
        const builtUnitPath = join(projectDir, builtName)
        if (!existsSync(builtUnitPath)) {
          throw new LogueBuildFailedError(
            `The build reported success but no ${builtName} was produced -- see the logue-sdk checkout for details.`
          )
        }

        const filePath = join(outputFolder, deriveBuildFileName(unitName, 'mnlgxdunit'))
        mkdirSync(outputFolder, { recursive: true })
        makeRoomForDestination(filePath)
        copyFileSync(builtUnitPath, filePath)
        return { savedPath: filePath, builtWith }
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )

  /**
   * Real-hardware verification (2026-09-18/19) -- the same
   * manual staging shape `stageSense*.ts` already proved works via real builds AND a real
   * Kontrol Editor upload, now wired as an in-app action instead of a one-off script.
   */
  ipcMain.handle(
    IPC_CHANNELS['logueBuild.buildNts1MkiiUnit'],
    async (
      _event,
      doc: PatchDocument,
      unitName: string,
      patchFilePath: string | null
    ): Promise<LogueBuildResult> => {
      const sdkPath = loadAppSettings(appHomeDir()).logueSdkPath
      if (!sdkPath) {
        throw new LogueSdkNotConfiguredError(
          'Set your logue-sdk checkout path in Settings (gear icon, top right) before building.'
        )
      }
      assertLogueSdkCheckoutForNts1Mkii(sdkPath)
      const outputFolder = resolveBuildOutputFolder(appHomeDir())

      const armBinDir = resolveArmToolchainBinDir(appHomeDir(), true)
      const builtWith = `Local ARM GCC (${await armGccVersion(armBinDir)})`

      const sources = generateNts1MkiiProject(
        doc,
        unitName,
        loadCurrentSubpatchDefinitions(patchFilePath ?? null)
      )
      const stagingName = deriveStagingName(unitName)
      const platformRoot = join(sdkPath, 'platform')
      const projectDir = join(platformRoot, 'nts-1_mkii', stagingName)
      const templateDir = join(platformRoot, 'nts-1_mkii', `dummy-${sources.module}`)
      if (!existsSync(templateDir)) {
        throw new LogueSdkInvalidError(
          `"${sdkPath}" has no platform/nts-1_mkii/dummy-${sources.module} template to build this unit with. Re-check the path in Settings.`
        )
      }

      try {
        writeStagedNts1MkiiProject(projectDir, sources, templateDir)

        await runLocalMake(projectDir, armBinDir)

        const builtName = `${sources.project}.nts1mkiiunit`
        const builtUnitPath = join(projectDir, builtName)
        if (!existsSync(builtUnitPath)) {
          throw new LogueBuildFailedError(
            `The build reported success but no ${builtName} was produced -- see the logue-sdk checkout for details.`
          )
        }

        const filePath = join(outputFolder, deriveBuildFileName(unitName, 'nts1mkiiunit'))
        mkdirSync(outputFolder, { recursive: true })
        makeRoomForDestination(filePath)
        copyFileSync(builtUnitPath, filePath)
        return { savedPath: filePath, builtWith }
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )

  /**
   * Read-only probe for BuildPanel.tsx -- lets the UI show whether a local toolchain is actually
   * usable, and which compiler version it would build with, without attempting a
   * real build. `needsStrip: false` here since this isn't tied to either specific platform yet;
   * the two build handlers above re-resolve (and re-validate `arm-none-eabi-strip` for NTS-1
   * mkII specifically) at actual build time regardless.
   */
  ipcMain.handle(
    IPC_CHANNELS['logueBuild.detectLocalArmToolchain'],
    async (): Promise<ArmToolchainInfo | null> => {
      try {
        const binDir = resolveArmToolchainBinDir(appHomeDir(), false)
        return { binDir, version: await armGccVersion(binDir) }
      } catch {
        return null
      }
    }
  )
}

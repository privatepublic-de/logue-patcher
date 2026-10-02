/**
 * Uploads a staged test unit to a connected device from the command line (2026-09-30, for
 * hardware passes: stageOscHardwareUnits.ts' units, one after another). The same pieces the app's
 * Upload dialog uses -- discoverLogueDevices, LogueDeviceSession, buildMinilogueXdUnitBody,
 * RawSysexAssembler -- over the same native helper (resources/bin/logue-midi-helper, built by
 * `npm run build`), spoken to directly.
 *
 * Usage: npx tsx logue-codegen/scripts/uploadTestUnit.ts <unit dir name> [slot, 1-based = 1]
 *   e.g. `lp-osc-sync`: uploads platform/nts-1_mkii/lp-osc-sync/osc.nts1mkiiunit to a connected
 *   NTS-1 mkII and platform/minilogue-xd/lp-osc-sync/osc.mnlgxdunit to a connected xd, whichever
 *   exist, into that module's slot, and reads the slot back.
 */
import { spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { createInterface } from 'readline'
import {
  discoverLogueDevices,
  LogueDeviceSession,
  type SysexLink
} from '../src/sysex/deviceSession'
import { RawSysexAssembler } from '../src/sysex/rawSysexAssembler'
import { readOldGenUnitArchive } from '../src/sysex/unitArchive'
import { buildMinilogueXdUnitBody } from '../src/sysex/minilogueXdUnitBody'
import { readNts1mkiiUnitHeader } from '../src/sysex/unitBackup'
import { LOGUE_UNIT_MODULE_IDS, type LogueUnitModule } from '../src/sysex/korgUserUnitMessages'
import type { LoguePlatform } from '../../src/shared/domain/patch'

const here = dirname(new URL(import.meta.url).pathname)
const helperPath = join(here, '..', '..', 'resources', 'bin', 'logue-midi-helper')
const platformRoot = join(
  process.env.LOGUE_SDK ?? join(homedir(), 'Documents/GitHub/logue-sdk'),
  'platform'
)

/** The helper's line protocol (native/logue-midi-helper/main.swift, main/midi/midiHelper.ts). */
class Helper {
  private proc = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  private nextId = 1
  private pending = new Map<number, (msg: Record<string, unknown>) => void>()
  private assemblers = new Map<number, RawSysexAssembler>()
  private listeners = new Map<number, Set<(msg: Uint8Array) => void>>()

  constructor() {
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      const msg = JSON.parse(line) as Record<string, unknown>
      if (msg.event === 'data') {
        const source = msg.source as number
        let a = this.assemblers.get(source)
        if (!a) {
          a = new RawSysexAssembler((m) => this.listeners.get(source)?.forEach((l) => l(m)))
          this.assemblers.set(source, a)
        }
        a.push(new Uint8Array(Buffer.from(msg.data as string, 'base64')))
        return
      }
      const done = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined
      if (done) {
        this.pending.delete(msg.id as number)
        done(msg)
      }
    })
  }

  request(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, (reply) =>
        reply.ok ? resolve(reply) : reject(new Error(String(reply.error)))
      )
      this.proc.stdin.write(JSON.stringify({ ...msg, id }) + '\n')
    })
  }

  send(dest: number, bytes: Uint8Array): void {
    void this.request({ cmd: 'send', dest, data: Buffer.from(bytes).toString('base64') }).catch(
      (e) => console.error('send failed:', e)
    )
  }

  subscribe(source: number, cb: (msg: Uint8Array) => void): () => void {
    let set = this.listeners.get(source)
    if (!set) this.listeners.set(source, (set = new Set()))
    set.add(cb)
    return () => set.delete(cb)
  }

  link(input: number, output: number): SysexLink {
    return { send: (m) => this.send(output, m), subscribe: (cb) => this.subscribe(input, cb) }
  }

  close(): void {
    this.proc.stdin.end()
  }
}

function prepare(
  platform: LoguePlatform,
  bytes: Uint8Array
): Promise<{ module: LogueUnitModule; name: string; body: Uint8Array }> {
  if (platform === 'minilogue-xd') {
    return readOldGenUnitArchive(bytes).then((a) => ({
      module: a.module,
      name: a.manifest.header.name,
      body: buildMinilogueXdUnitBody(a.manifest, a.payload)
    }))
  }
  const h = readNts1mkiiUnitHeader(bytes)
  if (!h) throw new Error('not an NTS-1 mkII unit')
  const module = (Object.keys(LOGUE_UNIT_MODULE_IDS) as LogueUnitModule[]).find(
    (m) => LOGUE_UNIT_MODULE_IDS[m] === (h.target & 0xff)
  )!
  return Promise.resolve({ module, name: h.name, body: bytes })
}

async function main(): Promise<void> {
  const unitDir = process.argv[2]
  const slot = Number(process.argv[3] ?? '1') - 1
  if (!unitDir) throw new Error('usage: uploadTestUnit.ts <unit dir> [slot]')
  const files: Partial<Record<LoguePlatform, string>> = {}
  for (const [platform, sub] of [
    ['nts1mkii', 'nts-1_mkii'],
    ['minilogue-xd', 'minilogue-xd']
  ] as const) {
    const dir = join(platformRoot, sub, unitDir)
    const file = ['osc', 'fx']
      .map((p) => join(dir, `${p}.${platform === 'nts1mkii' ? 'nts1mkiiunit' : 'mnlgxdunit'}`))
      .find(existsSync)
    if (file) files[platform] = file
  }
  if (Object.keys(files).length === 0) throw new Error(`no built unit named ${unitDir}`)

  const helper = new Helper()
  try {
    const { sources, destinations } = (await helper.request({ cmd: 'list' })) as unknown as {
      sources: { id: number }[]
      destinations: { id: number }[]
    }
    await Promise.allSettled(sources.map((s) => helper.request({ cmd: 'connect', source: s.id })))
    const devices = await discoverLogueDevices(
      destinations.map((d) => ({
        id: String(d.id),
        send: (m: Uint8Array) => helper.send(d.id, m)
      })),
      sources.map((s) => ({ id: String(s.id), subscribe: (cb) => helper.subscribe(s.id, cb) }))
    )
    for (const [platform, file] of Object.entries(files) as [LoguePlatform, string][]) {
      const device = devices.find((d) => d.platform === platform)
      if (!device) {
        console.log(`${platform}: not connected -- skipped`)
        continue
      }
      const unit = await prepare(platform, new Uint8Array(readFileSync(file)))
      const session = new LogueDeviceSession(
        helper.link(Number(device.inputId), Number(device.outputId)),
        platform,
        device.channel
      )
      const before = await session.slotStatus(unit.module, slot)
      await session.upload(unit.module, slot, unit.body)
      const after = await session.slotStatus(unit.module, slot)
      const was = before.empty ? 'empty' : `"${before.name}"`
      const now = after.empty ? 'EMPTY' : `"${after.name}"`
      console.log(`${platform}: ${unit.module} slot ${slot + 1}: ${was} -> ${now}`)
    }
  } finally {
    helper.close()
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})

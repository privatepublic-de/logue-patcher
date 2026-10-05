/**
 * A connected NTS-1 mkII for scripted hardware tests: notes and CCs, the current-program dump
 * (read, edit, write back), and user-slot uploads/downloads -- all over the native MIDI helper.
 * The device's MIDI implementation (Korg, v1.00 2024-03-18) is summarized in
 * `logue-codegen/harness/sysex-emu/PROTOCOL-nts1mkii.md`.
 */
import { discoverLogueDevices, LogueDeviceSession } from '../../src/sysex/deviceSession'
import type { LogueUnitModule } from '../../src/sysex/korgUserUnitMessages'
import { pack7, unpack7 } from '../../src/sysex/pack7'
import { Helper } from '../midiHelperClient'

const KORG = 0x42
const FAMILY = [0x00, 0x01, 0x73]
const ACK = 0x23

export class Nts1Rig {
  private constructor(
    private helper: Helper,
    private input: number,
    private output: number,
    readonly channel: number,
    readonly session: LogueDeviceSession
  ) {}

  static async connect(): Promise<Nts1Rig> {
    const helper = new Helper()
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
    const d = devices.find((x) => x.platform === 'nts1mkii')
    if (!d) {
      helper.close()
      throw new Error('no NTS-1 mkII connected')
    }
    const input = Number(d.inputId)
    const output = Number(d.outputId)
    const session = new LogueDeviceSession(helper.link(input, output), 'nts1mkii', d.channel)
    return new Nts1Rig(helper, input, output, d.channel, session)
  }

  close(): void {
    this.helper.close()
  }

  send(bytes: number[]): void {
    this.helper.send(this.output, new Uint8Array(bytes))
  }

  noteOn(note: number, velocity = 100): void {
    this.send([0x90 | this.channel, note, velocity])
  }

  noteOff(note: number): void {
    this.send([0x80 | this.channel, note, 64])
  }

  cc(controller: number, value: number): void {
    this.send([0xb0 | this.channel, controller, value])
  }

  allNotesOff(): void {
    this.cc(123, 0)
  }

  private header(fn: number): number[] {
    return [0xf0, KORG, 0x30 | this.channel, ...FAMILY, fn]
  }

  /** Sends a SysEx and resolves with the first reply whose function is in `fns`. */
  private exchange(msg: number[], fns: number[], timeoutMs = 3000): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error(`no reply to ${msg[6].toString(16)}`))
      }, timeoutMs)
      const off = this.helper.subscribe(this.input, (m) => {
        if (m[0] !== 0xf0 || m[1] !== KORG || m[3] !== 0 || m[5] !== 0x73) return
        if (!fns.includes(m[6])) return
        clearTimeout(timer)
        off()
        resolve(m)
      })
      this.helper.send(this.output, new Uint8Array(msg))
    })
  }

  /** The edit buffer, unpacked (TABLE 2 of the MIDI implementation, little-endian words). */
  async readProgram(): Promise<Uint8Array> {
    const m = await this.exchange([...this.header(0x10), 0xf7], [0x40, 0x24])
    if (m[6] !== 0x40) throw new Error(`program dump refused (${m[6].toString(16)})`)
    return unpack7(m.slice(7, -1))
  }

  /** Writes the edit buffer; the device ACKs with 23. */
  async writeProgram(data: Uint8Array): Promise<void> {
    const m = await this.exchange([...this.header(0x40), ...pack7(data), 0xf7], [0x23, 0x24, 0x26])
    if (m[6] !== ACK) throw new Error(`program write refused (${m[6].toString(16)})`)
  }

  async upload(module: LogueUnitModule, slot: number, body: Uint8Array): Promise<void> {
    await this.session.upload(module, slot, body)
  }

  async download(module: LogueUnitModule, slot: number): Promise<Uint8Array | undefined> {
    return this.session.downloadSlot(module, slot)
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

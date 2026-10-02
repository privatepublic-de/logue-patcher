/**
 * Request/response orchestration over a plain SysEx link, kept transport-agnostic (no Web MIDI
 * types) so the whole handshake -> slot scan -> upload -> ACK flow is unit-testable against a
 * scripted fake device, and the renderer only has to adapt `MIDIInput`/`MIDIOutput` to `SysexLink`.
 *
 * Device->host behavior here is still unconfirmed against real hardware (see
 * `logue-codegen/harness/sysex-emu/PROTOCOL.md`). Timeouts are deliberately generous and
 * configurable rather than tuned, since no real ACK latency has been measured yet.
 */
import type { LoguePlatform } from '../primitives'
import {
  apiVersionRequest,
  clearSlotRequest,
  slotDataRequest,
  moduleInfoRequest,
  parseLogueSysexReply,
  searchDeviceRequest,
  slotDataUploadChunks,
  slotStatusRequest,
  SysexError,
  joinSlotDataChunks,
  type LogueSysexReply,
  type LogueUnitModule,
  type SemVer,
  type SlotStatus
} from './korgUserUnitMessages'

export interface SysexLink {
  send(msg: Uint8Array): void
  /** Returns an unsubscribe function. */
  subscribe(cb: (msg: Uint8Array) => void): () => void
}

export class DeviceTimeoutError extends Error {}

/** The device answered with a NAK status (`2x` other than `23`). */
export class DeviceNakError extends Error {
  constructor(
    readonly code: number,
    readonly statusName: string
  ) {
    super(`Device rejected the request: ${statusName} (0x${code.toString(16)}).`)
  }
}

export interface DeviceSessionOptions {
  requestTimeoutMs?: number
  /** Only applies to queries/clears -- an upload is never retried automatically. */
  busyRetries?: number
  busyRetryDelayMs?: number
  uploadTimeoutMs?: number
  downloadTimeoutMs?: number
}

const BUSY = 0x24

type Accept = (reply: LogueSysexReply) => boolean

export class LogueDeviceSession {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly opts: Required<DeviceSessionOptions>

  constructor(
    private readonly link: SysexLink,
    readonly platform: LoguePlatform,
    /** The device's own global MIDI channel, as reported by its Search Device reply. */
    readonly channel: number,
    opts: DeviceSessionOptions = {}
  ) {
    this.opts = {
      requestTimeoutMs: 1500,
      busyRetries: 3,
      busyRetryDelayMs: 250,
      uploadTimeoutMs: 30000,
      downloadTimeoutMs: 15000,
      ...opts
    }
  }

  async apiVersion(): Promise<{ platformId: number; version: SemVer }> {
    const r = await this.query(
      apiVersionRequest(this.platform, this.channel),
      (x) => x.kind === 'apiVersion'
    )
    if (r.kind !== 'apiVersion') throw new SysexError('unreachable')
    return { platformId: r.platformId, version: r.version }
  }

  async moduleInfo(
    module: LogueUnitModule
  ): Promise<{ maxPayloadSize: number; maxLoadSize: number; slotCount: number }> {
    const r = await this.query(
      moduleInfoRequest(this.platform, module, this.channel),
      (x) => x.kind === 'moduleInfo'
    )
    if (r.kind !== 'moduleInfo') throw new SysexError('unreachable')
    return { maxPayloadSize: r.maxPayloadSize, maxLoadSize: r.maxLoadSize, slotCount: r.slotCount }
  }

  async slotStatus(module: LogueUnitModule, slot: number): Promise<SlotStatus> {
    const r = await this.query(
      slotStatusRequest(this.platform, module, slot, this.channel),
      (x) =>
        x.kind === 'slotStatus' &&
        x.slot === slot &&
        (x.module === undefined || x.module === module)
    )
    if (r.kind !== 'slotStatus') throw new SysexError('unreachable')
    return r.status
  }

  /**
   * A slot's stored body, or undefined if empty. On the xd that's byte-identical to what uploading the
   * unit sends; on the NTS-1 mkII it's the `.nts1mkiiunit` ELF itself, reassembled from chunks.
   */
  async downloadSlot(module: LogueUnitModule, slot: number): Promise<Uint8Array | undefined> {
    if (this.platform === 'nts1mkii') return this.downloadChunked(module, slot)
    const r = await this.query(
      slotDataRequest(this.platform, module, slot, this.channel),
      (x) =>
        x.kind === 'slotData' && x.slot === slot && (x.module === undefined || x.module === module),
      this.opts.downloadTimeoutMs
    )
    if (r.kind !== 'slotData') throw new SysexError('unreachable')
    return r.body
  }

  private downloadChunked(module: LogueUnitModule, slot: number): Promise<Uint8Array | undefined> {
    const msg = slotDataRequest(this.platform, module, slot, this.channel)
    return this.serialized(
      () =>
        new Promise<Uint8Array | undefined>((resolve, reject) => {
          const chunks: Uint8Array[] = []
          const finish = (fn: () => void): void => {
            clearTimeout(timer)
            unsubscribe()
            fn()
          }
          const timer = setTimeout(
            () =>
              finish(() =>
                reject(new DeviceTimeoutError(`Download of ${module} ${slot + 1} timed out.`))
              ),
            this.opts.downloadTimeoutMs
          )
          const unsubscribe = this.link.subscribe((incoming) => {
            let r: LogueSysexReply | undefined
            try {
              r = parseLogueSysexReply(this.platform, incoming)
            } catch (e) {
              return finish(() => reject(e))
            }
            if (r?.kind === 'status' && !r.ok)
              return finish(() => reject(new DeviceNakError(r.code, r.name)))
            if (r?.kind !== 'slotDataChunk' || r.slot !== slot || (r.module && r.module !== module))
              return
            if (r.index !== chunks.length) {
              return finish(() =>
                reject(new SysexError(`Chunk ${r.index} arrived, expected ${chunks.length}.`))
              )
            }
            chunks.push(r.data)
            if (r.index === r.last) {
              try {
                const body = joinSlotDataChunks(chunks)
                finish(() => resolve(body))
              } catch (e) {
                finish(() => reject(e))
              }
            }
          })
          this.link.send(msg)
        })
    )
  }

  async clearSlot(module: LogueUnitModule, slot: number): Promise<void> {
    await this.query(clearSlotRequest(this.platform, module, slot, this.channel), () => false)
  }

  /** Resolves on the device's ACK; rejects with `DeviceNakError` (including `24`, which after an upload means DATA LOAD ERROR, not busy) or `DeviceTimeoutError`. */
  async upload(module: LogueUnitModule, slot: number, body: Uint8Array): Promise<void> {
    const msgs = slotDataUploadChunks(this.platform, module, slot, body, this.channel)
    await this.serialized(async () => {
      // One ACK per message, and the next chunk only after it: exactly what Kontrol Editor does on
      // the NTS-1 mkII (the second chunk's ACK took ~0.9 s there, presumably the flash write).
      for (const msg of msgs) {
        const r = await this.transact(msg, () => false, this.opts.uploadTimeoutMs)
        if (r.kind === 'status' && !r.ok) throw new DeviceNakError(r.code, r.name)
      }
    })
  }

  /** One request in flight at a time: replies carry no request ID, so overlap would mismatch them. */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private query(
    msg: Uint8Array,
    accept: Accept,
    timeoutMs = this.opts.requestTimeoutMs
  ): Promise<LogueSysexReply> {
    return this.serialized(async () => {
      for (let attempt = 0; ; attempt++) {
        const r = await this.transact(msg, accept, timeoutMs)
        if (r.kind !== 'status') return r
        if (r.ok) return r
        if (r.code === BUSY && attempt < this.opts.busyRetries) {
          await new Promise((res) => setTimeout(res, this.opts.busyRetryDelayMs * (attempt + 1)))
          continue
        }
        throw new DeviceNakError(r.code, r.name)
      }
    })
  }

  /** Any `status` reply also ends the transaction -- ACK/NAK is a valid answer to every request. */
  private transact(msg: Uint8Array, accept: Accept, timeoutMs: number): Promise<LogueSysexReply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new DeviceTimeoutError(`No reply from the device within ${timeoutMs} ms.`))
      }, timeoutMs)
      const unsubscribe = this.link.subscribe((incoming) => {
        let reply: LogueSysexReply | undefined
        try {
          reply = parseLogueSysexReply(this.platform, incoming)
        } catch (e) {
          clearTimeout(timer)
          unsubscribe()
          reject(e)
          return
        }
        if (!reply || (reply.kind !== 'status' && !accept(reply))) return
        clearTimeout(timer)
        unsubscribe()
        resolve(reply)
      })
      this.link.send(msg)
    })
  }
}

export interface DiscoveryOutput {
  id: string
  send(msg: Uint8Array): void
}

export interface DiscoveryInput {
  id: string
  subscribe(cb: (msg: Uint8Array) => void): () => void
}

export interface DiscoveredDevice {
  /** Undefined for a Korg device this app doesn't know (a reply with an unknown family ID). */
  platform?: LoguePlatform
  familyId: number
  channel: number
  firmware: { major: number; minor: number }
  outputId: string
  inputId: string
}

/**
 * Sends Search Device to every output with its own echo ID, since a reply doesn't say which output
 * reached the device -- the echo does, and the input it arrives on completes the pair. Port names
 * are deliberately not used: the real xd's port names differ from the emulator's, and a DIN
 * interface may well have a Korg device behind it.
 */
export async function discoverLogueDevices(
  outputs: DiscoveryOutput[],
  inputs: DiscoveryInput[],
  timeoutMs = 600
): Promise<DiscoveredDevice[]> {
  const probed = outputs.slice(0, 128)
  const found = new Map<string, DiscoveredDevice>()
  const unsubs = inputs.map((input) =>
    input.subscribe((msg) => {
      let reply: LogueSysexReply | undefined
      try {
        reply = parseLogueSysexReply('minilogue-xd', msg)
      } catch {
        return
      }
      if (reply?.kind !== 'searchDeviceReply' || reply.echoId >= probed.length) return
      const outputId = probed[reply.echoId].id
      if (found.has(outputId)) return
      found.set(outputId, {
        platform: reply.platform,
        familyId: reply.familyId,
        channel: reply.channel,
        firmware: reply.firmware,
        outputId,
        inputId: input.id
      })
    })
  )
  try {
    probed.forEach((out, i) => {
      try {
        out.send(searchDeviceRequest(i))
      } catch {
        // A port that refuses SysEx (disconnected mid-scan, or a driver quirk) just isn't a candidate.
      }
    })
    await new Promise((res) => setTimeout(res, timeoutMs))
  } finally {
    unsubs.forEach((u) => u())
  }
  return [...found.values()]
}

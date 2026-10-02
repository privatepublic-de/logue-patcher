import { describe, it, expect } from 'vitest'
import {
  DeviceNakError,
  DeviceTimeoutError,
  LogueDeviceSession,
  discoverLogueDevices,
  type DiscoveryInput,
  type SysexLink
} from '../logue-codegen/src/sysex/deviceSession'
import { pack7, unpack7 } from '../logue-codegen/src/sysex/pack7'

/**
 * A scripted in-memory minilogue xd. Its replies follow the same framing guesses the Swift capture
 * emulator makes (`logue-codegen/harness/sysex-emu/main.swift`) -- this tests the session's
 * orchestration (matching, retries, serialization, timeouts), not what a real device sends.
 */
class FakeXd implements SysexLink {
  sent: Uint8Array[] = []
  private listeners = new Set<(m: Uint8Array) => void>()
  busyFor = 0
  uploadStatus = 0x23
  silent = false
  inFlight = 0
  maxInFlight = 0

  constructor(readonly channel = 0) {}

  subscribe(cb: (m: Uint8Array) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  emit(bytes: number[]): void {
    const msg = Uint8Array.from(bytes)
    queueMicrotask(() => {
      this.inFlight--
      this.listeners.forEach((l) => l(msg))
    })
  }

  send(msg: Uint8Array): void {
    this.sent.push(msg)
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    if (this.silent) return
    const hdr = [0xf0, 0x42, 0x30 | this.channel, 0x00, 0x01, 0x51]
    if (msg[2] !== (0x30 | this.channel)) return
    const fn = msg[6]
    if (fn !== 0x4a && this.busyFor > 0) {
      this.busyFor--
      return this.emit([...hdr, 0x24, 0xf7])
    }
    switch (fn) {
      case 0x17:
        return this.emit([...hdr, 0x47, 2, 1, 2, 0, 0xf7])
      case 0x18:
        return this.emit([
          ...hdr,
          0x48,
          msg[7],
          0,
          ...pack7(Uint8Array.from([0, 0xc0, 0, 0, 0, 0x80, 0, 0, 16, 0])),
          0xf7
        ])
      case 0x19: {
        const st = new Uint8Array(32)
        if (msg[8] === 1)
          st.set([4, 2, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0x55, 0x4e, 0x49, 0x54])
        return this.emit([...hdr, 0x49, msg[7], msg[8], 0, ...pack7(st), 0xf7])
      }
      case 0x4a:
        return this.emit([...hdr, this.uploadStatus, 0xf7])
      case 0x1b:
        return this.emit([...hdr, 0x23, 0xf7])
      case 0x1a: {
        if (msg[8] !== 1) return this.emit([...hdr, 0x4a, msg[7], msg[8], 0xf7])
        const body = Uint8Array.from({ length: 40 }, (_, i) => i)
        const framed = Uint8Array.from([40, 0, 0, 0, 0xfc, 0x89, 0xa2, 0xf7, ...body])
        return this.emit([...hdr, 0x4a, msg[7], msg[8], 0, ...pack7(framed), 0xf7])
      }
    }
  }
}

const fast = { requestTimeoutMs: 50, busyRetryDelayMs: 1, uploadTimeoutMs: 50 }

describe('LogueDeviceSession', () => {
  it('reads API version, module info and slot status', async () => {
    const dev = new FakeXd()
    const s = new LogueDeviceSession(dev, 'minilogue-xd', 0, fast)
    expect(await s.apiVersion()).toEqual({
      platformId: 2,
      version: { major: 1, minor: 2, patch: 0 }
    })
    expect(await s.moduleInfo('osc')).toEqual({
      maxPayloadSize: 0xc000,
      maxLoadSize: 0x8000,
      slotCount: 16
    })
    expect((await s.slotStatus('osc', 0)).empty).toBe(true)
    expect(await s.slotStatus('osc', 1)).toMatchObject({ empty: false, name: 'UNIT' })
  })

  it("addresses every request to the device's own global channel", async () => {
    const dev = new FakeXd(3)
    const s = new LogueDeviceSession(dev, 'minilogue-xd', 3, fast)
    await s.apiVersion()
    expect(dev.sent[0][2]).toBe(0x33)
  })

  it('retries a query answered with busy (24), then gives up with a NAK error', async () => {
    const dev = new FakeXd()
    dev.busyFor = 2
    const s = new LogueDeviceSession(dev, 'minilogue-xd', 0, fast)
    await expect(s.apiVersion()).resolves.toBeTruthy()
    expect(dev.sent.length).toBe(3)

    dev.busyFor = 10
    await expect(s.apiVersion()).rejects.toBeInstanceOf(DeviceNakError)
  })

  it('downloads a slot body, and an empty slot as undefined', async () => {
    const dev = new FakeXd()
    const s = new LogueDeviceSession(dev, 'minilogue-xd', 0, fast)
    expect(await s.downloadSlot('osc', 1)).toEqual(Uint8Array.from({ length: 40 }, (_, i) => i))
    expect(await s.downloadSlot('osc', 0)).toBeUndefined()
  })

  it('upload resolves on ACK, rejects on NAK, and never retries -- even on 24', async () => {
    const dev = new FakeXd()
    const s = new LogueDeviceSession(dev, 'minilogue-xd', 0, fast)
    await expect(s.upload('osc', 3, new Uint8Array(100))).resolves.toBeUndefined()

    dev.uploadStatus = 0x28
    await expect(s.upload('osc', 3, new Uint8Array(100))).rejects.toMatchObject({ code: 0x28 })

    dev.uploadStatus = 0x24
    const before = dev.sent.length
    await expect(s.upload('osc', 3, new Uint8Array(100))).rejects.toMatchObject({ code: 0x24 })
    expect(dev.sent.length).toBe(before + 1)
  })

  it('times out when the device never answers', async () => {
    const dev = new FakeXd()
    dev.silent = true
    const s = new LogueDeviceSession(dev, 'minilogue-xd', 0, fast)
    await expect(s.apiVersion()).rejects.toBeInstanceOf(DeviceTimeoutError)
  })

  it('keeps exactly one request in flight even when called concurrently', async () => {
    const dev = new FakeXd()
    const s = new LogueDeviceSession(dev, 'minilogue-xd', 0, fast)
    const all = await Promise.all(
      Array.from({ length: 16 }, (_, slot) => s.slotStatus('osc', slot))
    )
    expect(dev.maxInFlight).toBe(1)
    expect(all[1].name).toBe('UNIT')
    expect(all.filter((st) => st.empty).length).toBe(15)
  })

  it('ignores stray traffic (another device, another platform, non-Korg) while waiting', async () => {
    const dev = new FakeXd()
    const s = new LogueDeviceSession(dev, 'minilogue-xd', 0, fast)
    const p = s.apiVersion()
    dev.emit([0xf0, 0x42, 0x30, 0x00, 0x01, 0x73, 0x47, 5, 2, 0, 0, 0xf7])
    dev.emit([0x90, 60, 100])
    expect(await p).toMatchObject({ platformId: 2 })
  })

  it('packs the upload the device receives (round-trips through the fake)', async () => {
    const dev = new FakeXd()
    const s = new LogueDeviceSession(dev, 'minilogue-xd', 0, fast)
    const body = Uint8Array.from({ length: 300 }, (_, i) => (i * 13) & 0xff)
    await s.upload('osc', 5, body)
    const msg = dev.sent.at(-1)!
    expect([...msg.subarray(6, 9)]).toEqual([0x4a, 4, 5])
    expect(unpack7(msg.subarray(9, msg.length - 1)).subarray(8, 308)).toEqual(body)
  })
})

describe('discoverLogueDevices', () => {
  it('pairs each answering output with the input its echo arrived on', async () => {
    const listeners = new Map<string, (m: Uint8Array) => void>()
    const input = (id: string): DiscoveryInput => ({
      id,
      subscribe: (cb: (m: Uint8Array) => void) => {
        listeners.set(id, cb)
        return () => listeners.delete(id)
      }
    })
    const reply = (inputId: string, bytes: number[]): void =>
      queueMicrotask(() => listeners.get(inputId)?.(Uint8Array.from(bytes)))
    const outputs = [
      { id: 'mixer', send: () => {} },
      {
        id: 'xd-out',
        send: (m: Uint8Array) =>
          reply('xd-in', [0xf0, 0x42, 0x50, 0x01, 0x02, m[4], 0x51, 0x01, 0, 0, 3, 0, 2, 0, 0xf7])
      },
      {
        id: 'nts-out',
        send: (m: Uint8Array) =>
          reply('nts-in', [0xf0, 0x42, 0x50, 0x01, 0x00, m[4], 0x73, 0x01, 1, 0, 0, 0, 1, 0, 0xf7])
      },
      {
        id: 'broken',
        send: () => {
          throw new Error('port gone')
        }
      }
    ]
    const found = await discoverLogueDevices(
      outputs,
      [input('mixer-in'), input('xd-in'), input('nts-in')],
      20
    )
    expect(found).toEqual([
      {
        platform: 'minilogue-xd',
        familyId: 0x51,
        channel: 2,
        firmware: { major: 2, minor: 3 },
        outputId: 'xd-out',
        inputId: 'xd-in'
      },
      {
        platform: 'nts1mkii',
        familyId: 0x73,
        channel: 0,
        firmware: { major: 1, minor: 0 },
        outputId: 'nts-out',
        inputId: 'nts-in'
      }
    ])
  })
})

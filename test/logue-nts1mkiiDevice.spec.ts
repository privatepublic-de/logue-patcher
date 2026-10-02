import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect } from 'vitest'
import {
  joinSlotDataChunks,
  parseLogueSysexReply,
  slotDataUploadChunks
} from '../logue-codegen/src/sysex/korgUserUnitMessages'
import { LogueDeviceSession, type SysexLink } from '../logue-codegen/src/sysex/deviceSession'
import { planBackup, readNts1mkiiUnitHeader } from '../logue-codegen/src/sysex/unitBackup'

/**
 * Real NTS-1 digital kit mkII replies, captured 2026-09-25 with read-only requests only. osc slot 2
 * holds the user's own `combnew` build, the same file as `combnew.nts1mkiiunit` here.
 */
const FIXTURES = join(__dirname, 'fixtures/logue-sysex/nts1mkii')
const hex = (s: string): Uint8Array =>
  Uint8Array.from(
    s
      .trim()
      .split(/\s+/)
      .map((b) => parseInt(b, 16))
  )
const replies = (
  JSON.parse(readFileSync(join(FIXTURES, 'real-device-replies.json'), 'utf-8')) as {
    replies: Record<string, string>
  }
).replies
const parse = (key: string): ReturnType<typeof parseLogueSysexReply> =>
  parseLogueSysexReply('nts1mkii', hex(replies[key]))
const combnew = new Uint8Array(readFileSync(join(FIXTURES, 'combnew.nts1mkiiunit')))
const chunks = [0, 1].map(
  (i) => new Uint8Array(readFileSync(join(FIXTURES, `real-download-osc-slot2-combnew-${i}.syx`)))
)

describe('reply parsing vs a real NTS-1 mkII', () => {
  it('API version: platform 5, API 2.0.0 (the spec table\'s "0000 1010" is a typo)', () => {
    expect(parse('api')).toEqual({
      kind: 'apiVersion',
      platformId: 5,
      version: { major: 2, minor: 0, patch: 0 }
    })
  })

  it('module info carries a 12-byte payload; osc load size = the 48 KB RAM-load limit', () => {
    expect(parse('mod4')).toEqual({
      kind: 'moduleInfo',
      maxPayloadSize: 49136,
      maxLoadSize: 49152,
      slotCount: 16
    })
    expect(parse('mod1')).toEqual({
      kind: 'moduleInfo',
      maxPayloadSize: 16368,
      maxLoadSize: 16384,
      slotCount: 16
    })
    expect(parse('mod2')).toEqual({
      kind: 'moduleInfo',
      maxPayloadSize: 24560,
      maxLoadSize: 24576,
      slotCount: 8
    })
  })

  it("slot status is the whole unit_header_t, not the spec's 32 bytes", () => {
    expect(parse('osc1status')).toEqual({
      kind: 'slotStatus',
      module: 'osc',
      slot: 1,
      status: {
        empty: false,
        target: 0x0504,
        api: { major: 2, minor: 0, patch: 0 },
        devId: 0,
        programId: 0,
        version: { major: 1, minor: 0, patch: 0 },
        name: 'combnew'
      }
    })
    expect(parse('osc5statusEmpty')).toMatchObject({ slot: 4, status: { empty: true } })
  })

  it('a download is chunked; the joined body is the .nts1mkiiunit ELF verbatim', () => {
    const parsed = chunks.map((c) => parseLogueSysexReply('nts1mkii', c))
    expect(parsed.map((p) => (p?.kind === 'slotDataChunk' ? [p.index, p.last] : null))).toEqual([
      [0, 1],
      [1, 1]
    ])
    const body = joinSlotDataChunks(
      parsed.map((p) => (p?.kind === 'slotDataChunk' ? p.data : new Uint8Array()))
    )
    expect(body).toEqual(combnew)
  })

  it('an empty slot downloads as a single empty chunk', () => {
    const r = parse('modfx1downloadEmpty')
    expect(r).toMatchObject({ kind: 'slotDataChunk', module: 'modfx', slot: 0, index: 0, last: 0 })
    if (r?.kind !== 'slotDataChunk') throw new Error('unreachable')
    expect(joinSlotDataChunks([r.data])).toBeUndefined()
  })
})

describe('LogueDeviceSession.downloadSlot on NTS-1 mkII', () => {
  function replayingLink(replay: Uint8Array[]): SysexLink {
    const listeners = new Set<(m: Uint8Array) => void>()
    return {
      subscribe: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      send: () => replay.forEach((m) => queueMicrotask(() => listeners.forEach((l) => l(m))))
    }
  }

  it('reassembles the real chunked download', async () => {
    const s = new LogueDeviceSession(replayingLink(chunks), 'nts1mkii', 0, {
      downloadTimeoutMs: 200
    })
    expect(await s.downloadSlot('osc', 1)).toEqual(combnew)
  })

  it('rejects out-of-order chunks instead of silently corrupting the body', async () => {
    const s = new LogueDeviceSession(replayingLink([chunks[1], chunks[0]]), 'nts1mkii', 0, {
      downloadTimeoutMs: 200
    })
    await expect(s.downloadSlot('osc', 1)).rejects.toThrow(/Chunk 1 arrived, expected 0/)
  })

  it('an empty slot is undefined', async () => {
    const s = new LogueDeviceSession(
      replayingLink([hex(replies.modfx1downloadEmpty)]),
      'nts1mkii',
      0,
      {
        downloadTimeoutMs: 200
      }
    )
    expect(await s.downloadSlot('modfx', 0)).toBeUndefined()
  })
})

describe('NTS-1 mkII backup', () => {
  it('reads the unit name from the ELF .unit_header, and backs the ELF up as the unit file itself', () => {
    expect(readNts1mkiiUnitHeader(combnew)).toMatchObject({ name: 'combnew', target: 0x0504 })
    expect(readNts1mkiiUnitHeader(new Uint8Array(100))).toBeUndefined()
    const { files, index } = planBackup(
      'NTS-1 digital kit mkII',
      [
        { module: 'osc', slot: 1, body: combnew },
        { module: 'modfx', slot: 0 }
      ],
      new Date('2026-09-25T12:00:00Z'),
      'nts1mkii'
    )
    expect(files.find((f) => f.name === 'osc-02-combnew.nts1mkiiunit')?.bytes).toEqual(combnew)
    expect(index.slots).toEqual([
      {
        module: 'osc',
        slot: 1,
        empty: false,
        name: 'combnew',
        platform: 'nts1mkii',
        size: combnew.length,
        body: 'osc-02-combnew.nts1mkiiunit',
        unitFile: 'osc-02-combnew.nts1mkiiunit'
      },
      { module: 'modfx', slot: 0, empty: true }
    ])
  })
})

/**
 * KORG KONTROL Editor 2.5.0 sending the user's own `string.nts1mkiiunit` to osc slot 5 of a real
 * NTS-1 mkII, captured byte-for-byte through `logue-codegen/harness/sysex-emu/midi_proxy.swift`.
 * The device ACKed each chunk.
 */
describe('NTS-1 mkII upload vs Kontrol Editor', () => {
  const unit = new Uint8Array(readFileSync(join(FIXTURES, 'string.nts1mkiiunit')))
  const captured = [0, 1].map(
    (i) =>
      new Uint8Array(
        readFileSync(join(FIXTURES, `kontrol-editor-upload-osc-slot5-string-${i}.syx`))
      )
  )

  it('reproduces both captured chunks byte-for-byte from the unit file alone', () => {
    expect(slotDataUploadChunks('nts1mkii', 'osc', 4, unit)).toEqual(captured)
  })

  it('never exceeds 4096 bytes per message, and chunk headers count up to the last index', () => {
    const big = new Uint8Array(40000)
    const msgs = slotDataUploadChunks('nts1mkii', 'revfx', 7, big, 3)
    expect(msgs.length).toBe(12)
    expect(msgs.every((m) => m.length <= 4096)).toBe(true)
    expect(msgs.map((m) => [m[2], m[7], m[8], m[9], m[10]])).toEqual(
      msgs.map((_, i) => [0x33, 3, 7, i, 11])
    )
  })

  it('the session sends each chunk only after the previous one is ACKed, and stops at a NAK', async () => {
    const sent: Uint8Array[] = []
    const listeners = new Set<(m: Uint8Array) => void>()
    let nakOn = -1
    const link: SysexLink = {
      subscribe: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      send: (m) => {
        sent.push(m)
        const status = sent.length - 1 === nakOn ? 0x24 : 0x23
        setTimeout(
          () =>
            listeners.forEach((l) =>
              l(Uint8Array.from([0xf0, 0x42, 0x30, 0, 1, 0x73, status, 0xf7]))
            ),
          5
        )
      }
    }
    const s = new LogueDeviceSession(link, 'nts1mkii', 0, { uploadTimeoutMs: 200 })
    await s.upload('osc', 4, unit)
    expect(sent).toEqual(captured)

    sent.length = 0
    nakOn = 0
    await expect(s.upload('osc', 4, unit)).rejects.toMatchObject({ code: 0x24 })
    expect(sent.length).toBe(1)
  })
})

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect } from 'vitest'
import { RawSysexAssembler } from '../logue-codegen/src/sysex/rawSysexAssembler'
import { stripStrayEox } from '../logue-codegen/src/sysex/korgUserUnitMessages'
import { pack7 } from '../logue-codegen/src/sysex/pack7'

const FIXTURES = join(__dirname, 'fixtures/logue-sysex/minilogue-xd')
/** The real minilogue xd's raw answer to `1A 04 00`, stray F7s and all (see logue-sysex.spec.ts). */
const realDownload = new Uint8Array(
  readFileSync(join(FIXTURES, 'real-download-osc-slot1-string.raw'))
)

function collect(chunks: Uint8Array[]): Uint8Array[] {
  const got: Uint8Array[] = []
  const a = new RawSysexAssembler((m) => got.push(m))
  chunks.forEach((c) => a.push(c))
  return got
}

function chunked(data: Uint8Array, sizes: number[]): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0, k = 0; i < data.length; k++) {
    const n = sizes[k % sizes.length]
    out.push(data.subarray(i, i + n))
    i += n
  }
  return out
}

describe('RawSysexAssembler', () => {
  it('reassembles the real stray-F7 download into one complete message, however it is chunked', () => {
    const expected = stripStrayEox(realDownload)
    for (const sizes of [[realDownload.length], [48], [1], [3, 48, 7, 100], [9, 1, 43]]) {
      expect(collect(chunked(realDownload, sizes))).toEqual([expected])
    }
  })

  it('skips interleaved realtime bytes (Active Sensing, clock)', () => {
    const noisy = Uint8Array.from([
      ...realDownload.subarray(0, 700),
      0xfe,
      0xf8,
      ...realDownload.subarray(700)
    ])
    expect(collect([noisy])).toEqual([stripStrayEox(realDownload)])
  })

  it('ends ordinary short messages at their first F7, back to back', () => {
    const a = [0xf0, 0x42, 0x32, 0x00, 0x01, 0x51, 0x23, 0xf7]
    const b = [0xf0, 0x42, 0x32, 0x00, 0x01, 0x51, 0x49, 0x01, 0x02, 0xf7]
    const empty4a = [0xf0, 0x42, 0x32, 0x00, 0x01, 0x51, 0x4a, 0x01, 0x02, 0xf7]
    expect(collect([Uint8Array.from([...a, 0xfe, ...b, ...empty4a])])).toEqual([
      Uint8Array.from(a),
      Uint8Array.from(b),
      Uint8Array.from(empty4a)
    ])
  })

  it('delivers a transfer cut short by a new F0 as-is, so the parser rejects it', () => {
    const cut = realDownload.subarray(0, 900)
    const next = [0xf0, 0x42, 0x32, 0x00, 0x01, 0x51, 0x23, 0xf7]
    const got = collect([cut, Uint8Array.from(next)])
    expect(got.length).toBe(2)
    expect(got[0][got[0].length - 1]).not.toBe(0xf7)
    expect(got[1]).toEqual(Uint8Array.from(next))
  })

  it('ignores stray data outside any message, and drops a SysEx aborted by a status byte', () => {
    expect(collect([Uint8Array.from([0x12, 0x34, 0xf0, 0x42, 0x01, 0x90, 0x3c, 0x40])])).toEqual([])
  })

  it('passes NTS-1 mkII download chunks through at their own F7s (that device has no stray-F7 bug)', () => {
    const dir = join(__dirname, 'fixtures/logue-sysex/nts1mkii')
    const chunks = [0, 1].map(
      (i) => new Uint8Array(readFileSync(join(dir, `real-download-osc-slot2-combnew-${i}.syx`)))
    )
    const stream = Uint8Array.from([...chunks[0], ...chunks[1]])
    for (const sizes of [[stream.length], [48], [7, 300]]) {
      expect(collect(chunked(stream, sizes))).toEqual(chunks)
    }
  })

  it('keeps a 3-chunk NTS-1 mkII download as 3 messages (the case that broke a real backup)', () => {
    // Framed like the real device: `4A <module> <slot> <index> <last> pack7(chunk)`, each message
    // at most 4096 bytes. A 3-chunk unit (8.6 KB) once made the xd-only stray-F7 rule misread the
    // chunk header as a slot-data size and swallow chunk boundaries.
    // Zero runs, like a real ELF's padding: a chunk starting with zeros is exactly what the old rule
    // misread as a plausible 32 KB slot-data size.
    const body = Uint8Array.from({ length: 8636 }, (_, i) => (i < 64 ? (i * 31 + 7) & 0xff : 0))
    const framed = Uint8Array.from([
      ...new Uint8Array(new Uint32Array([body.length, 0]).buffer),
      ...body
    ])
    const per = 3570
    const parts = [0, 1, 2].map((i) => framed.subarray(i * per, (i + 1) * per))
    const msgs = parts.map((d, i) =>
      Uint8Array.from([
        0xf0,
        0x42,
        0x30,
        0x00,
        0x01,
        0x73,
        0x4a,
        0x03,
        0x00,
        i,
        2,
        ...pack7(d),
        0xf7
      ])
    )
    expect(msgs.every((m) => m.length <= 4096)).toBe(true)
    expect(collect([Uint8Array.from(msgs.flatMap((m) => [...m]))])).toEqual(msgs)
  })
})

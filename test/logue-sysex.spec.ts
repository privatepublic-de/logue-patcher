import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { describe, it, expect } from 'vitest'
import { testSampleAsset, testSampleFor } from './support/testSample'
import { pack7, unpack7, packedLength } from '../logue-codegen/src/sysex/pack7'
import { crc32 } from '../logue-codegen/src/sysex/crc32'
import {
  readOldGenUnitArchive,
  type OldGenUnitManifest
} from '../logue-codegen/src/sysex/unitArchive'
import { buildMinilogueXdUnitBody } from '../logue-codegen/src/sysex/minilogueXdUnitBody'
import { zipStored } from '../logue-codegen/src/sysex/unitBackup'
import {
  apiVersionRequest,
  clearModuleRequest,
  clearSlotRequest,
  moduleInfoRequest,
  parseLogueSysexReply,
  searchDeviceRequest,
  slotDataUpload,
  slotStatusRequest,
  stripStrayEox,
  swapSlotsRequest
} from '../logue-codegen/src/sysex/korgUserUnitMessages'
import { generateOldGenOscUnit } from '../logue-codegen/src/minilogue-xd/generateOscUnit'
import { LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import {
  canonicalPrimitiveId,
  findLoguePrimitive,
  recognizedLoguePrimitiveIds
} from '../logue-codegen/src/primitives'
import type { ObjNode, PatchDocument } from '../src/shared/domain/patch'

/**
 * Every `*.upload.syx` fixture is logue-cli's own captured bytes (`logue-codegen/harness/
 * sysex-emu/PROTOCOL.md`) -- ground truth for the host->device direction. The transcripts' `<<`
 * lines were written by the capture rig's fake device and are NOT used here as reply fixtures;
 * reply-parsing tests below construct their inputs by hand from the spec/logue-cli framings.
 */
const FIXTURES = join(__dirname, 'fixtures/logue-sysex/minilogue-xd')
const hex = (s: string): Uint8Array =>
  Uint8Array.from(
    s
      .trim()
      .split(/\s+/)
      .map((b) => parseInt(b, 16))
  )
const u32 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24]
const XD_HDR = [0xf0, 0x42, 0x30, 0x00, 0x01, 0x51]

function sentByLogueCli(transcript: string): Uint8Array[] {
  return readFileSync(join(FIXTURES, transcript), 'utf-8')
    .split('\n')
    .filter((l) => l.startsWith('>>'))
    .map((l) => hex(l.split('] ')[1]))
}

describe('pack7', () => {
  it('round-trips arbitrary data, including short final groups', () => {
    for (const len of [0, 1, 6, 7, 8, 13, 14, 100]) {
      const data = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 0x80) & 0xff)
      const packed = pack7(data)
      expect(packed.length).toBe(packedLength(len))
      expect(packed.every((b) => b < 0x80)).toBe(true)
      expect(unpack7(packed)).toEqual(data)
    }
  })

  it('puts byte j of a group into bit j of its leading MSB byte (NOTE 1)', () => {
    expect([...pack7(Uint8Array.from([0x00, 0xc0, 0x00, 0x00, 0x00, 0x80, 0x00, 0x81]))]).toEqual([
      0x22, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01
    ])
  })
})

describe('crc32', () => {
  it('is the standard zlib/IEEE variant', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array())).toBe(0)
  })
})

describe('minilogue xd upload encoding vs captured logue-cli traffic', () => {
  const syxFiles = readdirSync(FIXTURES).filter((f) => f.endsWith('.upload.syx'))

  it('has all the captured fixtures', () => {
    expect(syxFiles.length).toBe(10)
  })

  for (const syx of syxFiles) {
    it(`reproduces ${syx} byte-for-byte`, async () => {
      const captured = new Uint8Array(readFileSync(join(FIXTURES, syx)))
      const unit = await readOldGenUnitArchive(
        new Uint8Array(readFileSync(join(FIXTURES, syx.replace('.upload.syx', '.mnlgxdunit'))))
      )
      const body = buildMinilogueXdUnitBody(unit.manifest, unit.payload)
      expect(slotDataUpload('minilogue-xd', unit.module, captured[8], body)).toEqual(captured)
    })
  }
})

describe('minilogue xd request messages vs captured logue-cli traffic', () => {
  const sent = sentByLogueCli('string.transcript.txt')

  it('handshake requests', () => {
    expect(sent[0]).toEqual(searchDeviceRequest(0x55))
    expect(sent[1]).toEqual(apiVersionRequest('minilogue-xd'))
    expect(sent[6]).toEqual(moduleInfoRequest('minilogue-xd', 'osc'))
    expect(sent).toContainEqual(slotStatusRequest('minilogue-xd', 'revfx', 7))
  })

  it('clear slot / clear module', () => {
    expect(sentByLogueCli('clear-osc-slot9.transcript.txt')).toContainEqual(
      clearSlotRequest('minilogue-xd', 'osc', 9)
    )
    expect(sentByLogueCli('clear-delfx-all.transcript.txt')).toContainEqual(
      clearModuleRequest('minilogue-xd', 'delfx')
    )
  })

  it('swap matches the spec (uncaptured: logue-cli has no swap command)', () => {
    expect([...swapSlotsRequest('minilogue-xd', 'osc', 2, 5)]).toEqual([
      ...XD_HDR,
      0x1e,
      4,
      2,
      5,
      0xf7
    ])
  })

  it('rejects out-of-range slots per module', () => {
    expect(() => slotStatusRequest('minilogue-xd', 'osc', 16)).toThrow(/out of range/)
    expect(() => clearSlotRequest('minilogue-xd', 'delfx', 8)).toThrow(/out of range/)
    expect(() => slotStatusRequest('minilogue-xd', 'delfx', 7)).not.toThrow()
  })
})

describe('minilogue xd unit body validation', () => {
  const manifest = (overrides: Partial<OldGenUnitManifest['header']>): OldGenUnitManifest => ({
    header: {
      platform: 'minilogue-xd',
      module: 'osc',
      api: '1.1-0',
      dev_id: 0,
      prg_id: 0,
      version: '1.0-0',
      name: 'x',
      num_param: 0,
      params: [],
      ...overrides
    }
  })
  const payload = Uint8Array.from([...new TextEncoder().encode('UOSC'), 1, 2, 3])

  it("reads an effect package's module from its manifest, whatever the folder, with no params key", async () => {
    const enc = new TextEncoder()
    const fxManifest = {
      header: {
        platform: 'minilogue-xd',
        module: 'delfx',
        api: '1.1-0',
        dev_id: 0,
        prg_id: 0,
        version: '1.0-0',
        name: 'LP Echo',
        num_param: 0
      }
    }
    const fxPayload = Uint8Array.from([...enc.encode('UDEL'), 9, 9])
    const unit = await readOldGenUnitArchive(
      zipStored([
        { name: 'fx/manifest.json', bytes: enc.encode(JSON.stringify(fxManifest)) },
        { name: 'fx/payload.bin', bytes: fxPayload }
      ])
    )
    expect(unit.module).toBe('delfx')
    const body = buildMinilogueXdUnitBody(unit.manifest, unit.payload)
    expect(body[0]).toBe(2)
    expect(new DataView(body.buffer).getUint32(0x20, true)).toBe(0)
  })

  it('rejects a payload whose magic disagrees with the manifest module', () => {
    expect(() => buildMinilogueXdUnitBody(manifest({ module: 'modfx' }), payload)).toThrow(/magic/)
  })

  it("rejects a param range that would not fit the header's signed bytes", () => {
    const m = manifest({ num_param: 1, params: [['P', 0, 1023, '%']] })
    expect(() => buildMinilogueXdUnitBody(m, payload)).toThrow(/signed byte/)
  })

  it('rejects an unknown param unit instead of guessing its type byte', () => {
    const m = manifest({ num_param: 1, params: [['P', 0, 10, 'dB']] })
    expect(() => buildMinilogueXdUnitBody(m, payload)).toThrow(/only "%" and ""/)
  })

  it('rejects more than 6 params or a num_param mismatch', () => {
    const rows = Array.from(
      { length: 7 },
      (_, i) => [`P${i}`, 0, 1, ''] as [string, number, number, string]
    )
    expect(() =>
      buildMinilogueXdUnitBody(manifest({ num_param: 7, params: rows }), payload)
    ).toThrow(/max 6/)
    expect(() =>
      buildMinilogueXdUnitBody(manifest({ num_param: 2, params: rows.slice(0, 1) }), payload)
    ).toThrow(/must agree/)
  })

  it('lays out 1024-byte header + payload + 132-byte zero trailer', () => {
    const body = buildMinilogueXdUnitBody(manifest({}), payload)
    expect(body.length).toBe(1024 + payload.length + 132)
    expect([...body.subarray(1020, 1024)]).toEqual(u32(payload.length))
    expect(body.subarray(1024, 1024 + payload.length)).toEqual(payload)
  })
})

/**
 * The codec's own fixtures prove it matches logue-cli; this proves it accepts what logue-patcher's
 * OWN generator will actually feed it. Every xd-compatible primitive's every param is exposed alone
 * and pushed through the body builder, so a future param spec past its signed-byte min/max (or an
 * unexpected unit string) fails here instead of on the first real upload.
 */
describe('generated minilogue xd manifests fit the upload header', () => {
  const ids = [...new Set(recognizedLoguePrimitiveIds().map(canonicalPrimitiveId))]
  const payload = Uint8Array.from([...new TextEncoder().encode('UOSC'), 0])
  for (const id of ids) {
    const prim = findLoguePrimitive(id)!
    if (prim.platforms && !prim.platforms.includes('minilogue-xd')) continue
    if (prim.modules && !prim.modules.includes('osc')) continue
    for (const spec of prim.params ?? []) {
      it(`${id} ${spec.name}`, () => {
        const node: ObjNode = {
          kind: 'obj',
          type: id,
          name: 'n',
          x: 0,
          y: 0,
          params: [
            {
              name: spec.name,
              value: String(spec.default),
              logueParamIndex: { 'minilogue-xd': 0 },
              ...(spec.freeLabel ? { label: 'LABEL' } : {})
            }
          ],
          ...(prim.instanceProblem ? { sample: testSampleFor(prim) ?? testSampleAsset() } : {})
        }
        const out: ObjNode = {
          kind: 'obj',
          type: LOGUE_AUDIO_OUT_TYPE,
          name: 'out',
          x: 0,
          y: 0,
          params: []
        }
        const doc: PatchDocument = {
          nodes: [node, out],
          nets: [
            {
              sources: [{ obj: 'n', outlet: prim.outlets?.[0]?.name ?? 'out' }],
              dests: [{ obj: 'out', inlet: 'in' }]
            }
          ],
          settings: {},
          notes: ''
        }
        const { manifestJson } = generateOldGenOscUnit(doc, { name: 'sweep' })
        const manifest = JSON.parse(manifestJson) as OldGenUnitManifest
        expect(manifest.header.num_param).toBe(1)
        expect(() => buildMinilogueXdUnitBody(manifest, payload)).not.toThrow()
      })
    }
  }
})

describe('reply parsing', () => {
  const reply = (fn: number, data: number[]): Uint8Array =>
    Uint8Array.from([...XD_HDR, fn, ...data, 0xf7])
  const moduleInfo = [...u32(0xc123), ...u32(0x8765), 16]

  it('ACK/NAK status', () => {
    expect(parseLogueSysexReply('minilogue-xd', reply(0x23, []))).toMatchObject({
      kind: 'status',
      ok: true
    })
    expect(parseLogueSysexReply('minilogue-xd', reply(0x28, []))).toMatchObject({
      kind: 'status',
      ok: false,
      name: 'USER DATA CRC ERROR'
    })
  })

  it('API version', () => {
    expect(parseLogueSysexReply('minilogue-xd', reply(0x47, [2, 1, 2, 0]))).toEqual({
      kind: 'apiVersion',
      platformId: 2,
      version: { major: 1, minor: 2, patch: 0 }
    })
  })

  it('module info in both the spec framing and the framing logue-cli required', () => {
    const expected = {
      kind: 'moduleInfo',
      maxPayloadSize: 0xc123,
      maxLoadSize: 0x8765,
      slotCount: 16
    }
    const bare = [...pack7(Uint8Array.from(moduleInfo))]
    expect(parseLogueSysexReply('minilogue-xd', reply(0x48, bare))).toEqual(expected)
    expect(parseLogueSysexReply('minilogue-xd', reply(0x48, [4, 0, ...bare]))).toEqual(expected)
    expect(
      parseLogueSysexReply(
        'minilogue-xd',
        reply(0x48, [4, 0, ...pack7(Uint8Array.from([...moduleInfo, 0]))])
      )
    ).toEqual(expected)
    // Table 5's own 10-byte reading (slot count as offsets 8-9), unprefixed.
    expect(
      parseLogueSysexReply(
        'minilogue-xd',
        reply(0x48, [...pack7(Uint8Array.from([...moduleInfo, 0]))])
      )
    ).toEqual(expected)
  })

  it('slot status in both framings, and an all-zero slot as empty', () => {
    const st = Uint8Array.from([
      4,
      2,
      ...u32(0x00010100),
      ...u32(0x11223344),
      ...u32(0x55667788),
      ...u32(0x00020304),
      ...new TextEncoder().encode('SLOTNAME'),
      0,
      0,
      0,
      0,
      0,
      0
    ])
    const expected = {
      kind: 'slotStatus',
      module: 'osc',
      slot: 2,
      status: {
        empty: false,
        target: 0x0204,
        api: { major: 1, minor: 1, patch: 0 },
        devId: 0x11223344,
        programId: 0x55667788,
        version: { major: 2, minor: 3, patch: 4 },
        name: 'SLOTNAME'
      }
    }
    expect(parseLogueSysexReply('minilogue-xd', reply(0x49, [4, 2, ...pack7(st)]))).toEqual(
      expected
    )
    expect(parseLogueSysexReply('minilogue-xd', reply(0x49, [4, 2, 0, ...pack7(st)]))).toEqual(
      expected
    )
    const empty = parseLogueSysexReply(
      'minilogue-xd',
      reply(0x49, [4, 3, 0, ...pack7(new Uint8Array(32))])
    )
    expect(empty).toMatchObject({ kind: 'slotStatus', slot: 3, status: { empty: true, name: '' } })
  })

  it('points an NTS-1 mkII upload at the chunked encoder', () => {
    expect(() => slotDataUpload('nts1mkii', 'osc', 0, new Uint8Array(4))).toThrow(
      /slotDataUploadChunks/
    )
  })

  it('search device reply identifies the platform by family ID', () => {
    expect(
      parseLogueSysexReply('minilogue-xd', hex('F0 42 50 01 00 55 51 01 00 00 02 00 01 00 F7'))
    ).toMatchObject({
      kind: 'searchDeviceReply',
      echoId: 0x55,
      platform: 'minilogue-xd'
    })
    expect(
      parseLogueSysexReply('minilogue-xd', hex('F0 42 50 01 00 55 73 01 01 00 00 00 01 00 F7'))
    ).toMatchObject({
      platform: 'nts1mkii'
    })
  })

  it("ignores other devices' and non-Korg messages, throws on a malformed one addressed to it", () => {
    expect(parseLogueSysexReply('minilogue-xd', hex('F0 42 30 00 01 73 23 F7'))).toBeUndefined()
    expect(parseLogueSysexReply('minilogue-xd', hex('F0 7E 00 06 02 F7'))).toBeUndefined()
    expect(() => parseLogueSysexReply('minilogue-xd', reply(0x48, [1, 2, 3]))).toThrow(
      /no known framing/
    )
  })
})

/**
 * Real minilogue xd replies (read-only requests, captured 2026-09-25 from the user's own device on
 * global channel 2) -- the first device->host ground truth. Everything above that constructs replies
 * by hand only proves the parser accepts the framings it was written for; this proves the one a
 * real device actually sends.
 */
describe('reply parsing vs a real minilogue xd', () => {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, 'real-device-replies.json'), 'utf-8')) as {
    replies: Record<string, string>
  }
  const parse = (key: string): ReturnType<typeof parseLogueSysexReply> =>
    parseLogueSysexReply('minilogue-xd', hex(fixture.replies[key]))

  it('search device reply carries the global channel', () => {
    expect(parse('searchDeviceReply')).toMatchObject({
      platform: 'minilogue-xd',
      channel: 2,
      echoId: 6
    })
  })

  it('API version', () => {
    expect(parse('api')).toEqual({
      kind: 'apiVersion',
      platformId: 2,
      version: { major: 1, minor: 1, patch: 0 }
    })
  })

  it('module info: `48 <module> 00 pack7(9 bytes)`, osc load size = the 32 KB SRAM budget', () => {
    expect(parse('mod4')).toEqual({
      kind: 'moduleInfo',
      maxPayloadSize: 36848,
      maxLoadSize: 32768,
      slotCount: 16
    })
    expect(parse('mod1')).toEqual({
      kind: 'moduleInfo',
      maxPayloadSize: 8180,
      maxLoadSize: 6144,
      slotCount: 16
    })
    expect(parse('mod2')).toEqual({
      kind: 'moduleInfo',
      maxPayloadSize: 16368,
      maxLoadSize: 12288,
      slotCount: 8
    })
  })

  it('slot status: `49 <module> <slot> 00 pack7(32)`, bytes 0-1 = target (module, platform)', () => {
    expect(parse('osc0')).toEqual({
      kind: 'slotStatus',
      module: 'osc',
      slot: 0,
      status: {
        empty: false,
        target: 0x0204,
        api: { major: 1, minor: 1, patch: 0 },
        devId: 0,
        programId: 0,
        version: { major: 1, minor: 0, patch: 0 },
        name: 'string'
      }
    })
    // A prologue-built unit (platform 1) installed on the xd.
    expect(parse('osc14')).toMatchObject({ slot: 14, status: { target: 0x0104, name: 'Physiq' } })
    expect(parse('mod1slot0')).toMatchObject({
      module: 'modfx',
      status: { target: 0x0101, version: { major: 1, minor: 0, patch: 1 }, name: 'Hera' }
    })
  })

  it("an empty slot's status is a bare `49 <module> <slot>` with no data", () => {
    expect(parse('modfx2empty')).toMatchObject({
      kind: 'slotStatus',
      module: 'modfx',
      slot: 2,
      status: { empty: true, name: '' }
    })
  })

  it('every captured osc slot parses', () => {
    for (let s = 0; s < 16; s++)
      expect(parse(`osc${s}`)).toMatchObject({ kind: 'slotStatus', slot: s })
  })
})

/**
 * A real minilogue xd's answer to `1A 04 00` (osc slot 1, holding the user's own `string` unit, the
 * same file as `string.mnlgxdunit` here), recorded as the RAW byte stream: stray `F7`s included,
 * exactly as CoreMIDI delivered it.
 */
describe('slot download vs a real minilogue xd', () => {
  const raw = new Uint8Array(readFileSync(join(FIXTURES, 'real-download-osc-slot1-string.raw')))

  it('the raw stream carries stray F7s that would truncate a naive parse', () => {
    expect(raw.filter((b) => b === 0xf7).length).toBeGreaterThan(1)
    const firstEox = raw.indexOf(0xf7)
    expect(() => parseLogueSysexReply('minilogue-xd', raw.subarray(0, firstEox + 1))).toThrow(
      /declares 3692 bytes/
    )
  })

  it('after stripStrayEox, the body is byte-identical to what an upload of the same unit sends', async () => {
    const reply = parseLogueSysexReply('minilogue-xd', stripStrayEox(raw))
    const unit = await readOldGenUnitArchive(
      new Uint8Array(readFileSync(join(FIXTURES, 'string.mnlgxdunit')))
    )
    expect(reply).toMatchObject({ kind: 'slotData', module: 'osc', slot: 0 })
    if (reply?.kind !== 'slotData') throw new Error('unreachable')
    expect(reply.body).toEqual(buildMinilogueXdUnitBody(unit.manifest, unit.payload))
    // Recorded as-is: NOT zlib CRC-32 of the body (0xc7455bf2), and not yet identified.
    expect(reply.deviceChecksum).toBe(0xf7a289fc)
  })

  it('an empty slot answers with no data at all', () => {
    const empty = new Uint8Array(
      readFileSync(join(FIXTURES, 'real-download-modfx-slot3-empty.raw'))
    )
    expect(parseLogueSysexReply('minilogue-xd', empty)).toEqual({
      kind: 'slotData',
      module: 'modfx',
      slot: 2
    })
  })
})

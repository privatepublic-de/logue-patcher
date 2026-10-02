/**
 * Builders and a reply parser for the *logue "user unit" SysEx family (function IDs 17-1E /
 * 47-4A / 2x) that both the minilogue xd and NTS-1 mkII share, differing only in family ID and
 * platform ID. Dependency-free and transport-agnostic (plain `Uint8Array` in and out) so the same
 * code runs under Web MIDI in the renderer and in plain Node tests.
 *
 * Confidence differs per direction -- see `logue-codegen/harness/sysex-emu/PROTOCOL.md`:
 * host->device messages are byte-exact against captured logue-cli traffic (minilogue xd only);
 * device->host parsing is written against the published spec plus what logue-cli's parser
 * accepted, never against a real device yet. The NTS-1 mkII entry is spec-only.
 */
import type { LoguePlatform } from '../primitives'
import { crc32 } from './crc32'
import { pack7, packedLength, unpack7 } from './pack7'

export type LogueUnitModule = 'modfx' | 'delfx' | 'revfx' | 'osc'

export const LOGUE_UNIT_MODULE_IDS: Record<LogueUnitModule, number> = {
  modfx: 1,
  delfx: 2,
  revfx: 3,
  osc: 4
}

const MODULE_BY_ID = new Map(
  Object.entries(LOGUE_UNIT_MODULE_IDS).map(([m, id]) => [id, m as LogueUnitModule])
)

/** Per the spec's own slot-ID ranges (`modfx/osc:0-15, delfx/revfx:0-7`). */
const SLOT_COUNT: Record<LogueUnitModule, number> = { modfx: 16, delfx: 8, revfx: 8, osc: 16 }

interface SysexPlatform {
  familyId: number
  platformId: number
}

export const SYSEX_PLATFORMS: Record<LoguePlatform, SysexPlatform> = {
  'minilogue-xd': { familyId: 0x51, platformId: 2 },
  nts1mkii: { familyId: 0x73, platformId: 5 }
}

const KORG = 0x42
const EOX = 0xf7

export class SysexError extends Error {}

function header(platform: LoguePlatform, channel: number): number[] {
  if (!Number.isInteger(channel) || channel < 0 || channel > 15) {
    throw new SysexError(`Global MIDI channel ${channel} is out of range 0-15.`)
  }
  return [0xf0, KORG, 0x30 | channel, 0x00, 0x01, SYSEX_PLATFORMS[platform].familyId]
}

function checkSlot(module: LogueUnitModule, slot: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT[module]) {
    throw new SysexError(
      `Slot ${slot} is out of range for ${module} (0-${SLOT_COUNT[module] - 1}).`
    )
  }
}

function message(platform: LoguePlatform, channel: number, body: number[]): Uint8Array {
  return Uint8Array.from([...header(platform, channel), ...body, EOX])
}

/** Platform-independent; every Korg device on the port answers with its own family ID. */
export function searchDeviceRequest(echoId: number): Uint8Array {
  return Uint8Array.from([0xf0, KORG, 0x50, 0x00, echoId & 0x7f, EOX])
}

export function apiVersionRequest(platform: LoguePlatform, channel = 0): Uint8Array {
  return message(platform, channel, [0x17])
}

export function moduleInfoRequest(
  platform: LoguePlatform,
  module: LogueUnitModule,
  channel = 0
): Uint8Array {
  return message(platform, channel, [0x18, LOGUE_UNIT_MODULE_IDS[module]])
}

export function slotStatusRequest(
  platform: LoguePlatform,
  module: LogueUnitModule,
  slot: number,
  channel = 0
): Uint8Array {
  checkSlot(module, slot)
  return message(platform, channel, [0x19, LOGUE_UNIT_MODULE_IDS[module], slot])
}

export function slotDataRequest(
  platform: LoguePlatform,
  module: LogueUnitModule,
  slot: number,
  channel = 0
): Uint8Array {
  checkSlot(module, slot)
  return message(platform, channel, [0x1a, LOGUE_UNIT_MODULE_IDS[module], slot])
}

export function clearSlotRequest(
  platform: LoguePlatform,
  module: LogueUnitModule,
  slot: number,
  channel = 0
): Uint8Array {
  checkSlot(module, slot)
  return message(platform, channel, [0x1b, LOGUE_UNIT_MODULE_IDS[module], slot])
}

export function clearModuleRequest(
  platform: LoguePlatform,
  module: LogueUnitModule,
  channel = 0
): Uint8Array {
  return message(platform, channel, [0x1d, LOGUE_UNIT_MODULE_IDS[module]])
}

export function swapSlotsRequest(
  platform: LoguePlatform,
  module: LogueUnitModule,
  slotA: number,
  slotB: number,
  channel = 0
): Uint8Array {
  checkSlot(module, slotA)
  checkSlot(module, slotB)
  return message(platform, channel, [0x1e, LOGUE_UNIT_MODULE_IDS[module], slotA, slotB])
}

/**
 * The upload itself: `4A <module> <slot> pack7(size, crc32, body, 00)`. The trailing `00` is packed
 * but not counted in `size` -- logue-cli sends it on every capture, reason unknown, so it's kept
 * for byte-exactness rather than dropped on a guess. `body` is platform-specific
 * (`buildMinilogueXdUnitBody` for the xd); this function doesn't interpret it.
 */
export function slotDataUpload(
  platform: LoguePlatform,
  module: LogueUnitModule,
  slot: number,
  body: Uint8Array,
  channel = 0
): Uint8Array {
  // The NTS-1 mkII uses a different, chunked framing -- see slotDataUploadChunks.
  if (platform !== 'minilogue-xd') {
    throw new SysexError(`Use slotDataUploadChunks for ${platform}: its upload is chunked.`)
  }
  checkSlot(module, slot)
  const framed = new Uint8Array(8 + body.length + 1)
  const view = new DataView(framed.buffer)
  view.setUint32(0, body.length, true)
  view.setUint32(4, crc32(body), true)
  framed.set(body, 8)
  const packed = pack7(framed)
  const out = new Uint8Array(6 + 3 + packed.length + 1)
  out.set(header(platform, channel), 0)
  out.set([0x4a, LOGUE_UNIT_MODULE_IDS[module], slot], 6)
  out.set(packed, 9)
  out[out.length - 1] = EOX
  return out
}

/** Largest message the NTS-1 mkII sends or accepts (both directions were captured at exactly this). */
const NTS1MKII_MAX_MESSAGE = 4096
/** `F0 42 3g 00 01 73 4A <module> <slot> <index> <last>` + `F7` around each chunk's packed data. */
const NTS1MKII_CHUNK_OVERHEAD = 12
/** 3573: the most decoded bytes whose packed form still fits one 4096-byte message. */
const NTS1MKII_CHUNK_DATA = Math.floor(((NTS1MKII_MAX_MESSAGE - NTS1MKII_CHUNK_OVERHEAD) * 7) / 8)

/**
 * Every message needed to upload `body` into a slot, in order; the device ACKs each before the
 * next may go (see `LogueDeviceSession.upload`).
 *
 * - **minilogue xd:** one message (`slotDataUpload`).
 * - **NTS-1 mkII:** captured from KORG KONTROL Editor 2.5.0 through a logging proxy
 *   (PROTOCOL-nts1mkii.md). Framing is `4A <module> <slot> <index> <last> pack7(chunk)`, the mirror
 *   of the download: `size:u32, checksum:u32 = 0, body` split into 3573-byte chunks, each packed
 *   separately. `body` is the `.nts1mkiiunit` file verbatim. Byte-exact against the captured
 *   messages in test/logue-nts1mkiiDevice.spec.ts.
 */
export function slotDataUploadChunks(
  platform: LoguePlatform,
  module: LogueUnitModule,
  slot: number,
  body: Uint8Array,
  channel = 0
): Uint8Array[] {
  if (platform === 'minilogue-xd') return [slotDataUpload(platform, module, slot, body, channel)]
  checkSlot(module, slot)
  const framed = new Uint8Array(8 + body.length)
  new DataView(framed.buffer).setUint32(0, body.length, true)
  framed.set(body, 8)
  const count = Math.ceil(framed.length / NTS1MKII_CHUNK_DATA)
  if (count > 128)
    throw new SysexError(`A ${body.length}-byte unit needs ${count} chunks; at most 128 fit.`)
  return Array.from({ length: count }, (_, i) => {
    const packed = pack7(framed.subarray(i * NTS1MKII_CHUNK_DATA, (i + 1) * NTS1MKII_CHUNK_DATA))
    const msg = new Uint8Array(NTS1MKII_CHUNK_OVERHEAD + packed.length)
    msg.set(header(platform, channel), 0)
    msg.set([0x4a, LOGUE_UNIT_MODULE_IDS[module], slot, i, count - 1], 6)
    msg.set(packed, 11)
    msg[msg.length - 1] = EOX
    return msg
  })
}

export const STATUS_NAMES: Record<number, string> = {
  0x23: 'DATA LOAD COMPLETED',
  0x24: 'DATA LOAD ERROR',
  0x26: 'DATA FORMAT ERROR',
  0x27: 'USER DATA SIZE ERROR',
  0x28: 'USER DATA CRC ERROR',
  0x29: 'USER TARGET ERROR',
  0x2a: 'USER API ERROR',
  0x2b: 'USER LOAD SIZE ERROR',
  0x2c: 'USER MODULE ERROR',
  0x2d: 'USER SLOT ERROR',
  0x2e: 'USER FORMAT ERROR',
  0x2f: 'USER INTERNAL ERROR'
}

export interface SemVer {
  major: number
  minor: number
  patch: number
}

export interface SlotStatus {
  /** A real xd sends no status data at all for an empty slot; an all-zero status (how logue-cli renders one) is treated the same. */
  empty: boolean
  /**
   * Bytes 0-1 as the SDK's `target` (`platform<<8 | module`, u16 LE) -- the order the upload header
   * provably uses, NOT Table 6's "platform, module" wording, which is unconfirmed against a device.
   */
  target: number
  api: SemVer
  devId: number
  programId: number
  version: SemVer
  name: string
}

export type LogueSysexReply =
  | {
      kind: 'searchDeviceReply'
      echoId: number
      channel: number
      familyId: number
      platform?: LoguePlatform
      firmware: { major: number; minor: number }
    }
  | { kind: 'status'; code: number; ok: boolean; name: string }
  | { kind: 'apiVersion'; platformId: number; version: SemVer }
  | { kind: 'moduleInfo'; maxPayloadSize: number; maxLoadSize: number; slotCount: number }
  | { kind: 'slotStatus'; module?: LogueUnitModule; slot: number; status: SlotStatus }
  | {
      kind: 'slotData'
      module?: LogueUnitModule
      slot: number
      /** Undefined for an empty slot (the device answers with no data at all). */
      body?: Uint8Array
      /** The device's own checksum field, which is NOT zlib CRC-32 of `body` (see parseSlotData). */
      deviceChecksum?: number
    }
  | {
      kind: 'slotDataChunk'
      module?: LogueUnitModule
      slot: number
      index: number
      last: number
      data: Uint8Array
    }
  | { kind: 'other'; functionId: number }

const u32le = (b: Uint8Array, o: number): number =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0

const semver = (v: number): SemVer => ({
  major: v >>> 16,
  minor: (v >>> 8) & 0xff,
  patch: v & 0xff
})

/**
 * Returns `undefined` for anything that isn't a Korg user-unit reply from THIS platform (so a live
 * MIDI listener can feed it every incoming message), and throws `SysexError` for a message that is
 * addressed to it but malformed.
 */
export function parseLogueSysexReply(
  platform: LoguePlatform,
  msg: Uint8Array
): LogueSysexReply | undefined {
  if (msg.length < 3 || msg[0] !== 0xf0 || msg[msg.length - 1] !== EOX || msg[1] !== KORG) {
    return undefined
  }
  if (msg[2] === 0x50) return parseSearchDeviceReply(msg)

  const family = SYSEX_PLATFORMS[platform].familyId
  if (
    msg.length < 8 ||
    (msg[2] & 0xf0) !== 0x30 ||
    msg[3] !== 0 ||
    msg[4] !== 1 ||
    msg[5] !== family
  ) {
    return undefined
  }
  const fn = msg[6]
  const data = msg.subarray(7, msg.length - 1)

  if (fn >= 0x20 && fn <= 0x2f) {
    return {
      kind: 'status',
      code: fn,
      ok: fn === 0x23,
      name: STATUS_NAMES[fn] ?? `STATUS ${fn.toString(16)}`
    }
  }
  switch (fn) {
    case 0x47:
      if (data.length !== 4)
        throw new SysexError(`USER API VERSION has ${data.length} data bytes, expected 4.`)
      return {
        kind: 'apiVersion',
        platformId: data[0],
        version: { major: data[1], minor: data[2], patch: data[3] }
      }
    case 0x48:
      return parseModuleInfo(data)
    case 0x49:
      return platform === 'nts1mkii' ? parseUnitHeaderStatus(data) : parseSlotStatus(data)
    case 0x4a:
      return platform === 'nts1mkii' ? parseSlotDataChunk(data) : parseSlotData(data)
    default:
      return { kind: 'other', functionId: fn }
  }
}

function parseSearchDeviceReply(msg: Uint8Array): LogueSysexReply | undefined {
  if (msg.length !== 15 || msg[3] !== 0x01) return undefined
  const familyId = msg[6]
  const platform = (Object.keys(SYSEX_PLATFORMS) as LoguePlatform[]).find(
    (p) => SYSEX_PLATFORMS[p].familyId === familyId && msg[7] === 0x01
  )
  return {
    kind: 'searchDeviceReply',
    echoId: msg[5],
    channel: msg[4] & 0x0f,
    familyId,
    platform,
    firmware: { minor: msg[10] | (msg[11] << 7), major: msg[12] | (msg[13] << 7) }
  }
}

/**
 * The spec frames USER MODULE INFO as bare packed data, but logue-cli's parser only accepted
 * `<module> <?> pack7(...)`, which has two extra raw bytes. The xd spec also contradicts itself on
 * the payload length: its message text says 9 bytes, but Table 5's offsets run to 8-9 (10 bytes).
 * Real devices settled it for both platforms: `48 <module> 00 pack7(...)`, the logue-cli framing.
 * The payload is 9 bytes on the minilogue xd and 12 on the NTS-1 mkII (slot count as u32). The bare
 * spec framing (11/12 bytes) is still accepted, told apart by length: prefixed replies are 13-16
 * bytes, and no real device sends a bare 13 or 14.
 */
function parseModuleInfo(data: Uint8Array): LogueSysexReply {
  const bare = [packedLength(9), packedLength(10)]
  const prefixed = [9, 10, 11, 12].map((n) => 2 + packedLength(n))
  let prefix: number
  if (bare.includes(data.length)) prefix = 0
  else if (prefixed.includes(data.length)) prefix = 2
  else
    throw new SysexError(`USER MODULE INFO has ${data.length} data bytes; no known framing fits.`)
  const d = unpack7(data.subarray(prefix))
  return {
    kind: 'moduleInfo',
    maxPayloadSize: u32le(d, 0),
    maxLoadSize: u32le(d, 4),
    slotCount: d[8]
  }
}

const EMPTY_SLOT: SlotStatus = {
  empty: true,
  target: 0,
  api: { major: 0, minor: 0, patch: 0 },
  devId: 0,
  programId: 0,
  version: { major: 0, minor: 0, patch: 0 },
  name: ''
}

/** Same spec-vs-logue-cli disagreement as `parseModuleInfo`, one raw byte further along. */
function parseSlotStatus(data: Uint8Array): LogueSysexReply {
  // A real xd answers an EMPTY slot with a bare `49 <module> <slot>` -- no data at all (captured).
  if (data.length === 2) {
    return {
      kind: 'slotStatus',
      module: MODULE_BY_ID.get(data[0]),
      slot: data[1],
      status: EMPTY_SLOT
    }
  }
  const packed = packedLength(32)
  let prefix: number
  if (data.length === 2 + packed) prefix = 2
  else if (data.length === 3 + packed) prefix = 3
  else
    throw new SysexError(`USER SLOT STATUS has ${data.length} data bytes; no known framing fits.`)
  const d = unpack7(data.subarray(prefix))
  const nameBytes = d.subarray(18, 32)
  const nul = nameBytes.indexOf(0)
  return {
    kind: 'slotStatus',
    module: MODULE_BY_ID.get(data[0]),
    slot: data[1],
    status: {
      empty: d.every((b) => b === 0),
      target: d[0] | (d[1] << 8),
      api: semver(u32le(d, 2)),
      devId: u32le(d, 6),
      programId: u32le(d, 10),
      version: semver(u32le(d, 14)),
      name: String.fromCharCode(...(nul < 0 ? nameBytes : nameBytes.subarray(0, nul)))
    }
  }
}

/**
 * Captured from a real minilogue xd (PROTOCOL.md): `4A <module> <slot> 00 pack7(size, checksum,
 * body)`, with 3 raw bytes like `49`, unlike the 2 an upload uses, and no trailing pad. An empty
 * slot is a bare `4A <module> <slot>`. `body` is byte-identical to what an upload of the same
 * unit sends, but the checksum field doesn't match zlib CRC-32 (or any common CRC-32 variant tried)
 * over any region of it. It's reported, not verified. Callers must get integrity another way; see
 * `stripStrayEox` for why this matters on real hardware.
 */
function parseSlotData(data: Uint8Array): LogueSysexReply {
  if (data.length === 2) {
    return { kind: 'slotData', module: MODULE_BY_ID.get(data[0]), slot: data[1] }
  }
  if (data.length < 3 + packedLength(8)) throw new SysexError('USER SLOT DATA is too short.')
  const d = unpack7(data.subarray(3))
  const size = u32le(d, 0)
  if (8 + size > d.length) {
    throw new SysexError(`USER SLOT DATA declares ${size} bytes but carries ${d.length - 8}.`)
  }
  return {
    kind: 'slotData',
    module: MODULE_BY_ID.get(data[0]),
    slot: data[1],
    body: d.slice(8, 8 + size),
    deviceChecksum: u32le(d, 4)
  }
}

/**
 * NTS-1 mkII slot status (captured from a real device): `49 <module> <slot> 00 pack7(unit_header_t)`.
 * The payload is the unit's whole 408-byte `unit_header_t` (logue-sdk runtime.h), NOT the spec
 * Table 4's 32 bytes. Empty slots are bare, as on the xd.
 */
function parseUnitHeaderStatus(data: Uint8Array): LogueSysexReply {
  const module = MODULE_BY_ID.get(data[0])
  if (data.length === 2) return { kind: 'slotStatus', module, slot: data[1], status: EMPTY_SLOT }
  if (data.length < 3 + packedLength(44)) {
    throw new SysexError(
      `USER SLOT STATUS has ${data.length} data bytes; too short for a unit header.`
    )
  }
  const d = unpack7(data.subarray(3))
  return { kind: 'slotStatus', module, slot: data[1], status: unitHeaderStatus(d) }
}

/**
 * `unit_header_t` (logue-sdk platform/nts-1_mkii/common/runtime.h): header_size, target, api,
 * dev_id, unit_id and version (all u32 LE), then name[UNIT_NAME_SIZE = 20].
 */
export function unitHeaderStatus(h: Uint8Array): SlotStatus {
  const nameBytes = h.subarray(24, 44)
  const nul = nameBytes.indexOf(0)
  return {
    empty: false,
    target: u32le(h, 4),
    api: semver(u32le(h, 8)),
    devId: u32le(h, 12),
    programId: u32le(h, 16),
    version: semver(u32le(h, 20)),
    name: String.fromCharCode(...(nul < 0 ? nameBytes : nameBytes.subarray(0, nul)))
  }
}

/**
 * NTS-1 mkII download (captured from a real device): unlike the xd's single message, it arrives as
 * `4A <module> <slot> <chunk index> <last chunk index> pack7(chunk)` messages of at most 4096 bytes.
 * The 7-bit packing restarts in each one. The decoded chunks concatenate to `size:u32, checksum:u32,
 * body`, where body is the `.nts1mkiiunit` ELF verbatim (byte-identical to the user's build files)
 * and checksum is always 0. An empty slot is a single chunk 0/0 with no data. Reassembly is the
 * caller's job (`LogueDeviceSession.downloadSlot`).
 */
function parseSlotDataChunk(data: Uint8Array): LogueSysexReply {
  if (data.length < 4) throw new SysexError('USER SLOT DATA chunk is too short.')
  return {
    kind: 'slotDataChunk',
    module: MODULE_BY_ID.get(data[0]),
    slot: data[1],
    index: data[2],
    last: data[3],
    data: unpack7(data.subarray(4))
  }
}

/** Joins an NTS-1 mkII download's decoded chunks (in order) into its body; undefined for an empty slot. */
export function joinSlotDataChunks(chunks: Uint8Array[]): Uint8Array | undefined {
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let p = 0
  for (const c of chunks) {
    all.set(c, p)
    p += c.length
  }
  if (all.length === 0) return undefined
  if (all.length < 8) throw new SysexError('USER SLOT DATA is too short.')
  const size = u32le(all, 0)
  if (all.length !== 8 + size) {
    throw new SysexError(`USER SLOT DATA declares ${size} bytes but carries ${all.length - 8}.`)
  }
  return all.slice(8)
}

/**
 * A real minilogue xd's USB MIDI output inserts stray `F7` bytes into a long SysEx stream, about one
 * per ~700 bytes at varying positions, while the data around them continues intact (verified by
 * repeat dumps giving identical bodies). Any standard SysEx parser, Chromium's Web MIDI included,
 * ends the message at the first one and drops the rest. Given the raw byte stream of ONE reply
 * (first `F0` through the true final `F7`), this drops every `F7` except the last. That's safe
 * because a packed SysEx body can never legitimately contain `F7` (every data byte is < 0x80).
 */
export function stripStrayEox(raw: Uint8Array): Uint8Array {
  const out: number[] = []
  raw.forEach((b, i) => {
    if (b !== EOX || i === raw.length - 1) out.push(b)
  })
  return Uint8Array.from(out)
}

/**
 * Rebuilds the exact USER SLOT DATA body logue-cli sends for a minilogue xd unit package: a
 * 1024-byte header derived from `manifest.json`, `payload.bin` verbatim, then 132 zero bytes. None
 * of this is in Korg's MIDI Implementation (its Table 7 just says "payload") -- every rule here
 * was captured from logue-cli's own traffic and is checked byte-for-byte against those captures
 * in `test/logue-sysex.spec.ts`. See `logue-codegen/harness/sysex-emu/PROTOCOL.md` for the
 * header's field table and the 132-byte trailer's (still unknown) meaning.
 */
import { LOGUE_UNIT_MODULE_IDS, type LogueUnitModule } from './korgUserUnitMessages'
import type { OldGenUnitManifest } from './unitArchive'

const HEADER_SIZE = 1024
const TRAILER_SIZE = 132
const MAX_PARAMS = 6
const NAME_BYTES = 14
const PARAM_NAME_BYTES = 13
/**
 * Old-gen platform IDs as the header's byte 1 carries them (the SDK's `k_unit_target_*` >> 8).
 * A minilogue xd happily stores and runs prologue-built units: the capture device had several.
 */
export const OLD_GEN_PLATFORM_IDS: Record<string, number> = {
  prologue: 1,
  'minilogue-xd': 2,
  'nutekt-digital': 3
}

/** `payload.bin`'s own first 4 bytes, which logue-cli checks against the manifest's module. */
const PAYLOAD_MAGIC: Record<LogueUnitModule, string> = {
  modfx: 'UMOD',
  delfx: 'UDEL',
  revfx: 'UREV',
  osc: 'UOSC'
}

export class UnitBodyError extends Error {}

export function buildMinilogueXdUnitBody(
  manifest: OldGenUnitManifest,
  payload: Uint8Array
): Uint8Array {
  if (manifest.header.platform !== 'minilogue-xd') {
    throw new UnitBodyError(`Manifest targets "${manifest.header.platform}", not minilogue-xd.`)
  }
  return buildOldGenUnitBody(manifest, payload)
}

/** The same body for any old-gen platform's manifest -- what a restore of a backed-up prologue unit needs. */
export function buildOldGenUnitBody(manifest: OldGenUnitManifest, payload: Uint8Array): Uint8Array {
  const h = manifest.header
  const platformId = OLD_GEN_PLATFORM_IDS[h.platform]
  if (platformId === undefined) throw new UnitBodyError(`Unknown old-gen platform "${h.platform}".`)
  const module = h.module as LogueUnitModule
  if (!(module in LOGUE_UNIT_MODULE_IDS)) throw new UnitBodyError(`Unknown module "${h.module}".`)
  const magic = String.fromCharCode(...payload.subarray(0, 4))
  if (magic !== PAYLOAD_MAGIC[module]) {
    throw new UnitBodyError(`payload.bin magic "${magic}" doesn't match module "${module}".`)
  }
  const params = h.params ?? []
  if (params.length > MAX_PARAMS || h.num_param !== params.length) {
    throw new UnitBodyError(
      `num_param ${h.num_param} / ${params.length} param rows (max ${MAX_PARAMS}, must agree).`
    )
  }

  const body = new Uint8Array(HEADER_SIZE + payload.length + TRAILER_SIZE)
  const view = new DataView(body.buffer)
  body[0] = LOGUE_UNIT_MODULE_IDS[module]
  body[1] = platformId
  view.setUint32(0x02, semverU32(h.api), true)
  view.setUint32(0x06, h.dev_id >>> 0, true)
  view.setUint32(0x0a, h.prg_id >>> 0, true)
  view.setUint32(0x0e, semverU32(h.version), true)
  // NAME_BYTES - 1 keeps a terminating NUL, exactly as logue-cli truncates; a param name gets no
  // such reserved NUL (a 13-char name was captured filling all 13 bytes).
  writeAscii(body, 0x12, h.name, NAME_BYTES - 1)
  view.setUint32(0x20, h.num_param, true)
  params.forEach(([name, min, max, unit], i) => {
    const off = 0x24 + i * 16
    view.setInt8(off, checkedInt8(name, 'min', min))
    view.setInt8(off + 1, checkedInt8(name, 'max', max))
    body[off + 2] = paramType(name, min, unit)
    writeAscii(body, off + 3, name, PARAM_NAME_BYTES)
  })
  view.setUint32(HEADER_SIZE - 4, payload.length, true)
  body.set(payload, HEADER_SIZE)
  return body
}

/** `"1.2-3"` -> `major<<16 | minor<<8 | patch`, the SDK's own `k_unit_api_*` packing. */
function semverU32(s: string): number {
  const m = /^(\d+)\.(\d+)-(\d+)$/.exec(s)
  if (!m)
    throw new UnitBodyError(`Version "${s}" isn't in the manifest's "major.minor-patch" form.`)
  const [major, minor, patch] = m.slice(1).map(Number)
  if (major > 0xffff || minor > 0xff || patch > 0xff) {
    throw new UnitBodyError(`Version "${s}" doesn't fit its packed field.`)
  }
  return ((major << 16) | (minor << 8) | patch) >>> 0
}

/**
 * logue-cli derives this rather than copying the manifest's unit string: "%" splits on sign
 * (0 unipolar, 1 bipolar), "" is typeless (2). Any other unit string has never been observed, so
 * it's rejected rather than guessed.
 */
function paramType(name: string, min: number, unit: string): number {
  if (unit === '%') return min < 0 ? 1 : 0
  if (unit === '') return 2
  throw new UnitBodyError(`Param "${name}" has unit "${unit}"; only "%" and "" are known.`)
}

// logue-cli's own out-of-range behavior is uncaptured; a silently wrapped range would bake a
// nonsense param straight onto the device, so this is loud instead.
function checkedInt8(param: string, field: string, v: number): number {
  if (!Number.isInteger(v) || v < -128 || v > 127) {
    throw new UnitBodyError(`Param "${param}" ${field}=${v} doesn't fit a signed byte.`)
  }
  return v
}

function writeAscii(dst: Uint8Array, offset: number, s: string, maxLen: number): void {
  for (let i = 0; i < Math.min(s.length, maxLen); i++) {
    const c = s.charCodeAt(i)
    if (c > 0x7f) throw new UnitBodyError(`"${s}" isn't plain ASCII.`)
    dst[offset + i] = c
  }
}

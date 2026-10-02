/**
 * Reassembles SysEx messages from a raw MIDI byte stream (arbitrary chunking, realtime bytes
 * interleaved), tolerating the stray `F7` bytes a real minilogue xd's USB MIDI output inserts into
 * long SysEx (see `stripStrayEox` and PROTOCOL.md). A standard parser ends the message at the first
 * `F7` and so loses the rest of the transfer -- which is exactly what Chromium's Web MIDI does.
 *
 * No timing heuristic is needed: the only long message in this protocol is a device->host USER SLOT
 * DATA reply (`4A <module> <slot> 00 pack7(size, checksum, body)`), whose first packed group carries
 * `size`, so its exact total length is known long before any stray `F7` can appear (the earliest
 * ever observed was ~1500 bytes in). An `F7` short of that length is dropped as stray; any other
 * message ends at its first `F7`, as usual.
 */
import { packedLength, unpack7 } from './pack7'

const SOX = 0xf0
const EOX = 0xf7
/** `F0 42 3g 00 01 <family> 4A <module> <slot> 00` -- the raw prefix before the packed data. */
const SLOT_DATA_PREFIX = 10
const MAX_PLAUSIBLE_SIZE = 1024 * 1024

export class RawSysexAssembler {
  private buf: number[] | null = null

  constructor(private readonly onMessage: (msg: Uint8Array) => void) {}

  push(bytes: Uint8Array): void {
    for (const b of bytes) {
      if (b >= 0xf8) continue
      if (b === SOX) {
        // A new message while one is still open means the old one was cut short: deliver it as-is
        // (without a fake F7), so the parser rejects it loudly instead of it vanishing.
        if (this.buf) this.emit(this.buf)
        this.buf = [b]
        continue
      }
      if (!this.buf) continue
      if (b === EOX) {
        const expected = expectedSlotDataLength(this.buf)
        if (expected !== undefined && this.buf.length + 1 < expected) continue
        this.buf.push(b)
        this.emit(this.buf)
        this.buf = null
        continue
      }
      if (b & 0x80) {
        // Any other status byte aborts an open SysEx (MIDI 1.0); nothing complete to deliver.
        this.buf = null
        continue
      }
      this.buf.push(b)
    }
  }

  private emit(buf: number[]): void {
    this.onMessage(Uint8Array.from(buf))
  }
}

/** Only the minilogue xd has the stray-F7 bug; the NTS-1 mkII frames downloads correctly (in chunks). */
const MINILOGUE_XD_FAMILY = 0x51

function expectedSlotDataLength(buf: number[]): number | undefined {
  // Family-specific on purpose: an NTS-1 mkII chunk (`4A <module> <slot> <index> <last> ...`) has a
  // different layout after the slot byte, and reading its bytes as the xd's `00` + size once made
  // this swallow real chunk boundaries.
  const isSlotData =
    buf[1] === 0x42 &&
    (buf[2] & 0xf0) === 0x30 &&
    buf[3] === 0 &&
    buf[4] === 1 &&
    buf[5] === MINILOGUE_XD_FAMILY &&
    buf[6] === 0x4a
  if (!isSlotData || buf.length < SLOT_DATA_PREFIX + 8) return undefined
  // A host->device upload (only 2 raw bytes after 4A) never arrives on an input here; only the
  // 3-raw-byte device->host form is measured.
  const firstGroup = unpack7(Uint8Array.from(buf.slice(SLOT_DATA_PREFIX, SLOT_DATA_PREFIX + 8)))
  const size =
    (firstGroup[0] | (firstGroup[1] << 8) | (firstGroup[2] << 16) | (firstGroup[3] << 24)) >>> 0
  // A loopback port echoing our own traffic, or a foreign device, can look like slot data with a
  // nonsense size; never let that swallow F7s for good. No real unit comes close to 1 MB.
  if (size > MAX_PLAUSIBLE_SIZE) return undefined
  return SLOT_DATA_PREFIX + packedLength(8 + size) + 1
}

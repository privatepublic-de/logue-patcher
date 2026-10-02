# minilogue xd user-unit SysEx protocol

Captured 2026-09-25 by pointing Korg's `logue-cli` 0.07-2b (`load`/`probe`/`clear`) at a fake
minilogue xd on virtual CoreMIDI ports (`main.swift`). This is black-box observation of MIDI
bytes only; `logue-cli` was never decompiled or disassembled (its EULA forbids that), and neither
its binary nor its EULA is stored in this repo. The starting point was Korg's own published
*minilogue xd MIDI Implementation* (sections 2-5, (11)–(24), Tables 5–7). This file records only
what that document leaves out or gets wrong.

## Confidence levels

- **Ground truth (logue-cli → device):** every byte `logue-cli` sent. `encode_upload.py`
  rebuilds all 10 captured uploads in `test/fixtures/logue-sysex/minilogue-xd/*.upload.syx`
  byte for byte from the rules below.
- **Ground truth (real device → host):** `real-device-replies.json`, from read-only requests. See
  "Replies from a real minilogue xd".
- **Synthetic:** the `<<` lines in the `*.transcript.txt` fixtures were written by the capture
  emulator, and most predate its framing fix, so their `48`/`49` replies are known-wrong. Never
  use them as reply fixtures.
- **Unverified:** everything under "Open, needs a real upload".

Common header: `F0 42 3g 00 01 51 <func> …`, where g = the device's global MIDI channel (0 in the
logue-cli captures, 2 on the real capture device).
7-bit packing is the spec's NOTE 1: groups of 7 bytes, preceded by one byte whose bit *j* holds
bit 7 of byte *j*.

## Handshake (what logue-cli does before every command)

1. `F0 42 50 00 <echo> F7`: Search Device. Reply per spec 1-5 (family `51 01`).
2. `17`: API version. Reply `47 <platform=02> <major> <minor> <patch>`.
3. `18 <module>` for modules **0** (logue-cli calls it "Global", not in the spec) through 4.
4. `19 <module> <slot>` for every slot of every module (80 requests: 16 per module, taken from
   module info's slot count).

## Upload: `4A` USER SLOT DATA (host → device)

```
F0 42 30 00 01 51 4A <module> <slot> pack7( size:u32le  crc32:u32le  body[size]  00 ) F7
```

- `module`/`slot` are two **raw** (unpacked) bytes before the packed data. Table 7 doesn't show them.
- `crc32` = standard zlib CRC-32 over `body`.
- One extra `00` is appended **after** `body` and packed along with it (always present, not
  counted in `size`).
- The whole unit goes in **one** SysEx message (17 KB for `fm2`); no chunking.
- `body` = 1024-byte header ‖ `payload.bin` verbatim ‖ 132 zero bytes (constant across every
  capture; meaning unknown).
- The emulator ACKs with `23`. logue-cli sends nothing after that.

### 1024-byte header (built by logue-cli from `manifest.json`, all little-endian)

| Offset | Type | Field |
|---|---|---|
| 0x00 | u8 | module (modfx 1, delfx 2, revfx 3, osc 4). **Swapped vs. Table 6's order** |
| 0x01 | u8 | platform (minilogue xd = 2). Together, 0x00–01 are the SDK's `target = platform<<8 \| module` as u16 LE (`runtime.h`'s `k_unit_target_*`), which explains the order |
| 0x02 | u32 | api: `major<<16 \| minor<<8 \| patch` (so bytes are patch, minor, major, 0) |
| 0x06 | u32 | `dev_id` |
| 0x0A | u32 | `prg_id` |
| 0x0E | u32 | `version`, same packing as api |
| 0x12 | char[14] | name, NUL-padded; logue-cli **silently truncates to 13 chars** |
| 0x20 | u32 | `num_param` |
| 0x24 + 16·i | 16 B | param i (up to 6): `min:i8, max:i8, type:u8, name:char[13]` |
| 0x3FC | u32 | `len(payload.bin)` |

- Param name is NUL-padded but **not** NUL-terminated: a 13-char name fills all 13 bytes.
  Longer names are silently truncated.
- `type` is **derived** by logue-cli, not copied from the manifest: unit `"%"` → 0 if min ≥ 0,
  1 if min < 0; unit `""` → 2.
- min/max are `i8`, which is the real reason a manifest range past ±127 can't work (see the
  ±100 Librarian rejection noted in CLAUDE.md).
- logue-cli checks `payload.bin`'s first 4 bytes against the manifest's module: `UOSC`, `UMOD`,
  `UDEL`, `UREV`.

## Replies from a real minilogue xd (device → host; ground truth, read-only requests)

Captured 2026-09-25 from the user's own xd over Web MIDI in the built app
(`test/fixtures/logue-sysex/minilogue-xd/real-device-replies.json`). These confirm exactly the
framing logue-cli's parser needed, and correct the spec in several places.

- **Search Device reply:** `F0 42 50 01 0g <echo> 51 01 00 00 02 00 0a 00 F7`. `0g` is the
  device's **global MIDI channel** (this xd: 2), and every later request must use `3g` to match,
  or the device silently ignores it. The four version bytes are ambiguous: the spec's order
  (minor, major) reads 10.02, while major-first reads 2.10, which is a real xd release. Don't
  display them.
- **`47` API version:** `47 02 01 01 00` = platform 2, API 1.1.0.
- **`48` module info:** `48 <module> 00 pack7(9 bytes)`. That's 2 raw bytes, then the 9 bytes the
  spec's message text states: `max_payload:u32, max_load:u32, slot_count:u8`. Table 5's "8~9" is
  wrong. The values:

  | Module | max payload | max load | slots |
  |---|---|---|---|
  | osc (4) | 36 848 | 32 768 (the 32 KB SRAM) | 16 |
  | modfx (1) | 8 180 | 6 144 | 16 |
  | delfx (2) / revfx (3) | 16 368 | 12 288 | 8 |

  Module 0 answers a bare `48 00 F7` with no data.
- **`49` slot status:** `49 <module> <slot> 00 pack7(32 bytes)`, with 3 raw bytes. In the 32
  bytes, 0–1 are the SDK `target` as LE (`module, platform`), which is Table 6's order reversed.
  Units built for the prologue (platform 1) report `01` there and still run on the xd. api
  (@2) and version (@14) are u32 LE `major<<16|minor<<8|patch`, not Table 6's "major u16 first".
  The name is @18.
- The extra raw byte after module/slot was `00` in every real reply.
- **Empty slot:** a bare `49 <module> <slot> F7` with no data. (logue-cli's all-zero rendering is
  not what the device sends.)

## Download: `1A` → `4A` (real minilogue xd, read-only)

Captured 2026-09-25 by dumping all 48 user slots of the user's xd twice (`dump_slots.swift`):

- **Reply:** `4A <module> <slot> 00 pack7(size:u32, checksum:u32, body[size]) F7`. That's 3 raw
  bytes (the upload has 2) and **no trailing `00` pad** (the upload has one). An empty slot is a
  bare `4A <module> <slot> F7`.
- **`body` is byte-identical to the upload body.** Osc slot 1 held the user's `string.mnlgxdunit`
  build, and the downloaded 3692 bytes equal `buildMinilogueXdUnitBody` of that file exactly,
  132-byte trailer included. Every one of the 27 occupied slots (xd- and prologue-built units)
  re-encodes exactly from a manifest reconstructed out of its own header. So the device stores
  the upload body verbatim, and a download is a complete backup.
- **`checksum` is NOT a checksum of the body, as far as can be told.** It's stable per slot
  across dumps (string: `f7a289fc`, while zlib CRC-32 of the body is `c7455bf2`). But across all
  27 occupied slots its low 11 bits are identical (`…1fc`, low byte always `fc`), and only 17 of
  32 bits ever vary, which a CRC over different content can't produce. Tested and ruled out,
  over body, header, payload and payload+trailer: CRC-32 zlib/CRC-32C/BZIP2/MPEG-2/POSIX/STM32
  word-wise, and CRC-16-CCITT (FALSE, XMODEM, KERMIT, X-25, AUG, GENIBUS, MCRF4XX) in either
  16-bit half (a Stack Overflow claim pointed at CRC-16-CCITT). Treat it as an opaque device
  value. Uploads still use zlib CRC-32 (what Korg's logue-cli sends). Download integrity comes
  from exact lengths plus repeat dumps.
- **Stray `F7` bytes (transport bug):** the xd's USB MIDI output inserts `F7` into a long SysEx
  stream, about one per 700 bytes (1 for a 1.8 KB unit, 50 for 33 KB) at positions that vary per
  dump, while the data around them continues intact. Raw length is always the exact packed length
  plus the stray count, and two dumps of every slot gave identical bodies after dropping every `F7`
  but the last (`stripStrayEox`). Any standard SysEx parser ends the message at the first one:
  **Chromium's Web MIDI delivers only that first fragment and silently drops the rest**, so a
  download cannot work over Web MIDI on this device. It needs raw CoreMIDI bytes. Unknown whether
  the same happens host→device on upload; the device's own size/CRC check would NAK a corrupted
  upload rather than store it.
- Realtime bytes (Active Sensing `FE`, sent continuously) interleave with SysEx and must be
  skipped, including when deciding the transfer has gone quiet.

## Clear (ground truth, matches spec)

- Slot: `F0 42 30 00 01 51 1B <module> <slot> F7`.
- Whole module: `F0 42 30 00 01 51 1D <module> F7`.

## Real upload (2026-09-25): single-slot write verified

The app's Restore uploaded osc slot 1 alone (`string`, 3692-byte body, zlib CRC-32, the same framing
as logue-cli) to the user's real xd, over the native helper:
- The device ACKed with `23`. Upload plus read-back took about 2.4 s wall-clock.
- An in-app backup before and after matched the verified backup: all 27 bodies byte-identical,
  and the whole 48-slot table (occupancy, names, sizes) unchanged.

So the device accepts single-slot writes without disturbing other slots (Korg's editors' "send
all" is a UI choice, not a protocol limit). Host→device SysEx is unaffected by the stray-`F7`
output bug, and the upload checksum IS zlib CRC-32, whatever the download's field means.

## Open

- Exact ACK latency for large units (33 KB), and whether `24` (busy) ever shows up mid-upload.
- The real device's NAK behaviour (bad CRC/size/API).
- What the download's `checksum` field actually is.
- Whether the 132-byte zero trailer means anything to the device. (It's stored and returned
  verbatim.)
- NTS-1 mkII: not covered at all (logue-cli doesn't support it). That needs Kontrol Editor
  traffic captured with MIDI Monitor's spy driver.

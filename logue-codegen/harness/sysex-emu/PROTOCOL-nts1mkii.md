# NTS-1 mkII user-unit SysEx protocol

## Captured from a real device (2026-09-25: read-only 17/18/19/1A, plus one Kontrol Editor upload)

The user's own NTS-1 digital kit mkII (global channel 0), via `dump_slots.swift` (`FAMILY=73`) and
the app's in-app backup. Fixtures are in `test/fixtures/logue-sysex/nts1mkii/`. **This settles the
draft's main questions below; where they disagree, this section wins.**

- **`47`:** `47 05 02 00 00` = platform 5, API 2.0.0. The spec table's `0000 1010` is a typo.
- **`48`:** `48 <module> 00 pack7(12 bytes)`: `max_storage:u32, max_load:u32, slot_count:u32`.
  That's the xd's 2-raw-byte framing, with a 12-byte payload (the spec says 9).

  | Module | max storage | max load | slots |
  |---|---|---|---|
  | osc (4) | 49 136 | 49 152 (the 48 KB RAM-load limit) | 16 |
  | modfx (1) | 16 368 | 16 384 | 16 |
  | delfx (2) / revfx (3) | 24 560 | 24 576 | 8 |

  Modules 5 and 6 answer a bare `48 05` / `48 06`.
- **`49`:** `49 <module> <slot> 00 pack7(unit_header_t)`. The payload is the unit's whole 408-byte
  `unit_header_t` (runtime.h: header_size, target, api, dev_id, unit_id, version, name[20], …),
  **not** Table 4's 32 bytes. An empty slot is a bare `49 <module> <slot>`.
- **`1A` → `4A`, chunked:** `4A <module> <slot> <chunk index> <last chunk index> pack7(chunk)`.
  Each message is at most 4096 bytes, and the 7-bit packing restarts in every chunk. The decoded
  chunks concatenate to `size:u32, checksum:u32 (always 0), body`. **`body` is the
  `.nts1mkiiunit` ELF verbatim**: osc 2/3/4 were byte-identical to the user's own `combnew`,
  `harmonics` and `formant` builds. An empty slot answers a single chunk `00 00` with no data.
- **No stray-`F7` bug:** unlike the minilogue xd, this device frames long SysEx correctly, so
  Web MIDI would even work here. The app uses the native helper for both anyway.
- **Upload (captured from KORG KONTROL Editor 2.5.0, 2026-09-25):** recorded through
  `midi_proxy.swift`, a logging man-in-the-middle (Kontrol Editor's "Set MIDI ports manually"
  pointed at the proxy's virtual ports). "Send User Unit." of the user's `string.nts1mkiiunit` to
  osc slot 5:
  - It's the exact mirror of the download: `4A <module> <slot> <index> <last> pack7(chunk)`, with
    `size:u32, checksum:u32 = 0, body` split into 3573-byte chunks (4096-byte messages), packed per
    chunk. **`body` is the `.nts1mkiiunit` file verbatim**, and the checksum is 0 (no CRC at all).
  - The device ACKs **each** chunk with `23` (after ~0.15 s and ~0.87 s here), and Kontrol Editor
    waits for the ACK before sending the next chunk.
  - `slotDataUploadChunks` reproduces both captured messages byte-for-byte from the file alone
    (`test/logue-nts1mkiiDevice.spec.ts`). Afterwards osc 5 read back as "string".
  - **The app's own upload was verified on the same device afterwards:** `sysextest.nts1mkiiunit`
    to osc slot 6, both chunks ACKed. A before/after in-app backup showed osc 6 byte-identical to
    the uploaded file and the other 7 units unchanged.
  - Kontrol Editor's own session, for reference:
    1. Search Device (plus a universal Identity Request).
    2. `19` for every slot of modules 4, 1, 2, 3.
    3. `0E` (globals) and `10` (current program).
    4. On "Receive": `1A` for every slot.
    5. Only then, the upload itself.


## Current program dump and unit selection (2026-10-05, the hardware test harness)

Korg's MIDI implementation v1.00 (2024-03-18), checked on the user's device (firmware 1.3):
- `10` -> `40 pack7(504 bytes)` (the spec says 505). Writing the same `40` back is ACKed (`23`)
  and reads back byte-identical. Multi-byte values are **little-endian** (the spec's H/L columns
  read the other way): OSC A at 60 read `f5 02` = 757.
- Each module's 12-byte selection (osc 28, modfx 112, delfx 168, revfx 224): developer id (u32),
  unit id (u32), version (**one u32**, `major<<16|minor<<8|patch`, so `00 00 01 00` for 1.0.0 --
  not the table's separate major/minor/patch bytes). Factory units: `ffffffff`, their index in
  the type list (OFF 0, SAW 1, ...), `ffffffff`. Writing a user unit's ids selects it (the scripts
  also write its name into the 20 bytes after; untested whether that's needed -- left alone it
  kept the old name). An unset param reads `0x8000`.
- An effect's program PARAM 1..8 are its param rows 3..10 on delay/reverb (after TIME/DEPTH/MIX,
  which are the program's A/B/MIX words, 0..1023).
- Short messages (CCs) are on in the user's global settings, NRPN off (TABLE 1 offset 13); the
  output is set to mono (offset 7).

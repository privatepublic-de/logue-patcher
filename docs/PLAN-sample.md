# logue/osc/sample (a plain sample player)

Plan agreed 2026-10-02 (user: a new non-granular sample player next to `osc/granular`, for
material like their Fairlight CMI sample collection; samples stored at their **native rate**
and as **linear 8-bit**). Status: phase 1 (import, `pcm8`, loop points, codec) and phase 2 (the primitive: harness, builds,
emulator, tables) and phase 3 (import UI, draggable loop points with snap) done 2026-10-02; phase 4
(hardware) done: works seamlessly on a real xd and a real NTS-1 mkII (user, 2026-10-02).

Granular reads a sample as grain material. `osc/sample` plays it as recorded: pitched by the
keyboard against ROOT, one-shot or looped, from a START offset. It reuses what granular
already has (`ObjNode.sample`, the WAV import, root detection, the Inspector preview, content
hash dedupe); the new parts are the import policy, the encoding, loop points and the
playback code.

Background, unverified here: CMI-era samples were 8-bit and short (on the order of 16 KB per
voice), which is about what a *logue oscillator can hold. Nothing below depends on that; WAV
conversions of such libraries vary (many are 16-bit/44.1 kHz re-recordings), and the import
has to handle both.

## Phase 1: import and data model

### `SampleAsset` (`src/shared/domain/patch.ts`)

- `encoding: 'mulaw8' | 'pcm8'`. `pcm8` is **signed int8** two's complement, decoded as
  `(int8_t)b * (1.f/128.f)` -- no table, no offset. (WAV's 8-bit is unsigned offset-128; the
  import converts once.)
- New optional `loopStart?: number`, `loopEnd?: number`, in stored samples, `loopEnd`
  EXCLUSIVE (one past the last looped sample; the WAV `smpl` end is inclusive, converted at
  import). Both or neither.
- No file-version bump (the optional-field precedent: `unitName`, `label`, `sample` itself).
  An older app opening a `pcm8` file fails loudly on the encoding (`patchCodec.ts`), which is
  acceptable.
- Codec (`patchCodec.ts`): accept both encodings, read/write the loop pair, reject a loop
  outside `0 <= start < end <= length` (loud, like every other bad value).
- `decodeSampleAsset` (`importSample.ts`) branches on the encoding, so the Inspector waveform
  and preview work for both.

### `wav.ts`: the `smpl` chunk

- `DecodedWav` gains `bitsPerSample`/`format` (to recognize an 8-bit source),
  `unityNote?` (`smpl.dwMIDIUnityNote`) and `loop?: {start, end}` (end inclusive, as in the
  file).
- Take the FIRST loop whose type is 0 (forward). Other types (alternating, backward) are
  ignored and reported in the import result ("loop type not supported, imported without
  loop"), not silently changed to forward.
- Tests with hand-built WAV fixtures: 8-bit unsigned, 16-bit with `smpl`, a loop of another
  type, a `smpl` chunk with zero loops, an odd-sized chunk before `data` (padding).

### `importWavSample` for `osc/sample` (a second entry point, `importPlainSample`)

Granular's import is unchanged (resample to fit, normalize, mu-law); its output and goldens
must stay byte-identical.

1. Decode, mix to mono.
2. Trim silence at the start always; at the end only after the loop end (never inside a loop).
   Loop points move by the trimmed start.
3. Rate: the source's own rate, unless it's above 48 kHz (then 48 kHz: the device's output
   rate, anything more is wasted bytes).
4. Fit: when the result is longer than the chosen maximum length (see below), the Inspector
   offers **Cut** (default; cut at the maximum, or right after the loop end when the loop fits)
   or **Downsample** (the existing windowed-sinc `resample.ts`, to the rate that fits, never
   below `MIN_SAMPLE_RATE`; loop points scaled and rounded). The result line names what
   happened ("cut from 2.40 s", "downsampled 44100 -> 13 653 Hz").
5. Values:
   - **An 8-bit PCM source kept at its native rate is copied bit-exactly** (minus 128): no
     normalize, no requantize. That's the authentic path for real CMI-era files.
   - Anything else (16/24/32-bit, float, or resampled 8-bit) is peak-normalized and rounded to
     int8. **Plain rounding, no dither** -- a choice for character (8-bit grit, no added hiss),
     to revisit after listening.
6. ROOT: `smpl`'s unity note when present (a converted library usually carries it), else YIN
   (`detectRootNote`) as now, else unset.

**Maximum length.** Documents are platform-agnostic, so the import can't know the target. The
RAM gauge is the enforcement (the table counts in `sharedBytes`, as granular's does); the import
only caps at what the bigger device can hold. Choices: 8K / 16K (default: fits the xd beside a
small patch) / 24K / 32K / 40K samples (40K confirmed in phase 2). Before measuring: granular's measured NTS-1 mkII unit with a 16K sample is 22 955 B, so the NTS-1 mkII's
49 152 B leaves about 42 KB for a sample plus the rest of a patch -- the exact cap comes from a
real 40K build in phase 2. On the xd (32 768 B, code included), 16K is the practical maximum
(granular: 19 496 B text+rodata with 16K).

### Granular and a `pcm8` sample

`replaceNode` keeps `node.sample` (`{ ...n, type }`), so swapping between the two primitives
carries the sample across:
- sample -> granular with a `pcm8` sample: granular's `instanceProblem` reports "This sample is
  stored as linear 8-bit; re-import it for granular." (It reads `mulaw[smp[i]]` unconditionally
  and would otherwise play garbage.) A paste or hand-edited file is caught the same way.
- granular -> sample: `osc/sample` plays `mulaw8` too, converted to linear 8-bit at generation
  (`renderExpr` can't see the node, so a second step function per encoding wasn't possible
  without a branch per read); the Inspector offers a re-import as linear 8-bit at native rate.

## Phase 2: the primitive

`logue/osc/sample`, `primitives/osc.ts`, `modules: ['osc']` (in an effect `note_` is fixed at
60; a trigger-fired one-shot in effects is a possible later extension, which would add it to
the fx sweeps). `searchTerms`: wav, rompler, fairlight, player, sampler.

| Ports | Params |
|---|---|
| in `pitch` (control), `start` (control), `trig` (gate); out `out` (audio) | COARSE, FINE (the shared specs), ROOT (0..127, `NOTE_NAME`, default 60 -- same name as granular's, so `setNodeSample` sets it for both), START (0..100 %, additive `start` at depth 50), LOOP (select Off / On; a select so ping-pong can follow), TRACK (checkbox, default on: off plays at the stored rate on every key, for drums), INTERP (select Linear / None) |

- **Phase**: 16.16 fixed point in a `uint32_t` (lengths up to 65 536). The increment
  is `rate/48000 * note_w0(note)/note_w0(ROOT)`, converted to fixed point once; TRACK off is
  `rate/48000`. Playing ROOT from a 48 kHz sample is then exactly `0x10000` -- the harness's
  bit-exact case. Increment capped at 16x (granular's `GRANULAR_MAX_SPEED`).
- **Block constants**: with `pitch` unwired (or fed from a per-block value) the whole
  increment is a `blockValue`; the ROOT term is always per block. A wired `pitch` is read
  every 16 samples (granular's control period; a `note_w0` per sample is what made
  bass-support's wired case heavy). Vibrato then steps at 3 kHz -- inaudible, to confirm in the
  harness.
- **Restart**: note-on (every note, legato too) and a rising `trig` (>= 0.5, the gate
  convention) set a `restart_` flag; the step helper, on the next sample, latches START (with
  the wired `start` added -- a wired inlet can't be read in `noteOnStatement`) as
  `START% * (loop ? loopEnd : length)` and clears the flag. Unwired `trig`: note-on only.
- **Read**: Linear reads `i` and `i+1`; at a loop seam `i+1` is `loopStart`, past a one-shot's
  end it's 0. None reads `i` only (drop-sample). A one-shot past its end outputs 0 and holds
  (the device's amp envelope does the rest). A tail that doesn't end near 0 clicks at the
  end; disclosed in the description, not faded (the import could bake a short fade later).
- **Loop**: LOOP On without stored loop points loops the whole sample. The wrap is
  `pos -= (loopEnd - loopStart) << 16`, one `if` (the 16x cap keeps one wrap per sample unless
  the loop is shorter than 16 samples -- the import rejects loops under 32 samples).
- **Encoding**: one `sample_pcm8_<hash>` table helper per content (a mu-law sample converted
  first). Rate, length and loop points are per-instance init constants, never part of the
  table, so two nodes on the same bytes with different loops still dedupe.
- **xd shape**: `sample_step` is `static inline __attribute__((always_inline))`, a leaf; the
  staged build's `objdump` shows no `bl` below `Osc::process` other than leaf `note_w0` (only
  with `pitch` wired). No libm.
- **Short loops**: the codec accepts any loop of 1+ samples (it doesn't know playback limits),
  so the primitive's `instanceProblem` rejects a loop under `MIN_LOOP_LENGTH` (a hand-edited or
  pasted file); the import already drops one.
- **State**: hand-counted `stateBytesPerInstance` (phase, increment, flags, pointer, length,
  loop pair, rate ratio, the param floats), checked against the xd bss.

Chores: golden snapshots (`test/__snapshots__/primitives/`; granular's must not change except
for the new `instanceProblem`, which emits no code), `logue-primitivePresentation.spec.ts`
(`start` named by START's `modulatedBy`), `logue-hoisting.spec.ts` passes with all inlets wired
from constants, `cpuCostTable.ts` (`measureCpuCosts.ts`; variants base / control / loop /
interp-none) and `codeSizeTable.ts` (`measureCodeSizes.ts`) re-measured, CLAUDE.md counts
(88 -> 89 primitives, osc 12 -> 13) and a "Per-primitive gotchas" entry.

Verification:
- Host harness (xd, ASan/UBSan): note = ROOT on a 48 kHz sample reproduces the stored samples
  bit-exactly (both INTERP settings); pitch within 1 ct over +-24 st at several stored rates
  (autocorrelation on a looped single-cycle sample, not zero crossings); loop seam continuous
  (no step larger than the material's own); one-shot ends in exact silence; START 50 starts at
  half; a wired `pitch` sweep has no NaN/inf; fuzz with extreme notes/COARSE and short loops.
- Real ARM builds on both platforms (a `scripts/stageSample.ts`: unwired, all wired, a 16K
  and the cap-sized sample on NTS-1 mkII); RAM estimate vs bss + rodata.
- xd emulator cycles (expected well under granular; a sine-class oscillator plus one or two
  byte reads).

### Phase 2 results (2026-10-02)

- Harness (`scripts/runSampleHarness.ts`): bit-exact at ROOT from 48 kHz (both INTERPs, error
  3.8e-8 = the output's q31 rounding), one-shot tail exactly 0, pitch worst 0.11 ct over +-24 st
  at 22.05/32/48 kHz (0.25 ct with COARSE/FINE), TRACK off exact, loop steps within the
  material's, START 50 exact, trig restarts, wired pitch / speed cap / START 100 on a 32-sample
  loop / a converted mu-law sample clean.
- Builds (`scripts/stageSample.ts`): xd leaf-only (`note_w0`), 17 728 B with 16K; NTS-1 mkII
  21 802 B (16K), 38 186 B (32K), 46 378 B (40K), 50 474 B (44K: over). 40K is offered.
- RAM estimate within 1 % of each build; xd emulator 68 base, 76 with control inputs (measured
  looping: an unlooped first run read 45 for control, a finished one-shot's silence).

## Phase 3: Inspector

- `Inspector.tsx:583` shows `SampleSection` by a primitive-level flag
  (`LoguePrimitive.sampleImport?: 'granular' | 'plain'`), not by granular's id.
- `SampleSection` takes the import kind: granular keeps its size choices
  (`SAMPLE_SIZE_CHOICES`, matched against the decoded length); `osc/sample` shows the maximum
  length choice, Cut/Downsample when it applies, the stored rate and bit depth, the source of
  ROOT (`smpl` / detected), and a warning naming the loop type when a loop was dropped.
- The "cut to fit at the lowest rate" text was written for granular's import; a plain-import
  cut (or downsample, `resampledFromRate`) needs its own wording.
- Loop markers drawn on the waveform; the preview plays START -> loop -> (looping while the
  play button is held, or a fixed count) so a loop's seam can be heard before building.
- Draggable loop points (done 2026-10-02, the user's ask: in the unzoomed view, snapped by
  algorithm): `sample/loopSnap.ts`. Candidates are crossings of the level at the other loop
  point (zero crossings once that one is on one) within 4 px, going the same way by a smoothed
  slope; the best match of the 32 samples around both seams wins. On the 8-bit test tone with
  the file's loop end (not on a zero crossing): dropped at 6862 (seam cost 0.079), snapped to
  6865 (0.035); a zero-crossing-only first version picked 7007 (2.03). Shift places exactly, ×
  clears the loop, one undo step per drag, the preview follows a moved loop live.
- Done (2026-10-02): the section shows for any `sampleImport` primitive; `osc/sample` gets Max
  length (8K..40K, labelled with the xd's share, or the NTS-1 mkII's once the xd can't hold it)
  and If longer (Cut/Downsample), the loop shaded on the waveform, what the last import did
  (bit-exact, where ROOT came from, a dropped loop and why), a note for a sample stored for the
  other player, and a preview that loops (to the end, then round the loop) while the node's
  LOOP is on. Checked in the built app: an 8-bit WAV with `smpl` (bit-exact, loop, ROOT A3), a
  2 s 16-bit WAV cut (loop dropped, explained) and downsampled (44100 -> 8192 Hz, loop kept),
  the looping playhead, and granular's section on a real patch.
- Verified in the built app (`run-desktop`): import an 8-bit and a 16-bit WAV with `smpl`, the
  preview loops, swapping granular <-> sample shows the expected problem/offer.

## Phase 4: hardware

A CMI voice (the user's own collection; not shippable, so no example patch with it -- an
example could use a generated sample) on a real xd (polyphonic chords, START on Shape,
looped and one-shot) and a real NTS-1 mkII (the cap-sized sample loads; `pitch` from an LFO).

## Open items

- Dither: off by choice; revisit after listening.
- Ping-pong and reverse added 2026-10-02 (user's ask): LOOP Off/Forward/Ping-pong, REVERSE
  plays the sample mirrored; see CLAUDE.md's `osc/sample` entry.
- Later candidates, not planned: a baked loop crossfade at import,
  an `eoc` gate at a one-shot's end, use in effects with a `trig`, reading Fairlight `.VC`
  files directly (format not researched).

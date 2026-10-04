# logue/osc/wavetable (single-cycle frames cut from a recording)

Plan drafted 2026-10-04; decisions confirmed the same day (all five defaults). Status: phase 1
(import analysis, `wt8` data model, codec) and phase 2 (the primitive: harness, builds, emulator,
tables) done 2026-10-04; phase 3 (Inspector) done the same day; phase 4 (hardware) open. Origin: `osc/granular` with SYNC on bends pitch while
POSITION moves (each grain is a slice one NOTE period long of material whose own period is
different, so scanning drifts the material's phase from grain to grain: a Doppler shift of
about `f * v`, v = scan speed in seconds of material per second). The user asked for "more
wavetable-land": frames that are exactly one cycle of the recording, played at the note's
pitch, so POSITION only changes timbre.

The expensive part (finding cycles in a sung, drifting, partly unvoiced recording) runs at
import, in TypeScript. The device only reads small int8 tables: one phase, two neighbouring
frames, two band-limited levels.

What changes compared to granular SYNC, and goes in the description: **formants follow the
note** (a frame is stretched to the note period, so a vowel turns chipmunky high up and
growly low down), which is ordinary wavetable character. Granular SYNC keeps formants fixed.

## Decisions (confirmed by the user, 2026-10-04)

1. **Frame count**: 32 by default; 16 / 64 still offered (64 fits only NTS-1 mkII).
2. **Points per frame**: 256 (64 harmonics) by default; 512 offered for low sources (NTS-1 mkII
   only at 32+ frames). 64 harmonics reach ~20 kHz for a voice at Eb4 but only ~3.5 kHz for a
   55 Hz bass at its own pitch.
3. **Mip levels**: crossfade between the two levels around the note (smooth through bends and
   vibrato, +4 reads a sample).
4. **Level**: per-frame RMS evened out to the loudest frame, gain capped at +12 dB.
5. **Formants follow the note**: accepted as wavetable character (disclosed in the description).

## Memory budget

Aliasing can't be fixed after the table read (an output filter can't separate a folded
partial from a real one), so every frame needs a band-limited copy per octave of playable
pitch. Recorded frames aren't ordered by brightness, so `osc/additive`'s trick (clamping the
frame index by the note) doesn't apply. Pyramid per frame, each level half the harmonics, half
the points but never under 64 (phase 2: shorter levels' interpolation images were the worst
aliasing): 256 (64 h), 128 (32 h), 64 (16 h), 64 (8 h), 64 (4 h), 64 (2 h) = 640 B, 2.5x the
base frame. A C8 (4186 Hz) still gets its clean 5 harmonics from the 4 h level.

| Frames x points | Base | With mips | minilogue xd (32 768 B incl. code) | NTS-1 mkII (49 152 B) |
|---|---|---|---|---|
| 16 x 256 | 4 KB | 10 KB | fits easily | fits |
| 32 x 256 | 8 KB | 20 KB | fits (21 960 B built) | fits (25 925 B built) |
| 64 x 256 | 16 KB | 40 KB | no | fits alone (46 405 B built) |
| 32 x 512 | 16 KB | 36 KB | no | fits (42 313 B built) |
| 64 x 512 | 32 KB | 72 KB | no | no |

The RAM gauge enforces it (pyramid bytes in `sharedBytes`, via `instanceHelpers` like
granular; within 0.3 % of every build above); the import labels each choice with its share of
each device, like `osc/sample`'s max-length choice.

Level choice (as built): with `x = L * w0`, level j covers x in [2^j, 2^(j+1)) and is
crossfaded linearly into j+1 across it, so its top harmonic is at full weight up to 12 kHz and
gone exactly when it reaches Nyquist. (The draft's "18 kHz" rule was replaced by this; what
limits aliasing is interpolation images, see phase 2 results.)

## Phase 1: import and data model

### Source quality

The import reads the **original WAV at its native rate**. A granular asset can't be the
source: the user's current one is 7663 Hz mu-law, about 12 harmonics at Eb4, and harmonics
lost in resampling don't come back. `sourcePath` is only a hint (this one is on `/Volumes/...`,
which may not be mounted); the import asks for the file. A "convert the existing sample"
shortcut isn't planned; if it's ever added, it reports the harmonic ceiling.

### Analysis (`logue-codegen/src/sample/wavetable*.ts`, dependency-free)

1. Decode, mix to mono, trim silence (the existing helpers).
2. **Pitch track**: YIN per 5 ms hop, window two periods of the lowest pitch (40 Hz), the
   existing aperiodicity threshold 0.2, parabolic interpolation on the difference function
   for a fractional lag, then a 5-hop median to remove octave errors. A first, separate step
   moves `detectRootNote`'s YIN core into a shared function (a pure move, its output unchanged;
   see "Working conventions").
3. **Voiced spans**: hops above the aperiodicity threshold (breaths, consonants, silence) are
   skipped. The N frame positions are spread evenly over the **voiced** time, so POSITION maps
   to sung material. Under ~100 ms voiced in total, the import fails loudly ("not enough
   pitched material"). The result reports the voiced/skipped split.
4. **One cycle per position, by harmonic analysis** (rather than cutting one period in the
   time domain and resampling it): take ~3 periods around the position, Hann-window them, and
   correlate with `e^{-i 2 pi k f0 t}` for k = 1..K, where K = min(points/4, the source's own
   Nyquist / f0). Leakage: the Hann main lobe over 3 periods is +-0.67 f0 wide, so neighbouring
   harmonics fall outside it (sidelobes -31 dB). Then synthesize the frame from those amplitudes
   and phases. One step that gives:
   - an exactly periodic frame (no seam, even when the f0 estimate is slightly off),
   - band-limiting (only real harmonics, K capped by the source),
   - no DC (k starts at 1),
   - **phase alignment**: subtract `k * phi_1` from each harmonic's phase, so every frame's
     fundamental starts at phase 0. Frames that aren't aligned partly cancel each other when
     POSITION crossfades between neighbours. Where the fundamental is too weak for a reliable
     phase (< -30 dB of the frame), align by cross-correlation with the previous frame instead.
5. **Level**: per decision 4, then one global peak normalization to int8 full scale.
6. **Quantize** to signed int8 (plain rounding, no dither, like `osc/sample`). Mips are baked
   from these int8 frames at codegen.

### `SampleAsset` (`src/shared/domain/patch.ts`)

Kept on the node (`ObjNode.sample`) so copy/paste, subpatch flattening and content-hash
dedupe work as for the two existing players. No file-version bump (optional-field precedent).

- `encoding: 'wt8'`: signed int8 frames, back to back.
- New `frameLength` (128..512, a power of two) and `frameCount` (2..64), required for `wt8`
  and absent otherwise.
- `rate`: the source's own rate, informational (shown in the Inspector, unused by codegen).
  No loop fields.
- Codec (`patchCodec.ts`): data length must equal `frameCount * frameLength`; a loop pair on
  `wt8` is rejected (loud, like every other bad value).
- `sampleContentHash` includes `frameLength` for `wt8` (the same bytes cut at another frame
  length are a different table).
- `decodeSampleAsset` branches on `wt8` (the Inspector draws frames).

### All three players see all three encodings

`replaceNode` keeps `node.sample`, so:
- `osc/granular`: `instanceProblem` for `wt8` (it reads mu-law unconditionally).
- `osc/sample`: `instanceProblem` for `wt8` (no meaningful one-shot reading of a frame stack).
- `osc/wavetable`: `instanceProblem` for `mulaw8`/`pcm8` ("re-import this file as a
  wavetable"), and for a hand-edited `wt8` with a bad shape.
- `LoguePrimitive.sampleImport` gets a third kind, `'wavetable'`; the Inspector's "stored for
  the other player" note covers it.
- `setNodeSample`: the wavetable import passes no root note. Passing one would append a
  `ROOT` param the primitive doesn't have (it would show as an unknown-param issue).

### Phase 1 results (2026-10-04)

`sample/yin.ts` (YIN core moved out of `detectRootNote`, output unchanged), `sample/pitchTrack.ts`,
`sample/importWavetable.ts`, `wt8` in `SampleAsset`/the codec, and the two `instanceProblem`s.
One change from the plan above: pitched hops more than 20 dB below the loudest are also skipped
(`QUIET_HOP`): on the user's soul vocal, note tails passed the voicing check and became four
near-flat frames that even +12 dB couldn't lift. Also: only the first 30 s of a source are
analysed (`MAX_ANALYSIS_SECONDS`, recorded as `truncatedFromSeconds`), which bounds the import time.

On that vocal (44.1 kHz, 2.14 s): 1.29 s used, 0.85 s skipped, frames G3..Eb4 (median ~C4),
64 harmonics, ~0.2-0.4 s to import. Neighbouring frames correlate 0.75-1.0 (mostly >= 0.95). The
low pairs are aligned frames of different shape, not alignment misses: a midpoint crossfade dips
at most 0.57 dB (pair 25-26), exactly the `10 log10((1 + r)/2)` a correlation of 0.75 predicts;
a misaligned pair would sit near or below zero correlation. `test/logue-wavetableImport.spec.ts` covers the cases below.

Tests (synthetic input, generated in the test):
- A saw drifting +3 st over 2 s: harmonic k at 1/k within 0.75 dB up to the 64th (8-bit rounding at -36 dB), nothing above
  (-50 dB), fundamental phase 0, neighbours correlate > 0.99, the notes tracked.
- A saw with 6 Hz vibrato (+-50 ct): every harmonic up to the 64th within 1 dB (measured worst
  0.6 dB). This needed two changes from the first version, which lost 5 dB at the 25th and 15+
  past the 35th: the cycle analysis measures against the tracked pitch curve (warped time), not a
  constant pitch, and the tracker re-measures each hop over a short window centred on it (the
  detection window sits mostly before the hop and lagged the vibrato: 13 -> 1.9 ct rms).
- The same saw with a 300 ms noise gap: no frame comes from the gap, and the voiced/skipped
  split is reported correctly.
- A low-rate source (8 kHz) has K capped by its own Nyquist.
- Pure noise fails loudly.
- An octave-error trap (a strong 2nd harmonic) is tracked at the right octave.
- A tone with no fundamental: frames aligned to each other (neighbours correlate > 0.98).
- A fading tone: evened out up to +12 dB, quieter beyond.
- The codec round trip and refusals, the frame length in the content hash, and the
  `instanceProblem`s.

## Phase 2: the primitive

`logue/osc/wavetable`, `primitives/osc.ts`, `modules: ['osc']` (in an effect `note_` is fixed
at 60). `searchTerms`: wavetable, ppg, serum, scan, morph, vocal, cycle.

| Ports | Params |
|---|---|
| in `pitch`, `harmonic`, `position` (control); out `out` (audio) | COARSE, FINE (the shared specs), POSITION (0..100, additive `position` at depth 100: a whole-range morph like additive's TIMBRE), MORPH (select Smooth / Step: Step = nearest frame, PPG-style, and cheaper) |

- **Pitch**: `transposedW0` block constant like `additive` (COARSE/FINE/`pitch`/`harmonic`).
  Phase float 0..1, one wrap.
- **Mip level**: a block constant from w0 (`wt_level`: a compare chain over the 5 levels'
  thresholds, no libm log2), plus a crossfade fraction (decision 3). With `pitch`/`harmonic`
  wired it is re-read every 16 samples (granular's control period).
- **Frames**: POSITION picks frame `i` and blend `t`. Unwired (or from per-block values) both
  are block constants; a wired `position` is per sample (cheap: one multiply, one truncation).
- **Read**: int8 to float as `osc/sample` does (`(int8_t)b * (1.f/128.f)`); 2 frames x 2
  levels x 2 points = 8 byte reads and 7 lerps (4 reads with a hard level switch, 2 with Step).
- **Tables** (codegen, TS): `wavetable_<hash>` = every frame's pyramid as one `int8_t` array
  plus a small level-offset table, baked with an exact per-frame DFT (single cycles fall on
  exact bins: truncate the harmonics and resynthesize at each level's length). Deduped by
  content hash; `sharedBytes` = the array, through `instanceHelpers` so codegen and the RAM
  gauge agree.
- **xd shape**: `wavetable_step` is a `static inline __attribute__((always_inline))` leaf, no
  libm; check the staged build's `objdump` for no `bl` below `Osc::process` except `note_w0`.
- **State**: phase, coarse, fine, position, morph (~20 B), hand-counted, checked against the
  xd bss.
- **CPU guess** (to be measured): base ~50-80 xd emulator cycles, against additive's 178 with
  its float tables and per-sample frame search.

Chores: golden snapshots (granular's and sample's change only by their new
`instanceProblem`, which emits no code); `logue-primitivePresentation.spec.ts` (`position`
named by POSITION's `modulatedBy`); `logue-additiveDepth.spec.ts` and CLAUDE.md's list of
whole-range inlets (POSITION at depth 100); `logue-hoisting.spec.ts` with all inlets wired from
constants; `cpuCostTable.ts` (variants base / control / step / heavy-moving-position) and
`codeSizeTable.ts` re-measured; CLAUDE.md counts (92 -> 93 primitives, osc 14 -> 15) and a
"Per-primitive gotchas" entry.

Verification:
- **The criterion this is for**: with an LFO scanning POSITION across all frames at up to
  5 Hz, the output's fundamental stays at the note within 1 ct (autocorrelation peak lag, not
  zero crossings), at notes 36/60/84.
- Off-harmonic energy at high notes (phase-dist's harness method): with a bright frame stack
  (saw frames), at notes 84-108 and level boundaries, the target is -40 dB or better; this is
  where the 18 kHz rule gets tuned.
- Crossfade: RMS at the midpoint between two aligned frames within 1 dB of the endpoints'
  mean (a misaligned pair would dip).
- A bend across a level boundary: no step larger than the waveform's own slope (crossfade
  version).
- Host harness (xd, ASan/UBSan): fuzz with extreme notes/COARSE, a wired `position` beyond
  +-1, frameCount 2 and 64.
- Real ARM builds on both platforms (`scripts/stageWavetable.ts`: unwired, all wired, 32 x 256
  on the xd, 64 x 256 and 32 x 512 on NTS-1 mkII); RAM estimate against bss+rodata; xd
  emulator cycles.

### Phase 2 results (2026-10-04)

Built as planned, with these differences: levels never shorter than 64 points (above); the
frame shape is in members set in `init` (`renderExpr`/`blockConstants` can't see the node);
`sample/wavetableRead.ts` (the read in TypeScript, single precision) came forward from phase 3,
since the harness compares the unit against it. MORPH is a select (Smooth/Step).

- **The criterion**: a ramp LFO scanning POSITION one way over every frame, the fundamental's
  frequency (its phase per window, Blackman-Harris over 8+ periods) shows no sustained offset:
  mean <= 0.03 ct at notes 36/60/84 for 1 and 5 Hz scans, fixture and soul vocal. Granular SYNC
  on the same vocal and scans: -18.5..+20.9 ct. The window-to-window wobble (up to ~3 ct at a
  5 Hz scan, note 36) is fast timbre change spreading energy next to the fundamental -- the
  fixture's fundamental is identical in every frame and wobbles as much -- not a pitch shift.
  Autocorrelation and 40 ms windows read that wobble as a few cents of drift first.
- **Unit = reference** within 1.2e-7 (notes 24..120, three positions, both MORPHs).
- **Aliasing** (off-harmonic energy, Blackman-Harris; Hann's own floor was ~-58 dB): the
  fixture saw, the worst possible frame, -39 dB at note 78, -42..-51 elsewhere from 60 up; the
  soul vocal <= -46 dB at every note and position. The rest is linear interpolation's images
  at 4 points per cycle of a level's top harmonic. Tried in a model (`all 256` = every level
  256 points): Hermite reads +6 dB, doubling level lengths ~+10 dB in the middle notes, each for
  ~2x the reads or ~30 % more table. Not done.
- **Crossfade midpoints** (vocal): >= -0.58 dB, as phase 1's correlations predicted.
- **Fuzz** (noise into every inlet, notes 0/60/127, COARSE +-24, 2x128 / 64x256 / 8x512 tables):
  clean under ASan/UBSan, peak 0.991.
- **Builds**: see the budget table; xd only `note_w0` (with `pitch` wired) below `process`.
- **xd emulator**: 146 base, 149 control, 208 `heavy-moving-position` (POSITION from a sine LFO,
  its ~36 included). Additive is 178, granular SYNC 234. The per-line profile is mostly the 8
  table reads and lerps; hoisting the per-block frame/level split might save ~15 %.
- **CPU estimate against whole units** (measured / estimated saved..knob max, baseline included):
  POSITION on the Shape knob 165 / 165..227; `sense/control` into `position` 165 / 168..227; an
  LFO into POSITION 228 / 204..263; an LFO into POSITION and `pitch` 385 / 204..263. A moving
  `pitch` (a `note_w0` and the level search every sample) is understated like every
  oscillator's `control` variant (constants wired in get hoisted; CLAUDE.md "CPU"). The heavy
  variant first moved the pitch too (365), which put a knob-bound POSITION's maximum at 384.
- Code size ~1.0 KB first instance (xd), 0.7 KB more each.

## Phase 3: Inspector

- `SampleSection` for `sampleImport: 'wavetable'`: Frames (16/32/64) and Points (256/512)
  choices labelled with each device's share, Level (per frame / as recorded), and the import
  result ("32 frames from 1.84 s voiced, 0.30 s skipped; pitch Eb4 +-2 st; up to 12 harmonics,
  limited by the source's 7663 Hz").
- Drawing: the frame at the current POSITION, large, with a strip of all frames under it
  (live: follows the POSITION dial).
- Preview: a held note (C4, or the median detected pitch) rendered in JS by a reference
  implementation of the read (`sample/wavetableRead.ts`, also the harness's reference), scrubbed
  by the POSITION dial while playing.
- The import runs in the renderer at ~0.2-0.4 s per 2 s of audio, so a source near the 30 s
  cap freezes the UI for a few seconds: run it in a worker, or at least show a busy state.
- Verified in the built app (`run-desktop`): import a vocal, scrub, swap granular <-> wavetable
  and see the expected problem/offer.

### Phase 3 results (2026-10-04)

- `canvas/WavetableSection.tsx` (its own component, not a third branch of `SampleSection`): the
  cycle at the node's POSITION, drawn large (the device's level-0 blend, Smooth or Step:
  `sample/wavetableView.ts`); under it a strip of every frame (phase downwards, sign as colour,
  size as strength) that sets POSITION when dragged, one undo step (`beginGesture`/`endGesture`;
  the write keeps the param's slot and name); Frames / Points / Level (Even out / As recorded,
  `importWavetable`'s new `evenLevels`) with each choice's share of both devices; what the import
  found (pitched vs skipped time, the sung range, a harmonic ceiling from a low-rate file);
  re-import from the stored path; and a message plus re-import offer when the node holds a
  granular or sample-player sample (the other two players got the matching wording).
- Preview: an OscillatorNode with the cycle as a PeriodicWave (`cycleHarmonics`, no
  normalization, so level differences between frames are heard), middle C, updated as POSITION
  moves -- not the TypeScript read the plan named: the browser band-limits it, which sounds like
  the device's tables short of their aliasing, and it follows a scrub live with no worker.
- The import runs in the renderer behind an "Analysing…" state (a paint before it starts); no
  worker: ~0.2-0.4 s per 2 s of audio, a few seconds at the 30 s cap.
- **Found in the app**: a synthetic vowel sweep (a formant moving past the harmonics) came out
  "Sung A3–C7" -- the tracker locked onto a harmonic for ~60 ms whenever the formant sat on one,
  and those frames were cycles of that harmonic. `pitchTrack.ts` now checks for a much cleaner
  whole multiple of YIN's period (long locks under a steady formant) and re-measures hops more
  than ~1.6 st from their 200 ms context (short locks that look clean), with tests for both. Known
  miss, documented there: a narrow formant between two harmonics over a weak fundamental can
  repeat at (n+1)/n of the pitch for as long as it lasts; catching it risks octave-low tables.
  The soul vocal's result didn't change.
- Checked in the built app (`run-desktop`): empty state, a missing file's error, the soul vocal
  imported (G#3–D#4, 1.29 s used), a drag on the strip (POSITION 51, the node's dial following),
  one Undo back to 0 and a second removing the import, Play/Stop and scrubbing while playing, and
  a granular sample on a wavetable node (message, re-import from the stored path).

## Phase 4: hardware

The user's vocal loop re-imported from the original WAV, on a real xd (chords, POSITION on
Shape with the Mod LFO: the original complaint) and a real NTS-1 mkII (64 frames; POSITION
from an LFO).

## Open items / later

- int16 frames (half the frames for the same bytes, -48 dB -> -96 dB noise floor) if 8-bit
  grit turns out audible on smooth frames.
- An analysis range (start/end in the source) and choosing frames by spectral change instead
  of evenly over time.
- Non-recorded sources: importing a Serum-style wavetable WAV (frames back to back, 2048 points
  each) needs only the resampling and mip steps, not the analysis. Cheap to add once the
  pipeline exists.
- Use in effects (an LFO-like scan at a fixed note) isn't planned.

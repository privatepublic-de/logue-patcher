# logue-patcher history

How the current design got where it is: the round-by-round reports, measurements and reversals that used to live in CLAUDE.md. CLAUDE.md keeps only the current rules; look here for *why* a constant or workaround is what it is. Moved verbatim on 2026-09-28; nothing below is kept up to date.

## Per-primitive history (from CLAUDE.md, as of 2026-09-28)


- **`logue/mix/mix2`** averages (not sums) its two inputs — summing two correlated full-scale
  sources was found BY HARNESS to hard-clip; either unwired inlet reads as silence.
  **`logue/math/multiply`** (formerly `logue/mix/ringmod`) multiplies instead — because multiplication has an absorbing zero,
  EITHER unwired inlet mutes the entire output (unlike `mix2`'s partial loss) — a disclosed,
  correct consequence, not a bug. **`logue/filter/highpass-cheap`** is `in -
  onepole_step(...)`, reusing `lowpass-cheap`'s helpers verbatim; its `CUTOFF` defaults to 0
  (opposite of lowpass's 100) since that's the end of the SAME shared coefficient that
  guarantees passthrough for a highpass rather than lowpass.
- **`logue/mix/crossfader`** didn't link for the minilogue xd with the local toolchain (found
  2026-09-28 while measuring CPU, so probably broken since the Docker build was dropped):
  newlib's `sqrtf` sets `errno`, which drags `_sbrk`/`_write`/... stubs into the static xd link.
  It now uses `xfade_sqrtf`: `vsqrt.f32` inline asm on ARM (the same correctly-rounded result),
  plain `sqrtf` on the host harness. Emulator output of the ARM build matches the harness to
  0.001 RMS. Any new libm call needs the same real-link check on the xd -- `tanf` links, `expf`
  and `sqrtf` don't.
- **`logue/filter/comb`**: params `TUNE`/`FEEDBACK`/`DAMPING` (inlets `tune`/`feedback`/
  `damping`), renamed 2026-09-28 from the MiniFreak's `CUTOFF`/`GAIN` (user: those names hid that
  one sets the delay length, i.e. the pitch, and the other the loop feedback; same values and
  direction, value-preserving aliases; C++ members kept as `cutoffPercent_`/`gainPercent_`).
  Before phase 33 they were `DELAY` (inverted) and `FEEDBACK`. `FEEDBACK`/`DAMPING`/`TUNE` all
  pass through a warp curve
  (`comb_response_warp`/`cutoff_warp`) before becoming a coefficient — a linear dial would cram
  nearly the whole audible range into the last ~20% of travel. `TRACK>=50` switches `TUNE` from
  a free-running percent mapping to real Karplus-Strong pitch-tracking (`1/note_w0(note)`);
  `pitch`/`tune` inlets are mutually exclusive in effect depending on `TRACK` (an
  `InletTrackBadge` on the canvas node discloses which is currently live). `FEEDBACK` caps at
  `0.999`, not `1.0` — BIBO-stable at any value below 1 with no real cliff to approach, so `0.999`
  just rings far longer than a needlessly-conservative earlier `0.98` did.
- **`logue/filter/string`** (2026-09-24, dispersion redesigned through 2026-09-25): a genuine Karplus-Strong plucked string — deliberately
  NOT a modal/formant-style bank of parallel resonant filters (that direction, benchmarked via a
  real local ARM build + `objdump` instruction-count spike, cost ~21% of minilogue xd's per-block
  CPU budget at just 8 SVF modes and ~41% at 16, before anything else in a graph runs — abandoned
  for exactly that reason; see `logue-codegen/scripts/stageModalResonatorBench.ts`). Modeled on
  Mutable Instruments Rings'/Plaits' own `string.cc` (MIT-licensed) but NOT a verbatim port: a
  2048-sample delay line (originally 1024 — Plaits' own "Lite" string proportion, real shipped
  precedent on the same 32KB budget via `peterall/eurorack-prologue`'s `mo2_string` — doubled
  2026-09-25, see the low-register pitch-tracking paragraph below) read via 4-point Hermite
  interpolation (continuously tuned, unlike comb's sample-quantized read), a damping one-pole,
  and an 8-stage first-order allpass cascade (all stages sharing ONE coefficient — see the
  dispersion entry below for why that's the MEASURED right choice) for stiffness/dispersion
  character — a disclosed simplification of Rings'/Plaits' own separate multi-hundred-sample
  dispersion delay line, trading a little authenticity for a few bytes of state instead of a
  few hundred. Always pitch-tracked (no `TRACK` toggle the way comb has one — unlike comb, this
  primitive's whole reason to exist is to BE a tuned string). Per-sample cost is O(1) regardless
  of how rich the string sounds (one delay read/write, one onepole, a per-sample loop over the
  dispersion stage array, one DC blocker — no per-mode loop), confirmed via a real local build:
  the entire generated `Osc::process` (noise excitation + full string DSP; GCC inlined
  `string_step` then -- with the current toolchain it's a real, leaf call from `process`) was 700 bytes of code even with 8 dispersion stages at the original
  1024-sample size (a for-loop over an array compiles SMALLER than the earlier 3-stage version's
  3 unrolled calls, despite doing more per-sample work) — still smaller than the modal bench's
  resonator-only portion at the smallest mode count tried; code size is unaffected by the buffer
  doubling (a fixed-size array's own element count doesn't change the loop/read code, only its
  declared size). RAM, real local-build measurements (`arm-none-eabi-size`/`objdump` on a real
  minilogue xd `.elf`, not assumed): **4204 bytes `bss`** at the original 1024-sample size
  (~12.8% of the 32KB budget), **8300 bytes at the current 2048-sample size** (~25.3% of the
  32KB budget) — both match the hand-counted `stateBytesPerInstance` plus this generator's own
  fixed ~36-byte class baseline (`note_`/`noteFine_`/the sense-bridging members every generated
  `Osc` class always carries) exactly. NTS-1 mkII (looser 48KB RAM-load budget): 8344 bytes at
  the current size (~17.0%), also confirmed via a real local build.
  **Low-register pitch tracking (2026-09-25), a real user report**: "pitch tracking gets off in
  the low register below midi note 36." Root cause, found by re-deriving `string_step`'s own
  delay/compensation formulas numerically rather than assumed: `stringDelaySamplesExpr`'s own
  clamp (`delaySamples` capped at `STRING_MAX_DELAY_SAMPLES-4`) pinned the delay length at its
  ceiling for any note below ~46.9Hz (MIDI note ~30 at the original 1024-sample size) — the
  string's real closed-loop pitch stopped descending entirely below that (every lower note rang
  at the same fixed ~47Hz), and the last several semitones approaching that ceiling from above
  were ALSO measurably sharp (the tuning-compensation math fighting an increasingly tight budget
  as `delaySamples` gets pushed toward the cap) — a real, continuous mistuning that likely made
  it "sound off" a bit before the outright flatline, roughly matching the reported note-36
  impression. This was a real, disclosed, PRECEDENTED tradeoff (see `mo2_string` above), not an
  oversight — the user chose to pay the RAM cost anyway rather than accept the floor or add a
  separate bass-variant primitive. Fixed by doubling `STRING_MAX_DELAY_SAMPLES` to 2048 (the
  wraparound bitmask needs a power of two, so this is the only real step up) — floor is now
  ~23.5Hz (MIDI note ~18), covering the practical bass range. Confirmed via real local builds on
  both platforms (staged via `logue-codegen/scripts/stageStringFilter.ts`) — see the RAM
  paragraph above for the measured numbers; a second string instance on minilogue xd is now a
  real, tight fit rather than a comfortable one.
  **Dispersion went through THREE real, user-tested rounds (2026-09-24 through 2026-09-25)
  before it actually worked, and the third round found a genuine bug the first two didn't**:
  1. First: made the OVERALL amount note-dependent (real string stiffness/inharmonicity is
     audibly stronger on higher, thinner/more-taut strings than on low bass ones) via a plain
     affine factor of the played note, and changed the cascade from 2 IDENTICAL allpass stages to
     3 with DIFFERENT, progressively-scaled coefficients, reasoning (WRONGLY, see round 2) that
     this would "spread the effect across the spectrum."
  2. "Still too subtle at low notes and high notes too" — root-caused by actually MEASURING the
     real harmonic detuning via exact phase-accumulation solving (find the frequency where the
     whole loop's phase — delay + onepole + N allpass stages — satisfies a real resonance
     condition for harmonic k, compare to k×fundamental; a noisy time-domain simulation attempt
     gave wildly inconsistent results past the 5th-6th harmonic and had to be abandoned). Found:
     scaling stages down was backwards (N stages sharing ONE coefficient produce MORE detuning
     than progressively-scaled ones), and the compounding across stages is steeply NONLINEAR in
     the coefficient (a 2x reduction can crush detuning 5-10x). Redesigned to
     `STRING_DISPERSION_STAGES=8` stages sharing ONE coefficient (a `float[8]` array field) and a
     gentler note-factor floor (0.7, was 0.2).
  3. **"Still very subtle. most pronounced on higher notes with low decay setting. in the lower
     register it's not really audible"** — that specific pattern (stronger at high notes despite
     round 2's floor making low notes deliberately WEAKER) was the tell something was genuinely
     broken, not just subtle. Checked directly: at STRUCTURE=100 and a high note (C6, period≈46
     samples), round 2's own group-delay compensation needed ≈46 samples of budget — MORE than
     the note's ENTIRE period — so pitch tracking was silently breaking down above roughly C6 at
     high STRUCTURE, well within normal playing range. "Most pronounced on higher notes" was
     partly audible detuning FROM THE TUNING BREAKING, not a working effect. Root cause: a
     coefficient strong enough to be audible costs a large, roughly note-INDEPENDENT compensation
     budget, while a high note's own period (the total budget available) shrinks — any fixed
     coefficient large enough for low notes will eventually exceed a high note's whole period,
     and round 2's note-dependent floor (weaker at LOW notes) was exactly backwards for what this
     constraint needs. Fixed with a genuine constraint solve, not a curve: `string_step` computes
     at RUNTIME the actual maximum coefficient the CURRENT note's own period can afford (solving
     `STAGES*(1+c)/(1-c) <= budget` for `c`) and clamps the STRUCTURE-derived desired coefficient
     to that safe ceiling — the note-dependent floor/factor is gone entirely, STRUCTURE alone
     sets the desired amount. **A second real finding along the way**: naively raising
     `STRING_DISPERSION_MAX` to 0.85 (safe by the budget check) was separately verified to break
     the FUNDAMENTAL's own tuning by up to +66 cents at C5 — the DC-approximated compensation
     formula (accurate near zero frequency, not exact) becomes meaningfully wrong at high
     coefficient/high note combinations; a cheap frequency-aware (`w²`-only, no-trig) correction
     was tried and made some notes better but others worse, and was reverted rather than ship
     something that looks more accurate but isn't. `STRING_DISPERSION_MAX` is set to the
     measured-safe **0.72** instead (barely above the original 0.7) — real, disclosed, STILL-OPEN
     ceiling on how strong this primitive's dispersion can go without a genuinely more accurate
     (frequency-aware) compensation formula or a different mechanism entirely (a real multi-sample
     allpass delay line, closer to Rings'/Plaits' own technique, rather than single-sample
     cascaded stages). What DID improve: low/mid-register dispersion is no longer artificially
     weakened by the old floor (was as low as 0.7×0.7≈0.49 at the bottom of the register; now the
     full 0.72, since budget is abundant there) — the real, meaningful fix for "not really audible
     in the lower register." High notes taper smoothly instead of hitting a hard floor.
  **Two real bugs found and fixed testing on real hardware (2026-09-24), both worth knowing
  about before touching this primitive again**:
  1. *Pitch tracking was badly sharp above roughly C3* — the loop's own onepole damping filter
     and 2-stage allpass dispersion cascade each add a real, roughly pitch-INDEPENDENT group
     delay on top of the delay line's own length (a basic Karplus-Strong fact the first version
     missed) — negligible against a long bass-note period, a large fraction of a short
     high-note one. `string_step` now subtracts each stage's own DC group delay
     (`onepoleDelay=(1-a)/a`, `allpassDelay=(1+c)/(1-c)`, both derived from each helper's own
     transfer function, not guessed) from the target delay before the Hermite read. Verified
     TWICE, not just reasoned about: analytically (17/34/69 cents sharp at C3/C4/C5 at default
     DAMPING/STRUCTURE, predicted from the group-delay formulas) AND via a full numerical
     simulation of the exact algorithm with autocorrelation pitch detection (measured
     -14.4/-33.0/-60.6 cents uncompensated → -0.3/+4.4/-5.0 cents compensated at the same three
     notes) — both independently confirm the fix. Growing DAMPING/STRUCTURE increases the
     compensation further (they directly increase the filters' own group delay), so this isn't
     a one-time bass-register-only fix, it holds across the whole param range.
  2. *DECAY needed to be an ABSOLUTE, register-independent time, then genuinely LOSSLESS at
     100%* — three rounds of real feedback, each one a real miss, not just polish:
     - Round 1: raising `STRING_DECAY_MAX_GAIN` (comb's own `0.999`) alone made the symptom
       WORSE: seconds-to--60dB is cycle-count TIMES the played note's own period, so a flat
       per-cycle gain is inherently register-DEPENDENT no matter how high the ceiling goes — and
       the same session's tuning-compensation fix (above) shortens the loop's own effective
       period, so real-time decay got FASTER despite the higher ceiling.
     - Round 2: with no wired `decay` inlet (the common case), `decayGain_${suffix}` became a
       per-instance field computed ONCE per real `noteOn()` (not per sample) from an EXACT
       formula solved for a target TIME regardless of period -- `g = exp(ln(0.001) * period /
       (targetSeconds * 48000))`, `targetSeconds` a plain affine 0.05s–10s map of `DECAY`.
       Verified to actually give ~10.0s at DECAY=100 at BOTH a low note (C3, period≈367) and a
       high note (C5, period≈92) — but even a CORRECT, VERIFIED 10-second decay "didn't
       register" perceptually, and the real ask was "ring out like an open guitar string with NO
       DAMPING" — a finite RT60 number, however large, can't express that.
     - Round 3 (the actual fix): `DECAY=100` is now a genuine special case, not just the top of a
       bigger seconds range — `noteOnStatement` sets `decayGain_` to a literal `1.f` there
       (mathematically lossless at the fundamental, since `onepole_step`/`allpass1_step` are both
       already unity-gain — not an approximation of "very long"), matching `logue/filter/svf`'s
       own `RESONANCE=100`->`k=0` "rings forever once excited... accepted, working-as-intended"
       precedent exactly. `DECAY` 0-99 still uses the exact seconds formula, now over a wider
       0.05s-30s range (`STRING_DECAY_MAX_SECONDS`) so the approach to the lossless top feels
       continuous, not a cliff.
     - **A wired `decay` inlet is a real, disclosed exception to ALL of this**: `noteOnStatement`
       has no access to a node's wired inlets at all (only plain per-instance fields), so a
       live-modulated decay can't use the noteOn-time formula OR the lossless special case — it
       falls back to the OLDER cycle-count-based shape (`STRING_DECAY_MAX_GAIN = 0.9998`, comb's
       own math with a higher ceiling), a deliberate divergence: live-modulated decay is a
       genuinely different (expressive, continuous) use than "how long does THIS pluck ring."
     - **`expf` doesn't link on at least one real local ARM toolchain** — a genuine, confirmed
       finding, not a hypothetical: `logue/filter/svf`'s own `tanf` exception links clean, but a
       real local build of this exact `expf`-based formula failed at LINK time (newlib pulled in
       reentrant syscall stubs — `_sbrk`/`_read`/`_write`/`_close`/`_lseek` — this minimal
       embedded target doesn't provide). Not all libm functions are equally safe even when
       confined to a rare call site. Fixed by NOT using real `expf` at all: `exp_approx` is a
       range-reduced Padé[2/2] approximation (divide the argument by 8, apply the rational
       approximation, square the result 3 times), verified numerically to <0.01% relative error
       across the whole range this formula actually uses — libm-free like the rest of this file,
       and immune to this class of toolchain-version risk entirely.
- **`logue/osc/exciter`** (2026-09-25): a one-knob noise exciter designed specifically to feed
  `logue/filter/string`/`comb`, replacing a hand-wired `noise` → `ad` → `vca` chain that a user
  found sounded "too noisy/electronic" for a plucked string. `BOW` (0-100) crossfades the WHOLE
  character along one axis rather than two independently-dialed times: the real pluck/bow divide
  isn't attack length, it's whether the body decays regardless of note-hold (pluck) or only after
  a real note-off (bow) — so `pluck_exciter_step` reuses `logue/env/ahd`'s own 4-stage machine
  (0 idle/1 attack/2 hold/3 release) with one change, stage 2 also subtracts a `BOW`-dependent
  `heldDecayRate` instead of doing nothing: large at `BOW=0` (runs to 0 in ~8ms even while held —
  `ad`'s "ignore note-off" behavior falling out for free), exactly `0` at `BOW=100` via
  `cutoff_warp(1-s)` hitting its own zero endpoint (a genuinely lossless hold for as long as the
  note stays down, same "curve hits its endpoint exactly" precedent `svf`'s `RESONANCE=100`→`k=0`
  and `string`'s `DECAY=100`→`decayGain_=1` already use). Tone is a straight linear blend, not a
  branch: a fixed bright `aPluck` coefficient crossfades toward a note-tracked `aBowTracked`
  (`2*k*w0`, `k` harmonics' worth of bandwidth above the fundamental, floored) as `BOW` rises —
  deliberately note-tracked at the bow end specifically because a CONTINUOUSLY-fed resonant loop
  develops its "singing" quality from many round-trips reinforcing the string's own harmonics,
  which only works if the fed noise stays concentrated near those harmonics across the whole
  playable register, not just at whatever note the filter cutoff happened to be tuned for by ear.
  No `COARSE`/`FINE` (this primitive isn't itself a pitched tone, it only reads the played note to
  steer tracked brightness). `bow` (control inlet, added after real use so BOW can be swept live
  by another node — an envelope crossfading pluck→bow mid-performance, or an LFO wobbling between
  the two) is ADDITIVE like every other MODERN inlet in this file (`width`/`rate`/`drive`/
  `structure`/`damping`/`decay`), not full-replace like the original `cutoff`/`gain` precedent —
  a wired source bends the dialed `BOW` position rather than taking it over, `+-50` depth (half of
  `BOW`'s own 0-100 range), clamped back into range.
  **Second round (2026-09-25), real user feedback**: "the short burst is fine [...] but the
  'bowing' attack starts too soon. after the short burst [...] there need to be more softer
  strikes, that sound more like nylon guitar strings" — a real, physical distinction (a
  harpsichord's quill pluck is one hard bright transient; a classical guitar's attack is often a
  quick FLURRY of softer, rounder re-catches, not one smooth swell). Two real changes: (1) attack
  rate is now FIXED (`env_rate_from_percent(0.f)`) for every strike, decoupled from `BOW` entirely
  — the original design scaled attack rate with `BOW` from the very first strike, so even a
  moderate `BOW` already gave a slow, mushy onset well before its own top end; now the onset is
  always the same crisp ~5ms transient `BOW=0` always had, and all softening happens through (2) a
  real decaying STRIKE TRAIN: reaching `level<=0` in the hold stage no longer always means "go
  idle" — `strikesRemaining_`/`strikeGain_` (2 new per-instance fields, `stateBytesPerInstance` now
  28) retrigger stage 1 at a reduced peak (`strikeGain_ *= 0.55` each time,
  `EXCITER_STRIKE_GAIN_RATIO`) for as long as `strikesRemaining_` is positive and the note is still
  held, before the LAST one finally goes idle (or never needs to, at high enough `BOW` where
  `heldDecayRate` hits 0 first). `strikesRemaining_` is derived from `BOW` ALONE, recomputed once
  per real note-on (same "`noteOnStatement` can't see a wired inlet" limitation `string`'s own
  `decayGain_` doc comment discloses) — so `BOW=0` still gets exactly zero extra strikes, the
  original single-shot click untouched. Tone additionally warms with `max(s, 1-strikeGain)`, not
  `s` alone, so a later/quieter strike is always at least as warm as its own `strikeGain` implies
  regardless of where `BOW` sits — the literal "softer AND warmer with each strike" the
  nylon-guitar comparison asked for.
  **Third round (2026-09-26), real user feedback**: "pure white noise doesn't do the string pluck
  and bow sounds justice... is there anything we can do about the exciter noise to sound more
  natural?" Plain LCG white noise (`noise_step`) is flat to Nyquist — real excitation noise (a
  pick scraping, a bow's stick-slip friction) is naturally weighted toward the low end, which
  onepole lowpassing alone only approximates. Fixed with `pink_noise_step` (3 new per-instance
  fields `pinkB0_`/`pinkB1_`/`pinkB2_`, `stateBytesPerInstance` now 40): Paul Kellet's "economy"
  pink noise filter, a well-known, cheap, no-libm recursive 1/f approximation (3 leaky-integrator
  stages summed at fixed weights), recolors the SAME white sample `noise_step` already produces —
  no second independent LCG. Blended into the excitation by the SAME `warmth` value already
  driving the tone crossfade (`noiseSample = white + warmth*(pink-white)`) rather than a separate
  control: the very first strike (`warmth=0`) stays the exact bright, crisp white-noise click it
  always was — no regression to the already-liked pluck — while every softer/later strike and the
  bow-sustain end gets progressively pinker along with progressively darker, compounding with the
  tone blend instead of just being quieter, duller white noise. `pink_noise_step` is always
  advanced (not gated behind how much `warmth` currently wants), same "keep the filter state
  continuously settled, don't make it visibly catch up later" reasoning `onepole_step` is always
  called for. Confirmed via real local ARM builds on both platforms
  (`logue-codegen/scripts/stageExciterString.ts`, a new companion to `stageStringFilter.ts` wiring
  the exciter into the string specifically) — compiles clean, 8336 bytes bss on minilogue xd /
  8380 on NTS-1 mkII for exciter+string together (the exciter's own real contribution, 36 bytes
  over the same patch with a plain `noise` node instead, matches `stateBytesPerInstance`'s own
  40-vs-4-byte delta exactly).
  **Fourth round (2026-09-26), real user feedback, a SECOND report on the pink-noise feature
  itself**: "with higher bow the exciter signal gets too much overall gain and the resonated
  sound gets really more distorted." Root-caused numerically, not assumed (a real simulation of
  the exact LCG + Kellet filter, 5,000,000 samples): the RAW pink filter's own output ran ~3x
  white noise's own RMS and ~7.7x its peak — its low stages (`b0` especially) are near-unity-
  feedback leaky integrators with real DC gain in the tens, so blending more of it in as `warmth`
  rises (exactly what "higher BOW" means) was a genuine, measured loudness increase, not a
  subjective impression. Fixed two ways: `PINK_NOISE_GAIN_COMPENSATION` (`0.3374`, the measured
  `rms(white)/rms(pink)` ratio from that same simulation) scales `pink_noise_step`'s own output
  down to match white's RMS — confirmed afterward, 0.5775 vs 0.5772 at full pink, matched, and a
  dedicated test (`logue-generateOldGenOscUnit.spec.ts`) reimplements the exact shipped LCG +
  filter formula and asserts that ratio stays within 10% so a future edit to either constant
  can't silently drift back into the bug. Pink noise built this way still has a wider crest
  factor than white's own tightly bounded distribution even after RMS-matching (a real, disclosed
  property of the technique) — `pluck_exciter_step`'s own final blended sample is additionally
  clamped to `[-2,2]`, a measured, rare safety net (0.033% of samples at worst-case full
  `warmth` in the same simulation) on top of the real fix, not the fix itself. Re-confirmed via
  the same real local ARM builds — bss unchanged (no new state, only formula changes), `.text`
  grew ~50 bytes on minilogue xd for the extra clamp/multiply.
  **Fifth round (2026-09-26), real user feedback, a genuinely DIFFERENT mechanism from the pink-
  noise gain bug**: "the exciter is coming in too hot" -- still present after
  `PINK_NOISE_GAIN_COMPENSATION` fixed the noise color's own RMS, because that fixed a different
  lever entirely (the color's average power) from this one (the envelope's own held level). At
  high `BOW`, `heldDecayRate` approaches 0 (see its own doc comment) so `*level` pins at its peak
  and STAYS there for as long as the note is held — a continuous, near-full-amplitude feed into a
  resonant loop, structurally different from a decaying pluck's bounded, self-limiting energy. A
  resonant delay loop fed continuous energy builds toward a steady-state amplitude that grows
  sharply as the loop's own per-cycle retention approaches 1 (a real order-of-magnitude estimate
  from the loop's own feedback-gain arithmetic) — exactly the "bow into a long-`DECAY` string"
  patch a user would actually build. Fixed by `sustainLevelScale = 1 - warmth*0.65`
  (`EXCITER_SUSTAIN_LEVEL_DROP`) scaling the FINAL output by the SAME `warmth` value already
  driving tone/noise-color: the initial transient (`warmth=0`) is completely untouched, while the
  continuously-held portion tapers down as `BOW`/the strike train pushes toward sustained
  territory — tamed at the exciter itself rather than by asking the string's own `DECAY` to do
  less. Re-confirmed via the same real local ARM builds — bss unchanged, `.text` grew ~20 more
  bytes. **Open**: unlike the pink-noise gain fix, no closed-form "correct" attenuation exists
  here (it depends on the downstream resonator's own `DECAY`/`GAIN`, which this primitive has no
  visibility into) — `0.65` is a real, disclosed ear-tune starting point, not verified against
  real hardware yet, same as `EXCITER_HELD_DECAY_RATE_MAX`/`EXCITER_PLUCK_A`/
  `EXCITER_TRACKED_HARMONICS`/`EXCITER_TRACKED_MIN_A`/`EXCITER_STRIKE_MAX_COUNT`/
  `EXCITER_STRIKE_GAIN_RATIO` — no real hardware/harness pass has confirmed any of these yet the
  way `cutoff_warp`'s cube or `string`'s dispersion constants were.
- **`logue/osc/granular`** (2026-09-26): an imported sample (`ObjNode.sample`, 8-bit G.711 mu-law
  -- random-access, unlike ADPCM; decoded through a 1 KB baked float table) read by a fixed pool
  of 4 overlapping windowed grains, recycled round-robin (grain length capped at 4 spawn
  intervals so a sounding grain is never stolen). `SYNC` on (default): one grain per note
  period at the stored rate -- pitch from the grain rate, timbre from `POSITION`, formants fixed
  (at `SIZE` minimum and no `SMEAR` it's a wavetable scanned by `POSITION`); off: classic
  granular, grains transposed by `note/ROOT` on their own `SIZE`(ms)/`DENSITY` clock.
  `WINDOW` morphs Tukey (5% taper) -> Hann -> Hann^4, libm-free (Bhaskara `sin`); output is
  normalized by overlap x window area, never boosted. Reads are linear-interpolated and speed is
  capped at 16x -- the import's resampler is the only anti-aliasing (disclosed lo-fi, and
  wanted). **Import** (`logue-codegen/src/sample/`, dependency-free, tested): WAV (PCM 8-32 /
  float) -> mono -> silence trim -> windowed-sinc resample so the WHOLE file fits the chosen
  size (4K/8K/16K default/32K samples = bytes; no crop step, the rate follows from the length,
  floored at 2 kHz with the tail cut and disclosed below that) -> peak normalize -> mu-law; YIN
  proposes `ROOT`. Main only reads the file (`sampleFile` IPC); the Inspector's
  `SampleSection.tsx` runs the import and shows waveform/rate/budget. **Measured** (real local
  ARM builds, `logue-codegen/scripts/stageGranular.ts`, 16K sample): minilogue xd 19496 B
  text+rodata (16384 sample + 1 KB mu-law table + ~2 KB code), 172 B bss (140 per-instance +
  baseline, matches the estimator); NTS-1 mkII 22955 B total. Host harness (ASan/UBSan clean):
  SYNC pitch within +-1.3 ct from note 24 to 108 (noise sample, autocorrelation); TRANSPOSE
  content follows `note/ROOT`. **Real xd hang (2026-09-26)**: turning knobs hung a real
  minilogue xd (note stuck, UI dead) -- the first version called `granular_step` for real, and
  it called `mulaw_decode`/`grain_sin_pi` in turn with a 96-byte frame, the same `-Os` shape as
  the formant crash, while a 25M-sample random-param fuzz under ASan/UBSan/float-cast-overflow
  found nothing. Every grain helper is now `always_inline` (pinned by a test), leaving the
  hardware-proven `_hook_cycle -> process -> leaf note_w0` shape; the same pass cut per-sample
  divides from ~8 to 1-3 (divide-free window `sin`, phase-accumulator spawning, per-grain math
  only at spawn), since the xd runs this once per voice. `SMEAR` is cubed -- linear, one step
  off 0 already decorrelated overlapping grains audibly. Note: with `SMEAR=0` and SYNC off the
  cloud is periodic at the spawn rate, so transposed content lands on that rate's harmonics
  (measurement quirk, not a tuning bug). Inlets: `pitch` plus additive `position`/`smear`/
  `size`/`density`/`window` (+-50, clamped; `density`'s is SYNC-gated like its dial) -- `ROOT`
  deliberately has none (user call). **Confirmed on a real minilogue xd** (user, 2026-09-26):
  no more hangs, and the wired inlets sound right. **Second xd hang (2026-09-26), a CPU one**:
  SYNC on, SIZE 100, WINDOW 100 -- the worst case by construction (all 4 grains active, the
  costliest window path). The xd's MCU is an STM32F401 Cortex-M4, **84 MHz max: ~1750 cycles per
  sample for everything**, and the oscillator runs once per voice; a static count put that
  setting near 550 cycles/voice-sample. Cut to ~400 (mu-law via table instead of bit ops, a
  loop-free window power ladder, per-grain overlap gain set at spawn instead of a per-sample
  divide, `note_w0(ROOT)` skipped with SYNC on); output unchanged (same pitch/peak/RMS in the
  harness), host proxy -22%. Still ~90% of the budget at 4 voices by that estimate -- if chords
  at those settings still hang, the next lever is the grain count (4 -> 3) or a CPU-aware cap.
  Budget lesson for any new primitive: count cycles per voice-sample against ~1750/voices, not
  host timing (the host was within 10% of `string` here while the M4 cost wasn't). **Third xd
  overload (2026-09-27), SYNC off at DENSITY 100 with chords**: SYNC off made two `note_w0` calls
  and three divides per sample, and DENSITY 100 kept all 4 grains active. Fixes: the grain setup
  (speed, spawn rate, grain increment/gain, window shape) is recomputed every 16 samples
  (`GRANULAR_CONTROL_PERIOD`, `ctl_`/`ctlCount_`, +32 B; the call site passes the setup-only
  arguments as `ctlCount_ == 0u ? expr : 0.f`, and note-on forces a tick). A consequence: a wired
  `pitch` is only read at that rate. SYNC-off overlap now tops out at 3 (`GRANULAR_MAX_OVERLAP`,
  DENSITY rescaled to 0.5..3). SYNC keeps 1..4 periods. Also, `lfo_rate_from_percent` and
  `fast_lfo_rate_from_percent` now multiply by `1/48000` instead of dividing: GCC keeps `/ 48000.f`
  as a real 14-cycle divide. The fixes were measured with `logue-codegen/scripts/emulateXdCycles.py`
  (unicorn), which runs the real `.elf` hooks with M4-weighted instruction costs and can profile
  per source line. That is an estimate, and its scale is about 1.4x the older hand counts. The user's patch (granular + 2 LFOs + mux/multiply) went from
  795 to 486 cycles per voice-sample; the SYNC-on SIZE/WINDOW 100 worst case (`stageGranular`
  noise patch) went from 576 to 478. Static-param renders are byte-identical before/after the
  control-rate change (SYNC off and on). **The DENSITY rescale is a disclosed silent change** for
  existing documents: any DENSITY below 100 now gives less overlap than before, and at DENSITY 100
  output is ~1.6 dB louder (fewer grains to normalize). With SMEAR, spawn-rate ripple rose a little
  (SIZE 50: 2.2x -> 3.7x the modulation-spectrum median; SIZE 100: 15x -> 25x). Keeping 4 grains
  would cost ~557 on the same scale. Neither 486 nor 557 is confirmed safe on hardware.
  **Previous note bleeding into a new one** (2026-09-27, user report, not caused by the control
  rate): every grain used to keep the speed it spawned with, so after a big note jump the grains
  already sounding carried the old pitch for about one grain length (~100 ms at SIZE 100, both
  directions, and already in the pre-control-rate code). Grains now all advance by the current
  `speed`, which drops `gStep_` (-16 B) and makes pitch bend reach sounding grains too.
  Static-param renders are byte-identical. SYNC is unaffected (its speed never depends on the
  note), but after a note change its old-period grains still finish their up-to-4-period windows.
    **Smoothness** (same session): SMEAR 0 with SYNC off replays one identical slice every spawn
  interval, which is a buzz/pulse at the spawn rate (about 60 Hz at SIZE 50) that no
  SIZE/DENSITY/WINDOW setting removes. SMEAR >= ~30 with WINDOW ~50 (Hann) makes it a smooth cloud.
  **Open**: no NTS-1 mkII hardware test; the reduced cost not yet confirmed with chords on a real xd.
- **`logue/filter/svf`**: ZDF/"trapezoidal" topology (not naive Chamberlin) specifically for
  exact pitch-tracked resonance. `RESONANCE=100` → `k=0` (lossless resonator) is marginally
  stable, not unstable — rings forever once excited but won't self-start from silence; this is
  accepted, working-as-intended behavior, don't "fix" it without a new concrete reason.
- **`logue/filter/formant`**: 3 parallel ZDF-bandpass taps tuned to Peterson & Barney (1952)
  vowel formants, `VOWEL` order `u→o→a→e→i` (NOT alphabetical — alphabetical makes F2 jump
  non-monotonically). Quiet output at high `RESONANCE` is a fixed unity-peak-gain design choice,
  not a bug — route through `logue/gain/vca` to compensate rather than adding automatic gain
  compensation to `formant` itself (rejected: would reintroduce clipping risk on
  harmonically-tuned sources). On minilogue xd specifically: `formant_bp_step`/
  `formant_g_from_note` must stay `__attribute__((always_inline))`, and calls to `note_w0` inside
  them use a dedicated `formant_note_w0` duplicate, NOT the shared helper — removing that
  inlining reintroduces a real crash that only reproduces on real hardware at the SDK's default
  `-Os`, never fully root-caused (only empirically cornered via an 11-build bisect).
- **`logue/osc/additive`**: single `TIMBRE` knob (full-replace, not a modulation depth)
  crossfades 6 hand-designed baked wavetable frames (12312 bytes, ~37.5% of minilogue xd's whole
  RAM budget), computed once at codegen time in TypeScript and baked as a `static const` table —
  on-device is pure lookup+lerp, no runtime harmonic synthesis. A runtime Nyquist clamp caps how
  far `TIMBRE` can reach based on the currently-played note, continuously. **Open**: no real
  Docker build has measured actual compiled size against budget; only an earlier 4-frame design
  was confirmed on real hardware, not the current 6-frame one.
- **`logue/gain/vca`**: `GAIN` is 0-100%/**0-4x** (not 0-1x) — widened for real headroom, unity
  gain moved from raw `100` to raw `25`. A real, disclosed SILENT behavior change for any
  pre-existing document with a non-default `GAIN`.
- **`logue/env/ad` vs `logue/env/ahd`**: `ad` is a one-shot pluck that always runs to completion
  regardless of note length and ignores note-off entirely; `ahd` gates its hold stage on the real
  note-off event (the first primitive needing `noteOffStatement`). Deliberately separate
  primitives, not a mode flag on one — retrofitting risked silently changing `ad`'s existing
  disclosed contract.
- **`logue/sense/*`**: only `cutoff`/`resonance`/`param` are minilogue-xd-only; `pitch`/`shape`/
  `shape-2` work on both platforms (each reading that platform's own real underlying mechanism).
  `velocity` (2026-09-28) is NTS-1 mkII-only: it latches `noteOn`'s velocity per instance through
  `noteOnStatement`'s `note.velocity` (only the NTS-1 mkII generator passes one), and
  `LoguePrimitive.readsVelocity` is what makes that generator name its `velo` parameter, so no
  other unit's source changes. Whether the NTS-1 mkII's own keys send varying velocity (rather
  than only external MIDI) hasn't been checked on the device.
  Every sense primitive except `gate` (2026-09-25) has TWO outlets, `unipolar`/`bipolar` — every
  sense reading is natively unipolar `0..1`, but this registry's other sources (oscillators/LFOs/
  `constant`) are bipolar `-1..1`, and needing a separate `logue/util/unipolar-to-bipolar` node
  every time a sense value fed a bipolar-expecting inlet was a real, repeatedly-hit patching cost
  (user-reported). Both forms are computed directly off the one reading via
  `renderOutletStatements` (`bipolar = unipolar*2-1`); `unipolar` is declared first so
  `resolveDeclaredOutletName`'s "no/legacy `'out'` outlet name -> use the first declared one"
  fallback resolves an already-authored net to the exact value it read before this change, with
  no per-primitive migration needed. That fallback is shared verbatim (`primitives.ts`) between
  codegen (`oscInstances.ts`) and the canvas's own edge-validity/handle-id resolution
  (`toFlowGraph.ts`) — a real bug surfaced during this change: without sharing it, a pre-existing
  net still wired to a sense node's implicit legacy `'out'` outlet resolved fine at Export/Build
  time but rendered as a broken/dashed edge on canvas, a misleading disagreement between the two.
  `gate` was deliberately excluded — its `held_` is a discrete note-on/off boolean read through
  the registry's shared `>=0.5f` gate convention elsewhere, not a continuous value with a genuine
  polarity ambiguity.
- **`logue/logic/greater-than`/`less-than`/`equal`/`schmitt`** (2026-09-25): the first three
  collapse a variable-vs-constant compare and a variable-vs-variable compare into ONE primitive —
  a `THRESHOLD` dial (`-100..100`, same domain/scale as `logue/util/constant`'s own `VALUE`) plus
  an optional additive `b` inlet, unclamped and added in raw (an operand, not a modulation depth,
  so it deliberately skips the usual `+-50`/clamp-to-range treatment every other additive inlet
  uses). Unwired `b` means "compare against a dial"; wired `b` with `THRESHOLD=0` means a true
  two-signal compare. `equal` needs its own `TOLERANCE` window on top — exact float equality
  against a dial is otherwise unreachable, the same float-roundtrip hazard `harmonic_ratio`'s own
  doc comment discloses. `schmitt` reuses the SAME `THRESHOLD_PARAM` object (the identical
  shared-spec-across-primitives precedent `COARSE_PARAM`/`FINE_PARAM` already set for every
  oscillator), adding a `HYSTERESIS` dial for a real dead band (`high = THRESHOLD+HYSTERESIS`,
  `low = THRESHOLD-HYSTERESIS`) — the actual reason to reach for it over a plain `greater-than`:
  a signal hovering right at one fixed threshold otherwise chatters the output rapidly
  open/closed.
- **`logue/math/scale` vs `logue/gain/vca`+`logue/math/invert`, `logue/util/glide` vs
  `logue/filter/lowpass-cheap`** (2026-09-25): both new primitives were checked against what
  already exists first, the same "already covered" test that killed a standalone plain-attenuator
  primitive once before (see the conventions bullet above). `scale` (multiply by a constant, or
  divide by dialing the reciprocal) genuinely overlaps with chaining `vca` (`gain` unwired,
  0-4x, positive only) and `invert` — added anyway because that costs two nodes/a wire for one
  control, and `vca`'s own audio-gain framing is awkward for rescaling a CONTROL signal's depth;
  `scale`'s own bipolar `-100..100` `FACTOR` dial tops out at unity (no boost) as the tradeoff for
  attenuation+sign-flip on one dial. `glide` (a true LINEAR slew-rate limiter/portamento)
  overlaps with `lowpass-cheap` fed a low `CUTOFF` (already an EXPONENTIAL lag on any signal via
  `onepole_step`) but is a genuinely different constant-max-rate-of-change character — the real
  distinguishing trait of a hardware slew limiter, not reachable by re-tuning the existing
  one-pole filter. A two-signal multiply exists as `logue/math/multiply` (the renamed
  `logue/mix/ringmod`, 2026-09-27 — renamed rather than duplicated, same "don't add a byte-identical
  second primitive" rule as above); a wired-variable-divisor `divide` was dropped once the user
  narrowed the ask to constant-factor scaling only.
- **`logue/mux/mux4`**: a wired `index` inlet is read in this registry's default bipolar `-1..1`
  domain, rescaled linearly to `0..3` and ROUNDED (not truncated) via a real helper
  (`mux4_select`) before selecting a branch — the same `harmonic_ratio`-style "round to the
  nearest integer, don't truncate" lesson (truncating would bias every index boundary the same
  direction instead of landing on the nearest one). `mux2`/`mux4`/`demux2` all hard-switch
  (click on audio-rate signals) rather than blend — `logue/mix/crossfader` stays the tool for an
  audible fade; a `SELECT`/`INDEX` dial is the fallback, fully REPLACED (not blended) by a wired
  `sel`/`index`, the same "position with a signal" shape `crossfader`'s own `fade` already uses.
- **`logue/util/sample-delay`** (2026-09-28): a one-sample delay (z^-1), the only node a
  feedback loop may pass through (feedback FM, cross-FM, feedback around a folder/filter). Its
  `in` is a `delayedInlets` entry: read only in `advanceStatement`, after every compute statement,
  so the loop has a defined order; `logue-feedback.spec.ts` pins that no primitive reads a
  delayed inlet from `renderExpr`. The stored value goes through `sample_delay_store`: inf/NaN
  (checked on the exponent bits) resets to 0 and the value is clamped to +-4, so a loop with gain
  above 1 saturates instead of running off to NaN forever -- a bounded rail is still a loud DC
  output, disclosed in its description. Host harness (ASan/UBSan clean): feedback FM on a sine
  at FM_DEPTH 30 adds the expected harmonics (h3 0.21, h4 0.10 against a pure sine's 0), and a
  gain-2 loop (mix2 -> vca 4x -> delay) pins to the rail with no non-finite sample. Real local
  ARM builds link clean on both platforms; xd `process` makes no real calls. Wires in a loop keep
  their colour (`'inherit'` resolves through the non-delayed side). **Open**: no hardware
  listening pass yet.
- **`logue/lfo/fast-square` + `logue/util/sample-hold`** (2026-09-26 as `util/trig-hold`, renamed 2026-09-28, user request): a clock and a
  sample-and-hold meant to be used together. `fast-square` is a NAIVE (no PolyBLEP) `-1/+1` pulse
  with `WIDTH` (+ additive `width` inlet), so the edge a trigger input thresholds on stays sharp.
  `TRACK` (comb/svf convention, checkbox, gates RATE vs COARSE/FINE and `rate` vs `pitch` the same
  way) switches between a free `RATE` (0.1Hz-2kHz, `hz = 0.1 + t^4*1999.9`, mirrored exactly by
  `paramPresentation.ts`'s `fastLfoHzUnit`) and the played note via `transposedW0Expr`. No `harmonic`
  inlet: its x16 can push the increment past 1, which the single-`if` wrap can't handle.
  `WIDTH=0`/`100` gives a constant with no edges, so nothing downstream triggers. `sample-hold`
  latches `in` on a rising `trig` edge (`>=0.5f`, like `logic/edge`, including the power-on edge
  when `trig` starts high), passes `in` straight through with `trig` unwired, and reads unwired
  `in` as `0.f`. `logue/lfo/random-steps` (internal clock, noise fallback; `lfo/sample-hold` until 2026-09-28) stays as it is. Real
  local ARM builds of sine -> sample-hold clocked by fast-square (`scripts/stageFastSquareTrigHold.ts`)
  compile and link clean on both platforms (xd: 1052 B text, 80 B bss; NTS-1 mkII: 4616 B text),
  with only leaf `note_w0` calls below `Osc::process`. **Open**: no hardware or harness listening
  pass yet.
- **Every `logue/lfo/*`'s `trig` inlet** (2026-09-27, user request -- meant mostly for
  `logue/sense/gate`): a rising edge (`>=0.5f`) resets the phase, via one shared
  `lfoTrigResetStatement` emitted in `advanceStatement` AFTER the advance, so the reset shows one
  sample late and `renderExpr` stays a pure phase read. Phase goes to `0` (sine at its rising zero
  crossing, triangle/ramp-up at -1, square/ramp-down/fast-square at +1); `random-steps` goes to
  `1.f` instead, so its next `sample_hold_step` wraps and latches a FRESH value at once rather
  than holding the last note's value for a whole period. The edge check is emitted only when
  `trig` is wired, but `prevTrig_` is always declared (+4 bytes per instance: LFO shapes 12,
  fast-square 28, random-steps 20), a one-time codegen-text diff like the envelopes' own `trig`.
  A legato/overlapping note-on never drops `sense/gate`, so it gives no edge and no reset
  (disclosed). Real local ARM builds (`scripts/stageLfoTrig.ts`: gate resetting a sine LFO and a
  S&H) compile and link clean on both platforms (xd: 1204 B text, 84 B bss; NTS-1 mkII: 4714 B
  text), fully inlined below `Osc::process`. **Open**: no hardware listening pass yet.
- **`logue/env/ad`/`logue/env/ahd`'s `trig` inlet + `logue/sense/gate`** (2026-09-25): a rising
  edge on `trig` (this registry's own `>=0.5f` gate read) retriggers the envelope exactly like a
  real note-on (`stage_=1`, continuing from the CURRENT level, not resetting to 0) — the mutation
  lives inside `ad_env_step`/`ahd_env_step` themselves (the same "static helper does the
  mutation" pattern as `onepole_step`/`sample_hold_step`), reading `trig`/`&prevTrig_`
  UNCONDITIONALLY rather than branching on whether it's wired: an unwired `trig` is always
  exactly `0.f`, so the rising-edge check is a genuine no-op, not merely a cheap one. This DOES
  change every existing document's own exported source TEXT (two new trailing args on every
  `ad_env_step`/`ahd_env_step` call site, a new always-present `prevTrig_` member,
  `stateBytesPerInstance` 16→20 for both) even when `trig` is never wired — a real, disclosed
  one-time codegen-text diff, not a behavior change. `ahd`'s own `trig` is a note-on-equivalent
  ONLY — it can (re)start attack from any stage but can never move hold (stage 2) to decay
  (stage 3) the way a real note-off does; growing `trig` into a full external gate was
  deliberately out of scope. `logue/sense/gate` closes the gap `trig`'s own addition exposed
  (nothing could DRIVE that wire from a real note event): outputs `1.f` while a note is held,
  flipped directly by its own `noteOnStatement`/`noteOffStatement`, no helper needed. Wiring it
  straight into `trig` reproduces the note-on hook's own retrigger exactly; through
  `logue/logic/edge` it becomes a one-shot note-on PULSE for anything else. Per-instance state,
  NOT the shared Osc-class-level "sense-bridging" member mechanism `sensePitchPrimitive`/
  `senseShapePrimitive` read — reusing that would mean touching both platform generators' own
  class-level scaffolding for a plain boolean flag `noteOnStatement`/`noteOffStatement` already
  expresses cleanly per instance.
- **`websim` (`make wasm`) is broken for every unit this generator produces** — an early
  COARSE/FINE refactor changed `Osc::setPitch`'s signature without updating Korg's own
  `dummy-osc/wasm.cc` template. NTS-1 mkII sense/DSP verification must use the host-native harness
  or real hardware; there is currently no working `websim` path at all.


## Other text moved out of CLAUDE.md (2026-09-28)

### Registry: when categories were added

The last three categories (`math`/`logic`/`mux`) and `sense/gate` were added 2026-09-25 for more
complex patch design (comparators, boolean logic, hard-select routing, a wireable note-on/off
gate) — see "Per-primitive gotchas" below for the shared conventions (gate convention,
constant-collapse comparators) and per-primitive notes. `logue/util/invert`/`logue/util/curve`
were reclassified into `math` the same day (pure category-only id rename, see "Rename safety"),
and `logue/mix/ringmod` became `logue/math/multiply` on 2026-09-27 (same kind of rename).

### Presentation metadata: how the badge gap was found

The presentation test is how string/exciter/curve/mux/additive dials went without a "wired" badge before (2026-09-28).

### Rename safety: the rename events with reasons

primitive rename/merge — 9 rename events today (`logue/sense/shift-shape` + `logue/sense/shape-alt`
→ `logue/sense/shape-2`, `logue/noise/white` → `logue/osc/noise`, `logue/delay/comb` →
`logue/filter/comb`, `logue/filter/lowpass` → `logue/filter/lowpass-cheap`, `logue/util/invert` →
`logue/math/invert`, `logue/util/curve` → `logue/math/curve` — the last two are the 2026-09-25
`math` reclassification, category-only like the `filter/comb`/`filter/lowpass` renames before
them; `logue/util/glide` deliberately stayed in `util`, not every primitive that could arguably
move gets moved), and `logue/mix/ringmod` → `logue/math/multiply` (2026-09-27, user: "ringmod" read
wrong for a plain multiply of control signals; inlets kept as `in1`/`in2`), and (2026-09-28)
`logue/lfo/sample-hold` → `logue/lfo/random-steps` plus `logue/util/trig-hold` →
`logue/util/sample-hold` (the name goes to the node that samples on a trigger).

### Test coverage list

Test coverage: `logue-generateOscUnit`, `logue-generateOldGenOscUnit`, `logue-oscShared`,
`logue-stateBytesPerInstance`, `logue-helperSharedBytes`, `logue-oscFixedBaseline`,
`logue-estimateOscStateCost`, `logue-paramTrackGate`, `logue-paramUnits`, `logue-paramDeviceType`,
`logue-unresolvedReferences`, `loguePrimitiveCatalog`, `logueTargetSettings`, `logueBuildStaging`,
`buildResultNaming`, `logue-sysex`, `logue-deviceSession`, `logue-rawSysexAssembler`, `logue-unitBackup`,
`logue-nts1mkiiDevice`, `logue-subpatches`, `subpatchCanvas`, `subpatchLibrary`,
`patchFileDialogFilters`, `logue-granular`, `positionFreeDoc`, `logue-primitiveSnapshots`,
`logue-primitivePresentation`, `logue-feedback`, `logue-cpuCostTable`, `logue-renamedFields` (41 test files, 1117 tests total as of 2026-09-28 — the `math`/`logic`/`mux`
primitives and the envelope `trig`/`sense/gate` addition got no new dedicated spec files, just
more coverage inside the existing `logue-generateOscUnit`/`logue-generateOldGenOscUnit` files,
matching how `mix2`/`multiply`/`invert` were never given their own file either).

### SysEx: confidence and captures

- **Confidence:**
  - Upload messages match 10 captured `logue-cli` uploads byte-for-byte.
  - Replies and downloads are tested against real xd captures.
  - The in-app backup of a real xd matched an independently verified backup (27/27 bodies).
  - A restore→re-backup round trip on the fake xd was byte-identical.
  - A real single-slot upload/restore to the xd (osc 1) was ACKed, and a before/after backup
    showed all 27 units byte-identical, so single-slot writes don't disturb other slots.
  - Still unmeasured: ACK timing for large units.
  - NTS-1 mkII (captured 2026-09-25, read-only):
    - It stores the `.nts1mkiiunit` ELF verbatim.
    - Downloads arrive as chunked `4A <m> <s> <index> <last>` messages (at most 4096 B each).
    - Slot status is the whole `unit_header_t`; module info carries 12 bytes.
    - It has no stray-`F7` bug.
    - In-app Back up works for it and matched a raw-dump backup (6/6).
    - Upload framing was captured from KORG KONTROL Editor through
      `harness/sysex-emu/midi_proxy.swift`: the chunked mirror of the download, with the ELF
      verbatim, checksum 0, and one ACK per chunk. `slotDataUploadChunks` reproduces it
      byte-for-byte.
    - Upload…/Restore now work for the mkII too. The app's own upload to a real mkII (osc 6) was
      ACKed; a before/after backup showed osc 6 byte-identical to the file and the other 7 units
      unchanged.

## Source comments moved out (2026-09-28)

The full doc comments these replaced, verbatim.

### primitives/filter.ts, above `const FORMANT_VOWEL_NOTE_TABLE_HZ: [number, number, number][]`

```
/**
 * A parallel bank of 3 resonant bandpass filters tuned to human vowel formant frequencies (F1,
 * F2, F3), with a VOWEL param sweeping smoothly through 5 cardinal vowels, a SHIFT param
 * transposing all three bands together, and a global RESONANCE param controlling how narrow/
 * peaky each band is. Requested directly by the user as "a formant filter... sweep smoothly
 * through human voice vowel formants... a shift option... an extra resonance option."
 *
 * **Vowel data provenance**: F1/F2/F3 in Hz for the 5 cardinal vowels, the classic average-adult
 * Peterson & Barney (1952) acoustic-phonetics reference values (a widely-reused, public-domain
 * set of acoustic measurements, not anyone's copyrighted expression) --
 * u=(300,870,2240), o=(570,840,2410), a=(730,1090,2440), e=(530,1840,2480), i=(270,2290,3010).
 *
 * **Sweep order is u->o->a->e->i, deliberately NOT the alphabetical a-e-i-o-u a user might
 * expect from the label order**: F2 (the formant that most defines a vowel's own timbre) jumps
 * around non-monotonically in alphabetical order (1090->1840->2290->840->870 Hz -- it DOUBLES
 * BACK partway through), which is audible as a lurch rather than a smooth glide from a 0-100
 * dial or an LFO/envelope wired into `vowel`. Reordered to u->o->a->e->i, F2 rises
 * near-monotonically instead (870->840->1090->1840->2290 -- the 870->840 dip is 30Hz, both
 * within a semitone of each other, inaudible as a direction change) while F1 traces the natural
 * "vowel triangle" shape (300->570->730->530->270) and F3 is fully monotonic
 * (2240->2410->2440->2480->3010) -- confirmed by direct comparison of both orderings before
 * picking this one, not assumed. `VOWEL` (0-100) maps onto this as 4 equal-width segments
 * (0-25=u..o, 25-50=o..a, 50-75=a..e, 75-100=e..i), linearly interpolated within each segment
 * (`formant_step`'s own `seg`/`frac` split).
 *
 * **Interpolated and shifted in NOTE space, not Hz** -- each vowel's own F1/F2/F3 is converted
 * at CODEGEN time (`hzToNote`, plain `69 + 12*log2(f/440)`, TypeScript-side `Math.log2`, never
 * on-device) into a MIDI-note-equivalent float baked into `formant_step`'s own local
 * `kFormantNote[5][3]` table. A sweep interpolates those note values (not the Hz values)
 * before converting back to a frequency via `note_w0` -- perceptually correct (an octave is an
 * octave regardless of which end of the sweep it's near) and means `SHIFT` (also in semitones,
 * `+-24`, same physical unit/range as every oscillator's own `COARSE`) is a single, exact,
 * multiplicative-in-Hz transposition applied as one more note-space `+shiftSemis` term --
 * `+12` doubles every formant's own frequency exactly, reusing `note_w0`'s real SDK-backed
 * `osc_w0f_for_note` LUT for the actual note->frequency conversion, the SAME libm-free mechanism
 * every oscillator's own pitch already uses (no separate exponential/pow math needed on-device).
 *
 * **`formant_g_from_note` avoids `tanf`** (unlike `logue/filter/svf`'s own confirmed, gated
 * exception) by approximating `tan(x)` with its own Taylor series (`x + x^3/3 + 2x^5/15`) around
 * the ZDF SVF's `g = tan(pi*fc/fs)` coefficient -- verified numerically (not assumed) before
 * shipping: <0.01% error across every un-shifted formant in the table (200-3500Hz), degrading
 * to ~0.4% at `SHIFT=+24` on `a`/`e`'s own F3 and ~1.4% at `SHIFT=+24` on `i`'s F3 (270Hz->3010Hz
 * shifted 2 octaves up to ~12kHz, the single worst case in the whole table) -- audibly
 * inconsequential frequency drift at an extreme, rarely-used corner of the control range, and a
 * real, deliberate way to avoid relaxing this file's "no libm" discipline a second time for a
 * primitive that doesn't structurally need `tanf`'s exactness the way SVF's self-oscillating
 * pitch-tracking case does.
 *
 * **Each band is a trimmed ZDF SVF bandpass tap ONLY** (`formant_bp_step`, sharing
 * `svf_step`'s own derivation/math but computing/returning just the `k*v1` term -- see that
 * primitive's own doc comment for the topology) -- `logue/filter/svf`'s general-purpose
 * lp/bp/hp-together shape isn't reused verbatim since a formant band never needs its own lp/hp
 * taps, and computing them anyway 3x/sample for nothing would be pure waste.
 *
 * **Gain, the real landmine of summing 3 parallel resonators**: a ZDF bandpass's raw `v1` tap
 * has its own peak gain of `1/k` -- left unnormalized, `RESONANCE` would ALSO sweep output
 * loudness by orders of magnitude and clip hard at high settings, entangling "how narrow" with
 * "how loud." `formant_bp_step` returns `k*v1` instead (unity peak gain at resonance regardless
 * of `k`), and the 3 bands are combined with fixed relative weights `1.0/0.5/0.28` (F1 loudest,
 * F3 quietest -- a real, disclosed simplification: an authentic per-vowel-per-formant amplitude
 * table exists in the literature but a single fixed per-formant-index weight is simpler, roughly
 * matches how vowel spectra generally roll off with formant number, and needs no second 5x3
 * table), then divided by their own sum (`1/1.78`) so the combined output stays close to unity
 * even at high `RESONANCE` instead of drifting hotter as bands are added.
 *
 * **`RESONANCE`'s own `k` mapping deliberately floors above zero, diverging from
 * `logue/filter/svf`'s own `k=0`-at-`RESONANCE=100` mapping**: `svf_k_from_percent`'s cube taper
 * reaching exactly `k=0` is fine for ONE filter (a real, disclosed marginally-stable self-
 * oscillator, confirmed safe by that primitive's own doc comment) -- three simultaneous
 * marginally-stable resonators summed together, each free to ring indefinitely once excited by
 * the others' own energy, is a materially different (and untested) stability picture, so
 * `formant_k_from_percent` floors at `k=0.05` (`RESONANCE=100`) exactly like
 * `logue/filter/comb`'s own `DAMPING` coefficient floor, same reasoning: keep the control's
 * whole range unconditionally well-behaved rather than approach a mode this primitive was never
 * verified against. `RESONANCE` defaults to `60` (`k~=0.175`, `Q~=5.7`) -- NOT the "safe middle
 * of the range reads as roughly half-open" default most percent controls use, deliberately:
 * this primitive's own `GAIN=0`-defaulting-to-silent bug precedent (`logue/filter/comb`'s own
 * doc comment) already burned this exact mistake once -- a formant filter's whole *point* is its
 * resonant peaks, so a low/default-feeling `RESONANCE` would make a freshly-placed instance sound
 * like a dull, unremarkable EQ rather than a recognizable vowel, the same class of "looks broken
 * by default" bug, not a new one.
 *
 * `VOWEL`/`SHIFT`/`RESONANCE` are all wireable from the start (`vowel`/`shift`/`resonance`
 * inlets, additive/clamp shape, depth derived from each param's own range -- `50` for `VOWEL`/
 * `RESONANCE`, matching `WIDTH`/`RATE`/SVF's own `resonance` inlet precedent, and `24` for
 * `SHIFT`, reusing `COARSE_PARAM.max` as `PITCH_INLET_DEPTH` already does) -- confirmed with the
 * user rather than shipped dial-only-first the way `DRIVE`/`FM_DEPTH` originally did: sweeping
 * `vowel` with an envelope/LFO (a classic talkbox/vocoder-style effect) IS this primitive's own
 * central use case, not a later-requested extra.
 *
 * Platform-agnostic (no `platforms` restriction) -- purely arithmetic on a wired `in` signal and
 * this file's own already-shared `note_w0`/`clampf` machinery, nothing platform-specific to
 * decode.
 *
 * Verified (not just read), via a standalone numeric re-implementation of `formant_step`'s exact
 * math (mirroring the generated C++ formula 1:1, `note_w0` substituted with the exact equal-
 * tempered formula it's itself a LUT-based approximation of): an impulse-response DFT (exact for
 * this LTI system, avoiding noise-averaging variance) found all 3 peaks within ~1% of the
 * table's own target Hz at every one of the 5 vowel corners (`RESONANCE=60`); `SHIFT=+12`
 * doubled all 3 peaks' own frequencies (measured ratios 2.0000-2.0040) and `SHIFT=-24` quartered
 * them (measured ratios 0.2498-0.2503); combined RMS output of a 48000-sample noise-driven run
 * stayed bounded and DECREASED as `RESONANCE` rose from 0 to 100 (0.183 -> 0.021, expected for a
 * fixed-peak-gain bandpass narrowing against broadband noise -- less of the noise floor falls
 * inside a narrower passband -- not a sign of instability). A real Docker build of both
 * minilogue xd and NTS-1 mkII (`logue-codegen/scripts/stageFormantFilter.ts`) compiled clean
 * with zero warnings on both real cross-compiler toolchains, confirming the new
 * `static const float kFormantNote[5][3]` FUNCTION-LOCAL table (deliberately not a class-level
 * `static`/`constexpr` data member, which would risk an ODR/out-of-line-definition question
 * neither toolchain had been asked before) is unconditionally safe C++.
 */
```

### primitives/filter.ts, above `const SVF_CUTOFF_G_MAX`

```
/**
 * A 2-pole (12dB/oct) state-variable filter with simultaneous lowpass/bandpass/highpass outputs
 * -- the first multi-outlet primitive in this registry (`outlets`/`renderOutletStatements`, added
 * alongside this primitive specifically to support it -- see `primitives.ts`'s own doc comments
 * on those fields and `oscInstances.ts`/`oscBody.ts` for the net-resolution/codegen side). Sits
 * deliberately above `lowpass-cheap`/`highpass-cheap` in both quality and cost: real 12dB/oct
 * rolloff (vs. their 6dB/oct one-pole), a genuine resonance control reaching self-oscillation, and
 * three simultaneous taps from one shared per-sample state update -- at maybe 4x a cheap filter's
 * own arithmetic cost, still a tiny fraction of a sample period on the real target MCU.
 *
 * Topology: Andrew Simper's zero-delay-feedback (ZDF/"trapezoidal") SVF
 * (cytomic.com/files/dsp/SvfLinearTrapOptimised2.pdf), NOT the simpler naive/Chamberlin 2-integrator
 * SVF (`y=y+f*x` direct discretization) an earlier draft of this primitive used. That earlier draft
 * was wrong for this primitive's own stated goal (exact pitch-tracked resonance, "playable" self-
 * oscillation) and was caught before shipping by actually deriving the naive form's real transfer
 * function: its own `f` coefficient IS `2*sin(pi*fc/fs)` in the IDEALIZED (undamped) case, but that
 * relationship itself drifts from the nominal `fc` as `fc` climbs past roughly `fs/6` -- a real,
 * audible detuning at higher notes, precisely the range self-oscillating filter-as-oscillator
 * patches live in. The ZDF form instead solves the integrator loop's own implicit delay-free
 * feedback exactly (one division per sample, `a1` below) via a bilinear-transform-correct `g =
 * tan(pi*fc/fs)` coefficient, so the resonant peak matches the target frequency exactly at any
 * cutoff up to Nyquist, and remains UNCONDITIONALLY stable at any `g,k >= 0` (no frequency-
 * dependent stability ceiling to cap against at all, unlike the naive form's hard `f<2` limit) --
 * both real, measured properties of this topology, not this project's own approximation.
 *
 * `tanf` is real libm, a deliberate, confirmed exception to this file's usual "no libm" rule
 * (see `env_rate_from_percent`/`cutoff_warp`'s own doc comments on why that rule exists --
 * `expf`'s code-size cost against the 32KB budget): the user explicitly asked for exact,
 * "playable" pitch-tracked resonance, which the cheap alternatives structurally can't provide.
 * Confined to `TRACK>=TRACK_ON_RAW_THRESHOLD` (see `svfCoeffExpr` below, and comb's own doc
 * comment for why that threshold is `1`, not the original `50`) -- `tanf` is only actually CALLED (not just
 * linked) when tracking mode is active, so the free-running/manual `CUTOFF` path pays no runtime
 * cost for it, only maybe1KB of one-time code size from the libm symbol becoming reachable at all.
 *
 * `RESONANCE` (0-100 percent, default 0) maps to `k` (the ZDF form's own damping coefficient, `k =
 * 1/Q`) via a cube taper -- `k=2.0` at `RESONANCE=0` (an unremarkable, non-resonant 12dB/oct
 * rolloff), `k=0.0` EXACTLY at `RESONANCE=100` (a lossless, undamped 2-pole resonator). Unlike the
 * earlier naive-SVF draft, `k=0` is perfectly safe here -- `a1`'s own denominator (`1+g*(g+k)`) is
 * always >= 1 for `g,k>=0`, no floor-above-zero hack needed to dodge a divide-by-zero or runaway
 * blowup the way the discarded draft's `f`-vs-`2-q` ceiling did.
 *
 * A real, disclosed limitation carried over regardless of topology (flagged before shipping, not
 * discovered after): `k=0` is MARGINALLY stable, not unstable -- once excited (by the input signal
 * or by numerical noise) it rings essentially forever at constant amplitude, but it will not
 * spontaneously START ringing from true silence and zero state the way a real analog "screaming"
 * self-oscillating filter can. Genuine self-starting self-oscillation needs the feedback path to
 * be allowed to exceed unity (a real, deliberately unstable `k<0`), bounded from real numeric
 * blowup by clipping somewhere inside the loop (e.g. running `v1` through the existing `soft_clip`
 * helper each sample) -- a real, viable follow-up, not attempted this phase (this project's usual
 * "grow only as needed" discipline: nobody's asked for a self-STARTING filter yet, only a
 * correctly-TUNED resonant one).
 *
 * `CUTOFF`'s own manual/free-running path (`TRACK==0`) deliberately stays on the cheap, non-Hz-
 * accurate cube-warped-coefficient tradeoff every other filter in this registry uses (`g = t^3 *
 * 8`, `8` chosen so the top of the dial reaches a `g` corresponding to roughly 22kHz at 48kHz --
 * see `cutoff_warp`'s own doc comment for why a cubic curve specifically) -- exactness only
 * matters for the pitch-tracking case this primitive was actually built to fix, so the common/
 * default case keeps the cheaper, `tanf`-free path.
 *
 * `pitch`/`COARSE`/`FINE`/`TRACK` are the exact same mechanism `logue/filter/comb` already
 * established (`transposedW0Expr` reused verbatim, a plain `>=TRACK_ON_RAW_THRESHOLD` runtime
 * threshold, not a blend) -- see that primitive's own doc comment for the full reasoning
 * (including why the threshold is `1`, not the original `50`), identical here.
 */
```

### primitives/filter.ts, above `export const pluckedStringPrimitive: LoguePrimitive`

```
/**
 * A genuine Karplus-Strong plucked-string resonator -- distinct from `logue/filter/comb` (a
 * simpler, dual-purpose comb/flanger/texture filter) and deliberately NOT a modal/formant-style
 * bank of parallel resonant filters (the `logue/filter/svf`/`formant` family, or Mutable
 * Instruments Elements/Rings' own "Modal" engine, or peterall/eurorack-prologue's `mod_s`) --
 * the user explicitly asked for real string resonance, not a simulated resonating surface.
 * Modeled on Mutable Instruments Rings' own `string.cc` (and its own deliberately cheaper
 * "Lite" reimplementation in Plaits, `plaits/dsp/physical_modelling/string.cc`) -- a single
 * delay-line comb loop, not a filter bank, so its per-sample CPU cost is O(1) regardless of how
 * rich the string sounds, unlike a modal resonator's O(N modes) cost (measured via a real local
 * ARM build + objdump spike -- 8 SVF modes alone already cost ~21% of minilogue xd's per-block
 * CPU budget in a rough floor estimate, 16 modes ~41% -- exactly why that direction was
 * abandoned in favor of this one).
 *
 * Three things this primitive adds over `logue/filter/comb`'s own simpler loop:
 * 1. **4-point Hermite fractional-delay read** (`string_step`'s own doc comment) instead of
 *    comb's plain integer-indexed read -- a continuously, accurately tuned string rather than
 *    comb's disclosed sample-quantized pitch.
 * 2. **An 8-stage first-order allpass dispersion cascade** (`allpass1_step`, all stages sharing
 *    ONE coefficient -- see `STRING_DISPERSION_STAGES`'s own doc comment for why that's the
 *    MEASURED right choice, not scaled-down per-stage coefficients, which turned out to be
 *    counterproductive), the OVERALL amount also note-dependent (see
 *    `STRING_DISPERSION_NOTE_FACTOR_MIN`'s own doc comment) approximating a real string's
 *    stiffness-driven inharmonicity -- the actual character that makes this sound like a
 *    struck/plucked string rather than a metallic comb resonance. A real, disclosed
 *    simplification of Rings'/Plaits' own technique (a genuine allpass delay line of a few
 *    hundred samples) -- audibly similar dispersion character, a fraction of the RAM.
 * 3. **A one-pole DC blocker on the final output** (`dc_blocker_step`), matching Rings' own
 *    placement -- the damping/dispersion cascade can drift a small DC bias over a long ring
 *    that comb's simpler loop doesn't accumulate the same way.
 *
 * Deliberately ALWAYS pitch-tracked (no `TRACK` toggle the way comb has one) -- unlike comb,
 * which doubles as a free-running comb/flanger texture tool, this primitive's whole reason to
 * exist is to BE a tuned string, so `COARSE`/`FINE` (the same shared params every oscillator
 * has) are the only tuning offset it needs, reusing `transposedW0Expr` verbatim (the same
 * LUT-based `note_w0` machinery every oscillator/comb/svf already uses -- no libm).
 *
 * `STRING_MAX_DELAY_SAMPLES` was originally `1024` (vs. comb's 512), matching Plaits' own "Lite"
 * string engine's exact delay-line proportion -- itself real, shipped precedent on the closest
 * sibling hardware to minilogue xd, `peterall/eurorack-prologue`'s `mo2_string`, on the identical
 * 32KB prologue/minilogue-xd SRAM budget. That reached a real bass-register fundamental of
 * ~46.9Hz (MIDI note ~30) at ~12.6% of the 32KB budget for one instance. **Doubled to `2048`
 * (2026-09-25)**, a real, user-reported miss ("pitch tracking gets off in the low register below
 * midi note 36" -- see `STRING_MAX_DELAY_SAMPLES`'s own doc comment for the exact root cause and
 * math): the wraparound bitmask needs a power of two, so doubling is the only real step up.
 * Floor is now ~23.5Hz (MIDI note ~18), covering the practical bass range, at roughly DOUBLE the
 * RAM (`stateBytesPerInstance` below is now ~25.2% of the 32KB budget for one instance) -- a
 * real, accepted cost, no longer "comfortably affordable" the way the smaller buffer was: a
 * second string instance on minilogue xd is now a real, tight fit rather than a
 * comfortable one, and anything sympathetic-string-like (Rings' actual Sympathetic-String mode,
 * 2-8 full-size strings) remains out of scope, more firmly than before.
 *
 * `DECAY` reuses `comb_response_warp`/`DAMPING_MIN_A` verbatim (comb's own hard-won fix for a
 * real "have to turn it up past ~75% before anything changes" complaint, rooted in the same
 * genuine pole a feedback coefficient approaching 1 always has) -- `DAMPING` reuses the same
 * curve for the identical reason, since both are single scalar knobs feeding a coefficient with
 * the same nonlinear perceptual/mathematical shape comb's own doc comment already derives.
 *
 * Ported/adapted from Mutable Instruments' `eurorack` repository (`rings`/`plaits`,
 * MIT-licensed, Copyright Emilie Gillet -- see that repository's own README for the exact
 * license text) -- the DSP TECHNIQUES (delay-line Karplus-Strong loop, Hermite interpolation,
 * allpass dispersion, DC blocking) are adapted, not copied verbatim (this project's own
 * no-libm/warp-curve/ZDF-SVF conventions replace Mutable's own implementation throughout), but
 * the lineage is real and worth crediting. "Rings"/"Mutable Instruments" are that project's own
 * trademarks -- this primitive is named descriptively rather than reusing either name.
 */
```

### primitives/filter.ts, above `const STRING_DISPERSION_STAGES`

```
/**
 * Real, user-reported miss, THIRD round on dispersion (2026-09-25): "still very subtle. most
 * pronounced on higher notes with low decay setting. in the lower register it's not really
 * audible." That specific pattern -- stronger at high notes, weaker at low notes, EVEN THOUGH
 * the previous design's note-dependent floor made low notes deliberately WEAKER on purpose --
 * was the tell that something was actually broken, not just subtle. Checked directly (not
 * guessed): at STRUCTURE=100 and a genuinely high note (C6, 1046Hz, period≈46 samples), the
 * PREVIOUS 8-stages-at-0.7 design's own group-delay compensation (`onepoleDelay +
 * STAGES*(1+c)/(1-c)`) needed ≈46 samples of budget -- MORE than the note's entire ≈46-sample
 * period -- so `compensatedDelay` was hitting its safety floor and PITCH TRACKING ITSELF WAS
 * ALREADY BREAKING DOWN above roughly C6 at high STRUCTURE, well within a normal playing range.
 * "Most pronounced on higher notes" wasn't a working dispersion effect at all in that register --
 * it was (at least partly) audible detuning FROM THE TUNING BREAKING, which is a real bug, not a
 * feature to lean into.
 *
 * The deeper problem: strong dispersion (a large allpass coefficient, needed for the effect to
 * be audible at all -- see the previous round's own doc history) costs a LARGE, roughly
 * note-INDEPENDENT amount of group-delay compensation budget, while a high note's own period
 * (the TOTAL budget available) shrinks. Any FIXED coefficient large enough to be audible at low
 * notes (where budget is abundant) is guaranteed to eventually exceed a high note's whole
 * period. A note-dependent floor that happens to shrink at low notes (the previous design) was
 * exactly backwards for what this constraint actually needs.
 *
 * Fixed properly: `string_step` now computes, at RUNTIME, the actual maximum coefficient the
 * CURRENT note's own period can safely afford (solving `STAGES*(1+c)/(1-c) <= budget` for `c`,
 * where `budget` is the delay samples left over after the onepole's own compensation and a
 * fixed headroom margin), and clamps the STRUCTURE-derived desired coefficient to that safe
 * maximum. This is a real constraint satisfaction (protects against BUDGET running out), not a
 * guessed curve -- but budget safety turned out to be only HALF the real constraint.
 *
 * **A second real finding, from actually verifying the result, not just the budget math**: the
 * compensation formula itself (`(1+c)/(1-c)`, the group delay at DC/zero-frequency) is only an
 * APPROXIMATION of the real, frequency-dependent group delay -- accurate near DC, but
 * increasingly wrong as the coefficient grows AND as the note's own frequency rises (both push
 * further from the DC assumption). Pushing `STRING_DISPERSION_MAX` to 0.85 (safe by the BUDGET
 * check above) was verified to make the FUNDAMENTAL itself drift badly out of tune well within
 * the budget-safe register -- up to +66 cents at C5, not a subtle coloration, an audibly wrong
 * note. A cheap (no-trig, `w²`-only) frequency-aware correction to the compensation formula was
 * tried and made some notes better but others (C5) WORSE (a bisection/root-tracking artifact,
 * not a genuine fix) -- reverted rather than ship something that looks more accurate but isn't.
 * `STRING_DISPERSION_MAX` is instead set to **0.72** (barely above the original 0.7, not 0.85),
 * chosen from directly measuring fundamental tuning error at FULL coefficient across the
 * practical register (0.16/1.31/10.41 cents at C3/C4/C5 for 0.70; 0.21/1.67/13.31 for 0.72;
 * 0.24/1.90/15.13 for 0.73 -- 0.72 was picked as the point past which C5's own drift starts
 * exceeding ~15 cents) -- a real, disclosed, still-open limitation of the DC-approximation
 * compensation this primitive uses, not a guess.
 *
 * What DID improve, verified: removing the old note-dependent floor means low/mid-register
 * dispersion is no longer artificially weakened (previously as low as 0.7×0.7≈0.49 at the
 * bottom of the register; now the FULL 0.72 there, since budget is abundant) -- a real,
 * meaningful strength increase precisely where "not really audible in the lower register" was
 * reported. High notes are protected from ever breaking tuning via the budget clamp above,
 * tapering smoothly instead of hitting a hard floor. The old note-dependent floor/factor
 * (`STRING_DISPERSION_NOTE_FACTOR_MIN`/`NOTE_BASE`/`NOTE_SPAN_SEMITONES`) is gone entirely --
 * STRUCTURE alone sets the desired amount, and the budget-safety clamp is the only thing that
 * varies with register, for a real, load-bearing reason (protecting tuning), not a
 * physical-realism guess. Getting dispersion meaningfully STRONGER than this would need a
 * genuinely more accurate (frequency-aware, not DC-approximated) compensation formula, or a
 * different dispersion mechanism entirely (a real multi-sample allpass delay line, like Rings'/
 * Plaits' own technique, rather than a cascade of single-sample stages) -- open, not attempted
 * here.
 */
```

### primitives/filter.ts, above `const COMB_MAX_DELAY_SAMPLES`

```
/**
 * A feedback comb filter/resonator -- phase 16 added the core delay-line-with-feedback loop
 * (Karplus-Strong's basis, without a damping filter). Phase 33 is a real redesign, requested
 * after a reproducible complaint: feeding a continuous tone (a plain saw) in and sweeping the
 * delay produced no audible "sliding comb bands" at all. Root cause, found by re-reading this
 * primitive's OWN prior doc comment rather than assumed: `FEEDBACK` (now `GAIN`) defaulted to
 * `0`, and at exactly `0` this was a byte-EXACT passthrough (`y[n] = x[n] + 0*buf[...] = x[n]`,
 * documented as deliberate at the time, matching every other percent-domain control's own
 * "safe, unsurprising 0 default" precedent). That precedent fit params like `FM_DEPTH`/`DRIVE`,
 * where 0 is a commonly-wanted "off" state layered onto an otherwise-audible source -- it was
 * wrong here, because a comb filter's own core effect is what's silent by default, making a
 * freshly-placed instance look completely broken regardless of any other control. `GAIN` now
 * defaults to an audible `60` -- the actual fix for the reported symptom, not a side effect of
 * anything else in this redesign.
 *
 * The remaining two controls (`CUTOFF`, `DAMPING`) match the vocabulary the user pointed at
 * directly: Arturia MiniFreak's OSC2 "Comb Filter" mode (Cutoff/Gain/Damping), a real hardware
 * precedent for the same delay-line-plus-loop-filter topology this phase implements. `CUTOFF`
 * (renamed from `DELAY`) is the same free-running delay-length control with its direction
 * DELIBERATELY INVERTED: `DELAY` was "0=shortest/highest-pitched, 100=longest/lowest", backwards
 * from what "cutoff" means on every other filter in this registry (`lowpass-cheap`'s own
 * `CUTOFF=100` is fully open/brightest, `0` fully closed/darkest). `CUTOFF` here follows that
 * SAME convention -- `samples = 1 + (100-cutoffPercent)*5.10`, the exact old formula with the
 * percent term flipped, so the new default (`50`) still lands on the identical 256-sample/~187Hz
 * resonance `DELAY=50` always did. This is a real, deliberate, SILENT behavior change for any
 * already-authored document with an explicit non-default `DELAY` value (an old `DELAY=20` is now
 * a much LONGER delay under the same-looking `CUTOFF=20`, not a shorter one) -- accepted because
 * the user explicitly asked for cutoff-shaped vocabulary, not a side effect nobody noticed. Both
 * wireable inlets are renamed to match (`delay`->`cutoff`, `feedback`->`gain`); an existing net
 * wired to the old inlet names simply stops resolving (the same "unmatched name, no crash" cost
 * every other renamed param/inlet in this registry's history already carries), a second
 * disclosed compatibility cost of the same rename, not a new kind of risk. **Update (2026-09-21)**:
 * this exact silent failure hit a real user file (`comb.loguepatch`) and prompted
 * `renamedParams`/`renamedInlets` below (see `FieldAlias`) -- `FEEDBACK`/`feedback` now resolve
 * transparently to `GAIN`/`gain` (identical meaning, safe to auto-carry), while `DELAY`/`delay`
 * are recognized but deliberately NOT auto-remapped to `CUTOFF`/`cutoff` (the inversion above
 * makes the old value wrong under the new name) -- instead surfaced as an unresolved reference
 * (`findUnresolvedReferences`) so the canvas/Inspector can flag it for the user to re-tune.
 *
 * `DAMPING` (new) is the actual missing ingredient for the MiniFreak/Karplus-Strong CHARACTER --
 * as opposed to `GAIN`'s default, which is the fix for the "no effect at all" bug above -- a
 * one-pole lowpass (`onepole_step`, reused verbatim from `lowpass-cheap`) inserted on the delay
 * line's READ TAP, before it's scaled by `GAIN` and fed back: `damped = onepole_step(&dampZ1,
 * buf[readIdx], dampingA)`, `y[n] = x[n] + gain*damped`, `buf[writeIdx] = y[n]` -- the standard
 * "extended Karplus-Strong"/Jaffe-Smith damped-string topology, not a new invention, and exactly
 * what makes a continuous input's resonance read as swept metallic BANDS rather than one raw,
 * buzzy pitch: the loop filter progressively attenuates higher harmonics of the resonance more
 * than lower ones each pass, so only a handful of harmonics near the fundamental stay audible
 * for the tail's duration instead of every harmonic ringing at equal, harsh strength. `dampingA
 * = 1 - (DAMPING*0.01)*0.95`: at `DAMPING=0` the coefficient is exactly `1.0` (an unfiltered
 * passthrough of the delayed tap -- byte-identical to phase 16's original undamped loop), and
 * DELIBERATELY floored at `0.05`, not `0`, at `DAMPING=100`: `onepole_step`'s own `y = z1 +
 * a*(x-z1)` degenerates to `y = z1` FOREVER at `a=0`, freezing the loop filter's state at
 * whatever it last held rather than settling to a dark, slowly-moving tone -- caught before
 * shipping by reasoning through `onepole_step`'s own formula, not by ear. Originally shipped
 * WITHOUT reusing `lowpass-cheap`'s own `cutoff_warp` cube curve, deliberately: that curve was
 * shaped and verified for a fully-open-to-fully-closed AUDIO passthrough sweep, and this
 * control's own default (`20`, a light damping for a natural rather than harsh default
 * resonance) had no equivalent need verified yet -- a plain linear map was simpler to reason
 * about, to revisit only if a future ear check found it wanting. That ear check happened -- see
 * `comb_response_warp`'s own doc comment for the real fix this and `GAIN` both got. A real,
 * disclosed physical cost (independent of the warp): the loop filter adds phase lag, which
 * measurably detunes a `TRACK`-tracked pluck's period from the played note as `DAMPING`
 * increases. Shipped dial-only at first, matching this registry's "grow only as needed"
 * precedent (`DRIVE`/`FM_DEPTH` both shipped dial-only too, gaining a wire only once a real
 * follow-up request landed) -- a same-day follow-up request added a wireable `damping` inlet,
 * same additive/`+-50`/clamp shape as `cutoff`/`gain` (applied to the RAW percent, same
 * point-of-use as the dial fallback, before the `1-...*0.95` coefficient conversion) -- an
 * envelope sweeping `DAMPING` (a pluck brightening then darkening as it decays, the inverse of
 * the usual filter-envelope shape) or an LFO wobbling it are this control's own natural
 * modulation targets, the same reasoning `DELAY`/`FEEDBACK` were made wireable from the start in
 * phase 16.
 *
 * `GAIN` is still capped at `0.999` (`percent*0.00999f`, unchanged formula/cap from phase 16's
 * own `FEEDBACK`) -- still unconditionally stable at every dial position regardless of `DAMPING`,
 * since the loop filter's own maximum gain is `1.0` at DC (`onepole_step` never amplifies), so
 * the loop's total gain around the recirculation path never exceeds `GAIN` itself.
 *
 * `COMB_MAX_DELAY_SAMPLES = 512` (2KB of `float` buffer per instance) is a real, disclosed RAM
 * budget choice for the actual target MCU (minilogue xd's STM32F401xC) -- large enough for
 * genuinely audible comb/flanger/metallic resonance and mid-register plucked tones (512 samples
 * at 48kHz -> a ~93.75Hz fundamental at the brightest `CUTOFF`), not large enough for full
 * bass-register Karplus-Strong (which would need several KB more per instance); revisit only if
 * a real patch needs deeper delays and the RAM budget allows it. `CUTOFF` maps LINEARLY to a
 * sample count (`1..511`, never 0 -- a same-sample self-reference would be an immediate,
 * degenerate feedback loop), deliberately NOT calibrated to a musical pitch/Hz value -- the same
 * "cheap, audibly-correct, not scientifically-tuned" tradeoff `lowpass-cheap`'s own `CUTOFF`
 * already established, for the same libm-avoidance reason. No fractional-delay interpolation
 * either (plain integer sample indexing) -- real, disclosed pitch quantization at short delays,
 * fine for texture/resonance, not for dead-precise tuned plucks.
 *
 * `CUTOFF` and `GAIN` are wireable (`cutoff`/`gain` inlets) -- unchanged from phase 16's own
 * `delay`/`feedback` inlets, just renamed and (for `cutoff`) direction-flipped along with their
 * params. `DAMPING` gained its own wireable inlet the same day as this redesign shipped (see
 * above) -- all three use the same additive/`+-50`/clamp shape as every other percent-domain
 * inlet in this registry.
 *
 * `TRACK` (added once a user asked how to get a real Karplus-Strong pluck) switches the
 * delay-length source: `TRACK==0` keeps the free-running `CUTOFF` percent mapping (default,
 * unchanged by this phase); `TRACK>=TRACK_ON_RAW_THRESHOLD` replaces it with `1/note_w0(...)` --
 * reusing `transposedW0Expr` VERBATIM, the SAME LUT-based pitch machinery every oscillator
 * already uses (no libm): `w0` is cycles-per-sample (`= f/fs`), so `1/w0` is exactly the played
 * note's period in samples, a real, correctly-tuned string length. A plain runtime threshold, not
 * a blend -- simpler, and `TRACK` can still live on a real hardware knob for live switching
 * (unlike a codegen-time flag), so the check has to happen every sample regardless of how simple
 * the two branches are. `CUTOFF` is `inert-when-on` in tracked mode exactly as `DELAY` always
 * was (`@logue-codegen/paramTrackGate`) -- `COARSE`/`FINE` are the intended way to offset a
 * tracked pitch, the same job MiniFreak's own cutoff knob does when its comb is in keyboard-track
 * mode, so this is a labeling/discoverability gap, not a missing capability.
 *
 * The threshold itself is `TRACK_ON_RAW_THRESHOLD` (`1`, shared with `logue/filter/svf`'s own
 * `TRACK`) -- see that constant's own doc comment for why it moved from an original `50` to
 * exactly match NTS-1 mkII's own `k_unit_param_type_onoff` device display.
 *
 * Deliberately NOT gated on whether `pitch` is wired -- an earlier draft of this design tried
 * exactly that and was wrong, caught by actually generating and reading the code before
 * shipping it: `note_`/`noteFine_` (the played note) is ALREADY unconditionally part of
 * `transposedW0Expr`'s own sum, so wiring `logue/sense/pitch` into `pitch` to "turn on"
 * tracking would have ADDED the note a second time, at the wrong (LFO-modulation) scale, on
 * top of the base pitch already baked in -- a real double-count bug, not just an unwired
 * default. `TRACK` as its own explicit param avoids that entirely: `pitch` keeps its ordinary,
 * SEPARATE meaning (an additive semitone-domain bend on top of whatever base pitch is already
 * in play, same `+-24` depth every oscillator's own `pitch` inlet uses) instead of also having
 * to double as a mode switch.
 *
 * `COARSE`/`FINE` (the shared params/spec every oscillator already has) are added here too,
 * purely for tracking mode -- declared/baked unconditionally like everything else in this
 * registry, harmlessly inert whenever `TRACK==0`. Directly wiring anything (`sense/pitch`
 * included) into `cutoff` itself was also considered and rejected as WRONG, not just unwired:
 * `CUTOFF`'s own mapping is LINEAR in percent, but a string's period is linear in `1/frequency`,
 * which is exponential in semitones -- a linear-in-note wire there would produce audibly
 * out-of-tune notes that drift further out of tune the further you move from wherever it
 * happened to sound right, which is exactly why this needed `transposedW0Expr`'s real
 * `note_w0` machinery instead.
 */
```

### primitives/osc.ts, above `const PLUCK_EXCITER_STEP_HELPER: HelperBlock`

```
/**
 * The whole noise -> filter -> envelope chain for `logue/osc/exciter`, bundled into one
 * self-contained helper (matching `comb_step`/`string_step`'s own "one helper per primitive"
 * shape, not several separately-composed calls) since every stage here genuinely depends on the
 * SAME per-sample `bowPercent`/note.
 *
 * The envelope is `ahd_env_step`'s own 4-stage shape (0 idle / 1 attack / 2 hold / 3 release)
 * with two changes. First: stage 2 ALSO subtracts a `heldDecayRate` every sample instead of doing
 * nothing until a real note-off. At `BOW=0` that rate is large, so stage 2 runs to 0 in a few ms
 * EVEN WHILE THE NOTE IS STILL HELD -- `logue/env/ad`'s own "ignore note-off, always run to
 * completion" pluck behavior, falling out of the same mechanism for free rather than a separate
 * code path. At `BOW=100` the rate is exactly 0 (see `EXCITER_HELD_DECAY_RATE_MAX`'s own doc
 * comment) -- a true, lossless hold for as long as the note stays down, only moved into stage 3
 * by a real note-off (`pluckExciterPrimitive`'s own `noteOffStatement`, identical to `ahd`'s).
 * Second: reaching `level<=0` in stage 2 no longer always means "go idle" -- see
 * `EXCITER_STRIKE_MAX_COUNT`'s own doc comment for the real feedback that drove this, a decaying
 * train of re-strikes (`strikesRemaining_`/`strikeGain_`) plays out first, each one a real
 * re-attack (stage 1 again) at a smaller peak, before the LAST one finally goes idle (or, at high
 * enough `BOW`, never needs to -- `heldDecayRate` hits 0 before `strikesRemaining_` runs out).
 * Attack is now a fixed, BOW-independent crisp onset (`env_rate_from_percent(0.f)`, see
 * `EXCITER_STRIKE_MAX_COUNT`'s own doc comment for why); release still reuses
 * `env_rate_from_percent` against `bowPercent` directly -- no separately-dialed release time
 * exists here on purpose, this is a one-knob primitive.
 *
 * Tone is a straight linear blend between two coefficients, not a branch: `aPluck` is a fixed,
 * bright, register-independent color (the click's own brightness); `aBowTracked` derives a
 * onepole coefficient straight from the played note's own `w0` (`w0` is cycles/sample, so
 * `2*k*w0` is "`k` harmonics' worth of bandwidth above the fundamental, as a fraction of
 * Nyquist"), floored so a low note never gets choked entirely. The blend fraction is
 * `max(s, 1-strikeGain)`, not just `s` -- so a LATER, quieter strike in the train is also always
 * at least as warm as its own `strikeGain` implies, regardless of how far up `BOW` actually is
 * (the literal "softer AND warmer with each strike" the nylon-guitar comparison asked for),
 * while the very first strike (`strikeGain=1`, `1-strikeGain=0`) still reduces to the original
 * BOW-only blend, so a fresh note's initial transient is exactly as bright as it always was.
 * Blending by `BOW` alone (via the `s` floor) still gives a gradually-closing filter as `BOW`
 * rises AND that closing becoming note-relative by the time `BOW` reaches 100 -- the actual fix a
 * continuously-fed resonant loop needs to keep "singing" instead of just sounding dark.
 *
 * Noise color is ALSO blended by the SAME `warmth` value (2026-09-26, real user feedback: "pure
 * white noise doesn't do the string pluck and bow sounds justice... is there anything we can do
 * about the exciter noise to sound more natural?"). Plain LCG white noise (`noise_step`) is flat
 * to Nyquist -- real excitation noise (a pick scraping, a bow's stick-slip friction) is naturally
 * weighted toward the low end, which onepole lowpassing alone only approximates. `pink_noise_step`
 * (see its own doc comment) recolors that same white sample; blending white->pink by `warmth`
 * means the very first strike (`warmth=0`) stays the EXACT bright, crisp click it always was --
 * no regression to what was already liked -- while every softer/later strike and the bow-sustain
 * end gets progressively pinker along with progressively darker, compounding with the tone blend
 * rather than just being quieter, duller white noise.
 *
 * The final blended sample is clamped to `[-2,2]` (2026-09-26, second real user report on the
 * SAME feature: "with higher bow the exciter signal gets too much overall gain and the resonated
 * sound gets really more distorted" -- see `PINK_NOISE_GAIN_COMPENSATION`'s own doc comment for
 * the actual measured bug this was: the raw pink filter ran ~3x white's own RMS and ~7.7x its
 * peak before that constant was added). The gain compensation is the real, primary fix; THIS
 * clamp is a measured, rare safety net on top of it for pink noise's own wider crest factor (a
 * real property of the technique, not a residual bug) -- 0.033% of samples at worst-case full
 * `warmth`, confirmed via the same simulation, not a guessed headroom number.
 *
 * `sustainLevelScale` (2026-09-26, a THIRD real report, "the exciter is coming in too hot" --
 * see `EXCITER_SUSTAIN_LEVEL_DROP`'s own doc comment) tapers the FINAL output by `warmth` again --
 * a genuinely different lever from the noise-color gain fix above. At high `BOW`, `*level` pins
 * at its peak and stays there for as long as the note is held (`heldDecayRate` at or near 0) --
 * a continuous near-full-amplitude feed that a resonant loop (`logue/filter/string`) keeps
 * reinforcing for as long as it lasts, unlike a decaying pluck's bounded, self-limiting energy.
 * Scaling by `warmth` keeps the already-tuned initial transient (`warmth=0`) untouched while
 * taming exactly the continuously-held case that actually causes it.
 */
```

## More source comments moved out (2026-09-28)

The full doc comments that were condensed in a second pass, verbatim.

### primitives/filter.ts, above `lowpassCheapFilterPrimitive` (logue/filter/lowpass-cheap)

```
/**
 * A one-pole (single-order) lowpass filter -- the first primitive
 * with a real wireable CONTROL inlet (`cutoff`) alongside a real audio inlet (`in`), proving a
 * control signal from another active instance really is the same mechanism as an audio signal
 * (see this file's own module doc comment) -- no separate audio-rate/control-rate type needed.
 * Renamed from `logue/filter/lowpass` (phase 9) to `logue/filter/lowpass-cheap` to make the
 * "not Hz-accurate" tradeoff below visible in the palette itself, not just in this comment.
 *
 * Deliberately NOT a Hz-accurate design: `cutoff` (0..1 -- either a wired upstream instance's
 * own value, clamped, or -- when unwired -- the `CUTOFF` param, 0-100 percent, `value * 0.01f`,
 * matching `pulse`'s own `WIDTH` convention) is passed through `cutoff_warp` (a cheap cubic
 * curve, see its own doc comment) before being used as the one-pole's leaky-integrator
 * coefficient (`a` in `y[n] = z1 + a*(x[n]-z1)`) -- NOT converted through a real frequency-domain
 * formula (`1 - exp(-2*pi*fc/fs)`), which would pull in libm's `expf` for real, measurable
 * code-size cost against the 32KB budget. `a=1` passes the input through unfiltered (fully
 * open), `a` shrinking toward 0 progressively darkens/mutes it (fully closed at `a=0`) -- a
 * real, audibly-correct lowpass sweep, just not one calibrated to a musical Hz value. Revisit
 * only if a real patch needs Hz-accurate tuning. `CUTOFF` defaults to 100 (fully open) so a
 * freshly placed filter never silently mutes whatever's wired through it.
 *
 * Why the warp (phase 9, added after real use): a linear `a` sweep is audibly steppy -- the
 * one-pole's own `a`-to-cutoff-frequency relationship is itself logarithmic
 * (`fc ~= -(fs/2*pi)*ln(1-a)`), so a linear knob/wired-control value pushes `fc` through nearly
 * the entire audible range within the bottom ~10% of its travel, then spends the rest of its
 * range sweeping `fc` from "already bright" to "inaudibly brighter" -- confirmed by a user
 * wiring `logue/sense/param` (a knob) directly into `cutoff` and hearing exactly that. The cube
 * warp is applied at the SAME point for both the param fallback and a wired inlet (inside
 * `renderExpr`, not in `CUTOFF`'s `setStatement`) specifically because a wired inlet bypasses
 * the param path entirely -- warping only the param would leave a wired control just as steppy.
 *
 * Unlike every oscillator, the state update (`z1`) happens INSIDE `onepole_step` itself, not in
 * a separate `advanceStatement` -- a filter's next state genuinely depends on the JUST-COMPUTED
 * output sample (`z1 = y[n]`), not a value that can be advanced independently before/after
 * `renderExpr` reads it the way an oscillator's phase can. `advanceStatement` is a real no-op
 * here, not an oversight.
 */
```

### primitives/filter.ts, above `combResponseWarpExpr` (comb_response_warp)

```
/**
 * A cheap, no-libm "ease-out" warp (`1-(1-t)^2`, two subtracts and a multiply) applied to
 * `GAIN`/`DAMPING`'s own combined (dial + wired-inlet) percent value before it becomes a real
 * coefficient -- added after a real, user-reported "have to turn GAIN up past ~75% before
 * anything changes" complaint, root-caused (not just reasoned about) by computing the actual
 * ring-decay time `comb_step`'s own feedback coefficient produces: cycles-to-`-60dB` is
 * `ln(0.001)/ln(coefficient)`, which has a genuine pole as `coefficient` approaches 1 -- e.g. at
 * `GAIN=50` (coefficient 0.4995) that's only ~10 cycles, but by `GAIN=90` (0.8991) it's ~65, and
 * `GAIN=99` (0.989) is ~625. A LINEAR percent-to-coefficient map (what `GAIN` used unwarped)
 * crams nearly the entire audible range of "how long does it ring" into the last ~20% of the
 * dial's travel, exactly the same CLASS of problem `lowpass-cheap`'s own `cutoff_warp` was built
 * to fix for `CUTOFF` -- just a different curve, since comb's own coefficient-to-decay-time
 * relationship (a genuine pole) is steeper than `cutoff_warp`'s target relationship. Confirmed
 * numerically before shipping (not just reasoned about): at `GAIN=50`, the warped coefficient is
 * ~0.749 (was 0.4995) -- ~24 cycles instead of ~10 -- already in the range the UNWARPED curve
 * needed `GAIN=76` to reach. Endpoints are exact (`t=0` -> `0`, `t=1` -> `1`), so `GAIN=0`/`100`
 * and `DAMPING=0`/`100` still mean exactly what they did before -- only the middle of each dial's
 * travel changed. `DAMPING`'s own doc comment previously declined reusing `cutoff_warp` here
 * specifically because "a plain linear map is simpler to reason about and revisit only if a
 * future ear check finds it wanting" -- this warp is that revisit, triggered by the same kind of
 * real complaint for `DAMPING` too. A real, disclosed, SILENT behavior change for any
 * already-authored document with a non-default `GAIN`/`DAMPING` value (same category as phase
 * 33's own `DELAY`->`CUTOFF` inversion) -- an existing patch will sound different at the same
 * dial value and likely wants re-tuning by ear, not a value the codec can safely "convert".
 */
```

### primitives/filter.ts, above `STRING_DECAY_MIN_SECONDS`/`STRING_DECAY_MAX_SECONDS`

```
// DECAY's percent->seconds range for the (default, unwired) noteOn-time register-independent
// path -- see `stringDecayGainExpr`'s own doc comment for the full story. A real, user-reported
// miss (2026-09-24): the FIRST fix here only raised the cycle-count ceiling (this same
// `STRING_DECAY_MAX_GAIN`), which is still fundamentally REGISTER-DEPENDENT (seconds-to--60dB is
// cycle-count times the played note's own PERIOD) -- worse, the SAME session's pitch-tracking
// fix shortens the loop's own effective period (subtracting the filters' group delay before the
// Hermite read), so decay got FASTER in real time even though the cycle-count ceiling went up.
// 0.05s-30s is a real, disclosed, plainly affine range (matching this file's own established
// ATTACK/DECAY envelope convention, `env_rate_from_percent`'s own "ms = 5 + t*1995" shape) --
// deliberately NOT run through `comb_response_warp`: that curve exists specifically because
// percent->COEFFICIENT has a genuine pole as the coefficient approaches 1, but this path
// computes coefficient FROM a target TIME instead (see the `expf` formula below), so the pole
// problem this warp curve was built to fix doesn't exist here at all.
//
// DECAY=100 is a SEPARATE, deliberate special case, not just "the top of the 30s range" -- a
// real, second round of user feedback (2026-09-24): even an exact, verified 10-second decay
// "didn't register" perceptually, and the actual ask was "ring out like an open guitar string
// with NO DAMPING". A finite RT60 number, however large, can't express that -- `logue/filter/
// svf`'s own `RESONANCE=100` already sets exactly this precedent in this same file (`k=0`, a
// genuinely lossless resonator, "rings forever once excited... accepted, working-as-intended
// behavior") -- see `noteOnStatement` below for where `decayGain_` is set to a literal `1.f`
// (mathematically lossless at the fundamental: `onepole_step`/`allpass1_step` are both already
// unity-gain there, verified via their own transfer functions in this primitive's earlier design
// work, so `decayGain_=1` makes the WHOLE loop unity-gain at the fundamental, not an
// approximation of "very long"). Real acoustic strings aren't LITERALLY undamped either (air
// resistance/internal friction always cost something eventually) -- this is the same accepted
// idealization svf's own `k=0` already ships.
```

### primitives/filter.ts, above `stringDecayGainExpr`

```
/**
 * Real, user-reported miss (2026-09-24, two rounds): first, "decay should be much longer... ring
 * out very slow, unrelated to register" -- raising a flat cycle-count ceiling (the very first fix
 * here) can't deliver that, because seconds-to--60dB is cycle-count TIMES the played note's own
 * period, which is exactly the thing that varies by register. Fixed with NO wired `decay` inlet
 * (the common case, and the one the user is actually turning a knob for): `decayGain_${suffix}` is
 * a per-instance field computed ONCE per real note-on (`noteOnStatement` below) from an EXACT
 * formula -- `g = exp(ln(0.001) * period / (targetSeconds * 48000))` -- solved so the loop reaches
 * -60dB in EXACTLY `targetSeconds` real seconds regardless of the period, not an approximation.
 * Second round: even a correct, verified 10-second decay "didn't register" perceptually, and the
 * real ask was "ring out like an open guitar string with NO DAMPING" -- a finite RT60 number,
 * however large, can't express that. `DECAY=100` is now a genuine special case, not just the top
 * of the seconds range: `noteOnStatement` sets `decayGain_` to a literal `1.f` there (mathematically
 * lossless at the fundamental, since `onepole_step`/`allpass1_step` are both already unity-gain --
 * NOT an approximation of "very long"), matching `logue/filter/svf`'s own `RESONANCE=100`->`k=0`
 * precedent ("rings forever once excited... accepted, working-as-intended behavior") exactly.
 * `DECAY` 0-99 still uses the exact seconds formula, now over a wider 0.05s-30s range.
 *
 * The seconds formula needs a genuine exponential, but NOT a real `expf` call: `exp_approx`
 * (see its own doc comment) is a libm-free polynomial approximation instead, found necessary
 * after a real local-toolchain LINK failure with actual `expf` (unlike `logue/filter/svf`'s own
 * confirmed, disclosed `tanf` exception, which links clean).
 *
 * A wired `decay` inlet is a real, disclosed EXCEPTION to ALL of this: `noteOnStatement` has no
 * access to a node's wired inlets (only `PrimitiveParamSpec`/plain per-instance fields), so a
 * live-modulated decay can't use the noteOn-time formula (or the lossless special case) at all --
 * it falls back to the OLDER, cycle-count-based, register-DEPENDENT shape
 * (`STRING_DECAY_MAX_GAIN`, same math comb's own `GAIN` uses). A real, deliberate divergence
 * between the two paths, not an oversight: a wired decay implies live/expressive continuous
 * control, which is a genuinely different use from "how long does THIS pluck ring" -- the dial's
 * own, much more common case.
 */
```

### primitives/filter.ts, above `FORMANT_BP_STEP_HELPER`

```
/**
 * `__attribute__((always_inline))` here (and on `FORMANT_NOTE_W0_HELPER` below) is a real,
 * hardware-confirmed fix for a real `-Os`-specific crash -- see the fuller bisect story in this
 * project's own commit history. Short version: the doubly-nested-call-as-argument restructuring
 * tried first did NOT fix it (confirmed on real hardware: the restructured source, still
 * compiled at the SDK's own default `-Os`, crashed identically). Disassembling a `-O2` rebuild of
 * the original source against the crashing `-Os` build found the real structural difference: at
 * `-O2`, GCC fully inlines `process`/`formant_step`/`formant_bp_step`/`formant_g_from_note`/
 * `note_w0` into ONE function with no real calls at all; at `-Os`, those stay separate, real ARM
 * `bl` calls. Force-inlining just `formant_bp_step`/`formant_g_from_note` fixed the simplest
 * reproduction (a single wired `resonance` inlet) but NOT the original, more heavily-wired
 * patch (`vowel`/`shift`/`resonance` all wired at once) -- real hardware confirmed BOTH results,
 * not assumed from the first fix generalizing. That means the bug scales with something ELSE
 * still uninlined nearby, and the one remaining candidate is `note_w0` itself, called 3x from
 * inside `formant_g_from_note` -- so `FORMANT_NOTE_W0_HELPER` (below) is a force-inlined,
 * formant-only DUPLICATE of the shared `NOTE_W0_HELPER`'s exact body, used only here. The
 * shared, non-inlined `note_w0` itself is deliberately left completely untouched for every
 * other primitive (oscillators, comb, svf) -- each already real-hardware-verified as a real,
 * non-inlined function call, so widening this fix to touch that shared helper would risk
 * consequences for already-shipped, working code for no evidence-backed reason. This isn't a
 * fix for a fully IDENTIFIED root cause (manually reading the non-inlined functions' own `-Os`
 * disassembly found nothing incorrect per AAPCS-VFP -- no touched callee-saved register left
 * unsaved), it's an empirically-driven one: eliminate every real function call in formant's own
 * hot path, matching the one confirmed-safe configuration (full inlining) as closely as possible
 * without touching code shared by other, already-proven-safe primitives.
 */
```

### primitives/filter.ts, above `FORMANT_STEP_HELPER`

```
/**
 * A real, hardware-confirmed minilogue xd crash (2026-09-19, "kind of crashes... UI gets
 * unfunctional") traced to this helper's OWN original shape, not to any DSP/logic bug -- see
 * this file's own git history for the full bisect. `resonancePercent`/`x` used to arrive as an
 * already-CONVERTED `k` value, computed by `formant_k_from_percent(clampf(...))` NESTED DIRECTLY
 * as an inline call argument at the `renderExpr` call site (i.e. inside `process()`'s per-sample
 * loop: `formant_step(..., formant_k_from_percent(clampf(...)), ...)`), and `formant_g_from_note
 * (noteA/B/C)` was similarly nested directly as an inline argument to each `formant_bp_step`
 * call INSIDE this function. An exhaustive real-hardware bisect (11 staged builds) ruled out
 * every DSP/numeric explanation -- the exact same resonance value verified byte-identical, a
 * 10M-sample single-precision-emulated stability sweep, a full ELF/section/linker-script diff
 * all came back clean -- and isolated the one remaining variable: rebuilding the EXACT crashing
 * source at `-O2` instead of the SDK's own `-Os` did NOT crash, confirming a real `-Os`
 * codegen-level issue specific to this doubly-nested-call-as-argument shape (not reproduced,
 * not something this project can fix in GCC itself). `logue/filter/svf`'s own `svfKExpr` already
 * establishes the safe alternative this file otherwise always uses: assign a nested-helper-call
 * result to a NAMED LOCAL before using it as a further call argument, never inline it directly
 * -- `formant_step` was the one place in the whole registry that broke that convention (`renderExpr`'s
 * single-expression contract forced the OUTER `formant_k_from_percent` call to nest at the call
 * site; there was no structural reason for the INNER `formant_g_from_note` calls to nest, that
 * was simply an oversight). Fixed by moving the percent->k conversion INSIDE this function
 * (taking raw `resonancePercent`, symmetric with `vowelPercent`/`shiftSemis`) and assigning
 * every nested-helper-call result (`k`, `gA`/`gB`/`gC`) to its own named local first. Verified: a
 * real Docker build of the ORIGINAL crashing patch, unchanged from the bisect's own crashing
 * unit except for this restructuring, compiled clean at `-Os` and was confirmed on real hardware
 * to no longer crash.
 *
 * Row order: u, o, a, e, i (index 0..4); columns: F1, F2, F3 (index 0..2) -- see
 * logue/filter/formant's own doc comment for the Hz source table, the note-space conversion,
 * and why this sweep order (not alphabetical) was picked.
 */
```

### primitives/env.ts, above `ATTACK_INLET_DEPTH` (documents `adEnvelopePrimitive`, logue/env/ad)

```
/**
 * A simple one-shot AD (Attack-Decay) envelope -- the first
 * primitive with `noteOnStatement` (retriggers on every real note-on) and the other half of the
 * "envelope + VCA" pair. Deliberately NOT a full ADSR: there is no sustain stage and no release
 * -- note-off is intentionally IGNORED (no `noteOffStatement` at all), so the envelope always
 * runs to completion (attack then decay to 0) regardless of how long the note is held, the same
 * "pluck" shape many real percussion/pluck synths use for their simplest envelope. A real
 * sustain/release stage is a genuinely bigger addition (a third stage, a note-off hook this
 * primitive doesn't need yet) -- left for a future primitive if a real patch needs it, matching
 * this project's "grow only as needed" discipline.
 *
 * Like the filter, the state update happens INSIDE the `ad_env_step` helper (mutating `stage`/
 * `level` by pointer) rather than in `advanceStatement` -- the next stage/level genuinely
 * depends on the JUST-computed step, not a value advanceable independently beforehand.
 *
 * `attack`/`decay` inlets (phase 20): both stage times are wireable, so an envelope's own shape
 * can itself be modulated (a second envelope or a `logue/sense/*` source shortening the decay as
 * a patch plays, a `logue/util/constant` offsetting it by a fixed amount). Additive/`+-50`/
 * clamped -- see `envRateExpr` below for the full shape and for why a per-sample-varying rate is
 * safe here. Both inlets are `control`-role and there is no `audio` one: an envelope is a pure
 * source of control signal, nothing passes THROUGH it (`sine-lfo`'s own `rate`-only inlet list
 * is the same shape, for the same reason).
 *
 * `trig` (a genuine fix for a real, disclosed gap: `logue/logic/edge`'s own doc comment names
 * this exact primitive as something "nothing else in this registry currently listens for a wired
 * one-shot trigger" for): a rising edge (this registry's usual `>=0.5f` gate read, see the
 * gate-convention doc comment above `thresholdExpr`) retriggers the envelope from a WIRED signal
 * -- any `logue/logic/*` gate/comparator, an `logue/logic/edge` pulse, or a raw bipolar LFO --
 * exactly as if a real note-on had just fired (`stage_=1`, continuing from the CURRENT level, not
 * resetting to 0 -- identical to `noteOnStatement`'s own behavior, see `ad_env_step`'s own doc
 * comment). Left unwired, `trig` is a genuine no-op (an unwired inlet is always `0.f`, which never
 * reads as a rising edge) -- but note this DOES change every existing document's own exported
 * source TEXT (two new trailing arguments on every `ad_env_step`/`ahd_env_step` call site, one new
 * always-present `prevTrig_` member), even though the actual DSP/behavior is byte-identical
 * whenever `trig` is never wired -- a real, disclosed one-time codegen text diff, not a runtime
 * behavior change, the same class of disclosed-but-inert cost `fmDepthPercent_`/`coarse_`/`fine_`
 * already impose on every oscillator instance regardless of whether their own inlets are wired.
 */
```

### primitives/env.ts, above `ahdEnvelopePrimitive` (logue/env/ahd)

```
/**
 * A gated Attack-Hold-Decay envelope -- requested as an
 * alternative to `logue/env/ad`'s own one-shot "pluck" shape (attack then decay to 0
 * regardless of how long the note is held). Here HOLD is not a dialable time at all: after
 * ATTACK reaches its peak, the envelope pins at 1 for exactly as long as the note stays held
 * (a real sustain-at-fixed-level stage, gate-tracked) and only starts DECAY once a real note-off
 * arrives -- so this is the first primitive in the registry that needs `noteOffStatement`, a
 * mechanism that didn't exist before this phase (see `LoguePrimitive.noteOffStatement`'s own doc
 * comment for why it was never needed until now, and both platform generators' own `noteOff()`
 * wiring for the new plumbing this required).
 *
 * A deliberately separate primitive from `logue/env/ad`, not a mode toggle on it: gating decay
 * behind note-off is a genuinely different envelope SHAPE (a patch built on `ad`'s own disclosed
 * "always runs to completion" behavior would silently start hanging at 1 forever on a long-held
 * note if that behavior changed underneath it), not a generalization where one setting's default
 * reproduces the other's exact output the way `logue/filter/comb`'s `TRACK` or the wireable-
 * inlet phases did -- matching this registry's existing one-primitive-per-envelope-shape
 * precedent (`logue/env/ad` itself, `logue/lfo/*`'s one-primitive-per-waveform).
 *
 * `noteOnStatement` is identical to `logue/env/ad`'s own: retrigger always restarts at stage 1
 * (attack) WITHOUT resetting `level_` first, so a retrigger mid-decay (or mid-hold, from a fast
 * legato re-press) continues from the current level rather than clicking back to 0.
 * `noteOffStatement` only actually does anything from stage 1 (attack) or 2 (hold) -- an
 * already-idle (0) or already-decaying (3) instance ignores a redundant/stray note-off rather
 * than restarting its own decay ramp. Note-off arriving mid-attack (before the envelope ever
 * reaches its peak) still moves straight to decay from whatever level attack had reached so far,
 * the same "release from wherever you are" behavior most real envelope generators use, rather
 * than forcing the envelope up to 1 first.
 *
 * ATTACK/DECAY reuse `logue/env/ad`'s own `envRateExpr`/`ENV_RATE_HELPER`/wireable-inlet shape
 * verbatim (identical percent domain, identical additive/+-50/clamp modulation) -- there is
 * nothing AHD-specific about how either stage's OWN rate is computed, only about what triggers
 * the transition OUT of the hold stage.
 *
 * `trig` reuses `logue/env/ad`'s own doc comment verbatim for the general mechanism (rising edge
 * -> `stage_=1`, unwired is a genuine no-op, same disclosed one-time codegen-text-only diff for
 * every existing document). The one real difference: a wired `trig` here is a NOTE-ON equivalent
 * ONLY -- it can (re)start attack from any stage, but it can never move stage 2 (hold) to stage 3
 * (decay) the way a real note-off does. Deliberately scoped this way rather than also wiring
 * `trig`'s FALLING edge to mimic note-off: that would turn `trig` into a full gate input (a
 * bigger, genuinely different feature -- an externally gated envelope independent of the
 * platform's own note-on/off) rather than the focused "retrigger from a wired pulse" fix this
 * phase actually asked for; left for a future primitive if a real patch needs it.
 */
```

### primitives/gain.ts, above `vcaPrimitive` (logue/gain/vca)

```
/**
 * A VCA (voltage-controlled amplifier) -- the second phase-4 primitive, the plain multiply half
 * of the "envelope + VCA" pair (`logue/env/ad` below is the other half). One audio inlet (`in`),
 * one control inlet (`gain`, same wireable-or-param-fallback shape as the filter's `cutoff`,
 * FULLY REPLACING the param when wired -- a wired signal is used verbatim, unaffected by
 * `GAIN`'s own raw-to-linear scale below) -- `gain` falls back to a `GAIN` param when unwired.
 *
 * **`GAIN`'s own raw-to-linear scale is `*0.04f` (0-400%), not the original phase-4 `*0.01f`
 * (0-100%)** -- a real, disclosed change made when `logue/filter/formant` shipped with a real,
 * user-reported "output is very quiet, especially at high RESONANCE" complaint. A per-band
 * unity-peak-gain-normalized resonant filter genuinely passes less total energy as its own
 * bandwidth narrows (an inherent property of narrowband filtering broadband/harmonic content,
 * not a bug -- see `formant_bp_step`'s own doc comment) -- confirmed to need this widening of an
 * EXISTING general-purpose tool rather than a new one or an automatic per-filter compensation:
 * `formant_g_from_note`'s `k*v1` normalization already guarantees a tone parked exactly on a
 * formant peak never exceeds unity gain regardless of `RESONANCE` (the specific landmine that
 * primitive's own doc comment says it avoids) -- an automatic RESONANCE-dependent output boost
 * would have silently reintroduced exactly that entanglement for any harmonically-tuned source,
 * trading a quietness complaint for a clipping one. A NEW dedicated "boost" primitive was also
 * considered and declined: this registry's own phase-9 precedent already establishes that
 * `logue/gain/vca` with its `gain` inlet left unwired covers "a plain, unmodulatable attenuator"
 * so a second one would be redundant -- the same reasoning applies in reverse to a boost, and a
 * per-primitive `LEVEL`/`OUTPUT` param added directly to `logue/filter/formant` instead would
 * cost a real param slot on a platform with only 6 of them (minilogue xd) for a need `vca`
 * already generically serves. Widening `GAIN`'s own manifest range instead of its scale (e.g.
 * `max: 400`) was tried first and rejected: minilogue xd's own real hardware caps a custom
 * param's manifest range near `+-100` (a real Korg Librarian rejection, see
 * `minilogue-xd/generateOscUnit.ts`'s own doc comment) -- widening the SCALE while keeping the
 * manifest range at `0-100` is the only route that stays within that real hardware constraint.
 * `default` moved from `100` to `25` alongside the scale change specifically so a FRESH,
 * untouched `vca` instance still outputs unity gain by default (`25 * 0.04 = 1.0`, byte-identical
 * default behavior to before) -- but this IS a real, disclosed, SILENT behavior change for any
 * already-authored document with an explicit non-default `GAIN` value: `GAIN=100` meant exactly
 * unity gain before this change and now means a real `4.0x`/`+12dB` boost, and a physical device
 * knob assigned to this param via `logueParamIndex` now sweeps 4x further for the same rotation.
 * Accepted as the direct fix for a real reported symptom, the same class of deliberate,
 * disclosed rename/rescale `logue/filter/comb`'s own `DELAY`->`CUTOFF` inversion (phase 33) and
 * `GAIN=0`-defaults-to-silent fix already made.
 */
```

### primitives/mix.ts, above `crossfaderPrimitive` (logue/mix/crossfader)

```
/**
 * An equal-power (constant-loudness) crossfader -- third `mix` primitive, requested because
 * `mix2`'s own fixed/independent gains can't express a single "position" control that moves
 * smoothly from one input to the other. A plain LINEAR fade (`gain1 = 1-t`, `gain2 = t`) dips
 * noticeably in perceived loudness around the center (`gain1^2 + gain2^2` bottoms out at `0.5`
 * there), which is exactly the "equal loudness" property the user asked for -- so this uses the
 * standard constant-power SQUARE-ROOT pan law instead (`gain1 = sqrt(1-t)`, `gain2 = sqrt(t)`):
 * `gain1^2 + gain2^2` is exactly `1` at every point along the fade, not just the two endpoints.
 * `sqrtf` reuses the same "cheap intrinsic, not a real libm cost" precedent `fabsf` already
 * established (`saturatorPrimitive`'s own doc comment) -- both compile to a single FPU
 * instruction on the real target MCU, unlike `expf`/`logf`.
 *
 * `FADE` (0-100 percent, default 50 -- dead center, equal mix) is the dial fallback; a wired
 * `fade` inlet FULLY REPLACES it (same shape as `logue/gain/vca`'s own `gain` inlet, not the
 * additive `+-50`/clamp shape `width`/`rate`/etc. use) since the user's own ask is specifically
 * "position the fade with a signal," not "nudge a dial-set position." The wired value is
 * clamped to `[0,1]` before use -- unlike `gain`'s inlet, a value outside that range would feed
 * a negative number into `sqrtf`, producing NaN, not merely an out-of-range-but-still-finite
 * result -- so this clamp is load-bearing, not precautionary. `in1`/`in2` left unwired read as
 * silence (`0.f`), same convention as every other mixer in this registry.
 *
 * "Equal loudness" holds exactly for the intended use (crossfading between two UNCORRELATED
 * sources -- different oscillators/samples): summed power stays at a constant `1x` an
 * uncorrelated pair's own combined power across the whole fade, which is the entire point of
 * the square-root law over a plain linear one. Two fully CORRELATED, in-phase, full-scale
 * inputs (e.g. the same source wired into both `in1` and `in2`) are the one case where this
 * differs from `mix2`'s own headroom tradeoff: at dead center both gains are `~0.707`, not
 * `0.5`, so the sum can reach `~1.41x` rather than staying at `1x` -- a real, disclosed
 * consequence of constant-power crossfading a correlated pair, not a bug (same category of
 * caveat `mix2`'s own doc comment already discloses for its own, differently-tuned tradeoff).
 */
```
### primitives/osc.ts, above `sawIncrementExpr`

```
/**
 * `logue/osc/saw`'s own combined phase increment. Reduces to the plain `transposedW0Expr` --
 * byte-identical to every other oscillator's own increment -- whenever `fm` is unwired OR `TZFM`
 * is off; only once `tzfm_<suffix> >= TRACK_ON_RAW_THRESHOLD` does it MULTIPLY that base
 * increment by `(1 + fm * depth)`, `depth` being `FM_DEPTH`'s own raw percent scaled by
 * `TZFM_DEPTH_PER_PERCENT` (with the same additive `fmDepth`-inlet handling `fmPhaseExpr` already
 * has for its PM case). Multiplying, not adding, is load-bearing, not stylistic -- an earlier
 * draft added `fm * depth` directly to `base`, which does NOT track `w0` despite reading like it
 * should: at audio-rate pitches `base` is tiny (~0.02 near A4) next to a depth of up to 4.0, so
 * the additive version let the fm term totally swamp the pitch term rather than scale it. Caught
 * by actually running the harness (a "5x faster" case rendered SLOWER than an unmodulated saw),
 * not by re-reading the formula -- see this file's own general "verify by running" discipline.
 * Mirrors `combCutoffSamplesExpr`'s own runtime `track_ >= TRACK_ON_RAW_THRESHOLD ? ... : ...`
 * shape -- the same mode-switch idiom, reusing the same shared threshold constant.
 *
 * Called from BOTH `advanceStatement` (accumulates this into `phase_`) and `renderExpr` (as
 * `polyblep_saw`'s own `dt`, so the antialiasing correction tracks the SAME signed instantaneous
 * velocity the accumulator just used) -- recomputed independently in both places, the same
 * "acceptable default" `transposedW0Expr`'s own doc comment already established, EXCEPT this one
 * genuinely carries a real ordering dependency now: it reads `inlets.fm`, an upstream instance's
 * OWN current-sample output (a `y_<suffix>` local), not just per-block-constant pitch state. That
 * dependency is satisfied by construction, not accidentally -- `oscBody.ts`'s `computeStatements`
 * always runs before `advanceStatements`, in the same per-sample scope, and an inlet's source is
 * always topologically earlier -- but it IS a real, disclosed difference from the "no ordering
 * dependency" claim `sawOscPrimitive`'s own doc comment below makes for the non-FM case.
 */
```

### primitives/osc.ts, above `GRANULAR_GRAINS`

```
/**
 * `logue/osc/granular` (2026-09-26): a short baked sample (`ObjNode.sample`, 8-bit mu-law,
 * imported and resampled in `sample/importSample.ts`) read by a fixed pool of overlapping
 * windowed grains, positioned by POSITION with random SMEAR around it. Two ways to follow the
 * played note, switched by `SYNC`:
 *  - SYNC on (default): a new grain starts once per note PERIOD and plays the sample at its
 *    stored rate -- pitch comes from the grain rate, timbre from whatever sits at POSITION, and
 *    formants stay put across the keyboard (pitch-synchronous overlap-add). At SIZE's shortest
 *    setting with no SMEAR this is a wavetable oscillator scanned by POSITION -- the "wavetable"
 *    half of the design.
 *  - SYNC off: classic granular -- grains start on their own clock (SIZE in ms, DENSITY as
 *    overlap), each played faster/slower by `note / ROOT` so the sample's own pitch transposes.
 *
 * Every helper here is `always_inline`, so the engine makes no real calls below `process()`. The
 * first version called `granular_step` for real and it called `mulaw_decode`/`grain_sin_pi` in
 * turn -- a real minilogue xd hang ("sound doesn't stop, device unresponsive") while turning
 * knobs, the same two-deep `-Os` call shape as `logue/filter/formant`'s crash (see
 * `FORMANT_BP_STEP_HELPER`). A 25M-sample random-param fuzz under ASan/UBSan/float-cast-overflow
 * found no out-of-bounds read or bad math, so the call shape is the one known difference.
 *
 * The grain pool is fixed at `GRANULAR_GRAINS` and recycled round-robin; grain length is capped
 * at that many spawn intervals so a still-sounding grain is never stolen mid-window (a click).
 * Reads are linear-interpolated -- the import's resampler is the only anti-aliasing, a disclosed
 * lo-fi tradeoff, like the playback-speed cap below.
 */
```

### primitives/osc.ts, above `pluckExciterPrimitive`

```
/**
 * A one-knob noise exciter, designed to feed `logue/filter/string` (or `comb`) rather than to be
 * heard on its own -- see this file's own commit history for the design conversation this came
 * out of. `BOW` alone crossfades the whole character:
 *
 * - **0%**: a single short, bright, register-independent click that decays in a handful of ms
 *   regardless of how long the note is held -- a plucked-string exciter, replacing the
 *   noise->AD->VCA chain a patch would otherwise wire by hand. Exactly zero extra strikes
 *   (`strikesRemaining_` derives from `BOW` alone, see `EXCITER_STRIKE_MAX_COUNT`'s own doc
 *   comment), so this stays a real one-shot pluck, byte-identical to the original design.
 * - **mid-range**: the initial click is followed by a real, decaying FLURRY of softer, warmer
 *   re-strikes (not a single smooth ramp) -- a real, disclosed physical distinction a user's own
 *   ear caught: a harpsichord's quill pluck is one hard transient, but a classical guitar's
 *   attack is often several quick, softer re-catches before the tone settles, not one swell. See
 *   `EXCITER_STRIKE_MAX_COUNT`'s own doc comment for the exact feedback and mechanism.
 * - **100%**: after any strike-train, the exciter holds and keeps feeding the resonator for as
 *   long as the note stays down, lowpassed to a note-tracked brightness so the fed energy stays
 *   concentrated near the string's own harmonic series -- a continuously-fed resonant loop
 *   develops a "singing" quality purely from its own resonance reinforcing those harmonics over
 *   many round-trips, which a one-shot burst never rings long enough to do. Only releases (fades
 *   out) on a real note-off, like a bow lifting off the string.
 *
 * Deliberately no separate `COARSE`/`FINE` -- this primitive isn't itself a pitched tone (nothing
 * about its own output is tuned), it just reads the played note directly to steer the bow end's
 * tracked brightness; unlike an oscillator's `transposedW0Expr`, there is no per-instance tuning
 * offset that would mean anything here.
 *
 * `bow` (control inlet, additive -- see `exciterBowPercentExpr`'s own doc comment) is the only
 * inlet: like `logue/osc/noise`, there's no other natural external control to wire in here;
 * wiring the exciter's own output through `logue/gain/vca` already covers "control this source's
 * level" the same way it does for plain noise.
 */
```

### primitives/lfo.ts, above `RATE_INLET_DEPTH`

```
/**
 * A free-running LFO -- sine was the only shape for a long while, until
 * the "more LFO shapes" follow-up added triangle/square/ramp-up/ramp-down. Deliberately NOT
 * a reuse of the oscillator primitives: those advance by the shared, note-pitch-derived `w0_`
 * (every real oscillator in this registry is pitch-locked to the played note) -- an LFO instead
 * needs its own independent phase accumulator advancing at a fixed, user-set RATE with no
 * relationship to note pitch at all. Every shape below shares that same accumulator, the same
 * `rate`-inlet handling, and the same `RATE` param -- only `renderExpr` (the phase-to-value
 * mapping) differs, so `makeLfoPrimitive` is a factory over that one difference rather than five
 * near-duplicate object literals.
 *
 * Considered and declined: a single configurable LFO primitive with a `WAVE` selector param
 * instead of five ids. Rejected because there is no design-time attrib/dropdown mechanism in
 * this app at all (`Inspector.tsx` edits declared params only, nothing else) -- the only
 * existing hook for "pick one of several options" is a `PrimitiveParamSpec`, which is a RUNTIME
 * `OSC_PARAM` value the compiler can't fold: every shape's branch would compile into every LFO
 * instance regardless of which one is ever selected. Separate primitives cost nothing extra here
 * (each shape is plain arithmetic on the same `phase_<suffix>`, sharing this file's existing
 * `LFO_RATE_HELPER`/`CLAMPF_HELPER` verbatim) and match this registry's own existing precedent of
 * one primitive per oscillator shape (`logue/osc/{sine,saw,square,pulse,triangle}`) rather than
 * one configurable oscillator.
 *
 * Every shape stays bipolar (`[-1,1]`, same domain as every other primitive), not unipolar
 * `[0,1]` -- deliberately NOT special-cased for "typical LFO modulation" use, matching this
 * project's "one plain per-sample float domain regardless of role" design (see
 * `PrimitiveInletSpec`'s own doc comment). A real, disclosed consequence: wiring any of these
 * into `logue/gain/vca`'s `gain` inlet produces amplitude modulation WITH polarity inversion on
 * the negative half-cycle (a real tremolo effect, just not the classic unipolar-only one some
 * synths default to), and wiring one into `logue/filter/lowpass-cheap`'s `cutoff` inlet gates the
 * filter fully closed for the negative half (`onepole_step`'s own existing clamp, not new
 * behavior this primitive introduces) -- both are real, valid, already-covered behaviors of the
 * existing consumers, not bugs. A future unipolar variant is a real, separate primitive to add if
 * a patch specifically wants classic tremolo/cutoff-sweep-only behavior -- not attempted here,
 * matching this project's "grow only as needed" discipline.
 *
 * The naive square/ramp shapes below have a real, disclosed sharp edge every sample period --
 * deliberately NOT polyblep-antialiased the way `sawOscPrimitive`/`squareOscPrimitive` are. Those
 * need it because their edge repeats at audio rate (20Hz-20kHz, well into the aliasing-prone
 * range); an LFO's edge repeats at 0.1Hz-20Hz (`LFO_RATE_HELPER`'s own fixed range) -- far below
 * any audible aliasing concern for a signal that's normally consumed as a slowly-varying control
 * value, not played back as the audio output itself.
 *
 * `rate` inlet: additive, like
 * `pitch`/`width` elsewhere in this file -- `RATE`'s own member is `ratePercent_<suffix>`,
 * storing the RAW percent (the `lfo_rate_from_percent` conversion happens at point-of-use) so a
 * wired value can add to it, in the same raw percent units, before that conversion happens. A
 * full `+-1` swing maps to `+-50` percentage points -- half of `RATE`'s own `0-100` range, same
 * depth-derivation rule as `width` above. *
 * `trig` inlet: resets the phase to 0 (see `lfoTrigResetStatement`), so each shape restarts at
 * its own phase-0 value -- sine at its rising zero crossing, triangle/ramp-up at -1, square/
 * ramp-down at +1.
 */
```

### primitives/lfo.ts, above `SAMPLE_HOLD_HELPER`

```
/**
 * A sample-and-hold LFO -- the "more LFO shapes" follow-up's one genuinely different addition
 * (triangle/square/ramp-up/ramp-down are all pure arithmetic on `makeLfoPrimitive`'s shared
 * accumulator; this one has its own state and its own inlet). Generic rather than random-only:
 * an `in` audio inlet samples WHATEVER is wired into it at each RATE-driven trigger -- wire
 * `logue/osc/noise` in for the classic random-stepped LFO, or wire any other signal in for a
 * quantized/stepped version of it (e.g. holding a slow sine into a scale-like staircase). Same
 * "decline a special-cased primitive when the general one costs nothing extra" precedent as the
 * declined plain-attenuator (`logue/gain/vca` with `gain` left unwired already IS one) --
 * `logue/osc/noise` wired into `logue/gain/vca` already covers "a plain, unmodulatable
 * attenuator", so no separate one was added; the same reasoning argues against a second,
 * noise-only S&H when this one covers it via wiring.
 *
 * Unwired `in` does NOT read as silence the way `mix2`/`multiply`'s unwired inlets do -- that
 * would make a freshly-placed instance look broken (a S&H with nothing wired in is exactly the
 * classic "random stepped LFO" use case, not a degenerate one). It falls back to `noise_step`,
 * reusing `noisePrimitive`'s own LCG helper and per-instance seed-hash technique verbatim so a
 * bare S&H is immediately useful without wiring anything at all.
 *
 * State update happens entirely inside `sample_hold_step` itself, called from `renderExpr` --
 * same shape as `onepole_step`/`ad_env_step`/`noise_step` (`advanceStatement` a real no-op) and
 * for the same reason those chose it: the trigger decision (did the phase cross 1.0 THIS sample)
 * has to be resolved before this sample's own output, not after it. `sine-lfo`'s own two-step
 * split (advance the phase in `advanceStatement`, read a continuous function of it in
 * `renderExpr`) doesn't work here because this primitive's output is a discontinuous STEP
 * function of the wrap itself, not a continuous function of the phase's value -- splitting the
 * two would make the just-latched sample invisible for one extra sample, needlessly.
 *
 * `held_<suffix>`/`seed_<suffix>` are declared unconditionally, even on an instance whose `in`
 * IS wired (a few bytes of dead state on that instance) -- `memberDecls` has no visibility into
 * a primitive's own inlet wiring (by design; wiring resolution belongs to `oscInstances.ts`, not
 * a primitive), so this is the same "harmless, disclosed, unconditional declaration" tradeoff
 * `logue/env/ad`'s inlets and `logue/filter/comb`'s always-declared `COARSE`/`FINE` members
 * already accept, at 5 bytes rather than anything worth branching codegen over.
 *
 * A freshly-placed instance stays at its init value (0.f) until its own first trigger -- up to
 * `LFO_RATE_HELPER`'s own full 10s worst case at `RATE=0`, ~0.25s at the default `RATE=20` -- a
 * real, disclosed startup transient, not a permanent silence the way an always-0-forever unwired
 * inlet would be (the concern the unwired-`in` fallback above actually addresses).
 */
```

### primitives/math.ts, above `CURVE_K_MAX`

```
/**
 * A linear/logarithmic/exponential curve morph -- originally the fourth `util` primitive,
 * requested as "linear to exponential" plus "linear to logarithmic" ASSEMBLED INTO ONE primitive
 * with a single `SHAPE` dial spanning both families (`-100` full logarithmic, `0` exact linear, `+100` full
 * exponential) rather than two separate one-way primitives -- both families turn out to be the
 * SAME rational curve mirrored around the diagonal (see below), so two ids would just be the same
 * formula twice, the same reasoning `crossfaderPrimitive` already applies to its own two-input
 * blend.
 *
 * Deliberately NOT `powf`/`expf`/`logf`: a continuous, runtime-variable exponent is exactly
 * `expf(p*logf(x))` under the hood, and this file has already refused that cost five separate
 * times (`env_rate_from_percent`, `cutoff_warp`, `lfo_rate_from_percent`, each with their own doc
 * comment on the code-size cost against the real 32KB budget) -- `tanf` (`logue/filter/svf`) is
 * the one confirmed, user-requested exception, and it's gated behind a mode switch specifically
 * so it's rarely actually evaluated. Nothing here asked to relax that rule, so instead this uses a
 * one-divide RATIONAL curve: `x / (1 + k*(1-x))` for the exponential/ease-in side, and its mirror
 * `1 - (1-x) / (1 + k*x)` for the logarithmic/ease-out side (algebraically `1 - exp_curve(1-x, k)`
 * -- an ease-out is just an ease-in read backwards). A single division is already an accepted cost
 * in this file (`env_rate_from_percent`'s own `1.f/samples`, phase 20's doc comment); `powf` would
 * have been a new one with no ask behind it.
 *
 * Both formulas pass through `(0,0)`/`(1,1)` and are EXACTLY linear at `k=0` for every `x` --
 * confirmed algebraically (`e_x = x/(1+0) = x`, `l_x = 1-(1-x)/(1+0) = x`) and numerically (a
 * 1001-point sweep per tested `SHAPE`, `K=16`: strictly monotonic, `y(0)=0`/`y(1)=1` exactly, at
 * every `SHAPE` from `-100` to `+100`). Since `curve_shape` blends `x` toward whichever curve by
 * exactly `shapeNorm`, `SHAPE=0` is an ALWAYS-exact linear passthrough regardless of `AMOUNT`, and
 * `AMOUNT=0` (`k=0`) is an always-exact passthrough regardless of `SHAPE` -- unlike `soft-clip`'s
 * own disclosed non-passthrough `DRIVE=0` case, this primitive's center detent is never merely
 * close to linear. Not verified against a real Docker build/hardware (no libm/state/platform-
 * specific risk exists here to need it for) -- the algebraic + numeric sweep above is the actual
 * correctness argument, same as `unipolarToBipolarPrimitive`'s own stateless converters never
 * needed a hardware check either.
 *
 * Domain is UNIPOLAR `0..1`, clamped on input (`CLAMPF_HELPER`) -- an ease curve is only
 * meaningful on a one-directional ramp (a velocity/CV-style curve), and this registry already has
 * a real bridge for a bipolar source (`logue/util/bipolar-to-unipolar`/`unipolar-to-bipolar`,
 * phase 24) rather than inventing an odd-symmetric bipolar variant here.
 *
 * `SHAPE` (`-100..100`, default `0`) is the primary, wireable control -- additive/clamp, depth
 * `100` (half of `SHAPE`'s own `-100..100` span, the same "half the param's own range" rule
 * `WIDTH_INLET_DEPTH`/`RATE_INLET_DEPTH`/`FM_DEPTH_INLET_DEPTH` already use, just scaled to a span
 * twice theirs). `AMOUNT` (`0..100`, default `100` -- full curve strength out of the box, so
 * `SHAPE` alone is the expected primary control the moment it's touched) stays dial-only, matching
 * `logue/filter/comb`'s own `TRACK`/`DAMPING` precedent of a character control shipping dial-only
 * until a real follow-up asks for more. `AMOUNT` maps to `k` via a fixed ceiling
 * (`CURVE_K_MAX = 16`, picked from the numeric sweep above -- doubling it past 16 barely moves the
 * curve further, so 16 is where the dial's top end stops buying anything).
 *
 * Reclassified `util` -> `math` (2026-09-25, alongside `invert`; `glide` stays `util`): a curve
 * reshape is arithmetic on a signal, a closer fit next to `add`/`subtract`/`scale`/`clamp` than a
 * domain-conversion utility. A pure category-only id rename, the same shape as
 * `logue/filter/lowpass`'s own phase-33 rename -- `RENAMED_PRIMITIVE_IDS` keeps an already-
 * authored `.loguepatch` file resolving under the old id, so this is a real, disclosed one-time
 * export-text diff, not a behavior change.
 */
```

### primitives/sense.ts, above `SENSE_OUTLETS`

```
/**
 * 6 new "sense" primitives, zero inlets/one outlet like an
 * oscillator, but wired to a real incoming *logue SDK value instead of computing one. All 6
 * started minilogue-xd-only (`platforms`): they decode raw fields from that platform's OWN
 * `user_osc_param_t`/`OSC_PARAM` shape (`minilogue-xd/generateOscUnit.ts`'s `generateOscCpp`),
 * verified directly against `platform/minilogue-xd/inc/userosc.h` in the real `logue-sdk`
 * checkout, with no researched NTS-1 mkII equivalent at the time.
 *
 * Phase 30 researched that NTS-1 mkII gap against the real SDK and found a real (if narrower)
 * equivalent for 3 of the 6: `sense/pitch`, `sense/shape`, and the device's second fixed knob
 * (`sense/shape-2` below -- see its own doc comment for why that one took two more phases and a
 * real merge/un-merge to get right) all widened their own `platforms` to include `'nts1mkii'`
 * (see `nts1mkii/generateOscUnit.ts`'s own doc comments for the mechanism). The other 2 stay
 * minilogue-xd-only for confirmed, disclosed reasons: `sense/cutoff`/`sense/resonance` read
 * `user_runtime_osc_context_t`'s `cutoff`/`resonance` fields, which Korg's own NTS-1 mkII header
 * marks "Unused. Future." -- genuinely dead on that platform, not unresearched. `sense/param` is
 * separately minilogue-xd-only too, but for a different reason -- fully redundant on NTS-1 mkII
 * (its own `setParameter` already delivers any exposed param live, no sense-style primitive
 * needed to read it a second way).
 *
 * The stateless/global ones (all but `sense/param`) share one shape -- `memberDecls: () => ''`,
 * `renderExpr` just names a shared Osc-class member the generator always declares/computes
 * (alongside `w0_`), regardless of how many instances of a given sense primitive are placed (same
 * reasoning `logue/mix/mix2` already established for a primitive with no per-instance state: the
 * sensed value is identical no matter how many readers there are).
 *
 * **Dual `unipolar`/`bipolar` outlets** (all six of `pitch`/`shape`/`shape-2`/`cutoff`/
 * `resonance`/`param`, NOT `logue/sense/gate` -- see below): every sense reading is natively
 * unipolar `0..1`, but this registry's other signal sources (oscillators, LFOs, `constant`) are
 * bipolar `-1..1`, and a real, repeatedly-hit patching cost was needing a separate
 * `logue/util/unipolar-to-bipolar` node every time a sense value fed a bipolar-expecting inlet
 * (`pitch`/`fm`/etc.) -- see `unipolarToBipolarPrimitive`'s own doc comment for the fuller
 * account of the two-domain split this was already bridging for arbitrary wired signals. Rather
 * than make the user patch that bridge in for this one specific, extremely common source
 * category, each of these six now computes BOTH forms directly (`bipolar = unipolar*2-1`, the
 * exact formula that converter already uses) via `renderOutletStatements` -- trivial extra cost
 * (one multiply-add) for a stateless primitive with no shared per-sample computation to protect
 * from double-evaluation the way `svf`/`formant`'s multi-outlet math needs. `unipolar` is
 * declared FIRST specifically so `resolveSourceOutlet`'s "no outlet named on this net -> use the
 * first declared one" fallback resolves every already-authored `.loguepatch` net to the exact
 * same value it read before this change (`renderExpr` used to return the raw unipolar reading
 * directly) -- no outlet-level rename/migration mechanism exists, so this ordering IS the
 * migration story. `logue/sense/gate`'s own `held_` is a discrete note-on/off boolean read
 * through the registry's shared `>=0.5f` gate convention elsewhere, not a continuous value with
 * a genuine polarity ambiguity -- deliberately excluded rather than added for symmetry alone.
 */
```

### primitives/sense.ts, above `senseShape2Primitive`

```
/**
 * The device's own SECOND fixed knob -- minilogue xd calls it Shift-Shape, NTS-1 mkII calls it
 * Alt-Shape (`k_unit_osc_fixed_param_altshape`, `platform/nts-1_mkii/common/unit_osc.h`), same
 * physical control. Originally shipped as two SEPARATE primitives (`logue/sense/shift-shape`
 * minilogue-xd-only from phase 7, `logue/sense/shape-alt` nts1mkii-only added in phase 32)
 * specifically BECAUSE the two platforms deliver it through genuinely different mechanisms:
 * minilogue xd's is a fixed `OSC_PARAM` ordinal outside the manifest entirely, NTS-1 mkII's is
 * that unit's own reserved param slot 1 (`ALT_SHAPE_PARAM_INDEX`, `nts1mkii/generateOscUnit.ts`).
 *
 * **Merged into one id, reversing that split** -- a
 * real, concrete blocker surfaced the gap: a user wiring `logue/filter/formant`'s `shift` inlet
 * needed BOTH platforms' own second-knob value feeding the SAME inlet (each platform only
 * supports one of the two source primitives), which the "one net per inlet" rule made impossible
 * with two separate ids -- and combining them through `logue/mix/mix2` first didn't work either:
 * it makes both instances simultaneously ACTIVE regardless of target platform, so
 * `assertPrimitivesSupportPlatform` hard-errors the build for BOTH platforms rather than just
 * producing a wrong value.
 *
 * Revisiting the original "genuinely different mechanisms" reasoning found it doesn't actually
 * distinguish this pair from `logue/sense/shape` above, which ALREADY merges across the exact
 * same ordinal-vs-slot boundary (minilogue xd: fixed OSC_PARAM ordinal; NTS-1 mkII: reserved
 * `setParameter` slot 0) with no correctness issue -- the split was, in retrospect, inconsistent
 * with that precedent rather than required by it. If anything this merge is SIMPLER than
 * `sense/shape`'s own: neither knob has a Mod-LFO term to combine, so each generator's own
 * populate code is an unconditional single write to the shared `shape2_01_` member below, no
 * combining logic needed at all -- `minilogue-xd/generateOscUnit.ts`'s `k_user_osc_param_
 * shiftshape` OSC_PARAM read and `nts1mkii/generateOscUnit.ts`'s slot-1 `setParameter` read are
 * both completely unchanged mechanically, only the shared member name (was `shiftshape01_`/
 * `altShape01_`) and this primitive's own id/registration are new. `reserveFixedKnobSlots`
 * (NTS-1 mkII) needed no change at all -- it already reserves both fixed-knob slots
 * unconditionally on every build (phase 33), regardless of which sense primitives are placed.
 *
 * `platforms` restriction dropped entirely -- valid on both, same shape as `sense/shape`/
 * `sense/pitch`. A neutral id (`shape-2`, not `shift-shape`/`alt-shape`/either device's own term)
 * was picked deliberately -- the original merge plan, written
 * before either single-platform primitive existed, had already flagged exactly this as its own
 * open question: "a label that doesn't imply either platform's own terminology is authoritative."
 * A `.loguepatch` file with an old `logue/sense/shift-shape`/`logue/sense/shape-alt` node had no
 * migration at the time this merge shipped -- same precedent every other primitive-id rename in
 * this registry had set (e.g. `logue/noise/white` -> `logue/osc/noise`, phase 17): re-insert the
 * primitive and rewire. **Superseded the next day**: `RENAMED_PRIMITIVE_IDS` (below, near
 * `findLoguePrimitive`) now maps both old ids here to `logue/sense/shape-2` automatically, so an
 * old file resolves and renders correctly without any manual fix -- see that table's own doc
 * comment for the incident that prompted it (this exact merge, hitting a real user file).
 */
```

### primitives/sense.ts, above `senseGatePrimitive`

```
/**
 * The real note-on/note-off gate, exposed as an ordinary wireable signal -- requested after a
 * real, concrete gap surfaced: `logue/env/ad`/`logue/env/ahd` gained a wireable `trig` inlet
 * (retriggering from a rising edge on any wired signal, same as a real note-on) specifically
 * because `logue/logic/edge`'s own doc comment disclosed that nothing in this registry could
 * ever DRIVE that wire from a real note event -- `noteOnStatement`/`noteOffStatement` only ever
 * let a primitive mutate ITS OWN members, with no way to read "is a note held" anywhere else.
 * This closes that gap directly: `held_` flips to `1.f`/`0.f` in this primitive's own
 * `noteOnStatement`/`noteOffStatement` (the exact same per-instance mechanism `logue/env/ad`'s
 * own `stage_`/`logue/env/ahd`'s `stage_`/every stateful `logue/logic/*` primitive's own state
 * already uses), then `renderExpr` just reads it back -- no helper needed, this is simpler than
 * every other stateful primitive in the registry, not more.
 *
 * Deliberately per-INSTANCE state (like `sensePitchPrimitive`'s own `note01_`, this one does NOT
 * reuse the shared Osc-class-level "sense-bridging" member mechanism `logue/sense/pitch`/
 * `logue/sense/shape` read) -- reusing that mechanism would mean touching both platform
 * generators' own class-level scaffolding for a plain boolean flag `noteOnStatement`/
 * `noteOffStatement` already expresses cleanly per instance, at the cost of 4 bytes per PLACED
 * instance (harmless in practice: a graph only ever needs one, and an unwired/unreachable
 * instance gets pruned entirely like any other primitive, per `resolveAudioGraph`'s own "zero
 * codegen when unreachable" rule).
 *
 * Composes directly with the very inlet that motivated it: wiring this straight into an
 * envelope's `trig` reproduces the note-on hook's own retrigger exactly (the rising-edge check
 * already lives inside `ad_env_step`/`ahd_env_step`, not here) -- and through `logue/logic/edge`
 * it becomes a one-shot note-on PULSE for anything else (a percussive click, a counter). No
 * `platforms` restriction: unlike `cutoff`/`resonance`/`param`, both platforms already emit a
 * real, always-present `noteOn`/`noteOff` override on every generated unit regardless of graph
 * content (see `LoguePrimitive.noteOnStatement`'s own doc comment), so there's no
 * platform-specific struct being decoded here at all.
 */
```

### primitives/shared.ts, above `PM_WRAP_HELPER`

```
/**
 * Linear FM -- confirmed with the user as PHASE modulation (what DX7/most digital "FM" synths
 * actually implement), not true frequency modulation: the `fm` inlet's value is added directly
 * to the phase ARGUMENT a waveform generator reads, wrapped back into `[0,1)` by `pm_wrap`. The
 * phase ACCUMULATOR itself (`advanceStatement`, `transposedW0Expr`) is completely untouched --
 * `note_w0`'s own increment stays exactly as before, always non-negative, so none of this
 * codebase's existing "phase only wraps upward" assumptions need to change, for every oscillator
 * except `logue/osc/saw` (see below). True (through-zero) frequency modulation was originally
 * considered and declined here: it would require the phase increment itself to go negative,
 * which the existing `advanceStatement` wrap logic (`if (phase >= 1.f) phase -= 1.f;`, no
 * corresponding downward wrap) doesn't handle -- a real, riskier change across every oscillator
 * for a sound that's musically almost indistinguishable from phase modulation, for a SINE
 * carrier specifically (`sin()` can't tell a reflected phase from an ordinary offset).
 *
 * **Revisited for `logue/osc/saw` only**: unlike a sine, a PolyBLEP waveform's antialiasing
 * genuinely depends on the SIGN of the phase's own instantaneous velocity, so PM and TZFM are NOT
 * musically interchangeable there -- real through-zero character needs the phase increment
 * itself to reverse. `logue/osc/saw` gained a `TZFM` mode-switch param (same on/off convention as
 * `logue/filter/comb`/`logue/filter/svf`'s own `TRACK`, reusing `TRACK_ON_RAW_THRESHOLD`) that
 * redirects the `fm` inlet from this function's phase-offset path into `sawIncrementExpr`'s own
 * accumulator path instead, and gave `advanceStatement`/`polyblep_saw` the bidirectional
 * wrap/signed correction that requires -- see those two symbols' own doc comments. The other 4
 * oscillators are deliberately UNCHANGED: sine's own carrier makes the distinction moot (above),
 * and square/pulse/triangle would each need their own multi-edge-aware BLEP correction redone the
 * same way saw's was -- real, separate future work, not attempted this phase.
 *
 * `pm_wrap` is a plain `while`-loop wrap, not a single conditional -- `FM_DEPTH_PARAM`'s own
 * range (0..2.0 cycle-normalized, see its own doc comment) means the wired term can overshoot
 * `[0,1)` by more than one full cycle, so a single up/down conditional (the shape
 * `advanceStatement`'s own wrap already uses for every non-TZFM oscillator) isn't always
 * enough; the loop is exact for any magnitude and costs at most a few iterations in practice
 * given that capped depth range.
 */
```

### primitives/shared.ts, above `POLYBLEP_SAW_HELPER`

```
/**
 * `dt` doubles as a SIGNED instantaneous phase velocity for `logue/osc/saw`'s own TZFM mode
 * (`sawIncrementExpr`, the only caller). A non-negative `dt <= 0.5` (every pre-TZFM case in
 * practice, and every TZFM-off/fm-unwired saw instance) makes `width`/`sign` reduce to `dt`/`1.f`
 * exactly, so this is byte-identical in effect to the original `(2*phase-1) -
 * polyblep(phase, dt)` formula in that range. The sign flip itself is NOT a different correction
 * shape -- a saw has exactly one edge per cycle, at the `phase==0/1` wrap, so traversing it
 * backward is the SAME jump seen from the other side, mirrored.
 *
 * The `width > 0.5f` clamp guards a real, SEVERE failure mode, not a stylistic guard: `polyblep`
 * corrects two windows, `[0,dt)` and `[1-dt,1)`, and once `dt > 0.5` those windows overlap, so
 * EVERY sample gets corrected rather than just the ones near the true edge -- confirmed via a
 * synthetic sweep of this exact formula (an UNCLAMPED `dt` of `0.7`/`1.0`/`1.3` each produced a
 * wildly different, uncontrolled peak, vs. a stable ~0.24 for all three once clamped). This is
 * not TZFM-specific -- `dt` could already exceed `0.5` from plain pitch alone very near the top
 * of the MIDI range, a pre-existing latent gap this clamp also closes, not introduces.
 *
 * Separately -- and this is NOT what the clamp above fixes -- this correction's own peak
 * amplitude tapers CONTINUOUSLY as `dt` grows, well before `0.5`: the same sweep measured
 * `dt=0.01 -> 0.98`, `dt=0.1 -> 0.80`, `dt=0.26 -> 0.545` (exactly matching `logue/osc/saw`'s own
 * PRE-EXISTING plain-pitch behavior at MIDI note 127, unrelated to TZFM or this phase's change at
 * all -- this two-segment PolyBLEP has always behaved this way). TZFM's only real effect on this
 * is reachability: a `dt` region that used to require nearly the top of the keyboard is now
 * reachable at ordinary, moderate notes once `TZFM_DEPTH_PER_PERCENT` multiplies `w0` by several
 * times. A real, audible, disclosed character of this mode at high `FM_DEPTH`/high notes -- not a
 * defect, and not something this phase attempts to fix (that would mean redesigning `polyblep`
 * itself for the whole registry, real separate future work).
 */
```

### primitives/shared.ts, above `NOISE_STEP_HELPER`

```
/**
 * A plain LCG (linear congruential generator) white noise source -- phase 15, a genuinely
 * different flavor of signal this registry had nothing like before (every oscillator tracks the
 * played note; this doesn't). Grouped under `osc` (`logue/osc/noise`) -- phase 15 originally
 * gave it its own `noise` category on the "structurally unrelated" reasoning that also split
 * `shape`/`filter` apart, but phase 17 deliberately narrowed that: the user asked to constrain
 * the category COUNT itself (fewer top-level palette groups), overriding "structurally
 * different" as the sole criterion -- a zero-input signal SOURCE, pitched or not, reads as "an
 * oscillator" to a user browsing the palette, which matters more here than the internal fact
 * that it shares none of the real oscillators' pitch/phase machinery (no `COARSE`/`FINE`, no
 * `pitch`/`fm` inlets, nothing to transpose -- still true, just no longer the deciding factor
 * for where it lives in the palette).
 *
 * Classic Numerical-Recipes LCG constants (`* 1664525u + 1013904223u`), no libm, one `uint32_t`
 * of state -- the raw 32-bit result is reinterpreted as signed and scaled to roughly `[-1,1)`.
 * The seed-advance-and-return-the-new-sample happens INSIDE `noise_step` itself, called from
 * `renderExpr`, with `advanceStatement` a real no-op -- same shape as `onepole_step`/
 * `ad_env_step` (the filter's and envelope's own state-update helpers): this primitive has no
 * independently-advanceable state the way an oscillator's phase is, just a value that mutates
 * itself every time it's read.
 *
 * No inlets, no params: unlike `WIDTH`/`RATE`/`DRIVE`, there's no natural per-instance control
 * to expose here (white noise IS white noise) or to wire a modulation source into -- wiring
 * this into `logue/gain/vca`'s own `gain`/`GAIN` already covers "control this source's level,"
 * no second mechanism needed.
 */
```

### logue-codegen/src/minilogue-xd/generateOscUnit.ts, above `LogueOldGenOscUnitMeta (file header)`

```
/**
 * A real `PatchDocument` -> real, buildable minilogue xd
 * oscillator unit source. Graph validation and param-exposure binding are shared with
 * `nts1mkii/generateOscUnit.ts` (`../oscInstances.ts`/`../oscParams.ts`/`../oscBody.ts`).
 *
 * **The DSP primitives themselves need zero platform-specific code** -- verified against the
 * real official `waves.cpp`/`waves.hpp` minilogue xd reference example: it computes everything
 * (phase accumulators, mixing, filtering) in plain `float` and calls `f32_to_q31()` exactly
 * once, at the render loop's final output line. Q31 is this platform's OUTPUT BUFFER format,
 * not a computation domain -- see `../primitives.ts`'s doc comment. So this file's only real
 * job is the outer shell: old-gen's `userosc.h` entry points (`OSC_INIT`/`OSC_CYCLE`/
 * `OSC_PARAM`/...) are a fundamentally different, older shape than new-gen's `unit.h`
 * callbacks -- a plain struct + free functions, not a `Processor`-derived class -- and
 * packaging is `manifest.json` (a plain JSON array) instead of a `unit_header_t` C struct.
 *
 * **Param VALUE RANGE is also not fully platform-agnostic, found via a real hardware failure**
 * (2026-09-16: Korg Librarian rejected a generated `.mnlgxdunit` with a param declared
 * `min:0, max:1023` -- "Could not parse user unit manifest data" -- while the zero-param
 * sibling loaded fine). Every real param row in the official `waves.json` example stays within
 * +/-100; `logue/osc/pulse`'s WIDTH spec was fixed to declare `0-100` (a plain percent,
 * `value * 0.01f`) instead of copying new-gen's 0-1023 A/B-knob convention. That formula also
 * happens to need no platform-specific macro at all (the previous 0-1023 version needed a
 * `param_10bit_to_f32`/`param_val_to_f32` naming alias between generations, removed along with
 * the bug) -- if a FUTURE primitive genuinely needs the full 0-1023 resolution on this
 * platform, re-add that alias then; don't reintroduce it speculatively.
 */
```

### logue-codegen/src/nts1mkii/generateOscUnit.ts, above `reserveFixedKnobSlots`

```
/**
 * `logue/sense/shape` reads `shape01_`, which only ever
 * updates if `shapeParam01_` (the static knob half) is fed by a real exposed param at slot 0
 * (`SHAPE_PARAM_INDEX`/`SHAPE_PARAM_NAME`, see this file's own top-of-file doc comment). Without
 * this, `shape01_` would be permanently stuck combining `setShapeLfo`'s own contribution with a
 * `shapeParam01_` that never leaves its init default of 0 -- a real, silent, easy-to-miss half-
 * implemented sense value, not an error a user could otherwise trace back to a missing manifest
 * row.
 *
 * **Post-ship correction (phase 30)**: the original version of this function reserved slot 0
 * alone, only when `logue/sense/shape` was active. A user loading the resulting unit onto real
 * hardware via Kontrol Editor hit a real "Wrong number of unit params" rejection -- `num_params:
 * 1` turned out to be a configuration no real shipped Korg example ever uses (they all declare
 * slots 0 AND 1 together, never just one), confirming the two fixed knobs must be declared as a
 * pair. Widened to reserve `ALT_SHAPE_PARAM_INDEX` (slot 1) alongside `SHAPE_PARAM_INDEX`
 * whenever `logue/sense/shape` OR `logue/sense/shape-alt` was active.
 *
 * **Second post-ship correction (phase 33)**: STILL gated on `logue/sense/shape(-alt)` being
 * active -- so a graph using NEITHER (e.g. a plain `saw -> comb -> audio-out`, phase 33's own
 * comb redesign work) produced `num_params: 0`, and hit the SAME real "Wrong number of unit
 * params" Kontrol Editor rejection as phase 30's `num_params: 1` case. Re-reading every real
 * shipped example with fresh eyes (the same move phase 32's own pairing-requirement discovery
 * used) shows why: `dummy-osc`/`dummy-modfx`/`waves`/`pluck`/this project's OWN very first
 * hand-written phase-1 proof of concept (`axomodern-poc1`) ALL declare slots 0 and 1
 * UNCONDITIONALLY, regardless of whether the unit's own code reads them (`pluck`'s own header.c
 * literally comments them "Fixed/direct UI parameters -- A knob / B knob", naming them "DAMP"/
 * "DECAY" for ITS OWN purposes, not generic "SHAPE"/"ALT"). The real, confirmed rule these
 * examples establish is broader than phase 30's own finding: NTS-1 mkII always has two physical
 * knobs (A/B, i.e. Shape/Alt-Shape) mapped to param slots 0/1 for WHATEVER oscillator is
 * currently loaded, independent of whether that oscillator's own DSP does anything with them --
 * so every unit must declare both, not just ones that happen to read them via `logue/sense/
 * shape(-alt)`. Every real-hardware-tested NTS-1 mkII build before this phase (30/31/32)
 * happened to include a `sense/shape` node, which coincidentally triggered the old conditional
 * reservation -- masking this gap until a sense-free patch was actually uploaded for the first
 * time. Fixed by reserving both slots UNCONDITIONALLY for every NTS-1 mkII build, matching
 * `dummy-osc`/`pluck`'s own unconditional convention exactly -- `logue/sense/shape`/`shape-alt`
 * being active no longer changes whether the slots are reserved (only that they're read), so the
 * `needsShapeKnobs` check that used to gate this whole function is gone.
 *
 * Slot 1's own `setStatement` always writes `shape2_01_` rather than discarding the value --
 * unconditional and harmless when `sense/shape-2` isn't placed (same "always written, sometimes
 * unread" precedent `shapeParam01_`/`note01_` already established), genuinely read when it is.
 *
 * Whether real NTS-1 mkII firmware would call `setParameter(0/1, ...)` for a physical knob turn
 * on a unit that never reads either value remains unverified: neither the public SDK nor `websim`
 * can answer it -- but reserving both slots is now confirmed NECESSARY on every unit, not just
 * ones using `logue/sense/shape(-alt)`, by the Kontrol Editor rejection above.
 *
 * `logue/sense/shape-alt` above is a dated record of what slot 1's own reader primitive was
 * called at the time of phases 30-33 -- it was merged into `logue/sense/shape-2`
 * (see `primitives.ts`'s own doc comment), a single id valid on both platforms. Nothing in this
 * function's own logic changed for that merge -- slot
 * 1 is still reserved unconditionally, still writes the same member (renamed `shape2_01_`).
 */
```

### logue-codegen/src/paramDeviceType.ts, above `ParamDeviceType`

```
/**
 * Which params' raw values are safe to expose through NTS-1 mkII's own richer on-device unit
 * label -- verified against the real *logue SDK (a local `logue-sdk` checkout, not assumed):
 * `unit_param_t` (`platform/common/runtime_common.h`) has a real `type` enum
 * (`k_unit_param_type_percent/db/cents/semi/hertz/msec/onoff/...`) plus `frac`/`frac_mode` for
 * decimal scaling -- but the actual on-device/websim rendering (`getParameterValueString`, byte-
 * identical boilerplate copied across every real example project's own `wasm.cc`, including an
 * `osc`-module one) only ever computes `raw_value / 2^frac` (fixed) or `raw_value / 10^frac`
 * (decimal), then appends a fixed unit suffix. It's a PLAIN LINEAR SCALE of the raw stored
 * integer -- there is no curve support at all.
 *
 * This means only a param whose raw value ALREADY equals its real-world unit with no scale or
 * offset at all (so `frac`/`frac_mode` both stay 0, exactly like every param this codebase emits
 * today) should get a `PrimitiveParamSpec.nts1mkiiType`. Same reasoning as `@logue-codegen/paramUnits`'s own "cheap, not
 * scientifically-tuned" exclusions, one level further down: correct on the SCREEN doesn't yet
 * mean correct on the DEVICE'S own scale.
 *
 * Every other unit `@logue-codegen/paramUnits` knows how to DISPLAY in the app -- LFO `RATE` in
 * Hz, envelope `ATTACK`/`DECAY` in ms, `GAIN`/`DRIVE` in dB, comb `CUTOFF` in ms -- was evaluated
 * for the SAME on-device treatment and DECLINED, permanently, not left as a TODO:
 * - Comb's `CUTOFF` is a hard exclusion regardless of any other consideration: it's only
 *   ms-meaningful while `TRACK==0` (`@logue-codegen/paramTrackGate`), and the manifest has
 *   exactly one static `type` per param -- it cannot conditionally mean "ms sometimes,
 *   meaningless the rest of the time" the way the DSP itself does.
 * - `GAIN`/`DRIVE` -> dB would need the RAW value to directly store dB (the device's own
 *   rendering is a linear scale, and dB is `20*log10(gain)`, genuinely logarithmic) -- meaning
 *   the DSP itself would need to convert back to linear gain via a real `exp10f`/`powf` call,
 *   every sample, for every active instance. This file's own math has a consistently-stated
 *   "no libm for code-size" rule (`env_rate_from_percent`'s own doc comment cites the 32KB
 *   budget), with exactly one disclosed exception (`svfFilterPrimitive`'s own `tanf`, justified
 *   by a specific user ask for exact pitch-tracked resonance) -- there's no equivalent ask here,
 *   so the trade isn't worth it just to make the device's own menu read "-6.0 dB" instead of "62".
 * - `RATE`/`ATTACK`/`DECAY` are the only params where the underlying math (a cubic Hz curve, an
 *   affine `ms = 5 + t*1995`) is at least not logarithmic -- yet even for these, re-basing the raw domain to
 *   literally store Hz/ms would (a) silently change the MEANING of every already-authored
 *   document's own value for that param (today's raw `50` means "10.05 Hz"; under a re-based
 *   scheme "50" would mean "0.5 Hz" instead) with no migration path attempted, and (b) break this
 *   registry's own deliberately-uniform "additive, +-50 percentage points of the param's own
 *   0-100 range, clamped" wired-inlet-modulation shape (`RATE_INLET_DEPTH`/`ATTACK_INLET_DEPTH`/
 *   `DECAY_INLET_DEPTH` and every sibling percent-domain inlet in this file use that SAME shape)
 *   for just these three params, while the REAL problem -- a friendly display -- is already fully
 *   solved in-app by `@logue-codegen/paramUnits`, independent of what's stored on-device. Declined
 *   for the same reason as the two above: a real, permanent cost for a benefit that only matters
 *   when reading the raw menu off the physical device with the app closed.
 *
 * minilogue xd has no per-param type -- see `resolveMinilogueXdDeviceParam` below, a general rule
 * plus a short list of discrete selects, since its own manifest schema has only two types.
 */
```

### logue-codegen/src/primitives.ts, above `the barrel export (file header)`

```
/**
 * Growing library of logue-target DSP primitives. A primitive is no
 * longer necessarily a zero-input source: `inlets` (see `PrimitiveInletSpec`) lets one
 * primitive's `renderExpr` read another active instance's own computed value, resolved by
 * `oscInstances.ts`'s `resolveAudioGraph` from real `doc.nets` wiring -- e.g. `logue/mix/mix2`
 * sums two upstream instances rather than contributing its own independent term.
 *

 * **Platform-agnostic, verified 2026-09-16 against the real `korginc/logue-sdk` reference
 * examples, not assumed**: the official minilogue xd `waves.cpp`/`waves.hpp` example does ALL
 * its internal DSP math in plain `float` (phase accumulators, mixing, filtering) and calls
 * `f32_to_q31()` exactly once, at the render loop's final output line, converting the finished
 * sample right before writing it to the `int32_t*` buffer the old-gen runtime expects -- Q31
 * is a boundary/output-format convention there, not a computation domain. `osc_sinf`,
 * `clip1m1f`, `osc_w0f_for_note`, and the 10-bit param-to-float conversion are all identical
 * (same signatures, same float domain) between minilogue xd's `osc_api.h` and NTS-1 mkII's.
 * So every primitive here is genuinely shared across both platforms' oscillator generators
 * (`nts1mkii/generateOscUnit.ts`, `minilogue-xd/generateOscUnit.ts`) with zero duplication --
 * each platform's own generator differs only in its outer shell (entry-point boilerplate,
 * packaging, and the one `f32_to_q31()` cast at the output write), not in DSP math. This is
 * exactly why an earlier "should we build a float/fixed-point IR"
 * question resolved to "no, and it turns out the problem it would have solved doesn't exist."
 *
 * A primitive owns exactly the per-instance state + per-sample expression needed inside the
 * generated `Osc::process()` loop. Unlike Axoloti's `.axo` code-block splicing
 * (`instanceBodyCodegen.ts`), there is no `code.krate`/`code.srate` text-substitution
 * convention to reuse here -- logue-sdk's own runtime model has nothing resembling `PExch`/
 * `inlet_X` naming, so each primitive is plain generated C++ against `osc_api.h`'s
 * `osc_sinf`/`clip1m1f` helpers (verified working in phase 1's hand-written
 * `axomodern-poc1` unit, both in `websim` and on real NTS-1 mkII hardware).
 */
```

### logue-codegen/src/primitives/registry.ts, above `RENAMED_PRIMITIVE_IDS`

```
/**
 * Every whole-primitive id rename/merge this registry has ever shipped, old id -> current id --
 * the id-level counterpart to a primitive's own `renamedParams`/`renamedInlets` (see `FieldAlias`'s
 * doc comment for the shared rationale). Added 2026-09-21 after a real, twice-repeated incident:
 * `logue/sense/shift-shape`/`logue/sense/shape-alt` merged into `logue/sense/shape-2` (phase 9)
 * with no migration, and a user's own `formant.loguepatch`/`comb.loguepatch` files, authored
 * before that merge, silently stopped resolving (`findLoguePrimitive` returned `undefined`,
 * `ports.ts` quietly fell back to wiring-inferred ports with no indication anything was wrong).
 * Every entry here is a PURE id rename -- the primitive's own behavior for a given set of
 * param/inlet values is unchanged, only its `id` string moved -- so, unlike `FieldAlias`, there is
 * no `valuePreserving` distinction to make: resolving through this table is always safe. A rename
 * that also changed what the primitive's OWN fields mean (comb's phase 33 redesign, which reused
 * the SAME id `logue/filter/comb` rather than picking a new one) is instead recorded as
 * `FieldAlias` entries on that primitive itself.
 *
 * `logue/delay/comb` maps to `logue/filter/comb` -- the phase-17 category-only rename -- even
 * though a `.loguepatch` file old enough to carry that id would almost certainly ALSO carry the
 * pre-phase-33 `FEEDBACK`/`DELAY` param names; both alias layers resolve against the same
 * canonical id, so they compose correctly without this table needing to know that.
 *
 * `logue/util/invert`/`logue/util/curve` map to `logue/math/invert`/`logue/math/curve` (2026-09-25)
 * -- the same shape of category-only rename, this time reclassifying two `util` primitives into
 * `math` (arithmetic/reshaping, a closer conceptual fit than a domain-conversion utility).
 * `logue/util/glide` deliberately stays put -- not every `util` primitive that COULD be argued
 * into `math` gets moved, only the two this rename was actually asked for.
 *
 * `logue/mix/ringmod` maps to `logue/math/multiply` (2026-09-27) -- a name as well as category
 * change, but the same byte-identical-codegen kind (see `multiplyPrimitive`).
 *
 * `logue/lfo/sample-hold` -> `logue/lfo/random-steps` and `logue/util/trig-hold` ->
 * `logue/util/sample-hold` (2026-09-28): the name "sample-hold" moves to the node that actually
 * samples on a trigger; the clocked one is a random LFO. Old files stay unambiguous because the
 * category differs (`lfo` vs `util`).
 */
```

### src/renderer/src/canvas/Inspector.tsx, above `ParamRow (Inspector file doc)`

```
/**
 * A selected node's editable properties -- a Name field, its Type label, and one row per param a
 * resolved *logue primitive declares. Still no
 * attrib/display editor of any kind -- there's no scanned library/widget system left to expose
 * metadata for, and no primitive has a display yet. The Type label
 * itself drops a `logue/` id's own root segment when displaying it (matching ObjectNode.tsx's
 * canvas titlebar convention, `stripLoguePrefix`) -- the full id is still one hover away via the
 * element's own `title`.
 *
 * The panel's own bottom-most element, when the selected primitive has one, is a brief read-only
 * `LoguePrimitive.description` blurb -- plain-language, user-facing help text (not this file's
 * own internal doc-comment style) explaining what the primitive actually does, since this
 * registry has grown well past what a user could reasonably be expected to already know by name
 * alone. `logue/io/audio-out` has no registry entry of its own to carry one (see
 * `LOGUE_AUDIO_OUT_DESCRIPTION`'s own doc comment in oscInstances.ts), so it's special-cased here.
 *

 * The Param # dropdown itself (a single-platform
 * editor, bound to the since-removed toolbar toggle) was removed here in favor of
 * `ParamMatrixOverlay.tsx` alone: a button next to each param's value opens that overlay focused
 * on this param, same destination the row's own right-click menu already opened. Editing a slot
 * in exactly one place (across both platforms at once) beats maintaining two editors that could
 * show a momentarily different answer depending on which platform was toggled at the time. Phase
 * 7 moved a `freeLabel` param's own device menu name (`ParamValue.label`) the same way -- the
 * separate "Label" field that used to live here is gone; the matrix's own Param column is now
 * the one place both a param's slot AND its label (when it has one) are edited. Phase 8 removed
 * the toggle itself -- this row's own matrix button no longer has a "currently viewed platform"
 * to key its tooltip off of at all; `describeExposedSlots` (`exposedLogueParams.ts`) lists
 * whichever platform(s) actually have a slot instead.
 */
```

### src/renderer/src/canvas/ParamDial.tsx, above `ParamDial`

```
/**
 * A live, on-canvas dial for one `PrimitiveParamSpec` -- the graph-node equivalent of
 * Inspector.tsx's `ParamRow`, matching the real Axoloti graph's own on-canvas knobs (see the
 * deleted `widgets/Knob.tsx`, still readable at git commit 3dc81d2 as a reference) rather than
 * leaving param editing Inspector-only. No unit converters/typed-value-buffer parsing survive
 * from that original: a `PrimitiveParamSpec` is always a plain `min..max` number with no
 * real-world unit tag (no Hz/ms/dB conversion table exists for it), so this dial only ever
 * shows/edits that raw number -- double-click the value to type one directly, drag the dial
 * (vertical, Shift/Ctrl/Cmd for fine adjustment) or use arrow keys otherwise.
 *
 * Reads its value straight off the live store rather than the React Flow node's own mount-time
 * `data` snapshot, because `setLogueParam` deliberately never bumps `reloadNonce` (see
 * patchStore.ts's own doc comment on that action) -- the same reason the old `paramController
 * .ts`'s `useParamValue` existed. `logueParamIndex` (the FULL per-platform slot map)
 * is read the same way and passed straight through, UNCHANGED,
 * on every commit so dragging/typing a value here never clobbers whatever slot either platform's
 * own `ParamMatrixOverlay.tsx` row already assigned this param -- `SlotBadges` below renders one
 * small tag per platform that actually has a slot (there's no single "currently viewed platform"
 * to resolve it down to any more).
 *
 * `data-param-name` on this widget's own root div is
 * what lets `PatchCanvas.tsx`'s single delegated `onContextMenu` handler recognize "the user
 * right-clicked THIS param" (vs. the whole node) and offer "Configure in Param Matrix..." --
 * see that handler's own doc comment.
 */
```

### src/renderer/src/canvas/autoArrange.ts, above `MIN_NODE_WIDTH (autoArrangeNodes module doc)`

```
/**
 * Rearranges a document's nodes to fix overlap from a legacy Axoloti `.axp`'s original tiny
 * node footprint (Swing frames as small as 60x40px on a 14px grid) not matching this app's
 * much larger rendered node size (CSS .patch-node min-width 140px plus port/param rows).
 * Deliberately NOT a topological/dependency layout, and deliberately preserves each node's
 * (y, x) rank exactly (see `comparePosition`/`verifyOrderPreserved` below) -- a holdover
 * from when that rank fed Axoloti codegen's execution order; no current codegen path
 * (logue-codegen resolves its audio graph from nets, not node position) reads it, but
 * preserving it costs nothing here (the remap below is order-preserving by construction)
 * and there's no reason to loosen an existing guarantee without a reason to.
 *
 * Also deliberately NOT a grid repack: the previous implementation bucketed nodes into
 * rows and packed each row left-to-right from a (0,0) origin, which "fixed" overlap by
 * discarding the original layout's shape entirely. Instead, each axis independently gets
 * a monotone remap of its distinct old coordinate values -- old_a < old_b implies
 * new_a < new_b, and old ties stay tied -- which by itself already guarantees
 * `comparePosition` rank survives untouched, before `verifyOrderPreserved` ever checks
 * it. On top of that, a level's new coordinate is `max(originalGapToPrevious,
 * requiredGapForAnyRealCollision)`, so a gap that was already big enough is left
 * completely alone (running this twice is a no-op) and the layout only grows where two
 * boxes actually would have overlapped. An AABB collision needs separating on only one
 * axis, so the x-sweep runs first and the y-sweep only touches whatever pairs it didn't
 * resolve (same x-level, e.g. a vertical stack, can't be separated by an x-only remap).
 * Exactly-coincident nodes (same x and y -- copy/paste, real patches) share both axes'
 * "level" and so can't be separated by either sweep; `separateCoincidentPositions`
 * nudges them apart by a sub-pixel cascade (rounded away in the final output, its only
 * purpose is to give the y-sweep distinct levels to work with) before the sweeps run.
 *
 * A raw per-distinct-x-value sweep has a real failure mode: a visual "column" -- several
 * nodes whose original x already puts them roughly in the same vertical lane, e.g. a
 * signal chain rendered top-to-bottom -- rarely shares one EXACT x value (manual dragging
 * scatters it by 10-60px). The forward x-sweep cascades a push through every x-level
 * above the collision point, so whichever column member happens to sit just below the
 * push threshold gets left behind while its column-mates move on -- this is exactly what
 * produced the reported bug (a real patch's 4-voice resonator chain: each voice's
 * `dial`/`*`/`resobp` trio scattered a straddling push, e.g. `resobp_2`/`*_2` moving right
 * while `dial_2` stayed put, introducing a wide gap between nodes meant to render one
 * above the other). `clusterColumns` fixes this by pre-snapping every column's members to
 * one shared x (single-link clustering on original x, scanned ascending) before the
 * x-sweep runs, so a later required push moves the whole column as a unit. Snapped
 * column-mates then rely on the y-sweep (never the x-sweep) to separate them if they're
 * still too close vertically -- which is the correct axis for two nodes that are supposed
 * to be visually stacked in the same column.
 */
```

### src/renderer/src/state/patchStore.ts, above `replaceNode`

```
  /**
   * Swaps a placed *logue primitive instance's own `type` for a different primitive's, in place
   * -- backs the canvas node context menu's "Replace with..." item (e.g. swapping a `saw` for a
   * `triangle`, or an `ad` envelope for an `ahd`). Deliberately keeps the node's `name`/position
   * unchanged: a net addresses its endpoints by node NAME (see `nodeId.ts`), never by `type`, so
   * every net that references this instance by name stays wired with zero rewriting -- the one
   * property that makes this action tractable at all (the alternative, renaming to something
   * `type`-derived, would force exactly the net-reference rewrite `renameNode` already does, for
   * no benefit here).
   *
   * Only ever reads the NEW primitive's own `params`/`inlets`/`outlets` specs -- never the old
   * primitive's (which may not even resolve, e.g. a legacy Axoloti object reference; replacing
   * one of those into a real *logue primitive works exactly the same way as replacing between
   * two resolved primitives). Params are rebuilt by walking the new primitive's own `params`
   * spec array and matching each one against the node's EXISTING `params` by `name` (same
   * `spec.name` <-> `ParamValue.name` idiom `listExposedLogueParams`/`Inspector.tsx` already use)
   * -- a match carries over `value` (clamped into the new spec's own `[min,max]`, since two
   * different primitives' same-named params can have different ranges, e.g. `logue/sense/param`'s
   * `VALUE` is `0..100` but `logue/util/constant`'s is `-100..100`) plus `logueParamIndex`/
   * `label` untouched; no match creates a fresh entry at the spec's own default (auto-exposing a
   * `freeLabel` param to the next open slot, same as `insertSpecialObject`). A param with NO
   * match in the new spec is simply never carried forward -- its slot (if any) is released for
   * real, since `listExposedLogueParams` only ever walks a primitive's OWN declared specs (a
   * stale `ParamValue` left dangling in `node.params` with its old `logueParamIndex` intact would
   * be invisible to that scan and could silently collide with a different param claiming the same
   * slot later). On minilogue xd this can leave `requireContiguousIndices`' own contiguity
   * requirement violated (e.g. dropping a param that was exposed at slot 2 while 0/1/3 stay
   * taken) -- a deliberate, accepted tradeoff rather than auto-compacting behind the user's back;
   * `ParamMatrixOverlay.tsx` already renders every param's own slot per platform (or "--") so the
   * gap is visible and fixable with its own reorder controls, and export would reject it with a
   * real error rather than silently miscompiling.
   *
   * Inlet/outlet references in `nets` are remapped by EXACT NAME ONLY, never role/position --
   * every family the "Replace with..." feature actually targets (the 5 oscillators, the 6 LFO
   * shapes, `ad`/`ahd`) already shares identical inlet names by construction (`pitch`/`fm`/
   * `fmDepth`, `rate`, `attack`/`decay` respectively), so exact-name matching alone already
   * covers the real use case with zero risk. A role/position fallback was deliberately rejected:
   * it would confidently mis-wire unrelated pairs (e.g. `ad`'s `attack` onto `sine-lfo`'s `rate`,
   * both single control-role inlets) instead of leaving an honestly "invalid"/dashed edge the
   * user can see and reconnect -- this project's whole disclosure ethos (see CLAUDE.md) favors
   * the latter. The one exception is outlets: since every primitive but `svf` has exactly one
   * (implicit `out` when undeclared), an old outlet name absent from the new primitive's own
   * outlet list remaps to its FIRST declared outlet -- unambiguous when there's only one, and a
   * one-line, user-reversible guess when there are several (e.g. replacing an `svf` down to a
   * single-outlet primitive, or a single-outlet primitive up to `svf`). An inlet with no exact
   * name match is left exactly as it was (not pruned) -- `toFlowGraph.ts`'s existing
   * `data.invalid` dashed-edge rendering already handles a net endpoint naming a nonexistent
   * port, so an unmatched inlet stays visible and reconnectable rather than silently vanishing.
   *
   * No-op for a non-`obj` node, an unresolvable target id, an unresolvable `newType`, a `newType`
   * identical to the node's current `type`, or the fixed `logue/io/audio-out` sink (its shape is
   * hardcoded outside the primitive registry -- see `ports.ts` -- and the audio graph assumes
   * exactly one).
   */
```


### primitives/osc.ts, above `EXCITER_SUSTAIN_LEVEL_DROP` (0.65 -> 0.9 on 2026-09-28)

```
// Real, user-reported miss (2026-09-26), a THIRD round on the exciter's overall energy: "the
// exciter is coming in too hot" -- still present after PINK_NOISE_GAIN_COMPENSATION fixed the
// noise-color RMS mismatch, because that fix addressed a different lever entirely (the color's
// own average power) from this one (the envelope's own held level). At high BOW, heldDecayRate
// approaches 0 (see its own doc comment) so `*level` pins at its peak (`strikeGain`, up to 1.0)
// and STAYS there for as long as the note is held -- a continuous, near-full-amplitude feed into
// a resonant loop, structurally different from a decaying pluck's bounded, one-shot energy
// injection. A resonant delay loop fed CONTINUOUS energy builds toward a steady-state amplitude
// that grows sharply as the loop's own per-cycle retention approaches 1 (a real, order-of-
// magnitude estimate from the loop's own feedback-gain arithmetic, not just a feeling) -- exactly
// the "bow into a long-DECAY string" patch a user would actually build. Fixed by scaling the
// FINAL output by the SAME `warmth` value already driving tone/noise-color: the initial transient
// (`warmth=0`) is completely untouched (no regression to the already-tuned pluck), while the
// continuously-held portion tapers down as `BOW`/the strike train pushes toward sustained
// territory, tamed at the SOURCE rather than by asking the string's own DECAY to do less. Real,
// disclosed ear-tune starting point, not measured against real hardware yet -- unlike the pink-
// noise gain fix, no closed-form "correct" attenuation exists here (it depends on the DOWNSTREAM
// resonator's own DECAY/GAIN, which this primitive has no visibility into), so this is a
// reasonable first cut, not a verified-correct one.
const EXCITER_SUSTAIN_LEVEL_DROP = 0.65
```


### `logue/osc/bass-support` (2026-09-29)

Requested as a "bass support" oscillator: every note restricted to two very low octaves, a deep
saturated tone under the Korg's own oscillators and filter. The user chose WRAP and FOLLOW
modes, a fixed two-octave span, and SUB plus GLIDE included.

- Folding was first sketched as re-folding the live note every block. A review before writing
  caught that the per-block pitch already carries bend (and the xd's portamento), so a bend
  across the window edge would have dropped two octaves mid-note. Hence the latched per-note
  SHIFT, and the pending flag set in noteOn, which can't see the new note on either platform.
- The drive stage started as a Pade tanh, `x(27+x^2)/(27+9x^2)`. Emulator 329 cycles base; the
  divide alone was ~20. Swapped for the cubic `x - 4x^3/27` (clamped at 1.5), and SHAPE snaps to
  a pure wave within 2% of a corner, so the defaults render one wave: 264 above baseline.
- Output gain: at x1 the worst harness corner (square, full sub, DRIVE 0, TONE 100) peaked at
  1.82, from the Q~1 lowpass ringing on the square/sub edges; 0.52 keeps it at ~0.95.
- DC blocker: `dc_blocker_step`'s R=0.995 is a ~38 Hz corner, which would have cut the C1 window's
  fundamental, so this one uses 0.9997 (~2 Hz).

### Device controls: knob bindings, followers, `sense/control` (2026-09-29)

Started as "can the Shape knobs drive dials that have no inlet?" and was generalized at the
user's request into one model: every param can have one device control per platform -- a menu
slot, a fixed knob (Shape, the second Shape knob, the xd's filter Cutoff/Resonance), or following
another param's slot -- and one `sense/control` node turns any of them into a signal.

- Phase 1 (codegen): knob-bound params are set at the start of every block from the knob's
  position member, not in `OSC_PARAM`/`setParameter`, so Shape includes the device's Mod-LFO like
  `sense/shape` did. Followers were given their own field (`logueFollow`) instead of allowing a
  duplicate `logueParamIndex`, so the lead is always the one owner of the slot.
- Phase 2: `sense/shape`/`shape-2`/`cutoff`/`resonance`/`param` became one `sense/control`, kept
  in `sense` because a new category would reflow every palette colour. `sense/param` had been
  xd-only for no technical reason. The old primitives stay (superseded, hidden) so unopened
  library definitions still build byte-identically. A review caught that the migration made the
  "slot + knob on one param" build error reachable from every old patch through a plain Matrix
  edit; taking a slot now ends the other binding.
- Phase 3 (UI): a follower is stored by slot number but the Matrix edits it by its lead's
  identity, so it moves with the lead on a reorder; a review caught that deleting a lead left
  followers pointing at nothing (Export failed, and they were invisible in the Matrix), hence
  `dropOrphanedFollows`.
- Auto-exposure on placement (inherited from `sense/param`) was dropped by the user's call once
  `sense/control` ran on both platforms: it took a menu slot on both and made Export fail until
  the control was named.
- Hardware (user, 2026-09-29): a `KnobTest` unit per device -- a `sense/control` on Shape into an
  svf cutoff, the saw's COARSE bound to the second knob, FINE following a menu RESONANCE -- reacted
  as expected on a real minilogue xd and a real NTS-1 mkII. That also settled the long-open
  question whether the NTS-1 mkII firmware calls `setParameter(0/1)` on a knob turn (it does), and
  showed a non-zero `init` on its SHPE/ALT rows loads fine.

### Code size in the RAM estimate (2026-09-30)

- Deferred since 2026-09-18 for want of calibration data (the builds on record were whole-graph
  totals). The xd effects made it urgent: code shares a modfx's 6 KB, and the auto-wah example's
  gauge read 8% (state only) while the built unit used 90%. The user asked for the table.
- First model: per primitive, one instance minus a base unit (`first`) and a second minus the
  first (`extra`), all inlets wired. Against whole builds: -7%..+70%. Two causes, found by
  building patches and comparing:
  - shared out-of-line helpers (`note_w0`, polyBLEP, the libm `tanf` chain) were in every
    primitive's `first`: now found per build with `nm` (functions the base unit lacks) and
    counted once per unit (supersaw on the xd: +70% -> +59%);
  - unwired inputs compile much smaller (block constants, folding), and the check patches left
    most inputs free: now also measured with no inlets wired and interpolated by the share wired
    (-> -7%..+23%).
- What's left: GCC inlines a helper while one primitive calls it and shares it once several do,
  so several different polyBLEP oscillators still overcount (+23% on the xd, 580 B of 32 KB).
  Always on the safe side so far; not modelled further.
- The measurement's bss deltas matched every `stateBytesPerInstance`, a free check of the
  hand-counted state.

### `logue/filter/svf`: `svf_tan` instead of libm `tanf` (2026-09-30)

- `tanf` had been the user-requested exception to the "no libm" rule, for exact tracked
  resonance. The code-size table showed its range reduction (`__kernel_rem_pio2f` and friends)
  was ~3.2 KB, so svf alone took ~4.7 KB of a minilogue xd modfx's 6 KB (auto-wah: 90% built).
- formant's Taylor `tan` wasn't enough: svf's tracked argument reaches ~pi/2 (the pitch clip
  just under Nyquist). `svf_tan` is a Padé [5/4] on [0, pi/4], with `tan(x) = 1/tan(pi/2 - x)`
  above: max 2.5e-7 relative error over notes 0-127 in float (0.0003 ct), checked in Python and
  compiled C++. Auto-wah on the xd: 5540 -> 1476 B; xd emulator TRACK+control 276 -> 206.

### The xd's filter knobs never reach an oscillator (2026-09-30)

- `user_osc_param_t.cutoff`/`resonance` are documented as the filter's values (0x0000-0x1fff)
  and were offered as knob bindings (Matrix rows FILTER CUTOFF/RESONANCE, the device-control
  picker) and read by the superseded `sense/cutoff`/`sense/resonance`, none of it hardware-checked.
- Hardware pass (user): a unit with a saw's COARSE on CUTOFF and a square's level on RESONANCE
  played only the square; a single-saw diagnostic (COARSE on CUTOFF, level on RESONANCE) played
  exactly +24 st at full level whatever the knobs did -- both fields read ~1.0, constant.
- User's call: remove them rather than label them. The xd oscillator's `knobs` is Shape/Shift-Shape
  only; an existing binding now fails Export ("names a knob the unit doesn't have"), and the two
  old readers migrate to an unbound control. The superseded primitives keep their codegen, so a
  never-reopened library definition still builds, reading the constant.

### Oscillator hardware pass (2026-09-30)

`scripts/stageOscHardwareUnits.ts` staged one unit per never-heard primitive/feature and
`scripts/uploadTestUnit.ts` uploaded each to both devices' osc slot 1 in turn. All good on both:
sync, bass-support (xd legato and portamento too), formant with CHARACTER (xd at a 668-cycle
estimate), multistage (all modes), util/delay, quantize, fast-square + sample-hold, the 6-frame
additive, the tracked svf with `svf_tan`, a subpatch-built unit, the select/checkbox/semi/cents
displays and the xd's COARSE/FINE offsets, granular and `sense/velocity` (velocity to pitch; the
device scales the level by velocity on its own) on the NTS-1 mkII. Found on the way: `#`
displays as a blank on the NTS-1 mkII (quantize's ROOT now uses flats), and a slot keeps its menu
param values across uploads (a test unit arrived with TRACK on).

### Bode frequency shifter: `filter/hilbert` + `util/freq-shift` (2026-09-30)

- The first effect not built from existing nodes: the existing `filter/allpass` is a Schroeder
  delay-line diffuser, and a Hilbert pair built from sample-delay/multiply/constant would have
  been ~100 nodes with coefficients `constant`'s 0.01 steps can't hold. User's calls: a separate
  reusable `hilbert` node, built-in feedback, SHIFT +-2 kHz to start.
- The pair is Olli Niemitalo's 8-coefficient design. The published values only work squared,
  with the one-sample delay on the chain starting at 0.6923878 (checked in Python before
  writing any C++): unsquared it was ~4 degrees off at 1 kHz and ~11 at 20 kHz, with the delay on
  the other chain 15-30 degrees off at 1 kHz. Double precision: 90 +- 0.7 degrees from ~25 Hz to 23.9 kHz. Float harness:
  q lags i by 90.2-90.7 / 89.3-89.4 degrees at 30 Hz..20 kHz.
- `hilbert_step` is `always_inline` because `freq_shift_step` calls it (the xd's leaf rule);
  z^-2 sections keep even and odd samples apart, so one history slot per signal per parity (21
  floats) is enough and nothing shifts.
- SHIFT is cubic (`2000*s^3` Hz) so the barber-pole range of a few Hz gets real knob travel.
  Feedback is the previous sample's `shifted` through comb's soft knee, only on the fed-back
  term, so MIX 0 stays bit-exact dry.
- The first feedback checks read exactly 1.000 peaks -- the unit's output clip (`clip1m1f`),
  not the knee. Measured behind a 0.25x VCA: at SHIFT 0 (the TIME knob's middle) the pair passes
  DC at +1, so FEEDBACK 100 lifted a 0.1 DC input to 0.84 and 0.5 to 1.5 (the knee's ceiling
  plus the input). Fix: comb's ~1.5 Hz DC blocker (`0.9998`) on the fed-back term. After it,
  0.1 DC settles at 0.10-0.11 (a 0.31 transient at the step), full-scale DC at ~0.53, and
  full-scale noise at FEEDBACK +-100 peaks at ~3.3 (bounded; an effect's input is ~0.18).
- Harness (NTS-1 mkII, exact `sinf` as the carrier): other sideband -49 dB at 1 kHz +-100 Hz,
  -50 at 440 +7, -47 at 5 kHz +1.5 kHz, -48 / -44 / -37 dB for 50 / 30 / 20 Hz inputs. The
  outlet can't be `out` (a multi-outlet primitive's `out` is read as the single-outlet case),
  hence `shifted`. The first measurement of the 440 +7 case read the input tone at -59 dB, which
  was Hann-window leakage from the line 7 Hz away; with Blackman-Harris it measured -83 dB.
- Sizes: an NTS-1 mkII modfx with one shifter is 5.6 KB (the fixed shell is ~4.2 KB); an xd
  modfx 1.6 KB of its 6 KB; the stereo example is 1740 B text / 260 B bss on the xd (the RAM
  estimate said ~1.9 KB in all), with only `freq_shift_step` (x2) and the tempo read below
  `Fx::process`. xd emulator: hilbert 105 cycles, freq-shift 285 (322 with control inputs
  wired). No hardware pass yet.

### Arrange by signal flow (2026-10-01)

The user asked for a graph-based arrange after grain-mill's canvas was tidied by hand (input and
buffer, clock, motion and envelope as bands left of a row of voices, feedback above the output).
`flowLayout.ts` grew in four rounds, each checked on grain-mill in the built app:
- Breaking loops at `delayedInlets` was rejected before writing it: `util/buffer`'s `in` is
  delayed but is grain-mill's main forward path. The DFS that finds feedback first started at the
  first source by canvas position (the FREE clock LFO) and cut the loop between buffer and voice 1;
  starting at `audio-in`/inlet ports cuts it at `fb-sat -> in+fb`, as by hand.
- Ordering columns by the walk back from the outputs, then barycenter crossing sweeps: crossings
  116 -> 97 (nearly all among the voice fan-outs), but the sweeps interleaved the env chain with
  the motion LFOs. Dropped.
- Walk order plus wire-pull placement (weighted median, isotonic fit per column): bands per column
  were right, but chains drifted into each other's columns and the voice row climbed.
- Tree layout with rigid bands slid up by per-column contours (the current one). Aligning a node
  by ports instead of top edges made the voices climb 42 px each (`l` is above `bus-l`); a voice
  fed twice by its neighbour (bus L and R) was first placed twice.
Comments first went in before the final spread and one wide comment pushed 35 nodes 32 px right;
they are now placed after it, at the nearest free spot that isn't within `autoArrange.ts`'s 50 px
column snap. An unwired port node in a definition would have fallen into the unwired row and
moved to the end of every instance's port list, so port nodes always take part.

### reverse-tap and the reverse-wash examples (2026-10-01)

A stereo reverse delay for both devices (`docs/PLAN-reverse-delay.md`); the user's calls: a new
`util/reverse-tap`, a mono sum into one buffer, softening on the sum.
- Primitive-only first: a `lfo/ramp-up` sweeping a `buffer-tap` reverses when the delay grows by
  2 samples per sample. A float32 simulation of `lfo_rate_from_percent` and the accumulator put a
  fractional authored RATE within 0.4 ct, but the nearest integer RATE (what a device param
  gives) 15-90 ct off, and a knob would also have to scale the span. So no SIZE knob that way.
- The first SOFTEN (fast follower 0.1/200 ms minus a slow one 100/200 ms, GAIN 40) did nothing
  useful: during a pluck both followers clamp at 1 (their difference collapses), and on held
  material the fast one sits near the peaks and the slow one near the mean, so steady sound was
  ducked too (the wet level read 12 dB low). A simulation of the follower math settled on fast
  0.1/46 ms minus 1.6x slow (via a VCA): steady noise and saws stay at gain 1.00. A first
  harness metric (the sharpest 2.5 ms fall of the full patch's output) didn't move at all with
  SOFTEN: the diffused, overlapped wash has no abrupt stops left to measure. Measured instead on
  one head alone (WINDOW 0, no feedback): a reversed pluck's last 5 ms vs its loudest are 0.1 dB
  without SOFTEN (it stops on its loudest moment), -4.6 dB at 80 and -10.2 dB at 100 (at an
  effect's input level, 0.2 peak) -- so the authored value is 100.
- xd CPU (emulator, penalty 8): the full patch was 1376 cycles/sample. The pans were the biggest
  share (a wired `pan` took two square roots and clamps per sample, ~240 for four heads): made
  control-rate with linear ramps -> 1148. The allpasses (~95 each: a real call, two interpolated
  SDRAM reads) got a whole-sample inlined path for a static TIME -> 969. Variants: no allpasses
  766, one per side 867, no motion LFOs -86, one reverse line ~ -200. Shipped for the xd: one
  line, one allpass a side, motion kept (670), +3 dB on its wet output after the feedback tap.
- Feedback: the first range (DEPTH x 0.8 of L + R) passed a "bounded, still sounding after the
  burst" check, which the soft-clip guarantees anyway. A per-second decay check showed the
  four-head version holding and growing at full DEPTH (L + R of four equal-power pans is ~1.2-1.7x,
  and it moves with the pan positions, so the motion LFOs swing the loop gain). Set where full
  DEPTH still dies away with the NTS-1 mkII menu at its worst (SPREAD and MOTION 0 -- every head
  centred -- and TONE open): 0.32; the xd version (one line) grew at 0.8, decayed slowly at 0.7,
  ships at 0.65.

### Additive cutoff/fade/timbre, file version 4 (2026-10-01)

The user's stereo bandpass effect (`~/Documents/logue-patches/fx-stereo-filters.loguepatch`):
a triangle LFO through a VCA at GAIN 4 (x0.16, not "a bit of scale"), straight and inverted,
into two svf `cutoff`s with CUTOFF at 50, and the Depth control's `bipolar` outlet into two
crossfaders' `fade`. The cutoffs replaced their dial and clamped to 0..1, so each filter sat
between 0 and 16 % half the time and fully closed the other half; the bottom half of Depth was
dry. The canvas's ⇥/± markers and wire colours were all there; what wasn't visible was the
expected range and that the dial went dead. Options weighed: a mismatch warning on the wire, a
fuller tooltip with the replaced dial greyed, a sweep arc on the dial, or removing the
replace/additive split. The user's question was whether the last one would have prevented the
confusion altogether: for cutoff/fade/timbre yes, but not for `vca` `gain` (an envelope into a
unity-gain additive VCA never closes) or the mux selectors (dial and gate fight), so those keep
replacing. Depth 100 rather than the house 50, so one LFO sweeps a filter closed to open and the
v3 migration (dial 0) is exact. The fixed copy, `fx-stereo-filters-fixed.loguepatch` (v4), is
the user's own wiring with the VCA at x0.4 (CUTOFF 50 +- 40), FADE 0 and Depth on `unipolar`.

### `osc/bass-support`: RANGE and MODE removed (2026-10-02)

The user found folding every note into a fixed two-octave window (RANGE C0-B1/C1-B2/C2-B3,
MODE Wrap/Follow) hard to follow and unpractical in use. Now the bass plays one octave below
the played note, and COARSE (+-24 st) sets any other distance. MODE went with RANGE: Wrap and
Follow only choose among copies inside the window. That also removed the per-note octave latch
(and with it the untested "device portamento in the first block" caveat): the pitch is live.
RETRIG now resets the phase directly in `noteOnStatement`; state 10 -> 7 floats (84 -> 64 B).
Harness (xd): note 60 plays 130.81 Hz, COARSE -12 65.41 Hz. xd emulator unchanged (265 base,
392 with control inputs); code ~210-300 B smaller per first instance (re-measured). An older file's RANGE/MODE
entries show as stale params (Remove). No hardware pass of the new version yet.
Headroom sweep (xd harness, SUB/DRIVE/ASYM/TONE 100, notes 12..127, COARSE -24/0/+24): SHAPE
33/67 reaches the output clip for bass notes up to ~24, as the old version did at the same corner
inside its own C0-B1/C1-B2 windows (checked against the previous commit), so x0.52 is not a hard
guarantee at that extreme; SHAPE 100 peaks at 0.95, no non-finite samples anywhere.

### `env/adsr` and `env/one-knob-adsr` (2026-10-02)

The user asked for something like their Axoloti `one-knob-adsr` subpatch: a dial (plus an
inlet) reading four 16-step interpolated tables into an ADSR's A/D/S/R, useful on restricted
interfaces. Its own order was organ (release growing) -> percussive (decay growing) -> swells
(attack growing), sustain only ever 0 or full. Asked primitive vs subpatch, the answer was a
primitive: logue-patcher had neither an ADSR (`ahd` holds at 1, no sustain level) nor a table
node, and a subpatch would have done four table reads, per sample once anything moves, behind
the same one-param interface. The user chose the proposed short-to-long order over the
original's: Blip, Pluck, Mallet, Piano, Keys, Gate, Organ, Brass, Strings, Bowed, Swell, Pad,
Drone, so neighbours differ in one or two stages and in-between positions stay musical (the
original's organ -> percussion step was the one abrupt blend). A plain four-dial `env/adsr`
came with it on the same step helper. Exponential decay/release was chosen over linear (a pluck
or piano sounds right without a curve param), with each time meaning "within 1 %". Stations
got plateaus (a fifth of the spacing either side) because SHAPE's 101 integer steps only hit
5 of 13 stations exactly otherwise. Harness, measurements: see CLAUDE.md's gotcha entry.

### `osc/phase-dist` (2026-10-02)

The user asked for a CZ-style phase distortion oscillator, CPU feasibility first. The estimate
from the measured sine (110 xd emulator cycles) said a PD oscillator is a sine plus a compare and
a multiply-add per sample; the measured result was 85 base. The user picked all eight CZ waves,
line 1+2, an external DCW (wire an envelope, no built-in DCW envelope) and limiting the bend by
note. Shapes: the resonance waves follow Casio's patent (a windowed counter-reset cosine) as
summarised on Wikipedia; keithadler/pdsynth (GPL, read for ideas only, no code taken) rounds the
resonance multiple to an integer, which this deliberately doesn't. Its five-segment square holds
at the cosine's peaks like this one's. Tuning in the harness: the first limit (1/4 of the sample
rate) still aliased the pulse at -33 dB, the squared DCW curve bunched the change at the top
(cubed now), the limit made the double sine worse at high notes (it's exempt now), and a moving
DCW first cost ~180 cycles over the block path (now ~70: only the chosen waves' coefficients,
one divide for both of the saw's).
Limit sweep at DCW 100 (`runPhaseDistHarness.ts --sweep-limits`, off-harmonic energy): a cap at
1/4 of the sample rate left the pulse only 33 dB clean even at note 48; 1/16 turned note 96 back
into a sine (harmonic centroid 1.0); 1/8 kept -46..-50 dB at notes 48-72 and -35..-47 at 96 with
the waves' character. Without any limit the bend waves were -0..-21 dB at notes 72-108. A review
found DCW's first default of 50 left an envelope from the default only half the range (depth
100 clamps at 100); it defaults to 0 now.
Both staged units (`lp-*-pd`: DCW on Shape; `lp-*-pd-env`: an ADSR into `dcw`) worked as
designed on a real minilogue xd and a real NTS-1 mkII (user, 2026-10-02).

### Noise colours and `osc/lfsr` (2026-10-03)

The user asked for more noise types at the lowest possible CPU, and whether they should be new
primitives or a select on `osc/noise`. Decided: the spectral colours (White/Pink/Brown/Violet)
share no params and one meaning, so they became a COLOR select (one device control switches
them); the NES/Game Boy shift register needs its own clock, pitch tracking and mode, which would
sit dead on a colour, so it's a separate primitive. A dust/velvet source was offered and left
for later.
CPU went through three rounds on the xd emulator. The first version reused the exciter's Kellet
filter behind a float colour compare: white 6 -> 17, pink 74. Making the colour an int member
(the float compare needed a `vmrs` a sample) and dropping the +-1 clamps brought white to 9; pink
stayed ~55 because GCC at `-Os` reloaded Kellet's seven coefficients from the literal pool every
sample. Voss-McCartney (integer rows, `ctz` picks the one to redraw) cut pink to 34 with octave
ripple under 0.3 dB, and integer brown/violet went 33/27 -> 27/27. `lfsr` first stepped a float
accumulator (32 base); an integer 8.24 one with the fixed-point increment as the block constant
made it 28 (Short 17). An early Short mode stepped the register itself, which caps the pitch at
48000/127 = 378 Hz; reading the 127-step loop as a table plays any note exactly.
The level target (RMS 1/3 for the colours) came from a 10M-sample simulation: at white's RMS
~8% of pink/brown samples sat past +-1.


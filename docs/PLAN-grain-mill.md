# grain-mill (a granular delay effect from primitives)

Plan agreed 2026-09-30. Status: phase 1 done (2026-09-30; harness- and link-checked, no
hardware pass yet). A port of the user's Axoloti patch
`~/Documents/axoloti/axoloti-patches/grains/grain-mill-axocontrol.axp` (+ its `grain-player.axs`
subpatch), built from new general-purpose primitives rather than one monolithic node.

## What the original does

- **Record buffer**: input L + feedback written into a 131072-sample ring (2.7 s at 48 kHz).
  FREEZE crossfades (a few ms) from writing the input to re-writing the buffer's own content;
  the write head keeps moving.
- **Clock**: a free square LFO (knob 4) or MIDI clock divisions. "Random" is a 50% chance gate on
  each clock tick (`uniform < 0` AND clock), not random timing.
- **Round robin**: counter + demux8 hand each trigger to the next of 8 grain players.
- **Grain player**: on a trigger it latches position and length, then records `length` samples
  from the buffer at a CONSTANT delay behind the write head into its own 64K table (200-sample
  linear fade in/out baked in; the first 200 samples crossfade with the old table content), and
  LOOPS that table until its next trigger. An AD envelope (linear attack, exponential decay,
  retriggered from the current level) and a VCA on top. The original underflows for
  `length < 200`.
- **Motion**: position = amount x unipolar(saw down / saw up / triangle / random every 16
  samples); every voice gets the same position and length (`exp` of knob 3), latched per voice.
- **Out**: odd voices left, even right. L+R -> ~49 Hz highpass -> feedback VCA -> into the buffer.
  Dry is added at full wet level; width crossfades mono sum (L+R) <-> stereo.
- Not ported: the envelope follower, LEDs, change detection, joystick (Axoloti UI only).

## Decisions (user, 2026-09-30)

- **NTS-1 mkII delfx first**; a minilogue xd delfx variant later (3 knobs, no menu params, 12 KB
  SRAM incl. code, effect CPU unmeasured -- probably fewer voices).
- **The voice is a subpatch** (`grain -> env/ad -> vca -> pan`), like `grain-player.axs`, 8
  instances. So the buffer wire must cross a subpatch inlet.
- **Mixing by a chainable pan**: `mix/pan` has bus inlets `l`/`r` and adds its panned voice onto
  them; the 8 voices form one chain. PAN per instance (alternating +-), replacing hard L/R.
- **16-bit storage** for the buffer and the grain tables (the `util/delay` precedent, ~-90 dB
  floor): 256 KB + 8 x 128 KB = 1.25 MB of the delfx's 3 MB, leaving room for the xd later.
- **Freeze = DEPTH knob at full travel** (the top few % of grain size also freezes).
- Defaults, not objected to: position 0 = newest audio, 1 = the whole buffer back (the original
  jumps from newest at 0 to oldest at 0.01); device tempo replaces MIDI clock divisions; MIX is a
  real dry/wet; random chance fixed at 50% (a CHANCE param, not exposed); `env/ad` gets an
  exponential-decay option.

## The new concept: a buffer wire

Today every connection is one float per sample. A `buf` connection instead carries a reference
to a writer's SDRAM line (pointer, write index, mask) -- an Axoloti objref, but as a visible
wire (node identity is the name, and flattening renames nodes, so no by-name reference).

- **Resolver**: a `bufferInlets` list on the reader. Like `delayedInlets` it doesn't order the
  graph (the writer is visited from the deferred queue, so a writer reached only through buffer
  wires is still emitted, its own inputs -- the feedback sum -- ordered after the readers, and
  8 readers share one writer). Unlike a delayed inlet it's readable in `renderExpr`: the reader
  receives the writer's member names, not a value. Reads are at least 1 sample old (the writer
  runs after its readers), which is what makes the feedback loop legal without `sample-delay`.
- A `buf` outlet may only go to a `buf` inlet and vice versa (resolver error + canvas refusal).
- **Canvas**: a new port shape/colour; `wirePolarity`/`ports.ts`; `unresolvedReferences`;
  `logue-primitivePresentation.spec.ts`' exempt-inlet list.
- **Subpatches**: flattening is type-agnostic (it rewires nets). `synthesizeSubpatchPrimitive`
  gives an inlet port the buffer role when, inside, it feeds a buffer inlet.
- **Generators**: `oscBody`/`fxShared` and both fx generators; SDRAM layout gains 16-bit lines
  (`sdramFloats` stays the unit: a 16-bit line asks for `n/2` floats, reinterpreted as
  `int16_t *`). Buffer primitives are effects-only (`modules`), like `util/long-delay`.
- Snapshots, code-size and CPU tables get the new entries.

## New primitives

| Primitive | Ports | Params |
|---|---|---|
| `util/buffer` | in `in`, `freeze` (gate); out `buf` | LENGTH (structural: 0.68/1.4/2.7/5.5 s), FREEZE (checkbox, OR'd with the inlet) |
| `util/buffer-tap` | in `buf`, `delay`; out `out` | TIME (0..LENGTH, Hermite read) -- the plain reader, for multi-tap delays |
| `util/grain` | in `buf`, `trig`, `position`, `size`; out `out` | POSITION, SIZE (exponential, ~10 ms..MAXLEN, min 2x fade), FADE, MAXLEN (structural table size) |
| `mix/pan` | in `in`, `l`, `r` (bus); out `l`, `r` | PAN -100..100 (equal power), additive `pan` inlet |
| `mix/width` | in `l`, `r`; out `l`, `r` | WIDTH 0 (mono, the mid) .. 100 (as is) |
| `logic/chance` | in `trig`; out `out` (gate) | CHANCE 0..100 % per rising edge |
| `logic/round-robin` | in `trig`; out `o1`..`o8` (gates) | VOICES 2..8 |

Changed: `env/ad` gets a decay-curve option (linear as today / exponential like the original).

## The example patch

- `audio-in.mono` + feedback -> `util/buffer`.
- Clock: `lfo/square-lfo` (free) and `sense/tempo` (sync), each also through a `logic/chance`;
  one `mux4` picks among free / sync / random / random+sync -> `logic/round-robin` -> 8 voices.
- Motion: ramp-down / ramp-up / triangle-lfo / random-steps -> `mux4` -> x amount -> every voice's
  `position`.
- Voices chained through their pans -> `mix/width` -> dry/wet crossfaders (MIX knob) -> out;
  the chain's L+R -> `highpass-cheap` -> VCA (FEEDBACK) -> back into the buffer.
- DEPTH: one `sense/control` -> every voice's size; `logic/greater-than` near full travel ->
  the buffer's `freeze`.

| Control | Proposal |
|---|---|
| TIME knob | clock rate (free) and tempo DIVISION (sync) -- both bound to the knob |
| DEPTH knob | grain size; full travel = freeze |
| MIX | dry/wet |
| Menu 1-3 | MOTN AMT, MOTN SPD, MOTN TYP |
| Menu 4 | FEEDBACK |
| Menu 5 | WIDTH |
| Menu 6-7 | ENV (envelope shape and length), CHANCE (random modes) |
| Menu 8 | MODE: free / sync / random / random+sync |

## Subpatch lookup next to the patch (user, 2026-09-30)

A `sub/<path>` type resolves FIRST to `<folder of the open patch>/<path>.loguesub`, and only if
that doesn't exist to the library folder as today. A local file overrides a library one of the
same path. So the example ships as `examples/effects/grain-mill.loguepatch` +
`examples/effects/grain-voice.loguesub` and works without touching the library.

- Both readers change together: main's `loadCurrentSubpatchDefinitions` (Export/Build) and the
  renderer's `subpatchLibraryStore` cache (canvas), so they can't disagree. The cache follows
  the active tab's folder (re-listed on a tab switch or Save As), and main watches that one
  folder's top level. Only the top level is searched.
- The root patch's folder applies at every nesting level (a library definition's own `sub/x`
  also looks next to the root patch first) -- one rule, and what gets built is decided by the
  document being built. (Default; revisit if a real case wants per-definition folders.)
- An unsaved patch has no folder: library only. Save As into another folder can change what an
  instance resolves to -- the canvas remounts on the cache change, as it does today.
- An instance resolved locally shows that (a "local" hint in the Inspector, with the file path),
  since shadowing a library definition is otherwise invisible. "Edit subpatch" opens the file it
  actually resolved to.
- The palette offers the patch folder's subpatches as their own group, ahead of the library's.
- A self-containing check and `missing-subpatch` work across both roots.
- Its own phase (before the example, independent of the buffer work).

## Phases

1. **Done.** Buffer wire type + `util/buffer` + `util/buffer-tap`, with harness checks (two taps
   exact, an echo loop through the buffer, freeze looping bit-exactly).
   On a real NTS-1 mkII (2026-09-30): ~150 cycles per tap (588 for buffer + 1 tap, 1061 for 4),
   so 8 grain voices at ~150-300 each should land near 10-20 % of the 11,457-cycle budget.
   Freeze and the 16-bit sound confirmed on the device (user).
2. **Done** (2026-09-30). `util/grain`: harness checks capture, a bit-exact loop, the faded seam,
   POSITION, a click-free retrigger and self-triggering. A retrigger ramps out what was playing
   (the original's crossfade against the old table's start clicked). On a real NTS-1 mkII
   (2026-09-30): works as designed; ~70-100 cycles per grain voice (a whole one-grain unit 504),
   so 8 voices should be ~5-7 % and the whole grain-mill ~10-15 %.
3. **Done** (2026-09-30). `mix/pan`, `mix/width`, `logic/chance`, `logic/round-robin`, the `env/ad`
   `EXP` option; harness-checked, no hardware pass yet. WIDTH tops out at 100 (the xd manifest's
   range cap).
4. **Done** (2026-09-30). Subpatch lookup next to the patch (see above): only the folder's top
   level (a patch may sit in a huge folder), checked in the built app.
5. **In progress** (2026-09-30): `examples/effects/grain-mill.loguepatch` + `grain-voice.loguesub`
   written (`writeEffectExamples.ts`), harness-checked (`runNts1FxHarness.ts`), staged as
   `lp-fx-grainmill` (+ `-cpu`, MODE's row given to the probe: the delay's 11 rows are full). The -6 dB
   output trim first planned was dropped: the harness showed the wet signal ~-12 dB under the input.
   First device notes (user, 2026-10-01): too quiet at slow clocks, FEEDBK 100 died out. Fixed:
   EXP DECAY is now a time constant; the feedback path sums L+R (as the original's `+_2`) and
   gets a soft clip, since eight summed voices ran away into a clipped noise wall at FEEDBK 60+
   (harness: 30 now holds steady, 60-100 build to a soft-saturated ~0.7 rms wet). Pending: how
   high FEEDBK sounds on the device. -> FEEDBK 100 of the full sum was too loud (user,
   2026-10-01); the feedback mixer now takes half the sum, so 100 = the old 50, where the loop
   just starts to build up (harness: 0.32 -> 0.59 wet rms over 3 s; 50 now fades slowly).
   ATTACK/DECAY became ENV + LENGTH (user's idea, 2026-10-01): ENV morphs the grain envelope
   no attack -> attack = decay -> no decay, LENGTH scales both (attack = 100 % * ENV * LENGTH,
   decay = 100 % * (1 - ENV) * LENGTH, fed as signals into the voice's new attack/decay inlets --
   plain math nodes, no new primitive). The rates are now computed per sample (wired inlets):
   expect a few % more CPU, not measured yet.
   Then LENGTH was dropped (user): ENV alone sets shape AND length -- short and harsh at the
   ends, long and smooth in the middle: length = 10 % + 90 % * 4t(1-t) of the whole, attack =
   t * length, decay = (1-t) * length (ENV 0: a 10 % decay; 50: 50 %/50 %; 100: a 10 % attack).
   Its slot is now CHANCE (the random modes' probability, both chance nodes).
   CPU on the device (`lp-fx-grainmill-cpu`, user, 2026-10-01; TIME ~30 %, DEPTH ~75 %, FEEDBK
   25): 3610 of 11457 cycles/sample (the probe's own share read 25 %, 3610/11457 is 31 %) --
   2-3x the 10-15 % estimated from the one-grain unit; about the example reverb's 29 %, under
   the ~45 % where an oscillator broke up. Not yet split per node (SDRAM traffic from nine
   streams is the unverified suspect).
   The voice subpatch + the example; build, CPU probe and a listening pass on a real NTS-1 mkII.
6. **In progress** (2026-10-01): the minilogue xd delfx variants, the user's mapping. One unit per
   clock mode (`grain-mill-xd-{free,sync,rnd,rndsync}.loguepatch`, no MODE). Time = the clock
   (rate or tempo division) with ENV rising 0 -> 50 (slow = harsh); Depth = grain size, feedback
   0 -> 40 and freeze at full travel; Shift+Depth = dry/wet. No motion: each voice reads from its
   own fixed offset (the voice subpatch's POSITION is now promoted, 4 % steps; the NTS-1 mkII
   unit is byte-identical). WIDTH fixed (no node), CHANCE 50.
   CPU first (`scripts/emulateXdFxCycles.py`, new: the xd oscillator emulator for effect units,
   with an SDRAM_PENALTY per SDRAM access since the F446 has no data cache). Worst case (20 Hz
   clock, every voice recording): ~340 cycles per voice + ~330: 8 voices 3060-3380, 6 voices
   2370-2690, 4 voices 1690-1910 (penalty 0-16), against ~3750 cycles/sample if the effects MCU
   runs at 180 MHz -- which the mod and reverb slots share. So 4 voices (`XD_VOICES`) for the
   first hardware pass: 5.2-5.4 KB of the 12 KB SRAM, 1 MB SDRAM. xd harness: all four finite and
   sounding under ASan/UBSan.
   On the xd (user, 2026-10-01): alone fine, crackles with mod and/or reverb on. Profiled
   (`PROFILE=1`): ~20 % in the per-sample conversion of the wired envelope times, ~3 % in the
   crossfaders' square roots, the rest largely grain_step and its call. Fixed in the primitives
   (wired env times at control rate, block-rate crossfader, grain_step inlined): 4 voices
   1690-1910 -> 1100-1320 cycles/sample (-35 %), 7.0-7.2 KB SRAM.
   Retest on the xd (user, 2026-10-01): 4 voices alone fine, crackles with the factory reverb or
   chorus; 3 voices fine with either, crackles with both; **2 voices clean with both on** -- so
   `XD_VOICES = 2` (emulator ~750 cycles/sample, 4.4-4.6 KB SRAM, 768 KB SDRAM). The xd's effects
   MCU is shared by all three slots, and what the factory effects need was the unknown: a
   grain-mill-sized xd delay should stay under roughly 750-900 emulator cycles/sample.
   Grain Rnd at Time 0 was silent (user): the free clock's 0.1 Hz floor plus ENV's shortest
   envelope left one short grain every 10-20 s. The free/random xd clocks now span ~1-12 Hz
   (RATE 35 + Time through the rate inlet); the synced ones keep 1/16 .. 1/1.
   A/B on the xd (user, 2026-10-01): voice 2 further back sounds better -- offsets are now
   4 + (k-1) * 15 % (0.22 s and 1.05 s back). Low Depth gave only shrieky 10-20 ms repeats: on the
   xd Depth now scales SIZE 50..100 (~180 ms .. 1.4 s, through a new `size` inlet on the voice;
   the NTS-1 mkII keeps its knob binding, byte-identical). Fixed offsets repeated too much: a
   random-steps jitter (~8 Hz, +-4 % = +-0.2 s, inverted for voice 2) moves each grain's start.
   CPU: util/grain now clamps position/size and cubes SIZE only when it triggers, and every LFO's
   unwired RATE is a block constant (both output-identical); the unit is ~814 emulator cycles
   (penalty 8), ~40 over the last build heard clean with both factory effects.
   On the xd (user): the grains sound much better, but with both factory effects the fx section
   dropped out. Knob-only math is now computed once per block (pure primitives fed only by knobs
   and constants, and the conversions that read them): 814 -> 681 (Rnd 697), output identical;
   no drop-outs with both effects on (user, 2026-10-01).
   Feedback "could increase more with higher depth" (user): it now rides Depth SQUARED up to
   the full FEEDBK 100 (was linear, capped at 40), and the xd's feedback mixer takes the FULL sum
   of its two voices (the NTS-1 mkII's half sum is tuned for eight: with two it kept the loop gain
   ~0.4). xd harness at Depth 90 %: 0.031 rms a quarter second after a burst (was 0.004), peak 0.15.
   Then "nasty with higher Time, bad going into the freeze" (user): the loop is strongest at mid
   Time (fast clock, ENV's long grains) and built up there (xd harness: louder after a burst than
   during it at Time 0.5-0.75). Feedback now also scales by 1 - 0.6 Time: at Depth 90 % a burst
   sustains at about a third of its level at mid Time and never builds up (GM_SWEEP=1 in
   runXdFxHarness.ts prints the sweep; the check pins "sustains, never above half the burst").

## Open

- **Select labels**: MOTN TYP and MODE are `mux4` INDEX params, which the NTS-1 mkII shows as
  "In 1".."In 4". Readable names need per-instance select names (or dedicated nodes).
- xd: voice count vs 12 KB of code and unmeasured effect CPU.

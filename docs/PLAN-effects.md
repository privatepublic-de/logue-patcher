# Effect patches (modfx / delfx / revfx)

Plan agreed 2026-09-29. Status (2026-09-30): phase 0 done on NTS-1 mkII (xd units confirmed
2026-09-30 after the Q31 param fix); phases 1 and 2 done, phase 3 done and hardware-confirmed; phase 4 done and hardware-confirmed; phase 5 done (in-app upload confirmed on both devices); phase 6 done and hardware-confirmed; phase 7 done and hardware-confirmed; phase 8 done.

## Decisions (user, 2026-09-29)

- **Stereo is explicit.** A new pseudo-node `logue/io/audio-in` (no inlets; outlets `l`, `r`,
  `mono` = (l+r)/2). In an effect document `logue/io/audio-out` has inlets `l`/`r`, and an unwired
  `r` copies `l`. Oscillator documents keep the mono `in`. Primitives stay mono: a stereo effect
  is two chains, or one subpatch instanced twice.
- **The module lives in the document**: `settings.logueTarget.module: 'osc' | 'modfx' | 'delfx' |
  'revfx'`. Same `.loguepatch` extension and codec (no new file type: the module is one field, can
  be changed later as an undoable settings edit, and subpatches stay shareable). New menu items
  "New Mod/Delay/Reverb Effect"; a tab/Build panel badge shows the module.
- **Both platforms**, NTS-1 mkII proven end to end first; the xd follows the spike.
- **Dry/wet is user-wired**: a new effect document starts as audio-in -> crossfader -> audio-out,
  the crossfader's MIX bound to the device MIX knob where the unit has one.
- Subpatches work in any document whose module supports all their contents. The CPU gauge says
  "not measured" for effects until one is measured.
- **Architecture: hybrid.** One import-free descriptor table (`logue-codegen/src/unitKinds.ts`, per
  platform x module: knobs, reserved slots, param limits, RAM/SDRAM budgets, template, header
  target, fixed baseline) read by every consumer; the module is threaded through the existing osc
  pipeline; renames (`resolveOscUnit` -> `resolveUnit`, IPC names) only as final, separate commits.

## SDK facts the design rests on

| | Knobs | Reserved slots | Menu params | Code+RAM | SDRAM |
|---|---|---|---|---|---|
| NTS-1 mkII modfx | TIME, DEPTH | 0, 1 | 8 | 16 KB load | 256 KB |
| NTS-1 mkII delfx/revfx | TIME, DEPTH, MIX | 0, 1, 2 | 8 | 24 KB load | 3 MB |
| xd modfx | Time, Depth | -- | 0 | 6 KB SRAM incl. code | 128 KB |
| xd delfx/revfx | Time, Depth, Shift+Depth (id 3) | -- | 0 | 12 KB SRAM incl. code | 2432 KB |

- NTS-1 mkII: one API for every module; `unit_render(in, out, frames)` interleaved stereo 2-in/
  2-out, in/out may alias (read both inputs before writing). SDRAM from `hooks.sdram_alloc` in
  `unit_init`. Tempo via `unit_set_tempo` (UQ16.16) and `unit_tempo_4ppqn_tick`. MIX is
  `{-1000, 1000, ..., k_unit_param_type_drywet, 1, 1, ...}`.
- xd: modfx `process(main_xn, main_yn, sub_xn, sub_yn, frames)`; delfx/revfx `process(xn, frames)`
  in place. Params are 10-bit (0..1023), no menu params, manifest `num_param: 0`. SDRAM is a
  static `__sdram` array (NOLOAD: clear it in init and resume). Scaffold deltas vs osc: MCU
  `STM32F446xE`, per-module `.ld`, `main_api.syms`, `.sdram` in `rules.ld`, `_unit.c` magic
  `UMOD`/`UDEL`/`UREV`.
- Effects link no osc API. Primitive code uses only two osc symbols: `osc_w0f_for_note` (inside
  the `note_w0` helper) and `osc_sinf` (sine-lfo, osc/sine, sync, bass-support). Effect units get
  a constant `note_ = 60`, an fx-safe `note_w0`, and `osc_sinf` -> `fx_sinf` (same meaning), so
  every primitive compiles. `sense/pitch`/`gate`/`velocity` and the superseded `sense/*` get a
  new `modules?` restriction (osc only).
- No note, velocity or MIDI reaches an effect. `fx_sinuf`/`fx_cosuf` are stubs and
  `fx_sat_cubicf`/`fx_sat_schetzenf` index their LUT wrongly in both SDKs: don't use them.

## Phases

0. **Hardware spike** (`logue-codegen/scripts/stageFxSpike.ts`): hand-written units, no app code.
   See the checklist below.
1. **Done 2026-09-30.** `unitKinds.ts` with the osc entries only (output-neutral: snapshots
   byte-identical), and the `module` field in `PatchSettings`/`patchCodec`. The old per-platform
   constants (`MINILOGUE_XD_SRAM_BYTES`, `PLATFORM_KNOBS`, `MAX_PARAM_SLOTS`, `RESERVED_SLOTS`,
   ...) are kept as names but read the table; `resolvePlatformGraph` refuses a module with no
   entry, so an effect document reads "can't be built yet" rather than building as an osc.
2. **Done 2026-09-30.** `audio-in`, the two-sink `resolveAudioGraph` (`stereoSinks`,
   `audioInSuffix`), the `modules?` restriction (`assertPrimitivesSupportModule`, called from
   `resolvePlatformGraph`; subpatches intersect it); `test/logue-effectGraph.spec.ts`. Canvas
   ports for audio-in / stereo audio-out wait for phase 5.
3. **Done 2026-09-30, hardware-confirmed (user: all four units as described).** NTS-1 mkII modfx/delfx/revfx generator
   (`nts1mkii/generateFxUnit.ts`), Build/Export staging from `dummy-<module>`
   (`main/ipc/nts1mkiiSources.ts`), host harness (`scripts/runNts1FxHarness.ts`: bit-exact
   pass-through also with in == out, MIX +-1000, R copies L, a sine at middle C, a 5.08 ms
   Haas delay -- all pass), and a real ARM build of all 60 fx-usable primitives importing only
   fx_api symbols (`scripts/stageFxUnits.ts --sweep`). Decided on the way: the xd's Shift+Depth
   is the same `mix` knob as NTS-1 mkII's MIX (one binding = dry/wet on both); `env/ahd` is
   osc-only (it holds until a note-off an effect never gets). Measured: a generated
   pass-through delfx loads 4186 B (text 3842, data 272, bss 72), so the state-only RAM gauge
   understates effects by ~4 KB -- phase 4/5 should add a measured code baseline. Single-
   primitive units (sweep, loaded bytes): `osc/additive` 17670 (too big for modfx's 16 KB; fine
   in delfx/revfx), `filter/string` 13860, `svf` 9517, `comb` 7354, `bass-support` 7202,
   `util/delay` 6905, `formant` 6178; everything else under 6 KB.
4. **Done 2026-09-30, hardware-confirmed (user: all units as described, incl. the exact-256 KB
   modfx and repeated unit switching).** SDRAM for primitives
   (`LoguePrimitive.sdramFloats(node)`, `sdramLayout`, one `sdram_alloc` in `unit_init`, zeroed
   in `init()`, over-budget = export error) + `logue/util/long-delay` (user's calls: a structural
   RANGE select, built-in MIX, tempo SYNC now -- `tempo_` from `unit_set_tempo`). The RAM
   estimate gets an `sdram` line and the kind's measured `fixedCodeBytes`. New:
   `PrimitiveParamSpec.structural` (no device control allowed). Harness and sweep (61
   primitives) pass; long-delay alone loads 5030 B. Phase 5 must keep structural params out of
   the Param Matrix pool, and show the SDRAM line in the Build panel.
5. **Code done 2026-09-30, checked in the real app (run-desktop); device upload open.** Menus
   (File › New Mod/Delay/Reverb Effect, tab bar, empty state), a stereo pass-through template
   (user's call over a pre-wired crossfader), palette hiding what can't build in the patch's
   kind (user's call), the Param Matrix and device-control picker from `deviceLayout(platform,
   module)`, structural params kept out of the Matrix, the Build panel's Effect Type pill (among
   effects only, user's call), SDRAM line, CPU note and xd note, effect tab icon. Verified in the
   app: a new delay effect, its palette and Matrix, an in-app Build (`untitled.nts1mkiiunit`),
   the xd refusal, the stereo echo's RAM (18%, code baseline included) and SDRAM (33%) lines,
   Export of it (`header.c`/`fx.h`/`unit.cc`), and switching it to Mod (MIX bindings removed and
   reported, SDRAM 400% in red). Pasting leaves out the fixed io nodes.
   Also: the first effect unit uploaded through the app (Build Results' upload icon -> SysEx),
   which phase 3 couldn't do since the app can't open an effect patch yet; and the RAM gauge's
   measured code baseline (see phase 3).
6. **Code done 2026-09-30, hardware pass open.** revfx was already generated (phase 3). New
   primitives `filter/allpass` (SDRAM Schroeder diffuser), `env/follower`, `sense/tempo` (clock +
   ramp; user's calls: a primitive-built reverb first, a tempo clock rather than SYNC on every
   LFO, the follower under env). Example patches in `examples/effects/` (stereo reverb, auto-wah,
   tempo swell), built with a CPU probe to measure what a primitive-built reverb costs before
   deciding on a dedicated reverb primitive. Harness: allpass energy exact, follower times,
   tempo clock spacing. Sweep: 64 primitives build and link clean. The reverb example at the
   effect input's real level (0.18-peak noise): wet peak 0.27-0.30 and a smoothly decaying tail;
   one comb alone peaks at 0.56 with TIME fully up, just under long-delay's 0.6 soft knee (so a
   louder sustained input saturates a little, at maximum decay only).
   Open question for later: the RAM gauge counts primitive code as 0, so code-heavy effects
   read low (auto-wah estimate 4.3 KB, loads 10.3 KB of modfx's 16 KB). The sweep's single-unit
   sizes minus the 4244 B pass-through would give a measured per-primitive code table.
7. **Code done 2026-09-30, hardware pass open.** `minilogue-xd/generateFxUnit.ts`
   (`generateOldGenFxUnit`): `fx.cpp` (class `Fx`) plus the whole scaffold per module, embedded
   like the oscillator's -- Korg's `_unit.c` (UMOD/UDEL/UREV, modfx's four-buffer process), the
   Makefile with the effects MCU (`STM32F446xE`), `main_api.syms` and `user<module>.ld`, and the
   oscillator's `rules.ld` plus the NOLOAD `.sdram` section. What's shared with NTS-1 mkII
   (fixed members, osc-API stand-ins, SDRAM glue) moved to `fxShared.ts` (output-neutral apart
   from two comments). `minilogue-xd/projectFiles.ts` is the one path->file map Export and
   Build write (built unit `fx.mnlgxdunit`). xd unit kinds: no menu params (`maxParams` 0 --
   Korg's fx manifests have `num_param` 0 and no rows), knobs Time/Depth, plus Shift+Depth
   (id 3; id 2 is `reserved0`) as `mix` on delay/reverb; each arrives as Q31. SDRAM is one static
   `__sdram` array, cleared in init and on resume (NOLOAD). Tempo is pulled per block
   (`fx_get_bpmf`). Decided on the way: a menu slot on an xd effect is an export error naming
   the knobs; the Matrix and the device-control picker show knob rows only there; the upload
   reader takes the module from `manifest.json` rather than the zip's folder, which is the
   Makefile's PROJECT (`fx`, or Korg's `dummy_modfx`) -- the old rule would have refused every
   effect package, the spikes included. Verification: `scripts/runXdFxHarness.ts` (ASan/UBSan:
   pass in place and with separate buffers, Q31 knobs, Shift+Depth, middle C, NaN SDRAM, resume,
   tempo, the reverb example) and `scripts/stageXdFxUnits.ts --sweep`: every effect-usable
   primitive links against `main_api.syms` alone with only leaf calls below `process` (svf's
   per-block `tanf` aside, as in the oscillator); `osc/additive` can't fit (its 12 KB of tables
   overflow a delay's 12 KB by 1400 B; Build now says "too big for the device's memory");
   `filter/string` (10 KB) fits delay/reverb only. `util/long-delay`'s default RANGE (1.4 s,
   256 KB) is more than an xd modfx's 128 KB of SDRAM: Export says to shorten a RANGE, and the
   SDRAM line shows it red. The RAM gauge now includes measured code on both platforms
   (`codeSizeTable.ts`, user's call 2026-09-30), so an xd effect's gauge reads what the build
   will use (auto-wah: 5594 B estimated, 5540 B built).
8. **Done 2026-09-30**, four output-neutral commits: the per-platform constants kept over the
   table since phase 1 (`MINILOGUE_XD_SRAM_BYTES`, `NTS1MKII_OSC_MAX_RAM_LOAD_BYTES`, the
   `*_OSC_FIXED_BASELINE_BYTES`, `PLATFORM_KNOBS`, ...) replaced by `requireUnitKind` reads;
   `main/ipc/nts1mkiiSources.ts` moved to `nts1mkii/projectFiles.ts` beside the xd one;
   `resolveOscUnit` -> `resolveUnit`; the IPC channels named by platform
   (`exportNts1MkiiUnit`/`exportMinilogueXdUnit`, `buildNts1MkiiUnit`/`buildMinilogueXdUnit`),
   checked in the built app. Still osc-named, on purpose (a big rename for no behaviour):
   `oscInstances.ts`/`oscParams.ts`/`oscBody.ts`, `estimateOscStateCost`/`estimateOscCpuCost`,
   `LogueOscUnitMeta`, `buildOscBodyPieces`.

## Phase 0 results so far

Built with Arm GNU Toolchain 15.3 (not the SDK's GCC 5.4 / 10.3). Sizes from `arm-none-eabi-size`:

| Unit | Payload | Code+data+bss | SDRAM |
|---|---|---|---|
| xd modfx pass | 216 B | 216 B of 6 KB | -- |
| xd modfx chorus | 1024 B | 1040 B of 6 KB | 16 KB of 128 KB |
| xd delfx delay / revfx pingpong | 856 B | 868 B of 12 KB | 512 KB of 2432 KB |
| NTS-1 mkII modfx chorus | 5536 B file | ~2.1 KB loaded | 16 KB |
| NTS-1 mkII delfx delay / revfx pingpong | 5380 B file | ~2.0 KB loaded | 512 KB |

The xd's fixed fx overhead is tiny (216 B incl. the 64 B hook table), so the 6 KB is mostly
available to the graph. The xd `_hook_process` makes only leaf calls (`line_read`).

The NTS-1 mkII units import only `wt_sine_lut_f` (an fx_api LUT) from the device.

### NTS-1 mkII readings (user, 2026-09-29)

| Unit | pk | fr | fx cyc/sample | tot | sd (dirty words) | bpm |
|---|---|---|---|---|---|---|
| chorus (modfx) | 121 | 64 | 502 | 11457 | 4008 of 4096 | 120.2 |
| delay (delfx) | 13 | 64 | 453 | 11458 | 0 of 131072 | 120 (text cut?) |
| pingpong (revfx) | 25 | 64 | 455 | 11457 | 131072 of 131072 | 120 |

- All three load and run. 64 frames per call; the total budget is the same 11457 cycles/sample
  (~549 MHz) the oscillator probe measured.
- **SDRAM is handed over dirty** (pingpong got a fully written block, likely the delay's old
  audio): generated units must always clear what they allocate.
- Tempo arrives through `unit_set_tempo`.
- **A trivial delay already costs ~450 cycles/sample** (chorus ~500) -- far more than the same
  math on SRAM state would (the osc probe's whole sine cost 53). Most likely SDRAM data access,
  possibly uncached -- the chorus reads close to its write point and still costs ~500. The CPU estimate for effects needs its own SDRAM term; measure a delay with its
  line in SRAM to confirm.
- `al` is always 0: in and out are separate buffers (generated code still reads inputs first).
- Pingpong sounded mono: a spike bug (crossed feedback of an identical L/R input stays
  identical). Fixed 2026-09-30 (the input feeds only the left line): now stereo on the device,
  so the stereo output path works.
- MIX (DEL held + B) reaches the unit as param 2: the display's "W100" arrives as raw `1000`
  (user, 2026-09-30), so `+1000` = fully wet, as the `drywet` type suggests; `-1000` = dry is
  assumed from the symmetric range. The spike's `(v + 1000) / 2000` wet amount is right.
- **Input level**: a plain saw, filter open, peaks at 0.173-0.176 at the effect input on all three
  slots (user, 2026-09-30) -- about -15 dBFS, so effects get lots of headroom. Consequence:
  anything level-dependent tuned for +-1 (soft-clip, wavefolder, drive, a follower threshold)
  barely engages on a raw input. `audio-in` stays raw (no hidden gain); an effect that wants
  drive puts a gain stage first (`gain/vca` reaches 4x = +12 dB, so a dedicated input-gain range
  may be worth having).

### Hardware checklist (still open)

Load with Kontrol Editor or `logue-cli` (the app's upload dialog only opens from Build Results).
A short click or dropout when a delay/pingpong unit is switched on or reset is expected: it
clears 512 KB of SDRAM right then. The xd units have no readout, so everything on the xd is by
ear.

NTS-1 mkII (units in `logue-sdk/platform/nts-1_mkii/lp-fxspike-{chorus,delay,pingpong}/`):
- Each loads into its slot (MOD / DELAY / REVERB) and passes audio; DEPTH 0 on the chorus and
  MIX fully dry on the delay are exact pass-throughs.
- SHOW readings (the text updates when SHOW is moved): `pk` (recent input peak x1000 -- play the
  oscillator hard: is full scale 1000?), `fr` (frames per call), `sd` (non-zero SDRAM words before
  clearing: is SDRAM handed over zeroed?), `p` (last TIME/DEPTH/MIX change as id:value: turn MIX
  fully one way, then move SHOW to `p` -- raw range and sign, is -1000 dry?), `al` (do in/out
  alias?), `bpm` (does tempo arrive?).
- MODE "enable", then `fx`/`tot`: effect cycles per sample and the total budget, with the
  oscillator and the other effects on and off.
- Does the delay's TIME knob sweep smoothly; does the (fixed) pingpong bounce L -> R?

minilogue xd (units in `logue-sdk/platform/minilogue-xd/lp-fxspike-{pass,chorus,delay,pingpong}/`):
- Each loads into its slot and passes audio; pass is transparent.
- Chorus: Time = rate, Depth = depth. Delay: Time, Depth = feedback, Shift+Depth = dry/wet.
- Pingpong bounces L -> R (in the reverb slot). No clicks or stale audio when switching units
  (SDRAM is cleared in init/resume).

First xd pass (user, 2026-09-30): all four load, pingpong is L/R stereo, the delay's Shift+Depth
works. Every knob jumped from off at 0 straight to full: the spike read the param as 0..1023, but
the xd sends a Q31 value (0..2^31-1, 10 bits of it real; `q31_to_f32`, as the usual old-gen fx
code does). Fixed and rebuilt; knobs sweep smoothly after the fix (user, 2026-09-30). Chorus has no Shift+Depth by design: a
modfx has only Time and Depth on the xd (`user_modfx_param_id_t`), so the xd modfx kind gets
two knobs and no `mix`. The generator must convert with `q31_to_f32`.

### Phase 3 hardware checklist (generated units; all confirmed on a real NTS-1 mkII, 2026-09-30)

Built by `scripts/stageFxUnits.ts` into `logue-sdk/platform/nts-1_mkii/lp-fx-*/fx.nts1mkiiunit`
(load with Kontrol Editor or `logue-cli`; the app can't open an effect patch before phase 5):
- **LP FX Pass** (DELAY slot): transparent at every knob position.
- **LP FX LP Mix** (DELAY): MIX (DEL + B) fades dry -> lowpass; TIME is the cutoff (fully
  closed at 0, so fully wet + TIME 0 is silent). Mono out (R copies L).
- **LP FX Ring** (MOD): DEPTH fades dry -> ring modulated; TIME is the ring frequency (middle C
  at the centre, +-2 octaves).
- **LP FX Haas** (REVERB): L dry, R delayed 0.1-20 ms by DEPTH (widening/doubling); TIME and MIX
  do nothing.
- For each: does it load, do the knob names read TIME/DPTH(/MIX), and does the reverb-slot unit
  sit in the reverb list?

### Phase 4 hardware checklist (all confirmed on a real NTS-1 mkII, 2026-09-30)

`scripts/stageFxUnits.ts` builds, in `logue-sdk/platform/nts-1_mkii/lp-fx-*/fx.nts1mkiiunit`:
- **LP FX Echo** (DELAY): a stereo 2.7 s echo. TIME = delay time (linear, 0..2.7 s), DEPTH =
  feedback, MIX (DEL + B) = dry/wet. No stale audio when first selected (SDRAM cleared); a TIME
  sweep glides like tape.
- **LP FX Sync** (DELAY): the same, synced: TIME steps through 1/16 .. 1/1 (10 zones), repeats
  follow the device tempo (change the tempo while it plays).
- **LP FX Slap** (MOD): a 0.34 s slapback with a slow wobble; TIME = time, DEPTH = feedback.
- **LP FX Full** (MOD): one 1.4 s line, exactly the modfx's 256 KB of SDRAM. Does it load (does
  the allocator give the whole budget, or does it need a margin)?
- Switch between Echo and Sync (1 MB each, same DELAY slot) a dozen times: do loads keep working
  (Korg's templates never `sdram_free`, and neither do ours)? Mid-echo, switch away and back: an
  old tail must not come back (`unit_reset` clears the lines); a short click is possible.
- Worth a look: does TIME's display text read sensibly, and is the CPU fine with the reverb on?

### Phase 5 checklist (confirmed 2026-09-30: stereo-reverb built and uploaded from the app to a real NTS-1 mkII, user)

- Build an effect in the app (File › New Delay Effect, add a long delay between audio-in and
  audio-out, Build) and upload it from Build Results' upload icon: the first effect unit sent
  through the app's own SysEx path. Does it land in the DELAY slot list and play?

### Phase 6 hardware checklist (confirmed on a real NTS-1 mkII, 2026-09-30)

Result (user): swell and auto-wah OK (auto-wah with svf_tan); the reverb sounds good and its CPU
probe read fx 3406 cycles/sample of tot 11458 (29%) -- 8 long-delay combs, 4 allpasses and 2
crossfaders, so ~250 cycles per delay line on the M7.

Units in `logue-sdk/platform/nts-1_mkii/lp-fx-{reverb,autowah,swell}/fx.nts1mkiiunit` (the
example patches, each with an extra CPU menu param: set it to 1/2/3 and nudge it to read the
effect's cycles per sample, the whole budget, and the share):
- **LP Reverb** (REVERB): TIME = decay, DEPTH = damping, MIX = dry/wet. Does it sound like a
  reverb (dense, no obvious metallic ringing)? CPU readings with the reverb running.
- **LP AutoWah** (MOD): playing harder opens the filter; TIME = resonance, DEPTH = sensitivity.
- **LP Swell** (MOD): each 1/8 (TIME picks the division) fades in, following the device tempo.
- Also open: the phase 5 in-app upload.

### Phase 7 hardware checklist (minilogue xd)

Result (user, 2026-09-30): every unit below tested OK on a real xd, including tempo sync and
the in-app upload, except the first echo, rebuilt as described in its entry; the rebuilt one is stereo (user).

Units in `logue-sdk/platform/minilogue-xd/lp-xdfx-*/fx.mnlgxdunit`, from
`scripts/stageXdFxUnits.ts` (SRAM use in brackets, of 6 KB modfx / 12 KB delfx/revfx):
- **LP FX Pass** (DELAY, 440 B): transparent at every knob position.
- **LP FX LP Mix** (DELAY, 612 B): Shift+Depth fades dry -> lowpass; Time is the cutoff (closed
  at 0, so fully wet + Time 0 is silent). Mono out.
- **LP FX Ring** (MOD, 1100 B): Depth fades dry -> ring modulated; Time is the ring frequency
  (middle C at the centre, +-2 octaves).
- **LP FX Echo** (DELAY, 1632 B, 1 MB SDRAM): Time moves the left line, the right stays at
  0.73 s; Depth = feedback, Shift+Depth = mix. (First version: both lines on Time, which the
  xd's mono voice made sound mono -- identical sides, by construction; user, 2026-09-30.) **LP FX Sync**: the same at the device tempo, Time picks the division -- does
  `fx_get_bpmf` follow the xd's tempo (change BPM while it plays)?
- **LP FX Full** (REVERB, 2.25 MB of the 2432 KB SDRAM): loads and echoes; a short dropout when
  it's switched in or resumed is the 2.25 MB clear.
- The examples: **LP Reverb** (REVERB, 4716 B; Time = decay, Depth = damping, Shift+Depth =
  dry/wet), **LP AutoWah** (MOD, 5540 B -- 90% of the modfx's 6 KB), **LP Swell** (MOD).
- For each: does a knob's authored start hold until it's turned (the xd may or may not send the
  knob positions on load -- `knobInits` covers "not")? Any hang (the xd osc hang signature)?
  The effects MCU has no CPU readout, so the reverb is the one to listen to for dropouts.
- Upload one from the app (Build Results' upload icon) rather than Kontrol Editor: no xd
  effect upload has been captured, so the header the app builds for it (`num_param` 0) is
  unverified.

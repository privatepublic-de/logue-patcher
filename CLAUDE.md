# logue-patcher

Electron/TypeScript/React patcher-style editor for building Korg *logue SDK oscillators
(minilogue xd, NTS-1 mkII). macOS-only.

## What this is

A visual node-graph editor: build a flat DSP graph from a fixed *logue primitive registry
(`logue-codegen/src/primitives/`, 103 primitives, 5 of them superseded and 4 internal, both hidden) and either **Export** (write generated
source only) or **Build** (a real compiled, installable unit) for either platform. Forked from
`axo-modern` (an Axoloti patcher GUI) — all Axoloti-specific code has been removed; only the
canvas/tab/IPC chassis (React Flow, Zustand, Electron IPC scaffolding) survives.

## Repository & licensing

- Public at https://github.com/privatepublic-de/logue-patcher (`origin`), MIT. Published
  2026-10-03 as one fresh commit: the pre-publication history (which contains axo-modern's
  port of Axoloti's GPL-3.0 code generator and copied Axoloti object fixtures) lives only in the
  local branch `archive/full-history`, linked to `main` by a local `git replace --graft` so
  `git log`/`blame` still reach it here. Push `main` (and new feature branches) only -- never
  `archive/full-history`, `--all`, `--mirror` or `refs/replace/*`.
- Code taken from elsewhere must be permissively licensed and keep its notice: Korg's logue SDK
  (BSD-3-Clause) is embedded in `logue-codegen/src/minilogue-xd/` and the harnesses, with the
  notice in `THIRD_PARTY_NOTICES.md`. Regenerate that file after a dependency change
  (`node scripts/write-third-party-notices.mjs`). Nothing GPL, including Axoloti objects.

This file holds current rules only. Why a constant or workaround is what it is -- the user
reports, measurements and reversals behind it -- is in `docs/HISTORY.md`; add new stories there,
not here.

## Architecture

- Renderer: React + React Flow (xyflow) canvas, Zustand stores — `patchStore.ts` (per-tab
  document state; every edit goes through `commitDoc`, pure document helpers live in
  `patchDocHelpers.ts`), `tabsStore.ts` (global tab list), `buildResultsStore.ts` (global,
  session-only build/export history), `subpatchLibraryStore.ts` (global cache of the saved
  subpatch library, see "Subpatches").
- Main: Electron IPC handlers under `main/ipc/*`, typed end-to-end via `shared/ipc/contract.ts`
  (`AxolotiIpcApi`/`IPC_CHANNELS` — single source of truth for preload/main/renderer; changing
  either object needs a hand grep, see "Electron / IPC" below).
- `logue-codegen/`: separate, dependency-free package (no Electron/DOM import) — the primitive
  registry and both platform code generators, directly unit-testable. Both generators and both
  estimators start from `resolveUnit.ts` (flatten subpatches, resolve, platform checks).
- File format: `.loguepatch`, plain JSON (`shared/json/patchCodec.ts`), `PATCH_FILE_VERSION = 4`
  (3 -> 4 changed what five wired inlets mean, see "Primitive-authoring conventions").
  A subpatch definition is a `.loguesub` — the SAME codec and document shape, marked
  `settings.subpatch`. No more Axoloti XML, no more `.axlogue`.

## Domain model (`shared/domain/patch.ts`, `paramValueTypes.ts`, `appSettings.ts`)

- `PatchNode` = `ObjNode | CommentNode` — no nested documents, no
  "zombie/unresolved" node kind. A subpatch instance is a plain `ObjNode` whose `type` is
  `sub/<path>`, a live reference to a library file (see "Subpatches"), never an embedded copy.
  A legacy Axoloti `kind: 'hyperlink'` node (a link whose target was its `name`) still loads, as
  a comment showing that target (`patchCodec.ts`, 2026-09-28); nothing writes one any more.
- `PatchDocument`: `{nodes, nets, settings, notes}`. `Net`: `{sources: NetSource[], dests:
  NetDest[]}` (every real net has exactly one source; not enforced at this layer).
- `ObjNode.sample?: SampleAsset` (`{sourceName, sourcePath?, rate, encoding: 'mulaw8' | 'pcm8' |
  'wt8', data (base64), truncatedFromSeconds?, resampledFromRate?, loopStart?/loopEnd?,
  frameLength?/frameCount?}`; loop end exclusive, both or neither) -- read by `logue/osc/granular`
  (mu-law only; a `pcm8` one is an
  instance problem) and `logue/osc/sample` (`pcm8`: linear signed 8-bit at the source's own
  rate, `importPlainSample`; a mu-law one is converted at generation). `wt8` (2026-10-04, `docs/PLAN-wavetable.md`; read by `logue/osc/wavetable`) is
  `frameCount` (2..64) single cycles of `frameLength` (128/256/512) signed 8-bit points from
  `importWavetable` (pitch-tracked, one cycle rebuilt per position from its harmonics, frames
  phase-aligned); the codec checks the shape, rejects a loop on it, and the two sample players
  report it as an instance problem (the wavetable reports the other two). Which import a primitive
  wants is `LoguePrimitive.sampleImport` (`granular`/`plain`/`wavetable`). Deliberately on the
  node, not a document-level asset table: copy/paste and subpatch flattening carry it for free,
  and codegen dedupes identical samples by content hash anyway. Added without a file-version
  bump (plain optional field, the `unitName`/`label` precedent).
- `ObjNode.bus?: string` (2026-10-04): a bus node's bus name (see "Buses"), on the four bus
  node types only; absent reads as `''`. No file-version bump (the `sample` precedent).
- `PatchSettings`: `{logueTarget?: {module: LogueModule}, unitName?: string, subpatch?: true}`
  (`LogueModule = 'osc' | 'modfx' | 'delfx' | 'revfx'`; only a (platform, module) pair with a
  `logue-codegen/src/unitKinds.ts` entry builds -- since 2026-09-30 all eight; see
  `docs/PLAN-effects.md`)
  (`subpatch` marks a definition — the authoritative check, not the extension). **No `platform` field
  anywhere** — a document is fully platform-agnostic, with no document-level "current platform"
  concept at all. A platform is chosen only by the session-global (non-persisted)
  `targetPlatformStore.ts`, shared by `BuildPanel.tsx`'s build-target toggle and the Param Matrix.
- `LoguePlatform = 'nts1mkii' | 'minilogue-xd'` — the one canonical platform-literal type, used
  by param slot maps, primitive `platforms?` restrictions, and UI badges.
- `ParamValue`: `{name, value, logueParamIndex?, label?}`. `logueParamIndex` is `LogueParamSlot =
  Partial<Record<LoguePlatform, number>>` — each platform independently remembers its own
  device-menu slot for the same param (edited via the Device Param Matrix, see "Canvas & UI").
  `label` sources a param's exported manifest name: a `freeLabel` param's (`logue/sense/control`)
  typed name, or — stamped by the flattener — a promoted subpatch param's outer/instance name;
  unset, the fixed spec name is used. `subpatchExpose?: {outerName}` (definition docs only)
  promotes an inner param onto the subpatch's outer interface. `logueKnob?` (per platform:
  an oscillator's `shape`/`shape-2`; an effect's `time`/`depth`,
  plus `mix` on delay/reverb (NTS-1 mkII's MIX row, the xd's Shift+Depth) -- which unit kind
  has which is `unitKinds.ts`' `knobs`) and
  `logueFollow?` (per platform, a slot
  number) are the other two device controls a param can have -- see "Graph resolution".
- `AppSettings` (persisted to `~/.logue-patcher/app-settings.json`): `windowBounds`,
  `sidebarWidths`, `logueSdkPath`, `armToolchainPath`, `buildOutputFolder`, `subpatchLibraryPath`,
  `uploadAlwaysReplace` (Upload dialog: skip the "Replace slot N" confirmation, both devices),
  `recentFiles` (the start screen's list, newest first, max 8: Electron can add to macOS's Open
  Recent but can't read it back, so main keeps its own on every open/save, `main/config/recentFiles.ts`).
- Two storage cleanups were identified but deliberately deferred, still open today: collapsing
  `Net.sources[]` to a single source, and switching node identity off `name` onto a stable id.

## logue-codegen (primitive registry)

103 primitives (`PRIMITIVES.length` in `primitives/registry.ts` — always re-count directly against the array; this doc's own
history has drifted stale more than once). Categories by id's `logue/<cat>/*` segment: `osc` (15:
sine/saw/square/pulse/triangle/additive/granular/sample/wavetable/noise/lfsr/exciter/sync/phase-dist/bass-support), `mix` (11: mix2/crossfader/pan/pan-mix2/width/stereo-mix2/stereo-crossfader, plus the internal bus-send/bus-receive/bus-send-stereo/bus-receive-stereo -- see "Buses"), `filter` (11:
lowpass-cheap/highpass-cheap/comb/string/svf/ladder/eq-band/tilt/formant/allpass/hilbert), `gain` (1: vca), `env` (6: ad/ahd/adsr/one-knob-adsr/multistage/follower), `lfo` (7:
sine-lfo/triangle-lfo/square-lfo/ramp-up/ramp-down/random-steps/fast-square), `sense` (10: pitch/control/gate/velocity/tempo, plus
the superseded shape/shape-2/cutoff/resonance/param), `util` (15: constant/unipolar-to-bipolar/bipolar-to-unipolar/
glide/slew/sample-hold/sample-delay/delay/long-delay/quantize/freq-shift/buffer/buffer-tap/grain/reverse-tap), `shape` (3: wavefolder/soft-clip/drive), `math` (11: negate/one-minus/curve/add/subtract/multiply/scale/min/max/
clamp/abs), `logic` (10: greater-than/less-than/equal/and/or/xor/schmitt/edge/chance/round-robin), `mux` (3: mux2/
mux4/demux2).

**File layout** (split 2026-09-28, a verbatim move): `primitives.ts` is only a barrel re-exporting
the public names, so every import site stays `.../primitives`. The code lives in
`primitives/`: `types.ts` (the interfaces), `shared.ts` (helpers and param specs used by more than
one category: `COARSE_PARAM`, `NOTE_W0_HELPER`, `additiveInletExpr`, `onepole`/noise helpers, ...),
one file per category (`osc`, `filter`, `lfo`, `env`, `math`, `logic`, `mux`, `mix`, `gain`,
`sense`, `util`, `shape`), and `registry.ts` (`PRIMITIVES`, the rename map, `findLoguePrimitive`,
`directHelpersOf`). Keep it layered `types` <- `shared` <- categories <- `registry`: a helper a
second category needs moves to `shared.ts` rather than being imported sideways. There is
deliberately no `primitives/index.ts` (it would make `./primitives` ambiguous with the barrel).
A primitive's palette category still comes only from its id, not from which file it's in.

**`LoguePrimitive` interface** (`primitives.ts`): `id`, `description` (user-facing, shown in
Inspector), `platforms?` (omit = both platforms; only `sense/cutoff`/`sense/resonance`/
`sense/param` are minilogue-xd-only — dead on NTS-1 mkII per Korg's own header comments — and
`sense/velocity` is NTS-1 mkII-only, since the xd's `user_osc_param_t` carries no velocity),
`supersededBy?` (kept only so older documents build: hidden from the palette, rewritten on open --
see "Rename safety"),
`inlets?`/`outlets?` (omit outlets = implicit single `'out'`; multi-outlet primitives, via
`renderOutletStatements` instead of `renderExpr`, are `logue/filter/svf`/`logue/filter/formant`/
`logue/filter/hilbert`/`logue/util/freq-shift`/`logue/util/reverse-tap` (genuinely simultaneous DSP taps), `logue/mux/demux2` (2026-09-25, a routed passthrough, no
shared per-sample state so it needs no helper function either), and every `logue/sense/*`
primitive except `gate` (2026-09-25, a `unipolar`/`bipolar` pair off the one reading — see
"Per-primitive gotchas")), `stateBytesPerInstance` (required, hand-counted, backs the RAM estimator),
`memberDecls`/`initStatement?`/`renderExpr`/`advanceStatement`, `instanceHelpers?(node)`/
`instanceProblem?(node)` + `initStatement`'s optional 2nd `node` arg (the only node-aware hooks,
added for `logue/osc/granular`'s baked sample -- every reader of `helpers` goes through
`directHelpersOf` so codegen and the RAM estimate can't disagree; `instanceProblem` is checked
for ACTIVE instances only and also surfaces as an `'instance-problem'` unresolved reference),
`helpers?` (`HelperBlock[]`,
deduped across instances by `key`; `HelperBlock.sharedBytes?` covers an embedded baked table like
`logue/osc/additive`'s wavetables — emitted ONCE regardless of instance count, a genuinely
different cost dimension from per-instance state), `params?` (`PrimitiveParamSpec[]`:
`name/min/max/default`, optional `freeLabel`/`step`), `renamedParams?`/`renamedInlets?`
(`FieldAlias[]` — see rename-safety below), `noteOnStatement?`/`noteOffStatement?`
(always-emitted hooks into a real `noteOn`/`noteOff` on both platforms, harmlessly empty when
unused). `shortLabel?` (header text instead of the id: `uni→bi`, `−x`, `z⁻¹`, `a−b`) and `defaultName?` (a
new instance's name: `u2b`/`b2u`) are display-only; palette search matches both.

**Presentation metadata lives on the specs** (2026-09-28; it used to be four side tables keyed by
id string, which had drifted): `PrimitiveParamSpec.unit`/`modulatedBy`/`booleanWidget`/`trackGate`/
`nts1mkiiType`/`select`, and `PrimitiveInletSpec.trackGate`. The types and shared values (units,
`TRACK_WIDGET`, `PITCH_TRACKED_GATE`, ...) are in the import-free `paramPresentation.ts`;
`paramUnits`/`paramModulation`/`paramTrackGate`/`paramDeviceType` keep their `find*` API as thin
lookups over the registry. `booleanWidget`/`select`/`nts1mkiiType` also shape the device
manifest/header, so changing one is a device-facing change. A shared spec constant
(`COARSE_PARAM`, ...) gets per-use metadata via a spread (`{ ...COARSE_PARAM, trackGate: ... }`),
never by mutating the shared object. `test/logue-primitiveSnapshots.spec.ts` holds golden generated
source for every primitive on both platforms (unwired, all inlets wired, booleans flipped, every
param exposed); a registry refactor meant to be output-neutral must leave
`test/__snapshots__/primitives/` untouched. `logue-primitivePresentation.spec.ts` fails for a
control inlet no param's `modulatedBy` names (signal/operand inlets like `in`/`a`/`fm`/`trig` are
listed there as exempt; `pitch` is linked to COARSE). Additive/string COARSE/FINE got the NTS-1
mkII `semi`/`cents` types that way -- a header change not yet seen on a real device.

All primitive math is plain float, shared verbatim between both platforms' generators (except
the minilogue-xd-only `sense/*` primitives) — minilogue xd's own real reference source computes
in float too, only casting to Q31 once at the final output sample (an output-format cast, not a
fixed-point DSP pipeline). This file has a standing **"no libm" rule** for cheap synthesis math
(`cutoff_warp`, `env_rate_from_percent`, `lfo_rate_from_percent`, `comb_response_warp` all use
polynomial/rational approximations instead). No primitive calls libm any more: svf's tracked
`tan` is `svf_tan` (range-reduced Padé, float-exact) since 2026-09-30, and formant/bass-support
use a Taylor-series `tan`.

**Primitive-authoring conventions** (recurring patterns, not enforced by the type system — worth
matching when adding a new one):
- A wireable inlet that drives a dial is one of two shapes. **Additive** is the rule
  (`effective = control + incoming*depth`, clamped to the control's own range): `depth` is half
  of a 0-100 param's range or a pitch param's own semitone max, never an invented constant, except
  the filters' `cutoff` (and eq-band `freq`, tilt `center`), crossfader `fade`, additive `timbre`, phase-dist `dcw` and wavetable `position`, which use the whole range
  (depth 100) so one LFO sweeps closed to open. The formula needs no bipolar/unipolar branching:
  the dial is the centre and any source moves it sensibly. **Replace** is the exception, kept only
  where it's the natural meaning: `vca`'s `gain` (an envelope must close it whatever the dial
  says) and the mux selectors `sel`/`index` (a gate picks an input). Those five additive inlets
  replaced their dial until file version 4 (user's call, 2026-10-01, after a stereo-filter patch
  that wired a bipolar LFO into a replacing `cutoff` and sat almost closed);
  `migrateAdditiveDialInlets` (`shared/json/additiveDialInletMigration.ts`) sets a v3 file's
  wired ones to dial 0, where `clamp(0 + x)` is the old `clamp(x)` exactly. Inexact cases (none in
  the examples or the user's library at the time): a definition's inlet fed by an inlet port, whose
  instance leaves that port unwired, used to hear the dial and now hears 0; a promoted one keeps
  each instance's value, now live; one with a device control (slot/knob/follower) becomes a live
  control, and a slot keeps its old menu value across an upload (see "Gotchas").
- "Store the raw percent, convert to the real coefficient/rate at point of use inside
  `renderExpr`" is a deliberate, repeated refactor target (`WIDTH`, `RATE`, `FM_DEPTH`, `DRIVE`,
  `ATTACK`/`DECAY`, comb's `FEEDBACK`/`DAMPING`) — required so an additive wired inlet can add in the
  same domain the dial is authored in, before the (often nonlinear) conversion happens.
- When a primitive's NEXT state depends on the sample just computed (not independently
  advanceable like an oscillator's phase), the mutation lives inside a static helper called FROM
  `renderExpr` itself (`onepole_step`, `ad_env_step`, `noise_step`, `sample_hold_step`), with
  `advanceStatement` a real, intentional no-op — not an oversight.
- **Keep the real call shape at `process -> leaf`** on minilogue xd: a helper called per sample
  from `renderExpr` must not itself make real calls into other helpers -- mark the whole chain
  `static inline __attribute__((always_inline))`. Two real xd hangs (formant, granular) had
  exactly that `-Os` shape with sound math, and both were cured only by inlining; check the
  staged build's `objdump` for `bl` below `Osc::process` (only leaf `note_w0`/`*_step` calls are
  hardware-proven).
- **Per-block work goes in `blockConstants`** (2026-09-28): an expression that only reads params
  and the played note while its inputs are unwired is computed once before the sample loop as a
  `const float blk*_<suffix>` local, via `blockValue()` (`primitives/shared.ts`), which yields both
  the loop's reference and the declaration from one call so they can't disagree. Used by `svf`
  (tracked `svf_tan`, `k`), `comb`/`string` (`1/note_w0`, gain, damping, dispersion) and both
  envelopes (the two rate divides). Params only change between blocks, so output is unchanged:
  harness renders of all of them, wired and unwired, were byte-identical before/after.
  `logue-feedback.spec.ts` pins that a block constant never reads a wired inlet or a `y_` value.
  Emulator (`scripts/measureXdCycles.ts`, xd, cycles/sample incl. a saw/noise source): svf tracked
  405 -> 197, svf free 232 -> 193, comb tracked 183 -> 53, string 489 -> 361, ad/ahd 241/239 ->
  153/152. `formant`'s coefficients are block constants since 2026-10-06 (see
  "`filter/formant`"): 495 -> 102 base.
  `svf`'s `1/(1+g(g+k))` was still divided every sample inside `svf_step` until 2026-10-05: it
  now redoes it only when g or k changed (exact; see "`filter/svf`"). The cheap one-poles' unwired CUTOFF warp is a
  block constant (`blkOnepoleA`) since then too, and `env/multistage` converts its stage times
  where they're set.
  Every oscillator's transposed `w0` (`transposedW0`, 2026-10-03: sine/saw/square/pulse/
  triangle/additive, fast-square's TRACK) is one too while `pitch`/`harmonic` don't move -- they
  called `note_w0` once or twice a sample. xd emulator base cycles: sine 110 -> 50, saw 153 -> 86,
  square 153 -> 100, pulse 155 -> 97, triangle 90 -> 29, additive 231 -> 178, fast-square TRACK
  69 -> 11. Harness renders identical except with `harmonic` wired (<= 1e-6 of full scale: the
  `w0 * ratio` product is rounded per block instead of folded into the phase add per sample).
  In an effect the stand-in `osc_w0f_for_note` (`fastpow2f`) is dearer still, so a moving
  `pitch` there costs ~170-330 cycles more than a still one.
- **Knob-only math is computed once per block** (2026-10-01, `oscBody.ts`' `hoistedSuffixes`): a
  `pure` primitive (stateless: `math/*`, `util/constant`, the polarity converters, `mix/mix2`, the
  stateless `logic/*`, `sense/control`) whose wired inlets all come from other such instances is
  emitted before the sample loop, after the knob reads. Its outputs are registered as per-block
  values (`withBlockInvariantVars`), and `blockValue` treats an inlet wired from one as
  unwired, so a reader's conversion (an envelope rate, an LFO rate) becomes a block constant too
  (`isBlockInvariant`; `env/ad`'s rate path checks it before choosing `env_rate_ctl`). Output is
  identical. Outside generation the set is empty, so `logue-feedback.spec.ts`' "a block constant
  never reads a wired inlet" still holds for a per-sample input; `logue-hoisting.spec.ts` pins
  the rules. Found getting grain-mill's xd unit under its CPU limit: 814 -> 681 emulator cycles
  (the ENV curve, Time/Depth scaling and the clock rate). Mark a new primitive `pure` only if it
  has no init, advance, note hook or non-param member. A `blockValue` expression must name only
  params, members and the inlet vars themselves -- never a local the primitive declares inside
  the loop: `freq-shift` built its wired SHIFT into a loop-local `sh_` and stopped compiling once a
  per-block shift was hoisted (caught by the code-size run; `logue-hoisting.spec.ts` now wires
  every primitive's inlets from constants and checks no pre-loop code names a loop-local).
- A primitive's members must not be named `y_<suffix>`: that's every instance's per-sample output
  local, which shadows the member inside the loop (`util/slew`'s first version stepped an
  uninitialised local; `logue-memberNames.spec.ts` pins it).
- `helpers` is `HelperBlock | HelperBlock[]` specifically for a primitive needing two genuinely
  independent helpers with no real dependency between them — `dependsOn` only ever resolves
  against the small, fixed `HELPER_REGISTRY` (the `polyblep` family); don't assume it works as
  generic metadata for arbitrary helpers, list every helper a primitive needs directly.
- A standalone "plain attenuator"/"plain S&H" primitive has been proposed and declined more than
  once: `logue/gain/vca` with `gain` left unwired (or `logue/lfo/random-steps` with `in` unwired)
  already emits byte-identical code to a dedicated primitive — confirmed by reading actual
  codegen output, not assumed.
- A primitive's palette category is derived ENTIRELY from its own id's middle path segment
  (`logue/<category>/name`) — no separate category table exists, and the id string is never
  emitted into generated C++, so renaming a primitive's category is purely cosmetic (needs no
  Docker/harness re-verification, just updated test strings).
- No audio-rate/control-rate type system exists anywhere in resolution — every instance computes
  one plain per-sample float regardless of role; `ports.ts`'s `role` (see "Canvas & UI") is
  display-only. A control inlet and an audio inlet are the same mechanism, just wired to a
  different upstream node shape. Fan-out (multiple readers of one instance) is free — repeated
  variable references, never recomputed. The one exception is the **buffer wire** (2026-09-30,
  `docs/PLAN-grain-mill.md`): a `buffer`-role inlet (`isBufferInlet`) takes an outlet whose
  `outletPolarity` is `'buffer'` (`isBufferOutlet`, `util/buffer`'s `buf`) -- a reference to the
  writer's SDRAM ring, not a value. `oscBody.ts` hands the reader the writer's suffix instead of
  a `y_` variable (`bufferRef`, `primitives/util.ts`: `sdram_`/`bufLen_`/`bufW_`), and a buffer
  outlet into any other inlet (or the reverse) is an export error, a refused connection and a
  dashed wire (`portKindsAgree`, `ports.ts`; a subpatch's port nodes are exempt, and an inlet
  port that feeds a buffer inlet inside gets the `buffer` role on the instance).
- **Gate convention** (2026-09-25, `logue/logic/*`/`logue/mux/*`/`logue/sense/gate`/both
  envelopes' `trig`, every `logue/lfo/*`'s `trig`): a gate/boolean signal is a hard `0.f`/`1.f`, and anything READING one
  thresholds at `>=0.5f` rather than an exact `==1.f`/`!=0.f` check — chosen over a `+-1` bipolar
  gate so it composes for free with a multiply (`math/multiply`/`vca`'s `gain`: `0`=mute, `1`=unity,
  whereas bipolar would make "closed" INVERT the signal) and so a raw bipolar `+-1` square LFO
  wired straight into a gate input just works (`-1`/`+1` both read as a clean false/true). See
  "Per-primitive gotchas" for the full writeup and how `logue/logic/greater-than`/`less-than`/
  `equal` collapse a variable-vs-constant compare and a variable-vs-variable compare into one
  primitive.

**Superseded primitives** (2026-09-29, phase 2 of "device controls"): `sense/shape`/`shape-2`/
`cutoff`/`resonance`/`param` are `supersededBy: 'logue/sense/control'`. They stay in the registry
with their own codegen (a library definition that was never re-opened still builds byte-identically),
but `listInsertablePrimitives` hides them, palette search finds `control` by their names
(`formerPrimitiveIds`), and `normalizeRenamedFields` rewrites them on open/paste: a knob reader
becomes a control with `VALUE` 0 bound (`logueKnob`) to that knob on every platform the old one
ran on, except `sense/cutoff`/`resonance`, which become an unbound control (the xd's filter knobs
never reach an oscillator, see "Real *logue SDK facts"); `sense/param` keeps its VALUE entry (value, label, slots). Outlets are the same names, so
wires stay. Not a `RENAMED_PRIMITIVE_IDS` entry because the rewrite also sets a binding.

**Rename safety** (`primitives.ts`, `unresolvedReferences.ts`): `RENAMED_PRIMITIVE_IDS` is a flat
old-id→current-id map (`findLoguePrimitive` consults it transparently everywhere) for a pure
primitive rename/merge (10 so far: `sense/shift-shape`+`shape-alt` -> `shape-2`, `noise/white`
-> `osc/noise`, `delay/comb` -> `filter/comb`, `filter/lowpass` -> `lowpass-cheap`,
`util/invert`/`util/curve` -> `math/*`, `math/invert` -> `math/negate` (`util/invert` too), `mix/ringmod` -> `math/multiply` (inlets kept
`in1`/`in2`), `lfo/sample-hold` -> `lfo/random-steps`, `util/trig-hold` -> `util/sample-hold`).
Palette/insert-popup search
also matches a primitive's former NAMES (`formerPrimitiveIds`, last id segment only), so "ringmod"
still finds `multiply` while "mix" doesn't; `LoguePrimitive.searchTerms` adds words that are neither
("invert" lists both `negate` (-x) and `one-minus` (1-x), since the word means either).
**Opening or pasting a document rewrites old names** (`renamedFields.ts`'s
`normalizeRenamedFields`, in `patchStore.ts`'s `arrangeForLoad` and paste, 2026-09-28): old ids and
every value-preserving param/inlet alias become the current names, so the canvas and the store only
ever see current names -- the canvas draws a wire by its stored inlet name, and `setLogueParam`
edits by stored param name (an alias used to get a second entry, without the device slot).
Subpatch definitions read by main for Export/Build aren't normalized; codegen resolves aliases
itself. Meaning-changing aliases are left for `findUnresolvedReferences`.
`LoguePrimitive.renamedParams`/`renamedInlets` (`FieldAlias`: `{from, to, valuePreserving,
note?}`) cover a FIELD rename on the SAME primitive id — `valuePreserving: true` (e.g. comb's
`GAIN`→`FEEDBACK`) silently carries the old value across; `false` (e.g. `DELAY`→`TUNE`, which
also inverted direction) is recognized but NOT auto-applied — carrying a stale value across a
meaning-inverting rename would silently produce a musically wrong result — `findUnresolvedReferences`
flags it instead (see "Canvas & UI"). UUIDs for node/param identity were explicitly considered
and rejected: a UUID scheme still needs the identical hand-maintained rename mapping, for
strictly less grep-ability through generated C++/test output.

**Graph resolution & param exposure**:
- `oscInstances.ts`'s `resolveAudioGraph`: topologically-sorted DAG walk backward from the one
  `logue/io/audio-out` node. One net per inlet (fan-in throws, naming every conflicting source),
  no cycles except through a `LoguePrimitive.delayedInlets` inlet (only `logue/util/sample-delay`'s
  `in`) or a buffer inlet: that source is visited from a queue after the main walk and never
  orders the graph (so a writer reached only through buffer wires is still emitted);
  any other loop throws, naming sample-delay as the fix. An instance unreachable from the output gets **zero** codegen — no member
  decls, no state, nothing.
  In an effect document (`isEffectModule`, `unitKinds.ts`) audio-out takes `l`/`r` instead of
  `in` (an unwired `r` copies `l`; result in `stereoSinks`), and the optional pseudo-node
  `logue/io/audio-in` (outlets `l`/`r`/`mono`, root only, effect documents only) is a source
  whose variables the generator declares itself (`audioInSuffix`). A primitive's `modules?`
  (omit = all) is checked like `platforms?` (`assertPrimitivesSupportModule`); every
  note/knob-reading `sense/*` except `control` is `['osc']`, and a subpatch intersects both.
- `oscParams.ts`'s `resolveExposedParams` binds `logueParamIndex[platform]` to a param spec,
  validated per-platform (`maxParamCount`: minilogue xd 6, NTS-1 mkII 10 — 2 of NTS-1's 10 are
  permanently reserved, see below). minilogue xd additionally requires exposure to be a
  contiguous run from 0 — no "unused slot" manifest sentinel exists there (NTS-1 mkII has one,
  so gaps are fine there). `rejectExposedParamsOnInactiveInstances` guards an exposed-but-unwired
  instance (maps to nothing on a real device).
- NTS-1 mkII reserves param slots 0/1 **unconditionally on every build** (`reserveFixedKnobSlots`)
  for the device's own fixed Shape/Alt-Shape knob pair, regardless of whether any `sense/*`
  primitive is placed — every real shipped Korg example does this; omitting it caused a real
  Kontrol Editor "Wrong number of unit params" rejection once.
- **Knob bindings and slot followers** (2026-09-29, phase 1 of "device controls"; edited in the
  Param Matrix since phase 3): at most one of `logueParamIndex`/`logueKnob`/`logueFollow`
  per param per platform (`resolveKnobBindings` rejects two). A knob-bound param is set from the
  knob's position member (`shape01_`/`shape2_01_`/`cutoff01_`/`resonance01_`, so Shape includes the
  device's Mod-LFO like `sense/shape`) at the start of every block, ahead of the block constants,
  over its whole range: selects in equal zones, checkboxes at half travel, stepped params rounded
  (`positionToParamStatement`). Any number of params may share a knob; the first one (graph order)
  sets the knob's starting position (`init()`, and NTS-1 mkII's slot 0/1 header `init`) so it keeps
  its authored value until the device reports the knob. A follower is set inside its lead's
  `setParameter` case from the lead's position over the lead's DEVICE range (`attachSlotFollowers`);
  the lead (the param exposed at that slot) alone defines the menu row. Following a slot nobody
  owns, or NTS-1 mkII's knob slots 0/1, is an error. Inside a subpatch definition a knob binding is
  kept (fixed hardware every instance can share) but a follower is stripped like a slot; a promoted
  param takes the instance's slot/knob/follower. The CPU gauge treats every bound param as
  device-reachable. Both platforms link (`scripts/stageKnobBindings.ts`), and an xd harness sweep
  of Shape/Shift-Shape/slot values is ASan/UBSan-clean with the follower tracking its lead.
  Confirmed on a real xd and a real NTS-1 mkII (Shape, the second knob, a follower; user,
  2026-09-29).
- Two platform generators (`nts1mkii/generateOscUnit.ts`, `minilogue-xd/generateOscUnit.ts`)
  share `oscInstances.ts`/`oscParams.ts`/`oscBody.ts` but differ in outer shape: new-gen emits an
  `Osc : public Processor` class + `header.c`; old-gen emits a plain struct + free
  `OSC_INIT`/`OSC_CYCLE`/`OSC_PARAM` functions + `manifest.json`, with its whole build scaffold
  (Makefile/linker scripts) embedded as literal strings for a self-contained export.

**RAM estimate** (`estimateOscStateCost.ts`, live in `BuildPanel.tsx`; drawn by the same
`UsageGauge.tsx` as the CPU gauge, green up to 75% of the budget, red at 100%): three tiers, all real not
fabricated — per-instance (`stateBytesPerInstance` summed over active instances), shared-helper
(`HelperBlock.sharedBytes` summed once per deduped active helper, not per instance), and a fixed
per-platform baseline (the always-declared sense-bridging members every generated `Osc` class
carries regardless of graph content) make `stateBytes`. **Code** (`codeBytes`, 2026-09-30) is
measured, not hand-counted: each unit kind's `fixedCodeBytes` (a constant into the output /
a pass-through) plus the primitives' code from `codeSizeTable.ts`, GENERATED by
`scripts/measureCodeSizes.ts` (~1000 real builds in ~40 s, parallel: per platform x
oscillator/effect, one and two instances of every primitive, all inlets wired and none; the xd
links with an enlarged SRAM region so oversize units can be sized). An instance costs `first`
(the first of its primitive) or `extra`, interpolated between the unwired and the wired
measurement by the share of its inlets wired; out-of-line functions a primitive brings
(`note_w0`, a `*_step` leaf, `memset`, found with `nm`) are tabled once and
counted once per unit. Tables already in `sharedBytes` are subtracted, and every measured bss
delta matched `stateBytesPerInstance`. Against whole builds (`scripts/checkCodeSizeEstimate.ts`,
examples + oscillator patches, both platforms): -7%..+23%, usually over; the worst is several
polyBLEP oscillators together (GCC inlines shared code for one caller, shares it for several).
The table is for the GCC it names (the local-toolchain drift risk); `logue-codeSizeTable.spec.ts`
warns on a missing/stale entry (the primitive's snapshot hash) and on a changed unit shell (a
hash per context: the fx goldens, `util.constant`'s), `CODE_SIZE_STRICT=1` fails. Budgets are each unit kind's `ramBytes`: minilogue xd
oscillator 32768 (real linker-script SRAM); NTS-1 mkII oscillator 49152 (Korg's own published
"Max RAM Load Size" for this dynamically-linked-ELF platform — NOT a linker-script constant;
this platform is source-only, so don't assume "no linker script" means "no published limit"). **CPU (minilogue xd, 2026-09-28)**: `estimateOscCpuCost.ts`, shown in `BuildPanel.tsx`
for the xd target only, sums `cpuCostTable.ts` -- GENERATED by `scripts/measureCpuCosts.ts`, which
builds every primitive for real and runs it in the unicorn emulator per variant (`base` = audio
inputs wired; `control`; each checkbox flipped, with/without control wiring; granular's two
documented heavy settings), minus a one-constant baseline unit. Each instance counts the variant
matching its switches and wiring (not its worst case: that read cpiano 27% high). `maxCyclesPerVoice` adds
what the device knobs can reach: an xd-exposed checkbox in either position, and a primitive with
`heavy-*` variants (granular) at those once an exposed param or a wired control input can move
its settings. Emulator scale, not hardware; checked against measuring whole patches: -7%..+16%.
**Wired inputs are measured twice** (2026-10-06): `control` from white noise (a gate inlet,
`trig`/`gate`, from a square LFO; both sources' own cost measured and taken off), so a per-sample
path is what's counted -- svf 43 -> 115, TRACK 212, sine-lfo 36 -> 85; and `control-still` from
constants, which knob-only hoisting makes per-block: most readers then take their unwired path
(svf 43), some don't (bass-support 392 against 265 unwired). The estimator picks per instance:
a hoisted instance costs 0, a reader whose control inputs all come from hoisted ones counts
`control-still`, anything moving `control` (`estimateOscCpuCost.ts`). Before, `control` was
measured with constants only and understated a moving source (adsr's 38 below its base 46).
Audio inputs (`base`) come from the noise too.
**The gauge is in REAL cycles** (2026-10-06, `oscRealCycles`, `cpuZone` converts): measured
through audio telemetry (see "Hardware test harness"), xd real = 17 + 1.54 x the estimate per
voice (18 distinct patches, -30..+30 %), NTS-1 mkII 0.77 x (18, -29..+28 %): the fits with the
smallest worst error (`calibrateOsc.ts --refit`, no device: recomputes the stored readings'
estimates with the current table). With the constants-only table they were 164 + 1.40x (+-31 %
at best) and 44 + 0.83x (+-42 % at best). Per-instance costs stay on the emulator's scale (the
tooltip says so). xd anchors
(`cpuCeiling.ts --xd --osc`, a sine burning an exact load): with 4 notes held a voice is clean at
1225 and breaks up from 1250 (`XD_OSC_HANG_CYCLES` 1225, red); one voice ran to 1290 and FROZE at
1300 (kept sounding, MIDI dead: the hang signature). Green to 858 (`XD_OSC_CLEAN_CYCLES`, where a
30 % under-read still clears), amber "tight" between. Old reports agree: cpiano (estimate 404,
~640 converted, 921 measured) plays chords fine; formant before its per-block coefficients
(655 -> ~1030, ~1700 measured) and a
granular patch (~795 on the old table -> ~1240) hung it -- `logue-cpuCostTable.spec.ts` pins those and that every
calibrated patch stays below red. The Build panel's gauge: a solid fill for the saved settings,
a faint extension up to the knob maximum, and one line ("fine" / "tight" / "may hang", plus the
knob-reachable zone when it differs); numbers and the biggest costs are in the tooltip. `logue-cpuCostTable.spec.ts`
stores a hash of each primitive's xd snapshot and warns once codegen changes without a
re-measure: once, `python3 -m venv ~/.logue-emu && ~/.logue-emu/bin/pip install unicorn capstone
pyelftools`; then `EMU_PYTHON=~/.logue-emu/bin/python npx tsx
logue-codegen/scripts/measureCpuCosts.ts <id>` (needs the local ARM toolchain and logue-sdk
checkout; about a minute per primitive, the full table ~15 min). A missing or stale entry only warns
(the test prints which ids and the command) so it never blocks `npm run build`; the estimate then
counts a missing primitive as 0 and names it in the tooltip. `CPU_COST_STRICT=1 npx vitest run
test/logue-cpuCostTable.spec.ts` makes it fail, e.g. to confirm a re-measure. The CPU estimate also returns `incomplete` for a patch the xd can't build (same as
the RAM line). **NTS-1 mkII gauge** (same
code path, `estimateOscCpuCost(doc, defs, 'nts1mkii')`, `CPU_GAUGE`): the xd table stands in for
per-primitive costs (no M7 emulator), converted as above, a helper-less primitive with no xd
measurement (`sense/velocity`) counts as free, knob exposure is read per platform. Red at 6700
(`NTS1MKII_OSC_DROPOUT_CYCLES`: factory chorus, stereo delay and hall reverb on), "effects off"
up to 10000 (`NTS1MKII_OSC_SOLO_CYCLES`), green to 4750 (0.71 x 6700). **The oscillator and
the three effect slots share the M7**: a user oscillator and user effects get ~9800 cycles per
sample together with the factory effects off (`NTS1MKII_SHARED_CYCLES`; burn osc 3000 + burn
effect 6800, 6000 + 3800), and the three factory effects (chorus, stereo, hall) take ~3350. Each
gauge sees only its own unit, so both NTS-1 mkII tooltips say to add up the estimates. The first measurement
(2026-09-28), with
`scripts/stageNts1CpuProbe.ts`, a unit that times its own render with the M7's DWT cycle counter
(a user unit may read it) and shows it as a strings-param value: the clock is ~549 MHz (the
STM32H725's full rating), 11,457 cycles per sample in total, the probe's plain sine costs 53, and
audio broke once the oscillator used ~7,750 cycles/sample (45%; ~7,300 at the last good step).
The rest is firmware and effects: the factory Submarine reverb was on during the test, so a
heavier effect would leave less.
The osc is rendered once, not per voice. So even a heavy patch (500-600 cycles on the xd
emulator's scale) is a small fraction of the NTS-1 mkII's ceiling; RAM runs out first there.

`scripts/emulateXdFxCycles.py` (2026-10-01) is the effect-unit counterpart of the xd oscillator
emulator: it runs a built xd effect's `_entry`/`_hook_param`/`_hook_process` in unicorn with the
same M4 weights, maps SDRAM, answers `fx_get_bpmf` with 120, and adds `SDRAM_PENALTY` cycles per
SDRAM access (the F446 has no data cache). An estimate for comparing builds; real cycles are
measured with `hwtest/calibrateFx.ts --xd` since 2026-10-06 (see "The gauge"). The first anchor
(user, 2026-10-01): grain-mill's xd delay at ~680-750 emulator cycles/sample (penalty 8) stays
clean with the factory mod and reverb running; ~814 dropped out with both, ~1000 crackled with
both, ~1200 with either.

**Effect CPU table** (2026-10-03, xd): `src/fxCpuCostTable.ts`,
GENERATED by `scripts/measureXdFxCpuCosts.ts` (`EMU_PYTHON=... npx tsx`, ~20 min; ids re-measure
just those), the same variants as the oscillator table (`scripts/cpuVariants.ts`, shared) built
into a delfx around audio-in's mono (`scripts/measureXdFxCycles.ts`). The emulator runs modfx
units too (five-argument hook). What differs, each from a measured miss:
- Every variant stores `cycles` at SDRAM_PENALTY 0 plus `sdram` accesses per sample, so the
  penalty stays the estimator's constant (`cycles + p * sdram`). Per module, `FX_CPU_BASELINE`.
- `first` / `shared` / `extra`: one, two and three instances. GCC inlines code with one caller and
  shares it between several, and where it switches varies: long-delay 118, +179, then +147 each
  (8 combs read 17 % low counting only `first`, 15 % high counting the second's cost for all);
  env/ad 27, +34, +112. A unit counts `first`, then `shared + extra`, then `extra`.
- Control inlets get a moving signal (audio-in's mono), `trig`/`gate` a square LFO (the test
  noise never reaches 0.5), and every outlet is read (an unread one is dead code: reverse-tap's
  head `b` vanished). Buffer partners, the clock and the output adds are measured alone and
  subtracted (`overhead`); a writer/tap pair's `first`s are split by their `extra`s.
  `control-still` (2026-10-06, as in the oscillator table): control inlets from constants, the
  per-block path a knob or knob-only math gives; the estimator counts it for a reader fed only by
  hoisted values (before, it counted such a reader as unwired). It changed no calibration unit by
  more than 2 %: both fits stayed (xd 1.46 / 25.5, NTS-1 mkII 0.85 / 44.1), and auto-wah's +15 %
  (xd) isn't this.
- util/grain has `heavy-capturing` (SIZE 100 on the slow clock: recording the whole window).
`estimateFxCpuCost.ts` sums a patch: per-block (`hoistedSuffixes`) instances cost 0 and count as
unwired for their readers (grain-mill's envelope times took the per-block path; `control` read
~90 high), a grain whose `trig` moves counts `heavy-capturing` (trigger rate vs SIZE is
unknowable; grain-mill sync/free record all the time), and the knob-reachable maximum follows
the oscillator rules (a knob-bound checkbox both ways, `heavy-*` once a knob or moving input can
move a setting). **The gauge** (Build panel, xd effects; NTS-1 mkII below; measured scale since
2026-10-06): REAL effects-MCU cycles per sample (180 MHz, 3750 in all) as `1.46 * cycles + 26 *
sdram` (`XD_FX_CYCLE_SCALE`/`XD_FX_SDRAM_CYCLES`), fitted to 13 generated effects measured on a
real xd by `scripts/hwtest/calibrateFx.ts --xd` (readings `hwtest/xdFxCpuReadings.json`, loaded
as `XD_FX_DEVICE_READINGS`): every one within -11..+15 %. Every instruction costs ~1.5x what the
emulator counts (maybe because a unit runs from SRAM; a guess) and an SDRAM access ~26. Anchors
from `hwtest/cpuCeiling.ts --xd`: red at `XD_FX_DROPOUT_CYCLES` 1040 (the burn unit in the DELAY
slot with factory chorus and a hall/plate/room reverb, dry, running: clean 1040-1060; in the
REVERB slot with chorus + stereo delay 1280), "solo only" up to `XD_FX_SOLO_CYCLES` 2980 (the
other slots off, either slot), green to `XD_FX_CLEAN_CYCLES` 925 (an estimate 11 % low still
clears 1040), "tight" between. The example stereo reverb measures 2678 (solo only: matches the
user's report); the xd grain-mill units 1110-1200, a little over 1040 although they ran clean
with the user's factory mod and reverb (lighter types or settings, presumably). The emulator-scale
anchors the gauge had before (750/814/1660 at penalty 8) are in docs/HISTORY.md.
`scripts/checkFxCpuEstimate.ts` compares that with every example built whole: -10..+31 % at
penalty 8, SDRAM counts exact except the random-trigger grain-mill units (5-5.5 accesses against
8: the deliberate overcount, +16/+24 %); without those -10..+2 % but auto-wah +31 % (2026-10-05:
the svf `control` variant moves cutoff, resonance and pitch at audio rate, and since svf caches
its divide that variant costs 124 (118 before its `notch`/`ap` outlets were read too), while auto-wah's svf, only its cutoff moving, costs ~60). `scripts/profileFxUnit.ts`
attributes a unit's per-line profile (`PROFILE=1 PROFILE_LINES=0`, now with SDRAM per line) to
instances, helpers and SDK headers next to the table -- how the misses above were found.
`osc/additive` and `filter/string` don't fit an xd delfx: they're listed in `FX_CPU_DOES_NOT_FIT`
instead of the table. `logue-fxCpuCostTable.spec.ts` warns on a missing or stale entry (snapshot
hash, or the fx goldens' shell hash for the whole table) like the oscillator one;
`CPU_COST_STRICT=1` fails it.

**NTS-1 mkII effect gauge** (2026-10-05): `estimateFxCpuCost(doc, defs, 'nts1mkii')`, the xd
effect table converted to M7 cycles as `0.85 * cycles + 44 * sdram` (`NTS1MKII_FX_CYCLE_SCALE`/
`NTS1MKII_FX_SDRAM_CYCLES`), fitted (relative error, no intercept) to 14 generated effects measured
on the device by `scripts/hwtest/calibrateFx.ts` (see "Hardware test harness"; readings in
`hwtest/nts1FxCpuReadings.json`, loaded as `NTS1MKII_FX_PROBE_READINGS`): every one within
-22..+19 %. Plain math costs the M7 a little less than the xd emulator counts; an SDRAM access
~44 cycles. `scripts/checkNts1FxCpuEstimate.ts` reprints the comparison and a fresh fit without the
device; `logue-estimateFxCpuCost.spec.ts` warns outside -25..+25 % (`CPU_COST_STRICT=1` fails).
`osc/additive`/`filter/string` (no xd effect holds them) count their xd oscillator cost. Anchors,
measured by `hwtest/cpuCeiling.ts` (a unit burning an exact load in the REVERB slot, a factory
oscillator playing): dropouts past 6300 cycles per sample with factory CHORUS + STEREO delay on
(`NTS1MKII_FX_DROPOUT_CYCLES`, red), past 7000 with mod and delay off (`NTS1MKII_FX_SOLO_CYCLES`,
"solo only" between); green to 4900 (`NTS1MKII_FX_CLEAN_CYCLES` = 0.78 * 6300: an estimate 22 %
low still clears the busy ceiling), "tight" between. Device controls are read per platform.

`logue-codegen/scripts/*.ts` are one-off, throwaway verification scripts (stage a generated
project into a sibling logue-sdk checkout for a real Docker build + websim/hardware check) — not
part of the app, not wired into any UI. The formant-crash bisect scripts
(`stageFormantCrashBisect{,2,3,4}.ts`) are worth keeping as a diagnostic playbook template for a
future similar `-Os`-specific compiler issue.

Tests: `test/*.spec.ts` (vitest; `npx vitest run`), fixtures in `test/fixtures/`, golden
per-primitive codegen in `test/__snapshots__/primitives/`. New primitives usually get coverage
inside `logue-generateOscUnit`/`logue-generateOldGenOscUnit` rather than their own spec file.

**Direct device upload, backup & restore (SysEx)** (`logue-codegen/src/sysex/`, UI in
`src/renderer/src/device/`):
- **Codec:** dependency-free, for the user-unit SysEx family both platforms share (function IDs
  `17`-`1E`/`47`-`4A`/`2x`). 7-bit packing, zlib CRC-32, a hand-rolled `.mnlgxdunit` zip
  reader/writer, a byte-exact old-gen upload-body builder (`buildOldGenUnitBody`; the xd also
  runs prologue-built units), request builders and a reply parser. A package's module comes
  from its `manifest.json`, not its zip folder (that's the Makefile's PROJECT: `osc`, `fx`,
  Korg's `dummy_modfx`); an effect manifest has no `params` key. The body for an xd effect
  (`num_param` 0) matches no capture yet.
- **Session:** transport-agnostic `LogueDeviceSession` (query/upload/download) and
  `discoverLogueDevices` (`deviceSession.ts`).
- **Reassembly:** `RawSysexAssembler` tolerates the xd's stray `F7`s.
- **Backup format:** `unitBackup.ts` (`planBackup`, `index.json`
  `logue-patcher-device-backup/1`).
- **Transport:** NOT Web MIDI. A native Swift CoreMIDI helper
  (`native/logue-midi-helper/main.swift`) is built by `scripts/build-midi-helper.mjs` into
  `resources/bin/` (a universal binary, gitignored, asarUnpacked, hooked into `build`/`predev`/
  `build:mac`). It's spawned by `src/main/midi/midiHelper.ts` and passes raw bytes through the
  `logueMidi` IPC namespace; all parsing stays in tested TS.
- **UI:**
  - Build Results: ONE row per unit file (`groupResultsByPath`; a rebuild renames the previous
    file aside, so only the newest is at its path), with a build count and `● slot N` (uploaded
    from this build) / `○ slot N` (rebuilt since). Upload icon per row.
  - **Build & Upload** (button beside Build, Build menu ⇧⌘B, 2026-10-03): builds, then
    `quickUpload` (`device/unitUpload.ts`) goes straight to the slot this unit was last uploaded
    to (session-only `uploads`, keyed by path; re-reads that one slot: it must still hold the
    same name or be empty), or the ONE slot holding its name; anything else (first upload, no
    device, a slot taken over, two candidates) opens the dialog with the reason. It finds the
    device again by its MIDI output name, so with two devices connected it doesn't jump to the
    other one.
  - The dialog preselects the same way (`slotChoice.ts`' `initialSlot`: remembered slot, else
    one holding the name -- the device shows 13 characters -- else the first empty), and
    re-uploading the same-named unit needs no Replace click ("Update slot N").
    Checked end to end against the fake xd (with a real xd also connected; it was never written).
  - Device menu › "Back Up Device…" writes ONE new zip, `<build output folder>/backups/backup-<timestamp>.<device>.zip`
    (`backupZipName`, store-only, flat): the exact `.body.bin` per xd unit (plus a unit file only
    when it re-encodes exactly), or the `.nts1mkiiunit` itself for the mkII, and `index.json`.
    Older backups were plain folders of the same files; Restore still reads both.
  - Device menu › "Restore Device…" uploads `.body.bin`s back into their original slots and reads each back.
- **Harness** (`logue-codegen/harness/sysex-emu/`): `PROTOCOL.md`, `PROTOCOL-nts1mkii.md`,
  `midi_proxy.swift` (a logging MIDI man-in-the-middle for capturing another app's traffic with a
  device), and a fake xd (`main.swift`: validates CRC/size, stores uploads, serves downloads, `CHANNEL=`/`NAK=`
  env vars) that is the no-hardware end-to-end target. Also `dump_slots.swift` and
  `backup_from_dump.py` (standalone read-only dumper and backup builder).
- **Confidence:** upload bytes match captured `logue-cli`/Kontrol Editor traffic byte-for-byte;
  backups of a real xd (27/27) and NTS-1 mkII (6/6) matched independent dumps; real single-slot
  uploads/restores on both devices were ACKed and left every other slot byte-identical. Still
  unmeasured: ACK timing for large units. Details in `docs/HISTORY.md`.
Gotchas:
- **The real xd's USB MIDI output inserts stray `F7` bytes into long SysEx** (about 1 per 700
  bytes). Chromium's Web MIDI truncates at the first one and drops the rest, which is why the
  transport is the native helper and not Web MIDI. The download's "checksum" field is not a
  checksum of the body (its low 11 bits are constant across all slots; CRC-32 and CRC-16-CCITT
  variants are ruled out). Integrity comes from exact lengths plus repeat dumps.
- Discovery sends Search Device to EVERY output, since port names differ between the real xd,
  the fake and DIN interfaces. Pairing uses a per-output echo ID. Afterwards `midiLink.ts`
  disconnects every source that didn't answer, so keyboard/mixer/loopback traffic stops flowing
  over IPC.
- `RawSysexAssembler`'s stray-`F7` length rule is xd-only (family `51`) on purpose. Applied to an
  NTS-1 mkII chunk it misread the chunk header as a size and swallowed chunk boundaries, which
  broke a real backup once.
- A real device ignores requests not addressed to its global channel (`3g`); the channel comes
  from the Search Device reply.
- **A slot keeps its menu param values when a new unit is uploaded into it** (both devices,
  user, 2026-09-30): the previous unit's Param 3 value arrived as the new unit's Param 3, so the
  unit's own defaults (header `init` / manifest) don't apply after an upload. Harmless for a real
  patch, confusing in a test pass: set the params by hand after each upload.
- Every generated unit has `dev_id`/`prg_id`/`unit_id` = 0, which probably makes all
  logue-patcher units indistinguishable to a device (see `PROTOCOL-nts1mkii.md`).

### Per-primitive gotchas worth knowing before touching one

Current rules only. The round-by-round reports, measurements and reversals behind them are in
`docs/HISTORY.md` -- read the matching entry there before changing a constant.

- **`mix/mix2`** averages (summing two correlated full-scale sources clipped in the harness); an
  unwired inlet reads as silence. **Cascading** (2026-10-04): `mix2`'s `thru` and
  `stereo-mix2`/`pan-mix2`'s `l`/`r` inlets add a bus at unity ahead of the gained inputs (`pan`'s
  convention), so mixers chain with one wire each and no source is halved again per stage.
  `mixTerms` leaves unwired terms out of the sum (GCC can't drop `0.f * gain` without fast-math):
  unwired pan-mix2 code 176 -> 36 B (xd osc); a wired bus costs one add (+3 xd emulator cycles).
  Chosen over N-input mixers and named buses (user's call) as the least code; Pd-style summing
  inlets on audio-out/a `mix/sum` node are the next step if wiring still feels heavy. **`math/multiply`**: either unwired inlet mutes the output
  (absorbing zero, disclosed). **`filter/highpass-cheap`** is `in - onepole_step(...)`; its
  `CUTOFF` defaults to 0 (the passthrough end of the same coefficient).
- **`mix/crossfader`** uses `xfade_sqrtf` (`vsqrt.f32` on ARM, `sqrtf` on the host): newlib's
  `sqrtf` sets `errno` and breaks the static xd link. Any new libm call needs a real xd link check
  -- `tanf` links, `expf` and `sqrtf` don't.
- **Crossfader knob smoothing** (both crossfaders, 2026-10-03, user report: a jump and crackles
  near one end of a Depth-knob dry/wet): a per-block fade (unwired, or a knob) used to step its
  gains once per block, and near the equal-power law's ends one 10-bit knob step is ~-27 dB. Now
  `xfade_settle` (per block) snaps each gain onto its target within 1e-5 and flags a gain still on
  its way; only then does the loop run `xfade_glide`, a one-pole of 96 samples (2 ms), whatever
  the step size. Gliding every sample cost 38 xd emulator cycles; settled it's 16 / 15 (stereo),
  was 4 / 4. `xfade_settle` is a shared `noinline` leaf (both inlined: 9 cycles but ~350 B per
  instance; both out of line: 21 cycles), code ~140-220 B per instance. A per-sample `fade` (an LFO) isn't smoothed. Gains start at -1 ("not started"), so
  the first block takes its target at once and FADE 0/100 stay bit-exact. Harness
  (`runNts1FxHarness.ts`): a full Depth jump moves at most 1/96 of it per sample and lands exactly
  on 0; a 1 % step (0.049 at once before) at most 0.0005. Mono `crossfader` got `LAW`
  (Power/Linear) too. No hardware pass yet.
- **`filter/comb`**: `TUNE`/`FEEDBACK`/`DAMPING` (inlets `tune`/`feedback`/`damping`). All three
  pass through a warp (`comb_response_warp`/`cutoff_warp`), since a linear dial crams the audible
  range into the last ~20%. `TRACK` on (raw >= 1) replaces `TUNE` with note tracking (`1/note_w0`), so
  `pitch` and `tune` are live in opposite modes (the inlet badge shows which). `FEEDBACK` caps at
  `0.999`. The loop has a ~1.5 Hz DC blocker on the fed-back tap and a soft knee limit on what is
  written back (linear to 0.6, ceiling 1.0); the output is not limited, so FEEDBACK 0 is still a
  passthrough (2026-09-28, user report on both devices: a bowed exciter at high FEEDBACK with no
  damping built up a 3.7x-full-scale DC offset plus 2x AC and hard-clipped at the output). The
  blocker detunes a tracked pitch by ~4 ct at the lowest note (~94 Hz, calculated), under 2 at C4.
  Costs ~30 cycles (xd: 59 base, 220 worst). Confirmed improved on both devices (user, 2026-09-28). Old names (`CUTOFF`/`GAIN`, pre-phase-33 `DELAY`/`FEEDBACK`) resolve through
  `renamedParams`; `DELAY` inverted direction and is only flagged.
- **`filter/string`**: a Karplus-Strong string, deliberately not a modal bank (8/16 SVF modes cost
  ~21%/~41% of the xd's CPU; `scripts/stageModalResonatorBench.ts`).
  - A 2048-sample delay line (floor ~23.5 Hz, MIDI ~18; 1024 went flat below ~note 30) with a
    4-point Hermite read, a damping one-pole, and 8 first-order allpass stages sharing ONE
    coefficient (progressively scaled stages detune less; the effect is steeply nonlinear).
  - `string_step` subtracts the one-pole's and allpass stages' DC group delay from the target
    delay (tuning was sharp above ~C3 without it), and at runtime clamps the STRUCTURE-derived
    coefficient to what the current note's period can afford.
  - `STRING_DISPERSION_MAX` is 0.72: 0.85 fits the budget but detunes the fundamental up to
    +66 ct at C5 (the DC compensation is inexact there). A stronger dispersion needs a
    frequency-aware compensation or a real dispersion delay line -- open.
  - `DECAY` is an absolute time: `decayGain_` is solved per note-on for 0.05-30 s regardless of
    period, and `DECAY=100` is exactly lossless (`1.f`). A wired `decay` inlet can't reach
    note-on, so it uses the older per-cycle gain (`STRING_DECAY_MAX_GAIN = 0.9998`).
    `exp_approx` (range-reduced Padé) replaces `expf`, which doesn't link.
  - What recirculates gets comb's soft knee (linear to 0.6, ceiling 1.0; 2026-09-28): a bowed
    exciter at DECAY 100 grew to 5x full scale. Plucks at DECAY 100 now ring slightly quieter
    after their first peaks (0.18 vs 0.24 RMS after 1 s). xd emulator: 368 base, 554 wired.
    Confirmed improved on both devices (user, 2026-09-28).
  - RAM: 8300 B bss on the xd (~25% of 32 KB), 8344 B on NTS-1 mkII, both measured.
- **`osc/noise` `COLOR`** (2026-10-03): White / Pink / Brown / Violet, a select (one device
  control switches it). White is the old LCG and stays the fall-through of an integer
  `noiseColor_ == 0` test (xd emulator 9 cycles, was 6). The coloured ones are all integer math
  with one float conversion: pink is Voss-McCartney (12 rows, Gardner's trailing-zero order via
  `__builtin_ctz`, two LCG steps a sample), brown a `b - (b >> 9) + (x >> 9)` leak (~15 Hz
  corner), violet `(x >> 1) - (prev >> 1)`. Float versions reloaded their coefficients from the
  literal pool every sample: Kellet pink cost 74, now 34; brown/violet 27. All three come out at
  RMS 1/3 (white's is 0.577), unclamped: pink/brown pass +-1 in ~0.2% of samples. Harness
  (`scripts/runNoiseHarness.ts`): slopes -3.11/-5.99/+5.98 dB/oct over 25 Hz-12.8 kHz, octave
  ripple <= 0.4 dB. State 68 B (the pink rows), = the xd bss. The exciter keeps its own Kellet
  pink (`PINK_NOISE_STEP_HELPER`). As an effect unit on a real NTS-1 mkII and a real xd, the output matches the host render (`hwtest/functional.ts`, 2026-10-06); not checked inside an oscillator, no listening pass.
- **Noise LEVEL** (`osc/noise`, `osc/lfsr`, 2026-10-03, the Radio patch): measured
  (`scripts/measureRadioLevels.ts`, NTS-1 mkII fx shell) the noise sits 10-15 dB above an
  effect's input (white -4.8, coloured ~-9.4 dBFS RMS vs a 0.18-peak saw at -19.7), so a hiss
  under the signal needed `mix2` GAIN ~2. `LEVEL` (`LEVEL_PARAM`/`levelGain`, `primitives/shared.ts`):
  stored 0..100 (no negative typeless range on the xd), 100 = 0 dB (the default; the gain is then
  exactly `1.f`, so old patches render bit-identically), 0.48 dB a step to -47.5 at 1, 0 = off;
  the dial shows dB (`LEVEL_DB`). Gain per block via `exp_approx` (moved to `shared.ts`), at
  worst 0.015 dB off. +1-2 xd emulator cycles. Harness: LEVEL 50 = -24.000 dB, 0 silent.
  `mix2`/`stereo-mix2` GAIN show dB too (`MIX_GAIN_DB`, display only). No hardware pass yet.
- **`osc/lfsr`** (2026-10-03): the NES/Game Boy noise channel. Clock = 127x the pitch (the note
  with TRACK, default on; else RATE on `fast-square`'s 0.1 Hz-2 kHz curve). MODE Long: the
  15-bit register (period 32767, harness-exact), at most one step a sample, so past the sample
  rate it's plain 1-bit white. MODE Short: the Game Boy 7-bit loop (127 steps,
  `lfsrShortSequence`, baked at generation) read as a table, so it plays any note exactly
  (harness: 0.00-0.05 ct, 55 Hz-2 kHz) -- stepping a register at 127x the note would need
  several steps a sample above ~380 Hz. Position is integer 8.24 (no float compare a sample);
  the block constant is already the fixed-point increment. Naive +-1 output. xd emulator: 28
  base, 17 Short. As an effect unit on a real NTS-1 mkII and a real xd, the output matches the host render (`hwtest/functional.ts`, 2026-10-06); not checked inside an oscillator, no listening pass.
- **`osc/exciter`**: one `BOW` knob from pluck to bow, built for `string`/`comb`.
  `pluck_exciter_step` is `ahd`'s 4-stage machine with a BOW-dependent decay while held (0 at
  BOW=100). Attack is always the fast `env_rate_from_percent(0)`; softness comes from a decaying
  strike train (count from BOW at note-on, each strike x0.55, warmer). Pink noise (Kellet,
  scaled by `PINK_NOISE_GAIN_COMPENSATION = 0.3374` to white's RMS, pinned by a test) blends in
  with `warmth`, the output is clamped to +-2 and scaled by `1 - warmth*0.9` so a held bow
  doesn't overdrive a resonator (0.65 until 2026-09-28: a bow at BOW 100 fed ~-16 dBFS RMS
  continuously, now ~-28; `warmth = max(BOW, 1-strikeGain)`, so only a pure pluck keeps full
  level). `bow` inlet is additive +-50. The tone/decay/
  strike constants are ear-tuned starting points, not measured on hardware.
- **`osc/granular`**: an imported sample (`ObjNode.sample`, 8-bit mu-law, 1 KB decode table) read
  by 4 windowed grains, recycled round-robin. `SYNC` on: one grain per note period (pitch from
  the grain rate, timbre from `POSITION`); off: classic granular transposed by `note/ROOT`.
  `WINDOW` morphs Tukey -> Hann -> Hann^4 (libm-free); output is normalized, never boosted;
  reads are linear, speed capped at 16x. `SMEAR` is cubed. SMEAR 0 with SYNC off buzzes at the
  spawn rate by nature; SMEAR >= ~30 with WINDOW ~50 is smooth.
  - Import (`logue-codegen/src/sample/`): WAV -> mono -> trim -> windowed-sinc resample to fit
    4K-32K samples -> normalize -> mu-law; YIN proposes `ROOT`. Main only reads the file.
  - xd: every grain helper is `always_inline` (a real call chain hung the device; pinned by a
    test). Grain setup runs every 16 samples (`GRANULAR_CONTROL_PERIOD`), so a wired `pitch` is
    read at that rate; SYNC-off overlap tops out at 3 (`GRANULAR_MAX_OVERLAP`); all grains use
    the current speed (no pitch bleed after a note change).
  - Measured: xd 19496 B text+rodata / 172 B bss with a 16K sample; NTS-1 mkII 22955 B.
    Confirmed on a real xd (no hangs, inlets sound right) and on a real NTS-1 mkII (user, 2026-09-30).
- **`osc/sample`** (2026-10-02, `docs/PLAN-sample.md`): a plain sample player for the user's
  Fairlight CMI collection -- the sample as recorded, the note against ROOT setting the speed,
  LOOP (Off/Forward/Ping-pong select) over the stored loop or the whole sample, REVERSE (the
  sample mirrored: from the end backwards, START counted from the end, a Forward loop run
  backwards; with ping-pong it bounces after reaching the loop start),
  START (additive `start`, latched at a restart), TRACK off = every key is ROOT (COARSE/FINE/
  `pitch` still transpose), INTERP Linear/None (drop-sample). Every note-on and rising `trig`
  restarts it.
  - Import (`importPlainSample`): the source's own rate (48 kHz at most); a mono 8-bit file is
    stored bit-exactly, anything else peak-normalized and rounded to int8 (no dither, on
    purpose); the WAV `smpl` chunk's first forward loop and unity note (over YIN); too long ->
    Cut (default; at the loop end when the loop fits) or Downsample; max length 8K..40K.
  - Read position is 16.16 fixed point: ROOT from a 48 kHz sample reproduces the stored bytes
    exactly (harness). Speed capped at 16x, loops >= `MIN_LOOP_LENGTH` (32; the import drops a
    shorter one, `instanceProblem` rejects one in a hand-edited file), so the loop's one `if`
    wrap holds. A restart is a flag: the step latches START on the next sample, which is how a
    wired `start` counts. Unwired (or per-block) `pitch`/`start` are block constants; a moving
    `pitch` is re-read every 16 samples (`sample_speed_ctl`), a moving `start` only at a restart.
  - Loop editing (`SampleSection.tsx`, `sample/loopSnap.ts`): drag the nearer loop line on the
    unzoomed waveform (one undo step; Shift = exact, × removes the loop). The snap looks a few
    pixels around the pointer for crossings of the LEVEL at the other loop point (zero once that
    one sits on a zero crossing; a loop from a file often doesn't, and forcing zero there made the
    seam ~25x worse), going the same way by an 8-sample smoothed slope (immune to 1-LSB wiggle),
    and keeps the one whose +-16 samples best match the other point's. The preview applies a
    moved loop live; its decode is keyed on the bytes, so a loop edit doesn't restart it.
  - Direction is a state bit (`back_`): REVERSE sets it at a restart, ping-pong flips it at each
    loop end, turning ON the end samples (each played once per turn, so interpolation never
    reads past a loop end); a finished backwards one-shot parks at `0xffffffff`, which reads as
    past the end. Harness: the exact index order at ROOT for REVERSE (one-shot, START 50, with a
    loop), ping-pong, and both, each INTERP; off-ROOT seams within the material's steps. Costs
    ~20 xd emulator cycles even unused (88 base, 102 worst, `heavy-pingpong-reverse` 100). The
    Inspector preview plays the device's order (`sample/playbackOrder.ts`, a reordered buffer,
    since Web Audio only loops forwards); only a plain forward loop takes a dragged loop live.
    Ping-pong/REVERSE (2026-10-02) are harness-, link- and app-checked; no hardware pass yet.
  - `renderExpr` can't see the node, so there's one step (`sample_step`, `const int8_t *`): a
    mu-law sample (Replace with keeps a node's sample) is converted to pcm8 at generation.
  - Harness (`scripts/runSampleHarness.ts`, xd, ASan/UBSan): bit-exact at ROOT (both INTERPs),
    one-shot ends in exact silence, pitch within 0.25 ct over +-24 st at 22.05/32/48 kHz, loop
    steps within the material's own, START 50 exact, trig restarts, extremes clean.
  - Builds (`scripts/stageSample.ts`): only `note_w0` below the xd's `process`; xd 17 728 B with
    a 16K sample, NTS-1 mkII 21 802 B (16K) / 46 378 B (40K; 44K is over 49 152). The RAM
    estimate is within 1 % of each (before ping-pong/REVERSE, which added ~150 B; 40K still
    fits: 46 570 B). xd emulator 68 base, 76 with control inputs then (measured
    looping: unlooped, a variant can end up timing a finished one-shot's silence). Confirmed on
    a real xd and a real NTS-1 mkII, loops and all (user, 2026-10-02).
- **`osc/wavetable`** (2026-10-04, `docs/PLAN-wavetable.md`): single cycles cut from a recording
  by `importWavetable` (`wt8`, phase 1: pitch-tracked, one cycle rebuilt per position from its
  harmonics, frames phase-aligned), read at the played note. POSITION (additive, depth 100) picks
  the frame, MORPH Smooth crossfades neighbours / Step takes the nearest. Built because granular
  SYNC bends the pitch while POSITION moves (each grain is a note-period slice of material with
  its own period); here the pitch can't move (harness, a one-way ramp scan over every frame of the
  user's soul vocal: mean offset <= 0.03 ct, granular SYNC on the same scan up to 21 ct).
  Formants move with the note (wavetable character, accepted by the user).
  - Aliasing: `wavetablePyramid` bakes band-limited copies at generation (level j: harmonics up
    to `(L/4) >> j`, `L >> j` points but at least 64), cached by content hash (the RAM estimate
    calls it on every edit). The level follows the note: `x = L*w0`, level j for x in
    [2^j, 2^(j+1)), crossfaded linearly into j+1 so its top harmonic is gone exactly at Nyquist
    (`wt_level`, halving, no libm). What's left is linear interpolation's images at 4 points per
    cycle of a level's top harmonic: the fixture saw (64 harmonics at 1/k, the worst case) -39 dB
    off-harmonic at note 78, the soul vocal <= -46 dB. Levels of 8/16 points gave -26 dB at note
    120, hence the 64-point floor (~25 % more table). Doubling the level lengths (r = 1/8) or
    Hermite reads would buy ~6-10 dB in the middle notes for ~30 % more table or ~2x the reads.
  - The frame shape lives in members set in `init` (`frames_`/`len_`/`lastLevel_`/
    `levelOffsets_[]`): only `initStatement` sees the node. `sample/wavetableRead.ts` is the same
    read in TypeScript (single precision); the harness holds the unit to it within 1.2e-7.
  - Harness (`scripts/runWavetableHarness.ts`, `WAVETABLE_WAV=<file>` adds a real import and the
    granular comparison): reference match, no sustained pitch offset while scanning (the
    fundamental's phase per window; autocorrelation and short windows misread fast timbre change
    as a few cents), aliasing per note, crossfade midpoints (vocal: >= -0.58 dB), fuzz clean.
  - Builds (`scripts/stageWavetable.ts`): xd 32x256 21 960 B, only `note_w0` (with `pitch`
    wired) below `process`; NTS-1 mkII 32x256 25 925 B, 64x256 46 405 B (of 49 152), 32x512
    42 313 B; the RAM estimate within 0.3 % of each. xd emulator 146 base (cheaper than granular
    SYNC's 234), 208 `heavy-moving-position` (an LFO into POSITION, LFO included); the profile
    is mostly the 8 table reads and their lerps. Whole units against the CPU estimate: POSITION on
    the Shape knob 165 measured / 165..227 estimated, an LFO into POSITION 228 / 204..263, an LFO
    into POSITION and `pitch` 385 / 204..263 -- a moving `pitch` is the `control` variants' known
    gap (see "CPU"). The heavy variant was POSITION and pitch at first (365), which put a
    knob-bound POSITION's knob maximum at 384. Confirmed on a real xd and a real NTS-1 mkII (user,
    2026-10-04: `stageWavetable.ts --hardware`'s WT Shape / WT Scan / GR Scan / WT 64, the soul
    vocal, POSITION by hand, by the Mod LFO and by a patch LFO).
  - Inspector: `WavetableSection.tsx` (not `SampleSection`): the cycle at POSITION, a frame strip
    that scrubs POSITION (one undo step), Frames/Points/Level import choices, a PeriodicWave
    preview at middle C that follows a scrub (`sample/wavetableView.ts`). The pitch tracker
    (`sample/pitchTrack.ts`) has two harmonic-lock checks, found on a synthetic vowel sweep in
    the app (a frame was measured at C7); its known miss is documented there.
- **`osc/sync`** (2026-09-28): hard sync as one node -- a silent master plays the note
  (COARSE/FINE/`pitch`), the heard slave runs `SYNC` 0-48 st above it and restarts at each master
  wrap; SHAPE saw/pulse (WIDTH)/triangle/sine. Chosen over a `sync` inlet on every oscillator
  because only here is the master's sub-sample wrap time known: `sync_osc_step` sees the wrap one
  sample ahead and spreads each restart's jump over the two samples around it (2-point polyBLEP,
  no latency); the slave's own saw/pulse edges get the usual polyBLEP; triangle/sine restarts are
  smoothed in value, not slope. Harness: pitch within ~1 ct; aliasing 7-13 dB below the
  uncorrected version for saw/pulse (e.g. saw at note 84, SYNC 31: -15 vs -8 dB). The two lambdas
  in the helper need `always_inline` (at -Os GCC called them); with that the helper is one real
  leaf call from the xd's `process`. Slave increment capped at 0.5. xd emulator 108 base, 264
  with `pitch`/`sync` wired (two `note_w0` per sample then). Confirmed on both devices (user, 2026-09-30).
- **`osc/phase-dist`** (2026-10-02): Casio CZ phase distortion, a cosine read through a bent
  phase. `WAVE` (8, the CZ's order): Saw, Square, Pulse, Double sine, Saw-pulse, Reso 1/2/3;
  `WAVE2` (Off + the 8) is the CZ's line 1+2: WAVE plays the first half of each period and
  WAVE2 the second, each at double speed, so the note keeps its pitch (whether the CZ instead
  drops an octave wasn't confirmed; COARSE -12 gives that). `DCW` with an additive `dcw` inlet
  at depth 100 (an envelope from dial 0 sweeps the whole range), plus the usual
  `pitch`/`harmonic`/`fm`/`fmDepth`.
  - Bend waves share one bend width `k = (1-DCW)^3` (brightness goes roughly as 1/k); each
    one's steepest stretch has slope `1/k`. The
    double sine blends by DCW itself toward reading the sine twice per cycle (a clean octave at
    100, own reading of the CZ wave) and isn't limited. Resonance waves are `1 - w*(1 - cos(r*p))`
    under a saw/triangle/trapezoid window, `r` 1..16 x the note, unrounded: the window brings
    each reset back to 1, so the sweep is smooth (Casio's patent method).
    At DCW 0 the five bend waves are a pure sine (harness floor), the resonance waves are not
    (-20/-12/-18 dB of other harmonics).
  - Limit by note (`pd_knee`/`pd_reso_ratio`): `k >= 8*rate` (the steepest stretch under 1/8 of
    the sample rate), `r*rate <= 0.25`, `rate` doubled with WAVE2 on (`pd_rate`). Off-harmonic
    energy at DCW 100 (`runPhaseDistHarness.ts`; `--sweep-limits` compares limits): -44..-50 dB
    for the bend waves up to note 108, resonance -29..-47 at notes 96-108. DCW defaults to 0, so
    an envelope wired into `dcw` sweeps the whole range.
  - A ~2 Hz DC blocker (0.9997) after the wave (pulse, saw-pulse and resonance sit mostly above
    zero), output x0.5: the narrow pulse peaks at 1.99 once its DC is gone, so everything stays
    under full scale; a plain sine is 6 dB quieter than `osc/sine`.
  - Unwired (or from per-block values) the coefficients are block constants; a moving `dcw`/
    `pitch`/`harmonic` takes `pd_osc_step_moving`, which works out only what the chosen waves read
    (the saw's two reciprocals from one divide, `pd_both`, also per block). Everything is `always_inline`: the staged xd builds
    show no call below `process` at all. Uses `osc_sinf(x + 0.25f)` rather than `osc_cosf`, which effects
    have no stand-in for; it links in both fx sweeps.
  - xd emulator: 85 base, 99 control, 97 reso at DCW 100, 101 line 1+2, 285 with an LFO moving
    DCW and the pitch with line 1+2 on (LFO's ~36 included; DCW alone from an LFO ~163 without
    it). RAM estimate = the xd bss (68 B). Builds: `scripts/stagePhaseDist.ts` (`lp-xd-pd`,
    `lp-xd-pd-env`, `lp-nts1-pd`, `lp-nts1-pd-env`; ~2-2.8 KB on the xd). Confirmed on a real
    xd and a real NTS-1 mkII (user, 2026-10-02): both units, DCW on Shape and an ADSR into `dcw`.
- **`osc/bass-support`** (2026-09-29; RANGE/MODE removed 2026-10-02, user's call: the
  two-octave window fold was hard to follow): a bass under the device's own oscillators, one
  octave below the played note; `COARSE` (+-24 st) sets any other distance. The pitch is live
  (bends and device portamento pass straight through). `bass_block_note` is stateful (glide), so
  it's an unconditional block local, never a `blockValue` (which would inline it per sample once
  an input is wired). `GLIDE` is a per-block one-pole on that note (time constant `2000*t^2` ms);
  `COARSE`/`FINE`/`pitch` are added after the glide,
  so vibrato isn't smoothed. Chain: `SHAPE` sine->tri->saw->square morph (snaps to the pure wave
  within 2% of a corner, so 33/67 give one wave), `SUB` square an octave down (flips at each main
  wrap, so it stays locked), `DRIVE` 0.7-8x into a cubic soft clip (level-compensated) with an
  `ASYM` offset, `TONE` TPT lowpass at `1+31t^2` times the pitch (Q ~1, block constant, tracks
  the glided note but not the `pitch` inlet), a ~2 Hz DC blocker (`0.9997`, not
  `dc_blocker_step`'s 0.995 = ~38 Hz), output x0.52 (the worst corner peaked at 1.82 before it).
  `RETRIG` restarts the phase in `noteOnStatement`.
  On the xd every voice plays its own bass (mono/unison suits it).
  - Harness (2026-10-02): note 60 -> 130.81 Hz, COARSE -12 -> 65.41 Hz. No hardware pass of the
    windowless version yet; the items below are from the 2026-09-29/30 RANGE version.
  - Harness: steady-state DC 1e-5 at ASYM/DRIVE 100; ASan/UBSan fuzz clean (wired inlets,
    extreme notes/COARSE).
  - Builds link on both platforms (`scripts/stageBassSupport.ts`); `bass_support_step` is the
    only call below the xd's `process`; the xd RAM estimate equalled the bss (128 B then; state is 20 B smaller now).
  - xd emulator (cycles/voice-sample above the baseline): 264 base, 513 with all four inputs
    wired (a wired `pitch` means a `note_w0` per sample, wired `drive`/`tone` per-sample
    divides; the table's base/control variants re-measured 265/392 on 2026-10-02) -- a heavy primitive; the wired case alone is past the 468 "plays fine" anchor.
    The rational tanh it started with cost ~20 more (a divide); a control-rate update of the
    wired coefficients would be the next saving. Confirmed on both devices (user, 2026-09-30),
    including on the xd a mono-legato note (RETRIG still worked, so it sends `OSC_NOTEON`)
    and device portamento with wide jumps. The emulator reads `osc_sinf` as silence (only the note LUT is stubbed;
    plain `osc/sine` too), so the sine corner's cycles are real but its rms there is 0.
- **`filter/svf`**: ZDF/trapezoidal for exact tracked resonance. `RESONANCE=100` (`k=0`) rings
  forever once excited but won't self-start -- accepted, don't "fix" it. Tracked `g = tan(pi*w0)`
  is `svf_tan`: Padé [5/4] on [0, pi/4], `1/tan(pi/2 - x)` above (the tracked pitch is clipped
  below Nyquist), within 2.5e-7 of `tan` over every note (0.0003 ct). It replaced libm `tanf`
  (user's call, 2026-09-30), whose range reduction linked ~3.2 KB: the xd auto-wah example went
  5540 -> 1476 B of a modfx's 6 KB, and TRACK with every input wired 276 -> 206 cycles (xd
  emulator). No hardware pass of the new one yet.
  `svf_step` caches `a1 = 1/(1+g(g+k))` with the g and k it was made from (`svfA1Cache_[3]`,
  +12 B; 2026-10-05, the Radio patch) and divides only when either changed: never while both are
  per block, every few dozen samples from a stepped source (lfsr, sample-hold), every sample from
  an LFO. Bit-identical output. xd fx emulator: still 55 -> 45, a third instance 81 -> 79, but a
  continuously moving cutoff 106 -> 118 (the compare on top of the divide). Passing a block
  constant `a1` instead, with an always-inline cache only for a moving g/k, was 36 for one still
  svf but a third instance cost 119 (still) / 255 (moving): GCC stopped sharing the code.
  Outlets `notch` (`in - k*bp`) and `ap` (`in - 2k*bp`) since 2026-10-05, appended after `hp`:
  free unwired (GCC drops the unread locals), the notch's width is `k` (zero at RESONANCE 100).
  Harness (`runEqHarness.ts`): ap within 0.0004 dB of flat, notch -67..-85 dB. The fx table
  reads every outlet, so svf's re-measure rose ~5 cycles (45 -> 50 still, 118 -> 124 moving).
- **`filter/ladder`** (2026-10-04): a Moog-style 24 dB/oct lowpass, Zavalishin's ZDF/TPT
  ladder (four bilinear one-poles, the loop solved linearly for an output estimate) with the
  cubic soft clip on the input + feedback sum, where the ladder's differential pair sits. It bounds
  self-oscillation, and a hot input (DRIVE, 1-10x, `+0..+20 dB`) swamps the feedback the way the
  hardware does. bass-support's TONE is a separate 2-pole and stays as it is.
  - `FB_DRIVE` (additive `fbDrive`): a second soft clip on the OUTPUT node, through which both the
    fed-back estimate and the heard output pass. It is pushed by `t*(4+6t)` (1.4x at 25, 10x at
    100) and scaled back, so only the clipping changes, not the loop gain. Makeup on the heard
    output only (`1 + 0.3f^2/(1+f)`). Harness, saw at RESONANCE 90: h12 -50 -> -23 dB, h20 -71 ->
    -32 dB, rms within +2/-2 dB. Self-oscillation: 3rd harmonic -52 -> -25 dB, +3 dB, pitch
    unchanged. The first version clipped only the feedback, before the four stages: they filtered
    its harmonics away and it just limited the resonance and brought the bass back (resonant
    peak -19 dB). At 0 the clip is off (c 0, bound 1e30): the plain ladder up to rounding. Every
    ladder pays for it (~26 cycles for the two clips plus register pressure: 87 -> 118 base).
    Skipping it at 0 would save ~20, but the CPU gauge can't see param values.
  - `RESONANCE` is linear, `k = 4.8*t`, so it self-oscillates from ~84 %, on the cutoff within
    0.4 ct (harness, notes 24-108). Below that point the peak sits under the cutoff, -45 ct at
    k 3.6, as on any ladder. Half the passband loss (`1/(1+k)`) is made up at the input
    (`1 + 0.5k`): about -4 dB is left at high resonance instead of -14 (user's taste call, open).
  - A ~-120 dB LCG noise on the input lets it start oscillating from silence: ~170 ms at C4,
    ~0.7 s at C2, ~1.6 s at C1. Self-oscillation runs at ~-15 dBFS RMS.
  - Free `CUTOFF` is a note (`LADDER_NOTE_LO` 15.5 + 1.2 st per percent, 20 Hz..20.5 kHz) through
    `note_w0`, so the additive `cutoff` (depth 100) sweeps exponentially. The dial shows Hz
    (`LADDER_CUTOFF_HZ`). `TRACK`/`COARSE`/`FINE`/`pitch` are svf's. `g = svf_tan(pi*w0)` with
    w0 capped at 0.45.
  - Unwired, G/p/q are block constants (`ladder_step`). A moving input is control-rate
    (`ladder_ctl`, like `pan_ctl`): G/p/q are worked out every 16 samples and ramped linearly in
    between (the clip's pair steps), so audio-rate filter FM is smoothed to ~3 kHz. Computed per
    sample, a saw with an ADSR into `cutoff` measured 402 xd emulator cycles as a whole unit
    (before FB_DRIVE); control-rate, with FB_DRIVE, 324 (estimate 270..395). The four stages and
    the ramp are unrolled (115 -> 87 base before FB_DRIVE; 284 -> 244 moving). Now 118 base,
    `heavy-moving-cutoff` (an LFO into `cutoff`, LFO included) 244, which counts toward the knob
    maximum once a control input is wired. `control` (noise into every input, 2026-10-06) 247,
    `control-still` 120. xd fx: 116 still, ~250 moving (`fastpow2f` stand-in).
  - Harness (`scripts/runLadderHarness.ts`, xd, ASan/UBSan, noise response vs input):
    -0.04 dB at 50 Hz, -12.03 dB at the cutoff, -25.8 dB/oct an octave up. A full-scale saw at
    DRIVE 100 reaches the output's clip, and a fuzz with every inlet moving at notes 0-127 is
    clean.
  - Builds (`scripts/stageLadder.ts`: `lp-xd-ladder`/`-env`/`-osc`, `lp-nts1-*`): only leaf calls
    below the xd's `process`, and the RAM estimate equals the bss (108 B an instance). Both fx sweeps link.
    As an effect unit on a real NTS-1 mkII and a real xd, the output matches the host render (`hwtest/functional.ts`, 2026-10-06); not checked inside an oscillator, no listening pass.
- **`filter/eq-band`** (2026-10-05): one parametric EQ band, TYPE Bell / Low shelf / High
  shelf / Notch (a select, NTS-1 mkII names `Bell`/`LoShelf`/`HiShelf`/`Notch`). Simper's SVF EQ:
  `svf_step` (shared with `svf`) with `y = m0*in + m1*bp + m2*lp`, g/k/m per TYPE worked out per
  block (`eq_g`/`eq_k`/`eq_m*`), so the loop never branches on TYPE. `A = 10^(dB/40)` via
  `exp_approx` (no `powf`/`sqrtf`: `sqrtf` breaks the xd link). Bell `k = 1/(Q*A)` (a cut is the
  boost's exact inverse); shelves move g by `sqrt(A)` and FREQ is their half-gain point; Notch
  ignores GAIN. FREQ is the ladder's note scale (`LADDER_CUTOFF_HZ`, additive `freq` depth 100),
  GAIN -100..100 = +-18 dB (`EQ_GAIN_DB`, additive depth 100), Q 0.25..16 exponential, 25 = 0.707
  (`EQ_Q`, additive depth 50). GAIN 0 is a bit-exact pass-through (`exp_approx(0)` is exactly 1).
  A moving input goes through `eq_ctl` every 16 samples: g/k STEP (svf_step's cached divide is
  then redone once per 16), the three weights RAMP -- in a double-precision simulation stepped
  weights zippered at ~-57 dB on a fast GAIN sweep, ramped ~-106; stepped g/k ~-100..-117.
  Harness (`scripts/runEqHarness.ts`, xd, ASan/UBSan): every case within 0.015 dB of the
  bilinear prototype from 40 Hz to 18 kHz, bell exactly GAIN at FREQ, shelves half at FREQ,
  moving paths bit-identical to the dial, zipper on a Q 8 bell <= -118 dB, fuzz clean. A sine on
  a Q 8 notch's note only drops ~-49 dB: `note_w0` truncates the fraction to 1/255 st (~0.4 ct).
  Builds (`scripts/stageEq.ts`: `lp-xd-eq`/`-eq-lfo`/`-notch`, `lp-nts1-*`): only leaf calls
  below the xd's `process`, RAM estimate = bss (72 B an instance). CPU: xd osc 51 base (an LFO
  into freq and gain measured ~120 above the LFO, the table's `control` (noise into every input) reads
  83 above base, see "CPU"; no `heavy-*` variant, since the estimators count those for a
  knob binding, which always takes the still path); xd fx 52 still, 137 with moving control
  inputs. As an effect unit on a real NTS-1 mkII and a real xd, the output matches the host render (`hwtest/functional.ts`, 2026-10-06); not checked inside an oscillator, no listening pass.
- **`filter/tilt`** (2026-10-05): a first-order tilt EQ, TILT +-9 dB per side around CENTER
  (`TILT_DB`: "Bright/Dark x dB"). `y = G*in + (1/G - G)*lp`, a TPT one-pole with its pole at
  CENTER*G, prewarped AT the pivot (`tan(pi*w0)*G`, not `tan(pi*w0*G)`), so the pivot is exactly
  0 dB in the digital filter too. Deliberately not `shape/drive`'s TONE (fixed corner, weights
  only: not 0 dB at its pivot). TILT 0 is bit-exact. Additive `tilt` (depth 100) and `center`
  (100); moving, `tilt_ctl` every 16 samples, ramped. Harness: within 0.007 dB of the prototype,
  pivot within 0.002 dB, plateaus as set. CPU: xd osc 18 base (~68 above an LFO moving TILT; the table's `control` measures it); xd fx 21
  still, 80 moving. 40 B
  state. As an effect unit on a real NTS-1 mkII and a real xd, the output matches the host render (`hwtest/functional.ts`, 2026-10-06); not checked inside an oscillator, no listening pass.
- **`filter/formant`**: 3 ZDF bandpasses on Peterson & Barney formants, `VOWEL` order
  `u o a e i` (alphabetical makes F2 jump). `CHARACTER` (2026-09-29) blends the male table (0, the
  original) -> women's (50) -> children's (100) in note space via the leaf `formant_note`
  (always_inline); SHIFT stays on top. Women's/children's rows are
  from memory of the published averages: check against the paper. Confirmed on both devices (user, 2026-09-30), on the xd at its 668-cycle estimate -- but the user's own patch (VOWEL/CHARACTER on the knobs) later hung an xd at ~1700 real cycles a voice. Quiet at high `RESONANCE` by design (unity peak
  gain; use a VCA). On the xd, `formant_bp_step`/`formant_g_from_note` must stay
  `always_inline` and use their own `formant_note_w0` copy -- removing that brings back a real
  hardware crash at `-Os` that was cornered (11-build bisect) but never root-caused.
  - **Per-block coefficients** (2026-10-06): k and each band's g/a1/a2/a3 (the table lookup,
    `note_w0`, the Taylor `tan` and the one divide per band) are block constants while the inputs
    are unwired or per-block (knobs); the loop runs only the three bandpasses (`formant_step`,
    always_inline). `formant_g` is one shared `noinline` leaf (inlined it was ~1.1 KB per
    instance), so the xd's call shape is `process -> formant_g` (leaf) and nothing else, checked
    on the crash repros (`scripts/stageFormant.ts`: single wired `resonance`, triple-wired, LFOs,
    two instances). A moving input goes through `formant_ctl` every 16 samples: the a's step
    (every sample is a real SVF), `k` -- which also scales each band's output -- ramps; stepped,
    a RESONANCE LFO zippered at -41 dB. Harness (`scripts/runFormantHarness.ts`, xd, ASan/UBSan,
    against renders of the per-sample version): still settings and knob-fed inputs bit-identical;
    a fast full-range LFO (sine source, RATE 90, RESONANCE 90) leaves -61 (resonance) .. -70 dB
    above 1.5 kHz where the per-sample version had -79..-127 -- the price of control rate; the
    formants follow a moving input up to 16 samples late. xd emulator: 495 -> 102 base, 533 ->
    210 `control`, 534 -> 103 `control-still`; the user's patch (whole unit) 622 -> 202; xd fx
    614 -> 103 first. Code (xd osc): 1114 B for the first instance (was 1476 with the old
    `formant_step` helper), +624 per extra (was +232). State 40 -> 88 B (= the bss). On a real
    xd (`calibrateOsc.ts --xd formant`, 2026-10-06) the user's patch measured 513 real cycles a
    voice (was ~1700 and hung), estimate 263 -> 422 converted (-18 %); no listening pass, no
    NTS-1 mkII reading.
- **`osc/additive`**: `TIMBRE` (additive inlet, depth 100) crossfades 6 baked wavetable frames (12312 B,
  ~37.5% of the xd's RAM), with a runtime Nyquist clamp. The 6-frame version builds to 13.6 KB on the xd (17.5 KB on
  NTS-1 mkII) and plays on both devices (user, 2026-09-30).
- **`gain/vca`**: `GAIN` is 0-4x, unity at raw `25`.
- **`shape/drive`** (2026-10-05, for the Radio patch's grit): a saturator with a tone control.
  DRIVE 0..+36 dB pre-gain, linear in dB (`DRIVE_DB`; an effect's input is ~0.18 peak, so the
  clip starts around +15 dB), into the cubic soft clip (bass-support's / the ladder's: no divide,
  unlike `soft-clip`'s `x/(1+|x|)`), then half the drive's dB taken back (`h = 10^(dB/40)`:
  pre-gain `h^2`, makeup `1/h`). TONE tilts around 800 Hz with one one-pole (`DRIVE_TONE`): 0 a
  6 dB/oct lowpass there, 50 exactly flat, 100 the matching highpass. LEVEL is `LEVEL_PARAM`.
  Additive `drive`/`tone` (depth 50). Three always-inline leaves pick the path (`driveCode`):
  both still -> `drive_step` with every gain a block constant; a moving `tone` ->
  `drive_step_t` (a clamp, a few multiplies); a moving `drive` -> `drive_step_h` (an
  `exp_approx` and a divide a sample). Harness (`scripts/runDriveHarness.ts`, xd, ASan/UBSan):
  the settled curve within 1.6e-6 of `clip(c*h^2)/h`, the tilt within 0.05 dB of the one-pole's
  exact response at 65/784/4186 Hz for every TONE, the moving paths bit-identical to the dial,
  fuzz clean. Not lighter than what it replaced in Radio: ~33 xd fx emulator cycles against ~25
  for wavefolder + lowpass-cheap there, where the wavefolder's input (0.3 peak test noise x3)
  never reached a fold, so its loop ran once (a hot input folding costs it ~6 more per fold).
  CPU tables: xd osc 26 base / 27 control; xd fx 26 base, 121 with moving `drive` and `tone`
  (the per-sample `exp_approx` and divide; a control-rate drive would be the next saving).
  As an effect unit on a real NTS-1 mkII and a real xd, the output matches the host render (`hwtest/functional.ts`, 2026-10-06); not checked inside an oscillator, no listening pass.
- **`mix/pan`** (2026-09-30, grain-mill phase 3): equal-power placement ADDED onto a stereo bus
  (`l`/`r` in and out), so pans chain into a mix with no mixer node. Gains are
  `sqrt(clamp((100 -+ PAN)*0.005))`: unclamped, `0.5 - 100*0.005f` went negative in float (a NaN
  from the square root at hard left). Hard left/right is exact (harness). A wired `pan` is
  control-rate (2026-10-01, `pan_ctl`): the gains are worked out every 16 samples and ramped
  linearly in between (two square roots per head per sample were most of reverse-wash's xd
  cost); harness: equal power within 0.001 % through a 4 Hz full sweep, no steps. Unwired or
  wired from a per-block value it stays a block constant. **`mix/width`**:
  mid/side, WIDTH 0 = the mid on both sides (level-kept, unlike grain-mill's L+R), 100 = as is;
  not above 100 (the xd manifest's +-100 cap, found when a 0..200 range failed the manifest test).
- **`mix/pan-mix2`** (2026-10-04): a panning mixer, two mono inputs (`in1`/`in2`) each with
  GAIN (0..100 = x0..x1, shown in dB like `mix2`) and PAN (`pan`'s equal-power law, -3 dB a side
  at the center), summed onto `l`/`r`. GAIN defaults to 70 (-3 dB), so two in-phase full-scale
  inputs at the center peak at 0.99. Additive `pan1`/`pan2` (depth 100); no gain inlets (use a
  VCA). Unwired, each input's two gains (GAIN folded in) are block constants; a moving pan uses
  `pan`'s `pan_ctl` (every 16 samples, ramped), with GAIN multiplied per sample. Harness
  (`scripts/runPanMixHarness.ts`): every gain within 3e-8 of `GAIN*sqrt((100-+PAN)/200)`, hard
  left/right exact, an LFO on `pan1` keeps l^2+r^2 within 0.0014 %. xd emulator: 4 cycles in an
  oscillator; in an xd effect 12 still, ~65 with both pans moving. State 56 B (= the xd bss over
  a pass-through). Staged: `lp-fx-panmix` / `lp-xdfx-panmix` (modfx, L/R in, TIME pans the left
  input, DEPTH the right, a pass-through at the defaults). No hardware pass yet.
- **`mix/stereo-crossfader` + `mix/stereo-mix2`** (2026-10-03): `crossfader`/`mix2` for a stereo
  pair (`l1`/`r1`, `l2`/`r2` in; `l`/`r` out), so an effect's dry/wet is one node with ONE FADE
  (one device control) -- every effect example had a crossfader pair whose dials had to match,
  and they all use the stereo one now (`stereo-reverb` also sums its combs with three
  `stereo-mix2`s instead of six `mix2`s). The crossfader's `LAW` is Power (`crossfader`'s) or
  Linear (unity for a wet signal correlated with the dry one, where Power swells +3 dB at the
  centre); both sides share the gains, so a wired `fade` costs two square roots, not four. Both
  crossfaders keep the fade in percent (`sqrt((100 - p)*0.01f)`) so both ends are exact:
  `1 - 100*0.01f` isn't 0 in float, which let ~-72 dB of the first input through at FADE 100
  (plain `crossfader` too, until 2026-10-03; the NTS-1 mkII lpmix harness check is exact now). Harness
  (`runNts1FxHarness.ts`): FADE 0/100 bit-exact, Power centre 1.41421, Linear unity, a wired fade
  identical on both sides; stereo-mix2's gains exact. Both fx sweeps link (xd: leaf calls only);
  the changed examples build on both platforms. xd emulator 4 / 0 cycles, like their mono
  siblings. No hardware pass yet.
- **`logic/chance`** (a gate passes whole with CHANCE %, drawn at its rising edge; harness 0 /
  0.515 / 1 at 0/50/100) and **`logic/round-robin`** (each gate to the next of `o1`..`oVOICES`,
  the first to `o1`; the counter + demux8 of grain-mill) (2026-09-30).
- **`env/ad` `EXP`** (2026-09-30): exponential decay for grain-mill's grain envelope -- the same
  `ad_env_step`, fed `decayRate * (level + 0.01)`: DECAY is the TIME CONSTANT (-8.7 dB at it,
  -60 dB ~7x later), the 0.01 linear floor so it reaches 0 (~4.6x DECAY) and idles. It first
  meant "-60 dB at DECAY" (x6.9): grain-mill's voices then died long before their next turn and
  feedback 100 faded fast (user, a real NTS-1 mkII, 2026-10-01). Harness: 0.3615 at T. xd emulator: the
  EXP check costs every `env/ad` ~12 cycles (base 25 -> 37), on or off.
- **Wired `env/ad`/`env/ahd` times are control-rate** (2026-10-01): a wired `attack`/`decay` is
  re-read every 16 samples (`env_rate_ctl`: the clamp and `env_rate_from_percent`'s divide), not
  every sample; unwired they stay block constants. xd emulator: ad with control inputs 150 -> 73,
  ahd 139 -> 59. Found profiling grain-mill on the xd, where they were ~20 % of the unit.
  **`mix/crossfader`**'s two square roots are block constants while `fade` is unwired (34 -> 4;
  16 since the knob smoothing).
- **`env/ad` vs `env/ahd`**: `ad` always runs to completion and ignores note-off; `ahd` holds
  until note-off (`noteOffStatement`). Separate primitives on purpose.
- **`env/multistage`** (2026-09-28): a six-stage breakpoint envelope for modulation (the device's
  own filter/amp envelopes follow the unit). `L1`-`L6` bipolar levels, `T1`-`T6` times (0 = one
  sample, else `8000*t^3` ms), one `CURVE` (cubic bend, + = fast start), `MODE` one-shot /
  sustain (sits at the end of stage `HOLD`) / loop (`HOLD` wraps to `LOOP` while held) / cycle
  (free-runs from power-on), `TIME` 0.1-10x and `DEPTH` +-100% macros with additive inlets.
  Outlets `env` (bipolar) and `eoc` (a one-sample gate at each wrap and at the end); it can't be
  called `out`, which codegen treats as the single-outlet case. A wired `gate` replaces the note
  (and suppresses the note-on retrigger); unwired, note-on always restarts (legato too), from
  the current level. `mseg_step` is a leaf: the six rates (`stageRate_[6]`) are converted by the
  T params' set statements (`mseg_rate_from_percent`; before 2026-10-05 per block, ~10 xd fx
  cycles a sample with 64-frame blocks), a moving `time` is re-read every 16 samples
  (`mseg_time_ctl`, as ad/ahd's times), at most one stage change per sample and rate <= 1, so zero-time
  loops can't spin. `MODE`/`HOLD`/`LOOP` are 0-based selects (`SelectParam.names` gives NTS-1
  mkII the mode names; the xd shows 1..N). Harness-checked per mode (ASan/UBSan clean); real
  ARM builds link on both (`scripts/stageMultistageEnv.ts`), `mseg_step` is inlined into the
  xd's `process`, and the xd RAM estimate matches its bss exactly. Emulator cost (xd, per
  voice-sample, table of 2026-10-05): 110 base, 42 with control inputs wired, 100 for
  `heavy-cycle` (cycle mode, short stages, inputs wired) -- counted once MODE or another param is on a knob. Moving the
  hold/loop clamps per block or adding a sustain early-return didn't pay off at `-Os` (+15 for the
  early return). Confirmed on both devices, all four modes (user, 2026-09-30).
  Defaults give every stage a nonzero time and its own level (L 100/50/70/30/15/0, T
  15/25/25/25/25/35; user, 2026-10-03): with T4-T6 at 0 the last three graph points sat on T3's
  and were hard to grab. A file that never touched those params now plays the new shape.
- **`env/adsr` + `env/one-knob-adsr`** (2026-10-02): an ADSR (none existed: `ahd` has no
  sustain level) and the same core with its four stages picked by one SHAPE knob, after the
  user's Axoloti `one-knob-adsr` subpatch. A primitive, not a subpatch: there was no ADSR and no
  table node to build one from, and per block the table read is free. Shared `adsr_env_step`
  (leaf): linear attack, EXPONENTIAL decay/release (no curve param), each within 1 % of its
  target at its time (`ADSR_EXP_K` = ln 100); a release from a sustain below 1 ends sooner
  (Keys' 400 ms from 0.4: ~320 ms). Times on `multistage`'s cubic curve (`adsr_rate`, 8000*t^3
  ms). Gate like `multistage`: a wired `gate` replaces the note; unwired, note-on (legato too)
  restarts from the current level, and a LOW gate in attack/sustain releases -- by level, not
  edge, so a note that ends in its first block can't stick (it stays silent instead). Both work
  in effects with a wired gate. One-knob: 13 stations short to long (`KNOB_ENV_SHAPE_NAMES`:
  Blip..Drone, table `KNOB_ENV_STATIONS` in `env.ts`, ear-picked) every 8.33 of SHAPE; within a
  fifth of the spacing it is exactly the station, between two the stage percents blend (so on
  the cube-root curve, close to a log blend). `paramPresentation.ts`' label mapping mirrors the
  C one (`logue-oneKnobAdsr.spec.ts` pins the constants). SHAPE's inlet is additive at depth 100
  (a morph, like crossfader `fade`); TIME is `multistage`'s 0.1-10x. Unwired or from per-block
  values all four stages are block constants; from a moving source `knob_env_step_ctl`
  (always_inline) re-reads them every 16 samples. NTS-1 mkII shows the station name ("Pluck",
  "Plk-Mlt" between) through the new `PrimitiveParamSpec.nts1mkiiStrings` (a `strings` row over
  the spec's own 0..100, not a select, so it still blends); the xd shows 0-100 %. Harness
  (`scripts/runAdsrHarness.ts`, xd, ASan/UBSan): every station's A/D/S/R within ~1-5 % of the
  table, TIME 0/100 exactly 0.1x/10x, no non-finite samples wired or unwired. Real ARM builds on
  both (`scripts/stageOneKnobAdsr.ts`): only leaf calls below the xd's `process`, RAM estimate =
  bss. xd emulator: adsr 46, one-knob 51 base, ~95 above its LFO with SHAPE moving
  (`heavy-moving-shape`). No hardware pass yet; the NTS-1 mkII strings row is unconfirmed on a
  device.
- **Envelope `trig` + `sense/gate`**: a rising `trig` retriggers like a note-on (from the
  current level); the check lives inside `ad_env_step`/`ahd_env_step` and is a real no-op when
  unwired. `ahd`'s `trig` never moves hold to decay. `sense/gate` outputs `1.f` while a note is
  held; wired straight into `trig` it reproduces the note-on retrigger, through `logic/edge` it
  becomes a one-shot pulse. Per-instance state, not the Osc-level sense members.
- **An unwired LFO `RATE` is a block constant** (`lfoRate`, `primitives/lfo.ts`, 2026-10-01):
  all seven LFOs used to convert it every sample. Output-identical.
- **Every `lfo/*`'s `trig`**: a rising edge resets the phase one sample late
  (`lfoTrigResetStatement`, after the advance). `random-steps` resets to `1.f` so it latches a
  fresh value at once. `prevTrig_` is always declared (+4 B). Legato notes give no edge.
- **`sense/control`**: `VALUE` (0..100, `freeLabel`) is set by whatever device control the param
  has on the build target -- a menu slot, a knob, or following a slot -- and the outlets carry
  it; with none it's the constant `VALUE` (`listUnboundDeviceControls`, `deviceControls.ts`, lists
  those for a warning). Works on both platforms (`sense/param` was xd-only for no technical
  reason). Placed in a root patch it starts with NO device control (user's call, 2026-09-29: auto-taking
  a menu slot on both platforms made Export fail until it was named); its "Not on <device>" badge
  and the Build warning point at the Param Matrix. Inside a definition it's promoted instead. A migrated Shape reader writes `sense_ = (0 + shape01_*100)*0.01`, not
  the old bare `shape01_` read -- equal up to float rounding.
- **`sense/*`**: `cutoff`/`resonance`/`param` are xd-only, `velocity` NTS-1 mkII-only (latched
  per instance in `noteOnStatement`; `readsVelocity` makes that generator name its `velo`
  argument). `sense/velocity` reads the NTS-1 mkII's own key velocity (user, 2026-09-30: a unit sending it to pitch followed how hard the keys were pressed; the device also scales the level by velocity itself). Every sense
  primitive except `gate` has `unipolar`/`bipolar` outlets, `unipolar` first so an old net on
  the implicit `'out'` resolves to what it read before; that fallback
  (`resolveDeclaredOutletName`) is shared by codegen and the canvas so both agree.
- **`logic/greater-than`/`less-than`/`equal`/`schmitt`**: a `THRESHOLD` dial (-100..100, like
  `util/constant`) plus an optional `b` inlet added raw and unclamped (an operand, not a
  modulation): unwired `b` compares against the dial, `THRESHOLD=0` with `b` wired compares two
  signals. `equal` needs `TOLERANCE` (exact float equality is unreachable). `schmitt` adds
  `HYSTERESIS` for a dead band.
- **`util/slew`** (2026-10-04): a slew limiter with separate `RISE`/`FALL` (the envelopes'
  `8000*t^3` ms curve, `MSEG_STAGE_MS`) and `MODE` Linear (fixed speed: the time is for a change
  of 1, so a bigger jump takes longer -- glide's character) / Exponential (a one-pole per
  direction: every jump lands within 1 % of its target at the set time, `ln 100` like `adsr`).
  Additive `rise`/`fall` (depth 50); block constants unwired, re-read every 16 samples when moving
  (`slew_rate_ctl`). 0 is a true pass-through (the step lands exactly on the target; a saw through
  RISE/FALL 0 is bit-exact). Kept beside `glide` (user's call): glide is the one-knob portamento,
  and growing it would have changed old patches. Harness (`scripts/runSlewHarness.ts`, xd,
  ASan/UBSan): every jump time within a sample or two of the curve in both modes, wired paths
  clean. xd emulator 25 base. Confirmed on a real xd and a real NTS-1 mkII (user, 2026-10-04).
- **`math/scale`** and **`util/glide`** overlap existing nodes on purpose: `scale` saves a
  VCA+negate pair for control signals; `glide` is a linear slew limiter, a different character
  from `lowpass-cheap`'s exponential lag. `scale`'s factor is `FACTOR/100 * RANGE` (RANGE a select
  x1/x2/x4/x8, 2026-10-02, default x1): a select rather than a wider FACTOR because of the xd's
  +-100 manifest cap, and 0.5x/2x stay exact. Both set statements recompute the one `factor_`
  the loop reads (not an `initStatement`: an effect's reset re-runs those, not the param sets).
  FACTOR's dial shows the real factor through `PrimitiveParamSpec.unitDependsOn` (a unit
  following another param, read live like the value; a promoted param shows none).
- **`mux/mux4`**: a wired `index` is read -1..1, rescaled to 0..3 and rounded (`mux4_select`).
  All mux nodes hard-switch (click on audio); `crossfader` is the tool for a fade. A wired
  `sel`/`index` replaces the dial.
- **`util/sample-delay`**: z^-1, the only node a feedback loop may pass through. `in` is a
  `delayedInlets` entry, read only in `advanceStatement` (`logue-feedback.spec.ts` pins that).
  `sample_delay_store` resets inf/NaN to 0 and clamps to +-4, so a gain>1 loop saturates to a
  loud rail instead of NaN. Harness-verified; no hardware listening pass yet.
- **`util/delay`** (2026-09-29): a 0.1-20 ms delay for chorus/flanger/doubling. `TIME` (squared,
  `0.1 + 19.9*t^2` ms), `FEEDBACK` -100..100 (coefficient up to 0.95), `MIX` dry->wet; additive
  `time`/`feedback` inlets and deliberately no built-in LFO (user's call: wire one). 16-bit ring
  buffer of 1024 (2 KB; stored over +-2, clamped, so feedback stays bounded) with a 4-point
  Hermite read, so a swept time glides. Not a loop-breaking node (its dry path reads `in`
  directly). Harness: delay exact at every TIME, 16-bit residual -75..-88 dB, +-100 feedback
  bounded (a full-scale saw at +-100 does hit the output's clip), no jumps when swept. Leaf call
  from the xd's `process`; xd RAM estimate matches the build. xd emulator 154 base (mostly the
  Hermite read), 190 wired. `util` rather than a new `fx` category, which would reflow every
  palette colour. Confirmed on both devices (chorus/flanger on a saw) (user, 2026-09-30).
- **`util/buffer` + `util/buffer-tap`** (2026-09-30, effects only, phase 1 of grain-mill,
  `docs/PLAN-grain-mill.md`): a recording ring in SDRAM, int16 over +-2 (`LENGTH` structural,
  0.68/1.4/2.7/5.5 s = 64..512 KB), read through its `buf` buffer wire. The writer stores in
  `advanceStatement` (`in`/`freeze` are `delayedInlets`), so every reader sees delay 1 as the
  newest sample whatever the emit order, and a reader may feed its own buffer (an echo loop needs
  no `sample-delay`). `FREEZE` (or a gate on `freeze`, OR'd) glides the stored value to the
  slot's own content over ~5 ms and then stops writing, so a frozen loop is bit-exact (no
  re-quantizing wear); the index keeps moving. `buffer-tap`: TIME 0..100 % of the ring (3 samples
  to length-2), 4-point Hermite, additive `time`, no smoothing. Harness (`runNts1FxHarness.ts`):
  taps exact (3 and 16384.5 samples), echo loop halving per pass, freeze repeats with the ring's
  period bit-exactly, NaN SDRAM cleared. Both link in the fx sweeps (a writer+tap pair ~660 B on
  NTS-1 mkII, ~680 B on the xd, leaf calls only); scripts that build a primitive alone add its
  partner via `scripts/bufferPartners.ts` (so a writer's measured code includes a tap and vice
  versa: the code-size estimate counts a pair about twice). CPU on a real NTS-1 mkII (user,
  2026-09-30, `stageFxUnits.ts`' `lp-fx-buf1`/`lp-fx-buf4` with the probe): 588 cycles/sample
  for buffer + 1 tap + freeze compare + 2 crossfaders, 1061 with 4 taps -- ~150 per tap (four
  int16 SDRAM reads). Freeze holds and the 16-bit
  buffer sounds clean on the device (user, 2026-09-30).
- **`util/grain`** (2026-09-30, effects only, grain-mill phase 2): the Axoloti grain-player as one
  node. On a rising `trig` it latches POSITION (0 = newest .. 100 = oldest of the buffer, delay
  `1 + p*mask`), SIZE (10 ms + cubed up to MAXLEN) and FADE (16 samples + a share of half the
  grain), records that many samples from a `buf` at that fixed delay into its own int16 table
  in SDRAM (MAXLEN structural: 0.34/0.68/1.4 s = 32..128 KB) with the ramps baked in, then loops
  the table bit-exactly until the next trigger. Deliberate change from the original: what was
  playing at the trigger ramps out over the fade (`hold_`), instead of crossfading against the
  old table's start (a click). Unwired `trig`: retriggers at every pass (a stream of grains).
  `position`/`size` are additive (depth 50) and read only at a trigger: they're passed unclamped
  and clamped/cubed inside the trigger branch (2026-10-01, ~30 cycles a voice saved on the xd). `grain_step` is
  `always_inline` since 2026-10-01: its 14-argument call cost more than much of its body (a copy
  per voice: grain-mill's xd units grew 5.3 -> 7.1 KB of 12). Harness: capture exact, loop
  bit-exact, seam faded, POSITION 50 exact, a retrigger's largest step = the sine's own slope.
  Links in both sweeps (~460 B over its writer). Works as designed on a real NTS-1 mkII (user,
  2026-09-30, `lp-fx-grain`: one grain on a square-LFO clock, SIZE on DEPTH, freeze at the top):
  504 cycles/sample for the whole unit vs 588 for buffer + 1 tap, so a grain voice is roughly
  70-100 cycles (one int16 SDRAM read + one write while capturing, one read looping).
- **`util/reverse-tap`** (2026-10-01, effects only, `docs/PLAN-reverse-delay.md`): plays a
  `util/buffer` backwards in segments of SIZE (40 ms .. half the ring, squared; `size` additive
  50), two heads half a segment apart (`a`, `b`), each windowed by WINDOW (5 ms fades .. a full
  smoothstep crossfade), plus `phaseA`/`phaseB` (0..1 across each head's own segment, one per
  head because `1 - phaseA` jumps where b peaks). Head a reads delay `2c + 1` at sample c: a
  whole-sample read at exactly -1 speed, nothing to interpolate. SIZE/WINDOW are read at a's
  midpoint for a's NEXT segment, which is also when b's next segment starts (ending at that
  segment's midpoint) -- so both heads' lengths and fades stay matched while SIZE moves and no
  read jumps mid-segment; both heads in one node because two instances couldn't stay locked.
  Why a primitive: a ramp LFO sweeping a buffer-tap reverses too, but only at fixed lengths --
  its speed is rate x span, and an integer device RATE is 15-90 ct off. Harness: every segment
  an exact reversal (16-bit) at fixed and swept SIZE, b at the half, `a + b` constant within
  3e-5 at WINDOW 100 (also while SIZE moves). ~1 KB code per instance on the xd (always_inline,
  leaf). With WINDOW < 100 the two heads overlap above unity: use one head, or accept it.
- **`util/long-delay`** (2026-09-30, effects only): an echo on a line in the effect's SDRAM
  (`LoguePrimitive.sdramFloats`, see "Effect units"). `RANGE` (0.34/1.4/2.7/5.5 s = 64 KB..1 MB)
  is a `structural` param: it sizes the line, so exposing it or putting it on a knob/follow is
  an export error. TIME is linear over the RANGE; `SYNC` replaces it with a `DIVISION` (1/16..1/1,
  dotted/triplet) of a beat at the device tempo (`tempo_`, from `unit_set_tempo`). The read
  point glides toward a new time (one-pole, ~42 ms: tape-like bends). FEEDBACK up to 0.98 with
  comb's soft knee on what recirculates, DAMPING a one-pole in the loop, MIX dry to wet built in
  (user's call over a wet-only node whose input could close loops -- so a loop between delays
  still needs `util/sample-delay`). Harness: TIME exact to the sample (8191.5 at RANGE 0/TIME
  50), SYNC exact (28800 at 100 BPM, 1/4), MIX 0 exactly dry, NaN-filled SDRAM cleared.
  Confirmed on a real NTS-1 mkII (user, 2026-09-30): stereo echo, tempo sync, a modfx using
  exactly its 256 KB, repeated unit switching.
- **`filter/allpass`** (2026-09-30, effects only): a Schroeder allpass (`w = x + g*w[n-D]`,
  `y = w[n-D] - g*w`) on an 8192-float SDRAM line, the diffuser of a reverb. TIME 0.5-100 ms
  (squared), GAIN +-0.9. A static TIME is rounded to whole samples: linear interpolation inside
  the loop is a lowpass (a 788.2-sample delay kept 76% of an impulse's energy; rounded: 100%,
  harness). A wired `time` stays fractional so it glides. A static TIME is a block constant
  read by the inlined `allpass_step_int` (one SDRAM read, 2026-10-01): output-identical (the
  reverb harness numbers didn't move), ~95 -> ~50 xd emulator cycles each (penalty 8).
- **`filter/hilbert` + `util/freq-shift`** (2026-09-30): a Bode frequency shifter and its
  reusable core. `hilbert_step` (`primitives/shared.ts`) is Niemitalo's 8-coefficient pair: the
  published values SQUARED, the one-sample delay on the chain starting at 0.6923878 (either
  mistake is a few to tens of degrees off, the wrong delay the worse one). `q` lags `i` by 90 +- 0.7 degrees from ~25 Hz to 23.9 kHz; below
  ~15 Hz it falls apart. It's `always_inline` (freq_shift_step calls it); 21 floats of state, one
  history slot per parity (z^-2 sections). `freq-shift`: `shifted` moves every partial by SHIFT
  (`2000*s^3` Hz, -100..100, through zero), `mirror` by -SHIFT; FEEDBACK +-90% is the previous
  `shifted` through comb's ~1.5 Hz DC blocker and soft knee (only the fed-back term, so MIX 0 is
  bit-exact dry). The blocker is needed: at SHIFT 0 the pair passes DC at +1, and without it
  FEEDBACK 100 lifted a 0.1 DC input to 0.84. Additive `shift` (depth 100, a +-1 LFO sweeps through
  zero) and `feedback` (50) inlets. The carrier is `osc_sinf`, so both work in oscillators too.
  An outlet can't be `out` (multi-outlet), hence `shifted`. Harness (`runNts1FxHarness.ts`,
  `runXdFxHarness.ts`): other sideband -47..-51 dB over the band, -44 at 30 Hz, -37 at 20 Hz;
  at FEEDBACK +-100 (measured behind a 0.25x VCA, since the unit's output clip hides it) 0.1 DC
  settles at 0.10-0.11 and full-scale noise peaks at ~3.3 (bounded). Both link clean in the fx
  sweeps (xd: leaf calls only). xd emulator 105 / 285 (322 wired). Example `examples/effects/freq-shifter.loguepatch`.
  As an effect unit on a real NTS-1 mkII and a real xd, the output matches the host render (`hwtest/functional.ts`, 2026-10-06); not checked inside an oscillator, no listening pass.
- **`env/follower`** (2026-09-30): rectify x gain, one-pole up at ATTACK (0.1-100 ms) and down
  at RELEASE (1 ms-2 s), clamped 0..1. The gain goes to +24 dB because an effect's input is quiet
  (~0.18 peak for a saw on NTS-1 mkII). It is `SENS` since 2026-10-03 (was `GAIN`, a
  value-preserving `renamedParams` alias; user's call: what it decides is where the output tops
  out, the Radio patch's follower sat at 1), shown as the input level that reaches full output
  (`FOLLOWER_SENS_DB`, "full at -18.6 dB" at the default 50); below it the output stays
  proportional, so it is no gate threshold. Only the exposed device name changed. Coefficients are block constants. Harness: attack within
  1 ms, RELEASE exactly its time constant. xd emulator 20 cycles.
- **`sense/tempo`** (2026-09-30, effects only): `clock` (a one-sample gate each DIVISION of a
  beat at `tempo_`) and `ramp` (0..1 across it). Counts samples against the period (a phase
  increment drifted a sample per period); free-running from load -- it has the tempo, not the
  downbeat (`unit_tempo_4ppqn_tick` isn't read). Harness: clocks exactly 14400 apart at 100 BPM,
  1/8.
- **`util/quantize`** (2026-09-29): snaps a signal to a scale in the `pitch` inlet's units (+-1 =
  +-24 st), for melodies from LFOs/random steps. `SCALE` (10 presets, masks in
  `QUANTIZE_SCALE_MASKS`, NTS-1 mkII names <= 7 chars) and `ROOT` (C..B) are 0-based selects.
  Outlets `pitch` (bipolar) and `trig` (a one-sample gate on each note change, so a quantized
  melody can play an envelope). A quarter-semitone of hysteresis stops chatter on a boundary
  (noise larger than that still chatters). Fast path: within 0.5 st of the current note nothing
  can change, so the scale search is skipped -- xd emulator 65 base, 184 for noise input
  (`heavy-moving-input`). Harness: every note in scale over +-24 st, one trigger per change.
  Leaf helper; xd RAM estimate matches the build. Confirmed on both devices (user, 2026-09-30). `ROOT`'s names are flats (`Db`..`Bb`): the NTS-1 mkII displays `#` as a blank.
- **`lfo/fast-square` + `util/sample-hold`**: a naive (no PolyBLEP) pulse clock with `WIDTH` and
  `TRACK` (free RATE 0.1 Hz-2 kHz vs the played note; no `harmonic` inlet, its x16 can break the
  single-`if` wrap), and a sample-and-hold that latches `in` on a rising `trig` (passes `in`
  through with `trig` unwired). `WIDTH` 0/100 has no edges. `lfo/random-steps` is the clocked,
  noise-by-default one. Confirmed on both devices (user, 2026-09-30).
- **`websim` (`make wasm`) is broken for every generated NTS-1 mkII unit** (the COARSE/FINE
  `setPitch` change never reached Korg's `dummy-osc/wasm.cc`). Use the host harness or hardware.

## Canvas & UI

- Node ids are a node's own `name` (nets address nodes by name); an unnamed node (comment) gets a
  synthetic `__unnamed_${index}` id. `PatchCanvas.tsx` remounts (key = `filePath`+`reloadNonce`+
  the subpatch library's `version`) on every structural mutation except a plain node move, and
  whenever a saved definition changes, so an edge's derived state always matches the store's
  current `nets` and every instance's current definition.
- Port/wire coloring (`ports.ts`, `portColors.ts`, `wirePolarity.ts`, `primitives.ts`'s own
  `outletPolarity`) — display-only for every signal (the `buffer` bucket/role alone is also read
  by codegen, see "Graph resolution"). Colors by SIGNAL SHAPE,
  not by source category: green = audio, blue = unipolar (`0..1`, an envelope/`sense` reading),
  amber = bipolar (`-1..1`, an LFO/oscillator-as-modulator/`util/constant`), purple = a discrete
  gate (`logic/*`, `sense/gate`), rose = a buffer wire (a ring-shaped dot; the one bucket codegen
  reads, see "Graph resolution"). Shape is a second, redundant cue (round/square/diamond) for
  colorblind accessibility, independent of hue. Every primitive declares a required
  `outletPolarity` (a fixed bucket, or `'inherit'` for a genuine pass-through/combiner — a
  filter, VCA, mixer, math/mux node — whose own outlet is only as meaningful as whatever's wired
  into its `audio`-role inlet(s)); `wirePolarity.ts` resolves `'inherit'` recursively backward
  through `doc.nets` (memoized, cycle-guarded), falling back to a 5th neutral gray when a
  combiner's own inlets disagree or resolution hits a cycle. Inlet role (`{name, role?:
  'audio'|'control'}`) is a separate, simpler concept: only decides an unwired inlet's own
  shape/neutral-color, since a control inlet accepts any bucket. Resolution priority:
  `logue/io/audio-out` fixed inlet → `resolveNodePrimitive` (registry primitive, the two
  subpatch port nodes, or a subpatch instance's synthesized stand-in) → wiring-inference
  fallback (covers a stale/unresolvable type). Every canvas consumer resolves through
  `resolveNodePrimitive`, never bare `findLoguePrimitive`, or subpatch instances go blank there.
- Insertion: `LoguePrimitivePalette.tsx` (sidebar, grouped/collapsible by category, filterable)
  and `ObjectInsertPopup.tsx` (double-click empty canvas, or Space with the pointer over the canvas -- React Flow's Space-to-pan is disabled for it, filter+Enter-picks-first-match) share
  one data source, `loguePrimitiveCatalog.ts`, so the two can't disagree on what's shown/
  supported (`useInsertableEntries`: every primitive, the library's subpatches grouped per
  subfolder as `subpatch/<folder>`, and the inlet/outlet port nodes only while editing a
  definition). Both go through `insertSpecialObject` (`patchStore.ts`) — a plain `obj` node.
  A primitive whose `modules` exclude the document's is hidden, not badged (user's call,
  2026-09-30: it can never build there), in both lists and among subpatches; a definition is
  offered everything. Insert-only (not "Replace with…", `useInsertableEntries(forInsert)`):
  control presets per module (`controlPresetEntries(module)`): an oscillator's "control · shape
  knob"/"control · 2nd shape knob", an effect's time/depth knob (plus "control · mix" on
  delay/reverb) (`sense` group, id
  `logue/sense/control@<knob>` mapped by `insertArgsFor` to a plain control bound to that knob on
  both devices -- also inside a definition, where a knob binding is kept). No menu-param preset:
  that needs a slot order and a name.
  Both also offer a canvas comment (`COMMENT_ENTRY`, its own grey `annotate` group, inserted via
  `insertComment`; also the C/⌘5 shortcut) -- not a primitive, generates no code. The node
  context menu's "Replace with…" reuses the popup without it.
  The sidebar palette (2026-10-02): a PRIMITIVES header with expand/collapse all, per-category
  counts, ⌘F or `/` focuses the filter, Enter inserts the first match, Esc clears. An entry
  dragged onto the canvas (`PALETTE_DRAG_TYPE`, `PatchCanvas.tsx`'s `handleDrop`) lands under the
  pointer; a click places it via `freeSpot.ts`: the mounted canvas registers
  `findInsertPosition`, which picks the free grid spot nearest the visible viewport's center
  (existing nodes, minimap and zoom controls count as occupied; new-node size estimated from the
  primitive's ports/params), or the least-overlapping one in a full view. Falls back to the old
  cascading grid only when no canvas is mounted.
  Both show each primitive's `description` (carried on `PrimitiveCatalogEntry`): the palette as
  a wrapping popover beside the hovered item (`GlobalTooltip`'s opt-in
  `data-tooltip-side="right"`), the popup in a right-hand column for the hovered row, else the
  ↑/↓-highlighted one.
- **Sidebars** (2026-10-02, user's call): the left column is the palette alone; the right is the
  Inspector (scrolls) over the Build panel (pinned at the bottom, so the Build button doesn't move
  with the selection). Inspector param rows are one grid line each: label, value, and the dial's
  own device tags (`SlotBadges`) as the Param Matrix button. Warnings in both panels are one-line
  `WarningLine`s (`build/WarningLine.tsx`) that expand to the explanation.
  A node's header is ONE category-tinted row: the name in bold (double-click to rename), the type
  muted on the right, taking only leftover width (`.patch-node__type`; `autoArrange.ts`' size
  estimate counts the name alone). A param-less primitive with one outlet and at most one inlet,
  or two for `math/*`/`logic/*` (`canvas/compactNode.ts`' `isCompactPrimitive`: the polarity
  converters, negate, one-minus, abs, edge, sample-delay, sense/gate, add/subtract/multiply/min/
  max, and/or/xor;
  2026-10-04) is drawn as that header row ALONE, jacks on its edges (two operands stacked on the
  left, `a` on top, the jack's tooltip naming it), sized by its content -- unless it has a badge to show (an issue, Renamed, Only on).
  `autoArrange.ts`/`freeSpot.ts` estimate it from the same predicate. No canvas text is under 10px (the user zooms the whole UI for
  reading; small badges didn't scale usefully).
  There's no toolbar strip above the canvas: undo/redo/arrange-by-flow are `ControlButton`s under
  React Flow's zoom controls (`PatchCanvas.tsx`), both arrange actions are in the native Arrange
  menu (`useArrangeActions.ts`), and the file path is the tab's tooltip (⌘-click reveals it).
- `ParamDial.tsx` (on-canvas draggable dial) and `Inspector.tsx`'s param row read/write the SAME
  `setLogueParam` store action — editing either updates the other live. `ParamDial` reads its
  value live off the store on every render rather than off React Flow's mount-time node data,
  since `setLogueParam` deliberately never bumps `reloadNonce`; `Inspector.tsx`'s own inputs are
  uncontrolled (`defaultValue`) and are keyed on the CURRENT value (not just node+param name) for
  the same reason — so an external write (e.g. from the dial) forces a remount instead of showing
  a stale value. TRACK/SYNC gating is read the same live way everywhere through
  `canvas/trackGateState.ts` (`useIsTrackGated` on the canvas, `isNodeTrackGated` in the
  Inspector). A `Param N` badge on the dial shows the exposed slot; nothing renders when
  unexposed (never an ambiguous placeholder). An adjacent `COARSE`/`FINE` spec pair shares one
  row (`groupTuningPairs`, `ObjectNode.tsx`). A `freeLabel` param (`logue/sense/control`) is
  placed unassigned (`initialFreeLabelParam`) and needs a label once it takes a menu slot. Taking a slot in the Param
  Matrix (`setPlatformSlotOrder`) clears that param's `logueKnob`/`logueFollow` on the same
  platform (`withoutPlatform`), since a param has one device control per platform. `resolveParamDefaultValue` throws
  `InvalidLogueParamError` on a non-numeric/out-of-range authored value — a bad value would
  otherwise bake straight into a C++ literal, so this must be a loud export-time error.
- **Device Param Matrix** (`ParamMatrixOverlay.tsx`, titled "Device Params", opened via the grid
  icon in the Inspector header, Device › Device Param Matrix…, or right-click on a param): ONE
  platform at a time (`build/PlatformToggle.tsx`, the same component and `targetPlatformStore.ts`
  as the Build panel's build target). Slots, reserved rows and knob rows come from
  `deviceLayout(platform, module)` (`exposedLogueParams.ts`, read off `unitKinds.ts`): an
  effect's TIME/DEPTH(/MIX) rows are its reserved Params 1-2(-3); a definition gets every knob of
  the platform; an xd effect has no menu params at all (`maxParams` 0), so it shows only its
  knob rows, like a definition (`knobsOnly`); `structural` params
  (long-delay's RANGE) are left out of the pool. Top: a slot
  list that IS the device order (NTS-1 mkII's fixed Shape/Alt slots shown locked), drag to reorder
  (native HTML5 DnD, armed from the grip only), × to remove. Below: every other param on the
  document as "+ PARAM" chips grouped by node (params of primitives not on this platform hidden;
  outlined when already assigned on the other platform), plus "Copy the <other> order" when this
  platform is empty. Above the slots, one row per fixed knob of the platform (Shape, Shape 2 --
  NTS-1 mkII's reserved slots 1/2), each listing every
  param bound to it (`listKnobAssignments`: a bound `sense/control` also shows where it's wired, a
  subpatch instance binding it inside shows as "(inside)", a not-yet-migrated legacy reader as its
  node), × to unbind. Followers sit on their own line under their lead's slot row. A pool chip is
  clicked to become a menu param, or DRAGGED onto a knob row (bind) or a slot row (follow) -- still
  draggable when every slot is used. Edits go through `setPlatformSlotOrder`/`setKnobBinding`/
  `setSlotFollow`, all one `PlatformControlLayout` rewrite (`patchDocHelpers.ts`'s
  `currentPlatformLayout`/`applyPlatformLayout`, one undo step): a param gets one control per
  platform, slots are laid out gap-free via `slotsForOrder` (xd contiguity can't be violated, and
  an NTS-1 gap from an older file closes on the first edit), a follower is kept by its lead's identity so it moves with it (and is dropped when the lead leaves), and taking a slot or knob ends the param's other control there. Deleting a node, replacing its type or removing a param entry runs `dropOrphanedFollows`, so a follower never outlives its lead (a file edited elsewhere that has one shows it back in the pool). **Every param's device name is editable here** (not just
  `freeLabel` ones): `ParamValue.label` is one value shared by both platforms, codegen already
  used `label || spec name` for all params; `requiresLabel` (a `freeLabel` param that isn't a
  promoted subpatch param) flags an empty name, and an exposed-on-NTS-1 label over
  `UNIT_PARAM_NAME_MAX_LEN` (21) is flagged. `Inspector.tsx` has no slot/label editor, just a button opening
  this. `computeCrossPlatformExposureWarnings` (shown unconditionally in `BuildPanel.tsx`) still
  flags a param with a device control on the OTHER platform but none on the current build target
  (except `sense/control`, whose own `listUnboundDeviceControls` warning says it outputs a
  constant). Inside a subpatch definition the Matrix shows only the knob rows and the definition's
  unpromoted params (a knob there drives every instance). On canvas, dial badges read `xd 3`
  (slot), `xd SHP`/`SH+`/`ALT` (knob) or `xd ↳3` (follows Param 3), and a
  `sense/control` carries a badge naming its control on the build target -- "Not on <device>" and
  dimmed outlets when it has none (read live from the store, since layout edits don't remount).
  That badge is a button opening `DeviceControlPicker.tsx`: one select per device (None, each
  knob, "Menu param" -- appended last -- or "Follows <lead>"), through the same store actions, so
  choosing "this is the Shape knob" never needs the Matrix (only knobs inside a definition; a
  promoted control's badge reads "per instance" and is disabled). Device names are edited ONLY in
  the Matrix (user's call, 2026-09-29: a "Label…" prompt on every free-label dial was confusing,
  and a knob can't take a name anyway): a free-label dial is titled by its name only while it's
  on a menu slot, else `VALUE` (or a promoted param's outer name), and shows a "needs a name" chip
  opening the Matrix at it when it's on a slot without one (Export would fail).
- **Replace with…** renames a node that still has its type's default name (`saw`, `saw_2`, an
  older default like `bipolar_to_unipolar`, or a former id's name like `ringmod`) to the new
  type's (`hasDefaultNodeName`/`defaultNodeName`, `patchDocHelpers.ts`; user's call,
  2026-10-04: a saw turned square kept saying "saw"), in the same undo step; a typed name stays.
- **Duplicate** (node context menu, ⌘D; 2026-10-02): `duplicateNodes` copies the node(s) with the
  wires among them through the paste path (not the system clipboard), placed right of the
  originals and stepped down until clear. Any paste (so a duplicate too) drops menu slots and
  followers (two params can't share a slot; cut-and-paste loses them as well); knob bindings stay.
  Right-clicking one of several selected nodes duplicates all.
- **Inlet markers** (`ObjectNode.tsx`'s `InletModulationMarker`, 2026-09-28): an inlet that drives
  a dial shows `±` (adds to it) or `⇥` (replaces it) before its label, with a tooltip naming the
  dial, read from `modulatedBy` via `findInletModulation` -- the unwired-time counterpart of
  ParamDial's "Modulated"/"Overridden" badge (glyphs were the user's pick over icons and word
  tags). Rows without one get an empty slot so labels stay aligned.
  A replacing inlet's `modulatedBy.expects` (`InletExpectation`, 2026-10-02: `vca` `gain`, the
  mux `sel`/`index`) names what the wire should carry in the ⇥ tooltip and the Overridden
  dial's; a wire whose resolved signal shape is in its `warnFrom` (a bipolar source into `gain`,
  a unipolar/gate one into `mux4`'s `index`) gets a red `!` on the wire's midpoint
  (`TypedEdge.tsx`) and in place of the inlet's ⇥, both with the warning as tooltip
  (`NetEdgeData.warning`/`inletWarnings`, `toFlowGraph.ts`). Audio into `gain` (a ring modulator)
  isn't flagged. `pitch` counts as COARSE's
  input (`COARSE_PARAM.modulatedBy`, ±24 st on top of it, unclamped).
  An additive inlet wired straight from a knob reading (`sense/control` with a device control, or
  a superseded knob reader) gets the same red `!` when its clamp swallows part of the knob's
  travel (`canvas/wireWarnings.ts`' `knobDeadZoneWarning`, 2026-10-03, the Radio patch's bipolar
  Depth into a crossfader at FADE 50), naming the dead stretch and the dial range (or outlet)
  that fixes it. Knob sources only: clipping an LFO's swing can be the sound (user's call). It
  reads `ParamModulation.depth` -- half the param's range unless set (`additiveDepthOf`; set on
  the whole-range inlets and delay/freq-shift FEEDBACK's 50), `unclamped` on logic `b` --
  pinned against codegen by `logue-additiveDepth.spec.ts`. Wire colours and warnings are
  projected per canvas mount, so `setLogueParam` remounts when an edit changes one
  (`wiresChanged`), never mid-drag (`endGesture` catches up).
- **Envelope graph** (`EnvelopeGraph.tsx`, `logue/env/multistage` only): a breakpoint editor at
  the top of the node; its L1-L6/T1-T6 aren't drawn as dials. Drag a point up/down for its
  level, left/right for its time (Shift: fine); a drag is one gesture, so one undo step. The x
  axis follows the T dial values (times are cubic), scaled to fit the shape and frozen while
  dragging. It draws the hold point (sustain) or the loop range (loop/cycle). Stages at the same
  position stack, with the last one on top. The exposure badges for L/T only show in the Param
  Matrix, since those params have no dial.
- Checkboxes: every one (canvas booleans, Inspector, Upload/Backup dialogs) uses
  `.param-widget__checkbox-input`, drawn like a dial (18px, dark fill, accent tick); its selector
  carries `input[type='checkbox']` to beat base.css's reset and `.inspector__field input`.
- Unresolved-reference detection (`unresolvedReferences.ts`, `findUnresolvedReferences(doc,
  node)`): per node, checks its `type` and every param/net-endpoint name against the resolved
  primitive's CURRENT spec — surfaces a stale/renamed reference (informational "Renamed" badge)
  or a genuinely broken one (warning "N issues" badge + Inspector detail boxes), rather than
  silently falling back or dropping the wire. Deliberately excludes `logue/io/audio-out` (no
  registry entry by design — a real gap unit tests missed, caught only via the real app).
- **Arrange by signal flow** (`flowLayout.ts`, the toolbar's second arrange button; the first,
  "Spread out overlapping nodes", is `autoArrange.ts`): a layered layout like a hand-tidied patch.
  Feedback is found by a DFS that starts at `audio-in`/inlet ports; columns are as-late-as-possible
  with outputs last; heights are a tree layout of a walk back from the outputs, each node's inputs
  stacked as rigid bands in inlet order and each node top-aligned with its nearest input. A
  definition's port nodes (wired or not) keep their order -- it's every instance's port order.
  Comments keep their offset from their nearest node, nudged into free space after the nodes are
  spread; unwired nodes go underneath. The result is spread by `autoArrangeNodes` on
  max(measured, estimated) sizes, so the load-time pass doesn't move it again
  (`test/flowLayout.spec.ts`, every example). Background in `docs/HISTORY.md`.
- `autoArrange.ts` still auto-arranges a freshly-opened doc's overlapping positions (legacy from
  Axoloti-scale coordinates); its position-rank-preservation guard is kept even though no codegen
  path reads node order.
- Dead-but-intentionally-repurposed CSS/components (grep before assuming "dead = deletable"):
  `.param-widget`/`.param-widget--knob` (now `ParamDial.tsx`), `.library-panel__section-title`
  (now the palette's category headers), `.view-mode-pill__option` (now the platform toggle), `.build-panel__hint-link` (now link-styled buttons in the Build panel).

## Subpatches

A subpatch is a reusable piece of graph stored as its own `.loguesub` file in a user-chosen
library folder (`AppSettings.subpatchLibraryPath`, subfolders allowed). Decisions made up front
with the user (2026-09-26), worth keeping unless there's a new concrete reason:
- **Live reference, never an embedded copy.** An instance's `type` is `sub/<path relative to the
  library folder, no extension>`; editing and saving the file updates every instance in every
  patch. Moving the whole folder keeps references valid; renaming/moving a file inside it breaks
  them (surfaced as a `missing-subpatch` unresolved reference, never silently dropped).
- **Ports** are `logue/io/inlet`/`logue/io/outlet` nodes inside the definition; the node's name is
  the port name, ordered top-to-bottom then left-to-right on the definition's canvas
  (`subpatchPortNodes`). A definition has no `logue/io/audio-out` (the flattener rejects one).
- **Params** are promoted per inner param via `ParamValue.subpatchExpose.outerName` (Inspector's
  per-param toggle inside a definition tab, default name `node:PARAM`, editable; a clash gets a
  numeric suffix). Each instance carries its own value, device slots and device menu label under
  that outer name, edited like any param (dial, Inspector, Param Matrix). A definition never owns
  a menu slot: the Param Matrix shows only the knob rows inside one, and a placed
  `logue/sense/control` is promoted. A knob binding inside a definition is kept (see "Knob bindings").
- **Nesting** is unlimited, with re-promotion chaining through every level; a definition that
  contains itself is rejected (and never offered in its own palette).
- **Double-click** an instance (or its context menu / Inspector "Edit subpatch") opens the
  definition file in its own tab — not Axoloti's same-tab breadcrumb, which only suits embedded
  subpatches.
- **Export/Build read the saved files** (main process, `loadCurrentSubpatchDefinitions`, at click
  time) — an open definition tab's unsaved edits never reach a unit; BuildPanel warns when a used
  definition is dirty. The canvas cache (`subpatchLibraryStore.ts`) is also saved-state only,
  refreshed via a debounced `fs.watch` on the folder (`subpatchLibrary.changed`).
- **A patch's own folder comes first** (2026-09-30, user's call, `docs/PLAN-grain-mill.md`): a
  `.loguesub` at the TOP LEVEL of the open patch's folder is `sub/<name>` and overrides a library
  file of the same type (`listSubpatchesFor`, `main/config/subpatchLibrary.ts`; entries carry
  `source: 'local' | 'library'`). Only the top level, deliberately: a patch can sit in Desktop or
  Documents, where a recursive scan has no bound. One rule for the whole tree (a library
  definition's own `sub/x` also looks next to the root patch first). Export/Build get the patch's
  path (`patchFilePath` on the four IPC calls); the canvas cache follows the ACTIVE tab
  (`refreshSubpatchLibrary` re-lists on a tab switch or Save As, dropping out-of-order replies),
  and main watches that one folder's top level for `.loguesub` changes. An unsaved patch sees the
  library only. The palette shows local ones as "subpatch/this folder", ahead of the library
  groups; the Inspector names the local file an instance resolved to. So an example ships with its
  subpatches beside it. Checked in the built app (resolution, palette, hint, live edit).

Mechanics (`logue-codegen/src/subpatches.ts`, dependency-free, definitions always passed in):
- `flattenSubpatches(doc, defs)` runs before `resolveAudioGraph` at all four callers (both
  generators, `estimateOscStateCost`, `computeCrossPlatformExposureWarnings`); nothing downstream
  knows subpatches exist, and a subpatch-free doc is returned as the same object (byte-identical
  output). Two passes: first every instance gets its own copy of its definition's nodes (names
  `<instance>_<inner>`, sanitized, deduped — root names always win; inner slots dropped;
  promoted params overwritten with the instance's value/slots/label); then wires resolve
  lazily PER PORT through any chain of port nodes. Per-port, not per-instance, on purpose: an
  instance's free-running outlet feeding one of its own unrelated inlets is legal — a real
  review finding against the first per-instance version. Only a loop made purely of port nodes
  is rejected here; a loop through real nodes stays `resolveAudioGraph`'s to report.
- Loud export errors (`SubpatchResolutionError extends UnsupportedLogueNodeError`, so every
  existing "incomplete graph" handler catches it): missing definition, self-containing
  definition, fan-in into a port, unknown outlet, duplicate outer name, and an instance value for
  a promoted param the definition no longer exposes (a rename in the definition would otherwise
  silently reset every instance's value and drop its device slot) -- the way out is the
  Inspector's "Remove" on that stale-param issue row (`removeParamValue`).
- A promoted param's DEFAULTED device label (its outer name) is cut to the platform's name limit
  (`flattenSubpatches`' `maxLabelLength`, NTS-1 mkII's 21); a label typed on the instance is never
  cut and still fails Export when too long. Errors raised after flattening (e.g. a param exposed
  on an unwired instance) name the flattened node (`f1_lp`), not the instance path -- known,
  not yet mapped back.
- `synthesizeSubpatchPrimitive` builds a canvas-only stand-in `LoguePrimitive` (codegen hooks
  throw): ports, promoted params as `freeLabel` specs (min/max/step from the leaf spec, default =
  the definition's authored value), platforms = intersection of the contents', and per-outlet
  polarity via `LoguePrimitive.inheritFrom` (which inlets an outlet really passes through), so a
  subpatch mixing a modulator with audio doesn't just colour grey.
- Stale ports: a wire to a port a definition dropped keeps a dashed "stale" handle
  (`PortInfo.stale`) so it stays visible and disconnectable while Export fails on it.
- Units/checkbox widgets: a promoted spec carries `promotedFrom` (the leaf primitive param,
  through any nesting); `findDisplayUnit`/`presentationKeyOf` look presentation up by that. A
  promoted param whose leaf unit is TRACK-gated (comb/svf COARSE/FINE, comb TUNE, svf CUTOFF) deliberately shows
  no unit -- the gate is on the inner node, invisible to the instance, so a unit could be wrong.
- Finder: `electron-builder.yml`'s `fileAssociations` registers `.loguepatch` and `.loguesub`
  (packaged app only; `npm run dev` isn't registered), feeding the existing `open-file` handler.
- A subpatch-built unit (two instances, a promoted param on a knob and one as a menu param) works on
  both devices (user, 2026-09-30).

## Buses

Named send/receive without wires (user's call, 2026-10-04, after the `thru` cascade inlets were
still too much wiring; plan and decisions in `docs/PLAN-buses.md`). `logue-codegen/src/buses.ts`.
- **Placed types aren't registry primitives** (the subpatch port-node precedent):
  `logue/mix/send` (`in`, GAIN 0..100 = x0..x1 in dB, default unity), `receive` (`out`),
  `send-stereo` (`l`/`r`, GAIN), `receive-stereo` (`l`/`r`). `createSubpatchAwareResolver` gives
  the canvas a stand-in (codegen hooks throw); its GAIN's `promotedFrom` points at the internal
  send, so presentation (dB) resolves there. The registry loops (snapshots, measurement scripts,
  sweeps) therefore never meet a node that can't generate code alone.
- **`resolveBuses`** runs after `flattenSubpatches` through ONE entry point, `flattenUnit`
  (`resolveUnit.ts`), used by `resolvePlatformGraph` (every generator and estimator) and
  `exposedLogueParams.ts`: it retypes each bus node to its `internal: true` registry primitive
  (`logue/mix/bus-send`: `thru + in*gain`; `bus-receive`: a copy; stereo pair alike) and chains
  each bus -- sends sorted by node name, every receive fed from the last send, none = `0.f`.
  Nothing downstream knows buses exist: a bus nobody receives is unreachable (no code), fan-out is
  free, CPU is the same as hand-wired `thru` mixers (a send ~5-7 xd fx emulator cycles, a receive 0).
- **Mixers send directly** (user's ask, same day): `LoguePrimitive.busOutlets` (`['out']` on
  `mix2`/`crossfader`, `['l','r']` on `stereo-mix2`/`pan-mix2`/`pan`/`stereo-crossfader`) lets a
  mixer carry `bus` itself -- the Inspector's "Send to bus" (empty = none), a `→ verb` header
  badge. `resolveBuses` first expands it into a unity send `<mixer>__bus` fed from those outlets
  (`withDirectSendsExpanded`), so the result is a hand-placed send's code and the outlets stay
  wireable; everything else (`busesIn`, warnings, colours, layout, presets) counts it as a send
  via `busRoleOf`/`busKindOf`. Anything that SENDS mono -- a mono mixer or a mono `send` node --
  fits either kind of bus (`busKindOf` 'either', user's calls 2026-10-04/05): on a bus with any
  stereo node it feeds both sides at unity (+3 dB against a centred `pan`; a send node is retyped
  to a stereo send with its input wired to `l` and `r`, `withMonoSendsWidened`); a bus of mono
  senders alone stays mono. Only a mono RECEIVE on a stereo bus is an error (`mixed`; the badge
  sits on that receive). Replace with... keeps a sender's bus on a mixer, not a
  receive's (a reader would turn into a writer). A `bus` on any other type is ignored.
- **Global scope**: one namespace per unit, so a send inside a subpatch reaches the root's bus
  (two instances of a definition holding a send+receive pair share it). A mono receive on a
  stereo bus is a `BusResolutionError`. A loop through a bus is an ordinary cycle; the error gains
  `BUS_LOOP_HINT` (a `sample-delay` in the loop fixes it, as for a wire).
- **Canvas**: a bus node is titled by its bus (`→ verb` / `verb →`) and double-clicking the title
  edits the BUS (`setNodeBus`, one undo step; the node's own name is in the Inspector, beside a
  Bus field offering the document's buses of the same kind and their send/receive counts). A new
  one takes the last bus of its kind (`defaultBusName`), else the first free `busN`; the insert
  search offers `send → x` / `receive x` per existing bus (`busPresetEntries`, keyed by a value
  string so a dial drag doesn't re-render the palette). Replace with... among bus types keeps the
  bus, to anything else drops it; paste/duplicate keep it. A mono receive is compact. A receive's
  wire colour merges its sends' inputs (this document only). Badges (`busProblems`, through
  `busProblemsFor` on the flattened document so a send inside a subpatch counts): a receive with
  no send, a send nobody receives (root patches only), a mono receive on a stereo bus (everywhere).
  Arrange by signal flow adds a virtual edge per send -> receive pair.
- Verified (2026-10-04): unit tests, the built app (placing, bus editing, badges, colours,
  arrange, a send's GAIN as a Param Matrix menu param), and real builds of a three-send
  oscillator on both platforms (`scripts/stageBuses.ts`: `lp-xd-buses`/`lp-nts1-buses`, one send
  GAIN on Shape, one a menu param; only leaf calls below the xd's `process`). No harness render,
  no hardware pass, no effect-unit build yet; no example uses a bus.
- A node without outlets (a send, a subpatch's outlet port) answers to no outlet name
  (`resolveDeclaredOutletName`), so Replace with... into a send leaves the old output wire stale.

## Build & Export pipeline

- **New effect patches** (2026-09-30): File › New Effect › Mod/Delay/Reverb, the tab bar's "+"
  menu and the empty-state buttons create a document with that module, seeded as a stereo
  pass-through (audio-in L/R -> audio-out L/R; audio-in is as fixed as audio-out:
  `isFixedIoNodeType`; paste leaves both out, with their wires). The Build panel's Effect Type
  pill switches among effects only (not osc <-> fx: the io nodes differ) through
  `setEffectModule`, one undo step: each buildable platform's params are re-laid for the new
  type (menu params move past its reserved rows) and a knob binding it lacks (MIX on Mod) is
  removed and named in the panel. It shows the SDRAM line and, for the xd, the effect CPU gauge
  (see "Effect CPU table"; "—" on NTS-1 mkII). Effect tabs get the wave icon
  (`TabInfo.module`).
- **Menus** (`main/index.ts`, macOS order since 2026-10-02): app (About, Settings… ⌘,), File
  (New Oscillator ⌘N, New Effect ▸, New Subpatch ⇧⌘N, Open, Save, Close Tab ⌘W -- closes the
  active tab; on the last tab or the start screen it closes the window, so the app quits), Edit (Undo/Redo drive the
  patch, see `menu.undo`), View (Zoom to Fit ⌥⌘0, Arrange by Signal Flow ⌥⌘A, Spread Out,
  Electron's page zoom ⌘+/⌘−/⌘0 -- the user needs it for reading, never remove it;
  Reload/DevTools only in development -- Reload drops unsaved patches unasked), Build (Export
  Unit Source ⇧⌘E, Build Unit ⌘B), Device (Device Param Matrix…, Back Up/Restore Device…),
  Window, Help (⌘?). There's no header row: status, Settings and Help sit at the tab bar's
  right end, and a success status fades after 4 s. Build and Device items are stateless: each fires a
  `menu.*` event that `BuildPanel.tsx` handles against its own current build-target selector
  (expanding the panel so the result is visible). Export and Back up/Restore have no panel
  controls any more -- menu only (the Matrix also has a button in the Inspector header).
- **Export** (`main/ipc/logueExport.ts`): writes generated source ONLY (`header.c`/`osc.h`/
  `unit.cc` for NTS-1 mkII, or `manifest.json`+`osc.cpp`/`fx.cpp`+embedded build scaffold for
  minilogue xd, laid out by `minilogue-xd/projectFiles.ts` for Export and Build alike) — never a
  compiled unit.
- **Effect units (both platforms, 2026-09-30; plan: `docs/PLAN-effects.md`)**: what both
  generators share (fixed members, the osc-API stand-ins, SDRAM glue) is `fxShared.ts`.
  NTS-1 mkII:
  `nts1mkii/generateFxUnit.ts` (`header.c`/`fx.h`/`unit.cc`, class `Fx`), picked by the
  document's module in `nts1mkii/projectFiles.ts` for both Export and Build (staged from
  `dummy-<module>`, `PROJECT := fx`). Stereo interleaved in/out, every input read before the
  frame's outputs are written. Reserved rows TIME/DPTH (and Korg's MIX row on delfx/revfx:
  `-1000..1000`, `drywet`, frac 1/1) come from `unitKinds.ts`. No note: `note_ = 60`, and the
  two osc-API symbols primitives use get stand-ins (`osc_sinf` -> `fx_sinf`, an
  `osc_w0f_for_note` on `fastpow2f`); `scripts/stageFxUnits.ts --sweep` builds every primitive
  into a real unit and checks `readelf` for non-fx_api imports (all 64 clean). Example effect
  patches (`examples/effects/`, written by `scripts/writeEffectExamples.ts`): a Freeverb-style
  stereo reverb from primitives, an auto-wah, a tempo swell, a stereo frequency shifter, a stereo reverse delay
  (`reverse-wash`, plus the lighter `reverse-wash-xd`); `stageFxUnits.ts` stages them with
  a CPU-probe menu param (the M7 cycle counter) for measuring on the device. SDRAM (phase 4):
  a primitive's `sdramFloats(node)` share is laid out by `oscBody.ts`' `sdramLayout` (shared with
  the RAM estimate's `sdram` line), allocated once in `unit_init` (`getBufferSize()`), pointed to
  by a generated `float *sdram_<suffix>` and zeroed in `init()` -- the device hands it over dirty;
  over the kind's `sdramBytes` is an export error. The RAM estimate adds the kind's measured
  `fixedCodeBytes` (4220 B on NTS-1 mkII effects, re-checked by the sweep) and the primitives'
  measured code (see "RAM estimate"). `Fx::reset()` (`unit_reset`) zeroes the SDRAM and re-runs the state inits,
  keeping params. Korg's templates never call `sdram_free`, so neither does teardown. Host harness:
  `scripts/runNts1FxHarness.ts` (`harness/nts1mkii-fx/`). The CPU gauge is the xd effect table
  scaled (see "NTS-1 mkII effect gauge"); a generated effect carries ~4.2 KB of fixed code, a big share of modfx's 16 KB. Four generated units (pass, lowpass +
  MIX, ring, Haas) behave as designed on a real NTS-1 mkII (user, 2026-09-30), and so do the three
  examples; the example reverb (8 long-delay combs, 4 allpasses) measured 3406 of 11458
  cycles/sample (29%) with the CPU probe -- the only effect CPU measurement so far.
- **minilogue xd effect units** (phase 7, 2026-09-30): `minilogue-xd/generateFxUnit.ts`
  (`generateOldGenFxUnit`: `fx.cpp`, class `Fx`, plus the whole scaffold per module, embedded:
  Korg's `_unit.c` with the UMOD/UDEL/UREV hook table, a Makefile for the effects MCU
  `STM32F446xE` linking `main_api.syms`, `user<module>.ld`, and `rules.ld` with a NOLOAD
  `.sdram` section). No menu params (`num_param` 0, no `params` key -- the spike's shape, which
  loaded): only Time/Depth, plus Shift+Depth (param id 3; id 2 is `reserved0`) as `mix` on
  delay/reverb. **Knob values arrive as Q31** (0..2^31-1, 10 bits of it real): reading them as
  0..1023 made every knob jump from off to full (user, a real xd, 2026-09-30). modfx processes
  separate buffers (and copies the unused sub-timbre ones), delfx/revfx in place. SDRAM is one
  static `__sdram` array (128 KB modfx / 2432 KB delfx/revfx), cleared in init and on resume.
  Tempo is pulled per block (`fx_get_bpmf`, no push callback). SRAM holds code, tables and state
  together (6 KB modfx / 12 KB delfx/revfx; a pass-through is 440 B, 464 on modfx, as
  `fixedCodeBytes`), so code is the real limit: `osc/additive` doesn't fit any xd effect, the
  auto-wah example is 5540 B of a modfx's 6 KB; an SRAM overflow at link time becomes "too big
  for the device's memory" in Build. `scripts/stageXdFxUnits.ts --sweep` links every
  effect-usable primitive (a static link, so a missing symbol fails it) and checks for only leaf
  calls below `process`; `scripts/runXdFxHarness.ts` (`harness/minilogue-xd-fx/`) checks the
  shell under ASan/UBSan. On a real xd (user, 2026-09-30): every phase 7 test unit OK -- pass, LP mix, ring, echo (stereo once only its left line followed Time), synced echo, the 2.25 MB unit, the reverb/auto-wah/swell examples, in-app upload, knob starting values, no hangs.
- **Build** (`main/ipc/logueBuild.ts`, `BuildPanel.tsx`): a real, additional action that stages
  the same generated project as a temp subdirectory of the user's own local `logue-sdk` checkout
  (`AppSettings.logueSdkPath`, never bundled/vendored) and produces an installable
  `.mnlgxdunit`/`.nts1mkiiunit`.
  - Runs `make`/`make install` directly against a local `arm-none-eabi-gcc` (`resolveArmToolchainBinDir`: explicit
    `AppSettings.armToolchainPath` override first, else probes Homebrew's `gcc-arm-embedded`
    cask / the Arm GNU Toolchain installer's layout — deliberately NOT a PATH lookup, since a
    GUI-launched Electron app doesn't inherit shell PATH). Real, disclosed tradeoff: uses
    whatever compiler is installed, a real version-drift risk especially on NTS-1 mkII's
    dynamically-linked ELF units (could compile clean and only fail at device load time).
    `LogueBuildResult.builtWith` always names the actual compiler used, so provenance is never
    ambiguous. Local-built units work on real hardware (user-confirmed).
  - There is no Docker build any more (removed 2026-09-25); "Docker build" in older notes and
    `logue-codegen/scripts/*` means the SDK's `docker/run_cmd.sh build` (GCC 9.2.1).
  - NTS-1 mkII's staging has one mechanical difference: since its generator never produces a
    build scaffold, staging copies the real `dummy-osc` template's own `Makefile`/`wasm.cc`
    verbatim rather than generating one.
  - A built unit uploads from the Build Results list (see "Direct device upload" above);
    Kontrol Editor / `logue-cli` also work (confirmed on hardware for both platforms).
- **Build output folder**: no per-click save dialog; Export and Build write straight into
  `AppSettings.buildOutputFolder`
  (configured once in `SettingsModal.tsx`, displayed read-only in `BuildPanel.tsx` with a
  "Change…" link — the display is fetched once per `BuildPanel` mount, so it can go stale if you
  change the setting without switching tabs; the actual write always reads the live value) —
  Export into a `<UnitName>-<platform>` subfolder, Build into a `<UnitName>.<ext>` file
  (`main/config/buildResultNaming.ts`). A pre-existing file/folder at the exact destination is
  renamed aside first (`main/config/buildOutputFolder.ts`'s `makeRoomForDestination`) with a
  `.history-YYYYMMDD-HHMMSS` segment inserted before a file's real extension (or appended, for an
  extension-less export folder) — never silently overwritten. Throws
  `BuildOutputFolderNotConfiguredError` with a clear message if unset. `BuildPanel.tsx` keeps a
  growing, SESSION-ONLY (not persisted), GLOBAL (survives switching tabs — `buildResultsStore.ts`,
  a plain Zustand store, since `BuildPanel` itself remounts per tab via its own `key`) list of
  every successful export/build; clicking an entry calls `system.showItemInFolder`
  (`shell.showItemInFolder`) to reveal it in Finder. Only successes are recorded.
- **Verification methodology** (no golden-file reference exists for *logue codegen, unlike the
  old Axoloti path's real Java tool to diff against): NTS-1 mkII via `websim`'s real
  `AudioWorkletNode`+`AnalyserNode` when it works (see the websim gotcha above) or a host-native
  harness; minilogue xd via a host-native ASan/UBSan harness (`logue-codegen/harness/
  minilogue-xd/`) since no `websim` equivalent exists there; real hardware for anything a bug
  report can't be resolved by re-reading. **A clean Docker compile only proves the C++
  compiles** — it doesn't prove the manifest passes Korg's own tools (a real Librarian rejection
  is on record: minilogue xd caps a custom param's manifest range near ±100) or that the DSP
  sounds right on-device. Two SDK generations, genuinely different: minilogue xd is
  Q31-output/static-ARM/32KB SRAM/≤6 params (needs a local ARM toolchain, no native
  Apple Silicon build); NTS-1 mkII is float/dynamically-linked ELF/48KB RAM-load/10 params.
- **Real *logue SDK facts** (verified against actual Korg headers/hardware, not assumed):
  minilogue xd's `user_osc_param_t` carries `pitch`/`cutoff`/`resonance`, the latter two documented
  as the filter's values (0x0000-0x1fff) but on a real xd a constant near full scale that doesn't
  follow the FILTER knobs (user, 2026-09-30), so nothing may be bound to them — SHAPE/SHIFT-SHAPE are NOT
  in that struct at all, they arrive via the ordinary `OSC_PARAM` callback at fixed enum ordinals
  just past the 6 named param slots. NTS-1 mkII's `unit_runtime_osc_context_t.cutoff`/
  `resonance`/`amp_eg_*` are genuinely dead (Korg's own header comment: "Unused. Future.") — not
  unresearched, just unimplemented in firmware. NTS-1 mkII's Shape/Alt-Shape are NOT a "sense"
  read the way minilogue xd's are — they're the unit's own fixed param slots 0/1, delivered
  through the ordinary `setParameter` path. `websim`'s own `wasm.cc` harness is structurally
  incapable of testing anything involving `unit_runtime_osc_context_t` or the physical Shape
  knobs at all — it only ever iterates declared params, never simulates that struct — so some
  questions (e.g. whether a knob turn calls `setParameter` regardless of `num_params`) are
  answerable only on real hardware.
- **The NTS-1 mkII's voice section saturates a full-scale oscillator** (measured 2026-10-06,
  `hwtest`, a sine osc unit, filter through or LP4 open): 3rd harmonic -29 dB at 0 dBFS peak,
  -41 at -6, -53 at -12, -67 at -20 (12 dB less per 6 dB: a cubic-like soft clip), the top step
  0.7 dB compressed. Effects (the REVERB slot at least) don't: -69 dB at -6 dBFS. So an
  oscillator patch at full scale gets ~3.6 % THD from the device, not from its own code.
- **minilogue xd param types/signs** (2026-09-27, a real xd report): typeless (`""`) manifest
  ranges must be non-negative (the device shows them +1, so a typeless `-100..100` read "-99"
  and stuck at "101"); a bipolar param is `[-100, 100, "%"]` (Korg's own `dummy-osc`). It
  arrives OFFSET, not signed -- Korg's own xd `userosc.h`: "0-200 for bipolar percent parameters.
  0% at 100, -100% at 0" -- so the generated `OSC_PARAM` subtracts 100 for every negative-min
  param, clamps both ends, and `setParameter` takes `int32_t` (confirmed on a real xd for
  +-100; reading it as signed made a constant at 0 arrive as +100%). The header only states the +-100 case; COARSE (+-24)/FINE (+-50) get the same offset, confirmed on a real xd (user, 2026-09-30).
  A param's DEVICE range can differ from its spec on both platforms (`DeviceParam`,
  `resolveMinilogueXdDeviceParam`/`resolveNts1mkiiDeviceParam`, 2026-09-27): hard selects
  (`mux2`/`demux2` SELECT, `mux4` INDEX) are `0..N-1` -- typeless on the xd, so its +1 display
  offset shows 1..N; `k_unit_param_type_strings` on NTS-1 mkII, labelled "In 1".."In N" ("Out
  1/2" for demux2) by a generated `unit_get_param_str_value`. A mux's choices (`SelectParam.choiceInlets`) show
  instead the name of the node wired into each input (`_` as a space, cut to 7 characters), so a
  patch labels its selector by naming its sources (`withWiredChoiceNames`, `oscParams.ts`; user's
  pick over per-param choice names, 2026-10-01; grain-mill's show in full on a real NTS-1 mkII). Boolean widgets (`TRACK`/`SYNC`/
  `TZFM`) are `0..1`: `"%"` (0%/1%) on the xd, `onoff` on NTS-1 mkII. The generated
  `setParameter` case multiplies by `scale` back into the spec domain (SELECT 0/1 -> 0/100), and
  NTS-1 mkII's header `init` goes through `toDeviceValue` (two-step params by the DSP's own
  threshold), so documents and the canvas are untouched. Both compile and link clean
  (`scripts/stageDeviceParams.ts`); the selects, checkbox, semitone and cent params display right on both real devices (user, 2026-09-30).
- **minilogue xd "hang" signature** (user-described, 2026-09-26): the multi-engine oscillator
  keeps sounding (a frozen, looping buffer) and never stops; nothing on the multi engine responds,
  including loading another program; the whole envelope/ADSR stage stops responding; the rest of
  the panel is erratic or unresponsive. Seen three times: `logue/filter/formant` (2026-09-19),
  `logue/osc/granular` twice (2026-09-26). The second granular case was **CPU overload, confirmed**:
  it hit only at the costliest settings and went away once the per-voice cycle count dropped (see
  docs/HISTORY.md's granular entry), with four voices held. The first granular case (and the formant
  one) went away with force-inlining instead -- also consistent with overload, since inlining cuts
  call overhead, though the formant bisect ruled out polyphony (one held voice crashed).
  **Triage when it recurs**: first ask whether it depends on settings (the costliest ones) and on
  voice count, and count cycles per voice-sample in the staged build against ~1728 per sample
  PER VOICE (measured 2026-10-06: each voice has its own budget; real cycles ~= 17 + 1.54x the
  emulator's), of which a voice gets ~1225-1300 before the xd breaks up or hangs; only then suspect call shape/`-Os` (the formant playbook). A fuzz
  under ASan/UBSan rules out bad reads/math cheaply first.
- **Verifying a new primitive's actual DSP correctness** — lessons from real false starts:
  zero-crossing counting is the wrong measurement for a harmonically-rich or continuously
  re-excited signal (e.g. a noise-fed resonant filter) — use autocorrelation/peak-lag instead. A
  continuous periodic input (a plain saw) is the wrong test signal for measuring a comb/resonant
  filter's tracked band, since its own fundamental swamps a naive autocorrelation — use noise.
  Measure an envelope's shape by rendering it directly, not through a VCA whose carrier's own
  polarity flips can hide the ramp.

## Hardware test harness (NTS-1 mkII, 2026-10-05)

`logue-codegen/scripts/hwtest/`: scripted measurements on the user's real NTS-1 mkII, no hands on
the device. MIDI through the native helper (`midiHelperClient.ts`, moved out of
`uploadTestUnit.ts`), audio recorded with Homebrew `sox` from the user's X18/XR18 **inputs
17/18** (the clean pair; 1/2 go through a limiter; ~-30 dBFS, ~60 dB SNR; `HWTEST_AUDIO_DEVICE`/
`HWTEST_AUDIO_CHANNELS` override). Run only with the user's go-ahead: it overwrites slot 1 of
each module it uses (the user's choice) and the edit buffer. Every run first snapshots both into
its own `~/Documents/logue-patches/backups/hwtest/run-<time>/` (`deviceState.ts`), builds its
test programs from that snapshot, restores it at the end and reads it back to verify; a slot or
program still holding a test unit (developer id `LPHT`, a run that died) is taken from the newest
earlier snapshot instead. `compareWithSnapshot.ts` checks the device against one, read-only.
- `nts1Rig.ts`: notes/CCs, the current-program dump (`10` -> `40`, 504 bytes unpacked, words
  little-endian; written back with `40`, ACK `23`), slot upload/download. Units are SELECTED by
  writing their developer id, unit id and version (a little-endian u32, `major<<16|minor<<8|patch`)
  into the program's selection (`deviceState.ts`' `select`); test units get developer id `LPHT`
  and a unit id per test (`buildUnit.ts`; `generateNts1MkiiProject`'s optional `ids`) since every
  app build has 0/0. Menu params are set the same way: an effect's program PARAM n is its param
  row n+2 on delay/reverb (after TIME/DEPTH/MIX), knobs A/B/MIX are 0..1023 words. NRPN is off on
  the user's device (short messages on) and isn't needed; the user offered to turn it on.
  The device's output is set to mono globally.
- `telemetry.ts`: an effect's render cycles reach the recording as audio. The unit still runs its
  graph, then replaces its output with a 440 Hz detector sine, a tone at 2000 Hz + cycles/4
  (its own render, from the M7's DWT counter) and one for the whole budget; `BURN` (optional menu
  param) spins until an exact load is reached. Decoded by `analysis.ts` (`peakFrequency`,
  `trackPeak` for a cost that moves, `scanGlitches` for dropouts: a per-block least-squares fit of
  the known tones, residual against the clean floor), tested on synthetic signals
  (`test/hwtest-analysis.spec.ts`).
- `cpuCeiling.ts` (`--others`): the effect anchors above. `calibrateFx.ts`: the 14-unit
  calibration. A unit with buffers gets dearer as they fill (grain-mill ~1840 -> ~2520 over 3 s),
  so readings settle 4 s and track 3 s; switching the module off before re-uploading into the
  selected slot avoided units that sometimes never played.
- `functional.ts` (2026-10-06): 25 cases, each a REVERB-slot effect with its own source (noise
  at -12 dB or a sine at the effect's middle C) into one primitive, every setting baked in,
  recorded on the device and rendered on the host from the same generated code
  (`hostRender.ts`, the effect harness's stand-ins). Compared per third octave (16384-point
  Welch; 50 Hz has few bins and reads noisiest) after removing the device chain's response
  (`chain-white`), plus tone levels and pitch. Result: every case within 0.3 dB rms of the host
  (worst band +1.0 dB, tilt+100 at 50 Hz), pitch +0.23..0.27 ct (the interface clock): noise
  colours, lfsr long/short, ladder (4 settings + self-oscillation), eq-band (bells, shelves,
  notch), tilt +-100, svf notch/ap, drive (odd harmonics to 0.1 dB), freq-shift. Each case
  passes or fails against `TOLERANCE` (band rms 0.5 dB, worst band 1.5 dB from 60 Hz, pitch 1 ct
  beyond the clock offset, tones above -60 dB within 1 dB); exit code 1 on a failure. Limits: it
  exercises the EFFECT path only (fx_sinf, the fastpow2f note stand-in, note 60), not an
  oscillator's tables, note tracking or voices; and third octaves can't resolve a narrow feature
  (a Q 8 bell's peak, a notch's depth), only the shape around it. A `chain-silence` case measures
  each device's own floor; bands and tones within 10 dB of it aren't judged.
  **On the xd** (`--xd`, 2026-10-06, against harness/minilogue-xd-fx): all 22 pass too (rms
  <= 0.3 dB; pitch 0.01 ct: its clock matches the interface's). Its chain is flat to -1.7 dB at
  16 kHz/-1 dB at 50 Hz, +0.4 dB of gain, and misbehaves loud: a -6 dBFS sine's H3 at -37 dB,
  and bright noise (tilt+100) grows fluctuating 30-120 Hz energy (+2.0 dB at 63 Hz at full level,
  +9.4 reproducibly at -6 dB, clean at -12 and -24) -- the analog output or the interface, not
  the code. So xd cases end in a VCA at -12 dB (`withOutputTrim`, `HWTEST_XD_TRIM`). The chain itself:
  flat within +-0.6 dB 50 Hz-16 kHz, -8.1 dB, H2 -52/H3 -69 dB for a -6 dBFS sine from the reverb
  slot. Recordings (device and host WAVs) and `functional.json` land in the run's snapshot folder.
- **minilogue xd** (2026-10-06): the same scripts take `--xd` (`LogueRig.connect('minilogue-xd')`,
  channel 3 here, family `51`; its audio arrives on the same X18 inputs, so only one synth may
  play). Units are selected by CC (USER1 of a slot; mod `88`/`96`, delay `89`, reverb `90`, on/off
  `92`-`94`) and knobs set as 10-bit CCs (`63` first); the program dump (1024 bytes on firmware
  2.10, the spec says 336) is only saved and restored. Telemetry wraps the xd effect hook
  (`withXdFxTelemetry`, mod/delay/reverb; BURN on the DEPTH knob, 0..`burnMax`); the effects
  MCU's DWT counter works. App-built xd units have no developer id: test units are told apart by
  their "HT "/"FN " names. **The xd keeps running a slot's previous code after a re-upload until
  a program load** -- three mod units in a row all read the first one's cost, whatever CCs came
  between -- so the scripts write the saved program back after every upload.
- `oscChecks.ts` (`--xd`; 2026-10-06): the OSCILLATOR path, which `functional.ts` can't reach --
  the firmware's note and sine tables, note tracking, the voice. Each case is an osc unit in OSC
  slot 1, every setting baked in, ending in a VCA at -20 dB (the NTS-1 mkII's voice section
  soft-clips a full-scale oscillator), played at one or more notes and compared with a host render
  of the same generated code against the SDK's OWN osc headers (`renderNts1OscOnHost`/
  `renderXdOscOnHost`: osc_api.h's inline `osc_w0f_for_note`/`osc_sinf` over formula-filled
  firmware tables -- equal temperament from 440 Hz clamped at note 138, a 129-point half sine;
  the xd's CMSIS intrinsics are stubs in harness/minilogue-xd-osc/ that abort if reached). Cases:
  pitch tracking over notes 24..120 (cents re equal temperament after the median), sine/saw/
  square/pulse/triangle/sync/phase-dist harmonics re h1 (a tonal case's fundamental is the note
  times the measured clock offset, never searched for: sync at an octave has almost nothing at
  its own fundamental), a tracked svf and comb in third octaves (noise cases record 6 s: 3 s
  scattered the lowest bands +-2 dB). Results: all 10 pass on both devices; pitch within 0.6 ct
  (both devices show the same -0.56/+0.30 at notes 24/36: the analysis, not the devices),
  harmonics mostly within 0.3 dB. The voice is made neutral first: NTS-1 mkII `neutralVoice` in
  the program dump; xd by CC after the program write (`XD_VOICE`). **On the xd LFO INT and EG INT
  are bipolar, centre 64** (LFO INT 0 = -100 % threw the pitch around every 100 ms), and CCs sent
  right after a program write were partly lost (the first case was silent): wait a second, space
  them 20 ms. The xd's osc path is flat to ~3 kHz, -6.3 dB at 16 kHz (analog filter/output),
  ~16 dB under the digital level; the NTS-1 mkII's within +-0.6 dB.
- Oscillator CPU (2026-10-06): `withNts1OscTelemetry` (BURN = the program's osc PARAM 1, row 2:
  an oscillator's PARAM n is row n+1, after Shape/Alt) and `withXdOscTelemetry` (wraps
  `OSC_CYCLE`). `calibrateOsc.ts` (`--xd`) measures the user's oscillator patches with every device
  control stripped (so each param is at its authored value on device and in the estimate):
  NTS-1 mkII real ~= 0.77 x `estimateOscCpuCost` (-29..+28 %, 18 distinct patches; the formant reading was dropped 2026-10-06), xd real ~=
  17 + 1.54 x it (-30..+30 %, 18 incl. formant since its per-block coefficients; per voice), since the table re-measure with moving sources
  (`--refit`). **Each xd voice has its own ~1728 cycles per
  sample**: with 1-4 notes held, cpiano read ~915 per voice and the budget 1729 every time -- the
  voices don't share one budget (so the "~1750 per sample in total" in the hang triage is per
  voice). formant at its authored settings costs ~1700 for ONE voice and hung the xd during the
  calibration (power cycle needed; `calibrateOsc.ts` now skips an xd patch whose converted
  estimate / 0.66 reaches `XD_OSC_HANG_CYCLES`). `cpuCeiling.ts --osc` (NTS-1 mkII): clean to
  10000 with the effects off, dropouts from 10050 (a first run read 7350 / 7400, which two later
  runs on the same program didn't reproduce); with factory chorus + stereo delay + hall reverb
  clean to 6650, dropouts from 6700 (reproduced). `--osc-load n` (effect sweep) holds a burn
  oscillator at n alongside (its tones at `LOAD_TONES`, the effect passing them through, both
  streams scanned for dropouts): the shared pool above. `cpuCeiling.ts --xd --osc [--notes n]` (BURN on the multi
  engine's Shape knob, CC 54 + LSB 63): one voice clean to 1290, FROZE at 1300; 4 notes clean at
  1225, breaking up from 1250 (effects off). It stops at the first failure and doesn't restore
  (each needs a power cycle; the next run's snapshot restores from an earlier one), and counts a
  step whose reading stops rising with the burn as a failure: a hung voice keeps rendering its
  last block while the recording looks whole and SysEx still works -- so a "verified" restore is
  no health check; a burn-0 reading above 400 aborts.
- Gotcha: a slot re-uploaded with the SAME unit id while selected keeps playing the old code;
  every test unit gets its own id and the module is deselected before an upload.
- Gotcha: the device has refused one of many quick uploads with USER INTERNAL ERROR (2F);
  `Nts1Rig.upload` pauses and retries.
- Gotcha: `sox` writes raw output with the INPUT's channel count unless the output has its own
  `-c` (it read as a 9x time stretch).

## Electron / IPC

- Sandboxed preload (`sandbox: true`) can't `require()` external node_modules — the preload
  bundle must stay fully self-contained.
- IPC namespaces: `system` (ping, getAppVersion, showItemInFolder, setUnsavedDocuments/
  closeWindowAfterSave -- the unsaved-changes guard on window close/⌘Q, `main/quitGuard.ts`: the
  renderer pushes dirty tab titles ahead of time, main shows Save/Cancel/Don't Save and on Save
  sends `app.saveAllAndClose`), `sampleFile` (pickWav, readWav -- `.wav`-only reads for the granular import), `logueDevice` (readUnitFile, writeBackup, openBackup), `logueMidi` (listPorts, connect, send -- raw bytes via the native helper), `clipboard` (writeText,
  readText), `settings` (sidebar widths, uploadAlwaysReplace, and one keyed
  `getPath`/`setPath`/`pickPath` trio over `PATH_SETTING_KEYS`: logueSdkPath, armToolchainPath,
  buildOutputFolder, subpatchLibraryPath -- main's `PATH_PICKERS` holds each dialog's title), `subpatchLibrary` (list),
  `patchFile` (openPath, save, openDialog, saveDialog, listRecent),
  `logueExport` (exportNts1MkiiUnit, exportMinilogueXdUnit), `logueBuild` (buildMinilogueXdUnit/
  buildNts1MkiiUnit; detectLocalArmToolchain), `events` (22
  menu-triggered subscriptions, `menu.newLogueEffect(module)` among them + `app.saveAllAndClose` + `logueMidi.data`/`logueMidi.setupChanged`/
  `subpatchLibrary.changed`).
- `noImplicitAny` is switched back on in both tsconfigs (the electron-toolkit base turns it
  off). Before that, a stale `IPC_CHANNELS['...']` key silently typed as `any` and caused a real
  launch crash once (two deleted keys collapsing to the same `undefined` handler); now it's
  error TS7053. Don't turn it off again.
- The renderer-facing API is still `window.axoloti` (not renamed to match the app's current
  name) — deliberate: renaming touches 8 files + the `'axoloti:'` channel prefix for zero
  user-visible benefit, and is exactly the surface the gotcha above warns about. Do it as its own
  isolated commit with its own launch verification if it's ever worth doing.
- `app.name` falls back to `package.json`'s `name` in dev mode vs. `electron-builder.yml`'s
  `productName` when packaged — these can silently disagree; the app calls `app.setName(...)`
  explicitly to avoid it.

## Working conventions

- Comments explain WHY only, never WHAT.
- Prefer fixture-based tests (`test/fixtures/*.json`) over hand-verification.
- UI changes: verify with `.claude/skills/run-desktop/` (builds + drives the real, built app via
  Playwright `_electron`, real screenshots/DOM queries). Don't claim a UI change works without
  running it. Known artifact: at the window's 1.2 zoom, an unpinned screenshot was laid out at
  the wrong width (right Build panel, header buttons and minimap missing although the DOM was
  correct); `launch`/`ss` now pin the viewport to the real window size (see the skill's
  Gotchas). If a screenshot still disagrees with expectations, read the DOM
  (`innerText`/`eval`) before trusting it. Its `click`
  command uses DOM `Element.click()`, which doesn't reliably focus a text `<input>` — click by
  real x/y coordinates before typing into one.
- New/changed *logue primitives: a clean compile alone proves nothing about manifest
  validity or on-device sound — verify with the real harness/websim/hardware methodology above.
- When grepping for "does X still have a caller" before deleting code, check the WHOLE repo
  (`logue-codegen/`, `test/`, generated-output string literals), not just `src/` — a stale
  reference has hidden inside a generated-C++ header comment and inside a test description
  string before.
- Don't blend a code MOVE and a code DELETE in the same change when refactoring — inline/move a
  helper only once it has a single remaining caller, as its own step.

## Known open items / verification debt

- Both effect gauges' "busy" anchors are measured with particular factory effects (NTS-1 mkII:
  CHORUS + STEREO delay; xd: CHORUS + a reverb), not the heaviest of every type, and with a
  factory oscillator. A knob can move an effect's cost a lot (the xd auto-wah: 532 cycles at
  DEPTH 0, 254 at 64), which the knob-reachable maximum doesn't model for continuous params.
- `util/reverse-tap` and the reverse-wash examples (2026-10-01) are harness-, link- and
  emulator-checked only; no listening pass yet. Staged: `lp-fx-revwash` (+ `-cpu` with the probe
  on WIDTH's row) and `lp-xdfx-revwash`/`lp-xdfx-revwash-xd`. xd emulator (penalty 0/8): the
  full patch 857/969 cycles -- past the ~750 clean anchor, so the xd gets `reverse-wash-xd` (one
  line, one allpass a side): 606/670. SOFTEN's detector constants are from a simulation and the
  harness, not ears.
- `osc/noise`'s COLOR and `osc/lfsr` (2026-10-03) match the host render in an effect unit on both
  devices (`hwtest/functional.ts`), not in an oscillator; no listening pass. Staged: `lp-xd-noise`/`lp-xd-lfsr`/`lp-xd-lfsr-lfo` and the
  `lp-nts1-*` equivalents (`scripts/stageNoiseTypes.ts`; COLOR/MODE/TRACK as menu params).
- `env/adsr`/`env/one-knob-adsr` (2026-10-02) are harness-, link- and emulator-checked only:
  no listening pass, and the NTS-1 mkII SHAPE name display (a 101-entry `strings` row) hasn't
  been seen on a device. Staged: `lp-xd-oneknob`(`-lfo`), `lp-nts1-oneknob`(`-lfo`).
- `shape/drive` (2026-10-05) matches the host render in an effect unit on both devices, not in
  an oscillator; no listening pass.
  `~/Documents/logue-patches/Radio drive.loguepatch` is the user's Radio with it in place of
  wavefolder + lowpass-cheap (DRIVE 50, TONE 40 -- starting points, not tuned by ear).
- `filter/eq-band`, `filter/tilt` and svf's `notch`/`ap` outlets (2026-10-05) match the host
  render in an effect unit on both devices, not in an oscillator; no listening pass. Staged: `lp-xd-eq`/`-eq-lfo`/`-notch` and
  the `lp-nts1-*` equivalents (`scripts/stageEq.ts`).
- `filter/ladder` (2026-10-04) matches the host render in an effect unit on both
  devices (self-oscillation included), not in an oscillator. No listening pass yet, and the half bass compensation and k_max 4.8 are untested by ear. Staged:
  `lp-xd-ladder`/`-env`/`-osc` and the `lp-nts1-*` equivalents (FB_DRIVE on menu param 3).
- `filter/hilbert`/`util/freq-shift` match the host render in an effect unit on both devices (a
  +250 Hz shift); the freq-shifter example has no listening pass on either device yet (staged as `lp-fx-freqshift`/`lp-xdfx-freqshift`).
- `logue/osc/exciter`'s tone/decay/strike-train constants (`EXCITER_HELD_DECAY_RATE_MAX`/
  `EXCITER_PLUCK_A`/`EXCITER_TRACKED_HARMONICS`/`EXCITER_TRACKED_MIN_A`/`EXCITER_STRIKE_MAX_COUNT`/
  `EXCITER_STRIKE_GAIN_RATIO`) are ear-tune starting points, not measured — no real hardware/
  harness pass through the actual `string` primitive has confirmed them yet (see that primitive's
  own gotcha entry above).
- `filter/formant`'s per-block coefficients (2026-10-06): the user's patch that hung an xd now
  plays there at 513 real cycles a voice (`calibrateOsc.ts --xd formant`); no listening pass of
  the control-rate path, and no NTS-1 mkII reading -- its old one (753 cycles) was dropped from
  `nts1OscCpuReadings.json` since that code is gone (`calibrateOsc.ts formant` re-measures it). Staged:
  `lp-xd-fmt-*`/`lp-nts1-fmt-*` (`scripts/stageFormant.ts`). `~/.logue-emu`
  exists on this machine (set up 2026-09-28), so `measureCpuCosts.ts` runs directly.
- Knob bindings/slot followers (see "Graph resolution") work on a real minilogue xd and a real
  NTS-1 mkII (user, 2026-09-29, a `KnobTest` unit per device: a `sense/control` on Shape into an
  svf cutoff, the saw's COARSE bound to the second knob, FINE following a menu RESONANCE -- all
  reacting as expected; the NTS-1 mkII unit loaded with its SHPE/ALT rows' `init` at 512).
- `websim` is broken for every NTS-1 mkII unit this generator produces (see the primitive
  gotchas above) — not yet fixed, not blocking since the host-native harness/hardware cover
  verification instead.
- Two identified-but-deferred storage cleanups remain open: collapsing `Net.sources[]` to a
  single source, and switching node identity off `name` onto a stable id.
- The local build's version-drift risk (whatever GCC is installed, vs. the GCC 9.2.1 every
  earlier hardware-verified build used) is a disclosed, accepted tradeoff.
- `oscInstances.ts`'s member-name suffix sanitization (`replace(/[^a-zA-Z0-9_]/g,'_')`) doesn't
  disambiguate its OWN result — two node names like `a-b`/`a_b` both sanitize to `a_b`, a real
  member-name collision. Unreachable today (`uniqueNodeName` disambiguates the raw name first)
  except via hand-edited/legacy-imported data; not worth guarding without a concrete report.

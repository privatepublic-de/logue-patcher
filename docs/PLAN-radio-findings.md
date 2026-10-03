# Findings from the Radio modfx patch (2026-10-03)

Four things came up while building `~/Documents/logue-patches/Radio.loguepatch`, a modfx that imitates bad
radio reception. Each item below is marked **confirmed** (read in code), **inferred** (follows from
the code but not measured), or **open** (needs a measurement or a decision).

## Phase 0 -- patch-level answers (no code)

- **Crossfader jump** (confirmed, fixed in the patch by the user): `depth`'s **bipolar**
  outlet fed `crossfader.fade` with FADE at 50, so the additive inlet gave
  `clamp(200x - 50)`: stuck at 0 below 25 % of the knob, at 100 above 75 %. Unipolar outlet +
  FADE 0 is the right wiring.
- **Positive-only signal** (confirmed): `math/max` with `b` unwired is `max(x, 0.f)`, an exact
  half-wave rectifier; `math/clamp` with LO 0 does the same. The DSP is right -- but the wire
  into the VCA still shows the bipolar warning (see phase 2a).
- **Invisible stale wires** (confirmed): `mix2` has nets into `l1`/`r1`/`l2`/`r2`, which a mono
  `mix2` doesn't have, and they can't be deleted from the canvas (see phase 2b). They do
  nothing in the unit: the only live noise path is `noise -> vca_2 -> mix2.in2`.

## Phase 1 -- crossfader: crackle and the steep start

Even with correct wiring, two real problems remain (both inferred, not yet heard in the harness):

1. **The equal-power law is steepest at the ends.** `gain_b = sqrt(fade/100)`: 1 % of fade is
   already -20 dB of the second input, and one 10-bit knob step at the start is about -27 dB.
   Moving a knob near either end therefore sounds like a jump.
2. **Knob-driven gains step once per block.** `sense/control` is hoisted per block, so the
   crossfader's gains are block constants and change in steps with no ramp. Where the square
   root is steep, each step is a click. This explains the crackle.

Plan:
- Ramp the gains across the block when `fade` comes from a per-block value: keep the previous
  block's gains in members and interpolate linearly. That costs one multiply-add per gain per
  sample, not the per-sample square roots of a fully wired `fade`. `pan_ctl` (control-rate with
  a linear ramp) is the precedent. Apply the same to `stereo-crossfader`.
- Give mono `crossfader` the `LAW` select (Power/Linear) that `stereo-crossfader` already has.
  With Linear, a modulated fade has no steep end.
- **Decision for you:** ramp only in the crossfader, or smooth knob values in general?
  `sense/control` could ramp its own output across the block, which would cure zipper noise
  everywhere (VCA gain, mix gains, filter cutoff). The cost: everything downstream turns
  per-sample, so the per-block hoisting (`hoistedSuffixes`, grain-mill's CPU savings) is lost
  for knob-driven chains. My recommendation is per-primitive ramps where a gain is steep.
- Harness: a knob sweep in 10-bit steps through the crossfader, measuring the largest
  sample-to-sample step before and after. Re-measure the xd emulator cost and the code-size and
  CPU tables.

## Phase 2a -- wire polarity that reads the node's settings (done 2026-10-03)

Done: `LoguePrimitive.refinePolarity(ctx)` (display-only; `ctx.inlet(name)` = the bucket arriving,
`undefined` unwired; `ctx.param(name)`), called by `wirePolarity.ts` after inheriting, with rules on
`max`/`min`/`clamp`/`abs`/`negate`/`one-minus` and also `multiply`/`add`/`subtract`/`scale`
(`env - env` and `scale` with a negative FACTOR read bipolar now, so the VCA warns for them).
Audio and mixed (`neutral`) inputs keep the inherited bucket: rectified audio stays audio.
`setLogueParam` remounts only when the edit changes that node's outlet bucket, never mid-drag
(`endGesture` catches up). Checked in the built app: clamp LO -100 -> 0 clears the warning live.
**Known gap**: a subpatch instance's outlet still inherits from its inlets (`inheritFrom`), so a
`max` INSIDE a definition isn't seen from outside.

Original analysis:

Confirmed in `src/renderer/src/canvas/wirePolarity.ts`: every `math/*` node is
`outletPolarity: 'inherit'`, and inherit looks only at what's wired in, never at the node's
params or which inlets are unwired. So `max(env, 0)` and `clamp(env, LO 0)` both still read as
bipolar, and the VCA's `warnFrom: ['bipolar']` fires on a signal that can't go negative. The
warning tells the user to fix something that is already fixed -- the worst kind.

Plan:
- An optional, node-aware hook on `LoguePrimitive`, e.g.
  `polarityOf?(node, inherited, inletBucket)`, consulted by the resolver after inheriting.
  Display-only like the rest of polarity (codegen never reads it, so no snapshot changes).
- Rules (each a range argument, not a guess):
  - `math/max`: unwired `b` (= 0), or either input unipolar/gate -> **unipolar** (output >= 0).
  - `math/min`: both inputs unipolar -> unipolar (otherwise inherit).
  - `math/clamp`: LO >= 0 -> unipolar; LO = -100 and HI = 100 -> inherit.
  - `math/abs`: always unipolar (today it presumably inherits too -- check).
  - `math/one-minus` of a unipolar is unipolar; `math/negate` of a unipolar is bipolar (it's
    <= 0, and the VCA must warn for it).
- The resolver is memoized per node+outlet; params change without a remount (`setLogueParam`
  doesn't bump `reloadNonce`), so the edge colour/warning must re-read live when LO or `b`
  changes -- same live-read pattern as `trackGateState.ts`. Verify in the real app.
- Tests: a `wirePolarity` spec per rule, plus the Radio shape (multistage -> max -> vca gain
  shows no warning; multistage -> vca gain does).

## Phase 2b -- stale wires: visible and removable (done 2026-10-03)

Done as planned: `ports.ts` gives every primitive stale handles (outlets resolved through
`resolveDeclaredOutletName`), the Inspector has "Remove wire" per row and "Remove all stale
wires" (`removeNodeWires` -> `withoutNodeWires`), and `replaceNode` remaps through
`remapStereoMonoInlets` (`l`/`r` -> `in`; a mono wire feeds both sides; an `r` repeating its `l`
is dropped, any other leftover stays visible). No status line: what isn't remapped stays on the
canvas as a dashed wire, which says it better. Checked in the built app on a copy of Radio.

Original analysis:

Confirmed:
- `replaceNode` (`patchStore.ts`) deliberately keeps nets into inlets the new type lacks; its
  comment says they render "as an invalid/dashed edge". That only holds for **subpatch
  instances**: `ports.ts` adds `stale: true` handles for unknown wired inlet/outlet names on
  `sub/*` nodes only. For a plain primitive no handle exists, so React Flow can't draw the edge
  -- the wire is invisible and undeletable, though `findUnresolvedReferences` reports it as
  `stale-inlet` in the Inspector.
- Inspector issue rows have a "Remove" button only for `stale-param` (`removeParamValue`).

Plan (all three; the first two are small):
1. **Remove in the Inspector issues box**: a "Remove wire" button on each `stale-inlet` /
   `stale-outlet` row (store action `removeStaleEndpoints(nodeId, portName)`, one undo step,
   prunes a net left with an empty side like `removeNetEndpoint` does). Plus one "Remove all
   stale wires" when there's more than one.
2. **Draw them**: extend `ports.ts`' stale-handle logic from subpatch instances to every
   primitive, so a stale wire shows as the dashed edge the replace comment promises and can be
   clicked/deleted on the canvas too. Check the node height/estimate (`autoArrange.ts`) copes
   with the extra rows.
3. **Replace with... remaps or drops**: when the new type lacks an inlet, map it by position
   where the shapes clearly correspond (stereo `l1`/`r1` -> mono `in1`, keeping the first;
   `l2`/`r2` -> `in2`), otherwise drop the wire; and say what was dropped (a status line, as
   `setEffectModule` does for removed knob bindings). Never two sources into one inlet --
   `addNet`'s one-source rule applies.

## Phase 2c -- warnings that point at the fix

- **Additive inlet with a mid-dial and a bipolar source** (new warning): when a bipolar wire
  feeds an additive depth-100 inlet (crossfader/stereo-crossfader `fade`, filter `cutoff`,
  additive `timbre`, phase-dist `dcw`, one-knob-adsr `SHAPE`) whose dial isn't at an end, half
  of the source's travel is clamped away. It would show as the same red `!` on the wire as
  `warnFrom`, with text like "clamps below/above x %; for a full sweep, set FADE to 0 and use a
  0..1 source". This is the additive counterpart of `InletExpectation`, and it would have caught
  the Radio wiring.
- **VCA `gain` warning names the rectifier**: add "to keep only the positive half, put a
  `math/max` (b unwired) in between" next to the existing "bipolar to unipolar" advice. Only
  after 2a, or the advice leads straight back into the same warning.
- **Search terms**: `rectify`, `half-wave`, `positive` on `math/max` and `math/clamp`. No
  dedicated rectifier node: it would emit byte-identical code to `max` with `b` unwired, and
  that kind of node has been declined before.

## Phase 3 -- levels: hot noise and linear gain dials

What the code says (inferred; measure before changing anything):
- `osc/noise` outputs RMS 0.577 (white) or 1/3 (coloured), about -5 to -10 dBFS RMS.
- An effect's input is quiet (~0.18 peak for a saw on NTS-1 mkII, from the follower work).
- In Radio, the noise passes `vca_2` (gain = the follower, 0..1, follower GAIN +12 dB by
  default), so the hiss starts 10-15 dB above the dry signal.
- `mix2`'s GAIN is linear 0-100 with no unit display, so every useful hiss level is in the
  bottom 3 %. GAIN2 2.1 is -33.6 dB.

Plan:
1. **Measure**: a harness render of the Radio graph with a saw input at the device's measured
   input level, giving noise and dry RMS at a few GAIN2 values. Confirms or refutes the numbers
   above.
2. **Show dB** on `mix2`/`stereo-mix2` GAIN (a `unit`, as on `vca`'s GAIN). This is
   display-only: no file change, no device-facing change.
3. **Decision for you**, pick one or both:
   - **Audio taper** on mix GAINs (e.g. 100 = 0 dB, 50 = -12 dB, 0 = off). Fine control at
     low levels, but it changes what every stored value means: a file-version bump to 5 plus a
     migration mapping old linear values onto the new curve (the v3->v4 precedent). The device
     menu would show the taper value too.
   - **A LEVEL param on `osc/noise`** (default about -18 dB, which suits an effect), or simply
     lowering the coloured noises' RMS. Cheaper, but only fixes noise, not the mixer dials.
   My recommendation is 2 now, then decide 3 after the measurement in 1.

## Phase 4 -- results and upload, for fast iteration

Today (confirmed in `BuildPanel.tsx`/`UploadUnitDialog.tsx`):
- Every Build adds a row (global, newest first). Only the newest row per path has the upload
  icon, and old rows pile up.
- Uploading opens a dialog that rediscovers devices, reads every slot, and preselects the
  **first empty slot**, not the slot already holding this unit. Then a "Replace slot N"
  confirmation follows unless "always replace" is set.
- So one edit-build-upload-listen cycle is: Build, find the row, upload icon, wait for the
  slot scan, choose the slot again, confirm.

Options (**decision for you**; these combine):
- **A. Build & Upload in one action** (⇧⌘B, plus a button beside Build). It builds, then
  uploads to the slot this unit went to last time (remembered per patch + platform + module,
  session-only or in the document's settings), with no dialog when that slot still holds a unit
  of the same name. The dialog appears only the first time, or when the slot holds something
  else.
- **B. Preselect by name**: in the dialog, preselect the slot whose unit name matches, rather
  than the first empty one. Small change, useful on its own.
- **C. One row per unit**: collapse the list to one row per output path (newest build, a
  build count, the time), with the slot it was last uploaded to ("xd · osc slot 4 · 2 min
  ago") and a one-click re-upload. Older builds sit behind a disclosure, or go entirely
  (Finder keeps the `.history-*` files).
- **D. Keep the device session open** between uploads so the slot scan isn't repeated. Needs
  care: the device may have been unplugged or edited from the panel in the meantime.

My recommendation: B first (quick), then A + C as the real change, with D as an optimisation
inside A if the scan turns out to be the slow part.

## Order

1. **2b** (stale wires: Remove button + visible handles + replace remap) -- a real bug that
   leaves a patch with something the user can't fix; small and UI-only.
2. **2a** (polarity reads settings) -- a false warning on the correct fix; display-only, no
   codegen change.
3. **1 + 2c** (crossfader ramp/LAW, additive-clamp warning, VCA advice, search terms).
4. **4** (results/upload) -- the biggest day-to-day gain, but needs your pick of A-D.
5. **3** waits on its measurement.

# Buses: send/receive without wires

Status (2026-10-04): implemented -- phase 1 codegen, phase 2 canvas. CLAUDE.md's "Buses" holds
the current rules; this file keeps the reasoning.

User's call (2026-10-04), after the `thru` cascade inlets still meant too much wiring: named
buses. A send adds its input onto a bus; a receive reads the bus's sum. No wire between them.

## Decisions (user, 2026-10-04)

- **Global scope**: one namespace per unit. A send inside a subpatch reaches the root patch's
  bus of the same name; two instances of a subpatch holding a send+receive pair share it.
- **GAIN on every send**: 0..100 = x0..x1, shown in dB (`MIX_GAIN_DB`), default 100 (unity).
- **Separate stereo nodes**: `send`/`receive` (mono), `send-stereo`/`receive-stereo` (l/r).
  A mono send onto a bus that has a stereo receive (or the reverse) is an export error.
- The `thru`/`l-thru`/`r-thru` mixer inlets stay.

## Model

- `ObjNode.bus?: string`: the bus name, on the four bus node types only. A plain optional
  field (the `sample` precedent, no file-version bump; `patchCodec.ts` reads/writes it).
  Missing = `''`, a bus like any other.
- **User-facing node types are not registry primitives** (the subpatch port-node precedent):
  `logue/mix/send` (`in`, GAIN), `logue/mix/receive` (`out`), `logue/mix/send-stereo` (`l`/`r`,
  GAIN), `logue/mix/receive-stereo` (`l`/`r`). `createSubpatchAwareResolver` hands the canvas a
  pseudo-primitive for each (codegen hooks throw), so the registry loops (snapshots,
  measurements, sweeps) never meet a node that can't generate code alone. Category `mix` (a new
  category would reflow every palette colour). A `hidden` port flag was considered and dropped:
  ~10 renderer files read `.inlets`/`.outlets`.
- **Internal registry primitives** do the work, `internal: true` (never offered in the palette):
  `logue/mix/bus-send` (`in`, `thru` -> `thru + in*gain`), `logue/mix/bus-receive` (`bus` ->
  copy), and the stereo pair. Ordinary primitives otherwise: snapshots, CPU/code-size tables.

## Resolution: `resolveBuses(doc)` (`logue-codegen/src/buses.ts`, dependency-free)

One entry point, `flattenUnit(doc, defs)` = `resolveBuses(flattenSubpatches(...))`, used by
`resolvePlatformGraph` (so every generator and estimator) and `exposedLogueParams.ts`:

1. Group bus nodes by `bus`. Mono and stereo nodes on one bus: `BusResolutionError`
   (`extends UnsupportedLogueNodeError`).
2. Retype each to its internal primitive (name, params and position kept).
3. Chain the sends (sorted by node name, deterministic): send k's `thru` <- send k-1. Every
   receive's `bus` <- the last send. No sends: unwired, the receive outputs `0.f`.

`resolveAudioGraph` does the rest unchanged: a bus nobody receives is unreachable (zero code),
fan-out to several receives is free. A loop through a bus (receive -> delay -> send to the same
bus, the usual feedback effect) is a cycle like any other; when the document has buses the cycle
error gains a sentence saying a bus counts as a wire (fix: a `sample-delay` in the loop). CPU:
one multiply-add per send, a receive is a copy GCC folds.

## Canvas

- Arrange by signal flow (`flowLayout.ts`, and `autoArrange` if it orders by wiring): a send ->
  receive of the same bus is a virtual edge, or every send lands in the "unwired" pile.
- Double-clicking a send/receive header edits the BUS name, not the node name (the node name
  is the hidden identity, editable in the Inspector).
- Replace with... among the four bus types keeps `bus`; to anything else drops it. Paste and
  Duplicate keep it (a second send to the same bus).

- Header: a send reads `→ verb`, a receive `verb →` (bold, where the node name goes; the node
  name stays the identity and shows in the Inspector). Receive is a compact node (no params).
- Inspector: a "Bus" field (text input + the patch's existing bus names offered), editing
  `bus` through one store action (`setNodeBus`, one undo step).
- Insert popup / palette: `send`/`receive`/stereo entries, plus per existing bus
  `send → verb` / `receive verb` presets (the `controlPresetEntries` pattern). A new send/receive
  gets the most recently used bus name, else `bus1`.
- Wire colour: a receive's outlet polarity = the merge of its bus's sends' inputs
  (`wirePolarity.ts`, bus-aware, across the open document only).
- Warnings (`unresolvedReferences`-style badges): a receive whose bus has no send, a send whose
  bus has no receive -- root documents only (inside a definition the other end is usually in the
  root patch), counting sends/receives inside used subpatch definitions.
- Done after phase 2: mixers send straight onto a bus (`busOutlets`, see CLAUDE.md).
- Optional, later: hovering a send/receive highlights its partners; a "rename bus everywhere".

## Measurement and tests

- Snapshot goldens: the four internal primitives (like any primitive).
- `logue-buses.spec.ts`: chaining order, unity sum, gain, receive with no sends = 0, bus through a
  subpatch (global), stereo/mono mismatch error, cycle through a bus rejected, unreceived bus = no code.
- CPU / code-size tables: the internal primitives, measured like any primitive.
- CLAUDE.md: primitive count, `mix` category, the `bus` field, this mechanism.
- Real ARM builds both platforms, osc and fx; app check with run-desktop.

# Logue Patcher

A visual patcher for building custom oscillators and effects for the Korg **minilogue xd** and
**NTS-1 mkII**, without writing C++.

You wire DSP building blocks (oscillators, filters, envelopes, LFOs, delays, logic, math, ...)
together on a node-graph canvas, choose which parameters appear on the device's knobs and menu,
and Logue Patcher generates the *logue SDK source for you. It can also compile it into an
installable unit (`.mnlgxdunit` / `.nts1mkiiunit`) and upload that straight to the device over
USB MIDI.

- 80+ built-in primitives, including sample and granular oscillators, phase distortion, hard
  sync, Karplus-Strong strings, formant and state-variable filters, a frequency shifter and
  SDRAM delay/grain buffers for effects
- Oscillator units and mod/delay/reverb effect units for both devices
- Reusable subpatches (`.loguesub`) that you can nest
- Live RAM, code-size and CPU estimates while you patch
- Device param matrix: assign params to menu slots, the Shape knobs, or have one follow another
- Direct upload, backup and restore of user units over SysEx (no Kontrol Editor needed)

**macOS only.** Patches are plain JSON files (`.loguepatch`); example effects are in
[`examples/effects/`](examples/effects).

> **How this was made:** Logue Patcher was developed largely through AI-assisted ("vibe")
> coding with Anthropic's Claude models, directed, tested on real hardware and curated by
> Peter Witzel. Expect the code and its comments to reflect that.

> Logue Patcher is an independent project and is not affiliated with or endorsed by KORG Inc.
> minilogue, NTS-1 and logue are trademarks of KORG Inc.

## Requirements

| What | Why | How |
| --- | --- | --- |
| macOS 12 or later | the app and its MIDI helper are macOS-only | |
| Xcode Command Line Tools | `swiftc` compiles the bundled CoreMIDI helper | `xcode-select --install` |
| Node.js 20.19+ or 22.12+, with npm | builds and runs the app | [nodejs.org](https://nodejs.org) or `brew install node` |
| Git | to clone this repo and the logue SDK | included with the Command Line Tools |
| ARM GCC toolchain *(only for Build)* | compiles units for the devices | `brew install --cask gcc-arm-embedded` |
| Korg logue SDK checkout *(only for Build)* | headers, templates and linker scripts | see step 4 below |

You only need the last two if you want the app to compile units. **Export** (writing the
generated source to a folder) works without them.

Whichever you use, first set a **Build output folder** in **Logue Patcher › Settings…** (⌘,);
that's where Export and Build write. A **Subpatch library folder** for your `.loguesub` files is
optional.

## Getting started

### 1. Clone the repository

```bash
git clone https://github.com/<your-account>/logue-patcher.git
```

```bash
cd logue-patcher
```

### 2. Install dependencies

```bash
npm install
```

### 3. Run the app in development mode

```bash
npm run dev
```

The first run compiles the native MIDI helper (`resources/bin/logue-midi-helper`) with `swiftc`;
later runs skip it while it's up to date.

### 4. (Optional) Set up building units

Install the ARM toolchain:

```bash
brew install --cask gcc-arm-embedded
```

Clone Korg's logue SDK somewhere outside this repo, together with its submodules:

```bash
git clone --recursive https://github.com/korginc/logue-sdk.git ~/logue-sdk
```

Then, in **Logue Patcher › Settings…**, set:

- **logue SDK folder** to the checkout (e.g. `~/logue-sdk`)
- **ARM toolchain**: leave empty if it shows "automatic: …"; otherwise point it at the
  toolchain's `bin` folder (it looks in `/opt/homebrew/bin`, `/usr/local/bin` and
  `/Applications/ArmGNUToolchain/*/arm-none-eabi/bin`)

### 5. Build a unit and put it on the device

1. Open an example (e.g. `examples/effects/stereo-reverb.loguepatch`) or create a new
   oscillator (⌘N) or effect (**File › New Effect**).
2. Pick the target device in the Build panel (bottom right) and click **Build** (⌘B).
3. Connect the device over USB and click the upload icon next to the result in Build Results,
   or load the unit with Korg's Kontrol Editor / `logue-cli`.

Units are built with whatever `arm-none-eabi-gcc` you have installed; the Build Results list
names the compiler that was used.

## Packaging a standalone app

```bash
npm run build:mac
```

This writes `Logue Patcher.app` and a `.dmg` to `dist/`. The app isn't notarized, so macOS
blocks it the first time; allow it under **System Settings › Privacy & Security › Open Anyway**,
or remove the quarantine flag:

```bash
xattr -dr com.apple.quarantine "/Applications/Logue Patcher.app"
```

## Development

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm test
```

`npm run build` runs the typecheck and the test suite before bundling.

Layout:

- `src/main`, `src/preload`, `src/renderer` — the Electron app (React, React Flow, Zustand)
- `src/shared` — document model, file codec and the typed IPC contract
- `logue-codegen/` — the dependency-free primitive registry, code generators, estimators and
  SysEx codec, plus verification scripts and host test harnesses
- `native/logue-midi-helper` — the Swift CoreMIDI bridge
- `test/` — Vitest specs, including golden generated source for every primitive

Design notes and the reasoning behind many constants live in [`CLAUDE.md`](CLAUDE.md) and
[`docs/`](docs).

## License

[MIT](LICENSE) © 2026 Peter Witzel

Parts of Korg's logue SDK (BSD 3-Clause) are embedded in the minilogue xd unit templates, and
the app bundles open-source npm packages; their licences are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). After changing dependencies, regenerate it:

```bash
node scripts/write-third-party-notices.mjs
```

import type { LogueEffectModule, LogueModule, LoguePlatform } from '../../src/shared/domain/patch'
import type { LogueKnob } from '../../src/shared/domain/paramValueTypes'
import type { DeviceParam } from './paramDeviceType'
import { CODE_BASELINE_BYTES } from './codeSizeTable'

/**
 * A menu slot the device owns rather than the patch: it is declared on every unit and driven by
 * a fixed knob (NTS-1 mkII: an oscillator's slots 0/1 are its Shape/Alt-Shape pair -- see
 * `reserveFixedKnobSlots`, `nts1mkii/generateOscUnit.ts`, for the Kontrol Editor rejection that
 * made both mandatory).
 */
export interface ReservedKnobSlot {
  index: number
  knob: LogueKnob
  /** The header row's name. */
  name: string
  /** What the panel calls the knob, for messages. */
  panelName: string
  /** The header row; a bound param's authored value maps over `min..max` into its `init`. */
  device: DeviceParam
  /** The row's `init` when no param is bound. */
  unboundInit: number
}

const TEN_BIT_KNOB: DeviceParam = { min: 0, max: 1023, type: 'none', scale: 1 }

// An NTS-1 mkII effect's A/B knobs are its params 0/1 (`k_unit_*fx_fixed_param_time/depth`).
const TIME_SLOT: ReservedKnobSlot = {
  index: 0,
  knob: 'time',
  name: 'TIME',
  panelName: 'TIME',
  device: TEN_BIT_KNOB,
  unboundInit: 0
}
const DEPTH_SLOT: ReservedKnobSlot = {
  index: 1,
  knob: 'depth',
  name: 'DPTH',
  panelName: 'DEPTH',
  device: TEN_BIT_KNOB,
  unboundInit: 0
}
// Delay/reverb param 2 (B knob with DEL/REV held), dry/wet by convention: Korg's dummy-delfx row.
// On a real NTS-1 mkII the display's "W100" arrives as 1000 (docs/PLAN-effects.md).
const MIX_SLOT: ReservedKnobSlot = {
  index: 2,
  knob: 'mix',
  name: 'MIX',
  panelName: 'MIX',
  device: { min: -1000, max: 1000, type: 'drywet', scale: 1, frac: 1, fracMode: 1 },
  unboundInit: 0
}

/** An effect's always-declared members on either platform (`fxShared.ts`' `FX_FIXED_MEMBER_DECLS`):
 *  note_, noteFine_, time01_, depth01_, mix01_, tempo_. */
const FX_BASELINE_BYTES = 6 * 4

/**
 * What an otherwise empty unit of this kind loads besides its fixed members: measured by
 * `scripts/measureCodeSizes.ts` (a constant into the output for an oscillator, a pass-through
 * for an effect: e.g. 4244 B for an NTS-1 mkII delay, 440 B for an xd one).
 */
function fixedCode(platform: LoguePlatform, module: LogueModule, members: number): number {
  return CODE_BASELINE_BYTES[`${platform}:${module}`] - members
}

/**
 * What one (platform, module) pair is: the single place its limits live, read by both
 * generators, both estimators and the renderer's Param Matrix, so they can't disagree. A pair
 * without an entry can't be built yet.
 */
export interface UnitKind {
  platform: LoguePlatform
  module: LogueModule
  /** Every param slot the header/manifest can declare, reserved ones included. */
  maxParams: number
  /** In slot order. */
  reservedSlots: readonly ReservedKnobSlot[]
  /** The fixed hardware controls a param can be bound to. */
  knobs: readonly LogueKnob[]
  /** The pool code, data and state share (see `ramBytes`' sources on each entry). */
  ramBytes: number
  /** The generated unit's always-declared members (`FIXED_MEMBER_DECLS`), for the RAM estimate. */
  fixedBaselineBytes: number
  /** External memory an instance's `sdramFloats` comes out of; unset = the unit has none. */
  sdramBytes?: number
  /**
   * Measured: what an empty generated unit already loads besides `fixedBaselineBytes` (its
   * code, the header, the SDK glue).
   */
  fixedCodeBytes: number
}

export const UNIT_KINDS: readonly UnitKind[] = [
  {
    platform: 'minilogue-xd',
    module: 'osc',
    // k_user_osc_param_id1..id6 (platform/minilogue-xd/inc/userosc.h).
    maxParams: 6,
    reservedSlots: [],
    // Not the filter knobs: user_osc_param_t's cutoff/resonance (0x0000-0x1fff per Korg's header)
    // read a constant near full scale on a real xd and don't follow FILTER CUTOFF/RESONANCE
    // (user, 2026-09-30: a unit bound to them never moved).
    knobs: ['shape', 'shape-2'],
    // userosc.ld's single SRAM region, which every section is placed into.
    ramBytes: 32 * 1024,
    fixedBaselineBytes: 32,
    fixedCodeBytes: fixedCode('minilogue-xd', 'osc', 32)
  },
  {
    platform: 'nts1mkii',
    module: 'osc',
    // UNIT_OSC_MAX_PARAM_COUNT (platform/nts-1_mkii/common/unit_osc.h).
    maxParams: 10,
    reservedSlots: [
      {
        index: 0,
        knob: 'shape',
        name: 'SHPE',
        panelName: 'SHAPE',
        device: TEN_BIT_KNOB,
        unboundInit: 0
      },
      {
        index: 1,
        knob: 'shape-2',
        name: 'ALT',
        panelName: 'ALT-SHAPE',
        device: TEN_BIT_KNOB,
        unboundInit: 0
      }
    ],
    // The unit context's filter fields are "Unused. Future." in Korg's header.
    knobs: ['shape', 'shape-2'],
    // README's "Max RAM Load Size" for osc: the whole loaded ELF (code + data) must fit.
    ramBytes: 48 * 1024,
    fixedBaselineBytes: 24,
    fixedCodeBytes: fixedCode('nts1mkii', 'osc', 24)
  },
  {
    platform: 'nts1mkii',
    module: 'modfx',
    // UNIT_MODFX_MAX_PARAM_COUNT (platform/nts-1_mkii/common/unit_modfx.h).
    maxParams: 10,
    reservedSlots: [TIME_SLOT, DEPTH_SLOT],
    knobs: ['time', 'depth'],
    // README's "Max RAM Load Size" for modfx; delay lines go in SDRAM (256 KB), not here.
    ramBytes: 16 * 1024,
    fixedBaselineBytes: FX_BASELINE_BYTES,
    sdramBytes: 256 * 1024,
    fixedCodeBytes: fixedCode('nts1mkii', 'modfx', FX_BASELINE_BYTES)
  },
  ...(['delfx', 'revfx'] as const).map((module): UnitKind => ({
    platform: 'nts1mkii',
    module,
    // UNIT_DELFX_MAX_PARAM_COUNT / UNIT_REVFX_MAX_PARAM_COUNT.
    maxParams: 11,
    reservedSlots: [TIME_SLOT, DEPTH_SLOT, MIX_SLOT],
    knobs: ['time', 'depth', 'mix'],
    // README's "Max RAM Load Size" for delfx/revfx; SDRAM (3 MB) is separate.
    ramBytes: 24 * 1024,
    fixedBaselineBytes: FX_BASELINE_BYTES,
    sdramBytes: 3 * 1024 * 1024,
    fixedCodeBytes: fixedCode('nts1mkii', module, FX_BASELINE_BYTES)
  })),
  // The xd's effects have no menu params at all (`num_param` 0 in Korg's dummy manifests; the
  // README: params "only meaningful for osc type projects"), only the panel knobs:
  // `k_user_*fx_param_time/depth`, and on delay/reverb `shift_depth` (Shift+Depth, id 3), which
  // is dry/wet by convention -- the `mix` knob. Each arrives as Q31 (docs/PLAN-effects.md).
  {
    platform: 'minilogue-xd',
    module: 'modfx',
    maxParams: 0,
    reservedSlots: [],
    knobs: ['time', 'depth'],
    // usermodfx.ld: SRAM 6K holds code, data and state; SDRAM 128K.
    ramBytes: 6 * 1024,
    fixedBaselineBytes: FX_BASELINE_BYTES,
    sdramBytes: 128 * 1024,
    fixedCodeBytes: fixedCode('minilogue-xd', 'modfx', FX_BASELINE_BYTES)
  },
  ...(['delfx', 'revfx'] as const).map((module): UnitKind => ({
    platform: 'minilogue-xd',
    module,
    maxParams: 0,
    reservedSlots: [],
    knobs: ['time', 'depth', 'mix'],
    // userdelfx.ld / userrevfx.ld: SRAM 12K (code, data and state), SDRAM 2432K.
    ramBytes: 12 * 1024,
    fixedBaselineBytes: FX_BASELINE_BYTES,
    sdramBytes: 2432 * 1024,
    fixedCodeBytes: fixedCode('minilogue-xd', module, FX_BASELINE_BYTES)
  }))
]

export const MODULE_LABEL: Record<LogueModule, string> = {
  osc: 'Oscillator',
  modfx: 'Modulation effect',
  delfx: 'Delay effect',
  revfx: 'Reverb effect'
}

/** An effect takes stereo audio in and gives stereo out; an oscillator makes mono audio from a note. */
export function isEffectModule(module: LogueModule): module is LogueEffectModule {
  return module !== 'osc'
}

export function findUnitKind(platform: LoguePlatform, module: LogueModule): UnitKind | undefined {
  return UNIT_KINDS.find((k) => k.platform === platform && k.module === module)
}

/** For callers that only ever handle a pair known to exist. */
export function requireUnitKind(platform: LoguePlatform, module: LogueModule): UnitKind {
  const kind = findUnitKind(platform, module)
  if (!kind) throw new Error(`No unit kind for ${module} on ${platform}.`)
  return kind
}

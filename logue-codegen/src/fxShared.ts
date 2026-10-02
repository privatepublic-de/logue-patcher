import { sdramLayout } from './oscBody'
import { floatLit, KNOB_POSITION_MEMBER } from './oscParams'
import type { UnitKind } from './unitKinds'

/**
 * What both platforms' effect generators (`nts1mkii/generateFxUnit.ts`,
 * `minilogue-xd/generateFxUnit.ts`) emit the same way: the always-declared members, the
 * oscillator-API stand-ins and the SDRAM glue. Only the outer shell differs per platform.
 */

/**
 * Always declared, whatever the graph (their bytes are the RAM estimate's baseline,
 * `unitKinds.ts`' `fixedBaselineBytes`, checked by `logue-oscFixedBaseline.spec.ts`).
 */
export const FX_FIXED_MEMBER_DECLS = `  // The note a primitive that follows the played note (an oscillator's pitch, a TRACK filter)
  // reads: an effect gets none, so it's a fixed middle C.
  float note_;
  float noteFine_;
  // The fixed knobs' positions (0..1), as the device reports them.
  float time01_;
  float depth01_;
  float mix01_;
  // The device tempo in BPM, 120 until the device gives one.
  float tempo_;
`

/**
 * Effect units link against the fx API only (`fx_api.h`): no `osc_api.h`, so none of its LUTs
 * or helpers exist on the device for them. The two the primitive registry uses get self-contained
 * stand-ins: `fx_sinf` is `osc_sinf`'s exact twin (same LUT walk, same `wt_sine_lut_f`), and a
 * note's phase increment is computed from `fastpow2f` (`utils/float_math.h`) instead of the
 * note LUT -- `osc_w0f_for_note`'s own interpolation and clip, with its constants inlined.
 * Both SDKs' fx APIs have `fx_sinf` and `fastpow2f`.
 */
export const OSC_API_STAND_INS = `// Effects link no oscillator API -- stand-ins for the two symbols primitives use.
#define osc_sinf fx_sinf
static inline __attribute__((always_inline)) float osc_w0f_for_note(uint8_t note, uint8_t mod)
{
  const float f = 440.f * fastpow2f(((float)note + (float)mod * (1.f / 255.f) - 69.f) * (1.f / 12.f));
  return (f < 23679.643054f ? f : 23679.643054f) * (1.f / 48000.f);
}
`

export type SdramLayout = ReturnType<typeof sdramLayout>

/** Points each instance at its share of the block `base` and zeroes the block: the device
 *  hands SDRAM over dirty (the phase 0 spike found a fully written block on the NTS-1 mkII; the
 *  xd's `.sdram` section is NOLOAD, so nothing clears it either). */
export function sdramInits(sdram: SdramLayout, base: string): string {
  if (sdram.totalFloats === 0) return ''
  return (
    sdram.regions.map((r) => `    sdram_${r.suffix} = ${base} + ${r.offset};\n`).join('') +
    `    for (uint32_t i = 0; i < ${sdram.totalFloats}u; ++i) ${base}[i] = 0.f;\n`
  )
}

export function sdramClears(sdram: SdramLayout): string {
  return sdram.regions
    .map((r) => `    for (uint32_t i = 0; i < ${r.floats}u; ++i) sdram_${r.suffix}[i] = 0.f;\n`)
    .join('')
}

export function sdramPointerDecls(sdram: SdramLayout): string {
  return sdram.regions.map((r) => `  float *sdram_${r.suffix};\n`).join('')
}

/** Each fixed knob's position before the device reports it: its reserved row's `init` where
 *  it has one (NTS-1 mkII), else 0. A bound param's authored start comes after, in knobInits. */
export function fixedKnobInits(kind: UnitKind): string {
  const bySlot = new Map(kind.reservedSlots.map((slot) => [slot.knob, slot]))
  return kind.knobs
    .map((knob) => {
      const slot = bySlot.get(knob)
      const position = slot
        ? (slot.unboundInit - slot.device.min) / (slot.device.max - slot.device.min)
        : 0
      return `    ${KNOB_POSITION_MEMBER[knob]} = ${floatLit(position)};\n`
    })
    .join('')
}

export function formatKb(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`
}

/**
 * CPU telemetry through audio for NTS-1 mkII effect units. The unit still renders its graph (so
 * the cost is real), then its output is replaced by three tones the recording decodes:
 *
 * - `DETECTOR_HZ`: a phase-continuous sine, for finding dropouts (any gap or repeated block is a
 *   break in it);
 * - `fxToneHz(c)`: the unit's own render cycles per sample, smoothed over 16 calls;
 * - `totToneHz(c)`: all cycles per sample between two render calls (the whole budget, ~11457).
 *
 * With `burnRow`, the unit also has a BURN menu param at that row: each call spins on the cycle
 * counter until BURN cycles per sample have passed since the call started (graph included), so
 * the load is exact.
 *
 * The reading uses the Cortex-M7 DWT cycle counter, which a user unit may switch on (the CPU
 * probe of stageNts1CpuProbe.ts / stageFxUnits.ts does the same). For measuring only.
 */

export const DETECTOR_HZ = 440
export const TONE_AMPLITUDE = 0.2
const FX_BASE_HZ = 2000
const TOT_BASE_HZ = 7000
const TOT_OFFSET = 10000
/** Cycles per Hz: a 1 s recording resolves the tone to well under 0.1 Hz, i.e. < 0.4 cycles. */
const CYCLES_PER_HZ = 4

export const fxToneHz = (cycles: number): number => FX_BASE_HZ + cycles / CYCLES_PER_HZ
export const totToneHz = (cycles: number): number =>
  TOT_BASE_HZ + (cycles - TOT_OFFSET) / CYCLES_PER_HZ
export const cyclesFromFxTone = (hz: number): number => (hz - FX_BASE_HZ) * CYCLES_PER_HZ
export const cyclesFromTotTone = (hz: number): number =>
  (hz - TOT_BASE_HZ) * CYCLES_PER_HZ + TOT_OFFSET
/** Where to look for each tone (cycles 0..12000 / 9000..14000). */
export const FX_TONE_BAND: [number, number] = [fxToneHz(0) - 20, fxToneHz(12000)]
export const TOT_TONE_BAND: [number, number] = [totToneHz(9000), totToneHz(14000)]

const EMPTY_ROW = '{0, 0, 0, 0, k_unit_param_type_none, 0, 0, 0, {""}}'

/** Edits a generated effect's files (`header.c`, `unit.cc`). */
export function withFxTelemetry(
  files: Record<string, string>,
  opts: { burnRow?: number } = {}
): Record<string, string> {
  let headerC = files['header.c']
  let unitCc = files['unit.cc']
  const { burnRow } = opts
  if (burnRow !== undefined) {
    const n = Number(/\.num_params = (\d+),/.exec(headerC)![1])
    if (burnRow !== n) throw new Error(`BURN must take the first free row (${n}), not ${burnRow}`)
    const rows = headerC.split('\n')
    const first = rows.findIndex((l) => l.trim().startsWith('{') && l.includes('k_unit_param_type'))
    if (!rows[first + n].includes(EMPTY_ROW)) throw new Error(`row ${n} is not free`)
    rows[first + n] = rows[first + n].replace(
      EMPTY_ROW,
      '{0, 12000, 0, 0, k_unit_param_type_none, 0, 0, 0, {"BURN"}}'
    )
    headerC = rows.join('\n').replace(`.num_params = ${n},`, `.num_params = ${n + 1},`)
  }
  const decls = `
// Telemetry (logue-codegen/scripts/hwtest/telemetry.ts).
#define DEMCR (*(volatile uint32_t *)0xE000EDFCu)
#define DWT_CTRL (*(volatile uint32_t *)0xE0001000u)
#define DWT_CYCCNT (*(volatile uint32_t *)0xE0001004u)
#define DWT_LAR (*(volatile uint32_t *)0xE0001FB0u)
static uint32_t s_t_prev = 0, s_t_have_prev = 0, s_t_fx = 0, s_t_tot = 0;
static int32_t s_t_burn = 0;
static float s_t_ph[3] = {0.f, 0.f, 0.f};
static inline void telemetry_tone(float *out, uint32_t frames, int k, float hz)
{
  const float inc = hz / 48000.f;
  float ph = s_t_ph[k];
  for (uint32_t i = 0; i < frames; ++i)
  {
    const float s = ${TONE_AMPLITUDE}f * fx_sinf(ph);
    out[2 * i] += s;
    out[2 * i + 1] += s;
    ph += inc;
    if (ph >= 1.f) ph -= 1.f;
  }
  s_t_ph[k] = ph;
}
`
  const render = `  const uint32_t t0 = DWT_CYCCNT;
  if (s_t_have_prev && frames)
  {
    const uint32_t tot = ((t0 - s_t_prev) << 4) / frames;
    s_t_tot = s_t_tot ? s_t_tot + ((int32_t)(tot - s_t_tot) >> 4) : tot;
  }
  s_t_prev = t0;
  s_t_have_prev = 1;
  s_fx_instance.process(in, out, frames);
  if (s_t_burn > 0)
  {
    const uint32_t until = (uint32_t)s_t_burn * frames;
    while (DWT_CYCCNT - t0 < until) {}
  }
  if (frames)
  {
    const uint32_t fxc = ((DWT_CYCCNT - t0) << 4) / frames;
    s_t_fx = s_t_fx ? s_t_fx + ((int32_t)(fxc - s_t_fx) >> 4) : fxc;
  }
  for (uint32_t i = 0; i < 2 * frames; ++i) out[i] = 0.f;
  telemetry_tone(out, frames, 0, ${DETECTOR_HZ}.f);
  telemetry_tone(out, frames, 1, ${FX_BASE_HZ}.f + (float)s_t_fx * ${1 / 16 / CYCLES_PER_HZ}f);
  if (s_t_tot)
    telemetry_tone(out, frames, 2, ${TOT_BASE_HZ}.f + ((float)s_t_tot * ${1 / 16}f - ${TOT_OFFSET}.f) * ${1 / CYCLES_PER_HZ}f);`
  const replace = (from: string, to: string): void => {
    if (!unitCc.includes(from)) throw new Error(`telemetry: "${from.trim()}" not found`)
    unitCc = unitCc.replace(from, to)
  }
  replace(
    'static int32_t cached_values[UNIT_MAX_PARAM_COUNT];',
    `static int32_t cached_values[UNIT_MAX_PARAM_COUNT];\n${decls}`
  )
  replace(
    '  s_fx_instance.init(sdram);',
    '  DEMCR |= (1u << 24);\n  DWT_LAR = 0xC5ACCE55u;\n  DWT_CTRL |= 1u;\n  s_fx_instance.init(sdram);'
  )
  replace('  s_fx_instance.process(in, out, frames);', render)
  if (burnRow !== undefined) {
    replace(
      '  cached_values[id] = value;\n',
      `  cached_values[id] = value;\n  if (id == ${burnRow}) s_t_burn = value;\n`
    )
  }
  return { ...files, 'header.c': headerC, 'unit.cc': unitCc }
}

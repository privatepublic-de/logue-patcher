/**
 * CPU telemetry through audio for NTS-1 mkII and minilogue xd effect units. The unit still renders its graph (so
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
 * The reading uses the DWT cycle counter (NTS-1 mkII: the Cortex-M7; xd: the effects MCU's
 * Cortex-M4), which a user unit may switch on (the CPU probe of stageNts1CpuProbe.ts /
 * stageFxUnits.ts does the same on the NTS-1 mkII). The xd's whole budget is far smaller, so its
 * total tone has no offset (`XD_TELEMETRY`). For measuring only.
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

/** The xd: fx 0..4500 and total 2000..8000 cycles per sample (its effects MCU, ~3750 at 180 MHz). */
export const XD_TELEMETRY = {
  totOffset: 0,
  fxBand: [fxToneHz(0) - 20, fxToneHz(4500)] as [number, number],
  totBand: [TOT_BASE_HZ + 2000 / CYCLES_PER_HZ, TOT_BASE_HZ + 8000 / CYCLES_PER_HZ] as [
    number,
    number
  ]
}
export const cyclesFromXdTotTone = (hz: number): number => (hz - TOT_BASE_HZ) * CYCLES_PER_HZ

const EMPTY_ROW = '{0, 0, 0, 0, k_unit_param_type_none, 0, 0, 0, {""}}'

/** Edits a generated effect's files (`header.c`, `unit.cc`). */
export function withFxTelemetry(
  files: Record<string, string>,
  opts: { burnRow?: number; passInput?: boolean } = {}
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
${opts.passInput ? '' : '  for (uint32_t i = 0; i < 2 * frames; ++i) out[i] = 0.f;\n'}  telemetry_tone(out, frames, 0, ${DETECTOR_HZ}.f);
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

/**
 * The minilogue xd counterpart: edits a generated effect's `fx.cpp` (`<PREFIX>_INIT`, the process
 * hook -- in place on delay/reverb, main buffers on mod -- and `_PARAM`). With `burnMax`, the
 * DEPTH knob sets the burn (0..burnMax cycles per sample; an xd effect has no menu params).
 */
export function withXdFxTelemetry(
  files: Record<string, string>,
  module: 'modfx' | 'delfx' | 'revfx',
  opts: { burnMax?: number } = {}
): Record<string, string> {
  const prefix = module.toUpperCase()
  let fxCpp = files['fx.cpp']
  const replace = (from: string, to: string): void => {
    if (!fxCpp.includes(from)) throw new Error(`xd telemetry: "${from.trim()}" not found`)
    fxCpp = fxCpp.replace(from, to)
  }
  replace(
    `void ${prefix}_INIT(uint32_t platform, uint32_t api)`,
    `// Telemetry (logue-codegen/scripts/hwtest/telemetry.ts).
#define DEMCR (*(volatile uint32_t *)0xE000EDFCu)
#define DWT_CTRL (*(volatile uint32_t *)0xE0001000u)
#define DWT_CYCCNT (*(volatile uint32_t *)0xE0001004u)
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
static void telemetry_process(const float *in, float *out, uint32_t frames);

void ${prefix}_INIT(uint32_t platform, uint32_t api)`
  )
  replace('  s_fx.init();', '  DEMCR |= (1u << 24);\n  DWT_CTRL |= 1u;\n  s_fx.init();')
  if (module === 'modfx')
    replace(
      '  s_fx.process(main_xn, main_yn, frames);',
      '  telemetry_process(main_xn, main_yn, frames);'
    )
  else
    replace(
      `void ${prefix}_PROCESS(float *xn, uint32_t frames) { s_fx.process(xn, xn, frames); }`,
      `void ${prefix}_PROCESS(float *xn, uint32_t frames) { telemetry_process(xn, xn, frames); }`
    )
  fxCpp += `
static void telemetry_process(const float *in, float *out, uint32_t frames)
{
  const uint32_t t0 = DWT_CYCCNT;
  if (s_t_have_prev && frames)
  {
    const uint32_t tot = ((t0 - s_t_prev) << 4) / frames;
    s_t_tot = s_t_tot ? s_t_tot + ((int32_t)(tot - s_t_tot) >> 4) : tot;
  }
  s_t_prev = t0;
  s_t_have_prev = 1;
  s_fx.process(in, out, frames);
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
    telemetry_tone(out, frames, 2, ${TOT_BASE_HZ}.f + (float)s_t_tot * ${1 / 16 / CYCLES_PER_HZ}f);
}
`
  if (opts.burnMax !== undefined) {
    replace(
      `void ${prefix}_PARAM(uint8_t index, int32_t value) {`,
      `void ${prefix}_PARAM(uint8_t index, int32_t value) {
  if (index == k_user_${module}_param_depth)
    s_t_burn = (int32_t)(clip01f(q31_to_f32(value)) * ${opts.burnMax}.f);`
    )
  }
  return { ...files, 'fx.cpp': fxCpp }
}

/** An oscillator's tones are quieter: the NTS-1 mkII's voice section soft-clips a loud one. */
const OSC_TONE_AMPLITUDE = 0.08

/** The C both oscillator wrappers share: the counter, three tones written into a mono float
 *  buffer, and a burn (cycles per sample) set from outside. */
const oscTelemetryDecls = `
// Telemetry (logue-codegen/scripts/hwtest/telemetry.ts).
#define DEMCR (*(volatile uint32_t *)0xE000EDFCu)
#define DWT_CTRL (*(volatile uint32_t *)0xE0001000u)
#define DWT_CYCCNT (*(volatile uint32_t *)0xE0001004u)
#define DWT_LAR (*(volatile uint32_t *)0xE0001FB0u)
static uint32_t s_t_prev = 0, s_t_have_prev = 0, s_t_fx = 0, s_t_tot = 0;
static int32_t s_t_burn = 0;
static float s_t_ph[3] = {0.f, 0.f, 0.f};
static inline void telemetry_tone_mono(float *out, uint32_t frames, int k, float hz)
{
  const float inc = hz / 48000.f;
  float ph = s_t_ph[k];
  for (uint32_t i = 0; i < frames; ++i)
  {
    out[i] += ${OSC_TONE_AMPLITUDE}f * osc_sinf(ph);
    ph += inc;
    if (ph >= 1.f) ph -= 1.f;
  }
  s_t_ph[k] = ph;
}
static inline void telemetry_start(uint32_t *t0, uint32_t frames)
{
  if (!(DWT_CTRL & 1u)) { DEMCR |= (1u << 24); DWT_LAR = 0xC5ACCE55u; DWT_CTRL |= 1u; }
  *t0 = DWT_CYCCNT;
  if (s_t_have_prev && frames)
  {
    const uint32_t tot = ((*t0 - s_t_prev) << 4) / frames;
    s_t_tot = s_t_tot ? s_t_tot + ((int32_t)(tot - s_t_tot) >> 4) : tot;
  }
  s_t_prev = *t0;
  s_t_have_prev = 1;
}
static inline void telemetry_measure(uint32_t t0, uint32_t frames)
{
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
}
static inline void telemetry_write(float *out, uint32_t frames, float totOffset)
{
  for (uint32_t i = 0; i < frames; ++i) out[i] = 0.f;
  telemetry_tone_mono(out, frames, 0, ${DETECTOR_HZ}.f);
  telemetry_tone_mono(out, frames, 1, ${FX_BASE_HZ}.f + (float)s_t_fx * ${1 / 16 / CYCLES_PER_HZ}f);
  if (s_t_tot)
    telemetry_tone_mono(out, frames, 2, ${TOT_BASE_HZ}.f + ((float)s_t_tot * ${1 / 16}f - totOffset) * ${1 / CYCLES_PER_HZ}f);
}
`

/** Where a LOAD oscillator's tones go (`withNts1OscTelemetry`'s `loadTones`), clear of an
 *  effect's own when both play at once: detector 300 Hz, its cycles at 9000 + c/4, the total at
 *  12000 + (c - 10000)/4. */
export const LOAD_TONES = { detector: 300, fxBase: 9000, totBase: 12000 }

/**
 * NTS-1 mkII oscillator: wraps `unit_render`'s `process` (pitch and Shape LFO set as usual), the
 * tones in place of the voice's output (same decoding as an effect's: `cyclesFromFxTone`,
 * `cyclesFromTotTone`). With `burnRow`, a BURN menu param at that row (the first free one). With
 * `loadTones`, the tones sit at `LOAD_TONES` instead.
 */
export function withNts1OscTelemetry(
  files: Record<string, string>,
  opts: { burnRow?: number; loadTones?: boolean } = {}
): Record<string, string> {
  let headerC = files['header.c']
  let unitCc = files['unit.cc']
  const replace = (from: string, to: string): void => {
    if (!unitCc.includes(from)) throw new Error(`osc telemetry: "${from.trim()}" not found`)
    unitCc = unitCc.replace(from, to)
  }
  if (opts.burnRow !== undefined) {
    const n = Number(/\.num_params = (\d+),/.exec(headerC)![1])
    if (opts.burnRow !== n) throw new Error(`BURN must take the first free row (${n})`)
    const rows = headerC.split('\n')
    const first = rows.findIndex((l) => l.trim().startsWith('{') && l.includes('k_unit_param_type'))
    if (!rows[first + n].includes(EMPTY_ROW)) throw new Error(`row ${n} is not free`)
    rows[first + n] = rows[first + n].replace(
      EMPTY_ROW,
      '{0, 12000, 0, 0, k_unit_param_type_none, 0, 0, 0, {"BURN"}}'
    )
    headerC = rows.join('\n').replace(`.num_params = ${n},`, `.num_params = ${n + 1},`)
    replace(
      '  cached_values[id] = value;\n',
      `  cached_values[id] = value;\n  if (id == ${opts.burnRow}) s_t_burn = value;\n`
    )
  }
  replace(
    'static const unit_runtime_osc_context_t *context;',
    `static const unit_runtime_osc_context_t *context;\n${oscTelemetryDecls}`
  )
  replace(
    '  s_osc_instance.process(in, out, frames);',
    `  uint32_t t0;
  telemetry_start(&t0, frames);
  s_osc_instance.process(in, out, frames);
  telemetry_measure(t0, frames);
  telemetry_write(out, frames, ${TOT_OFFSET}.f);`
  )
  if (opts.loadTones) {
    replace(`frames, 0, ${DETECTOR_HZ}.f)`, `frames, 0, ${LOAD_TONES.detector}.f)`)
    replace(`frames, 1, ${FX_BASE_HZ}.f +`, `frames, 1, ${LOAD_TONES.fxBase}.f +`)
    replace(`frames, 2, ${TOT_BASE_HZ}.f +`, `frames, 2, ${LOAD_TONES.totBase}.f +`)
  }
  return { ...files, 'header.c': headerC, 'unit.cc': unitCc }
}

/**
 * minilogue xd oscillator: wraps `OSC_CYCLE` (called once per voice; every voice runs its own
 * copy, so each reads its own render and the time between its own calls -- the whole main-MCU
 * budget per sample, ~1728). The tones go out as Q31; decode the total with
 * `cyclesFromXdTotTone`. With `burnMax`, the multi engine's Shape knob sets the burn (0..burnMax
 * cycles per sample).
 */
export function withXdOscTelemetry(
  files: Record<string, string>,
  opts: { burnMax?: number } = {}
): Record<string, string> {
  let oscCpp = files['osc.cpp']
  const replace = (from: string, to: string): void => {
    if (!oscCpp.includes(from)) throw new Error(`xd osc telemetry: "${from.trim()}" not found`)
    oscCpp = oscCpp.replace(from, to)
  }
  replace('static Osc s_osc;', `static Osc s_osc;\n${oscTelemetryDecls}\nstatic float s_t_buf[64];`)
  replace(
    '  s_osc.process(yn, frames);',
    `  uint32_t t0;
  telemetry_start(&t0, frames);
  s_osc.process(yn, frames);
  telemetry_measure(t0, frames);
  for (uint32_t done = 0; done < frames; done += 64)
  {
    const uint32_t n = frames - done < 64 ? frames - done : 64;
    telemetry_write(s_t_buf, n, 0.f);
    for (uint32_t i = 0; i < n; ++i) yn[done + i] = f32_to_q31(s_t_buf[i]);
  }`
  )
  if (opts.burnMax !== undefined) {
    replace(
      '  if (index == k_user_osc_param_shape) {',
      `  if (index == k_user_osc_param_shape) s_t_burn = (int32_t)(param_val_to_f32(value) * ${opts.burnMax}.f);
  if (index == k_user_osc_param_shape) {`
    )
  }
  return { ...files, 'osc.cpp': oscCpp }
}

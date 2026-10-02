/**
 * NTS-1 mkII CPU probe (2026-09-28): a hand-written oscillator unit that times its own render
 * callback with the Cortex-M7's DWT cycle counter and shows the result on the device, as the
 * value text of a strings-type param. Answers three questions the SDK doesn't: can a user unit
 * read the cycle counter at all, what clock the NTS-1 mkII really runs (cycles between render
 * calls), and how much the oscillator can burn before audio breaks.
 *
 * Safe to load: the counter is only touched once MODE is turned up, since the debug registers
 * fault if the firmware runs units unprivileged (which would likely freeze the device until it's
 * power-cycled). MODE: "off" (no access), "read" (only reads CYCCNT -- works if the firmware
 * already runs it), "enable" (turns the counter on, then reads).
 *
 * Params: SHPE/ALT (fixed pair), MODE, SHOW (which reading: osc = render cycles per sample,
 * tot = cycles per sample between render calls, i.e. the whole budget, load = osc/tot, peak =
 * highest osc seen since SHOW last moved, MHz = tot x 48 kHz), BURN (0..100, extra work per
 * sample in steps of ~150 cycles). The display text is fetched when the param is shown, so
 * nudge SHOW to refresh it.
 *
 * Usage: npx tsx stageNts1CpuProbe.ts, then in the staged folder:
 *   GCC_BIN_PATH=/opt/homebrew/bin make && GCC_BIN_PATH=/opt/homebrew/bin make install
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const root = join(
  process.env.LOGUE_SDK ?? join(homedir(), 'Documents/GitHub/logue-sdk'),
  'platform',
  'nts-1_mkii'
)
const dir = join(root, 'lp-cpu-probe')
mkdirSync(dir, { recursive: true })

const headerC = `#include "unit_osc.h"

const __unit_header unit_header_t unit_header = {
    .header_size = sizeof(unit_header_t),
    .target = UNIT_TARGET_PLATFORM | k_unit_module_osc,
    .api = UNIT_API_VERSION,
    .dev_id = 0x0U,
    .unit_id = 0x0U,
    .version = 0x00010000U,
    .name = "cpuprobe",
    .num_params = 5,
    .params = {
        {0, 1023, 0, 0, k_unit_param_type_none, 0, 0, 0, {"SHPE"}},
        {0, 1023, 0, 0, k_unit_param_type_none, 0, 0, 0, {"ALT"}},
        {0, 2, 0, 0, k_unit_param_type_strings, 0, 0, 0, {"MODE"}},
        {0, 4, 0, 0, k_unit_param_type_strings, 0, 0, 0, {"SHOW"}},
        {0, 100, 0, 0, k_unit_param_type_none, 0, 0, 0, {"BURN"}},
        {0, 0, 0, 0, k_unit_param_type_none, 0, 0, 0, {""}},
        {0, 0, 0, 0, k_unit_param_type_none, 0, 0, 0, {""}},
        {0, 0, 0, 0, k_unit_param_type_none, 0, 0, 0, {""}},
        {0, 0, 0, 0, k_unit_param_type_none, 0, 0, 0, {""}},
        {0, 0, 0, 0, k_unit_param_type_none, 0, 0, 0, {""}}}};
`

const unitCc = `#include <stdint.h>
#include "unit_osc.h"
#include "osc_api.h"
#include "utils/int_math.h"

// Cortex-M7 core debug registers (ARMv7-M ARM, C1.6 / C1.8).
#define DEMCR (*(volatile uint32_t *)0xE000EDFCu)
#define DWT_CTRL (*(volatile uint32_t *)0xE0001000u)
#define DWT_CYCCNT (*(volatile uint32_t *)0xE0001004u)
#define DWT_LAR (*(volatile uint32_t *)0xE0001FB0u)

static const unit_runtime_osc_context_t *context;
static int32_t cached_values[UNIT_OSC_MAX_PARAM_COUNT];

static int32_t s_mode = 0, s_show = 0, s_burn = 0;
static uint32_t s_enabled = 0;
static uint32_t s_prev_t0 = 0, s_have_prev = 0;
static uint32_t s_osc = 0, s_tot = 0, s_peak = 0; // cycles per sample, x16 fixed point averages
static float s_phase = 0.f, s_acc = 1.f;
static char s_text[16];

static void put_num(char *p, uint32_t v) {
  char tmp[12];
  int n = 0;
  do { tmp[n++] = (char)('0' + v % 10u); v /= 10u; } while (v && n < 11);
  while (n) *p++ = tmp[--n];
  *p = 0;
}

static const char *reading(const char *label, uint32_t v) {
  int i = 0;
  while (label[i]) { s_text[i] = label[i]; ++i; }
  put_num(s_text + i, v);
  return s_text;
}

__unit_callback int8_t unit_init(const unit_runtime_desc_t *desc) {
  if (!desc) return k_unit_err_undef;
  if (desc->target != unit_header.target) return k_unit_err_target;
  if (!UNIT_API_IS_COMPAT(desc->api)) return k_unit_err_api_version;
  if (desc->samplerate != 48000) return k_unit_err_samplerate;
  if (desc->input_channels != 2 || desc->output_channels != 1) return k_unit_err_geometry;
  context = static_cast<const unit_runtime_osc_context_t *>(desc->hooks.runtime_context);
  for (int id = 0; id < UNIT_OSC_MAX_PARAM_COUNT; ++id)
    cached_values[id] = static_cast<int32_t>(unit_header.params[id].init);
  return k_unit_err_none;
}

__unit_callback void unit_teardown() {}
__unit_callback void unit_reset() {}
__unit_callback void unit_resume() {}
__unit_callback void unit_suspend() {}

__unit_callback void unit_render(const float *in, float *out, uint32_t frames) {
  (void)in;
  uint32_t t0 = 0;
  if (s_mode >= 1) {
    if (s_mode == 2 && !s_enabled) {
      DEMCR |= (1u << 24); // TRCENA
      DWT_LAR = 0xC5ACCE55u;
      DWT_CTRL |= 1u; // CYCCNTENA
      s_enabled = 1;
    }
    t0 = DWT_CYCCNT;
    if (s_have_prev && frames) {
      const uint32_t tot = ((t0 - s_prev_t0) << 4) / frames;
      s_tot = s_tot ? s_tot + ((int32_t)(tot - s_tot) >> 4) : tot;
    }
    s_prev_t0 = t0;
    s_have_prev = 1;
  }

  const float w0 = osc_w0f_for_note((context->pitch) >> 8, context->pitch & 0xFF);
  const int32_t iters = s_burn * 50;
  float acc = s_acc;
  for (uint32_t i = 0; i < frames; ++i) {
    for (int32_t k = 0; k < iters; ++k) acc = acc * 0.99999f + 0.00001f;
    out[i] = 0.4f * osc_sinf(s_phase) + acc * 1e-9f;
    s_phase += w0;
    s_phase -= (uint32_t)s_phase;
  }
  s_acc = acc;

  if (s_mode >= 1 && frames) {
    const uint32_t osc = ((DWT_CYCCNT - t0) << 4) / frames;
    s_osc = s_osc ? s_osc + ((int32_t)(osc - s_osc) >> 4) : osc;
    if (osc > s_peak) s_peak = osc;
  }
}

__unit_callback void unit_set_param_value(uint8_t id, int32_t value) {
  value = clipminmaxi32(unit_header.params[id].min, value, unit_header.params[id].max);
  cached_values[id] = value;
  if (id == 2) s_mode = value;
  if (id == 3) { s_show = value; s_peak = 0; }
  if (id == 4) s_burn = value;
}

__unit_callback int32_t unit_get_param_value(uint8_t id) { return cached_values[id]; }

__unit_callback const char *unit_get_param_str_value(uint8_t id, int32_t value) {
  value = clipminmaxi32(unit_header.params[id].min, value, unit_header.params[id].max);
  if (id == 2) {
    static const char *modes[3] = {"off", "read", "enable"};
    return modes[value];
  }
  if (id != 3) return nullptr;
  if (s_mode == 0) return "mode off";
  if (s_tot == 0) return "no cnt";
  switch (value) {
    case 0: return reading("osc ", s_osc >> 4);
    case 1: return reading("tot ", s_tot >> 4);
    case 2: return reading("ld% ", (s_osc * 100u) / s_tot);
    case 3: return reading("pk ", s_peak >> 4);
    default: return reading("MHz ", (uint32_t)(((uint64_t)(s_tot >> 4) * 48000u) / 1000000u));
  }
}

__unit_callback void unit_note_on(uint8_t note, uint8_t velo) { (void)note; (void)velo; }
__unit_callback void unit_note_off(uint8_t note) { (void)note; }
__unit_callback void unit_all_note_off() {}
__unit_callback void unit_pitch_bend(uint16_t bend) { (void)bend; }
__unit_callback void unit_channel_pressure(uint8_t press) { (void)press; }
__unit_callback void unit_aftertouch(uint8_t note, uint8_t press) { (void)note; (void)press; }
`

writeFileSync(join(dir, 'header.c'), headerC)
writeFileSync(join(dir, 'unit.cc'), unitCc)
writeFileSync(
  join(dir, 'config.mk'),
  'PROJECT := cpuprobe\nPROJECT_TYPE := osc\nUCSRC = header.c\nUCXXSRC = unit.cc\nUASMSRC =\nUASMXSRC =\nUINCDIR  =\nULIBDIR =\nULIBS  = -lm\nUDEFS =\n'
)
copyFileSync(join(root, 'dummy-osc', 'Makefile'), join(dir, 'Makefile'))
copyFileSync(join(root, 'dummy-osc', 'wasm.cc'), join(dir, 'wasm.cc'))
console.log(dir)

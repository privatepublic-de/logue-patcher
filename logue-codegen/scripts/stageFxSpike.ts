/**
 * Effect-unit spike (2026-09-29, phase 0 of "effect patches"): hand-written modfx/delfx/revfx
 * units for both platforms, before any codegen exists. Answers what the SDK doesn't say and what
 * the generator design depends on: do they load and pass stereo audio, how much of the xd's
 * 6 KB (modfx) / 12 KB (delfx/revfx) code+data SRAM a bare unit already uses, does SDRAM work
 * (xd: static `.sdram` arrays; NTS-1 mkII: `sdram_alloc`), is SDRAM handed over zeroed, do the
 * NTS-1 mkII's in/out buffers alias, the nominal input level, the MIX knob's raw range, the
 * frames per call, tempo delivery, and (NTS-1 mkII) the effect's cycle budget.
 *
 * Units (the same DSP on both platforms):
 * - modfx "chorus": one SDRAM delay line per channel, LFO rate = TIME, DEPTH = modulation and
 *   wet amount (DEPTH 0 is an exact pass-through). L/R LFOs a quarter cycle apart.
 * - delfx "delay": 10 ms..1.3 s (TIME), feedback up to 0.9 (DEPTH), dry/wet = MIX on NTS-1 mkII,
 *   Shift+DEPTH on the xd.
 * - revfx "pingpong": the delay with the input (summed to mono) fed only into the left line and
 *   the feedback crossed, so echoes alternate L, R, L... (crossing alone does nothing for a mono
 *   source: both lines stay identical).
 * - xd "pass" modfx: copies input to output, the baseline size of the old-gen fx scaffold.
 *
 * NTS-1 mkII diagnostics: MODE (off/read/enable the DWT cycle counter, as in stageNts1CpuProbe)
 * and SHOW, whose value text is a reading: pk (recent input peak x1000, ~1 s decay), fr (frames
 * per render call), fx (render cycles/sample), tot (cycles/sample between calls), sd (non-zero
 * 32-bit words found in the SDRAM block before clearing it), p (last param id:value), al (1 if
 * in == out), bpm (last unit_set_tempo x10). Nudge SHOW to refresh the text.
 *
 * Usage: npx tsx logue-codegen/scripts/stageFxSpike.ts, then in each staged folder:
 *   GCC_BIN_PATH=/opt/homebrew/bin make && GCC_BIN_PATH=/opt/homebrew/bin make install
 */
import { copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

type Fx = 'modfx' | 'delfx' | 'revfx'
type Effect = 'chorus' | 'delay' | 'pingpong' | 'pass'

const platformRoot = join(
  process.env.LOGUE_SDK ?? join(homedir(), 'Documents/GitHub/logue-sdk'),
  'platform'
)

const CHORUS_LINE = 2048
const DELAY_LINE = 65536

/** Plain C++ shared by both platforms: state, init/clear, and a per-frame stereo step. */
function dspCore(effect: Effect): string {
  if (effect === 'pass') {
    return `
static inline void fx_step(float inL, float inR, float *outL, float *outR) { *outL = inL; *outR = inR; }
static void fx_clear(void) {}
`
  }
  if (effect === 'chorus') {
    return `
#define LINE_LEN ${CHORUS_LINE}u
#define LINE_MASK (LINE_LEN - 1u)
static float *s_lineL, *s_lineR;
static uint32_t s_w = 0;
static float s_phase = 0.f;
static float s_time = 0.25f, s_depth = 0.25f;

static void fx_clear(void) {
  for (uint32_t i = 0; i < LINE_LEN; ++i) { s_lineL[i] = 0.f; s_lineR[i] = 0.f; }
  s_w = 0;
}

static inline float line_read(const float *line, float delay) {
  const uint32_t di = (uint32_t)delay;
  const float frac = delay - (float)di;
  const float a = line[(s_w - di) & LINE_MASK];
  const float b = line[(s_w - di - 1u) & LINE_MASK];
  return a + (b - a) * frac;
}

static inline void fx_step(float inL, float inR, float *outL, float *outR) {
  s_lineL[s_w & LINE_MASK] = inL;
  s_lineR[s_w & LINE_MASK] = inR;
  const float rate = (0.05f + 4.95f * s_time * s_time) * (1.f / 48000.f);
  s_phase += rate;
  if (s_phase >= 1.f) s_phase -= 1.f;
  float phR = s_phase + 0.25f;
  if (phR >= 1.f) phR -= 1.f;
  const float swing = s_depth * 384.f;
  const float wetL = line_read(s_lineL, 480.f + swing * fx_sinf(s_phase));
  const float wetR = line_read(s_lineR, 480.f + swing * fx_sinf(phR));
  const float wet = 0.5f * s_depth;
  *outL = inL * (1.f - wet) + wetL * wet;
  *outR = inR * (1.f - wet) + wetR * wet;
  ++s_w;
}
`
  }
  const cross = effect === 'pingpong'
  return `
#define LINE_LEN ${DELAY_LINE}u
#define LINE_MASK (LINE_LEN - 1u)
static float *s_lineL, *s_lineR;
static uint32_t s_w = 0;
static float s_time = 0.25f, s_depth = 0.25f, s_mix = 0.5f;
static float s_delay = 480.f;

static void fx_clear(void) {
  for (uint32_t i = 0; i < LINE_LEN; ++i) { s_lineL[i] = 0.f; s_lineR[i] = 0.f; }
  s_w = 0;
}

static inline float line_read(const float *line, float delay) {
  const uint32_t di = (uint32_t)delay;
  const float frac = delay - (float)di;
  const float a = line[(s_w - di) & LINE_MASK];
  const float b = line[(s_w - di - 1u) & LINE_MASK];
  return a + (b - a) * frac;
}

static inline float clamp2(float x) { return x > 2.f ? 2.f : (x < -2.f ? -2.f : x); }

static inline void fx_step(float inL, float inR, float *outL, float *outR) {
  const float target = 480.f + s_time * s_time * 61520.f;
  s_delay += (target - s_delay) * 0.0005f;
  const float wetL = line_read(s_lineL, s_delay);
  const float wetR = line_read(s_lineR, s_delay);
  const float fb = 0.9f * s_depth;
${
  cross
    ? `  s_lineL[s_w & LINE_MASK] = clamp2(0.5f * (inL + inR) + fb * wetR);
  s_lineR[s_w & LINE_MASK] = clamp2(fb * wetL);`
    : `  s_lineL[s_w & LINE_MASK] = clamp2(inL + fb * wetL);
  s_lineR[s_w & LINE_MASK] = clamp2(inR + fb * wetR);`
}
  *outL = inL * (1.f - s_mix) + wetL * s_mix;
  *outR = inR * (1.f - s_mix) + wetR * s_mix;
  ++s_w;
}
`
}

const LINE_FLOATS: Record<Effect, number> = {
  pass: 0,
  chorus: 2 * CHORUS_LINE,
  delay: 2 * DELAY_LINE,
  pingpong: 2 * DELAY_LINE
}

// ---------------------------------------------------------------------------------------------
// NTS-1 mkII

function nts1HeaderC(module: Fx, name: string): string {
  const param = (p: string): string => `        ${p},\n`
  const empty = '{0, 0, 0, 0, k_unit_param_type_none, 0, 0, 0, {""}}'
  const rows = [
    '{0, 1023, 0, 256, k_unit_param_type_none, 1, 0, 0, {"TIME"}}',
    '{0, 1023, 0, 256, k_unit_param_type_none, 1, 0, 0, {"DPTH"}}',
    ...(module === 'modfx'
      ? []
      : ['{-1000, 1000, 0, 0, k_unit_param_type_drywet, 1, 1, 0, {"MIX"}}']),
    '{0, 2, 0, 0, k_unit_param_type_strings, 0, 0, 0, {"MODE"}}',
    '{0, 7, 0, 0, k_unit_param_type_strings, 0, 0, 0, {"SHOW"}}'
  ]
  const numParams = rows.length
  while (rows.length < 11) rows.push(empty)
  return `#include "unit_${module}.h"

const __unit_header unit_header_t unit_header = {
    .header_size = sizeof(unit_header_t),
    .target = UNIT_TARGET_PLATFORM | k_unit_module_${module},
    .api = UNIT_API_VERSION,
    .dev_id = 0x0U,
    .unit_id = 0x0U,
    .version = 0x00010000U,
    .name = "${name}",
    .num_params = ${numParams},
    .params = {
${rows.map(param).join('').replace(/,\n$/, '')}}};
`
}

function nts1UnitCc(module: Fx, effect: Effect): string {
  const hasMix = module !== 'modfx'
  const modeId = hasMix ? 3 : 2
  const showId = modeId + 1
  const lineFloats = LINE_FLOATS[effect]
  return `#include <stdint.h>
#include "unit_${module}.h"
#include "utils/int_math.h"

#define DEMCR (*(volatile uint32_t *)0xE000EDFCu)
#define DWT_CTRL (*(volatile uint32_t *)0xE0001000u)
#define DWT_CYCCNT (*(volatile uint32_t *)0xE0001004u)
#define DWT_LAR (*(volatile uint32_t *)0xE0001FB0u)
${dspCore(effect)}
static int32_t cached_values[UNIT_MAX_PARAM_COUNT];
static int32_t s_mode = 0;
static uint32_t s_enabled = 0, s_prev_t0 = 0, s_have_prev = 0;
static uint32_t s_fx = 0, s_tot = 0, s_frames = 0, s_alias = 0, s_sdram_dirty = 0;
static uint32_t s_bpm10 = 0, s_last_id = 0;
static int32_t s_last_value = 0;
static float s_peak = 0.f;
static char s_text[16];

static void put_num(char *p, int32_t sv) {
  if (sv < 0) { *p++ = '-'; sv = -sv; }
  uint32_t v = (uint32_t)sv;
  char tmp[12];
  int n = 0;
  do { tmp[n++] = (char)('0' + v % 10u); v /= 10u; } while (v && n < 11);
  while (n) *p++ = tmp[--n];
  *p = 0;
}

static const char *reading(const char *label, int32_t v) {
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
  if (desc->input_channels != 2 || desc->output_channels != 2) return k_unit_err_geometry;
${
  lineFloats === 0
    ? ''
    : `  if (!desc->hooks.sdram_alloc) return k_unit_err_memory;
  float *mem = (float *)desc->hooks.sdram_alloc(${lineFloats}u * sizeof(float));
  if (!mem) return k_unit_err_memory;
  const uint32_t *words = (const uint32_t *)mem;
  for (uint32_t i = 0; i < ${lineFloats}u; ++i) s_sdram_dirty += words[i] != 0u;
  s_lineL = mem;
  s_lineR = mem + ${lineFloats / 2}u;
  fx_clear();
`
}  for (int id = 0; id < UNIT_MAX_PARAM_COUNT; ++id)
    cached_values[id] = static_cast<int32_t>(unit_header.params[id].init);
  return k_unit_err_none;
}

__unit_callback void unit_teardown() {}
__unit_callback void unit_reset() { fx_clear(); }
__unit_callback void unit_resume() {}
__unit_callback void unit_suspend() {}

__unit_callback void unit_render(const float *in, float *out, uint32_t frames) {
  uint32_t t0 = 0;
  if (s_mode >= 1) {
    if (s_mode == 2 && !s_enabled) {
      DEMCR |= (1u << 24);
      DWT_LAR = 0xC5ACCE55u;
      DWT_CTRL |= 1u;
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
  s_frames = frames;
  s_alias = (const void *)in == (const void *)out;
  // A decaying hold (~1 s at 64 frames per call), since the text is only read when SHOW moves.
  s_peak *= 0.999f;

  for (uint32_t i = 0; i < frames; ++i) {
    // Read both channels first: in and out may be the same buffer.
    const float inL = in[2 * i], inR = in[2 * i + 1];
    const float a = si_fabsf(inL), b = si_fabsf(inR);
    if (a > s_peak) s_peak = a;
    if (b > s_peak) s_peak = b;
    float outL, outR;
    fx_step(inL, inR, &outL, &outR);
    out[2 * i] = outL;
    out[2 * i + 1] = outR;
  }

  if (s_mode >= 1 && frames) {
    const uint32_t fx = ((DWT_CYCCNT - t0) << 4) / frames;
    s_fx = s_fx ? s_fx + ((int32_t)(fx - s_fx) >> 4) : fx;
  }
}

__unit_callback void unit_set_param_value(uint8_t id, int32_t value) {
  value = clipminmaxi32(unit_header.params[id].min, value, unit_header.params[id].max);
  cached_values[id] = value;
  // Not MODE/SHOW: moving SHOW to "p" would otherwise always report SHOW itself.
  if (id < ${modeId}) {
    s_last_id = id;
    s_last_value = value;
  }
  switch (id) {
${
  effect === 'pass'
    ? ''
    : `    case 0: s_time = param_10bit_to_f32(value); break;
    case 1: s_depth = param_10bit_to_f32(value); break;
`
}${hasMix && effect !== 'pass' ? '    case 2: s_mix = (value + 1000) * (1.f / 2000.f); break;\n' : ''}    case ${modeId}: s_mode = value; break;
    default: break;
  }
}

__unit_callback int32_t unit_get_param_value(uint8_t id) { return cached_values[id]; }

__unit_callback const char *unit_get_param_str_value(uint8_t id, int32_t value) {
  value = clipminmaxi32(unit_header.params[id].min, value, unit_header.params[id].max);
  if (id == ${modeId}) {
    static const char *modes[3] = {"off", "read", "enable"};
    return modes[value];
  }
  if (id != ${showId}) return nullptr;
  switch (value) {
    case 0: return reading("pk ", (int32_t)(s_peak * 1000.f));
    case 1: return reading("fr ", (int32_t)s_frames);
    case 2: return s_mode ? reading("fx ", (int32_t)(s_fx >> 4)) : "mode off";
    case 3: return s_mode ? reading("tot ", (int32_t)(s_tot >> 4)) : "mode off";
    case 4: return reading("sd ", (int32_t)s_sdram_dirty);
    case 5: {
      reading("p", (int32_t)s_last_id);
      int i = 0;
      while (s_text[i]) ++i;
      s_text[i++] = ':';
      put_num(s_text + i, s_last_value);
      return s_text;
    }
    case 6: return reading("al ", (int32_t)s_alias);
    default: return reading("bpm ", (int32_t)s_bpm10);
  }
}

__unit_callback void unit_set_tempo(uint32_t tempo) {
  s_bpm10 = ((tempo >> 16) * 10u) + (((tempo & 0xFFFFu) * 10u) >> 16);
}
__unit_callback void unit_tempo_4ppqn_tick(uint32_t counter) { (void)counter; }
`
}

function stageNts1(module: Fx, effect: Effect, name: string): string {
  const root = join(platformRoot, 'nts-1_mkii')
  const dir = join(root, `lp-fxspike-${effect}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const template = join(root, `dummy-${module}`)
  writeFileSync(join(dir, 'header.c'), nts1HeaderC(module, name))
  writeFileSync(join(dir, 'unit.cc'), nts1UnitCc(module, effect))
  writeFileSync(
    join(dir, 'config.mk'),
    `PROJECT := lp_${effect}\nPROJECT_TYPE := ${module}\nUCSRC = header.c\nUCXXSRC = unit.cc\nUASMSRC =\nUASMXSRC =\nUINCDIR  =\nULIBDIR =\nULIBS  = -lm\nUDEFS =\n`
  )
  copyFileSync(join(template, 'Makefile'), join(dir, 'Makefile'))
  copyFileSync(join(template, 'wasm.cc'), join(dir, 'wasm.cc'))
  return dir
}

// ---------------------------------------------------------------------------------------------
// minilogue xd

function xdFxCpp(module: Fx, effect: Effect): string {
  const upper = module.toUpperCase()
  const lineFloats = LINE_FLOATS[effect]
  const sdram =
    lineFloats === 0
      ? ''
      : `// NOLOAD section: not zeroed by the loader, so fx_clear() runs in init and resume.
static float s_sdram[${lineFloats}] __sdram;
`
  const bind =
    lineFloats === 0 ? '' : `  s_lineL = s_sdram;\n  s_lineR = s_sdram + ${lineFloats / 2};\n`
  const loop = `  for (uint32_t i = 0; i < frames; ++i) {
    const float inL = XN[2 * i], inR = XN[2 * i + 1];
    float outL, outR;
    fx_step(inL, inR, &outL, &outR);
    YN[2 * i] = outL;
    YN[2 * i + 1] = outR;
  }`
  const process =
    module === 'modfx'
      ? `void MODFX_PROCESS(const float *main_xn, float *main_yn, const float *sub_xn, float *sub_yn, uint32_t frames) {
${loop.replace(/XN/g, 'main_xn').replace(/YN/g, 'main_yn')}
  // prologue's second timbre; the xd has none, but never leave an output buffer unwritten.
  if (sub_xn && sub_yn)
    for (uint32_t i = 0; i < 2 * frames; ++i) sub_yn[i] = sub_xn[i];
}`
      : `void ${upper}_PROCESS(float *xn, uint32_t frames) {
${loop.replace(/XN/g, 'xn').replace(/YN/g, 'xn')}
}`
  const params =
    effect === 'pass'
      ? '  (void)index; (void)value;\n'
      : `  // Q31 (0..2^31-1, 10 bits of it real), not 0..1023: reading it as 0..1023 jumped from off
  // to full at the knob's first step (user, 2026-09-30).
  const float v = clip01f(q31_to_f32(value));
  switch (index) {
    case 0: s_time = v; break;
    case 1: s_depth = v; break;
${module === 'modfx' ? '' : '    case 3: s_mix = v; break;\n'}    default: break;
  }
`
  return `#include "user${module}.h"
${dspCore(effect)}
${sdram}
void ${upper}_INIT(uint32_t platform, uint32_t api) {
  (void)platform; (void)api;
${bind}  fx_clear();
}

${process}

void ${upper}_SUSPEND(void) {}

void ${upper}_RESUME(void) { fx_clear(); }

void ${upper}_PARAM(uint8_t index, int32_t value) {
${params}}
`
}

function stageXd(module: Fx, effect: Effect, name: string): string {
  const root = join(platformRoot, 'minilogue-xd')
  const dir = join(root, `lp-fxspike-${effect}`)
  rmSync(dir, { recursive: true, force: true })
  cpSync(join(root, `dummy-${module}`), dir, { recursive: true })
  rmSync(join(dir, 'README.md'), { force: true })
  writeFileSync(join(dir, 'fx.cpp'), xdFxCpp(module, effect))
  writeFileSync(
    join(dir, 'project.mk'),
    `PROJECT = lp_${effect}\nUCSRC =\nUCXXSRC = fx.cpp\nUINCDIR =\nUDEFS =\nULIB =\nULIBDIR =\n`
  )
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        header: {
          platform: 'minilogue-xd',
          module,
          api: '1.1-0',
          dev_id: 0,
          prg_id: 0,
          version: '1.0-0',
          name,
          num_param: 0
        }
      },
      null,
      2
    ) + '\n'
  )
  return dir
}

const staged = [
  stageNts1('modfx', 'chorus', 'LP Chorus'),
  stageNts1('delfx', 'delay', 'LP Delay'),
  stageNts1('revfx', 'pingpong', 'LP PingPong'),
  stageXd('modfx', 'pass', 'lp pass'),
  stageXd('modfx', 'chorus', 'lp chorus'),
  stageXd('delfx', 'delay', 'lp delay'),
  stageXd('revfx', 'pingpong', 'lp pingpong')
]
for (const dir of staged) console.log(dir)

// Contains code from Korg's logue SDK, Copyright (c) 2018, KORG INC., under the BSD 3-Clause
// License -- full text in THIRD_PARTY_NOTICES.md at the repository root.
// Portable host-native stand-in for minilogue xd's real userosc.h -- ONLY the symbols the
// generated osc.cpp actually references. clip1m1f/f32_to_q31 are copied VERBATIM from the
// real SDK headers (utils/float_math.h, utils/fixed_math.h). osc_w0f_for_note is a
// deliberately SIMPLIFIED equal-tempered approximation, not the real LUT-based implementation
// (the real note->Hz lookup table is baked into KORG's flashed firmware binary, referenced only
// via a linker symbol file (osc_api.syms) -- not present as C source anywhere in the SDK to
// copy verbatim). Good enough to produce a sane, non-zero pitch for this harness's purpose
// (does the render loop/param handling behave correctly), not to bit-exactly match hardware.
#pragma once
#include <cstdint>
#include <cmath>

typedef int32_t q31_t;

typedef struct user_osc_param {
  int32_t  shape_lfo;
  uint16_t pitch;
  uint16_t cutoff;
  uint16_t resonance;
  uint16_t reserved0[3];
} user_osc_param_t;

typedef enum {
  k_user_osc_param_id1 = 0,
  k_user_osc_param_id2,
  k_user_osc_param_id3,
  k_user_osc_param_id4,
  k_user_osc_param_id5,
  k_user_osc_param_id6,
  k_user_osc_param_shape,
  k_user_osc_param_shiftshape,
  k_num_user_osc_param_id
} user_osc_param_id_t;

// Copied verbatim from the real SDK's userosc.h.
#define param_val_to_f32(val) ((uint16_t)val * 9.77517106549365e-004f)

static inline float clip1m1f(const float x) {
  return ((x) > 1.f) ? 1.f : ((x) < -1.f) ? -1.f : (x);
}

#define f32_to_q31(f) ((q31_t)((float)(f) * (float)0x7FFFFFFF))
#define q31_to_f32(q) ((float)(q) * 4.65661287307739e-010f)

// mod interpolates in Hz between `note` and `note+1` (matches the real SDK's own documented
// semantics for this function) -- found necessary,
// not just a nicety, when verifying a FRACTIONAL semitone offset (e.g. logue/util/constant
// wired into an oscillator's own pitch inlet at a non-whole-semitone VALUE): the earlier
// `(void)mod` version silently truncated to whole semitones, which read as a real ~1-semitone
// pitch-tracking bug until traced back to this stand-in, not the generated code under test.
static inline float osc_w0f_for_note(uint8_t note, uint8_t mod) {
  const float hzLo = 440.f * powf(2.f, (static_cast<float>(note) - 69.f) / 12.f);
  const float hzHi = 440.f * powf(2.f, (static_cast<float>(note) + 1.f - 69.f) / 12.f);
  const float t = static_cast<float>(mod) / 255.f;
  return (hzLo + (hzHi - hzLo) * t) / 48000.f;
}

// A deliberately SIMPLIFIED plain sinf(2*pi*x) approximation, not the real LUT-based
// implementation (osc_api.h's own wt_sine_lut_f table has no C source anywhere in the SDK to
// copy verbatim -- same reasoning as osc_w0f_for_note above). Good enough to confirm a sine
// primitive's real output shape/range in this harness, not to bit-exactly match hardware.
static inline float osc_sinf(float x) {
  return sinf(x * 6.283185307179586f);
}

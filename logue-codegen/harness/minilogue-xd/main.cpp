// Contains code from Korg's logue SDK, Copyright (c) 2018, KORG INC., under the BSD 3-Clause
// License -- full text in THIRD_PARTY_NOTICES.md at the repository root.
// Host-native harness for a REAL generated minilogue xd osc.cpp -- found the real f32_to_q31
// overflow UB this way (2026-09-16), matching this project's general native-harness debugging
// convention (CLAUDE.md). Actually RUNS the exact
// generated code against portable stand-ins for the few userosc.h symbols it needs (userosc.h
// in this directory -- clip1m1f/f32_to_q31/q31_to_f32 copied VERBATIM from the real SDK headers,
// osc_w0f_for_note a deliberate simplified approximation since the real note->Hz LUT is baked
// into KORG's firmware binary with no C source anywhere to copy), instead of reasoning about
// behavior from reading alone.
//
// Usage: copy the project you're debugging's generated osc.cpp into this directory as
// osc_real.cpp (NOT committed -- it's a snapshot of generated output, not source), then:
//   c++ -std=c++17 -Wall -Wextra -fsanitize=address,undefined -I. main.cpp -o harness && ./harness
// Adjust main()'s OSC_PARAM(0, ...) calls/param count if the unit you're debugging exposes a
// different param shape than this file's original single-WIDTH-param pulse oscillator.
#include <cstdio>
#include <cstring>
#include <initializer_list>
#include "osc_real.cpp"

static void render(user_osc_param_t &params, int32_t *out, uint32_t frames) {
  OSC_CYCLE(&params, out, frames);
}

static void report(const char *label, int32_t *buf, uint32_t n) {
  int32_t minV = buf[0], maxV = buf[0];
  uint32_t highCount = 0;
  for (uint32_t i = 0; i < n; i++) {
    if (buf[i] < minV) minV = buf[i];
    if (buf[i] > maxV) maxV = buf[i];
    if (buf[i] > 0) highCount++;
  }
  float minF = q31_to_f32(minV);
  float maxF = q31_to_f32(maxV);
  printf("%-28s min=%+.4f max=%+.4f highFrac=%.3f  first16=[", label, minF, maxF,
         (float)highCount / (float)n);
  for (uint32_t i = 0; i < 16 && i < n; i++) printf("%+.3f ", q31_to_f32(buf[i]));
  printf("]\n");
}

int main() {
  user_osc_param_t params;
  memset(&params, 0, sizeof(params));
  params.pitch = (69 << 8); // A4, matches OSC_CYCLE's (pitch>>8, pitch&0xFF) decode

  const uint32_t FRAMES = 4096;
  int32_t buf[FRAMES];

  OSC_INIT(0, 0);

  // 1. Straight after OSC_INIT, no OSC_PARAM call yet -- exercises the init()-seeded default
  //    (duty = 50 * 0.01f = 0.5) with NOTHING param-related touched at all.
  render(params, buf, FRAMES);
  report("after OSC_INIT only", buf, FRAMES);

  // 2. Explicit OSC_PARAM pushes across the full declared [0,100] range.
  for (uint16_t v : {(uint16_t)0, (uint16_t)25, (uint16_t)50, (uint16_t)75, (uint16_t)100}) {
    OSC_PARAM(0, v);
    render(params, buf, FRAMES);
    char label[32];
    snprintf(label, sizeof(label), "OSC_PARAM(0, %u)", v);
    report(label, buf, FRAMES);
  }

  // 3. Out-of-declared-range pushes (what a raw, unclamped ADC/ANY value might look like) --
  //    confirms whether the OSC_PARAM-side clamp (added in the last fix) is actually reached
  //    and effective.
  for (uint16_t v : {(uint16_t)512, (uint16_t)1023}) {
    OSC_PARAM(0, v);
    render(params, buf, FRAMES);
    char label[32];
    snprintf(label, sizeof(label), "OSC_PARAM(0, %u) [OOR]", v);
    report(label, buf, FRAMES);
  }

  return 0;
}

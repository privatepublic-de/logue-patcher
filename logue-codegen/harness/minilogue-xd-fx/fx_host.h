// Contains code from Korg's logue SDK, Copyright (c) 2018, KORG INC., under the BSD 3-Clause
// License -- full text in THIRD_PARTY_NOTICES.md at the repository root.
// Portable stand-ins for what a generated minilogue xd effect's fx.cpp reads from the SDK
// (user*fx.h -> fx_api.h/fixed_math.h, whose cortexm4.h intrinsics don't build on a host), for
// a host build under ASan/UBSan. The SDK's own utils/float_math.h is plain C and is used as it is.
#pragma once
#include <stdint.h>
#include <math.h>
#include "float_math.h"

typedef int32_t q31_t;
// fixed_math.h's own definition.
#define q31_to_f32(q) ((float)(q) * 4.65661287307739e-010f)

// The linker section only matters on the device; the harness driver fills the array with NaNs.
#define __sdram

// fx_api.h's fx_sinf walks the device's sine LUT; the exact sine is close enough here.
static inline float fx_sinf(float x) { return sinf(6.283185307179586f * (x - (float)(uint32_t)x)); }

// Set by the harness driver; the device's _fx_get_bpmf reads the current tempo.
extern float g_bpm;
static inline float fx_get_bpmf(void) { return g_bpm; }

// Contains code from Korg's logue SDK, Copyright (c) 2018, KORG INC., under the BSD 3-Clause
// License -- full text in THIRD_PARTY_NOTICES.md at the repository root.
// Portable stand-ins for what a generated NTS-1 mkII effect's fx.h reads from the SDK
// (unit_*fx.h -> unit.h/fx_api.h/macros.h), for a host build under ASan/UBSan. The SDK's own
// processor.h and utils/float_math.h are plain C++ and are used as they are (-I common/).
#pragma once
#include <stdint.h>
#include <math.h>
#include "utils/float_math.h"

#define param_10bit_to_f32(val) ((uint16_t)(val) * 9.77517106549365e-004f)

// fx_api.h's fx_sinf walks a 128-entry half-wave LUT the device provides; the exact sine is
// close enough for behaviour checks.
static inline float fx_sinf(float x) { return sinf(6.283185307179586f * (x - (float)(uint32_t)x)); }

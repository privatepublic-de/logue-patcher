// Host stand-in for CMSIS's arm_math.h, found by the minilogue xd SDK's own utils/cortexm4.h so
// that a generated osc.cpp can be built on the host against the SDK's UNMODIFIED userosc.h /
// osc_api.h (logue-codegen/scripts/hwtest/hostRender.ts). fixed_math.h's inline Q15/Q31 helpers
// name these intrinsics; generated oscillator code never calls them (it computes in float and
// converts once with f32_to_q31), so they only need to compile -- each one aborts if it is ever
// reached, rather than emulating the Cortex-M4's GE flags wrongly.
#pragma once
#include <stdint.h>
#include <stdlib.h>

#define __SIMD32_TYPE int32_t
static inline int32_t __hwtest_unreachable(void) { abort(); }
#define __SSAT(x, bits) ((void)(x), (void)(bits), __hwtest_unreachable())
#define __QADD16(a, b) ((void)(a), (void)(b), __hwtest_unreachable())
#define __QSUB16(a, b) ((void)(a), (void)(b), __hwtest_unreachable())
#define __SEL(a, b) ((void)(a), (void)(b), __hwtest_unreachable())
#define __QADD(a, b) ((void)(a), (void)(b), __hwtest_unreachable())
#define __QSUB(a, b) ((void)(a), (void)(b), __hwtest_unreachable())

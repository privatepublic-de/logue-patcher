// Embeds parts of Korg's logue SDK (the xd's tpl/_unit.c, ld/*.ld and Makefile), Copyright (c)
// 2018, KORG INC., under the BSD 3-Clause License -- full text in THIRD_PARTY_NOTICES.md.
import type { PatchDocument } from '../../../src/shared/domain/patch'
import { UnsupportedLogueNodeError } from '../oscInstances'
import type { SubpatchDefinitions } from '../subpatches'
import { InvalidLogueParamError, type ExposedParamBinding } from '../oscParams'
import { resolveUnit } from '../resolveUnit'
import { buildOscBodyPieces } from '../oscBody'
import { isEffectModule, requireUnitKind } from '../unitKinds'

/**
 * `PatchDocument` -> buildable minilogue xd oscillator unit source. Graph validation and param
 * binding are shared with `nts1mkii/generateOscUnit.ts` (`../oscInstances.ts`/`../oscParams.ts`/
 * `../oscBody.ts`), and primitive DSP is plain float on both platforms (see `../primitives.ts`),
 * so this file only emits the old-gen outer shell: `userosc.h`'s plain struct plus free
 * `OSC_INIT`/`OSC_CYCLE`/`OSC_PARAM` functions, the one `f32_to_q31()` cast at the output write,
 * and a `manifest.json` instead of a `unit_header_t`.
 *
 * Manifest param ranges must stay within about +-100: Korg Librarian rejected a unit declaring
 * `0..1023` ("Could not parse user unit manifest data"), and every row in Korg's own `waves.json`
 * stays in that range. So no primitive uses new-gen's 0-1023 knob convention and no
 * `param_10bit_to_f32`/`param_val_to_f32` alias is needed; add one only if a primitive really
 * needs 10-bit resolution on the xd. History: docs/HISTORY.md.
 */

export interface LogueOldGenOscUnitMeta {
  /** manifest.json's `header.name` -- displayed on-device. */
  name: string
  /** Local-test placeholder unless a real developer_ids.md registration exists. */
  devId?: number
  prgId?: number
}

export interface LogueOldGenOscUnitSource {
  manifestJson: string
  projectMk: string
  /** The single `<name>.cpp` -- old-gen's real reference examples split `Waves`'s class into a
   * separate `.hpp`, but nothing in the build requires that split, so this stays one file. */
  oscCpp: string
  /** Fixed per-project scaffold, embedded (not read from a live logue-sdk checkout) so an
   * export is self-contained and buildable on its own -- confirmed byte-identical across the
   * real `dummy-osc`/`waves` reference examples (`diff`'d directly, 2026-09-16), so there is
   * exactly one real version of each to embed, not a guess at "the" template. */
  makefile: string
  unitC: string
  rulesLd: string
  useroscLd: string
  oscApiSyms: string
}

export class InvalidLogueUnitNameError extends Error {}

/** `k_user_osc_param_id1..id6` (`platform/minilogue-xd/inc/userosc.h`) -- a real, confirmed 6-slot limit for a minilogue xd oscillator's custom params (0-indexed, matching `logueParamIndex` directly). */
const MINILOGUE_XD_OSC = requireUnitKind('minilogue-xd', 'osc')

export function validateNoBreakingChars(value: string, label: string): void {
  if (value.includes('"') || value.includes('\n')) {
    throw new InvalidLogueUnitNameError(
      `${label} "${value}" contains a character that would break the generated JSON/C++ (" or a newline).`
    )
  }
}

/**
 * Unlike NTS-1 mkII's `k_unit_param_type_none` sentinel (a real, documented "this slot is
 * unused" row), minilogue xd's `manifest.json` has no confirmed equivalent -- every real
 * example (`dummy-osc`/`waves`) declares exactly as many `params` entries as `num_param`, none
 * padded. Rather than invent an unverified placeholder-row shape, this platform simply
 * requires exposed indices to be contiguous from 0 -- a real, disclosed platform difference
 * from NTS-1 mkII's "gaps are fine" rule, not a shortcut.
 */
function requireContiguousIndices(exposedParams: Map<number, ExposedParamBinding>): void {
  const indices = Array.from(exposedParams.keys()).sort((a, b) => a - b)
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] !== i) {
      throw new InvalidLogueParamError(
        `minilogue xd's manifest.json has no confirmed "unused slot" row (unlike NTS-1 mkII) -- exposed logueParamIndex values must be contiguous starting at 0. Got: [${indices.join(', ')}].`
      )
    }
  }
}

function generateManifestJson(
  meta: LogueOldGenOscUnitMeta,
  exposedParams: Map<number, ExposedParamBinding>
): string {
  // See `resolveMinilogueXdDeviceParam`'s own doc comment (`@logue-codegen/paramDeviceType`)
  // for why the device range/type can differ from the param's own spec.
  const rows = Array.from(exposedParams.values())
    .sort((a, b) => a.index - b.index)
    .map((b) => [b.paramName, b.device.min, b.device.max, b.device.type])

  const manifest = {
    header: {
      platform: 'minilogue-xd',
      module: 'osc',
      api: '1.1-0',
      dev_id: meta.devId ?? 0,
      prg_id: meta.prgId ?? 0,
      version: '1.0-0',
      name: meta.name,
      num_param: rows.length,
      params: rows
    }
  }
  return JSON.stringify(manifest, null, 4) + '\n'
}

function generateProjectMk(): string {
  return `# Generated by logue-patcher's logue-codegen.
# NOT hand-written -- do not edit directly, re-export instead.

PROJECT = osc

UCSRC =

UCXXSRC = osc.cpp

UINCDIR =

UDEFS =

ULIB =

ULIBDIR =
`
}

/**
 * Old-gen's real firmware does NOT pre-clamp the raw `value` `OSC_PARAM` receives to the
 * manifest's own declared `[min,max]` -- confirmed indirectly but concretely by the real
 * `waves.cpp` reference example, whose `k_user_osc_param_id1`/`id2` handlers apply a defensive
 * `value % cnt` before use (pointless if the incoming value were already guaranteed in range).
 * Found via a real hardware bug (2026-09-16): a pulse oscillator's WIDTH param, declared
 * `0-100`, received an unclamped raw value far outside that range at the physical A/B knob
 * slot, producing `duty` wildly outside [0,1] -- audible as a constant-DC or brief-spark
 * output, not a variable pulse. New-gen's OWN equivalent forwarding function
 * (`unit_set_param_value`, `nts1mkii/generateOscUnit.ts`) already clamps for exactly this
 * reason; old-gen's generated `OSC_PARAM` previously didn't, which this fixes.
 *
 * A negative-range param (`-100..100 "%"`, e.g. `util/constant`'s `VALUE`) arrives offset, not
 * signed: Korg's own `userosc.h` says "0-200 for bipolar percent parameters. 0% at 100, -100% at
 * 0", so its case subtracts 100 before clamping both ends. Reading it as signed (an earlier
 * guess from NTS-1 mk1 community docs) was a real xd bug (2026-09-27): a depth constant showing
 * 0 on the device arrived as +100%; the offset is confirmed on a real xd for +-100. The header
 * only states the +-100 case; COARSE (+-24) and FINE (+-50) get the same offset, unconfirmed on
 * hardware.
 *
 * The clamp runs in the DEVICE range (`DeviceParam`); `setParameter`'s case then applies `scale`
 * back into the param's own spec domain, e.g. a `mux2` SELECT shown as 1/2 arrives as 0/1 and is
 * stored as 0/100.
 */
function generateOscParamClamp(exposedParams: Map<number, ExposedParamBinding>): string {
  if (exposedParams.size === 0) return ''
  const cases = Array.from(exposedParams.values())
    .sort((a, b) => a.index - b.index)
    .map((b) => {
      const { min, max } = b.device
      return `  case ${b.index}: ${min < 0 ? 'v -= 100; ' : ''}if (v < ${min}) v = ${min}; else if (v > ${max}) v = ${max}; break;\n`
    })
    .join('')
  return `  int32_t v = (int32_t)value;\n  switch (index)\n  {\n${cases}  default: break;\n  }\n`
}

function generateOscCpp(
  pieces: ReturnType<typeof buildOscBodyPieces>,
  exposedParams: Map<number, ExposedParamBinding>
): string {
  const setParameterBody = !pieces.hasExposedParams
    ? '    (void)index;\n    (void)value;\n'
    : '    switch (index)\n    {\n' + pieces.setParameterCases + '    default: break;\n    }\n'
  const oscParamClamp = generateOscParamClamp(exposedParams)

  return `// Generated by logue-patcher's logue-codegen.
// NOT hand-written -- do not edit directly, re-export instead.
#include "userosc.h"

class Osc
{
public:
  void init()
  {
    note_ = 0.f;
    noteFine_ = 0.f;
    note01_ = 0.f;
    cutoff01_ = 0.f;
    resonance01_ = 0.f;
    shapeParam01_ = 0.f;
    shape01_ = 0.f;
    shape2_01_ = 0.f;
${pieces.stateInits}${pieces.paramDefaultInits}${pieces.knobInits}  }

  // No longer precomputes a
  // single shared w0 here; each oscillator instance now derives its OWN transposed phase
  // increment from note_/noteFine_ (see primitives.ts's note_w0 helper), so this just stashes
  // the raw decoded bytes.
  void setPitch(uint8_t note, uint8_t fine)
  {
    note_ = (float)note;
    noteFine_ = (float)fine;
  }

  void setSenseInputs(float note01, float cutoff01, float resonance01)
  {
    note01_ = note01;
    cutoff01_ = cutoff01;
    resonance01_ = resonance01;
  }

  /** The static SHAPE knob position, arriving via OSC_PARAM (see its own doc comment below). */
  void setShapeParam(float v) { shapeParam01_ = v; }
  /** The device's second fixed knob (logue/sense/shape-2) has no LFO-modulation path on real
      hardware -- arrives via OSC_PARAM only. */
  void setShape2Sense(float v) { shape2_01_ = v; }

  /**
   * The real device's own Mod section can target SHAPE (user_osc_param_t.shape_lfo, "value of
   * LFO implicitely applied to shape parameter" per the real SDK header) -- a per-block value
   * that arrives through OSC_CYCLE, NOT OSC_PARAM, and previously wasn't read anywhere in this
   * generator at all, so logue/sense/shape silently ignored it (real user report: a param wired
   * from sense/shape didn't move when the device's own LFO was set to modulate shape). Combined
   * additively with the static knob position and clamped to this registry's own unipolar 0..1
   * sense domain -- confirmed against the real waves.cpp reference example's own p.shape + lfoz
   * combination. Applied once per BLOCK (matching
   * cutoff01_/resonance01_'s own per-block granularity), not interpolated per-sample the way the
   * reference's lfoz ramp is -- a disclosed simplification, not a claim of sample-accurate
   * tracking.
   */
  void updateShapeSense(float shapeLfo01)
  {
    const float sum = shapeParam01_ + shapeLfo01;
    shape01_ = (sum < 0.f) ? 0.f : (sum > 1.f) ? 1.f : sum;
  }

  void noteOn()
  {
${pieces.noteOnStatements}  }

  void noteOff()
  {
${pieces.noteOffStatements}  }

  void setParameter(uint16_t index, int32_t value)
  {
${setParameterBody}  }

  void process(int32_t *yn, uint32_t frames)
  {
${pieces.blockStatements}    for (uint32_t i = 0; i < frames; ++i)
    {
${pieces.computeStatements}      // \`* 0.999f\` (not just clip1m1f alone) -- found via a real host-native ASan/UBSan
      // harness run (2026-09-16): f32_to_q31's real formula, (q31_t)(f * (float)0x7FFFFFFF),
      // overflows int32_t whenever f is exactly +1.0f, because 0x7FFFFFFF isn't exactly
      // representable as a 32-bit float (it rounds UP to 2147483648.0f, one past INT32_MAX).
      // clip1m1f alone permits exactly +/-1.0, which a hard-edged wave (pulse/square) hits on
      // most samples -- real, confirmed undefined behavior on nearly every sample of exactly
      // the waveforms this bug first surfaced on. A tiny, inaudible headroom scale keeps the
      // clipped signal's peak just under full-scale, avoiding the overflow deterministically.
      yn[i] = f32_to_q31(clip1m1f(${pieces.outputExpr}) * 0.999f);
${pieces.advanceStatements}    }
  }

private:
${FIXED_MEMBER_DECLS}${pieces.memberDecls}
${pieces.helperCode}};

static Osc s_osc;

void OSC_INIT(uint32_t platform, uint32_t api)
{
  (void)platform;
  (void)api;
  s_osc.init();
}

void OSC_CYCLE(const user_osc_param_t * const params, int32_t *yn, const uint32_t frames)
{
  s_osc.setPitch((params->pitch) >> 8, params->pitch & 0xFF);
  // note01_ is a plain linear 0..1-ish note position -- NOT the same value/domain as note_
  // (a raw 0-127 MIDI note byte, unusable directly as e.g. a filter cutoff coefficient).
  s_osc.setSenseInputs(
    (float)(params->pitch >> 8) * (1.f / 127.f),
    (float)params->cutoff * (1.f / 8191.f),
    (float)params->resonance * (1.f / 8191.f)
  );
  s_osc.updateShapeSense(q31_to_f32(params->shape_lfo));
  s_osc.process(yn, frames);
}

void OSC_NOTEON(const user_osc_param_t * const params) { (void)params; s_osc.noteOn(); }
void OSC_NOTEOFF(const user_osc_param_t * const params) { (void)params; s_osc.noteOff(); }

void OSC_PARAM(uint16_t index, uint16_t value)
{
  // SHAPE and the second fixed knob (logue/sense/shape-2) are fixed hardware knobs, not one of
  // the 6 named param slots below.
  if (index == k_user_osc_param_shape) { s_osc.setShapeParam(param_val_to_f32(value)); return; }
  if (index == k_user_osc_param_shiftshape) { s_osc.setShape2Sense(param_val_to_f32(value)); return; }
${oscParamClamp}  s_osc.setParameter(index, ${exposedParams.size > 0 ? 'v' : '(int32_t)value'});
}
`
}

/** Byte-identical (confirmed via \`diff\`, 2026-09-16) across the real \`dummy-osc\`/\`waves\` reference examples -- the entry-point trampoline that always calls the same weak \`_hook_*\` symbols \`OSC_INIT\`/\`OSC_CYCLE\`/etc. expand to. */
const UNIT_C = `#include "userosc.h"

extern uint8_t _bss_start;
extern uint8_t _bss_end;

extern void (*__init_array_start []) (void);
extern void (*__init_array_end []) (void);

typedef void (*__init_fptr)(void);

__attribute__((used, section(".hooks")))
static const user_osc_hook_table_t s_hook_table = {
  .magic = {'U','O','S','C'},
  .api = USER_API_VERSION,
  .platform = USER_TARGET_PLATFORM>>8,
  .reserved0 = {0},
  .func_entry = _entry,
  .func_cycle = _hook_cycle,
  .func_on = _hook_on,
  .func_off = _hook_off,
  .func_mute = _hook_mute,
  .func_value = _hook_value,
  .func_param = _hook_param,
  .reserved1 = {0}
};

__attribute__((used))
void _entry(uint32_t platform, uint32_t api)
{
  uint8_t * __restrict bss_p = (uint8_t *)&_bss_start;
  const uint8_t * const bss_e = (uint8_t *)&_bss_end;

  for (; bss_p != bss_e;)
    *(bss_p++) = 0;

  const size_t count = __init_array_end - __init_array_start;
  for (size_t i = 0; i<count; ++i) {
    __init_fptr init_p = (__init_fptr)__init_array_start[i];
    if (init_p != NULL)
      init_p();
  }

  _hook_init(platform, api);
}

__attribute__((weak))
void _hook_init(uint32_t platform, uint32_t api)
{
  (void)platform;
  (void)api;
}

__attribute__((weak))
void _hook_cycle(const user_osc_param_t * const params, int32_t *yn, const uint32_t frames)
{
  (void)params;
  (void)yn;
  (void)frames;
}

__attribute__((weak))
void _hook_on(const user_osc_param_t * const params)
{
  (void)params;
}

__attribute__((weak))
void _hook_off(const user_osc_param_t * const params)
{
  (void)params;
}

__attribute__((weak))
void _hook_mute(const user_osc_param_t * const params)
{
  (void)params;
}

__attribute__((weak))
void _hook_value(uint16_t value)
{
  (void)value;
}

__attribute__((weak))
void _hook_param(uint16_t index, uint16_t value)
{
  (void)index;
  (void)value;
}
`

export const RULES_LD = `SECTIONS
{

  .hooks : ALIGN(16) SUBALIGN(16)
  {
    . = ALIGN(4);
    _hooks_start = .;
    KEEP(*(.hooks))
    . = ALIGN(4);
    _hooks_end = .;
  } > SRAM

  .init_array : ALIGN(4) SUBALIGN(4)
  {
    . = ALIGN(4);
    PROVIDE(__init_array_start = .);
    KEEP(*(SORT(.init_array.*)))
    KEEP(*(.init_array*))
    . = ALIGN(4);
    PROVIDE(__init_array_end = .);
  } > SRAM

  .text : ALIGN(4) SUBALIGN(4)
  {
    . = ALIGN(4);
    _text_start = .;
    *(.text)
    *(.text.*)
    *(.glue_7)
    *(.glue_7t)
    *(.gcc*)
    . = ALIGN(4);
    _text_end = .;
  } > SRAM

  .rodata : ALIGN(4) SUBALIGN(4)
  {
    . = ALIGN(4);
    _rodata_start = .;
    *(.rodata)
    *(.rodata.*)
    . = ALIGN(4);
    _rodata_end = .;
  } > SRAM

  .data ALIGN(8) : ALIGN(8) SUBALIGN(8)
  {
    . = ALIGN(8);
    _data_start = .;
    *(.data)
    *(.data.*)
    . = ALIGN(8);
    _data_end = .;
  } > SRAM

  .bss (NOLOAD) : ALIGN(4)
  {
    . = ALIGN(4);
    _bss_start = .;
    *(.bss)
    *(.bss.*)
    *(COMMON)
    . = ALIGN(4);
    _bss_end = .;
  } > SRAM

  .ARM.extab : ALIGN(4) SUBALIGN(4)
  {
    . = ALIGN(4);
    __extab_start = .;
    *(.ARM.extab* .gnu.linkonce.armextab.*)
    . = ALIGN(4);
    __extab_end = .;
  } > SRAM

  .ARM.exidx : ALIGN(4) SUBALIGN(4)
  {
    __exidx_start = .;
    *(.ARM.exidx* .gnu.linkonce.armexidx.*)
    __exidx_end = .;
  } > SRAM

  .eh_frame_hdr : ALIGN(4) SUBALIGN(4)
  {
    . = ALIGN(4);
    _eh_frame_hdr_start = .;
    *(.eh_frame_hdr)
    . = ALIGN(4);
    _eh_frame_hdr_end = .;
  } > SRAM

  .eh_frame : ALIGN(4) SUBALIGN(4) ONLY_IF_RO
  {
    . = ALIGN(4);
    _eh_frame_start = .;
    *(.eh_frame)
    . = ALIGN(4);
    _eh_frame_end = .;
  } > SRAM
}
`

/**
 * The `Osc` class's own "sense bridging" members -- present in EVERY generated unit regardless
 * of which primitives are actually placed (each field's own comment below explains why it's
 * unconditional). Extracted into its own named constant, referenced by the class template
 * function below, rather than left as inline text -- so `UnitKind.fixedBaselineBytes`
 * (used by `estimateOscStateCost.ts`) has exactly one real source of truth to be checked against
 * (`test/logue-oscFixedBaseline.spec.ts`, same "hand-counted but parser-verified" discipline as
 * `stateBytesPerInstance`/`HelperBlock.sharedBytes`) instead of a second, separately hand-typed
 * number that could silently drift if a field here is ever added, removed, or resized.
 */
const FIXED_MEMBER_DECLS = `  // The raw decoded per-block pitch bytes -- each oscillator instance derives its OWN
  // transposed w0 from these (see primitives.ts's note_w0 helper) rather than sharing one
  // precomputed w0_, since COARSE/FINE/a wired pitch inlet can differ per instance.
  float note_;
  float noteFine_;
  // Always declared, regardless of whether any logue/sense/*
  // primitive is placed (same reasoning as note_/noteFine_ above: a few extra floats is
  // negligible against the 32KB budget, and keeps the class shape unconditional rather than
  // feature-detected).
  float note01_;
  float cutoff01_;
  float resonance01_;
  // shapeParam01_ is the static knob position (OSC_PARAM); shape01_ is that value combined with
  // the device's own Mod-LFO contribution each block (see updateShapeSense's own doc comment) --
  // shape01_, not shapeParam01_, is what logue/sense/shape's renderExpr actually reads.
  float shapeParam01_;
  float shape01_;
  float shape2_01_;
`

const USEROSC_LD = `ENTRY(_entry)

MEMORY
{
  SRAM   (rx) : org = 0x20000000, len = 32K
}

INCLUDE rules.ld
`

const OSC_API_SYMS = `k_osc_api_version = 0x0800f000;
k_osc_api_platform = 0x0800f004;
midi_to_hz_lut_f = 0x0800f100;
sqrtm2log_lut_f = 0x0800f360;
tanpi_lut_f = 0x0800f764;
log_lut_f = 0x0800fb68;
bitres_lut_f = 0x0800ff6c;
wt_par_lut_f = 0x08010170;
wt_par_notes = 0x08010f8c;
wt_sqr_lut_f = 0x08010f94;
wt_sqr_notes = 0x08011db0;
wt_saw_lut_f = 0x08011db8;
wt_saw_notes = 0x08012bd4;
wt_sine_lut_f = 0x08012bdc;
schetzen_lut_f = 0x08012de0;
cubicsat_lut_f = 0x08012fe4;
wavesA = 0x080131e8;
wavesB = 0x0801546c;
wavesC = 0x080174ec;
wavesD = 0x0801915c;
wavesE = 0x0801abc4;
wavesF = 0x0801ca3c;
_osc_mcu_hash = 0x0801eabc;
_osc_bl_saw_idx = 0x0801eac8;
_osc_bl_sqr_idx = 0x0801ebb0;
_osc_bl_par_idx = 0x0801ec98;
_osc_rand = 0x0801ed80;
_osc_white = 0x0801edb8;
`

export const MAKEFILE = `PLATFORMDIR ?= $(abspath ..)
PROJECTDIR ?= $(abspath .)
INSTALLDIR ?= $(PROJECTDIR)
TOOLSDIR ?= $(PLATFORMDIR)/../../tools
EXTDIR ?= $(PLATFORMDIR)/../ext
CMSISDIR ?= $(EXTDIR)/CMSIS/CMSIS
LDDIR ?= $(PROJECTDIR)/ld

ZIP ?= /usr/bin/zip
ZIP_ARGS := -r -m -q

include ./project.mk

MCU := cortex-m4
MCU_MODEL := STM32F401xC

GCC_TARGET := arm-none-eabi-
GCC_BIN_PATH ?= $(TOOLSDIR)/gcc/gcc-arm-none-eabi-5_4-2016q3/bin

CC   := $(GCC_BIN_PATH)/$(GCC_TARGET)gcc
CXXC := $(GCC_BIN_PATH)/$(GCC_TARGET)g++
LD   := $(GCC_BIN_PATH)/$(GCC_TARGET)gcc
CP   := $(GCC_BIN_PATH)/$(GCC_TARGET)objcopy
AS   := $(GCC_BIN_PATH)/$(GCC_TARGET)gcc -x assembler-with-cpp
AR   := $(GCC_BIN_PATH)/$(GCC_TARGET)ar
OD   := $(GCC_BIN_PATH)/$(GCC_TARGET)objdump
SZ   := $(GCC_BIN_PATH)/$(GCC_TARGET)size

HEX  := $(CP) -O ihex
BIN  := $(CP) -O binary

RULESPATH := $(LDDIR)
LDSCRIPT := $(LDDIR)/userosc.ld
DLIBS := -lm

DADEFS := -D$(MCU_MODEL) -DCORTEX_USE_FPU=TRUE -DARM_MATH_CM4
DDEFS := -D$(MCU_MODEL) -DCORTEX_USE_FPU=TRUE -DARM_MATH_CM4 -D__FPU_PRESENT

COPT := -std=c11 -mstructure-size-boundary=8
CXXOPT := -std=c++11 -fno-rtti -fno-exceptions -fno-non-call-exceptions

LDOPT := -Xlinker --just-symbols=$(LDDIR)/osc_api.syms

CWARN := -W -Wall -Wextra
CXXWARN :=

FPU_OPTS := -mfloat-abi=hard -mfpu=fpv4-sp-d16 -fsingle-precision-constant -fcheck-new

OPT := -g -Os -mlittle-endian
OPT += $(FPU_OPTS)

TOPT := -mthumb -mno-thumb-interwork -DTHUMB_NO_INTERWORKING -DTHUMB_PRESENT

PKGARCH := $(PROJECT).mnlgxdunit
MANIFEST := manifest.json
PAYLOAD := payload.bin

BUILDDIR := $(PROJECTDIR)/build
OBJDIR := $(BUILDDIR)/obj
LSTDIR := $(BUILDDIR)/lst

ASMSRC := $(UASMSRC)
ASMXSRC := $(UASMXSRC)
CSRC := $(PROJECTDIR)/tpl/_unit.c $(UCSRC)
CXXSRC := $(UCXXSRC)

vpath %.s $(sort $(dir $(ASMSRC)))
vpath %.S $(sort $(dir $(ASMXSRC)))
vpath %.c $(sort $(dir $(CSRC)))
vpath %.cpp $(sort $(dir $(CXXSRC)))

ASMOBJS := $(addprefix $(OBJDIR)/, $(notdir $(ASMSRC:.s=.o)))
ASMXOBJS := $(addprefix $(OBJDIR)/, $(notdir $(ASMXSRC:.S=.o)))
COBJS := $(addprefix $(OBJDIR)/, $(notdir $(CSRC:.c=.o)))
CXXOBJS := $(addprefix $(OBJDIR)/, $(notdir $(CXXSRC:.cpp=.o)))

OBJS := $(ASMXOBJS) $(ASMOBJS) $(COBJS) $(CXXOBJS)

DINCDIR := $(PROJECTDIR)/inc \\
           $(PROJECTDIR)/inc/api \\
           $(PLATFORMDIR)/inc \\
	   $(PLATFORMDIR)/inc/dsp \\
	   $(PLATFORMDIR)/inc/utils \\
           $(CMSISDIR)/Include

INCDIR := $(patsubst %,-I%,$(DINCDIR) $(UINCDIR))

DEFS := $(DDEFS) $(UDEFS)
ADEFS := $(DADEFS) $(UADEFS)

LIBS := $(DLIBS) $(ULIBS)

LIBDIR := $(patsubst %,-I%,$(DLIBDIR) $(ULIBDIR))

MCFLAGS   := -mcpu=$(MCU)
ODFLAGS	  := -x --syms
ASFLAGS   = $(MCFLAGS) -g $(TOPT) -Wa,-alms=$(LSTDIR)/$(notdir $(<:.s=.lst)) $(ADEFS)
ASXFLAGS  = $(MCFLAGS) -g $(TOPT) -Wa,-alms=$(LSTDIR)/$(notdir $(<:.S=.lst)) $(ADEFS)
CFLAGS    = $(MCFLAGS) $(TOPT) $(OPT) $(COPT) $(CWARN) -Wa,-alms=$(LSTDIR)/$(notdir $(<:.c=.lst)) $(DEFS)
CXXFLAGS  = $(MCFLAGS) $(TOPT) $(OPT) $(CXXOPT) $(CXXWARN) -Wa,-alms=$(LSTDIR)/$(notdir $(<:.cpp=.lst)) $(DEFS)
LDFLAGS   := $(MCFLAGS) $(TOPT) $(OPT) -nostartfiles $(LIBDIR) -Wl,-Map=$(BUILDDIR)/$(PROJECT).map,--cref,--no-warn-mismatch,--library-path=$(RULESPATH),--script=$(LDSCRIPT) $(LDOPT)

OUTFILES := $(BUILDDIR)/$(PROJECT).elf \\
	    $(BUILDDIR)/$(PROJECT).hex \\
	    $(BUILDDIR)/$(PROJECT).bin \\
	    $(BUILDDIR)/$(PROJECT).dmp \\
	    $(BUILDDIR)/$(PROJECT).list

all: PRE_ALL $(OBJS) $(OUTFILES) POST_ALL
	@echo Done
	@echo

PRE_ALL:

POST_ALL:

$(OBJS): | $(BUILDDIR) $(OBJDIR) $(LSTDIR)

$(BUILDDIR):
	@echo Compiler Options
	@echo $(CC) -c $(CFLAGS) -I. $(INCDIR)
	@echo
	@mkdir -p $(BUILDDIR)

$(OBJDIR):
	@mkdir -p $(OBJDIR)

$(LSTDIR):
	@mkdir -p $(LSTDIR)

$(ASMOBJS) : $(OBJDIR)/%.o : %.s Makefile
	@echo Assembling $(<F)
	@$(AS) -c $(ASFLAGS) -I. $(INCDIR) $< -o $@

$(ASMXOBJS) : $(OBJDIR)/%.o : %.S Makefile
	@echo Assembling $(<F)
	@$(CC) -c $(ASXFLAGS) -I. $(INCDIR) $< -o $@

$(COBJS) : $(OBJDIR)/%.o : %.c Makefile
	@echo Compiling $(<F)
	@$(CC) -c $(CFLAGS) -I. $(INCDIR) $< -o $@

$(CXXOBJS) : $(OBJDIR)/%.o : %.cpp Makefile
	@echo Compiling $(<F)
	@$(CXXC) -c $(CXXFLAGS) -I. $(INCDIR) $< -o $@

$(BUILDDIR)/%.elf: $(OBJS) $(LDSCRIPT)
	@echo Linking $@
	@$(LD) $(OBJS) $(LDFLAGS) $(LIBS) -o $@

%.hex: %.elf
	@echo Creating $@
	@$(HEX) $< $@

%.bin: %.elf
	@echo Creating $@
	@$(BIN) $< $@

%.dmp: %.elf
	@echo Creating $@
	@$(OD) $(ODFLAGS) $< > $@
	@echo
	@$(SZ) $<
	@echo

%.list: %.elf
	@echo Creating $@
	@$(OD) -S $< > $@

clean:
	@echo Cleaning
	-rm -fR $(PROJECTDIR)/.dep $(BUILDDIR) $(PROJECTDIR)/$(PKGARCH)
	@echo Done
	@echo

$(BUILDDIR)/$(PKGARCH): | $(OBJS) $(OUTFILES)
	@echo Packaging to $(BUILDDIR)/$(PKGARCH)
	@mkdir -p $(BUILDDIR)/$(PROJECT)
	@cp -a $(PROJECTDIR)/$(MANIFEST) $(BUILDDIR)/$(PROJECT)/
	@cp -a $(BUILDDIR)/$(PROJECT).bin $(BUILDDIR)/$(PROJECT)/$(PAYLOAD)
	@cd $(BUILDDIR) && $(ZIP) $(ZIP_ARGS) $(PROJECT).zip $(PROJECT)
	@mv $(BUILDDIR)/$(PROJECT).zip $(BUILDDIR)/$(PKGARCH)

install: $(BUILDDIR)/$(PKGARCH)
	@echo Deploying to $(INSTALLDIR)/$(PKGARCH)
	@mv $(BUILDDIR)/$(PKGARCH) $(INSTALLDIR)/$(PKGARCH)
	@echo Done
	@echo
`

export function generateOldGenOscUnit(
  doc: PatchDocument,
  meta: LogueOldGenOscUnitMeta,
  subpatches: SubpatchDefinitions = new Map()
): LogueOldGenOscUnitSource {
  validateNoBreakingChars(meta.name, 'Unit name')
  if (isEffectModule(doc.settings.logueTarget?.module ?? 'osc')) {
    throw new UnsupportedLogueNodeError(
      'This is an effect patch -- it builds with generateOldGenFxUnit, not as an oscillator.'
    )
  }
  const { activeInstances, sinkOutlet, exposedParams, knobBindings } = resolveUnit(
    doc,
    subpatches,
    'minilogue-xd',
    { maxParamCount: MINILOGUE_XD_OSC.maxParams }
  )
  for (const binding of exposedParams.values()) {
    validateNoBreakingChars(binding.paramName, 'Param name')
  }
  requireContiguousIndices(exposedParams)
  const pieces = buildOscBodyPieces(
    activeInstances,
    exposedParams,
    sinkOutlet,
    undefined,
    knobBindings
  )

  return {
    manifestJson: generateManifestJson(meta, exposedParams),
    projectMk: generateProjectMk(),
    oscCpp: generateOscCpp(pieces, exposedParams),
    makefile: MAKEFILE,
    unitC: UNIT_C,
    rulesLd: RULES_LD,
    useroscLd: USEROSC_LD,
    oscApiSyms: OSC_API_SYMS
  }
}

export { UnsupportedLogueNodeError, InvalidLogueParamError }

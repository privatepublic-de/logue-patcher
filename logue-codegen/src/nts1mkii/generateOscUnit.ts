import type { PatchDocument } from '../../../src/shared/domain/patch'
import { UnsupportedLogueNodeError } from '../oscInstances'
import type { SubpatchDefinitions } from '../subpatches'
import {
  InvalidLogueParamError,
  knobInitPositions,
  type ExposedParamBinding,
  type KnobBinding,
  type LogueKnob
} from '../oscParams'
import { resolveUnit } from '../resolveUnit'
import { buildOscBodyPieces } from '../oscBody'
import { toDeviceValue } from '../paramDeviceType'
import { isEffectModule, requireUnitKind, type UnitKind } from '../unitKinds'

/**
 * A real `PatchDocument` -> real, buildable NTS-1 mkII
 * oscillator unit source. Reuses `.axp`/the ordinary `PatchDocument` shape as-is, per the
 * phase-0 design resolution ("Design questions: resolved 2026-09-16", question 2) -- no new
 * document type. Graph validation and param-exposure binding are shared with
 * `minilogue-xd/generateOscUnit.ts` (`../oscInstances.ts`/`../oscParams.ts`/`../oscBody.ts`) --
 * only this file's own class/header/entry-point SHAPE is NTS-1-mkII-specific.
 */

export interface LogueOscUnitMeta {
  /** unit_header.name -- displayed on-device. */
  name: string
  /** Local-test placeholder unless a real developer_ids.md registration exists. */
  devId?: number
  unitId?: number
}

export interface LogueOscUnitSource {
  headerC: string
  /** The `Osc` DSP class -- kept separate from `unitCc` to mirror the SDK's own osc.h/unit.cc split (see phase 1's `axomodern-poc1`). */
  oscH: string
  unitCc: string
}

class InvalidLogueUnitNameError extends Error {}

/**
 * `UNIT_NAME_LEN` (`platform/nts-1_mkii/common/runtime.h`) -- the real fixed-size on-device
 * name buffer. Found via a real Docker build: an over-long name compiled with only a silent
 * `initializer-string for array of chars is too long` GCC warning (the excess bytes are
 * dropped, not rejected), which is a genuinely confusing failure mode for a GENERATED name --
 * validated here so it's a clear thrown error instead.
 */
const UNIT_NAME_MAX_LEN = 19
/** `UNIT_PARAM_NAME_LEN` (`platform/nts-1_mkii/common/runtime.h`) -- same class of fixed-size buffer, same reason to validate rather than let GCC silently truncate. */
const UNIT_PARAM_NAME_MAX_LEN = 21
const NTS1MKII_OSC = requireUnitKind('nts1mkii', 'osc')
/** `UNIT_OSC_MAX_PARAM_COUNT` (`platform/nts-1_mkii/common/unit_osc.h`). */
const UNIT_OSC_MAX_PARAM_COUNT = NTS1MKII_OSC.maxParams

/**
 * The `Osc` class's own "sense bridging" members -- present in EVERY generated unit regardless
 * of which primitives are actually placed (each field's own comment below explains why it's
 * unconditional). Extracted into its own named constant, referenced by `generateOscH` below,
 * rather than left as inline text in the class template -- so `UnitKind.fixedBaselineBytes`
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
  // See init()'s own comment on why these are unconditional.
  float note01_;
  // shapeParam01_ is the static knob position (setParameter's own slot 0); shape01_ is that
  // value combined with the device's own Mod-LFO contribution each block (see setShapeLfo's
  // own doc comment).
  float shapeParam01_;
  float shape01_;
  // The device's second fixed knob (Alt-Shape) -- its own static knob position
  // (setParameter's own slot 1), read by logue/sense/shape-2 (merged with minilogue xd's own
  // Shift-Shape reader -- see primitives.ts's own doc comment). Always written (slot 1 is now
  // reserved on EVERY unit, see reserveFixedKnobSlots's
  // own doc comment), regardless of whether logue/sense/shape-2 is actually placed.
  float shape2_01_;
`

/**
 * `k_unit_osc_fixed_param_shape`/`altshape`
 * (`platform/nts-1_mkii/common/unit_osc.h`, `k_num_unit_osc_fixed_param_id == 2`): unlike
 * minilogue xd (where SHAPE arrives via a fixed OSC_PARAM ordinal outside the unit's own
 * manifest), NTS-1 mkII's Shape/Alt-Shape knobs are this unit's OWN param slots 0/1, delivered
 * through the ordinary `setParameter` path every other exposed param already uses -- as a PAIR:
 * a real Kontrol Editor "Wrong number of unit params" rejection (found by the user loading a
 * built unit with `num_params: 1`, slot 0 only, onto real hardware) confirmed no partial
 * declaration is accepted. Every real
 * shipped Korg example that reads Shape at all (`dummy-osc`, `waves`, `pluck`) already declares
 * BOTH slots together, never just one -- this project's own original phase-30 ship missed that,
 * having verified only that the generated code COMPILES, not that Kontrol Editor accepts it.
 *
 * Slot 1's value went unread at first (`logue/sense/shape` had no Alt-Shape-sensing counterpart
 * yet); a later addition, `logue/sense/shape-alt` (`primitives.ts`), gave it a real reader --
 * see `reserveFixedKnobSlots`'s own doc comment for how the two primitives share this pair (and
 * why, as of phase 33, both slots are reserved on EVERY unit, not just ones using either).
 */
const RESERVED_KNOB_SLOTS: ReadonlyMap<number, LogueKnob> = new Map(
  NTS1MKII_OSC.reservedSlots.map((slot) => [slot.index, slot.knob])
)
/** Slot 0 sets the static position `setShapeLfo` then combines with the Mod-LFO. */
const RESERVED_SLOT_STATEMENT: Partial<Record<LogueKnob, string>> = {
  shape: 'shapeParam01_ = param_10bit_to_f32(value);',
  'shape-2': 'shape2_01_ = param_10bit_to_f32(value);',
  time: 'time01_ = param_10bit_to_f32(value);',
  depth: 'depth01_ = param_10bit_to_f32(value);',
  mix: 'mix01_ = (value + 1000) * (1.f / 2000.f);'
}

function generateOscH(pieces: ReturnType<typeof buildOscBodyPieces>): string {
  const setParameterBody = !pieces.hasExposedParams
    ? '    (void)index;\n    (void)value;\n'
    : '    switch (index)\n    {\n' + pieces.setParameterCases + '    default: break;\n    }\n'

  return `#pragma once
// Generated by logue-patcher's logue-codegen.
// NOT hand-written -- do not edit directly, re-export instead.
#include "processor.h"
#include "unit_osc.h"
#include <cmath>

class Osc : public Processor
{
public:
  uint32_t getBufferSize() const override final { return 0; }

  void setParameter(uint8_t index, int32_t value) override final
  {
${setParameterBody}  }

  void init(float *) override final
  {
    note_ = 0.f;
    noteFine_ = 0.f;
    // Always declared, regardless of whether any
    // logue/sense/* primitive is placed, same "unconditional, harmlessly unused" precedent
    // minilogue xd's own note01_/shapeParam01_/shape01_ already established.
    note01_ = 0.f;
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
    // note01_ is a plain linear 0..1-ish note position -- NOT the same value/domain as note_
    // (a raw note byte, unusable directly as e.g. a filter cutoff coefficient). Same /127.f
    // scale minilogue xd's own note01_ uses (not NTS-1 mkII's wider 0-151 LUT range) so a
    // patch built around logue/sense/pitch means the same thing on both platforms -- a
    // disclosed simplification, not a claim either scale is independently "correct".
    note01_ = note_ * (1.f / 127.f);
  }

  /**
   * The real device's own Mod section can target SHAPE (unit_runtime_osc_context_t.shape_lfo,
   * Q31, delivered once per block via unit_render -- see generateUnitCc). Combined additively
   * with the static knob position (shapeParam01_, set via setParameter's slot 0 -- see
   * reserveFixedKnobSlots) and clamped to this registry's own unipolar 0..1 sense domain,
   * mirroring minilogue xd's updateShapeSense verbatim.
   * shape01_, not shapeParam01_, is what logue/sense/shape's renderExpr reads.
   */
  void setShapeLfo(float shapeLfo01)
  {
    const float sum = shapeParam01_ + shapeLfo01;
    shape01_ = (sum < 0.f) ? 0.f : (sum > 1.f) ? 1.f : sum;
  }

  void noteOn(uint8_t, uint8_t${pieces.readsVelocity ? ' velo' : ''}) override final
  {
${pieces.noteOnStatements}  }

  void noteOff(uint8_t) override final
  {
${pieces.noteOffStatements}  }

  void process(const float *__restrict in, float *__restrict out, uint32_t frames) override final
  {
    (void)in;
${pieces.blockStatements}    for (uint32_t i = 0; i < frames; ++i)
    {
${pieces.computeStatements}      out[i] = clip1m1f(${pieces.outputExpr});
${pieces.advanceStatements}    }
  }

private:
${FIXED_MEMBER_DECLS}${pieces.memberDecls}
${pieces.helperCode}};
`
}

export function generateHeaderC(
  meta: LogueOscUnitMeta,
  exposedParams: Map<number, ExposedParamBinding>,
  kind: UnitKind = NTS1MKII_OSC
): string {
  const devId = meta.devId ?? 0
  const unitId = meta.unitId ?? 0

  // `num_params` = one past the highest exposed slot -- every slot below it must still be a
  // real, present row (the SDK's own `k_unit_param_type_none` sentinel for a gap), matching
  // the phase-0 design resolution's "gaps are fine, duplicates are rejected" decision.
  const highestIndex = exposedParams.size === 0 ? -1 : Math.max(...Array.from(exposedParams.keys()))
  const numParams = highestIndex + 1

  const rows: string[] = []
  for (let i = 0; i < kind.maxParams; i++) {
    const binding = exposedParams.get(i)
    // `frac`/`frac_mode` stay 0 (no decimal scaling) for every param `@logue-codegen/
    // paramDeviceType` lists -- each one's raw value already equals its target unit exactly, no
    // curve/offset to express (see that module's own doc comment on why that's the ONLY safe
    // case, given the real device's own rendering is a plain `raw/2^frac` or `raw/10^frac`).
    // The row's range and `init` are in the DEVICE domain (`DeviceParam`), which differs from
    // the spec's for a select or toggle; `setParameter` scales back.
    const device = binding?.device
    rows.push(
      binding && device
        ? `        {${device.min}, ${device.max}, 0, ${toDeviceValue(device, binding.default)}, k_unit_param_type_${device.type}, ${device.frac ?? 0}, ${device.fracMode ?? 0}, 0, {"${binding.paramName}"}}`
        : `        {0, 0, 0, 0, k_unit_param_type_none, 0, 0, 0, {""}}`
    )
  }

  return `// Generated by logue-patcher's logue-codegen.
// NOT hand-written -- do not edit directly, re-export instead.
#include "unit_${kind.module}.h"

const __unit_header unit_header_t unit_header = {
    .header_size = sizeof(unit_header_t),
    .target = UNIT_TARGET_PLATFORM | k_unit_module_${kind.module},
    .api = UNIT_API_VERSION,
    .dev_id = ${devId}U,
    .unit_id = ${unitId}U,
    .version = 0x00010000U,
    .name = "${meta.name}",
    .num_params = ${numParams},
    .params = {
${rows.join(',\n')}},
};
`
}

/**
 * Fixed boilerplate matching phase 1's hand-written `axomodern-poc1/unit.cc` verbatim in
 * shape (the entry-point contract is fixed by `unit_osc.h`, nothing to generate differently
 * here) -- including the real cached-value param forwarding pattern (clip to the header's own
 * declared min/max, cache for `unit_get_param_value`, forward to the DSP class), not just a
 * no-op: harmless when a graph exposes zero params (the loop/switch are simply empty-effect),
 * but real infrastructure the moment one is.
 */
/**
 * `k_unit_param_type_strings` rows ask the firmware to call `unit_get_param_str_value` for their
 * label. Korg's README: the returned string only has to stay valid until the next call, so a
 * static table per param is enough; `nullptr` for any other id, as before.
 */
export function generateParamStrValue(exposedParams: Map<number, ExposedParamBinding>): string {
  const cases = Array.from(exposedParams.values())
    .filter((b) => b.device.strings)
    .sort((a, b) => a.index - b.index)
    .map((b) => {
      const list = b.device.strings!.map((str) => `"${str}"`).join(', ')
      return `  case ${b.index}:\n  {\n    static const char *const strs[] = {${list}};\n    return strs[value - ${b.device.min}];\n  }\n`
    })
  if (cases.length === 0) {
    return '__unit_callback const char *unit_get_param_str_value(uint8_t, int32_t) { return nullptr; }\n'
  }
  return `__unit_callback const char *unit_get_param_str_value(uint8_t id, int32_t value)
{
  value = clipminmaxi32(unit_header.params[id].min, value, unit_header.params[id].max);
  switch (id)
  {
${cases.join('')}  default: break;
  }
  return nullptr;
}
`
}

function generateUnitCc(exposedParams: Map<number, ExposedParamBinding>): string {
  return `// Generated by logue-patcher's logue-codegen.
// NOT hand-written -- do not edit directly, re-export instead.
#include "osc.h"
#include "unit_osc.h"
#include "utils/int_math.h"

// Same local definition the real dummy-osc/waves/pluck
// reference examples all use for reading unit_runtime_osc_context_t.shape_lfo.
#define q31_to_f32_c 4.65661287307739e-010f
#define q31_to_f32(q) ((float)(q) * q31_to_f32_c)

static Osc s_osc_instance;
static int32_t cached_values[UNIT_OSC_MAX_PARAM_COUNT];
static const unit_runtime_osc_context_t *context;

__unit_callback int8_t unit_init(const unit_runtime_desc_t *desc)
{
  if (!desc)
    return k_unit_err_undef;
  if (desc->target != unit_header.target)
    return k_unit_err_target;
  if (!UNIT_API_IS_COMPAT(desc->api))
    return k_unit_err_api_version;
  if (desc->samplerate != s_osc_instance.getSampleRate())
    return k_unit_err_samplerate;
  if (desc->input_channels != 2 || desc->output_channels != 1)
    return k_unit_err_geometry;

  context = static_cast<const unit_runtime_osc_context_t *>(desc->hooks.runtime_context);
  // dummy-osc's own unit_init never calls Osc::init() (harmless there -- its init() only
  // re-zeroes state static storage duration already zeroes). This class's own init() is NOT a
  // no-op -- it carries every non-exposed param's configured default -- so skip dummy-osc's
  // omission and call it explicitly, same as dummy-delfx/dummy-revfx/dummy-modfx's own
  // unit_init does with getBufferSize()==0.
  s_osc_instance.init(nullptr);
  for (int id = 0; id < UNIT_OSC_MAX_PARAM_COUNT; ++id)
  {
    cached_values[id] = static_cast<int32_t>(unit_header.params[id].init);
  }
  return k_unit_err_none;
}

__unit_callback void unit_teardown() { s_osc_instance.teardown(); }
__unit_callback void unit_reset() { s_osc_instance.reset(); }
__unit_callback void unit_resume() { s_osc_instance.resume(); }
__unit_callback void unit_suspend() { s_osc_instance.suspend(); }

__unit_callback void unit_render(const float *in, float *out, uint32_t frames)
{
  s_osc_instance.setPitch((context->pitch) >> 8, context->pitch & 0xFF);
  // Always called, regardless of whether logue/sense/shape is
  // used (same "unconditional, harmlessly unused" precedent as setPitch itself).
  s_osc_instance.setShapeLfo(q31_to_f32(context->shape_lfo));
  s_osc_instance.process(in, out, frames);
}

__unit_callback void unit_set_param_value(uint8_t id, int32_t value)
{
  value = clipminmaxi32(unit_header.params[id].min, value, unit_header.params[id].max);
  cached_values[id] = value;
  s_osc_instance.setParameter(id, value);
}
__unit_callback int32_t unit_get_param_value(uint8_t id) { return cached_values[id]; }
${generateParamStrValue(exposedParams)}
__unit_callback void unit_note_on(uint8_t note, uint8_t velo) { s_osc_instance.noteOn(note, velo); }
__unit_callback void unit_note_off(uint8_t note) { s_osc_instance.noteOff(note); }
__unit_callback void unit_all_note_off() { s_osc_instance.allNoteOff(); }
__unit_callback void unit_set_tempo(uint32_t) {}
__unit_callback void unit_tempo_4ppqn_tick(uint32_t) {}
__unit_callback void unit_pitch_bend(uint16_t) {}
__unit_callback void unit_channel_pressure(uint8_t) {}
__unit_callback void unit_aftertouch(uint8_t, uint8_t) {}
`
}

/**
 * Reserves slots 0 (Shape) and 1 (Alt-Shape, `unitKinds.ts`) on every NTS-1 mkII unit
 * for the device's fixed A/B (Shape/Alt-Shape) knobs, whether or not the graph reads them. Every
 * shipped Korg example (`dummy-osc`, `waves`, `pluck`, ...) declares both unconditionally, and
 * Kontrol Editor rejected units declaring only one or neither ("Wrong number of unit params").
 *
 * Slot 0 feeds `shapeParam01_`, without which `logue/sense/shape`'s `shape01_` would never leave
 * its init value. Slot 1 always writes `shape2_01_`: read by `logue/sense/shape-2` when one is
 * placed, harmless otherwise.
 *
 * A knob with a bound param declares that param's authored value as the row's `init`, so a
 * program starts where the patch was authored (the same position `Osc::init` starts from).
 *
 * The firmware does call `setParameter(0/1, ...)` on a knob turn: a unit binding both knobs
 * followed them on a real NTS-1 mkII, and loaded with a non-zero `init` on both rows (user,
 * 2026-09-29). History: docs/HISTORY.md.
 */
export function reserveFixedKnobSlots(
  exposedParams: Map<number, ExposedParamBinding>,
  knobBindings: KnobBinding[],
  kind: UnitKind = NTS1MKII_OSC
): void {
  const initPositions = knobInitPositions(knobBindings)
  const why =
    kind.module === 'osc'
      ? ' (both fixed knobs must always be declared together, whether or not logue/sense/shape(-alt) is used)'
      : ''
  for (const { index, knob, name, panelName, device, unboundInit } of kind.reservedSlots) {
    const setStatement = RESERVED_SLOT_STATEMENT[knob]!
    const initPosition = initPositions[knob]
    const existing = exposedParams.get(index)
    if (existing) {
      throw new InvalidLogueParamError(
        `Param slot ${index} is reserved on every NTS-1 mkII unit for its fixed ${panelName} knob${why}, but it's already claimed by "${existing.paramName}" (on "${existing.instanceSuffix}") -- move that param to a different logueParamIndex.`
      )
    }

    exposedParams.set(index, {
      index,
      instanceSuffix: `(nts1mkii ${name} knob, reserved on every unit for the fixed A/B knob pair)`,
      paramName: name,
      min: device.min,
      max: device.max,
      default:
        initPosition === undefined
          ? unboundInit
          : device.min + Math.round(initPosition * (device.max - device.min)),
      // param_10bit_to_f32 (platform/nts-1_mkii/common/macros.h, transitively included via
      // unit_osc.h -> unit.h) -- the same real SDK macro minilogue xd's own equivalent OSC_PARAM
      // handling uses (param_val_to_f32, an alias of the same macro).
      setStatement,
      device
    })
  }
}

export function validateMeta(meta: LogueOscUnitMeta): void {
  if (meta.name.length > UNIT_NAME_MAX_LEN) {
    throw new InvalidLogueUnitNameError(
      `Unit name "${meta.name}" is ${meta.name.length} characters, exceeding the real on-device limit of ${UNIT_NAME_MAX_LEN} ` +
        `(UNIT_NAME_LEN, platform/nts-1_mkii/common/runtime.h) -- shorten it.`
    )
  }
  if (meta.name.includes('"') || meta.name.includes('\n')) {
    throw new InvalidLogueUnitNameError(
      `Unit name "${meta.name}" contains a character that would break the generated C string literal (" or a newline).`
    )
  }
}

export function generateOscUnit(
  doc: PatchDocument,
  meta: LogueOscUnitMeta,
  subpatches: SubpatchDefinitions = new Map()
): LogueOscUnitSource {
  validateMeta(meta)
  if (isEffectModule(doc.settings.logueTarget?.module ?? 'osc')) {
    throw new UnsupportedLogueNodeError(
      'This is an effect patch -- it builds with generateFxUnit, not as an oscillator.'
    )
  }
  const { activeInstances, sinkOutlet, exposedParams, knobBindings } = resolveUnit(
    doc,
    subpatches,
    'nts1mkii',
    {
      maxParamCount: UNIT_OSC_MAX_PARAM_COUNT,
      maxLabelLength: UNIT_PARAM_NAME_MAX_LEN,
      reservedKnobSlots: RESERVED_KNOB_SLOTS
    }
  )
  reserveFixedKnobSlots(exposedParams, knobBindings)
  const pieces = buildOscBodyPieces(
    activeInstances,
    exposedParams,
    sinkOutlet,
    'velo',
    knobBindings
  )
  return {
    headerC: generateHeaderC(meta, exposedParams),
    oscH: generateOscH(pieces),
    unitCc: generateUnitCc(exposedParams)
  }
}

export {
  UnsupportedLogueNodeError,
  InvalidLogueUnitNameError,
  InvalidLogueParamError,
  UNIT_NAME_MAX_LEN,
  UNIT_PARAM_NAME_MAX_LEN
}

import type { HelperBlock, LoguePrimitive, PrimitiveOutletSpec } from './types'
import { TEMPO_DIVISION_NAME } from '../paramPresentation'

/**
 * "Sense" primitives: no inlets, reading a live *logue SDK value instead of computing one.
 * `pitch`/`shape`/`shape-2` work on both platforms, each through that platform's own mechanism
 * (see the generators). `cutoff`/`resonance` are minilogue-xd-only: the NTS-1 mkII header marks
 * those context fields "Unused. Future.". `param` is xd-only because the NTS-1 mkII's
 * `setParameter` already delivers an exposed param live. `velocity` is NTS-1 mkII-only.
 *
 * The global readings (`pitch`/`shape`/`shape-2`/`cutoff`/`resonance`) have no per-instance state:
 * `renderOutletStatements` names a shared Osc-class member each generator always declares, since
 * the value is the same for every reader.
 *
 * Dual `unipolar`/`bipolar` outlets (every sense primitive except `gate`): readings are natively
 * `0..1`, but the other sources are bipolar, so this saves a `unipolar-to-bipolar` node at almost
 * every use; `bipolar = unipolar*2-1`, one multiply-add. `unipolar` is declared FIRST on purpose:
 * `resolveDeclaredOutletName` maps a net with no/legacy `'out'` outlet to the first declared one,
 * which keeps older files reading the unipolar value they read before -- that ordering is the
 * whole migration. `gate` is a discrete 0/1 flag with no polarity question, so it keeps one outlet.
 * History: docs/HISTORY.md.
 */
const SENSE_OUTLETS: PrimitiveOutletSpec[] = [{ name: 'unipolar' }, { name: 'bipolar' }]

/** Shared by every dual-outlet sense primitive below -- see the doc comment above. */
function senseOutletStatements(suffix: string, valueExpr: string): string {
  return (
    `      float y_${suffix}_unipolar = ${valueExpr};\n` +
    `      float y_${suffix}_bipolar = ${valueExpr} * 2.f - 1.f;\n` +
    `      (void)y_${suffix}_unipolar; (void)y_${suffix}_bipolar;\n`
  )
}

export const sensePitchPrimitive: LoguePrimitive = {
  id: 'logue/sense/pitch',
  modules: ['osc'],
  outletPolarity: { unipolar: 'unipolar', bipolar: 'bipolar' },
  stateBytesPerInstance: 0, // stateless, memberDecls is empty
  description: "Reads the device's own currently played note pitch as a control signal.",
  memberDecls: () => '',
  outlets: SENSE_OUTLETS,
  renderExpr: () => {
    throw new Error(
      'logue/sense/pitch is multi-outlet -- use renderOutletStatements, not renderExpr'
    )
  },
  renderOutletStatements: (suffix) => senseOutletStatements(suffix, 'note01_'),
  advanceStatement: () => ''
}

/**
 * SHAPE and its second knob (`logue/sense/shape-2` below) are fixed, always-present hardware
 * knobs on ANY minilogue xd oscillator (not something a user "exposes" -- confirmed via the real
 * manifest.json schema, which has no entry for either). Their raw value arrives via `OSC_PARAM`
 * (`k_user_osc_param_shape`/`k_user_osc_param_shiftshape`, both real SDK enum values, NOT one of
 * the 6 named/nameable param slots), not `OSC_CYCLE` -- see `generateOscCpp`'s own handling.
 *
 * SHAPE alone also combines with the device's own Mod-LFO contribution when the Mod section is
 * set to modulate shape (`user_osc_param_t.shape_lfo`, delivered via `OSC_CYCLE`, a real, once-
 * missed data path -- see `updateShapeSense`'s own doc comment in `minilogue-xd/generateOscUnit
 * .ts`). The second knob has no such LFO path on real hardware, so `shape2_01_` stays OSC_PARAM-
 * only.
 *
 * This was later widened to NTS-1 mkII too: `shape01_` means the same
 * thing there (current knob position combined with the live Mod-LFO contribution, clamped
 * `0..1`) even though the two platforms deliver the raw data through genuinely different paths
 * -- see `nts1mkii/generateOscUnit.ts`'s `reserveFixedKnobSlots`/`generateOscH` doc comments.
 */
export const senseShapePrimitive: LoguePrimitive = {
  id: 'logue/sense/shape',
  modules: ['osc'],
  supersededBy: 'logue/sense/control',
  outletPolarity: { unipolar: 'unipolar', bipolar: 'bipolar' },
  stateBytesPerInstance: 0, // stateless, memberDecls is empty
  description:
    "Reads the device's Shape knob, including any Mod-LFO applied to it, as a control signal.",
  memberDecls: () => '',
  outlets: SENSE_OUTLETS,
  renderExpr: () => {
    throw new Error(
      'logue/sense/shape is multi-outlet -- use renderOutletStatements, not renderExpr'
    )
  },
  renderOutletStatements: (suffix) => senseOutletStatements(suffix, 'shape01_'),
  advanceStatement: () => ''
}

/**
 * The device's second fixed knob: Shift-Shape on the minilogue xd (a fixed `OSC_PARAM` ordinal,
 * `k_user_osc_param_shiftshape`, outside the manifest), Alt-Shape on the NTS-1 mkII (reserved
 * param slot 1, the `shape-2` reserved slot in `unitKinds.ts`). One id for both, like
 * `sense/shape`, so a single net can feed one inlet on either platform -- with two platform-only
 * ids, even combining them through `mix2` fails, because both become active and
 * `assertPrimitivesSupportPlatform` rejects the build on both. Each generator writes the shared
 * `shape2_01_` member unconditionally (no Mod-LFO term to combine). The id is neutral on
 * purpose, favouring neither device's name. The old `logue/sense/shift-shape`/
 * `logue/sense/shape-alt` ids resolve here via `RENAMED_PRIMITIVE_IDS`. History: docs/HISTORY.md.
 */
export const senseShape2Primitive: LoguePrimitive = {
  id: 'logue/sense/shape-2',
  modules: ['osc'],
  supersededBy: 'logue/sense/control',
  outletPolarity: { unipolar: 'unipolar', bipolar: 'bipolar' },
  stateBytesPerInstance: 0, // stateless, memberDecls is empty
  description:
    "Reads the device's second Shape knob (Shift-Shape on minilogue xd, Alt-Shape on NTS-1 mkII) as a control signal.",
  memberDecls: () => '',
  outlets: SENSE_OUTLETS,
  renderExpr: () => {
    throw new Error(
      'logue/sense/shape-2 is multi-outlet -- use renderOutletStatements, not renderExpr'
    )
  },
  renderOutletStatements: (suffix) => senseOutletStatements(suffix, 'shape2_01_'),
  advanceStatement: () => ''
}

/**
 * The multi-engine's own built-in analog-modeled filter's live cutoff/resonance knobs -- read-
 * only from a custom oscillator's perspective (this project's own generated code never controls
 * them), but real, live, wireable values sitting in the SAME `user_osc_param_t` struct as pitch.
 */
export const senseCutoffPrimitive: LoguePrimitive = {
  id: 'logue/sense/cutoff',
  modules: ['osc'],
  supersededBy: 'logue/sense/control',
  outletPolarity: { unipolar: 'unipolar', bipolar: 'bipolar' },
  stateBytesPerInstance: 0, // stateless, memberDecls is empty
  description:
    "Reads the multi-engine's own built-in Filter Cutoff knob as a control signal (minilogue xd only).",
  platforms: ['minilogue-xd'],
  memberDecls: () => '',
  outlets: SENSE_OUTLETS,
  renderExpr: () => {
    throw new Error(
      'logue/sense/cutoff is multi-outlet -- use renderOutletStatements, not renderExpr'
    )
  },
  renderOutletStatements: (suffix) => senseOutletStatements(suffix, 'cutoff01_'),
  advanceStatement: () => ''
}

export const senseResonancePrimitive: LoguePrimitive = {
  id: 'logue/sense/resonance',
  modules: ['osc'],
  supersededBy: 'logue/sense/control',
  outletPolarity: { unipolar: 'unipolar', bipolar: 'bipolar' },
  stateBytesPerInstance: 0, // stateless, memberDecls is empty
  description:
    "Reads the multi-engine's own built-in Filter Resonance knob as a control signal (minilogue xd only).",
  platforms: ['minilogue-xd'],
  memberDecls: () => '',
  outlets: SENSE_OUTLETS,
  renderExpr: () => {
    throw new Error(
      'logue/sense/resonance is multi-outlet -- use renderOutletStatements, not renderExpr'
    )
  },
  renderOutletStatements: (suffix) => senseOutletStatements(suffix, 'resonance01_'),
  advanceStatement: () => ''
}

/**
 * The generic, freely-labeled version of the up-to-6 multi-engine user param slots -- unlike
 * every other param in this registry, this one has no inherent semantic name (a filter's CUTOFF
 * is always called "CUTOFF"; this primitive's whole purpose is a user-chosen label), so its one
 * param spec sets `freeLabel: true` and `resolveExposedParams` (`oscParams.ts`) sources its
 * EXPORTED name from the placed instance's own `ParamValue.label` instead of `name` below
 * (`"VALUE"` is just the internal binding key, never shown to a user). Otherwise this behaves
 * EXACTLY like any other exposed param -- baked at its authored/default value when unexposed,
 * live-updated via the existing 0-5 `OSC_PARAM` switch when given a `logueParamIndex` -- no new
 * runtime mechanism needed, unlike the 5 primitives above.
 */
export const senseParamPrimitive: LoguePrimitive = {
  id: 'logue/sense/param',
  modules: ['osc'],
  supersededBy: 'logue/sense/control',
  outletPolarity: { unipolar: 'unipolar', bipolar: 'bipolar' },
  stateBytesPerInstance: 4, // sense_, 1 float
  description:
    "A freely-labeled param exposed to the device's own menu -- reads its live knob value as a control signal (minilogue xd only).",
  platforms: ['minilogue-xd'],
  memberDecls: (suffix) => `  float sense_${suffix};\n`,
  outlets: SENSE_OUTLETS,
  renderExpr: () => {
    throw new Error(
      'logue/sense/param is multi-outlet -- use renderOutletStatements, not renderExpr'
    )
  },
  renderOutletStatements: (suffix) => senseOutletStatements(suffix, `sense_${suffix}`),
  advanceStatement: () => '',
  params: [
    {
      name: 'VALUE',
      freeLabel: true,
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `sense_${suffix} = ${valueExpr} * 0.01f;`
    }
  ]
}

/**
 * One device control as a signal: `VALUE` is an ordinary dial, and wherever the Param Matrix puts
 * it on a platform -- a menu slot (`logueParamIndex`), a fixed knob (`logueKnob`: Shape, Shape 2,
 * the xd's filter Cutoff/Resonance) or following another slot (`logueFollow`) -- the device sets
 * it and the outlets carry it live. Unassigned on a platform, it is the constant `VALUE`. It
 * replaces `sense/shape`/`shape-2`/`cutoff`/`resonance`/`param` (each kept, hidden, for older
 * documents): one node that works on both platforms because the platform-specific part is the
 * per-platform binding, not the node. A knob-bound one reads the knob's position member via the
 * block-start binding (`resolveKnobBindings`), so Shape includes the device's Mod-LFO as before.
 */
export const senseControlPrimitive: LoguePrimitive = {
  id: 'logue/sense/control',
  pure: true,
  outletPolarity: { unipolar: 'unipolar', bipolar: 'bipolar' },
  stateBytesPerInstance: 4, // sense_, 1 float
  description:
    'A device control as a signal: put its VALUE on the Shape knob, the second Shape knob, a menu param or (minilogue xd) the filter knobs in the Param Matrix, separately per device. Unassigned on a device, it outputs VALUE.',
  memberDecls: (suffix) => `  float sense_${suffix};\n`,
  outlets: SENSE_OUTLETS,
  renderExpr: () => {
    throw new Error(
      'logue/sense/control is multi-outlet -- use renderOutletStatements, not renderExpr'
    )
  },
  renderOutletStatements: (suffix) => senseOutletStatements(suffix, `sense_${suffix}`),
  advanceStatement: () => '',
  params: [
    {
      name: 'VALUE',
      freeLabel: true,
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `sense_${suffix} = ${valueExpr} * 0.01f;`
    }
  ]
}

/**
 * The note-on/off gate as a wireable signal: `held_` is set to 1/0 by this primitive's own
 * `noteOnStatement`/`noteOffStatement` and `renderExpr` reads it back. It exists because nothing
 * else could drive an envelope's `trig` (or `logue/logic/edge`) from a real note event --
 * note hooks only mutate their own primitive's members. Wired into `trig` it reproduces the
 * note-on retrigger exactly (the edge check is in `ad_env_step`/`ahd_env_step`); through
 * `logue/logic/edge` it becomes a one-shot note-on pulse.
 *
 * Per-instance state (4 bytes) rather than the shared Osc-class sense members `sense/pitch`/
 * `sense/shape` read, which would mean touching both generators' class scaffolding for a
 * boolean. Valid on both platforms: every generated unit has real `noteOn`/`noteOff` hooks.
 */
export const senseGatePrimitive: LoguePrimitive = {
  id: 'logue/sense/gate',
  modules: ['osc'],
  outletPolarity: 'gate',
  stateBytesPerInstance: 4, // held_, 1 float
  description:
    'Outputs 1 while a note is held, 0 otherwise -- the real note-on/note-off gate, as a wireable signal.',
  memberDecls: (suffix) => `  float held_${suffix};\n`,
  initStatement: (suffix) => `    held_${suffix} = 0.f;\n`,
  renderExpr: (suffix) => `held_${suffix}`,
  advanceStatement: () => '',
  noteOnStatement: (suffix) => `    held_${suffix} = 1.f;\n`,
  noteOffStatement: (suffix) => `    held_${suffix} = 0.f;\n`
}

/**
 * The last note-on's velocity, latched per instance -- NTS-1 mkII only, since the minilogue xd's
 * oscillator API (`user_osc_param_t`) carries no velocity at all. It changes only at a note-on,
 * like `sense/gate`. Over MIDI it's the sent velocity; whether the NTS-1 mkII's own keys send
 * varying velocity hasn't been checked on the device. Reads 0 before the first note.
 */
export const senseVelocityPrimitive: LoguePrimitive = {
  id: 'logue/sense/velocity',
  modules: ['osc'],
  platforms: ['nts1mkii'],
  outletPolarity: { unipolar: 'unipolar', bipolar: 'bipolar' },
  stateBytesPerInstance: 4, // velocity01_, 1 float
  description:
    'The velocity of the last note-on, 0..1 (NTS-1 mkII only: the minilogue xd gives oscillators no velocity). Over MIDI it follows the played velocity.',
  outlets: SENSE_OUTLETS,
  readsVelocity: true,
  memberDecls: (suffix) => `  float velocity01_${suffix};\n`,
  initStatement: (suffix) => `    velocity01_${suffix} = 0.f;\n`,
  renderExpr: () => {
    throw new Error(
      'logue/sense/velocity is multi-outlet -- use renderOutletStatements, not renderExpr'
    )
  },
  renderOutletStatements: (suffix) => senseOutletStatements(suffix, `velocity01_${suffix}`),
  advanceStatement: () => '',
  noteOnStatement: (suffix, note) =>
    note.velocity === undefined
      ? ''
      : `    velocity01_${suffix} = (float)${note.velocity} * (1.f / 127.f);\n`
}

const TEMPO_CLOCK_HELPER: HelperBlock = {
  key: 'tempo_clock_step',
  // tempo_clock_step's beats[10] table.
  sharedBytes: 40,
  code: `  // Counts samples through one DIVISION of a beat at bpm (counting samples, not adding a tiny
  // phase increment, which drifted a sample per period); *clock is 1 for the sample the period
  // ends. Returns how far through it is (0..1). A leaf.
  static float tempo_clock_step(float *count, float bpm, int div, float *clock)
  {
    static const float beats[10] = {0.25f, 1.f / 3.f, 0.5f, 0.75f, 2.f / 3.f, 1.f, 1.5f, 2.f, 3.f, 4.f};
    const int i = div < 0 ? 0 : (div > 9 ? 9 : div);
    const float period = 2880000.f * beats[i] / (bpm < 20.f ? 20.f : bpm);
    *count += 1.f;
    *clock = 0.f;
    if (*count >= period)
    {
      *count -= period;
      *clock = 1.f;
    }
    return *count / period;
  }
`
}

/**
 * `logue/sense/tempo`: the device tempo (`unit_set_tempo`, so effects only) as a clock: `clock`
 * is a one-sample gate every DIVISION of a beat (1/16 .. 1/1, dotted and triplet), `ramp` rises
 * 0..1 across it. The clock into an LFO's `trig` keeps it in time with the tempo (it resets the
 * phase each division); the ramp through math nodes gives any tempo-locked shape. It free-runs
 * from when the unit loads rather than following the device's beat position
 * (`unit_tempo_4ppqn_tick` isn't read yet), so it has the tempo but not the downbeat.
 */
export const senseTempoPrimitive: LoguePrimitive = {
  id: 'logue/sense/tempo',
  modules: ['modfx', 'delfx', 'revfx'],
  outletPolarity: { clock: 'gate', ramp: 'unipolar' },
  // count_, div_ (2 x 4 B).
  stateBytesPerInstance: 8,
  description:
    "The device tempo as a clock: a gate every DIVISION of a beat, and a 0..1 ramp across it. Into an LFO's trig it keeps the LFO in time. Effects only.",
  outlets: [{ name: 'clock' }, { name: 'ramp' }],
  memberDecls: (suffix) => `  float count_${suffix};\n  int div_${suffix};\n`,
  initStatement: (suffix) => `    count_${suffix} = 0.f;\n`,
  renderExpr: () => {
    throw new Error(
      'logue/sense/tempo is multi-outlet -- use renderOutletStatements, not renderExpr'
    )
  },
  renderOutletStatements: (suffix) =>
    `      float y_${suffix}_clock;\n      float y_${suffix}_ramp = tempo_clock_step(&count_${suffix}, tempo_, div_${suffix}, &y_${suffix}_clock);\n`,
  advanceStatement: () => '',
  helpers: [TEMPO_CLOCK_HELPER],
  params: [
    {
      name: 'DIVISION',
      unit: TEMPO_DIVISION_NAME,
      select: {
        count: 10,
        scale: 1,
        label: 'Div',
        names: ['1/16', '1/8T', '1/8', '1/8D', '1/4T', '1/4', '1/4D', '1/2', '1/2D', '1/1']
      },
      min: 0,
      max: 9,
      default: 5,
      step: 1,
      setStatement: (suffix, valueExpr) => `div_${suffix} = (int)(${valueExpr});`
    }
  ]
}

import {
  ENV_MS,
  EXP_DECAY_WIDGET,
  FOLLOWER_ATTACK_MS,
  FOLLOWER_SENS_DB,
  FOLLOWER_RELEASE_MS,
  KNOB_ENV_SHAPE,
  KNOB_ENV_SHAPE_DEVICE_STRINGS,
  KNOB_ENV_SHAPE_NAMES,
  MSEG_MODE_NAME,
  MSEG_STAGE_MS,
  MSEG_TIME_SCALE,
  PERCENT,
  STAGE_NUMBER
} from '../paramPresentation'
import type { HelperBlock, LoguePrimitive, PrimitiveParamSpec } from './types'
import {
  blockDecls,
  blockValue,
  type BlockValue,
  CLAMPF_HELPER,
  ENV_RATE_HELPER,
  TRACK_ON_RAW_THRESHOLD,
  additiveInletExpr,
  isBlockInvariant
} from './shared'

const AD_ENV_STEP_HELPER: HelperBlock = {
  key: 'ad_env_step',
  code: `  // stage: 0 = idle (holds at 0), 1 = attack (ramping to 1), 2 = decay (ramping to 0, then
  // back to idle). Retriggering (note-on, OR a rising edge on a wired trig inlet, while already
  // attacking/decaying) just resets stage to 1 and continues from the CURRENT level, not a hard
  // reset to 0 -- avoids an audible click. The trig edge check runs unconditionally, same as
  // every other optional inlet's own "unwired reads as a harmless constant" convention in this
  // registry -- an unwired trig is always exactly 0.f, so isOpen is always 0.f and never exceeds
  // *prevTrig (which the very same line then holds at 0.f), so this is a real no-op, not merely
  // a cheap one, whenever trig is left unwired.
  static float ad_env_step(int *stage, float *level, float attackRate, float decayRate, float trig, float *prevTrig)
  {
    float trigOpen = (trig >= 0.5f) ? 1.f : 0.f;
    if (trigOpen > *prevTrig) { *stage = 1; }
    *prevTrig = trigOpen;
    if (*stage == 1)
    {
      *level += attackRate;
      if (*level >= 1.f) { *level = 1.f; *stage = 2; }
    }
    else if (*stage == 2)
    {
      *level -= decayRate;
      if (*level <= 0.f) { *level = 0.f; *stage = 0; }
    }
    return *level;
  }
`
}

/**
 * `logue/env/ad`: a one-shot attack-decay "pluck". Note-off is ignored (no `noteOffStatement`),
 * so it always runs to completion however long the note is held; `logue/env/ahd` is the gated
 * variant. The state update lives in `ad_env_step` because the next stage depends on the step
 * just computed; `advanceStatement` is empty on purpose. `attack`/`decay` are additive control
 * inlets (see `envRateExpr`); there's no audio inlet, since nothing passes through an envelope.
 *
 * `trig`: a rising edge (the usual `>=0.5f` gate read) retriggers from a wired signal exactly like
 * a note-on -- `stage_ = 1`, continuing from the current level rather than resetting to 0.
 * Unwired it is `0.f`, which never reads as an edge, so it does nothing; every unit's source
 * still carries the two extra `ad_env_step`/`ahd_env_step` arguments and the `prevTrig_` member.
 * History: docs/HISTORY.md.
 */
const ATTACK_INLET_DEPTH = 50
const DECAY_INLET_DEPTH = 50

/**
 * One stage's own percent-to-per-sample-increment expression, shared by `attack`/`decay` since
 * the two are structurally identical 0-100 percent controls. A wired inlet is ADDITIVE (add,
 * scale by the stage's own `+-50` depth -- half its own 0-100 range, the same derivation rule
 * `WIDTH`/`RATE`/`FM_DEPTH`/`DRIVE` all use -- then clamp back into `[0,100]`), deliberately NOT
 * `vca` `gain`'s full-REPLACE shape: a wired modulator here BENDS a dialed envelope time, it
 * doesn't take it over, so the user's own ATTACK/DECAY dials stay meaningful while something is
 * wired in. Safe to vary per sample: `ad_env_step` takes both rates BY VALUE and
 * `env_rate_from_percent` floors its own sample count at 1, so every rate stays strictly
 * positive and the stage machine still always terminates however wildly a modulator swings.
 */
function envRateExpr(
  suffix: string,
  inlets: Record<string, string | undefined>,
  stage: 'attack' | 'decay',
  depth: number
): string {
  const wired = inlets[stage]
  // Wired: converted every ENV_RATE_CONTROL_PERIOD samples (env_rate_ctl), not every sample -- a
  // clamp and a divide per stage per sample were ~20 % of grain-mill's xd CPU (2026-10-01).
  // Wired from a per-block value, it's a plain block constant (envBlockValues) instead.
  if (wired !== undefined && !isBlockInvariant(wired)) {
    return `env_rate_ctl(&${stage}Ctl_${suffix}, &${stage}Rate_${suffix}, ${stage}Percent_${suffix} + (${wired}) * ${depth}.f)`
  }
  return wired !== undefined
    ? `env_rate_from_percent(${additiveInletExpr(`${stage}Percent`, suffix, wired, depth)})`
    : `env_rate_from_percent(${stage}Percent_${suffix})`
}

/** How often a wired attack/decay time is re-read: 16 samples = 1/3 ms, far below hearing a
 *  time change late (logue/osc/granular's GRANULAR_CONTROL_PERIOD precedent). */
const ENV_RATE_CONTROL_PERIOD = 16

const ENV_RATE_CTL_HELPER: HelperBlock = {
  key: 'env_rate_ctl',
  code: `  // A wired envelope time at control rate: every ${ENV_RATE_CONTROL_PERIOD}th call clamps the percent to 0..100 and
  // converts it (env_rate_from_percent's divide); in between the cached rate is returned. A leaf
  // apart from that conversion.
  static inline __attribute__((always_inline)) float env_rate_ctl(uint32_t *n, float *rate, float percent)
  {
    if ((*n)++ & ${ENV_RATE_CONTROL_PERIOD - 1}u) return *rate;
    percent = percent < 0.f ? 0.f : (percent > 100.f ? 100.f : percent);
    *rate = env_rate_from_percent(percent);
    return *rate;
  }
`
}

/** The members env_rate_ctl keeps per stage (declared whether or not the stage is wired). */
const envRateCtlMembers = (suffix: string): string =>
  `  uint32_t attackCtl_${suffix};\n  float attackRate_${suffix};\n  uint32_t decayCtl_${suffix};\n  float decayRate_${suffix};\n`
const envRateCtlInit = (suffix: string): string =>
  `    attackCtl_${suffix} = 0u;\n    attackRate_${suffix} = 0.f;\n    decayCtl_${suffix} = 0u;\n    decayRate_${suffix} = 0.f;\n`

/** Both stage rates (each a divide), once per block while their inlets are unwired. */
function envBlockValues(
  suffix: string,
  inlets: Record<string, string | undefined>
): Record<'attack' | 'decay', BlockValue> {
  return {
    attack: blockValue(
      'blkAttackRate',
      suffix,
      envRateExpr(suffix, inlets, 'attack', ATTACK_INLET_DEPTH),
      [inlets.attack]
    ),
    decay: blockValue(
      'blkDecayRate',
      suffix,
      envRateExpr(suffix, inlets, 'decay', DECAY_INLET_DEPTH),
      [inlets.decay]
    )
  }
}

/**
 * EXP on: the decay falls by a share of the level each sample instead of a fixed step -- the
 * rate scaled by the level, so DECAY is the time constant (-8.7 dB after it, -60 dB about 7x
 * later), plus a hundredth of the linear step so it still reaches 0 (after ~4.6x DECAY) and goes
 * idle. A time constant rather than "-60 dB at DECAY" (the first version, 2026-09-30): that died
 * so fast that grain-mill's voices were silent long before their next turn (user, on a real
 * NTS-1 mkII). Axoloti grain-mill's grain envelope is this
 * shape (linear attack, exponential decay). The same `ad_env_step`, fed a level-dependent rate.
 */
function adDecayRateExpr(suffix: string, linearRate: string): string {
  return `(exp_${suffix} >= ${TRACK_ON_RAW_THRESHOLD}.f ? (${linearRate}) * (level_${suffix} + 0.01f) : (${linearRate}))`
}

export const adEnvelopePrimitive: LoguePrimitive = {
  id: 'logue/env/ad',
  outletPolarity: 'unipolar',
  // stage_(int) + level_ + attackPercent_ + decayPercent_ + prevTrig_ + exp_, 6 x 4 bytes, and
  // env_rate_ctl's attackCtl_/attackRate_/decayCtl_/decayRate_ (16 B)
  stateBytesPerInstance: 40,
  description:
    'A one-shot Attack-Decay envelope -- always runs its full course once triggered, regardless of note length. A rising edge on trig retriggers it, same as a note-on.',
  inlets: [
    { name: 'attack', role: 'control' },
    { name: 'decay', role: 'control' },
    { name: 'trig', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  int stage_${suffix};\n  float level_${suffix};\n  float attackPercent_${suffix};\n  float decayPercent_${suffix};\n  float prevTrig_${suffix};\n  float exp_${suffix};\n` +
    envRateCtlMembers(suffix),
  initStatement: (suffix) =>
    `    stage_${suffix} = 0;\n    level_${suffix} = 0.f;\n    prevTrig_${suffix} = 0.f;\n` +
    envRateCtlInit(suffix),
  blockConstants: (suffix, inlets) => blockDecls(envBlockValues(suffix, inlets)),
  renderExpr: (suffix, inlets) => {
    const v = envBlockValues(suffix, inlets)
    return `ad_env_step(&stage_${suffix}, &level_${suffix}, ${v.attack.ref}, ${adDecayRateExpr(suffix, v.decay.ref)}, ${inlets.trig ?? '0.f'}, &prevTrig_${suffix})`
  },
  advanceStatement: () => '',
  helpers: [ENV_RATE_HELPER, ENV_RATE_CTL_HELPER, AD_ENV_STEP_HELPER, CLAMPF_HELPER],
  noteOnStatement: (suffix) => `    stage_${suffix} = 1;\n`,
  params: [
    {
      name: 'ATTACK',
      unit: ENV_MS,
      modulatedBy: { inlet: 'attack', shape: 'additive' },
      min: 0,
      max: 100,
      default: 10,
      setStatement: (suffix, valueExpr) => `attackPercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'DECAY',
      unit: ENV_MS,
      modulatedBy: { inlet: 'decay', shape: 'additive' },
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `decayPercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'EXP',
      booleanWidget: EXP_DECAY_WIDGET,
      min: 0,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `exp_${suffix} = ${valueExpr};`
    }
  ]
}

const AHD_ENV_STEP_HELPER: HelperBlock = {
  key: 'ahd_env_step',
  code: `  // stage: 0 = idle (holds at 0), 1 = attack (ramping to 1), 2 = hold (pinned at 1 for as long
  // as the note stays held -- nothing to do here, this function just returns *level unchanged),
  // 3 = decay (ramping back to 0 after note-off, then back to idle). Unlike ad_env_step, stage 2
  // is never advanced BY this function -- only noteOff() (see logue/env/ahd's own doc comment)
  // ever moves it to stage 3, since "how long to hold" is the note's own gate duration, not a
  // dialable time. The trig edge check runs unconditionally and retriggers stage 1 from ANY
  // stage (same as noteOn), same "harmless no-op when trig is left unwired" reasoning
  // ad_env_step's own doc comment gives -- but note a wired trig only ever reaches stage 1
  // (attack); it cannot move stage 2 to stage 3 the way a real note-off does (see
  // logue/env/ahd's own doc comment for why that stays note-off-only).
  static float ahd_env_step(int *stage, float *level, float attackRate, float decayRate, float trig, float *prevTrig)
  {
    float trigOpen = (trig >= 0.5f) ? 1.f : 0.f;
    if (trigOpen > *prevTrig) { *stage = 1; }
    *prevTrig = trigOpen;
    if (*stage == 1)
    {
      *level += attackRate;
      if (*level >= 1.f) { *level = 1.f; *stage = 2; }
    }
    else if (*stage == 3)
    {
      *level -= decayRate;
      if (*level <= 0.f) { *level = 0.f; *stage = 0; }
    }
    return *level;
  }
`
}

/**
 * `logue/env/ahd`: attack, then hold at 1 for as long as the note is held (HOLD is gated, not a
 * time), then decay on note-off. A separate primitive rather than a mode on `logue/env/ad`, so a
 * patch relying on `ad` always running to completion can't start hanging at 1 on a long note.
 *
 * Note-on restarts attack without resetting `level_`, so a retrigger continues from the current
 * level instead of clicking. Note-off acts only in attack or hold (stage 1/2), going straight to
 * decay from the current level; an idle or already-decaying instance ignores it. ATTACK/DECAY
 * share `ad`'s `envRateExpr`/`ENV_RATE_HELPER` and inlet shape.
 *
 * `trig` works as on `logue/env/ad` (see its doc comment) but is a note-on equivalent only: it can
 * restart attack from any stage and never moves hold to decay. Treating its falling edge as a
 * note-off would make it a full external gate, a different feature. History: docs/HISTORY.md.
 */
export const ahdEnvelopePrimitive: LoguePrimitive = {
  id: 'logue/env/ahd',
  // It holds until note-off, which an effect never gets: a trig would start a hold that never ends.
  modules: ['osc'],
  outletPolarity: 'unipolar',
  // stage_(int) + level_ + attackPercent_ + decayPercent_ + prevTrig_, 5 x 4 bytes, and
  // env_rate_ctl's 16 B (see ad)
  stateBytesPerInstance: 36,
  description:
    'An Attack-Hold-Decay envelope -- holds at its peak while the note is held, then decays on note-off. A rising edge on trig retriggers attack, same as a note-on.',
  inlets: [
    { name: 'attack', role: 'control' },
    { name: 'decay', role: 'control' },
    { name: 'trig', role: 'control' }
  ],
  memberDecls: (suffix) =>
    `  int stage_${suffix};\n  float level_${suffix};\n  float attackPercent_${suffix};\n  float decayPercent_${suffix};\n  float prevTrig_${suffix};\n` +
    envRateCtlMembers(suffix),
  initStatement: (suffix) =>
    `    stage_${suffix} = 0;\n    level_${suffix} = 0.f;\n    prevTrig_${suffix} = 0.f;\n` +
    envRateCtlInit(suffix),
  blockConstants: (suffix, inlets) => blockDecls(envBlockValues(suffix, inlets)),
  renderExpr: (suffix, inlets) => {
    const v = envBlockValues(suffix, inlets)
    return `ahd_env_step(&stage_${suffix}, &level_${suffix}, ${v.attack.ref}, ${v.decay.ref}, ${inlets.trig ?? '0.f'}, &prevTrig_${suffix})`
  },
  advanceStatement: () => '',
  helpers: [ENV_RATE_HELPER, ENV_RATE_CTL_HELPER, AHD_ENV_STEP_HELPER, CLAMPF_HELPER],
  noteOnStatement: (suffix) => `    stage_${suffix} = 1;\n`,
  noteOffStatement: (suffix) =>
    `    if (stage_${suffix} == 1 || stage_${suffix} == 2) { stage_${suffix} = 3; }\n`,
  params: [
    {
      name: 'ATTACK',
      unit: ENV_MS,
      modulatedBy: { inlet: 'attack', shape: 'additive' },
      min: 0,
      max: 100,
      default: 10,
      setStatement: (suffix, valueExpr) => `attackPercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'DECAY',
      unit: ENV_MS,
      modulatedBy: { inlet: 'decay', shape: 'additive' },
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `decayPercent_${suffix} = ${valueExpr};`
    }
  ]
}

/** Six stages: enough for attack/decay/sustain/release plus two shaping steps or a 4-step loop. */
const MSEG_STAGES = 6

const MSEG_RATE_HELPER: HelperBlock = {
  key: 'mseg_rate_from_percent',
  code: `  // Stage time: 0 = one sample (a hard step), then 8000*t^3 ms (64 ms at 20, 1 s at 50, 8 s at
  // 100). Called once per block, never per sample.
  static float mseg_rate_from_percent(float percent)
  {
    float t = percent * 0.01f;
    float samples = t * t * t * 8000.f * 48.f;
    if (samples < 1.f) samples = 1.f;
    return 1.f / samples;
  }
`
}

const MSEG_STEP_HELPER: HelperBlock = {
  key: 'mseg_step',
  code: `  // One sample of the multistage envelope. stage 0..5 runs toward levels[stage]; stage 6 is
  // done (holds the last target). A rising gate, or a note-on (*retrig), restarts at stage 0
  // from the current output, so a retrigger never clicks. mode: 0 one-shot (ignores the gate),
  // 1 sustain (sits at the end of stage 'hold' while the gate is high), 2 loop (while the gate
  // is high, stage 'hold' wraps back to stage 'loop'), 3 cycle (always loops; free-runs from
  // power-on). At most one stage change per sample and rate <= 1, so zero-time stages in a loop
  // can't spin. A leaf: no calls into other helpers (the xd call-shape rule).
  static float mseg_step(int *stage, float *phase, float *start, float *out, float *prevGate,
    int *retrig, float *eoc, float gate, const float *levels, float r0, float r1, float r2,
    float r3, float r4, float r5, float timeMul, float depth, float curve, int mode, int hold,
    int loop)
  {
    float g = (gate >= 0.5f) ? 1.f : 0.f;
    int rise = (g > *prevGate) || *retrig;
    *prevGate = g;
    *retrig = 0;
    *eoc = 0.f;
    if (hold < 0) hold = 0; else if (hold > 5) hold = 5;
    if (loop < 0) loop = 0; else if (loop > hold) loop = hold;
    if (rise || (mode == 3 && *stage >= 6)) { *stage = 0; *phase = 0.f; *start = *out; }
    int s = *stage;
    if (s >= 6) return *out;
    float rate = s == 0 ? r0 : s == 1 ? r1 : s == 2 ? r2 : s == 3 ? r3 : s == 4 ? r4 : r5;
    rate *= timeMul;
    if (rate > 1.f) rate = 1.f;
    float target = levels[s] * depth;
    *phase += rate;
    if (*phase >= 1.f)
    {
      *phase = 1.f;
      int held = g >= 0.5f;
      if (!(s == hold && held && mode == 1))
      {
        *start = target;
        *phase = 0.f;
        if (s == hold && ((mode == 2 && held) || mode == 3)) { *stage = loop; *eoc = 1.f; }
        else if (s == 5) { *stage = 6; *eoc = 1.f; }
        else *stage = s + 1;
        *out = target;
        return *out;
      }
    }
    // curve > 0: fast start, slow end (RC-like either way); < 0: slow start; 0: linear.
    float t = *phase;
    float u = 1.f - t;
    float bent = curve >= 0.f ? t + curve * ((1.f - u * u * u) - t) : t - curve * (t * t * t - t);
    *out = *start + (target - *start) * bent;
    return *out;
  }
`
}

const MSEG_DEPTH_INLET_DEPTH = 100
const MSEG_TIME_INLET_DEPTH = 50

/** 0.1x at 0, 1x at 50, 10x at 100 -- the stage-time multiplier, inverted into a rate multiplier. */
function msegTimeMulExpr(percent: string): string {
  return `(1.f / ((${percent}) < 50.f ? 0.1f + 0.018f * (${percent}) : 1.f + 0.18f * ((${percent}) - 50.f)))`
}

function msegBlockValues(
  suffix: string,
  inlets: Record<string, string | undefined>
): { rates: BlockValue[]; timeMul: BlockValue } {
  const rates = Array.from({ length: MSEG_STAGES }, (_, i) =>
    blockValue(`blkMsegRate${i}`, suffix, `mseg_rate_from_percent(stageTime_${suffix}[${i}])`, [])
  )
  const timePercent =
    inlets.time !== undefined
      ? additiveInletExpr('timePercent', suffix, inlets.time, MSEG_TIME_INLET_DEPTH)
      : `timePercent_${suffix}`
  const timeMul = blockValue('blkMsegTimeMul', suffix, msegTimeMulExpr(timePercent), [inlets.time])
  return { rates, timeMul }
}

/**
 * `logue/env/multistage`: a six-stage breakpoint envelope meant for modulation (on the device the
 * unit's output already goes through the synth's own filter and amp envelopes). Each stage ramps
 * from wherever the output is to its bipolar level `L<n>` over `T<n>`, bent by one `CURVE`.
 *
 * - `MODE`: one-shot (runs all six stages, ignores release), sustain (sits at the end of stage
 *   `HOLD` while the gate is held, then finishes), loop (while held, the end of stage `HOLD`
 *   jumps back to stage `LOOP`; on release it runs on to the end), cycle (always loops, a drawn
 *   LFO that free-runs from power-on and restarts on a gate).
 * - Fewer stages: give the unused ones time 0 and the previous level -- a one-sample no-op.
 * - Gate: a wired `gate` (the usual `>=0.5f` read) replaces the played note; unwired, note-on
 *   and note-off drive it. A note-on always restarts, legato included, like `ad`/`ahd`.
 * - `eoc` outlet: a one-sample gate pulse at each loop wrap and at the end of the last stage, for
 *   chaining, clocking a `sample-hold` or stepping a `mux`.
 * - `TIME` scales every stage time (0.1x-10x) and `DEPTH` every level (-100..100%), so one
 *   device knob each can reshape the whole envelope; both have additive inlets.
 * - Cost: the six stage rates are computed per block; per sample it is one ramp step, a stage
 *   check and the curve (a few multiplies). `HOLD`/`LOOP`/`MODE` are 0-based selects, so the xd
 *   shows them as 1..N; NTS-1 mkII shows mode names.
 */
export const multistageEnvelopePrimitive: LoguePrimitive = {
  id: 'logue/env/multistage',
  outletPolarity: { env: 'bipolar', eoc: 'gate' },
  // levels[6] + stageTime[6] + curve/mode/hold/loop/time/depth (18 floats) + stage/retrig (ints)
  // + phase/start/out/prevGate/noteHeld/eoc (6 floats): 26 x 4 bytes
  stateBytesPerInstance: 104,
  description:
    'A six-stage envelope for modulation: each stage ramps to its own level (L1-L6, bipolar) over its own time (T1-T6). MODE picks one-shot, sustain (holds at stage HOLD), loop (repeats stages LOOP-HOLD while held) or cycle (a free-running drawn LFO). TIME and DEPTH scale the whole shape. eoc pulses at each loop and at the end.',
  inlets: [
    { name: 'gate', role: 'control' },
    { name: 'time', role: 'control' },
    { name: 'depth', role: 'control' }
  ],
  outlets: [{ name: 'env' }, { name: 'eoc' }],
  memberDecls: (suffix) =>
    `  float level_${suffix}[${MSEG_STAGES}];\n  float stageTime_${suffix}[${MSEG_STAGES}];\n` +
    `  float curvePercent_${suffix};\n  float mode_${suffix};\n  float hold_${suffix};\n  float loop_${suffix};\n` +
    `  float timePercent_${suffix};\n  float depthPercent_${suffix};\n` +
    `  int stage_${suffix};\n  int retrig_${suffix};\n  float phase_${suffix};\n  float start_${suffix};\n` +
    `  float out_${suffix};\n  float prevGate_${suffix};\n  float noteHeld_${suffix};\n  float eoc_${suffix};\n`,
  initStatement: (suffix) =>
    `    stage_${suffix} = 6;\n    retrig_${suffix} = 0;\n    phase_${suffix} = 0.f;\n    start_${suffix} = 0.f;\n` +
    `    out_${suffix} = 0.f;\n    prevGate_${suffix} = 0.f;\n    noteHeld_${suffix} = 0.f;\n    eoc_${suffix} = 0.f;\n`,
  blockConstants: (suffix, inlets) => {
    const v = msegBlockValues(suffix, inlets)
    return blockDecls({
      ...Object.fromEntries(v.rates.map((r, i) => [`r${i}`, r])),
      timeMul: v.timeMul
    })
  },
  renderExpr: () => {
    throw new Error('logue/env/multistage is multi-outlet -- use renderOutletStatements')
  },
  renderOutletStatements: (suffix, inlets) => {
    const v = msegBlockValues(suffix, inlets)
    const depth =
      inlets.depth !== undefined
        ? `(${additiveInletExpr('depthPercent', suffix, inlets.depth, MSEG_DEPTH_INLET_DEPTH, -100, 100)} * 0.01f)`
        : `(depthPercent_${suffix} * 0.01f)`
    const gate = inlets.gate ?? `noteHeld_${suffix}`
    const rates = v.rates.map((r) => r.ref).join(', ')
    // A wired gate replaces the note entirely, so a note-on must not restart it.
    const ignoreNote = inlets.gate !== undefined ? `      retrig_${suffix} = 0;\n` : ''
    return (
      ignoreNote +
      `      float y_${suffix}_env = mseg_step(&stage_${suffix}, &phase_${suffix}, &start_${suffix}, &out_${suffix}, &prevGate_${suffix}, &retrig_${suffix}, &eoc_${suffix}, ${gate}, level_${suffix}, ${rates}, ${v.timeMul.ref}, ${depth}, curvePercent_${suffix} * 0.01f, (int)mode_${suffix}, (int)hold_${suffix}, (int)loop_${suffix});\n` +
      `      float y_${suffix}_eoc = eoc_${suffix};\n` +
      `      (void)y_${suffix}_env; (void)y_${suffix}_eoc;\n`
    )
  },
  advanceStatement: () => '',
  helpers: [MSEG_RATE_HELPER, MSEG_STEP_HELPER, CLAMPF_HELPER],
  noteOnStatement: (suffix) => `    noteHeld_${suffix} = 1.f;\n    retrig_${suffix} = 1;\n`,
  noteOffStatement: (suffix) => `    noteHeld_${suffix} = 0.f;\n`,
  params: [
    ...[100, 50, 70, 30, 15, 0].map((level, i) => ({
      name: `L${i + 1}`,
      unit: PERCENT,
      min: -100,
      max: 100,
      default: level,
      setStatement: (suffix: string, valueExpr: string) =>
        `level_${suffix}[${i}] = (${valueExpr}) * 0.01f;`
    })),
    ...[15, 25, 25, 25, 25, 35].map((time, i) => ({
      name: `T${i + 1}`,
      unit: MSEG_STAGE_MS,
      min: 0,
      max: 100,
      default: time,
      setStatement: (suffix: string, valueExpr: string) =>
        `stageTime_${suffix}[${i}] = ${valueExpr};`
    })),
    {
      name: 'CURVE',
      min: -100,
      max: 100,
      default: 0,
      setStatement: (suffix, valueExpr) => `curvePercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'MODE',
      unit: MSEG_MODE_NAME,
      select: {
        count: 4,
        scale: 1,
        label: 'Mode',
        names: ['OneShot', 'Sustain', 'Loop', 'Cycle']
      },
      min: 0,
      max: 3,
      default: 1,
      step: 1,
      setStatement: (suffix, valueExpr) => `mode_${suffix} = ${valueExpr};`
    },
    {
      name: 'HOLD',
      unit: STAGE_NUMBER,
      select: { count: MSEG_STAGES, scale: 1, label: 'St' },
      min: 0,
      max: MSEG_STAGES - 1,
      default: 1,
      step: 1,
      setStatement: (suffix, valueExpr) => `hold_${suffix} = ${valueExpr};`
    },
    {
      name: 'LOOP',
      unit: STAGE_NUMBER,
      select: { count: MSEG_STAGES, scale: 1, label: 'St' },
      min: 0,
      max: MSEG_STAGES - 1,
      default: 0,
      step: 1,
      setStatement: (suffix, valueExpr) => `loop_${suffix} = ${valueExpr};`
    },
    {
      name: 'TIME',
      unit: MSEG_TIME_SCALE,
      modulatedBy: { inlet: 'time', shape: 'additive' },
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `timePercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'DEPTH',
      unit: PERCENT,
      modulatedBy: { inlet: 'depth', shape: 'additive' },
      min: -100,
      max: 100,
      default: 100,
      setStatement: (suffix, valueExpr) => `depthPercent_${suffix} = ${valueExpr};`
    }
  ]
}

/**
 * Decay and release approach their target exponentially and get within 1 % of it at the
 * stage's time (ln 100 = 4.6 time constants), so a stage time means the same as a linear
 * stage's: how long until it's there.
 */
const ADSR_EXP_K = '4.6052f'

const ADSR_RATE_HELPER: HelperBlock = {
  key: 'adsr_rate',
  code: `  // A stage time as a per-sample rate: percent 0..100 is 8000*t^3 ms (mseg_rate_from_percent's
  // curve: one sample at 0, 1 s at 50, 8 s at 100), times k, capped at 1 so an exponential step
  // never overshoots. A leaf.
  static float adsr_rate(float percent, float k)
  {
    float t = percent * 0.01f;
    float samples = t * t * t * 384000.f;
    if (samples < 1.f) samples = 1.f;
    float r = k / samples;
    return r > 1.f ? 1.f : r;
  }
`
}

const ADSR_STEP_HELPER: HelperBlock = {
  key: 'adsr_env_step',
  code: `  // stage: 0 idle, 1 attack (linear to 1), 2 decay toward the sustain level (exponential, then
  // sits there and follows a moved sustain), 3 release (exponential to 0, then idle). A rising
  // gate or a note-on (*retrig) restarts the attack from the current level; a low gate during
  // attack or sustain releases from the current level -- by level, not by edge, so a note that
  // ends in the block it started still releases. The 0.01 under the release's target lets it
  // reach 0 and go idle. A leaf.
  static float adsr_env_step(int *stage, float *level, float *prevGate, int *retrig, float gate,
    float attackRate, float decayRate, float sustain, float releaseRate)
  {
    float g = (gate >= 0.5f) ? 1.f : 0.f;
    if (g > *prevGate || *retrig) *stage = 1;
    if (g < 0.5f && (*stage == 1 || *stage == 2)) *stage = 3;
    *prevGate = g;
    *retrig = 0;
    float l = *level;
    if (*stage == 1)
    {
      l += attackRate;
      if (l >= 1.f) { l = 1.f; *stage = 2; }
    }
    else if (*stage == 2)
    {
      l += (sustain - l) * decayRate;
    }
    else if (*stage == 3)
    {
      l -= (l + 0.01f) * releaseRate;
      if (l <= 0.f) { l = 0.f; *stage = 0; }
    }
    *level = l;
    return l;
  }
`
}

/** The members both ADSR-shaped envelopes keep for `adsr_env_step` and the note. */
const adsrStateMembers = (suffix: string): string =>
  `  int stage_${suffix};\n  int retrig_${suffix};\n  float level_${suffix};\n  float prevGate_${suffix};\n  float noteHeld_${suffix};\n`
const adsrStateInit = (suffix: string): string =>
  `    stage_${suffix} = 0;\n    retrig_${suffix} = 0;\n    level_${suffix} = 0.f;\n    prevGate_${suffix} = 0.f;\n    noteHeld_${suffix} = 0.f;\n`

/** One sample of `adsr_env_step`; a wired gate replaces the note, so a note-on can't restart it. */
function adsrStepExpr(
  suffix: string,
  gate: string | undefined,
  rates: [string, string, string, string]
): string {
  const ignoreNote = gate !== undefined ? `(retrig_${suffix} = 0, ` : '('
  return `${ignoreNote}adsr_env_step(&stage_${suffix}, &level_${suffix}, &prevGate_${suffix}, &retrig_${suffix}, ${gate ?? `noteHeld_${suffix}`}, ${rates.join(', ')}))`
}

const adsrNoteOn = (suffix: string): string =>
  `    noteHeld_${suffix} = 1.f;\n    retrig_${suffix} = 1;\n`
const adsrNoteOff = (suffix: string): string => `    noteHeld_${suffix} = 0.f;\n`

const adsrTimeParam = (name: string, member: string, def: number): PrimitiveParamSpec => ({
  name,
  unit: MSEG_STAGE_MS,
  min: 0,
  max: 100,
  default: def,
  setStatement: (suffix: string, valueExpr: string) => `${member}_${suffix} = ${valueExpr};`
})

/**
 * `logue/env/adsr`: the classic four-stage envelope. Attack is linear; decay and release are
 * exponential (an analog ADSR's shape: a pluck or piano decay sounds natural without a curve
 * param), each reaching its target within 1 % at its time. Times use `env/multistage`'s cubic
 * curve (one sample .. 8 s). A wired `gate` replaces the played note, which also makes it usable
 * in an effect; unwired, note-on (legato too) restarts the attack from the current level and
 * note-off releases. All four rates are per block. `logue/env/one-knob-adsr` is the same core
 * with its stages from one SHAPE knob.
 */
export const adsrEnvelopePrimitive: LoguePrimitive = {
  id: 'logue/env/adsr',
  outletPolarity: 'unipolar',
  // stage_/retrig_ (ints) + level_/prevGate_/noteHeld_ + 4 stage percents: 9 x 4 bytes
  stateBytesPerInstance: 36,
  description:
    'A classic ADSR envelope: linear attack, exponential decay to the SUSTAIN level, exponential release on note-off. A wired gate replaces the played note.',
  inlets: [{ name: 'gate', role: 'control' }],
  memberDecls: (suffix) =>
    adsrStateMembers(suffix) +
    `  float attackPercent_${suffix};\n  float decayPercent_${suffix};\n  float sustainPercent_${suffix};\n  float releasePercent_${suffix};\n`,
  initStatement: adsrStateInit,
  blockConstants: (suffix) => blockDecls(adsrBlockValues(suffix)),
  renderExpr: (suffix, inlets) => {
    const v = adsrBlockValues(suffix)
    return adsrStepExpr(suffix, inlets.gate, [v.a.ref, v.d.ref, v.s.ref, v.r.ref])
  },
  advanceStatement: () => '',
  helpers: [ADSR_RATE_HELPER, ADSR_STEP_HELPER],
  noteOnStatement: adsrNoteOn,
  noteOffStatement: adsrNoteOff,
  params: [
    adsrTimeParam('ATTACK', 'attackPercent', 10),
    adsrTimeParam('DECAY', 'decayPercent', 40),
    {
      name: 'SUSTAIN',
      unit: PERCENT,
      min: 0,
      max: 100,
      default: 70,
      setStatement: (suffix, valueExpr) => `sustainPercent_${suffix} = ${valueExpr};`
    },
    adsrTimeParam('RELEASE', 'releasePercent', 35)
  ]
}

function adsrBlockValues(suffix: string): Record<'a' | 'd' | 's' | 'r', BlockValue> {
  return {
    a: blockValue('blkAdsrA', suffix, `adsr_rate(attackPercent_${suffix}, 1.f)`, []),
    d: blockValue('blkAdsrD', suffix, `adsr_rate(decayPercent_${suffix}, ${ADSR_EXP_K})`, []),
    s: blockValue('blkAdsrS', suffix, `(sustainPercent_${suffix} * 0.01f)`, []),
    r: blockValue('blkAdsrR', suffix, `adsr_rate(releasePercent_${suffix}, ${ADSR_EXP_K})`, [])
  }
}

/**
 * The one-knob envelope's stations, in `KNOB_ENV_SHAPE_NAMES`' order: attack, decay, sustain
 * (0..1), release; times in ms (decay/release: until within 1 % of the target, see
 * `ADSR_EXP_K`). Where a stage doesn't matter (decay at full sustain), the value is picked so
 * the neighbours blend smoothly. Attacks are at least 1 ms at TIME 1x so the amp envelope doesn't
 * click (TIME below 1x shortens them too).
 * Ear-picked starting points, not measured.
 */
const KNOB_ENV_STATIONS: ReadonlyArray<readonly [number, number, number, number]> = [
  [1, 40, 0, 40], // Blip
  [1, 250, 0, 200], // Pluck
  [1, 600, 0, 600], // Mallet
  [2, 2000, 0, 300], // Piano: letting go damps it
  [2, 800, 0.4, 400], // Keys
  [2, 300, 1, 10], // Gate
  [2, 300, 1, 300], // Organ
  [40, 300, 0.7, 150], // Brass
  [250, 500, 1, 600], // Strings
  [800, 1000, 0.8, 1000], // Bowed
  [2000, 1500, 0, 1500], // Swell: rises, then fades even while held
  [2000, 2000, 0.7, 3000], // Pad
  [5000, 3000, 1, 8000] // Drone
]

/** A time in ms as `adsr_rate`'s percent (the inverse of its 8000*t^3 ms). */
const msToStagePercent = (ms: number): number => 100 * Math.cbrt(ms / 8000)

const KNOB_ENV_TABLE: number[] = KNOB_ENV_STATIONS.flatMap(([a, d, s, r]) => [
  msToStagePercent(a),
  msToStagePercent(d),
  s,
  msToStagePercent(r)
])

const KNOB_ENV_VALUE_HELPER: HelperBlock = {
  key: 'knob_env_value',
  sharedBytes: KNOB_ENV_TABLE.length * 4,
  code: `  // One stage of the one-knob envelope at SHAPE percent: column 0..3 = attack/decay/release
  // time percent (adsr_rate's curve) or sustain (col 2, 0..1). The ${KNOB_ENV_STATIONS.length} stations sit every
  // ${(100 / (KNOB_ENV_STATIONS.length - 1)).toFixed(2)} %; within a fifth of a station's spacing it is exactly that station, in
  // between the two are blended (times on that cube-root curve, close to a log blend). A leaf.
  static float knob_env_value(float shape, int col)
  {
    static const float knob_env_table[${KNOB_ENV_TABLE.length}] = {${KNOB_ENV_TABLE.map((v) => `${v.toFixed(4)}f`).join(', ')}};
    float pos = (shape < 0.f ? 0.f : (shape > 100.f ? 100.f : shape)) * ${((KNOB_ENV_STATIONS.length - 1) / 100).toFixed(2)}f;
    int i = (int)pos;
    if (i > ${KNOB_ENV_STATIONS.length - 2}) i = ${KNOB_ENV_STATIONS.length - 2};
    float f = (pos - (float)i - 0.2f) * (1.f / 0.6f);
    f = f < 0.f ? 0.f : (f > 1.f ? 1.f : f);
    const float *row = knob_env_table + i * 4 + col;
    return row[0] + (row[4] - row[0]) * f;
  }
`
}

const KNOB_ENV_TIME_HELPER: HelperBlock = {
  key: 'knob_env_time_mul',
  code: `  // TIME percent as a rate multiplier: env/multistage's 0.1x at 0, 1x at 50, 10x at 100 (as
  // stage times), clamped. A leaf.
  static float knob_env_time_mul(float percent)
  {
    percent = percent < 0.f ? 0.f : (percent > 100.f ? 100.f : percent);
    return 1.f / (percent < 50.f ? 0.1f + 0.018f * percent : 1.f + 0.18f * (percent - 50.f));
  }
`
}

/** How often a moving SHAPE/TIME is re-read: as `env_rate_ctl`. */
const KNOB_ENV_CONTROL_PERIOD = ENV_RATE_CONTROL_PERIOD

const KNOB_ENV_CTL_HELPER: HelperBlock = {
  key: 'knob_env_step_ctl',
  code: `  // The one-knob envelope while SHAPE or TIME is wired to something that moves: every
  // ${KNOB_ENV_CONTROL_PERIOD}th sample the four stage values are re-read into rates[], then one adsr_env_step.
  // Inlined, so its calls are leaf calls from process.
  static inline __attribute__((always_inline)) float knob_env_step_ctl(int *stage, float *level,
    float *prevGate, int *retrig, float gate, uint32_t *n, float *rates, float shape, float timePercent)
  {
    if (((*n)++ & ${KNOB_ENV_CONTROL_PERIOD - 1}u) == 0u)
    {
      float m = knob_env_time_mul(timePercent);
      rates[0] = adsr_rate(knob_env_value(shape, 0), m);
      rates[1] = adsr_rate(knob_env_value(shape, 1), ${ADSR_EXP_K} * m);
      rates[2] = knob_env_value(shape, 2);
      rates[3] = adsr_rate(knob_env_value(shape, 3), ${ADSR_EXP_K} * m);
    }
    return adsr_env_step(stage, level, prevGate, retrig, gate, rates[0], rates[1], rates[2], rates[3]);
  }
`
}

/**
 * SHAPE's wired depth is its whole range (100), not the usual half: like crossfader `fade` and
 * additive `timbre` it picks a place on a morph, so one LFO or velocity reading should be able to
 * reach every station.
 */
const KNOB_ENV_SHAPE_INLET_DEPTH = 100
const KNOB_ENV_TIME_INLET_DEPTH = 50

function knobEnvInputs(
  suffix: string,
  inlets: Record<string, string | undefined>
): { shape: string; time: string; moving: boolean } {
  return {
    shape:
      inlets.shape !== undefined
        ? `(shapePercent_${suffix} + (${inlets.shape}) * ${KNOB_ENV_SHAPE_INLET_DEPTH}.f)`
        : `shapePercent_${suffix}`,
    time:
      inlets.time !== undefined
        ? `(timePercent_${suffix} + (${inlets.time}) * ${KNOB_ENV_TIME_INLET_DEPTH}.f)`
        : `timePercent_${suffix}`,
    moving: !isBlockInvariant(inlets.shape) || !isBlockInvariant(inlets.time)
  }
}

function knobEnvBlockValues(
  suffix: string,
  inlets: Record<string, string | undefined>
): Record<'m' | 'a' | 'd' | 's' | 'r', BlockValue> | undefined {
  const { shape, time, moving } = knobEnvInputs(suffix, inlets)
  if (moving) return undefined
  const m = blockValue('blkKnobEnvM', suffix, `knob_env_time_mul(${time})`, [inlets.time])
  const stage = (name: string, col: number, k: string): BlockValue =>
    blockValue(name, suffix, `adsr_rate(knob_env_value(${shape}, ${col}), ${k}${m.ref})`, [
      inlets.shape,
      inlets.time
    ])
  return {
    m,
    a: stage('blkKnobEnvA', 0, ''),
    d: stage('blkKnobEnvD', 1, `${ADSR_EXP_K} * `),
    s: blockValue('blkKnobEnvS', suffix, `knob_env_value(${shape}, 2)`, [inlets.shape]),
    r: stage('blkKnobEnvR', 3, `${ADSR_EXP_K} * `)
  }
}

/**
 * `logue/env/one-knob-adsr`: `logue/env/adsr` with all four stages picked by one SHAPE knob, for
 * a unit with few controls -- after the Axoloti `one-knob-adsr` subpatch (a dial reading four
 * 16-step tables). SHAPE runs short to long through ${KNOB_ENV_STATIONS.length} stations (`KNOB_ENV_SHAPE_NAMES`):
 * percussive ones first, then sustained, then slow swells and pads; between stations the stages
 * blend, so every knob position is usable. TIME scales every stage (0.1x-10x) for a second knob.
 * The canvas and the NTS-1 mkII display name the station ("Pluck", or "Plk-Mlt" between two).
 * Gate and note handling are `adsr`'s. Unwired (or wired from per-block values) SHAPE and TIME
 * make all four stages per-block constants; wired from something moving, they're re-read every
 * ${KNOB_ENV_CONTROL_PERIOD} samples (`knob_env_step_ctl`).
 */
export const oneKnobAdsrPrimitive: LoguePrimitive = {
  id: 'logue/env/one-knob-adsr',
  outletPolarity: 'unipolar',
  searchTerms: ['envelope', 'preset', 'shape'],
  // stage_/retrig_ (ints) + level_/prevGate_/noteHeld_ + shapePercent_/timePercent_ + ctl_
  // (uint32) + rates_[4]: 12 x 4 bytes
  stateBytesPerInstance: 48,
  description: `An ADSR whose four stages come from one SHAPE knob, short to long: ${KNOB_ENV_SHAPE_NAMES.join(', ')}. In-between positions blend two neighbours. TIME stretches the whole shape. A wired gate replaces the played note.`,
  inlets: [
    { name: 'gate', role: 'control' },
    { name: 'shape', role: 'control' },
    { name: 'time', role: 'control' }
  ],
  memberDecls: (suffix) =>
    adsrStateMembers(suffix) +
    `  float shapePercent_${suffix};\n  float timePercent_${suffix};\n  uint32_t ctl_${suffix};\n  float rates_${suffix}[4];\n`,
  initStatement: (suffix) =>
    adsrStateInit(suffix) +
    `    ctl_${suffix} = 0u;\n    rates_${suffix}[0] = 0.f;\n    rates_${suffix}[1] = 0.f;\n    rates_${suffix}[2] = 0.f;\n    rates_${suffix}[3] = 0.f;\n`,
  blockConstants: (suffix, inlets) => {
    const v = knobEnvBlockValues(suffix, inlets)
    return v ? blockDecls(v) : []
  },
  renderExpr: (suffix, inlets) => {
    const v = knobEnvBlockValues(suffix, inlets)
    if (v) return adsrStepExpr(suffix, inlets.gate, [v.a.ref, v.d.ref, v.s.ref, v.r.ref])
    const { shape, time } = knobEnvInputs(suffix, inlets)
    const ignoreNote = inlets.gate !== undefined ? `(retrig_${suffix} = 0, ` : '('
    return `${ignoreNote}knob_env_step_ctl(&stage_${suffix}, &level_${suffix}, &prevGate_${suffix}, &retrig_${suffix}, ${inlets.gate ?? `noteHeld_${suffix}`}, &ctl_${suffix}, rates_${suffix}, ${shape}, ${time}))`
  },
  advanceStatement: () => '',
  helpers: [
    ADSR_RATE_HELPER,
    ADSR_STEP_HELPER,
    KNOB_ENV_VALUE_HELPER,
    KNOB_ENV_TIME_HELPER,
    KNOB_ENV_CTL_HELPER
  ],
  noteOnStatement: adsrNoteOn,
  noteOffStatement: adsrNoteOff,
  params: [
    {
      name: 'SHAPE',
      unit: KNOB_ENV_SHAPE,
      nts1mkiiStrings: KNOB_ENV_SHAPE_DEVICE_STRINGS,
      modulatedBy: { inlet: 'shape', shape: 'additive', depth: 100 },
      min: 0,
      max: 100,
      default: 17,
      setStatement: (suffix, valueExpr) => `shapePercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'TIME',
      unit: MSEG_TIME_SCALE,
      modulatedBy: { inlet: 'time', shape: 'additive' },
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `timePercent_${suffix} = ${valueExpr};`
    }
  ]
}

const FOLLOWER_STEP_HELPER: HelperBlock = {
  key: 'follower_step',
  code: `  // The level of x: its rectified value, times gain, followed by a one-pole that rises with
  // the attack coefficient and falls with the release one. Clamped to the unipolar 0..1. A leaf.
  static float follower_step(float *env, float x, float gain, float attack, float release)
  {
    const float r = (x < 0.f ? -x : x) * gain;
    *env += (r > *env ? attack : release) * (r - *env);
    return *env > 1.f ? 1.f : *env;
  }
`
}

/** A one-pole coefficient for a time constant of `msExpr` milliseconds at 48 kHz. */
function onePoleCoeffExpr(msExpr: string): string {
  return `(1.f / (1.f + (${msExpr}) * 48.f))`
}

/**
 * `logue/env/follower`: the level of an audio signal as a unipolar control -- for a ducker (a
 * VCA's gain from 1 minus the follower of the input), an auto-wah (a filter cutoff), dynamics-
 * driven anything. ATTACK 0.1-100 ms and RELEASE 1 ms-2 s (both squared); SENS is a gain of
 * 0..+24 dB before the clamp to 1, shown as the input level that reaches full output (0 .. -24
 * dB), since an effect's input sits well below full scale (a saw peaks near 0.18 on the NTS-1
 * mkII, docs/PLAN-effects.md). Below that level the output follows the input proportionally,
 * so it is no gate threshold. It was GAIN until 2026-10-03 (a gain, but what it decides is where
 * the output tops out: the Radio patch's follower sat at 1 the whole time). Works in
 * oscillators too (following another oscillator's output). The two coefficients are per block.
 */
export const followerPrimitive: LoguePrimitive = {
  id: 'logue/env/follower',
  outletPolarity: 'unipolar',
  // env_, attackPercent_, releasePercent_, gainPercent_ (4 x 4 B).
  stateBytesPerInstance: 16,
  description:
    "An envelope follower: the input's level (0..1) with ATTACK and RELEASE. SENS sets the input level that gives full output (0 to -24 dB, as an effect's input is quiet); louder input stays at 1. For ducking, auto-wah, dynamics.",
  inlets: [{ name: 'in', role: 'audio' }],
  memberDecls: (suffix) =>
    `  float env_${suffix};\n  float attackPercent_${suffix};\n  float releasePercent_${suffix};\n  float gainPercent_${suffix};\n`,
  initStatement: (suffix) => `    env_${suffix} = 0.f;\n`,
  blockConstants: (suffix) => blockDecls(followerValues(suffix)),
  renderExpr: (suffix, inlets) => {
    const v = followerValues(suffix)
    return `follower_step(&env_${suffix}, ${inlets.in ?? '0.f'}, 1.f + gainPercent_${suffix} * 0.15f, ${v.attack.ref}, ${v.release.ref})`
  },
  advanceStatement: () => '',
  helpers: [FOLLOWER_STEP_HELPER],
  params: [
    {
      name: 'ATTACK',
      unit: FOLLOWER_ATTACK_MS,
      min: 0,
      max: 100,
      default: 15,
      setStatement: (suffix, valueExpr) => `attackPercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'RELEASE',
      unit: FOLLOWER_RELEASE_MS,
      min: 0,
      max: 100,
      default: 35,
      setStatement: (suffix, valueExpr) => `releasePercent_${suffix} = ${valueExpr};`
    },
    {
      name: 'SENS',
      unit: FOLLOWER_SENS_DB,
      min: 0,
      max: 100,
      default: 50,
      setStatement: (suffix, valueExpr) => `gainPercent_${suffix} = ${valueExpr};`
    }
  ],
  renamedParams: [{ from: 'GAIN', to: 'SENS', valuePreserving: true }]
}

function followerValues(suffix: string): Record<'attack' | 'release', BlockValue> {
  const t = (member: string): string => `(${member}_${suffix} * 0.01f)`
  const a = t('attackPercent')
  const r = t('releasePercent')
  return {
    attack: blockValue('blkAtt', suffix, onePoleCoeffExpr(`0.1f + 99.9f * ${a} * ${a}`), []),
    release: blockValue('blkRel', suffix, onePoleCoeffExpr(`1.f + 1999.f * ${r} * ${r}`), [])
  }
}

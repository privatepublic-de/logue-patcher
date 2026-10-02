/**
 * One-off, throwaway MEASUREMENT SPIKE (not part of the app, not wired into any UI) -- the first
 * real, controlled, single-primitive instruction-count measurement this project has ever taken,
 * comparing an 8-mode vs 16-mode Rings/Plaits-style modal resonator bank (a bank of N parallel
 * SVF band-pass "modes" summed together) to pick a defensible mode count before ever writing a
 * real `logue/resonator/modal`-shaped primitive into primitives.ts. Kept as a playbook template
 * (same reasoning as `stageFormantCrashBisect*.ts`), not deleted after use -- only the staged
 * logue-sdk project directories this produces are meant to be `rm -rf`'d after measuring.
 *
 * Does NOT touch primitives.ts or the app. Follows the exact `stageCombFilter.ts`/
 * `stageFormantCrashBisect.ts` precedent: stage a minimal real project via
 * `generateOldGenOscUnit` (saw -> svf -> audio-out, so the generated osc.cpp already contains a
 * real, hardware-proven `svf_step`/`svf_g_free`/`svf_k_from_percent` verbatim -- see
 * `logue-codegen/src/primitives.ts`'s `svfFilterPrimitive`), then HAND-EDITS that generated
 * osc.cpp text (string surgery on known-exact generated text, confirmed by probing the generator
 * directly before writing this) to splice in a modal resonator bank as two new PRIVATE STATIC
 * MEMBER functions of the generated `Osc` class (private static, not free functions, specifically
 * so they can call the class's own private `svf_step`/`svf_g_free`/`svf_k_from_percent` directly,
 * unqualified):
 *
 *   - `resonator_refresh_one_mode()`: round-robin coefficient refresh, ONE mode's g_/k_
 *     recomputed per call, cycling through all N modes across successive calls (Rings' own
 *     documented amortization technique, also used by the real-shipped
 *     `peterall/eurorack-prologue` port). Called ONCE PER BLOCK (i.e. once per `process()` call,
 *     before the per-sample loop) -- NOT once per sample.
 *   - `resonator_process_modes(float in)`: the per-sample N-mode loop, running the existing
 *     `svf_step` band-pass recurrence against the oscillator's own `y_saw1` signal for every
 *     mode, summing (scaled by 1/N) into the returned sample.
 *
 * Both are marked `__attribute__((noinline))` so they show up as isolable symbols in
 * `arm-none-eabi-objdump -d` output -- ONLY for this measurement; a real shipping primitive would
 * let the compiler inline/optimize freely. Per-mode state (`modeS1_`/`modeS2_`/`modeG_`/
 * `modeK_`, arrays of `kNumModes`) and `refreshIdx_` are added as ordinary private members,
 * initialized to 0 in `init()`.
 *
 * **Empirical finding worth knowing before reusing this template**: at `-Os`, GCC does NOT
 * unroll `resonator_process_modes`'s per-mode loop -- confirmed by diffing the FULL disassembly
 * of the 8-mode and 16-mode builds: the only bytes that differ anywhere in the whole `.text`
 * section are the literal loop-bound immediates at the two call sites (`movs r3, #8` -> `#16`)
 * and memory offsets shifted by the larger `.bss` arrays. `resonator_process_modes`'s own function
 * body (35 static instructions) and `resonator_refresh_one_mode`'s (38) are BYTE-IDENTICAL
 * between the two builds. This means "static disassembly line count" is the wrong proxy for
 * per-mode CPU cost with this loop-based design -- the real per-mode cost only shows up as
 * increased LOOP TRIP COUNT (a dynamic/runtime multiplier), not increased code size. A future
 * user of this script should compute dynamic (executed) instruction count -- preamble/postamble
 * once + (loop-check + loop-body + the non-inlined `svf_step` callee's own 27 instructions) once
 * per mode -- not just count disassembly lines, to get a meaningful time-budget number.
 *
 * Two project dirs are staged, identical except `kNumModes` (8 vs 16):
 *   platform/minilogue-xd/axomodern-modal-bench-8modes
 *   platform/minilogue-xd/axomodern-modal-bench-16modes
 *
 * Build with the LOCAL arm-none-eabi toolchain (Docker isn't available on this machine), mirror
 * of this project's own `runLocalMake()` (`src/main/ipc/logueBuild.ts`):
 *   GCC_BIN_PATH=/opt/homebrew/bin make -j$(sysctl -n hw.ncpu)
 *   GCC_BIN_PATH=/opt/homebrew/bin make install
 * ELF lands at <projectDir>/build/osc.elf (confirmed against an existing staged project's own
 * Makefile: PROJECT=osc, BUILDDIR=$(PROJECTDIR)/build).
 *
 * Delete both staged dirs after measuring (`rm -rf`) -- this script does NOT do that itself
 * (measurement, not cleanup, is its job), same as this project's own build staging does in a
 * `finally { rmSync(...) }`.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/minilogue-xd'

const doc: PatchDocument = {
  nodes: [
    { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/filter/svf', name: 'svf1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [
    { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'svf1', inlet: 'in' }] },
    { sources: [{ obj: 'svf1', outlet: 'bp' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ],
  settings: {},
  notes: ''
}

/**
 * The modal bank code spliced into the generated `Osc` class as private members. `kNumModes`
 * is the only thing that differs between the 8- and 16-mode builds.
 *
 * Mode tuning: mode_freq = fundamental * (1 + modeIdx * 0.08) -- a fixed-stiffness harmonic
 * series approximation of Rings' own inharmonic mode tuning. `kBaseCutoff01` is a hardcoded
 * synthetic bench constant (NOT wired to live pitch/note_) -- deliberately: this bench measures
 * INSTRUCTION COUNT, which is a function of the generated code's *shape*, not of what value
 * flows through it at runtime, so a real pitch-tracked fundamental would add coupling complexity
 * (accessing private note_/noteFine_ from here is trivial since these are members of the same
 * class, but wiring it doesn't change a single instruction emitted) for zero measurement benefit.
 */
function modalBankMemberCode(numModes: number): string {
  return `
  // ---- Modal resonator bench (instruction-count measurement spike, NOT a real primitive) ----
  static const int kNumModes = ${numModes};
  float modeS1_[kNumModes];
  float modeS2_[kNumModes];
  float modeG_[kNumModes];
  float modeK_[kNumModes];
  int refreshIdx_;

  // Synthetic bench fundamental -- see this script's own doc comment for why this is a fixed
  // constant rather than wired to live pitch: instruction count is a function of code shape, not
  // runtime values.
  static constexpr float kBaseCutoff01 = 0.12f;
  static constexpr float kModeStiffness = 0.08f;
  static constexpr float kModeResonancePercent = 70.f;

  // Round-robin coefficient refresh -- recomputes exactly ONE mode's g_/k_ per call, matching
  // Rings' own documented amortization technique (also used by the real-shipped
  // peterall/eurorack-prologue port): "resonator filters are recomputed one per block instead of
  // all every block". Called ONCE PER BLOCK (see process()), not once per sample. noinline is
  // ONLY for this measurement -- not a real shipping recommendation.
  static void __attribute__((noinline)) resonator_refresh_one_mode(
    float *modeG, float *modeK, int *refreshIdx, int numModes)
  {
    int modeIdx = *refreshIdx;
    *refreshIdx = (*refreshIdx + 1) % numModes;
    float cutoff01 = kBaseCutoff01 * (1.f + (float)modeIdx * kModeStiffness);
    if (cutoff01 > 1.f) cutoff01 = 1.f;
    modeG[modeIdx] = svf_g_free(cutoff01);
    modeK[modeIdx] = svf_k_from_percent(kModeResonancePercent);
  }

  // Per-sample N-mode bank: runs the existing svf_step band-pass recurrence once per mode
  // against the oscillator's own signal, summing (scaled 1/N) into the returned sample. noinline
  // is ONLY for this measurement -- not a real shipping recommendation.
  static float __attribute__((noinline)) resonator_process_modes(
    float in, float *modeS1, float *modeS2, float *modeG, float *modeK, int numModes)
  {
    float sum = 0.f;
    for (int m = 0; m < numModes; ++m)
    {
      float lp, bp, hp;
      svf_step(&modeS1[m], &modeS2[m], in, modeG[m], modeK[m], &lp, &bp, &hp);
      (void)lp; (void)hp;
      sum += bp;
    }
    return sum * (1.f / (float)numModes);
  }
`
}

for (const numModes of [8, 16]) {
  const result = generateOldGenOscUnit(doc, { name: `modal bench ${numModes}modes` })
  let oscCpp = result.oscCpp

  // 1. Splice per-block refresh init (refreshIdx_ = 0) into init() -- anchor on the SVF
  // instance's own last init line (svfS2_svf1 is always the second field svfFilterPrimitive's
  // initStatement emits, see primitives.ts).
  const initAnchor = '    svfS2_svf1 = 0.f;\n'
  if (!oscCpp.includes(initAnchor)) {
    throw new Error('init() anchor not found -- generator output shape changed, re-probe it')
  }
  oscCpp = oscCpp.replace(initAnchor, initAnchor + '    refreshIdx_ = 0;\n')

  // 2. Splice the once-per-block refresh call right after process()'s opening brace, before the
  // per-sample for loop.
  const processAnchor = '  void process(int32_t *yn, uint32_t frames)\n  {\n'
  if (!oscCpp.includes(processAnchor)) {
    throw new Error('process() anchor not found -- generator output shape changed, re-probe it')
  }
  oscCpp = oscCpp.replace(
    processAnchor,
    processAnchor + '    resonator_refresh_one_mode(modeG_, modeK_, &refreshIdx_, kNumModes);\n'
  )

  // 3. Splice the per-sample N-mode call + mix it into the final output sample. Anchor on the
  // exact generated output line (outputExpr resolves to y_svf1_bp for this doc's wiring).
  const outputAnchor = '      yn[i] = f32_to_q31(clip1m1f(y_svf1_bp) * 0.999f);\n'
  if (!oscCpp.includes(outputAnchor)) {
    throw new Error('output-line anchor not found -- generator output shape changed, re-probe it')
  }
  oscCpp = oscCpp.replace(
    outputAnchor,
    '      float resonatorOut_ = resonator_process_modes(y_saw1, modeS1_, modeS2_, modeG_, modeK_, kNumModes);\n' +
      '      yn[i] = f32_to_q31(clip1m1f(y_svf1_bp + resonatorOut_) * 0.999f);\n'
  )

  // 4. Splice the modal bank member declarations + the two noinline functions in right before
  // the class's closing `};` (i.e. right after the generated helperCode, which is where
  // svf_step/svf_g_free/svf_k_from_percent live as private static members -- our functions need
  // to be private members of the SAME class to call those unqualified).
  const classCloseAnchor = '\n};\n\nstatic Osc s_osc;\n'
  if (!oscCpp.includes(classCloseAnchor)) {
    throw new Error('class-close anchor not found -- generator output shape changed, re-probe it')
  }
  oscCpp = oscCpp.replace(
    classCloseAnchor,
    modalBankMemberCode(numModes) + '\n};\n\nstatic Osc s_osc;\n'
  )

  const dirName = `axomodern-modal-bench-${numModes}modes`
  const projectDir = join(platformDir, dirName)
  mkdirSync(join(projectDir, 'ld'), { recursive: true })
  mkdirSync(join(projectDir, 'tpl'), { recursive: true })

  writeFileSync(join(projectDir, 'manifest.json'), result.manifestJson)
  writeFileSync(join(projectDir, 'project.mk'), result.projectMk)
  writeFileSync(join(projectDir, 'osc.cpp'), oscCpp)
  writeFileSync(join(projectDir, 'Makefile'), result.makefile)
  writeFileSync(join(projectDir, 'tpl', '_unit.c'), result.unitC)
  writeFileSync(join(projectDir, 'ld', 'rules.ld'), result.rulesLd)
  writeFileSync(join(projectDir, 'ld', 'userosc.ld'), result.useroscLd)
  writeFileSync(join(projectDir, 'ld', 'osc_api.syms'), result.oscApiSyms)

  console.log(`Staged ${dirName} (kNumModes=${numModes}) into ${projectDir}`)
}

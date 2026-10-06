/**
 * Where an effect runs out of CPU, measured: a telemetry pass-through in the REVERB slot (the end
 * of the chain, so nothing after it colours the tones) burns an exact number of cycles per sample
 * (NTS-1 mkII: BURN, program reverb PARAM 1; xd: the reverb DEPTH knob over 0..XD_BURN_MAX, sent
 * as a 10-bit CC), stepped up while a note is held, until the detector sine shows dropouts. Each step reports what the unit itself measured (fx), the whole
 * budget (tot) and the dropouts found in a 2 s recording. Run once with the factory mod and
 * delay off and once with them on, for the gauge's "alone" and "busy" anchors.
 *
 * Usage: npx tsx logue-codegen/scripts/hwtest/cpuCeiling.ts [--xd] [--others] [--from n] [--to n]
 *   --xd: the minilogue xd (default the NTS-1 mkII).
 *   --others: factory CHORUS in MOD and STEREO in DELAY (both dry/wet as stored in the program).
 *   --delay-slot (xd only): the burn unit in the DELAY slot instead, and with --others the
 *   factory CHORUS and a HALL reverb (dry/wet at 0, so the tones stay clean) run around it --
 *   the setup the xd gauge's first anchors were heard in (a delay unit, mod and reverb on).
 *   --reverb <cc value> picks another reverb type for that.
 *   --osc: the burn unit is an oscillator instead (see OSC). On the xd (`--xd --osc`) BURN is
 *   the multi engine's Shape knob, one note is held (one voice: each has its own budget), and the
 *   sweep stops at the FIRST step that shows dropouts or late calls -- an overloaded xd hangs and
 *   needs a power cycle, so there is no fine pass, no check at burn 0 and no restore after it
 *   (the next run's snapshot finds the test unit in the slot and restores from an earlier one).
 *   --notes n (xd oscillator): hold n notes (voices) instead of one.
 * Leaves the device as it was (slot 1s and the program restored).
 */
import { LOGUE_AUDIO_IN_TYPE, LOGUE_AUDIO_OUT_TYPE } from '../../src/oscInstances'
import type { PatchDocument } from '../../../src/shared/domain/patch'
import { peakFrequency, scanGlitches } from './analysis'
import { record, SAMPLE_RATE } from './audioCapture'
import { buildNts1Unit, buildXdUnit } from './buildUnit'
import {
  factory,
  neutralVoice,
  neutralXdVoice,
  programFrom,
  restore,
  takeSnapshot,
  type Snapshot,
  select,
  setParam
} from './deviceState'
import { LogueRig, sleep } from './rig'
import {
  cyclesFromFxTone,
  cyclesFromTotTone,
  cyclesFromXdTotTone,
  DETECTOR_HZ,
  FX_TONE_BAND,
  TOT_TONE_BAND,
  withFxTelemetry,
  withNts1OscTelemetry,
  withXdFxTelemetry,
  withXdOscTelemetry,
  XD_TELEMETRY
} from './telemetry'

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}
const XD = process.argv.includes('--xd')
const DELAY_SLOT = XD && process.argv.includes('--delay-slot')
/** The factory reverb around a delay-slot burn unit, as its CC value (the xd's *5-14: HALL 3,
 *  SMOOTH 11, ARENA 18, PLATE 25, ROOM 32, ...). */
const XD_REVERB = arg('--reverb', 3)
/** NTS-1 mkII only: the burn unit is an oscillator (a sine) in the OSC slot, BURN its program
 *  PARAM 1 (row 2, after Shape/Alt); with --others the factory CHORUS, STEREO delay and HALL
 *  reverb all run. */
const OSC = process.argv.includes('--osc')
const XD_OSC = XD && OSC
const SLOT = OSC ? ('osc' as const) : DELAY_SLOT ? ('delfx' as const) : ('revfx' as const)
const OTHERS = process.argv.includes('--others')
/** xd oscillator: notes held (one voice each; every voice runs its own burn). */
const NOTES = arg('--notes', 1)
const FROM = arg('--from', XD_OSC ? 800 : XD ? 2000 : 6000)
const TO = arg('--to', XD_OSC ? 1900 : XD ? 3700 : 11200)
const COARSE = arg('--step', XD_OSC ? 50 : XD ? 100 : 250)
const FINE = XD ? 20 : 50
/** The xd's DEPTH knob, all the way up, burns this many cycles per sample (~4 per knob step). */
const XD_BURN_MAX = arg('--burn-max', XD_OSC ? 2000 : 4000)
/** The xd voice's own budget per sample (one voice, `calibrateOsc.ts`' readings). */
const XD_OSC_BUDGET = 1728
/** The xd oscillator's tones: fx 0..4000, total 1000..3000 cycles per sample. */
const XD_OSC_BANDS = {
  fx: [1980, 3000] as [number, number],
  tot: [7000 + 1000 / 4, 7000 + 3000 / 4] as [number, number]
}
/** minilogue xd CCs (its MIDI implementation, 2-1). */
const XD_CC = {
  modOn: 92,
  modType: 88,
  delayOn: 93,
  delayType: 89,
  reverbOn: 94,
  reverbType: 90,
  reverbDepth: 109,
  reverbDryWet: 110,
  delayDepth: 106,
  multiShape: 54,
  lsb: 63
}

const OSC_SINE: PatchDocument = {
  nodes: [
    { kind: 'obj', type: 'logue/osc/sine', name: 's', x: 0, y: 0, params: [] },
    { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [{ sources: [{ obj: 's', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
  settings: { logueTarget: { module: 'osc' } },
  notes: ''
}

const PASS: PatchDocument = {
  nodes: [
    { kind: 'obj', type: LOGUE_AUDIO_IN_TYPE, name: 'in', x: 0, y: 0, params: [] },
    { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [
    { sources: [{ obj: 'in', outlet: 'l' }], dests: [{ obj: 'out', inlet: 'l' }] },
    { sources: [{ obj: 'in', outlet: 'r' }], dests: [{ obj: 'out', inlet: 'r' }] }
  ],
  settings: { logueTarget: { module: SLOT === 'osc' ? 'revfx' : SLOT } },
  notes: ''
}

interface Step {
  burn: number
  fx: number
  tot: number
  dropouts: number
}

async function main(): Promise<void> {
  const unit = XD
    ? undefined
    : OSC
      ? buildNts1Unit(OSC_SINE, 'lp-hwtest-burn-osc', 'HT Burn', 3, new Map(), (f) =>
          withNts1OscTelemetry(f, { burnRow: 2 })
        )
      : buildNts1Unit(PASS, 'lp-hwtest-burn-rev', 'HT Burn', 2, new Map(), (f) =>
          withFxTelemetry(f, { burnRow: 3 })
        )
  const xdUnit = XD_OSC
    ? buildXdUnit(OSC_SINE, 'lp-hwtest-xd-burn-osc', 'HT Burn', new Map(), (f) =>
        withXdOscTelemetry(f, { burnMax: XD_BURN_MAX })
      )
    : XD
      ? buildXdUnit(PASS, 'lp-hwtest-xd-burn', 'HT Burn', new Map(), (f) =>
          withXdFxTelemetry(f, DELAY_SLOT ? 'delfx' : 'revfx', { burnMax: XD_BURN_MAX })
        )
      : undefined
  const rig = await LogueRig.connect(XD ? 'minilogue-xd' : 'nts1mkii')
  let snapshot: Snapshot | undefined
  const steps: Step[] = []
  let hung = false
  try {
    snapshot = await takeSnapshot(rig, [SLOT])
    await rig.upload(SLOT, 0, unit ? unit.bytes : xdUnit!.body)
    // On the xd only a program load makes a slot run newly uploaded code.
    if (XD) await rig.writeProgram(snapshot.program)
    const program = programFrom(snapshot)
    if (unit) {
      if (OSC) {
        neutralVoice(program)
        select(program, 'osc', unit, 'HT Burn')
        if (OTHERS) select(program, 'revfx', factory(1), 'HALL')
      } else select(program, 'revfx', unit, 'HT Burn')
      select(program, 'modfx', OTHERS ? factory(1) : factory(0), OTHERS ? 'CHORUS' : 'OFF')
      select(program, 'delfx', OTHERS ? factory(1) : factory(0), OTHERS ? 'STEREO' : 'OFF')
    } else if (XD_OSC) {
      // The multi engine as USER1, the VCOs silent, the effects off (factory mod/delay/reverb
      // with --others, dry/wet as stored).
      await neutralXdVoice(rig)
      if (OTHERS) {
        rig.cc(XD_CC.modType, 0)
        rig.cc(XD_CC.modOn, 127)
        rig.cc(XD_CC.delayType, 3)
        rig.cc(XD_CC.delayOn, 127)
        rig.cc(XD_CC.reverbType, XD_REVERB)
        rig.cc(XD_CC.reverbOn, 127)
      }
    } else {
      // The xd selects by CC: the burn unit as USER1 of its slot, chorus (STEREO) and the
      // STEREO delay or a HALL reverb at dry/wet 0 around it, or nothing.
      rig.cc(XD_CC.modType, 0)
      rig.cc(XD_CC.modOn, OTHERS ? 127 : 0)
      if (DELAY_SLOT) {
        rig.cc(XD_CC.delayType, 80)
        rig.cc(XD_CC.delayOn, 127)
        rig.cc(XD_CC.reverbType, XD_REVERB)
        rig.cc(XD_CC.reverbDryWet, 0)
        rig.cc(XD_CC.reverbOn, OTHERS ? 127 : 0)
      } else {
        rig.cc(XD_CC.reverbType, 75)
        rig.cc(XD_CC.reverbOn, 127)
        rig.cc(XD_CC.delayType, 3)
        rig.cc(XD_CC.delayOn, OTHERS ? 127 : 0)
      }
    }
    const notes = [57, 60, 64, 67, 52, 55, 59, 62].slice(0, NOTES)
    for (const n of notes) rig.noteOn(n)
    const setBurn = async (burn: number): Promise<void> => {
      if (unit) {
        setParam(program, SLOT, 1, burn)
        await rig.writeProgram(program)
        return
      }
      const knob = Math.min(1023, Math.round((burn / XD_BURN_MAX) * 1023))
      rig.cc(XD_CC.lsb, knob & 7)
      rig.cc(
        XD_OSC ? XD_CC.multiShape : DELAY_SLOT ? XD_CC.delayDepth : XD_CC.reverbDepth,
        knob >> 3
      )
    }

    let cleanFloor = Infinity
    // Past the ceiling the calls stop arriving on time, which shows in the measured budget even
    // when the recording happens to look whole. Each processor's budget is fixed and has read the same in every run (NTS-1 mkII 11458,
    // the xd's effects MCU 3750); a reading taken at burn 0 once caught a unit still starting
    // (12645) and made every later step look late.
    const budget = XD_OSC ? XD_OSC_BUDGET : XD ? 3750 : 11458
    const measure = async (burn: number): Promise<Step> => {
      await setBurn(burn)
      await sleep(1000)
      const r = await record(2)
      const det = peakFrequency(r.left, SAMPLE_RATE, DETECTOR_HZ - 20, DETECTOR_HZ + 20).hz
      // The interface's clock against the device's: the detector is exactly DETECTOR_HZ there.
      const clock = det / DETECTOR_HZ
      const fxHz = peakFrequency(
        r.left,
        SAMPLE_RATE,
        ...(XD_OSC ? XD_OSC_BANDS.fx : XD ? XD_TELEMETRY.fxBand : FX_TONE_BAND)
      ).hz
      const totHz = peakFrequency(
        r.left,
        SAMPLE_RATE,
        ...(XD_OSC ? XD_OSC_BANDS.tot : XD ? XD_TELEMETRY.totBand : TOT_TONE_BAND)
      ).hz
      const scan = scanGlitches(r.left, SAMPLE_RATE, [det, fxHz, totHz], { floor: cleanFloor })
      if (burn === 0 && scan.times.length === 0) cleanFloor = Math.min(cleanFloor, scan.floor)
      const step: Step = {
        burn,
        fx: cyclesFromFxTone(fxHz / clock),
        tot: XD ? cyclesFromXdTotTone(totHz / clock) : cyclesFromTotTone(totHz / clock),
        dropouts: scan.times.length
      }
      const late = Math.abs(step.tot / budget - 1) > 0.01
      if (late && step.dropouts === 0) step.dropouts = -1
      // An overloaded xd voice keeps rendering at its last burn while the device stops taking
      // MIDI: the reading stops rising with the burn, and the recording still looks whole (two
      // sweeps read 1301 from burn 1310 on). Readings run up to ~20 above the burn, so compare
      // with the previous step.
      const prev = steps[steps.length - 1]
      if (
        XD_OSC &&
        prev &&
        burn > prev.burn &&
        step.fx < prev.fx + (burn - prev.burn) / 2 &&
        step.dropouts === 0
      ) {
        step.dropouts = -2
      }
      steps.push(step)
      console.log(
        `burn ${String(burn).padStart(5)}  fx ${step.fx.toFixed(0).padStart(5)}  tot ${step.tot.toFixed(0).padStart(5)}  ` +
          (step.dropouts === -2
            ? 'FROZEN (fx not following the burn)'
            : step.dropouts < 0
              ? 'LATE CALLS'
              : `dropout windows ${step.dropouts}`) +
          (scan.times.length ? `  (first at ${scan.times[0].toFixed(3)} s)` : '') +
          `  worst ${(20 * Math.log10(scan.worst + 1e-12)).toFixed(0)} dB`
      )
      return step
    }

    console.log(
      `${XD ? 'minilogue xd' : 'NTS-1 mkII'}, burn unit in ${SLOT}: ` +
        (XD_OSC
          ? `${NOTES} note(s), ` +
            (OTHERS
              ? `MOD CHORUS + DELAY STEREO + REVERB (type cc ${XD_REVERB}) on`
              : 'effects off')
          : !OTHERS
            ? 'other effects off'
            : DELAY_SLOT
              ? `MOD CHORUS + REVERB (type cc ${XD_REVERB}, dry) on`
              : OSC
                ? 'MOD CHORUS + DELAY STEREO + REVERB HALL on'
                : 'MOD CHORUS + DELAY STEREO on')
    )
    // Let the unit switch in (the first recording after the CCs caught it), then take the clean
    // floor and budget at burn 0.
    await sleep(2000)
    const first = await measure(0)
    // A sine alone costs ~140 here; anything else is a voice still hung from an earlier run.
    if (XD_OSC && first.fx > 400) {
      hung = true
      throw new Error(
        `burn 0 reads ${first.fx.toFixed(0)} cycles: the xd looks hung -- power-cycle it`
      )
    }
    if (!Number.isFinite(cleanFloor)) await measure(0)
    let good = 0
    let bad: number | undefined
    for (let burn = FROM; burn <= TO; burn += COARSE) {
      if ((await measure(burn)).dropouts !== 0) {
        bad = burn
        break
      }
      good = burn
    }
    if (bad !== undefined && XD_OSC) {
      hung = true
      console.log(
        `\nlast clean burn ${good}, first with dropouts or late calls ${bad}.\n` +
          'POWER-CYCLE THE XD now (an overloaded voice hangs it); the slot and program are left ' +
          `as they are -- the next run restores them (snapshot ${snapshot.dir}).`
      )
    } else if (bad !== undefined) {
      for (let burn = Math.max(good, bad - COARSE) + FINE; burn < bad; burn += FINE) {
        if ((await measure(burn)).dropouts !== 0) {
          bad = burn
          break
        }
        good = burn
      }
      // Back to a light load before anything else, and check the device recovered.
      const after = await measure(0)
      console.log(
        `\nlast clean burn ${good}, first with dropouts ${bad}; ` +
          (after.dropouts === 0 ? 'recovered at burn 0' : 'STILL DROPPING OUT at burn 0')
      )
    } else {
      console.log(`\nno dropouts up to ${TO}`)
    }
  } finally {
    rig.allNotesOff()
    if (snapshot && !hung)
      console.log((await restore(rig, snapshot).catch((e) => [`RESTORE FAILED: ${e}`])).join('\n'))
    rig.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

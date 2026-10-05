/**
 * Where an NTS-1 mkII effect runs out of CPU, measured: a telemetry pass-through in the REVERB
 * slot (the end of the chain, so nothing after it colours the tones) burns an exact number of
 * cycles per sample (BURN, program reverb PARAM 1), stepped up while a note is held, until the
 * detector sine shows dropouts. Each step reports what the unit itself measured (fx), the whole
 * budget (tot) and the dropouts found in a 2 s recording. Run once with the factory mod and
 * delay off and once with them on, for the gauge's "alone" and "busy" anchors.
 *
 * Usage: npx tsx logue-codegen/scripts/hwtest/cpuCeiling.ts [--others] [--from 6000] [--to 11200]
 *   --others: factory CHORUS in MOD and STEREO in DELAY (both dry/wet as stored in the program).
 * Leaves the device as it was (slot 1s and the program restored).
 */
import { LOGUE_AUDIO_IN_TYPE, LOGUE_AUDIO_OUT_TYPE } from '../../src/oscInstances'
import type { PatchDocument } from '../../../src/shared/domain/patch'
import { peakFrequency, scanGlitches } from './analysis'
import { record, SAMPLE_RATE } from './audioCapture'
import { buildNts1Unit } from './buildUnit'
import {
  factory,
  programFrom,
  restore,
  takeSnapshot,
  type Snapshot,
  select,
  setParam
} from './deviceState'
import { Nts1Rig, sleep } from './nts1Rig'
import {
  cyclesFromFxTone,
  cyclesFromTotTone,
  DETECTOR_HZ,
  FX_TONE_BAND,
  TOT_TONE_BAND,
  withFxTelemetry
} from './telemetry'

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}
const OTHERS = process.argv.includes('--others')
const FROM = arg('--from', 6000)
const TO = arg('--to', 11200)
const COARSE = 250
const FINE = 50

const PASS: PatchDocument = {
  nodes: [
    { kind: 'obj', type: LOGUE_AUDIO_IN_TYPE, name: 'in', x: 0, y: 0, params: [] },
    { kind: 'obj', type: LOGUE_AUDIO_OUT_TYPE, name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [
    { sources: [{ obj: 'in', outlet: 'l' }], dests: [{ obj: 'out', inlet: 'l' }] },
    { sources: [{ obj: 'in', outlet: 'r' }], dests: [{ obj: 'out', inlet: 'r' }] }
  ],
  settings: { logueTarget: { module: 'revfx' } },
  notes: ''
}

interface Step {
  burn: number
  fx: number
  tot: number
  dropouts: number
}

async function main(): Promise<void> {
  const unit = buildNts1Unit(PASS, 'lp-hwtest-burn-rev', 'HT Burn', 2, new Map(), (f) =>
    withFxTelemetry(f, { burnRow: 3 })
  )
  const rig = await Nts1Rig.connect()
  let snapshot: Snapshot | undefined
  const steps: Step[] = []
  try {
    snapshot = await takeSnapshot(rig, ['revfx'])
    await rig.upload('revfx', 0, unit.bytes)
    const program = programFrom(snapshot)
    select(program, 'revfx', unit, 'HT Burn')
    select(program, 'modfx', OTHERS ? factory(1) : factory(0), OTHERS ? 'CHORUS' : 'OFF')
    select(program, 'delfx', OTHERS ? factory(1) : factory(0), OTHERS ? 'STEREO' : 'OFF')
    rig.noteOn(57)

    let cleanFloor = Infinity
    const measure = async (burn: number): Promise<Step> => {
      setParam(program, 'revfx', 1, burn)
      await rig.writeProgram(program)
      await sleep(1000)
      const r = await record(2)
      const det = peakFrequency(r.left, SAMPLE_RATE, DETECTOR_HZ - 20, DETECTOR_HZ + 20).hz
      // The interface's clock against the device's: the detector is exactly DETECTOR_HZ there.
      const clock = det / DETECTOR_HZ
      const fxHz = peakFrequency(r.left, SAMPLE_RATE, ...FX_TONE_BAND).hz
      const totHz = peakFrequency(r.left, SAMPLE_RATE, ...TOT_TONE_BAND).hz
      const scan = scanGlitches(r.left, SAMPLE_RATE, [det, fxHz, totHz], { floor: cleanFloor })
      if (burn === 0 && scan.times.length === 0) cleanFloor = Math.min(cleanFloor, scan.floor)
      const step: Step = {
        burn,
        fx: cyclesFromFxTone(fxHz / clock),
        tot: cyclesFromTotTone(totHz / clock),
        dropouts: scan.times.length
      }
      steps.push(step)
      console.log(
        `burn ${String(burn).padStart(5)}  fx ${step.fx.toFixed(0).padStart(5)}  tot ${step.tot.toFixed(0).padStart(5)}  ` +
          `dropout windows ${step.dropouts}` +
          (scan.times.length ? `  (first at ${scan.times[0].toFixed(3)} s)` : '') +
          `  worst ${(20 * Math.log10(scan.worst + 1e-12)).toFixed(0)} dB`
      )
      return step
    }

    console.log(OTHERS ? 'MOD CHORUS + DELAY STEREO on' : 'MOD and DELAY off')
    await measure(0)
    let good = 0
    let bad: number | undefined
    for (let burn = FROM; burn <= TO; burn += COARSE) {
      if ((await measure(burn)).dropouts > 0) {
        bad = burn
        break
      }
      good = burn
    }
    if (bad !== undefined) {
      for (let burn = Math.max(good, bad - COARSE) + FINE; burn < bad; burn += FINE) {
        if ((await measure(burn)).dropouts > 0) {
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
    if (snapshot)
      console.log((await restore(rig, snapshot).catch((e) => [`RESTORE FAILED: ${e}`])).join('\n'))
    rig.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

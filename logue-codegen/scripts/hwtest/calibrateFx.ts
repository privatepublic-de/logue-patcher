/**
 * Measures generated effects on the device and fits the xd effect table to them. NTS-1 mkII: re-fits
 * `estimateFxCpuCost`'s NTS-1 mkII scale; minilogue xd (`--xd`): how the emulator's cycles and
 * SDRAM accesses relate to the effects MCU's real cycles. Units: every example effect and the CPU probe's old test units, each built with telemetry
 * (`telemetry.ts`), uploaded to slot 1 of its module, selected alone (the other two effect slots
 * off) with its authored settings, and read while a note plays into it. Prints measured against
 * estimated and the fit (relative error, no intercept), and writes the readings to
 * `nts1FxCpuReadings.json` (`xdFxCpuReadings.json`) next to this script. On the xd a unit is
 * selected by CC (USER1 of its module) and its knobs are sent as the authored positions; a unit
 * too big for an xd effect is skipped.
 *
 * Usage: npx tsx logue-codegen/scripts/hwtest/calibrateFx.ts [--xd] [name filter ...]
 * Leaves the device as it was (slot 1s and the program restored).
 */
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { PatchDocument } from '../../../src/shared/domain/patch'
import { parsePatchFile } from '../../../src/shared/json/patchCodec'
import { estimateFxCpuCost } from '../../src/estimateFxCpuCost'
import type { LogueUnitModule } from '../../src/sysex/korgUserUnitMessages'
import { exampleSubpatches, examplesDir } from '../exampleSubpatches'
import { bufferTest, GRAIN_TEST } from '../nts1FxProbeUnits'
import { peakFrequency, trackPeak } from './analysis'
import { record, SAMPLE_RATE } from './audioCapture'
import { buildNts1Unit, buildXdUnit } from './buildUnit'
import {
  factory,
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
  DETECTOR_HZ,
  FX_TONE_BAND,
  withFxTelemetry,
  withXdFxTelemetry,
  XD_TELEMETRY
} from './telemetry'

const here = dirname(new URL(import.meta.url).pathname)
const XD = process.argv.includes('--xd')
export const READINGS_FILE = join(here, XD ? 'xdFxCpuReadings.json' : 'nts1FxCpuReadings.json')

/** minilogue xd CCs (its MIDI implementation, 2-1): on/off, USER1, knobs time/depth/mix. */
const XD_SELECT: Record<
  Exclude<LogueUnitModule, 'osc'>,
  { on: number; type: [number, number][]; knobs: number[] }
> = {
  modfx: {
    on: 92,
    type: [
      [88, 110],
      [96, 4]
    ],
    knobs: [28, 29]
  },
  delfx: { on: 93, type: [[89, 80]], knobs: [105, 106, 107] },
  revfx: { on: 94, type: [[90, 75]], knobs: [108, 109, 110] }
}

/** The authored knob positions an xd effect's init() sets (time01_/depth01_/mix01_). */
function xdKnobInits(fxCpp: string): number[] {
  return ['time01_', 'depth01_', 'mix01_'].map((m) => {
    const all = [...fxCpp.matchAll(new RegExp(`${m} = (-?[0-9.]+)f;`, 'g'))]
    return all.length ? Number(all[all.length - 1][1]) : 0
  })
}

/** TABLE 2: each effect's knobs (A, B and, on delay/reverb, MIX), 0..1023. */
const KNOBS: Record<Exclude<LogueUnitModule, 'osc'>, number[]> = {
  modfx: [144, 146],
  delfx: [200, 202, 204],
  revfx: [256, 258, 260]
}

interface Row {
  min: number
  max: number
  init: number
}

function headerRows(headerC: string): Row[] {
  return [...headerC.matchAll(/\{(-?\d+), (-?\d+), -?\d+, (-?\d+), k_unit_param_type_\w+/g)].map(
    (m) => ({ min: Number(m[1]), max: Number(m[2]), init: Number(m[3]) })
  )
}

const units: { name: string; doc: PatchDocument }[] = [
  { name: 'lp-fx-buf1', doc: bufferTest(1) },
  { name: 'lp-fx-buf4', doc: bufferTest(4) },
  { name: 'lp-fx-grain', doc: GRAIN_TEST },
  ...readdirSync(examplesDir)
    .filter((f) => f.endsWith('.loguepatch'))
    .sort()
    .map((f) => ({
      name: f.replace('.loguepatch', ''),
      doc: parsePatchFile(readFileSync(join(examplesDir, f), 'utf-8'))
    }))
]

async function main(): Promise<void> {
  const filters = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const subpatches = exampleSubpatches()
  const rig = await LogueRig.connect(XD ? 'minilogue-xd' : 'nts1mkii')
  let snapshot: Snapshot | undefined
  const readings: {
    name: string
    date: string
    cycles: number
    maxCycles: number
    xdCycles: number
    sdram: number
  }[] = []
  try {
    snapshot = await takeSnapshot(rig, ['modfx', 'delfx', 'revfx'])
    for (const [i, u] of units.entries()) {
      if (filters.length && !filters.some((f) => u.name.includes(f))) continue
      const module = u.doc.settings.logueTarget!.module as Exclude<LogueUnitModule, 'osc'>
      const estimate = estimateFxCpuCost(u.doc, subpatches, XD ? 'minilogue-xd' : 'nts1mkii')
      if (estimate.status !== 'ok') {
        console.log(`${u.name}: ${estimate.reason}`)
        continue
      }
      let play: () => Promise<void>
      if (XD) {
        let fxCpp = ''
        let built: ReturnType<typeof buildXdUnit>
        try {
          built = buildXdUnit(u.doc, `lp-hwtest-xd-${u.name}`, `HT ${i}`, subpatches, (f) => {
            fxCpp = f['fx.cpp']
            return withXdFxTelemetry(f, module)
          })
        } catch {
          console.log(`${u.name.padEnd(26)} ${module}  doesn't build for the xd (too big?)`)
          continue
        }
        await rig.upload(module, 0, built.body)
        // The xd keeps running a slot's previous code (three mod units in a row all read the first
        // one's ~255, whatever the CCs did in between) until a program load: write the saved
        // program back, then select by CC.
        await rig.writeProgram(snapshot.program)
        await sleep(500)
        for (const other of Object.values(XD_SELECT)) rig.cc(other.on, 0)
        const sel = XD_SELECT[module]
        const knobs = xdKnobInits(fxCpp)
        play = async () => {
          for (const [cc, v] of sel.type) rig.cc(cc, v)
          rig.cc(sel.on, 127)
          sel.knobs.forEach((cc, k) => {
            const v = Math.round(Math.min(1, Math.max(0, knobs[k])) * 1023)
            rig.cc(63, v & 7)
            rig.cc(cc, v >> 3)
          })
        }
      } else {
        let header = ''
        const unit = buildNts1Unit(
          u.doc,
          `lp-hwtest-${u.name}`,
          `HT ${i}`,
          100 + i,
          subpatches,
          (f) => {
            header = f['header.c']
            return withFxTelemetry(f)
          }
        )
        // Re-uploading into the slot that is selected and playing has left a unit with no
        // reading now and then: switch the module off first.
        const off = programFrom(snapshot)
        for (const m of ['modfx', 'delfx', 'revfx'] as const) select(off, m, factory(0), 'OFF')
        await rig.writeProgram(off)
        await rig.upload(module, 0, unit.bytes)
        const program = programFrom(snapshot)
        for (const m of ['modfx', 'delfx', 'revfx'] as const) select(program, m, factory(0), 'OFF')
        select(program, module, unit, `HT ${i}`)
        const rows = headerRows(header)
        const view = new DataView(program.buffer)
        KNOBS[module].forEach((offset, k) => {
          const r = rows[k]
          view.setUint16(offset, Math.round(((r.init - r.min) / (r.max - r.min || 1)) * 1023), true)
        })
        const first = KNOBS[module].length
        for (let n = 1; n <= 8 && first + n - 1 < rows.length; n++) {
          setParam(program, module, n, rows[first + n - 1].init)
        }
        play = () => rig.writeProgram(program)
      }
      const e = estimate.estimate
      // A unit with buffers gets dearer as they fill (grain-mill: ~1840 -> ~2520 cycles over
      // the first 3 s), so it settles first and the tone is tracked, not read once. Both tones
      // are written at one level: a window whose "fx tone" is much weaker holds no reading.
      let reading: { clock: number; track: ReturnType<typeof trackPeak> } | undefined
      for (let attempt = 0; attempt < 2 && !reading; attempt++) {
        await play()
        rig.noteOn(57)
        await sleep(4000)
        const r = await record(3)
        rig.noteOff(57)
        const det = peakFrequency(r.left, SAMPLE_RATE, DETECTOR_HZ - 20, DETECTOR_HZ + 20)
        const track = trackPeak(r.left, SAMPLE_RATE, XD ? XD_TELEMETRY.fxBand : FX_TONE_BAND)
        if (det.amplitude > 1e-3 && track.minAmplitude > 0.3 * det.amplitude)
          reading = { clock: det.hz / DETECTOR_HZ, track }
      }
      if (!reading) {
        console.log(`${u.name.padEnd(26)} ${module}  NO READING (no telemetry tones)`)
        continue
      }
      const { clock, track } = reading
      const measured = cyclesFromFxTone(track.mean / clock)
      const peak = cyclesFromFxTone(track.max / clock)
      readings.push({
        name: u.name,
        date: new Date().toISOString().slice(0, 10),
        cycles: Math.round(measured),
        maxCycles: Math.round(peak),
        xdCycles: e.sum.cycles,
        sdram: e.sum.sdram
      })
      console.log(
        `${u.name.padEnd(26)} ${module}  measured ${measured.toFixed(0).padStart(5)} (max ${peak.toFixed(0).padStart(5)})  estimated ${String(e.cyclesPerSample).padStart(5)}  ` +
          `${((e.cyclesPerSample / measured - 1) * 100).toFixed(0).padStart(4)} %  (xd ${e.sum.cycles}, SDRAM ${e.sum.sdram})`
      )
    }
  } finally {
    rig.allNotesOff()
    if (snapshot)
      console.log((await restore(rig, snapshot).catch((e) => [`RESTORE FAILED: ${e}`])).join('\n'))
    rig.close()
  }
  if (!filters.length) writeFileSync(READINGS_FILE, JSON.stringify(readings, null, 2) + '\n')
  // Least squares on (k*c + p*s)/m = 1.
  let a11 = 0,
    a12 = 0,
    a22 = 0,
    b1 = 0,
    b2 = 0
  for (const { cycles: m, xdCycles: c, sdram: s } of readings) {
    const x = c / m
    const z = s / m
    a11 += x * x
    a12 += x * z
    a22 += z * z
    b1 += x
    b2 += z
  }
  const det = a11 * a22 - a12 * a12
  const k = (b1 * a22 - b2 * a12) / det
  const p = (a11 * b2 - a12 * b1) / det
  const errors = readings.map((r) => (k * r.xdCycles + p * r.sdram) / r.cycles - 1)
  console.log(
    `\nfit: scale ${k.toFixed(2)}, ${p.toFixed(1)} cycles per SDRAM access; ` +
      `errors ${(Math.min(...errors) * 100).toFixed(0)}..${(Math.max(...errors) * 100).toFixed(0)} %`
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

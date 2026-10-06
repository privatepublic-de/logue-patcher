/**
 * Measures the user's oscillator patches on a real device through audio telemetry and compares
 * them with `estimateOscCpuCost` (the xd emulator table, cycles per voice-sample): how real
 * cycles relate to the estimate on each platform. Every patch is measured with its device
 * controls stripped (menu slots, knob bindings, followers -- in its subpatches too), so each
 * param runs at its authored value on the device and in the estimate alike, with nothing a
 * program or a knob could override. One note held (57); a unit settles 3 s, then is tracked 3 s.
 * Writes the readings to `<platform>OscCpuReadings.json` next to this script.
 *
 * Usage: npx tsx logue-codegen/scripts/hwtest/calibrateOsc.ts [--xd] [name filter ...]
 *   patches: HWTEST_OSC_PATCHES (default ~/Documents/logue-patches), subpatches from its
 *   `subpatches` folder and its top level.
 * Leaves the device as it was (osc slot 1 and the program restored and verified).
 *
 * `--refit` touches no device: it recomputes every stored reading's estimate from its patch with
 * the current cost table (after a re-measure), writes them back and prints the affine fit
 * real = a + b * estimate (smallest worst relative error) for `estimateOscCpuCost.ts`' constants.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, relative } from 'path'
import type { PatchDocument } from '../../../src/shared/domain/patch'
import { parsePatchFile } from '../../../src/shared/json/patchCodec'
import { estimateOscCpuCost, oscRealCycles, XD_OSC_HANG_CYCLES } from '../../src/estimateOscCpuCost'
import { isEffectModule } from '../../src/unitKinds'
import { peakFrequency, trackPeak } from './analysis'
import { record, SAMPLE_RATE } from './audioCapture'
import { buildNts1Unit, buildXdUnit } from './buildUnit'
import {
  factory,
  neutralVoice,
  neutralXdVoice,
  programFrom,
  restore,
  select,
  takeSnapshot,
  type Snapshot
} from './deviceState'
import { LogueRig, sleep } from './rig'
import {
  cyclesFromFxTone,
  cyclesFromTotTone,
  cyclesFromXdTotTone,
  DETECTOR_HZ,
  withNts1OscTelemetry,
  withXdOscTelemetry
} from './telemetry'

const XD = process.argv.includes('--xd')
const here = dirname(new URL(import.meta.url).pathname)
const READINGS_FILE = join(here, XD ? 'xdOscCpuReadings.json' : 'nts1OscCpuReadings.json')
const PATCHES = process.env.HWTEST_OSC_PATCHES ?? join(homedir(), 'Documents/logue-patches')
/** Where an oscillator's own cycles show: 2000 Hz + cycles/4, up to ~3750 cycles here. */
const FX_BAND: [number, number] = [1980, 3000]
const TOT_BAND: [number, number] = XD
  ? [7000 + 1000 / 4, 7000 + 3000 / 4]
  : [7000 - 1000 / 4, 7000 + 4000 / 4]

/** Every param without a device control, in a document and (for subpatches) a definition. */
function stripDeviceControls(doc: PatchDocument): PatchDocument {
  return {
    ...doc,
    nodes: doc.nodes.map((n) =>
      n.kind !== 'obj'
        ? n
        : {
            ...n,
            params: n.params.map(({ name, value, label, subpatchExpose }) => ({
              name,
              value,
              ...(label !== undefined ? { label } : {}),
              ...(subpatchExpose ? { subpatchExpose } : {})
            }))
          }
    )
  }
}

function loadSubpatches(): Map<string, PatchDocument> {
  const defs = new Map<string, PatchDocument>()
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const f of readdirSync(dir)) {
      const path = join(dir, f)
      if (statSync(path).isDirectory()) walk(path)
      else if (f.endsWith('.loguesub'))
        defs.set(
          `sub/${relative(join(PATCHES, 'subpatches'), path).replace(/\.loguesub$/, '')}`,
          stripDeviceControls(parsePatchFile(readFileSync(path, 'utf-8')))
        )
    }
  }
  walk(join(PATCHES, 'subpatches'))
  // A patch's own folder comes first (`listSubpatchesFor`): its top level overrides the library.
  for (const f of readdirSync(PATCHES).filter((f) => f.endsWith('.loguesub')))
    defs.set(
      `sub/${f.replace(/\.loguesub$/, '')}`,
      stripDeviceControls(parsePatchFile(readFileSync(join(PATCHES, f), 'utf-8')))
    )
  return defs
}

/**
 * real = a + b * e with the smallest worst relative error (a grid search): the gauge's green zone
 * is sized by the worst under-read, so that is what the fit keeps small.
 */
function affineFit(points: { e: number; r: number }[]): { a: number; b: number } {
  let best = { a: 0, b: 1, worst: Infinity }
  for (let a = 0; a <= 500; a += 1) {
    for (let b = 0.3; b <= 3; b += 0.005) {
      let worst = 0
      for (const { e, r } of points) worst = Math.max(worst, Math.abs((a + b * e) / r - 1))
      if (worst < best.worst) best = { a, b, worst }
    }
  }
  return best
}

function refit(): void {
  const platform = XD ? 'minilogue-xd' : 'nts1mkii'
  const defs = loadSubpatches()
  const readings: { name: string; cycles: number; estimate: number }[] = JSON.parse(
    readFileSync(READINGS_FILE, 'utf-8')
  )
  for (const r of readings) {
    const doc = stripDeviceControls(
      parsePatchFile(readFileSync(join(PATCHES, `${r.name}.loguepatch`), 'utf-8'))
    )
    const est = estimateOscCpuCost(doc, defs, platform)
    if (est.status !== 'ok') throw new Error(`${r.name}: ${est.reason}`)
    console.log(
      `${r.name.padEnd(22)} estimate ${String(r.estimate).padStart(4)} -> ${est.estimate.cyclesPerVoice}`
    )
    r.estimate = est.estimate.cyclesPerVoice
  }
  writeFileSync(READINGS_FILE, JSON.stringify(readings, null, 2) + '\n')
  // Copies of one patch under other names (cpiano, einfach, smpstr) count once.
  const points = [
    ...new Map(
      readings.map((r) => [
        `${r.estimate}:${Math.round(r.cycles / 5)}`,
        { e: r.estimate, r: r.cycles }
      ])
    ).values()
  ]
  const { a, b } = affineFit(points)
  const errors = points.map((p) => (a + b * p.e) / p.r - 1)
  console.log(
    `\nreal = ${a.toFixed(0)} + ${b.toFixed(2)} x estimate (${points.length} distinct); errors ` +
      `${(Math.min(...errors) * 100).toFixed(0)}..${(Math.max(...errors) * 100).toFixed(0)} %`
  )
}

async function main(): Promise<void> {
  if (process.argv.includes('--refit')) return refit()
  const filters = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const defs = loadSubpatches()
  const patches = readdirSync(PATCHES)
    .filter((f) => f.endsWith('.loguepatch') && !f.includes('.history-'))
    .filter((f) => !filters.length || filters.some((x) => f.includes(x)))
    .sort()
    .map((f) => ({
      name: f.replace(/\.loguepatch$/, ''),
      doc: stripDeviceControls(parsePatchFile(readFileSync(join(PATCHES, f), 'utf-8')))
    }))
    .filter((p) => !isEffectModule(p.doc.settings.logueTarget?.module ?? 'osc'))
  const platform = XD ? 'minilogue-xd' : 'nts1mkii'
  const rig = await LogueRig.connect(platform)
  let snapshot: Snapshot | undefined
  const readings: {
    name: string
    date: string
    cycles: number
    maxCycles: number
    estimate: number
  }[] = []
  try {
    snapshot = await takeSnapshot(rig, ['osc'])
    rig.send([0xe0 | rig.channel, 0, 0x40])
    for (const [i, p] of patches.entries()) {
      const est = estimateOscCpuCost(p.doc, defs, platform)
      if (est.status !== 'ok') {
        console.log(`${p.name.padEnd(22)} not estimated: ${est.reason}`)
        continue
      }
      // formant (estimate 682, ~1700 real for ONE voice) hung the xd here, and a hung xd needs a
      // power cycle. A voice hangs from ~1225-1300 real cycles (`XD_OSC_HANG_CYCLES`): skip a
      // patch whose converted estimate, 34 % low (the fit's worst), could reach it.
      if (XD && oscRealCycles(est.estimate.cyclesPerVoice, platform) / 0.66 > XD_OSC_HANG_CYCLES) {
        console.log(
          `${p.name.padEnd(22)} skipped: estimate ${est.estimate.cyclesPerVoice} could hang the xd`
        )
        continue
      }
      try {
        if (XD) {
          const unit = buildXdUnit(p.doc, `lp-hwtest-xd-cal-${i}`, `HT ${i}`, defs, (f) =>
            withXdOscTelemetry(f)
          )
          await rig.upload('osc', 0, unit.body)
          // Only a program load makes the xd run a re-uploaded slot's new code.
          await rig.writeProgram(snapshot.program)
          await neutralXdVoice(rig)
        } else {
          const unit = buildNts1Unit(p.doc, `lp-hwtest-cal-${i}`, `HT ${i}`, 800 + i, defs, (f) =>
            withNts1OscTelemetry(f)
          )
          const program = programFrom(snapshot)
          neutralVoice(program)
          select(program, 'osc', factory(1), 'SAW')
          await rig.writeProgram(program)
          await rig.upload('osc', 0, unit.bytes)
          select(program, 'osc', unit, `HT ${i}`)
          await rig.writeProgram(program)
        }
      } catch (e) {
        console.log(
          `${p.name.padEnd(22)} doesn't build/load: ${(e as Error).message.split('\n')[0]}`
        )
        continue
      }
      rig.noteOn(57, 100)
      await sleep(3000)
      const r = (await record(3)).left
      rig.noteOff(57)
      await sleep(300)
      const det = peakFrequency(r, SAMPLE_RATE, DETECTOR_HZ - 20, DETECTOR_HZ + 20)
      const track = trackPeak(r, SAMPLE_RATE, FX_BAND)
      if (!track.hz.length || det.amplitude < 1e-4 || track.minAmplitude < 0.3 * det.amplitude) {
        console.log(`${p.name.padEnd(22)} NO READING (no telemetry tones)`)
        continue
      }
      const clock = det.hz / DETECTOR_HZ
      const tot = peakFrequency(r, SAMPLE_RATE, ...TOT_BAND).hz / clock
      const measured = cyclesFromFxTone(track.mean / clock)
      const peak = cyclesFromFxTone(track.max / clock)
      const e = est.estimate.cyclesPerVoice
      readings.push({
        name: p.name,
        date: new Date().toISOString().slice(0, 10),
        cycles: Math.round(measured),
        maxCycles: Math.round(peak),
        estimate: e
      })
      console.log(
        `${p.name.padEnd(22)} measured ${measured.toFixed(0).padStart(5)} (max ${peak.toFixed(0).padStart(5)})  ` +
          `estimate ${String(e).padStart(4)}  ratio ${(measured / e).toFixed(2)}  ` +
          `budget ${(XD ? cyclesFromXdTotTone(tot) : cyclesFromTotTone(tot)).toFixed(0)}`
      )
    }
  } finally {
    rig.allNotesOff()
    if (snapshot)
      console.log((await restore(rig, snapshot).catch((e) => [`RESTORE FAILED: ${e}`])).join('\n'))
    rig.close()
  }
  if (!filters.length) writeFileSync(READINGS_FILE, JSON.stringify(readings, null, 2) + '\n')
  if (readings.length) {
    // One scale, relative least squares: real = k * estimate.
    const k =
      readings.reduce((s, r) => s + r.estimate / r.cycles, 0) /
      readings.reduce((s, r) => s + (r.estimate / r.cycles) ** 2, 0)
    const errors = readings.map((r) => (k * r.estimate) / r.cycles - 1)
    console.log(
      `\nreal = ${k.toFixed(2)} x estimate; errors ${(Math.min(...errors) * 100).toFixed(0)}..${(Math.max(...errors) * 100).toFixed(0)} %`
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

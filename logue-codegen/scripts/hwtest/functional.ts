/**
 * Functional checks on a real NTS-1 mkII: each case is a small REVERB-slot effect with its own
 * source (noise or a sine at the effect's fixed middle C) feeding the primitive under test, every
 * setting baked in. The device's recording and a host render of the same generated code
 * (`hostRender.ts`) are compared:
 * - third-octave band levels, after removing the device chain's own response (gain, DAC and
 *   interface filters), measured by the `chain-white` case against its host render;
 * - for tonal cases, the listed tones' levels relative to the first (the fundamental), and its
 *   frequency.
 * The chain's linearity is shown with a sine at two levels (harmonics against the host's).
 * Each other case passes or fails against `TOLERANCE`; the exit code is 1 if any fails.
 *
 * Usage: npx tsx logue-codegen/scripts/hwtest/functional.ts [--xd] [name filter ...]
 *   --xd: the minilogue xd (the same cases in its REVERB slot, against harness/minilogue-xd-fx).
 * Writes each recording (device and host, float WAV) into the run's snapshot folder.
 * Leaves the device as it was (reverb slot 1 and the program restored and verified).
 */
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { PatchDocument } from '../../../src/shared/domain/patch'
import type { ParamValue } from '../../../src/shared/domain/paramValueTypes'
import { doc, IN, obj, OUT, wire } from '../nts1FxProbeUnits'
import { bandLevels, centsBetween, peakFrequency, THIRD_OCTAVES, toneLevel } from './analysis'
import { record, SAMPLE_RATE } from './audioCapture'
import { buildNts1Unit, buildXdUnit } from './buildUnit'
import { factory, programFrom, restore, select, takeSnapshot, type Snapshot } from './deviceState'
import { renderFxOnHost, renderXdFxOnHost } from './hostRender'
import { LogueRig, sleep } from './rig'

const SETTLE_S = 1.5
/** minilogue xd CCs (its MIDI implementation, 2-1): effects on/off, the reverb's USER1. */
const XD_CC = { modOn: 92, delayOn: 93, reverbOn: 94, reverbType: 90 }
const SECONDS = 4
/** Middle C: an effect's fixed note, so an effect's sine plays it at COARSE 0. */
const C4 = 261.6255653

interface Case {
  name: string
  doc: PatchDocument
  /** Tones to compare (Hz); the first is the reference the others are measured against. */
  tones?: number[]
}

const p = (name: string, value: number | string): ParamValue => ({ name, value: String(value) })

/** White noise at -12 dB (LEVEL 75) into `node` (its input `inlet`), its `outlet` to the output. */
function noiseInto(name: string, node: [string, ParamValue[]], outlet = 'out', color = 0): Case {
  return {
    name,
    doc: doc(
      'revfx',
      [
        IN,
        obj('n', 'logue/osc/noise', [p('COLOR', color), p('LEVEL', 75)]),
        obj('dut', node[0], node[1]),
        OUT
      ],
      [wire('n', 'out', 'dut', 'in'), wire('dut', outlet, 'out', 'l')]
    )
  }
}

/** A sine at middle C, scaled by a VCA (GAIN 25 = unity), into `node`, its `outlet` out. */
function sineInto(
  name: string,
  gain: number,
  node: [string, ParamValue[]] | undefined,
  tones: number[],
  outlet = 'out'
): Case {
  const nodes = [
    IN,
    obj('s', 'logue/osc/sine'),
    obj('g', 'logue/gain/vca', [p('GAIN', gain)]),
    ...(node ? [obj('dut', node[0], node[1])] : []),
    OUT
  ]
  const nets = [
    wire('s', 'out', 'g', 'in'),
    ...(node
      ? [wire('g', 'out', 'dut', 'in'), wire('dut', outlet, 'out', 'l')]
      : [wire('g', 'out', 'out', 'l')])
  ]
  return { name, doc: doc('revfx', nodes, nets), tones }
}

const harmonics = (n: number): number[] => Array.from({ length: n }, (_, k) => C4 * (k + 1))

const CASES: Case[] = [
  noiseInto('chain-white', ['logue/gain/vca', [p('GAIN', 25)]]),
  // The device's own floor (hum, noise): nothing the unit outputs. A band or tone within 10 dB of
  // it can't be judged.
  noiseInto('chain-silence', ['logue/gain/vca', [p('GAIN', 0)]]),
  sineInto('chain-sine-6dB', 12.5, undefined, harmonics(5)),
  sineInto('chain-sine-20dB', 2.5, undefined, harmonics(5)),
  ...[
    ['noise-pink', 1],
    ['noise-brown', 2],
    ['noise-violet', 3]
  ].map(([name, color]) =>
    noiseInto(name as string, ['logue/gain/vca', [p('GAIN', 25)]], 'out', color as number)
  ),
  {
    name: 'lfsr-long',
    doc: doc(
      'revfx',
      [IN, obj('l', 'logue/osc/lfsr', [p('LEVEL', 75)]), OUT],
      [wire('l', 'out', 'out', 'l')]
    )
  },
  {
    name: 'lfsr-short',
    doc: doc(
      'revfx',
      [IN, obj('l', 'logue/osc/lfsr', [p('MODE', 1), p('LEVEL', 75)]), OUT],
      [wire('l', 'out', 'out', 'l')]
    ),
    tones: harmonics(5)
  },
  noiseInto('ladder-c50-r0', ['logue/filter/ladder', [p('CUTOFF', 50), p('RESONANCE', 0)]]),
  noiseInto('ladder-c50-r70', ['logue/filter/ladder', [p('CUTOFF', 50), p('RESONANCE', 70)]]),
  noiseInto('ladder-c35-r90-fb60', [
    'logue/filter/ladder',
    [p('CUTOFF', 35), p('RESONANCE', 90), p('FB_DRIVE', 60)]
  ]),
  noiseInto('ladder-c60-drive50', [
    'logue/filter/ladder',
    [p('CUTOFF', 60), p('RESONANCE', 20), p('DRIVE', 50)]
  ]),
  {
    // RESONANCE 100 self-oscillates on the cutoff, here tracked to the effect's middle C.
    name: 'ladder-selfosc',
    doc: doc(
      'revfx',
      [IN, obj('f', 'logue/filter/ladder', [p('RESONANCE', 100), p('TRACK', 100)]), OUT],
      [wire('f', 'out', 'out', 'l')]
    ),
    tones: harmonics(3)
  },
  noiseInto('eq-bell+18', [
    'logue/filter/eq-band',
    [p('TYPE', 0), p('FREQ', 50), p('GAIN', 100), p('Q', 25)]
  ]),
  noiseInto('eq-bell-18-q8', [
    'logue/filter/eq-band',
    [p('TYPE', 0), p('FREQ', 60), p('GAIN', -100), p('Q', 75)]
  ]),
  noiseInto('eq-loshelf+12', [
    'logue/filter/eq-band',
    [p('TYPE', 1), p('FREQ', 40), p('GAIN', 67)]
  ]),
  noiseInto('eq-hishelf-12', [
    'logue/filter/eq-band',
    [p('TYPE', 2), p('FREQ', 70), p('GAIN', -67)]
  ]),
  noiseInto('eq-notch', ['logue/filter/eq-band', [p('TYPE', 3), p('FREQ', 55), p('Q', 50)]]),
  noiseInto('tilt+100', ['logue/filter/tilt', [p('TILT', 100)]]),
  noiseInto('tilt-100', ['logue/filter/tilt', [p('TILT', -100)]]),
  noiseInto('svf-notch', ['logue/filter/svf', [p('CUTOFF', 60), p('RESONANCE', 50)]], 'notch'),
  noiseInto('svf-ap', ['logue/filter/svf', [p('CUTOFF', 60), p('RESONANCE', 50)]], 'ap'),
  sineInto('drive-50', 12.5, ['logue/shape/drive', [p('DRIVE', 50), p('TONE', 50)]], harmonics(7)),
  sineInto(
    'drive-100-tone20',
    12.5,
    ['logue/shape/drive', [p('DRIVE', 100), p('TONE', 20)]],
    harmonics(7)
  ),
  // 2000 * 0.5^3 = 250 Hz up on `shifted`; C4 - 250 would be the wrong sideband.
  sineInto(
    'freqshift+250',
    12.5,
    ['logue/util/freq-shift', [p('SHIFT', 50), p('MIX', 100)]],
    [C4 + 250, C4 - 250, C4],
    'shifted'
  )
]

function writeWav(path: string, x: Float32Array): void {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + x.byteLength, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(3, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(SAMPLE_RATE, 24)
  h.writeUInt32LE(SAMPLE_RATE * 4, 28)
  h.writeUInt16LE(4, 32)
  h.writeUInt16LE(32, 34)
  h.write('data', 36)
  h.writeUInt32LE(x.byteLength, 40)
  writeFileSync(path, Buffer.concat([h, Buffer.from(x.buffer, x.byteOffset, x.byteLength)]))
}

/**
 * What passes, from the first clean run's spread (every case within 0.3 dB rms, worst band
 * 1.0 dB, pitch +0.23..0.27 ct of interface clock). Bands under 60 Hz hold too few bins to judge;
 * tones the host puts below -60 dB re the first are under the device chain's own distortion
 * (its H2 at -52 dB for a -6 dBFS sine) and are only shown; bands and tones the device puts
 * within `overFloorDb` of its own floor (`chain-silence`: the xd's output carries hum and
 * rumble) can't be judged either.
 */
const TOLERANCE = {
  overFloorDb: 10,
  bandRms: 0.5,
  bandWorst: 1.5,
  minBandHz: 60,
  cents: 1,
  toneDb: 1,
  toneFloor: -60
}

const db = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`

/**
 * The xd's output reaches the interface ~8 dB hotter than the NTS-1 mkII's, and its analog path
 * misbehaves with a loud bright signal: a -6 dBFS sine's 3rd harmonic at -37 dB, and tilt+100's
 * noise growing fluctuating 30-120 Hz energy -- +2.0 dB at 63 Hz unattenuated, +9.4 dB
 * (reproducibly) at -6 dB, clean at -12 and -24 dB, so not plain clipping and not the code (the
 * same at every level on the host). Its cases end in a VCA at -12 dB (HWTEST_XD_TRIM: its GAIN),
 * host render included.
 */
function withOutputTrim(d: PatchDocument): PatchDocument {
  return {
    ...d,
    nodes: [
      ...d.nodes,
      obj('trim', 'logue/gain/vca', [p('GAIN', process.env.HWTEST_XD_TRIM ?? 6.25)])
    ],
    nets: [
      ...d.nets.map((n) =>
        n.dests.some((x) => x.obj === 'out' && x.inlet === 'l')
          ? { ...n, dests: [{ obj: 'trim', inlet: 'in' }] }
          : n
      ),
      wire('trim', 'out', 'out', 'l')
    ]
  }
}

async function main(): Promise<void> {
  const XD = process.argv.includes('--xd')
  const filters = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const cases = CASES.map((c) => (XD ? { ...c, doc: withOutputTrim(c.doc) } : c)).filter(
    (c) => !filters.length || c.name.startsWith('chain-') || filters.some((f) => c.name.includes(f))
  )
  const rig = await LogueRig.connect(XD ? 'minilogue-xd' : 'nts1mkii')
  let snapshot: Snapshot | undefined
  const results: Record<string, unknown>[] = []
  let chain: number[] | undefined
  let floorBands: number[] | undefined
  let whiteBands: number[] | undefined
  let floorRec: Float32Array | undefined
  // The interface's clock against the device's, from the first chain sine (cents).
  let clockCents: number | undefined
  const failures: string[] = []
  let checked = 0
  try {
    snapshot = await takeSnapshot(rig, ['revfx'])
    for (const [i, c] of cases.entries()) {
      const frames = Math.round((SECONDS + SETTLE_S) * SAMPLE_RATE)
      const host = (XD ? renderXdFxOnHost(c.doc, frames) : renderFxOnHost(c.doc, frames)).subarray(
        Math.round(SETTLE_S * SAMPLE_RATE)
      )
      if (XD) {
        const unit = buildXdUnit(c.doc, `lp-hwtest-xd-fn-${c.name}`, `FN ${i}`)
        rig.cc(XD_CC.reverbOn, 0)
        await rig.upload('revfx', 0, unit.body)
        // Only a program load makes the xd run a re-uploaded slot's new code.
        await rig.writeProgram(snapshot.program)
        rig.cc(XD_CC.modOn, 0)
        rig.cc(XD_CC.delayOn, 0)
        rig.cc(XD_CC.reverbType, 75)
        rig.cc(XD_CC.reverbOn, 127)
      } else {
        const unit = buildNts1Unit(c.doc, `lp-hwtest-fn-${c.name}`, `FN ${i}`, 300 + i)
        const off = programFrom(snapshot)
        for (const m of ['modfx', 'delfx', 'revfx'] as const) select(off, m, factory(0), 'OFF')
        await rig.writeProgram(off)
        await rig.upload('revfx', 0, unit.bytes)
        select(off, 'revfx', unit, `FN ${i}`)
        await rig.writeProgram(off)
      }
      await sleep(SETTLE_S * 1000)
      const dev = (await record(SECONDS)).left
      writeWav(join(snapshot.dir, `${c.name}.device.wav`), dev)
      writeWav(join(snapshot.dir, `${c.name}.host.wav`), host)

      const hb = bandLevels(host, SAMPLE_RATE)
      const devBands = bandLevels(dev, SAMPLE_RATE)
      if (c.name === 'chain-white') {
        chain = devBands.map((d, k) => d - hb[k])
        whiteBands = devBands
        const mid = chain[THIRD_OCTAVES.indexOf(1000)]
        console.log(
          `chain-white: gain ${db(mid)} dB at 1 kHz; response re 1 kHz: ` +
            THIRD_OCTAVES.map(
              (f, k) =>
                `${f < 1000 ? f.toFixed(0) : (f / 1000).toFixed(1) + 'k'} ${db(chain![k] - mid)}`
            ).join(', ')
        )
        results.push({ name: c.name, chain })
        continue
      }
      if (c.name === 'chain-silence') {
        floorBands = devBands
        floorRec = dev
        // How far under the white-noise case (-12 dB) the floor sits, at its closest band.
        const gap = devBands.map((f, k) => (whiteBands ? whiteBands[k] - f : NaN))
        const k = gap.reduce((a, g, j) => (g < gap[a] ? j : a), 0)
        console.log(
          `chain-silence: the floor sits ${gap[k].toFixed(0)} dB or more under the white-noise ` +
            `case (closest at ${THIRD_OCTAVES[k].toFixed(0)} Hz)`
        )
        results.push({ name: c.name, floorBands })
        continue
      }
      if (!chain || !floorBands || !floorRec) throw new Error('the chain cases must run first')
      // Bands the host has energy in (within 45 dB of its loudest), corrected by the chain.
      const top = Math.max(...hb)
      const errs = hb
        .map((h, k) => ({ f: THIRD_OCTAVES[k], e: devBands[k] - chain![k] - h, h, k }))
        .filter(
          (b) =>
            b.h > top - 45 &&
            b.f >= TOLERANCE.minBandHz &&
            devBands[b.k] > floorBands![b.k] + TOLERANCE.overFloorDb
        )
      const worst = errs.reduce((a, b) => (Math.abs(b.e) > Math.abs(a.e) ? b : a))
      const rmsErr = Math.sqrt(errs.reduce((s, b) => s + b.e * b.e, 0) / errs.length)
      let line = `${c.name.padEnd(20)} bands: rms ${rmsErr.toFixed(2)} dB, worst ${db(worst.e)} dB at ${worst.f.toFixed(0)} Hz`
      const result: Record<string, unknown> = { name: c.name, rmsErr, worst }
      const info = c.name.startsWith('chain-')
      const why: string[] = []
      if (rmsErr > TOLERANCE.bandRms) why.push(`band rms ${rmsErr.toFixed(2)} dB`)
      if (Math.abs(worst.e) > TOLERANCE.bandWorst)
        why.push(`band ${worst.f.toFixed(0)} Hz ${db(worst.e)} dB`)
      if (c.tones) {
        const chainAt = (hz: number): number => {
          const k = THIRD_OCTAVES.reduce(
            (b, f, j) =>
              Math.abs(Math.log(f / hz)) < Math.abs(Math.log(THIRD_OCTAVES[b] / hz)) ? j : b,
            0
          )
          return chain![k]
        }
        const rel = (x: Float32Array, correct: boolean): number[] => {
          const ref = toneLevel(x, SAMPLE_RATE, c.tones![0]) - (correct ? chainAt(c.tones![0]) : 0)
          return c.tones!.map(
            (t) => toneLevel(x, SAMPLE_RATE, t) - (correct ? chainAt(t) : 0) - ref
          )
        }
        const d = rel(dev, true)
        const h = rel(host, false)
        const f0 = peakFrequency(dev, SAMPLE_RATE, c.tones[0] * 0.9, c.tones[0] * 1.1).hz
        const hf0 = peakFrequency(host, SAMPLE_RATE, c.tones[0] * 0.9, c.tones[0] * 1.1).hz
        line +=
          `\n${''.padEnd(20)} tone ${f0.toFixed(2)} Hz (host ${hf0.toFixed(2)}, ${centsBetween(f0, hf0).toFixed(2)} ct); ` +
          `levels re the first, device / host dB: ` +
          c.tones
            .slice(1)
            .map((t, k) => `${t.toFixed(0)} ${d[k + 1].toFixed(1)}/${h[k + 1].toFixed(1)}`)
            .join(', ')
        Object.assign(result, { f0, hf0, device: d, host: h })
        const cents = centsBetween(f0, hf0)
        if (info) clockCents ??= cents
        else if (Math.abs(cents - (clockCents ?? 0)) > TOLERANCE.cents)
          why.push(`pitch ${cents.toFixed(2)} ct`)
        c.tones.forEach((t, k) => {
          if (k === 0 || info || h[k] < TOLERANCE.toneFloor) return
          const level = toneLevel(dev, SAMPLE_RATE, t)
          if (level < toneLevel(floorRec!, SAMPLE_RATE, t) + TOLERANCE.overFloorDb) {
            line += `\n${''.padEnd(20)} ${t.toFixed(0)} Hz: under the device's floor, not judged`
            return
          }
          if (Math.abs(d[k] - h[k]) > TOLERANCE.toneDb)
            why.push(`${t.toFixed(0)} Hz ${d[k].toFixed(1)} vs ${h[k].toFixed(1)} dB`)
        })
      }
      if (!info) {
        checked++
        if (why.length) failures.push(`${c.name}: ${why.join(', ')}`)
      }
      console.log(`${info ? 'info' : why.length ? 'FAIL' : 'pass'} ${line}`)
      Object.assign(result, { pass: info ? undefined : why.length === 0, why })
      results.push(result)
    }
  } finally {
    if (snapshot) {
      writeFileSync(join(snapshot.dir, 'functional.json'), JSON.stringify(results, null, 2))
      console.log((await restore(rig, snapshot).catch((e) => [`RESTORE FAILED: ${e}`])).join('\n'))
    }
    rig.close()
  }
  console.log(
    failures.length
      ? `\n${failures.length} of ${checked} FAILED:\n${failures.join('\n')}`
      : `\nall ${checked} passed`
  )
  if (failures.length) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

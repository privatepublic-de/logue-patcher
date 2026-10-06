/**
 * Oscillator-path checks on a real device: what the effect-slot cases (`functional.ts`) can't
 * reach -- the firmware's note table and sine table, note tracking, the voice. Each case is an
 * oscillator unit in OSC slot 1 (every setting baked in, ending in a VCA at -20 dB: the NTS-1
 * mkII's voice section soft-clips a full-scale oscillator), played at one or more notes and
 * compared with a host render of the same generated code (`hostRender.ts`; on the NTS-1 mkII
 * the SDK's own osc_api.h over formula-filled tables, so what differs is the firmware's):
 * - `pitch`: a sine over notes 24..120, each note's cents against equal temperament after the
 *   median (which holds the interface clock and any master tune) is taken out;
 * - tonal cases: harmonic levels re the fundamental, for harmonics the host puts above -60 dB;
 * - noise-fed cases: third-octave levels, after the chain's response (`chain-white`).
 * The voice is made neutral first (`neutralVoice`). Pass/fail like `functional.ts`.
 *
 * minilogue xd (`--xd`): the unit in the multi engine's USER1, the voice made neutral by CC
 * (`XD_VOICE`, after the program write that makes the xd load a re-uploaded slot), compared with
 * `renderXdOscOnHost`. Its voice runs through the analog filter (fully open, no keytrack), which
 * `chain-white` measures like the rest of the chain.
 *
 * Usage: npx tsx logue-codegen/scripts/hwtest/oscChecks.ts [--xd] [name filter ...]
 * Leaves the device as it was (osc slot 1 and the program restored and verified).
 * `--host` touches no device: every case's host render on both platforms (level, peak, finite),
 * to check a new case before a device run.
 */
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { ObjNode, PatchDocument } from '../../../src/shared/domain/patch'
import type { ParamValue } from '../../../src/shared/domain/paramValueTypes'
import { LOGUE_AUDIO_OUT_TYPE } from '../../src/oscInstances'
import {
  bandLevels,
  centsBetween,
  noteHz,
  peakFrequency,
  THIRD_OCTAVES,
  toneLevel
} from './analysis'
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
import { renderNts1OscOnHost, renderXdOscOnHost } from './hostRender'
import { LogueRig, sleep } from './rig'

const XD = process.argv.includes('--xd')
const SETTLE_S = 0.6
const SECONDS = 3
/** Noise-fed cases: with 3 s the lowest third octaves (a few bins each) scattered +-2 dB between
 *  two noise recordings (svf-tracked at 63 Hz); twice as long narrows that by sqrt(2). */
const NOISE_SECONDS = 6
const TOLERANCE = {
  bandRms: 0.5,
  bandWorst: 1.5,
  minBandHz: 60,
  overFloorDb: 10,
  /** Each note's deviation from equal temperament once the median is out. */
  trackingCents: 1,
  toneDb: 1,
  toneFloor: -60
}

const p = (name: string, value: number | string): ParamValue => ({ name, value: String(value) })
const obj = (name: string, type: string, params: ParamValue[] = []): ObjNode => ({
  kind: 'obj',
  type,
  name,
  x: 0,
  y: 0,
  params
})

/** A chain of nodes, each into the next's `in` (the first is the source), ending in the trim. */
function chain(...nodes: [string, string, ParamValue[], string?][]): PatchDocument {
  const all = [
    ...nodes,
    ['trim', 'logue/gain/vca', [p('GAIN', 2.5)]] as [string, string, ParamValue[]]
  ]
  return {
    nodes: [...all.map(([n, t, ps]) => obj(n, t, ps)), obj('out', LOGUE_AUDIO_OUT_TYPE)],
    nets: all.map(([n, , , outlet], k) => ({
      sources: [{ obj: n, outlet: outlet ?? 'out' }],
      dests: [
        k + 1 < all.length ? { obj: all[k + 1][0], inlet: 'in' } : { obj: 'out', inlet: 'in' }
      ]
    })),
    settings: { logueTarget: { module: 'osc' } },
    notes: ''
  }
}

interface Case {
  name: string
  doc: PatchDocument
  notes: number[]
  /** Compare the first `harmonics` harmonics of each note (else third-octave bands). */
  harmonics?: number
}

const noise = (): [string, string, ParamValue[]] => ['n', 'logue/osc/noise', [p('LEVEL', 75)]]
/** +12 dB, for a case whose filter takes most of the noise away (host under ~-45 dBFS). */
const boost = (): [string, string, ParamValue[]] => ['g', 'logue/gain/vca', [p('GAIN', 100)]]
const CASES: Case[] = [
  { name: 'chain-white', doc: chain(noise()), notes: [57] },
  {
    name: 'chain-silence',
    doc: chain(noise(), ['mute', 'logue/gain/vca', [p('GAIN', 0)]]),
    notes: [57]
  },
  {
    name: 'pitch',
    doc: chain(['s', 'logue/osc/sine', []]),
    notes: [24, 36, 48, 57, 60, 69, 72, 84, 96, 108, 120]
  },
  { name: 'sine', doc: chain(['s', 'logue/osc/sine', []]), notes: [45, 81], harmonics: 5 },
  { name: 'saw', doc: chain(['s', 'logue/osc/saw', []]), notes: [45, 69, 93], harmonics: 10 },
  { name: 'square', doc: chain(['s', 'logue/osc/square', []]), notes: [45, 69, 93], harmonics: 10 },
  {
    name: 'pulse-25',
    doc: chain(['s', 'logue/osc/pulse', [p('WIDTH', 25)]]),
    notes: [45, 81],
    harmonics: 10
  },
  { name: 'triangle', doc: chain(['s', 'logue/osc/triangle', []]), notes: [45, 81], harmonics: 7 },
  {
    name: 'sync-7',
    doc: chain(['s', 'logue/osc/sync', [p('SYNC', 7)]]),
    notes: [45, 69],
    harmonics: 10
  },
  {
    name: 'phase-dist',
    doc: chain(['s', 'logue/osc/phase-dist', [p('DCW', 60)]]),
    notes: [45, 69],
    harmonics: 10
  },
  {
    name: 'svf-tracked',
    doc: chain(noise(), ['f', 'logue/filter/svf', [p('TRACK', 100), p('RESONANCE', 80)], 'lp']),
    notes: [45, 69]
  },
  {
    name: 'comb-tracked',
    doc: chain(noise(), ['f', 'logue/filter/comb', [p('TRACK', 100), p('FEEDBACK', 80)]]),
    notes: [57]
  },
  // The primitives `functional.ts` only checked as effects (2026-10-06). Inside an oscillator they
  // read the firmware's note table (lfsr/ladder/svf tracking, ladder/eq/tilt cutoffs through
  // note_w0) and sine table (freq-shift's carrier), which an effect's stand-ins replace.
  ...(
    [
      ['noise-pink', 1],
      ['noise-brown', 2],
      ['noise-violet', 3]
    ] as const
  ).map(([name, color]): Case => ({
    name,
    doc: chain(['n', 'logue/osc/noise', [p('COLOR', color), p('LEVEL', 75)]]),
    notes: [57]
  })),
  // TRACK on (the default): the clock is 127x the note, so the long sequence's spectrum moves
  // with it and the short loop plays the note itself.
  { name: 'lfsr-long', doc: chain(['l', 'logue/osc/lfsr', [p('LEVEL', 75)]]), notes: [45, 69] },
  {
    name: 'lfsr-short',
    doc: chain(['l', 'logue/osc/lfsr', [p('MODE', 1), p('LEVEL', 75)]]),
    notes: [45, 69],
    harmonics: 10
  },
  {
    name: 'ladder-c50-r70',
    doc: chain(
      noise(),
      ['f', 'logue/filter/ladder', [p('CUTOFF', 50), p('RESONANCE', 70)]],
      boost()
    ),
    notes: [57]
  },
  {
    // Self-oscillation on the tracked note, started by the ladder's own -120 dB noise (silent
    // input): ~200 ms at A3, inside the settle time.
    name: 'ladder-selfosc',
    doc: chain(
      ['n', 'logue/osc/noise', [p('LEVEL', 0)]],
      ['f', 'logue/filter/ladder', [p('RESONANCE', 100), p('TRACK', 100)]]
    ),
    notes: [57, 69],
    harmonics: 3
  },
  {
    name: 'eq-bell+18',
    doc: chain(noise(), [
      'f',
      'logue/filter/eq-band',
      [p('TYPE', 0), p('FREQ', 50), p('GAIN', 100), p('Q', 25)]
    ]),
    notes: [57]
  },
  {
    name: 'eq-hishelf-12',
    doc: chain(
      noise(),
      ['f', 'logue/filter/eq-band', [p('TYPE', 2), p('FREQ', 70), p('GAIN', -67)]],
      boost()
    ),
    notes: [57]
  },
  {
    name: 'tilt+100',
    doc: chain(noise(), ['f', 'logue/filter/tilt', [p('TILT', 100)]]),
    notes: [57]
  },
  {
    name: 'svf-notch-tracked',
    doc: chain(noise(), ['f', 'logue/filter/svf', [p('TRACK', 100), p('RESONANCE', 50)], 'notch']),
    notes: [45, 69]
  },
  {
    name: 'drive-50',
    doc: chain(
      ['s', 'logue/osc/sine', []],
      ['h', 'logue/gain/vca', [p('GAIN', 12.5)]],
      ['d', 'logue/shape/drive', [p('DRIVE', 50), p('TONE', 50)]]
    ),
    notes: [45, 69],
    harmonics: 7
  },
  {
    // 2000 * 0.5^3 = 250 Hz up, every partial of a saw: no longer harmonic, so third octaves.
    name: 'freqshift+250',
    doc: chain(
      ['s', 'logue/osc/saw', []],
      ['f', 'logue/util/freq-shift', [p('SHIFT', 50), p('MIX', 100)], 'shifted']
    ),
    notes: [45]
  },
  {
    // Per-block coefficients since 2026-10-06. Three narrow bands of noise are quiet (-62 dBFS
    // at RESONANCE 70 through the trim): wider bands and +12 dB keep it clear of the floor.
    name: 'formant',
    doc: chain(
      noise(),
      [
        'f',
        'logue/filter/formant',
        [p('VOWEL', 30), p('CHARACTER', 60), p('RESONANCE', 30), p('SHIFT', 3)]
      ],
      boost()
    ),
    notes: [57]
  }
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

const db = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`

/** `--host`: no device -- every case's host render on both platforms, its level and peak, so a
 *  new case can be checked for silence, clipping or a build error before a device run. */
function hostDryRun(cases: Case[]): void {
  for (const c of cases)
    for (const note of c.notes)
      for (const [platform, render] of [
        ['nts1', renderNts1OscOnHost],
        ['xd', renderXdOscOnHost]
      ] as const) {
        const x = render(c.doc, Math.round((SECONDS + SETTLE_S) * SAMPLE_RATE), note).subarray(
          Math.round(SETTLE_S * SAMPLE_RATE)
        )
        const finite = x.every(Number.isFinite)
        const rms = Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length)
        const peak = x.reduce((a, v) => Math.max(a, Math.abs(v)), 0)
        console.log(
          `${c.name.padEnd(20)} ${String(note).padStart(3)} ${platform.padEnd(4)} ` +
            `rms ${db(20 * Math.log10(rms))} dBFS, peak ${peak.toFixed(3)}${finite ? '' : ' NON-FINITE'}`
        )
      }
}

async function main(): Promise<void> {
  const filters = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const cases = CASES.filter(
    (c) => !filters.length || c.name.startsWith('chain-') || filters.some((f) => c.name.includes(f))
  )
  if (process.argv.includes('--host')) return hostDryRun(cases)
  const rig = await LogueRig.connect(XD ? 'minilogue-xd' : 'nts1mkii')
  let snapshot: Snapshot | undefined
  const failures: string[] = []
  let checked = 0
  let chainBands: number[] | undefined
  let floorBands: number[] | undefined
  let floorRec: Float32Array | undefined
  const results: Record<string, unknown>[] = []
  // The interface's clock against the device's, from the pitch case's median (cents): a tonal
  // case's fundamental is the note's frequency times it, not searched for -- an oscillator
  // can put almost nothing at its own fundamental (sync at an octave).
  let clockCents = 0
  try {
    snapshot = await takeSnapshot(rig, ['osc'])
    rig.send([0xe0 | rig.channel, 0, 0x40])
    for (const [i, c] of cases.entries()) {
      if (XD) {
        const unit = buildXdUnit(c.doc, `lp-hwtest-xd-osc-${c.name}`, `FN ${i}`)
        await rig.upload('osc', 0, unit.body)
        // Only a program load makes the xd run a re-uploaded slot's new code.
        await rig.writeProgram(snapshot.program)
        await neutralXdVoice(rig)
      } else {
        const unit = buildNts1Unit(c.doc, `lp-hwtest-osc-${c.name}`, `FN ${i}`, 500 + i)
        // A fresh unit id per case, and a factory oscillator selected while uploading.
        const program = programFrom(snapshot)
        neutralVoice(program)
        select(program, 'osc', factory(1), 'SAW')
        await rig.writeProgram(program)
        await rig.upload('osc', 0, unit.bytes)
        select(program, 'osc', unit, `FN ${i}`)
        await rig.writeProgram(program)
      }
      await sleep(300)

      const why: string[] = []
      const lines: string[] = []
      const play = async (note: number, seconds: number): Promise<Float32Array> => {
        rig.noteOn(note, 100)
        await sleep(SETTLE_S * 1000)
        const r = (await record(seconds)).left
        rig.noteOff(note)
        await sleep(250)
        return r
      }
      const host = (note: number, seconds: number): Float32Array =>
        (XD ? renderXdOscOnHost : renderNts1OscOnHost)(
          c.doc,
          Math.round((seconds + SETTLE_S) * SAMPLE_RATE),
          note
        ).subarray(Math.round(SETTLE_S * SAMPLE_RATE))

      if (c.name === 'pitch') {
        const rows: { note: number; cents: number }[] = []
        for (const note of c.notes) {
          const r = await play(note, 2)
          const want = noteHz(note)
          const hz = peakFrequency(r, SAMPLE_RATE, want * 0.94, want * 1.06).hz
          rows.push({ note, cents: centsBetween(hz, want) })
        }
        const sorted = rows.map((r) => r.cents).sort((a, b) => a - b)
        const median = sorted[sorted.length >> 1]
        lines.push(
          `median offset ${median.toFixed(2)} ct; re it: ` +
            rows.map((r) => `${r.note} ${(r.cents - median).toFixed(2)}`).join(', ')
        )
        for (const r of rows)
          if (Math.abs(r.cents - median) > TOLERANCE.trackingCents)
            why.push(`note ${r.note} ${(r.cents - median).toFixed(2)} ct`)
        clockCents = median
        results.push({ name: c.name, median, rows })
      } else {
        for (const note of c.notes) {
          const seconds = c.harmonics ? SECONDS : NOISE_SECONDS
          const dev = await play(note, seconds)
          const ref = host(note, seconds)
          writeWav(join(snapshot.dir, `${c.name}-${note}.device.wav`), dev)
          writeWav(join(snapshot.dir, `${c.name}-${note}.host.wav`), ref)
          const hb = bandLevels(ref, SAMPLE_RATE)
          const devBands = bandLevels(dev, SAMPLE_RATE)
          if (c.name === 'chain-white') {
            chainBands = devBands.map((d, k) => d - hb[k])
            const mid = chainBands[THIRD_OCTAVES.indexOf(1000)]
            lines.push(
              `gain ${db(mid)} dB at 1 kHz; re it: ` +
                THIRD_OCTAVES.map(
                  (f, k) =>
                    `${f < 1000 ? f.toFixed(0) : (f / 1000).toFixed(1) + 'k'} ${db(chainBands![k] - mid)}`
                ).join(', ')
            )
            continue
          }
          if (c.name === 'chain-silence') {
            floorBands = devBands
            floorRec = dev
            const level = Math.sqrt(dev.reduce((a, v) => a + v * v, 0) / dev.length)
            lines.push(`the device's floor: ${(20 * Math.log10(level)).toFixed(1)} dBFS RMS`)
            continue
          }
          if (!chainBands || !floorBands || !floorRec)
            throw new Error('the chain cases must run first')
          if (c.harmonics) {
            const f0 = noteHz(note) * Math.pow(2, clockCents / 1200)
            const hf0 = noteHz(note)
            const chainAt = (hz: number): number => {
              const k = THIRD_OCTAVES.reduce(
                (b, f, j) =>
                  Math.abs(Math.log(f / hz)) < Math.abs(Math.log(THIRD_OCTAVES[b] / hz)) ? j : b,
                0
              )
              return chainBands![k]
            }
            const levels = (x: Float32Array, f: number, correct: boolean): number[] =>
              Array.from(
                { length: c.harmonics! },
                (_, k) =>
                  toneLevel(x, SAMPLE_RATE, f * (k + 1)) - (correct ? chainAt(f * (k + 1)) : 0)
              )
            const d = levels(dev, f0, true)
            const h = levels(ref, hf0, false)
            const shown: string[] = []
            for (let k = 1; k < c.harmonics; k++) {
              const hk = h[k] - h[0]
              const dk = d[k] - d[0]
              if (hk < TOLERANCE.toneFloor || f0 * (k + 1) > 16000) continue
              if (
                toneLevel(dev, SAMPLE_RATE, f0 * (k + 1)) <
                toneLevel(floorRec, SAMPLE_RATE, f0 * (k + 1)) + TOLERANCE.overFloorDb
              )
                continue
              shown.push(`h${k + 1} ${dk.toFixed(1)}/${hk.toFixed(1)}`)
              if (Math.abs(dk - hk) > TOLERANCE.toneDb)
                why.push(`note ${note} h${k + 1} ${dk.toFixed(1)} vs ${hk.toFixed(1)} dB`)
            }
            lines.push(
              `note ${note}: ${f0.toFixed(2)} Hz (host ${hf0.toFixed(2)}); device/host dB re h1: ${shown.join(', ')}`
            )
            results.push({ name: c.name, note, f0, hf0, device: d, host: h })
          } else {
            const top = Math.max(...hb)
            const errs = hb
              .map((h, k) => ({ f: THIRD_OCTAVES[k], e: devBands[k] - chainBands![k] - h, h, k }))
              .filter(
                (b) =>
                  b.h > top - 45 &&
                  b.f >= TOLERANCE.minBandHz &&
                  devBands[b.k] > floorBands![b.k] + TOLERANCE.overFloorDb
              )
            const worst = errs.reduce((a, b) => (Math.abs(b.e) > Math.abs(a.e) ? b : a))
            const rmsErr = Math.sqrt(errs.reduce((s, b) => s + b.e * b.e, 0) / errs.length)
            lines.push(
              `note ${note}: bands rms ${rmsErr.toFixed(2)} dB, worst ${db(worst.e)} dB at ${worst.f.toFixed(0)} Hz`
            )
            if (rmsErr > TOLERANCE.bandRms)
              why.push(`note ${note} band rms ${rmsErr.toFixed(2)} dB`)
            if (Math.abs(worst.e) > TOLERANCE.bandWorst)
              why.push(`note ${note} band ${worst.f.toFixed(0)} Hz ${db(worst.e)} dB`)
            results.push({ name: c.name, note, rmsErr, worst })
          }
        }
      }
      const info = c.name.startsWith('chain-')
      if (!info) {
        checked++
        if (why.length) failures.push(`${c.name}: ${why.join(', ')}`)
      }
      console.log(`${info ? 'info' : why.length ? 'FAIL' : 'pass'} ${c.name}`)
      for (const l of lines) console.log(`     ${l}`)
    }
  } finally {
    rig.allNotesOff()
    if (snapshot) {
      writeFileSync(join(snapshot.dir, 'oscChecks.json'), JSON.stringify(results, null, 2))
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

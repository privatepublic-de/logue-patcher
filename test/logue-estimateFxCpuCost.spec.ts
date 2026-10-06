import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect } from 'vitest'
import {
  estimateFxCpuCost,
  fxCpuZone,
  fxCyclesOn,
  NTS1MKII_FX_CLEAN_CYCLES,
  NTS1MKII_FX_DROPOUT_CYCLES,
  NTS1MKII_FX_SOLO_CYCLES,
  XD_FX_CLEAN_CYCLES,
  XD_FX_DROPOUT_CYCLES,
  XD_FX_SOLO_CYCLES
} from '../logue-codegen/src/estimateFxCpuCost'
import { FX_CPU_BASELINE, FX_CPU_COST_TABLE } from '../logue-codegen/src/fxCpuCostTable'
import { LOGUE_AUDIO_IN_TYPE, LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import type { LogueModule, Net, ObjNode, PatchDocument } from '../src/shared/domain/patch'
import { parsePatchFile } from '../src/shared/json/patchCodec'
import { CPU_COST_TABLE } from '../logue-codegen/src/cpuCostTable'
import { exampleSubpatches, examplesDir } from '../logue-codegen/scripts/exampleSubpatches'
import {
  NTS1MKII_FX_PROBE_READINGS,
  XD_FX_DEVICE_READINGS,
  type DeviceReading
} from '../logue-codegen/scripts/nts1FxProbeUnits'

function node(type: string, name: string, params: ObjNode['params'] = []): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params }
}
function net(from: string, outlet: string, to: string, inlet: string): Net {
  return { sources: [{ obj: from, outlet }], dests: [{ obj: to, inlet }] }
}
function fx(nodes: ObjNode[], nets: Net[], module: LogueModule = 'delfx'): PatchDocument {
  return {
    nodes: [node(LOGUE_AUDIO_IN_TYPE, 'in'), ...nodes, node(LOGUE_AUDIO_OUT_TYPE, 'out')],
    nets,
    settings: { logueTarget: { module } },
    notes: ''
  }
}
function ok(
  doc: PatchDocument,
  platform: 'minilogue-xd' | 'nts1mkii' = 'minilogue-xd'
): NonNullable<Extract<ReturnType<typeof estimateFxCpuCost>, { status: 'ok' }>>['estimate'] {
  const r = estimateFxCpuCost(doc, new Map(), platform)
  if (r.status !== 'ok') throw new Error(r.reason)
  return r.estimate
}

const delay = FX_CPU_COST_TABLE['logue/util/long-delay'].variants
const cost = (c: { cycles: number; sdram: number }): number =>
  Math.round(fxCyclesOn(c, 'minilogue-xd'))

describe('estimateFxCpuCost', () => {
  it('counts a primitive first, then shared + extra, then extra', () => {
    const e = ok(
      fx(
        [
          node('logue/util/long-delay', 'a'),
          node('logue/util/long-delay', 'b'),
          node('logue/util/long-delay', 'c')
        ],
        [
          net('in', 'mono', 'a', 'in'),
          net('a', 'out', 'b', 'in'),
          net('b', 'out', 'c', 'in'),
          net('c', 'out', 'out', 'l')
        ]
      )
    )
    const second = {
      cycles: delay.base.extra.cycles + delay.base.shared.cycles,
      sdram: delay.base.extra.sdram + delay.base.shared.sdram
    }
    expect(e.perInstance.map((i) => [i.nodeName, i.variant, i.cycles])).toEqual([
      ['a', 'base #1', cost(delay.base.first)],
      ['b', 'base #2', cost(second)],
      ['c', 'base #3', cost(delay.base.extra)]
    ])
    expect(e.baselineCycles).toBe(cost(FX_CPU_BASELINE.delfx))
    expect(e.cyclesPerSample).toBe(Math.round(fxCyclesOn(e.sum, 'minilogue-xd')))
  })

  it('takes the module baseline', () => {
    const pass = (module: LogueModule): PatchDocument =>
      fx([], [net('in', 'l', 'out', 'l'), net('in', 'r', 'out', 'r')], module)
    expect(ok(pass('modfx')).cyclesPerSample).toBe(cost(FX_CPU_BASELINE.modfx))
    expect(ok(pass('revfx')).cyclesPerSample).toBe(cost(FX_CPU_BASELINE.revfx))
  })

  it('counts an input from knob-only math as still (control-still), and that math as free', () => {
    const fromConstant = ok(
      fx(
        [node('logue/util/constant', 'k'), node('logue/util/long-delay', 'd')],
        [net('in', 'mono', 'd', 'in'), net('k', 'out', 'd', 'time'), net('d', 'out', 'out', 'l')]
      )
    )
    expect(fromConstant.perInstance.map((i) => [i.nodeName, i.variant])).toEqual([
      ['d', 'control-still #1']
    ])

    const fromLfo = ok(
      fx(
        [node('logue/lfo/sine-lfo', 'l'), node('logue/util/long-delay', 'd')],
        [net('in', 'mono', 'd', 'in'), net('l', 'out', 'd', 'time'), net('d', 'out', 'out', 'l')]
      )
    )
    expect(fromLfo.perInstance.find((i) => i.nodeName === 'd')).toMatchObject({
      variant: 'control #1',
      cycles: cost(delay.control.first)
    })
  })

  it('counts a grain whose trig moves as always capturing', () => {
    const doc = fx(
      [
        node('logue/util/buffer', 'buf'),
        node('logue/lfo/square-lfo', 'clk'),
        node('logue/util/grain', 'g')
      ],
      [
        net('in', 'mono', 'buf', 'in'),
        net('buf', 'buf', 'g', 'buf'),
        net('clk', 'out', 'g', 'trig'),
        net('g', 'out', 'out', 'l')
      ]
    )
    const capturing = FX_CPU_COST_TABLE['logue/util/grain'].variants['heavy-capturing']
    expect(ok(doc).perInstance.find((i) => i.nodeName === 'g')).toMatchObject({
      variant: 'heavy-capturing #1',
      cycles: cost(capturing.first)
    })
  })

  it('reaches both positions of a checkbox on a knob, and only the saved one otherwise', () => {
    const synced = (onKnob: boolean): PatchDocument =>
      fx(
        [
          node('logue/util/long-delay', 'd', [
            {
              name: 'SYNC',
              value: '0',
              ...(onKnob ? { logueKnob: { 'minilogue-xd': 'time' as const } } : {})
            }
          ])
        ],
        [net('in', 'mono', 'd', 'in'), net('d', 'out', 'out', 'l')]
      )
    const both = Math.max(cost(delay.base.first), cost(delay.SYNC.first))
    expect(ok(synced(true)).perInstance[0]).toMatchObject({
      cycles: cost(delay.base.first),
      maxCycles: both
    })
    expect(ok(synced(false)).perInstance[0].maxCycles).toBe(cost(delay.base.first))
  })

  it('names a primitive the table has no entry for and counts it as 0', () => {
    const e = ok(fx([node('logue/osc/additive', 'a')], [net('a', 'out', 'out', 'l')]))
    expect(e.unmeasured).toEqual(['logue/osc/additive'])
    expect(e.cyclesPerSample).toBe(cost(FX_CPU_BASELINE.delfx))
  })

  it('is incomplete for an oscillator or a patch the xd cannot build', () => {
    const osc: PatchDocument = {
      nodes: [node('logue/osc/saw', 's'), node(LOGUE_AUDIO_OUT_TYPE, 'out')],
      nets: [net('s', 'out', 'out', 'in')],
      settings: {},
      notes: ''
    }
    expect(estimateFxCpuCost(osc).status).toBe('incomplete')
    expect(estimateFxCpuCost(fx([], [])).status).toBe('incomplete')
  })
})

// Calibration, like the table specs: a drift only warns (a re-measured table or a rewritten
// example must not block `npm run build`); CPU_COST_STRICT=1 makes it fail.
function checkReadings(platform: 'nts1mkii' | 'minilogue-xd', readings: DeviceReading[]): void {
  const subpatches = exampleSubpatches()
  const drifted: string[] = []
  for (const r of readings) {
    const doc = r.doc ?? parsePatchFile(readFileSync(join(examplesDir, r.example!), 'utf-8'))
    const result = estimateFxCpuCost(doc, subpatches, platform)
    if (result.status !== 'ok') throw new Error(result.reason)
    const error = result.estimate.cyclesPerSample / r.cycles - 1
    if (error <= -0.25 || error >= 0.25) drifted.push(`${r.name} ${(error * 100).toFixed(0)} %`)
  }
  if (drifted.length === 0) return
  const message =
    `${platform} effect estimate outside -25..+25 % of the device reading: ${drifted.join(', ')}. ` +
    'Re-run logue-codegen/scripts/hwtest/calibrateFx.ts and re-fit.'
  if (process.env.CPU_COST_STRICT === '1') throw new Error(message)
  console.warn(message)
}

describe('estimateFxCpuCost against device readings', () => {
  it('lands every NTS-1 mkII reading within the calibration band', () => {
    checkReadings('nts1mkii', NTS1MKII_FX_PROBE_READINGS)
  })
  it('lands every minilogue xd reading within the calibration band', () => {
    expect(XD_FX_DEVICE_READINGS.length).toBeGreaterThan(10)
    checkReadings('minilogue-xd', XD_FX_DEVICE_READINGS)
  })
  it('puts the example stereo reverb in the xd\'s "solo only" band', () => {
    // Measured 2678 on a real xd: over the busy ceiling, under the alone one.
    const doc = parsePatchFile(readFileSync(join(examplesDir, 'stereo-reverb.loguepatch'), 'utf-8'))
    const r = estimateFxCpuCost(doc, new Map(), 'minilogue-xd')
    if (r.status !== 'ok') throw new Error(r.reason)
    expect(r.estimate.cyclesPerSample).toBeGreaterThan(XD_FX_DROPOUT_CYCLES)
    expect(r.estimate.cyclesPerSample).toBeLessThanOrEqual(XD_FX_SOLO_CYCLES)
  })
})

describe('estimateFxCpuCost on the NTS-1 mkII', () => {
  it('converts the xd table to M7 cycles, baseline included', () => {
    const doc = fx(
      [node('logue/util/long-delay', 'd')],
      [net('in', 'mono', 'd', 'in'), net('d', 'out', 'out', 'l')]
    )
    const e = ok(doc, 'nts1mkii')
    expect(e.perInstance[0].cycles).toBe(Math.round(fxCyclesOn(delay.base.first, 'nts1mkii')))
    expect(e.baselineCycles).toBe(Math.round(fxCyclesOn(FX_CPU_BASELINE.delfx, 'nts1mkii')))
    expect(e.sum).toEqual(ok(doc).sum)
  })

  it('reads device controls for the NTS-1 mkII, not the xd', () => {
    const synced = fx(
      [
        node('logue/util/long-delay', 'd', [
          { name: 'SYNC', value: '0', logueParamIndex: { nts1mkii: 3 } }
        ])
      ],
      [net('in', 'mono', 'd', 'in'), net('d', 'out', 'out', 'l')]
    )
    const on = (c: { cycles: number; sdram: number }): number =>
      Math.round(fxCyclesOn(c, 'nts1mkii'))
    expect(ok(synced, 'nts1mkii').perInstance[0].maxCycles).toBe(
      Math.max(on(delay.base.first), on(delay.SYNC.first))
    )
    expect(ok(synced).perInstance[0].maxCycles).toBe(cost(delay.base.first))
  })

  it('counts a primitive no xd effect holds at its xd oscillator cost', () => {
    const e = ok(fx([node('logue/osc/additive', 'a')], [net('a', 'out', 'out', 'l')]), 'nts1mkii')
    expect(e.unmeasured).toEqual([])
    expect(e.perInstance[0].cycles).toBe(
      Math.round(
        fxCyclesOn(
          { cycles: CPU_COST_TABLE['logue/osc/additive'].variants.base, sdram: 0 },
          'nts1mkii'
        )
      )
    )
  })

  it('zones against the NTS-1 mkII anchors', () => {
    expect(fxCpuZone(NTS1MKII_FX_CLEAN_CYCLES, 'nts1mkii').zone).toBe('fine')
    expect(fxCpuZone(NTS1MKII_FX_CLEAN_CYCLES + 1, 'nts1mkii').zone).toBe('between')
    expect(fxCpuZone(NTS1MKII_FX_DROPOUT_CYCLES, 'nts1mkii').zone).toBe('over')
    expect(NTS1MKII_FX_SOLO_CYCLES).toBeGreaterThan(NTS1MKII_FX_DROPOUT_CYCLES)
  })
})

describe('fxCpuZone', () => {
  it('is fine up to the clean anchor, between up to the dropout, then over', () => {
    expect(fxCpuZone(XD_FX_CLEAN_CYCLES).zone).toBe('fine')
    expect(fxCpuZone((XD_FX_CLEAN_CYCLES + XD_FX_DROPOUT_CYCLES) / 2).zone).toBe('between')
    expect(fxCpuZone(XD_FX_DROPOUT_CYCLES).zone).toBe('over')
  })

  it('puts the run-alone anchor past the dropout one (the gauge splits "over" there)', () => {
    expect(XD_FX_SOLO_CYCLES).toBeGreaterThan(XD_FX_DROPOUT_CYCLES)
  })
})

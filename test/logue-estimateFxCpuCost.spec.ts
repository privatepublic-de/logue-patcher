import { describe, it, expect } from 'vitest'
import {
  estimateFxCpuCost,
  fxCpuZone,
  fxCycles,
  XD_FX_CLEAN_CYCLES,
  XD_FX_DROPOUT_CYCLES,
  XD_FX_SOLO_CYCLES
} from '../logue-codegen/src/estimateFxCpuCost'
import { FX_CPU_BASELINE, FX_CPU_COST_TABLE } from '../logue-codegen/src/fxCpuCostTable'
import { LOGUE_AUDIO_IN_TYPE, LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import type { LogueModule, Net, ObjNode, PatchDocument } from '../src/shared/domain/patch'

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
  doc: PatchDocument
): NonNullable<Extract<ReturnType<typeof estimateFxCpuCost>, { status: 'ok' }>>['estimate'] {
  const r = estimateFxCpuCost(doc)
  if (r.status !== 'ok') throw new Error(r.reason)
  return r.estimate
}

const delay = FX_CPU_COST_TABLE['logue/util/long-delay'].variants
const cost = (c: { cycles: number; sdram: number }): number => Math.round(fxCycles(c))

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
    expect(e.cyclesPerSample).toBe(Math.round(fxCycles(e.sum)))
  })

  it('takes the module baseline', () => {
    const pass = (module: LogueModule): PatchDocument =>
      fx([], [net('in', 'l', 'out', 'l'), net('in', 'r', 'out', 'r')], module)
    expect(ok(pass('modfx')).cyclesPerSample).toBe(cost(FX_CPU_BASELINE.modfx))
    expect(ok(pass('revfx')).cyclesPerSample).toBe(cost(FX_CPU_BASELINE.revfx))
  })

  it('treats an input from knob-only math as unwired, and that math as free', () => {
    const fromConstant = ok(
      fx(
        [node('logue/util/constant', 'k'), node('logue/util/long-delay', 'd')],
        [net('in', 'mono', 'd', 'in'), net('k', 'out', 'd', 'time'), net('d', 'out', 'out', 'l')]
      )
    )
    expect(fromConstant.perInstance.map((i) => [i.nodeName, i.variant])).toEqual([['d', 'base #1']])

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

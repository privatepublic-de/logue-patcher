import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findLoguePrimitive, recognizedLoguePrimitiveIds } from '../logue-codegen/src/primitives'
import { CPU_COST_BASELINE_CYCLES, CPU_COST_TABLE } from '../logue-codegen/src/cpuCostTable'
import {
  CPU_GAUGE,
  cpuZone,
  estimateOscCpuCost,
  NTS1MKII_OSC_DROPOUT_CYCLES,
  oscRealCycles,
  XD_OSC_HANG_CYCLES
} from '../logue-codegen/src/estimateOscCpuCost'
import { LOGUE_AUDIO_OUT_TYPE } from '../logue-codegen/src/oscInstances'
import type { Net, ObjNode, PatchDocument } from '../src/shared/domain/patch'
import { testSampleAsset } from './support/testSample'

const RE_MEASURE = 'EMU_PYTHON=<venv python> npx tsx logue-codegen/scripts/measureCpuCosts.ts <id>'

function xdSnapshotHash(id: string): string {
  const file = join(
    import.meta.dirname,
    '__snapshots__',
    'primitives',
    `${id.slice('logue/'.length).replace('/', '.')}.minilogue-xd.txt`
  )
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
}

const xdIds = recognizedLoguePrimitiveIds().filter((id) => {
  const p = findLoguePrimitive(id)!
  // Effect-only primitives have no oscillator build to measure (and effects get no CPU estimate).
  if (p.modules && !p.modules.includes('osc')) return false
  return !p.platforms || p.platforms.includes('minilogue-xd')
})

/**
 * A missing or stale entry only warns: re-measuring needs the ARM toolchain, a logue-sdk checkout
 * and the emulator venv, and `npm run build` runs these tests, so failing here would block every
 * build after a codegen change. The estimate then counts a missing primitive as 0 and names it.
 * `CPU_COST_STRICT=1` turns the warnings back into failures (e.g. right after re-measuring).
 */
function reportTableProblem(what: string, ids: string[]): void {
  if (ids.length === 0) return
  const message = `CPU cost table: ${what}: ${ids.join(', ')} -- re-measure with: ${RE_MEASURE}`
  if (process.env.CPU_COST_STRICT === '1') throw new Error(message)
  console.warn(message)
}

describe('CPU cost table', () => {
  it('has a measurement for every primitive the minilogue xd supports (warns if not)', () => {
    reportTableProblem(
      'no entry for',
      xdIds.filter((id) => !CPU_COST_TABLE[id])
    )
    expect(CPU_COST_BASELINE_CYCLES).toBeGreaterThan(0)
  })

  it('was measured against the current generated code (warns if not)', () => {
    reportTableProblem(
      'measured against older generated code',
      xdIds.filter(
        (id) => CPU_COST_TABLE[id] && CPU_COST_TABLE[id].snapshotHash !== xdSnapshotHash(id)
      )
    )
  })
})

function node(type: string, name: string, params: ObjNode['params'] = []): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params }
}
function net(from: string, outlet: string, to: string, inlet: string): Net {
  return { sources: [{ obj: from, outlet }], dests: [{ obj: to, inlet }] }
}
function doc(nodes: ObjNode[], nets: Net[]): PatchDocument {
  return {
    nodes: [...nodes, node(LOGUE_AUDIO_OUT_TYPE, 'out')],
    nets,
    settings: {},
    notes: ''
  }
}

describe('estimateOscCpuCost', () => {
  const svf = CPU_COST_TABLE['logue/filter/svf']

  it('counts the variant matching the switches and the control wiring', () => {
    const tracked = doc(
      [
        node('logue/osc/saw', 's'),
        node('logue/filter/svf', 'f', [{ name: 'TRACK', value: '100' }])
      ],
      [net('s', 'out', 'f', 'in'), net('f', 'lp', 'out', 'in')]
    )
    const r = estimateOscCpuCost(tracked)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    const f = r.estimate.perInstance.find((i) => i.nodeName === 'f')!
    expect(f).toMatchObject({ variant: 'TRACK', cycles: svf.variants.TRACK })
    const saw = CPU_COST_TABLE['logue/osc/saw'].variants.base
    expect(r.estimate.cyclesPerVoice).toBe(CPU_COST_BASELINE_CYCLES + saw + svf.variants.TRACK)

    tracked.nodes.push(node('logue/lfo/sine-lfo', 'l'))
    tracked.nets.push(net('l', 'out', 'f', 'pitch'))
    const wired = estimateOscCpuCost(tracked)
    if (wired.status === 'ok') {
      expect(wired.estimate.perInstance.find((i) => i.nodeName === 'f')).toMatchObject({
        variant: 'TRACK+control',
        cycles: svf.variants['TRACK+control']
      })
    }
  })

  it('counts granular by its switches and wiring, not its worst case, when a setting moves', () => {
    const g = node('logue/osc/granular', 'g', [
      { name: 'SIZE', value: '50' },
      { name: 'SYNC', value: '0' }
    ])
    g.sample = testSampleAsset()
    const r = estimateOscCpuCost(doc([g], [net('g', 'out', 'out', 'in')]))
    expect(r.status === 'ok' && r.estimate.perInstance[0]).toMatchObject({
      variant: 'SYNC',
      cycles: CPU_COST_TABLE['logue/osc/granular'].variants.SYNC
    })
  })

  it('reports an incomplete graph instead of throwing', () => {
    expect(estimateOscCpuCost(doc([], [])).status).toBe('incomplete')
  })
})

describe('estimateOscCpuCost on a patch the xd cannot build', () => {
  it('reports it incomplete, like the RAM estimate', () => {
    const vel = doc(
      [node('logue/sense/velocity', 'v'), node('logue/gain/vca', 'a'), node('logue/osc/saw', 's')],
      [net('s', 'out', 'a', 'in'), net('v', 'unipolar', 'a', 'gain'), net('a', 'out', 'out', 'in')]
    )
    expect(estimateOscCpuCost(vel).status).toBe('incomplete')
  })
})

type OscReading = { name: string; cycles: number; estimate: number }
const oscReadings = (file: string): OscReading[] =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'logue-codegen/scripts/hwtest', file), 'utf-8')
  )

describe('cpuZone (real cycles, measured anchors)', () => {
  it('converts an estimate to real cycles before placing it', () => {
    expect(oscRealCycles(0, 'minilogue-xd')).toBe(164)
    expect(oscRealCycles(100, 'nts1mkii')).toBe(127)
    expect(cpuZone(5000).between).toBe(1)
  })

  it('agrees with what the xd did on hardware', () => {
    // cpiano (estimate 381 now, 921 measured per voice) plays 4-note chords fine.
    expect(cpuZone(381).zone).toBe('fine')
    // formant at its authored settings (682) hung the xd; a granular patch at ~795 hung it.
    expect(cpuZone(682).zone).not.toBe('fine')
    expect(cpuZone(795).zone).not.toBe('fine')
    // Every patch measured cleanly sits below red, by estimate and by its own reading.
    for (const r of oscReadings('xdOscCpuReadings.json')) {
      expect(cpuZone(r.estimate).zone, r.name).not.toBe('over')
      expect(r.cycles, r.name).toBeLessThan(XD_OSC_HANG_CYCLES)
    }
  })

  it('has fits that match the readings they came from', () => {
    for (const [file, platform, lo, hi] of [
      ['xdOscCpuReadings.json', 'minilogue-xd', -0.35, 0.36],
      ['nts1OscCpuReadings.json', 'nts1mkii', -0.38, 0.54]
    ] as const) {
      for (const r of oscReadings(file)) {
        const err = oscRealCycles(r.estimate, platform) / r.cycles - 1
        expect(err, `${platform} ${r.name}`).toBeGreaterThanOrEqual(lo)
        expect(err, `${platform} ${r.name}`).toBeLessThanOrEqual(hi)
      }
    }
  })

  it('ends "fine" where the fit\'s worst under-read still clears the ceiling', () => {
    expect(CPU_GAUGE['minilogue-xd'].fineUpTo / XD_OSC_HANG_CYCLES).toBeCloseTo(0.66, 2)
    expect(CPU_GAUGE.nts1mkii.fineUpTo / NTS1MKII_OSC_DROPOUT_CYCLES).toBeCloseTo(0.63, 2)
  })
})

describe('estimateOscCpuCost with params on device knobs', () => {
  it('has no extra range when nothing that matters is exposed', () => {
    const plain = doc([node('logue/osc/saw', 's')], [net('s', 'out', 'out', 'in')])
    const r = estimateOscCpuCost(plain)
    expect(r.status === 'ok' && r.estimate.maxCyclesPerVoice).toBe(
      r.status === 'ok' && r.estimate.cyclesPerVoice
    )
  })

  it('counts an exposed checkbox in either position', () => {
    const svfNode = node('logue/filter/svf', 'f', [
      { name: 'TRACK', value: '0', logueParamIndex: { 'minilogue-xd': 0 } }
    ])
    const r = estimateOscCpuCost(
      doc(
        [node('logue/osc/saw', 's'), svfNode],
        [net('s', 'out', 'f', 'in'), net('f', 'lp', 'out', 'in')]
      )
    )
    const svf = CPU_COST_TABLE['logue/filter/svf']
    expect(
      r.status === 'ok' && r.estimate.perInstance.find((i) => i.nodeName === 'f')
    ).toMatchObject({
      cycles: svf.variants.base,
      maxCycles: Math.max(svf.variants.base, svf.variants.TRACK)
    })
  })

  it('lets an exposed granular setting reach its heavy measured cases', () => {
    const g = node('logue/osc/granular', 'g', [
      { name: 'WINDOW', value: '0', logueParamIndex: { 'minilogue-xd': 0 } }
    ])
    g.sample = testSampleAsset()
    const r = estimateOscCpuCost(doc([g], [net('g', 'out', 'out', 'in')]))
    const entry = CPU_COST_TABLE['logue/osc/granular']
    expect(r.status === 'ok' && r.estimate.perInstance[0]).toMatchObject({
      cycles: entry.variants.base,
      maxCycles: entry.worst
    })
  })
})

describe('NTS-1 mkII CPU estimate', () => {
  it('is over once the converted estimate reaches the measured busy ceiling', () => {
    const at = (real: number): number => (real - 44) / 0.83
    expect(cpuZone(at(4000), 'nts1mkii').zone).toBe('fine')
    expect(cpuZone(at(5500), 'nts1mkii').zone).toBe('between')
    expect(cpuZone(at(NTS1MKII_OSC_DROPOUT_CYCLES), 'nts1mkii').zone).toBe('over')
  })

  it('estimates an NTS-1 mkII-only patch, counting helper-less sense/velocity as free', () => {
    const vel = doc(
      [node('logue/sense/velocity', 'v'), node('logue/gain/vca', 'a'), node('logue/osc/saw', 's')],
      [net('s', 'out', 'a', 'in'), net('v', 'unipolar', 'a', 'gain'), net('a', 'out', 'out', 'in')]
    )
    const r = estimateOscCpuCost(vel, new Map(), 'nts1mkii')
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.estimate.unmeasured).toEqual([])
    expect(r.estimate.perInstance.find((i) => i.nodeName === 'v')).toMatchObject({
      cycles: 0,
      variant: 'trivial'
    })
  })

  it('counts params exposed on the NTS-1 mkII, not the xd, for the knob range', () => {
    const g = node('logue/osc/granular', 'g', [
      { name: 'WINDOW', value: '0', logueParamIndex: { nts1mkii: 2 } }
    ])
    g.sample = testSampleAsset()
    const d = doc([g], [net('g', 'out', 'out', 'in')])
    const nts = estimateOscCpuCost(d, new Map(), 'nts1mkii')
    const xd = estimateOscCpuCost(d, new Map(), 'minilogue-xd')
    const worst = CPU_COST_TABLE['logue/osc/granular'].worst
    expect(nts.status === 'ok' && nts.estimate.perInstance[0].maxCycles).toBe(worst)
    expect(xd.status === 'ok' && xd.estimate.perInstance[0].maxCycles).toBeLessThan(worst)
  })
})

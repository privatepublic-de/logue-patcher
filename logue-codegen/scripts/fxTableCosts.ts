/**
 * A unit's CPU cost from `fxCpuCostTable.ts` (minilogue xd effects), per active instance: the
 * module's baseline plus each instance's variant -- flipped checkboxes, and `control` once a
 * control inlet is fed from a per-sample source; a unit's first instance of a primitive counts
 * `first`, the second `shared + extra`, the rest `extra`. The rules an effect estimator would
 * follow, found profiling whole units (`profileFxUnit.ts`):
 * - An instance codegen computes once per block (`hoistedSuffixes`: knob-only math) costs
 *   nothing per sample, and an inlet it feeds counts as unwired -- the reader takes its
 *   per-block path (grain-mill's envelope times: the `control` variant read ~90 cycles high).
 * - A util/grain whose `trig` moves counts `heavy-capturing`: whether it is still recording at
 *   the next trigger depends on the trigger rate against SIZE, unknowable at build time, and
 *   grain-mill's sync/free units record all the time (the `control` variant read ~85 low).
 * `max` has each instance with a moving control input at its heaviest reachable `heavy-*` case.
 */
import { FX_CPU_BASELINE, FX_CPU_COST_TABLE, type FxCpuCost } from '../src/fxCpuCostTable'
import { findLoguePrimitive } from '../src/primitives'
import { resolvePlatformGraph } from '../src/resolveUnit'
import { hoistedSuffixes } from '../src/oscBody'
import type { SubpatchDefinitions } from '../src/subpatches'
import type { LogueEffectModule, PatchDocument } from '../../src/shared/domain/patch'

/** Cycles per sample at an SDRAM penalty of `penalty` cycles per access. */
export const atPenalty = (c: FxCpuCost, penalty: number): number => c.cycles + penalty * c.sdram

export interface InstanceFxCost {
  suffix: string
  id: string
  /** The variant counted and which instance of its primitive this is (`control #2`). */
  label: string
  cost: FxCpuCost
}

export interface FxTableCosts {
  baseline: FxCpuCost
  /** Instances counted, in graph order; per-block (hoisted) ones are left out. */
  instances: InstanceFxCost[]
  sum: FxCpuCost
  max: FxCpuCost
  /** Active primitives with no entry in the table (counted as 0). */
  missing: string[]
}

export function fxTableCosts(doc: PatchDocument, subpatches: SubpatchDefinitions): FxTableCosts {
  const { activeInstances } = resolvePlatformGraph(doc, subpatches, 'minilogue-xd')
  const module = doc.settings.logueTarget!.module as LogueEffectModule
  const sum = { ...FX_CPU_BASELINE[module] }
  const max = { ...FX_CPU_BASELINE[module] }
  const missing: string[] = []
  const instances: InstanceFxCost[] = []
  const seen = new Map<string, number>()
  const hoisted = hoistedSuffixes(activeInstances)
  const moving = (source: { suffix: string } | undefined): boolean =>
    source !== undefined && !hoisted.has(source.suffix)
  for (const inst of activeInstances) {
    if (hoisted.has(inst.suffix)) continue
    const entry = FX_CPU_COST_TABLE[inst.id]
    if (!entry) {
      missing.push(inst.id)
      continue
    }
    const count = (seen.get(inst.id) ?? 0) + 1
    seen.set(inst.id, count)
    const which = count === 1 ? 'first' : 'extra'
    const p = findLoguePrimitive(inst.id)!
    const flipped = (p.params ?? []).filter((spec) => {
      const widget = spec.booleanWidget
      if (!widget) return false
      const raw = Number(inst.node.params.find((v) => v.name === spec.name)?.value)
      const value = Number.isFinite(raw) ? raw : spec.default
      return value >= widget.threshold !== spec.default >= widget.threshold
    })
    const controlWired = (p.inlets ?? []).some(
      (i) => i.role === 'control' && moving(inst.inletSources[i.name])
    )
    const capturing = inst.id === 'logue/util/grain' && moving(inst.inletSources.trig)
    const key = capturing
      ? 'heavy-capturing'
      : [...flipped.map((s) => s.name), ...(controlWired ? ['control'] : [])].join('+') || 'base'
    // The one-time cost of sharing code between instances goes with the second.
    const costOf = (v: { first: FxCpuCost; shared: FxCpuCost; extra: FxCpuCost }): FxCpuCost =>
      which === 'first'
        ? v.first
        : count === 2
          ? { cycles: v.extra.cycles + v.shared.cycles, sdram: v.extra.sdram + v.shared.sdram }
          : v.extra
    const costs = Object.entries(entry.variants).map(([k, v]) => ({ key: k, cost: costOf(v) }))
    const heaviest = (list: typeof costs): FxCpuCost =>
      list.reduce((a, b) => (atPenalty(b.cost, 8) > atPenalty(a.cost, 8) ? b : a)).cost
    const cost = entry.variants[key] ? costOf(entry.variants[key]) : heaviest(costs)
    // As the oscillator estimate: a moving control input can reach the heavy-* cases.
    const reachable = controlWired
      ? heaviest([{ key, cost }, ...costs.filter((c) => c.key.startsWith('heavy-'))])
      : cost
    instances.push({ suffix: inst.suffix, id: inst.id, label: `${key} #${count}`, cost })
    sum.cycles += cost.cycles
    sum.sdram += cost.sdram
    max.cycles += reachable.cycles
    max.sdram += reachable.sdram
  }
  return { baseline: FX_CPU_BASELINE[module], instances, sum, max, missing }
}

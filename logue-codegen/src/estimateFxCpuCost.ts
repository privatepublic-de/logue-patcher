import type { LogueEffectModule, LoguePlatform, PatchDocument } from '../../src/shared/domain/patch'
import { CPU_COST_TABLE } from './cpuCostTable'
import {
  FX_CPU_BASELINE,
  FX_CPU_COST_TABLE,
  FX_CPU_DOES_NOT_FIT,
  type FxCpuCost
} from './fxCpuCostTable'
import { zoneFor } from './estimateOscCpuCost'
import { hoistedSuffixes } from './oscBody'
import { UnsupportedLogueNodeError } from './oscInstances'
import { findLoguePrimitive } from './primitives'
import { resolvePlatformGraph } from './resolveUnit'
import type { SubpatchDefinitions } from './subpatches'
import { isEffectModule } from './unitKinds'

/**
 * An EFFECT unit's CPU estimate: `fxCpuCostTable.ts`' emulator measurements summed
 * per active instance, in cycles per sample of the one unit (an effect runs once, not per voice),
 * on the emulator's own scale -- an estimate, not a hardware measurement. Against every example
 * effect built whole (`scripts/checkFxCpuEstimate.ts`): -10..+31 % at the gauge's penalty.
 *
 * Each instance counts the variant matching it -- flipped checkboxes, and `control` once a
 * control inlet is fed from a per-sample source -- as the unit's first instance of its primitive
 * (`first`), its second (`shared + extra`) or a later one (`extra`): GCC inlines a one-caller
 * helper and shares it between several. Two rules found profiling whole units
 * (`scripts/profileFxUnit.ts`):
 * - An instance codegen computes once per block (`hoistedSuffixes`: knob-only math) costs
 *   nothing per sample, and an inlet it feeds counts as unwired -- its reader takes the per-block
 *   path (grain-mill's envelope times: counting `control` read ~90 cycles high).
 * - A util/grain whose `trig` moves counts `heavy-capturing`: whether it is still recording at
 *   the next trigger depends on the trigger rate against SIZE, unknowable here, and grain-mill's
 *   sync/free units record all the time.
 *
 * NTS-1 mkII: no emulator for its Cortex-M7, so the same xd table stands in, converted to M7
 * cycles by a fit against units measured on a real device (`NTS1MKII_FX_CYCLE_SCALE`,
 * `NTS1MKII_FX_SDRAM_CYCLES`). The two primitives no xd effect holds take their xd oscillator
 * cost (`cpuCostTable.ts`, no SDRAM).
 */

/**
 * Cycles added per SDRAM access. The F446's real cost per access isn't known; 8 is the scale the
 * hardware anchors below were read at, so estimate and anchors agree whatever the true value.
 */
export const XD_FX_SDRAM_PENALTY = 8
/** grain-mill's xd delay at ~680-750 stayed clean with the factory mod and reverb running. */
export const XD_FX_CLEAN_CYCLES = 750
/** At ~814 the same delay dropped out with both running (user, a real xd, 2026-10-01). */
export const XD_FX_DROPOUT_CYCLES = 814
/**
 * The example stereo reverb (~1660 measured whole) runs on a real xd only with both other effect
 * slots off (user, 2026-10-03): past the dropout anchor, a unit up to here can still run alone.
 */
export const XD_FX_SOLO_CYCLES = 1660
export const XD_FX_CPU_GAUGE = { fineUpTo: XD_FX_CLEAN_CYCLES, limit: XD_FX_DROPOUT_CYCLES }

/**
 * NTS-1 mkII: M7 cycles = SCALE * xd emulator cycles + SDRAM_CYCLES * SDRAM accesses, fitted
 * (relative error, no intercept) to 14 generated units measured on a real device through audio
 * telemetry (`scripts/hwtest/calibrateFx.ts`, 2026-10-05: every example effect and the CPU
 * probe's test units, settled 4 s, read over 3 s): every one within -22..+19 %. Plain math costs
 * the M7 a little less than the xd emulator counts; an SDRAM access ~44 cycles (uncached).
 */
export const NTS1MKII_FX_CYCLE_SCALE = 0.85
export const NTS1MKII_FX_SDRAM_CYCLES = 44
/**
 * Measured with a unit burning an exact load in the REVERB slot, a factory oscillator playing
 * (`scripts/hwtest/cpuCeiling.ts`, 2026-10-05): with factory CHORUS and STEREO delay running,
 * clean at 6300 cycles per sample, dropouts from 6350; with mod and delay off, clean at 7000,
 * dropouts from 7050. "Fine" ends where an estimate 22 % low (the fit's worst: the smallest
 * units, where the fixed shell dominates) still clears the busy ceiling: 0.78 * 6300.
 */
export const NTS1MKII_FX_DROPOUT_CYCLES = 6300
export const NTS1MKII_FX_SOLO_CYCLES = 7000
export const NTS1MKII_FX_CLEAN_CYCLES = 4900

/** Past the dropout anchor and up to here, a unit still runs with the other effect slots off. */
export const FX_SOLO_CYCLES: Record<LoguePlatform, number> = {
  'minilogue-xd': XD_FX_SOLO_CYCLES,
  nts1mkii: NTS1MKII_FX_SOLO_CYCLES
}

export const FX_CPU_GAUGE: Record<LoguePlatform, { fineUpTo: number; limit: number }> = {
  'minilogue-xd': XD_FX_CPU_GAUGE,
  nts1mkii: { fineUpTo: NTS1MKII_FX_CLEAN_CYCLES, limit: NTS1MKII_FX_DROPOUT_CYCLES }
}

/** Where an effect estimate sits against the platform's anchors (`zoneFor`). */
export const fxCpuZone = (
  cyclesPerSample: number,
  platform: LoguePlatform = 'minilogue-xd'
): ReturnType<typeof zoneFor> => zoneFor(cyclesPerSample, FX_CPU_GAUGE[platform])

/** Cycles per sample at the gauge's SDRAM penalty. */
export const fxCycles = (c: FxCpuCost, penalty = XD_FX_SDRAM_PENALTY): number =>
  c.cycles + penalty * c.sdram

/** A table cost on the platform's own gauge scale. */
export const fxCyclesOn = (c: FxCpuCost, platform: LoguePlatform): number =>
  platform === 'nts1mkii'
    ? NTS1MKII_FX_CYCLE_SCALE * c.cycles + NTS1MKII_FX_SDRAM_CYCLES * c.sdram
    : fxCycles(c)

type FxCpuEntry = (typeof FX_CPU_COST_TABLE)[string]

/** A primitive too big for any xd effect, from its xd oscillator cost: no sharing, no SDRAM. */
function oscStandIn(id: string): FxCpuEntry | undefined {
  const osc = CPU_COST_TABLE[id]
  if (!osc || !(id in FX_CPU_DOES_NOT_FIT)) return undefined
  const variants: FxCpuEntry['variants'] = {}
  for (const [key, cycles] of Object.entries(osc.variants)) {
    const c = { cycles, sdram: 0 }
    variants[key] = { first: c, shared: { cycles: 0, sdram: 0 }, extra: c }
  }
  return { variants, snapshotHash: osc.snapshotHash }
}

export interface FxInstanceCpuCost {
  nodeName: string
  /** The instance's codegen suffix (its C++ names), for attributing a profile. */
  suffix: string
  primitiveId: string
  /** Cycles per sample on the platform's scale (`fxCyclesOn`). */
  cycles: number
  /** The measurement counted: its variant and which instance of its primitive (`control #2`). */
  variant: string
  /** The most this node can cost once its device-controlled params are turned (>= `cycles`). */
  maxCycles: number
  /** The table's cost at penalty 0 plus SDRAM accesses, for another penalty. */
  cost: FxCpuCost
}

export interface FxCpuEstimate {
  perInstance: FxInstanceCpuCost[]
  baselineCycles: number
  cyclesPerSample: number
  /** Every knob-controlled checkbox in either position, and a settings-dependent primitive at
   *  its `heavy-*` cases once a knob or a moving input can move its settings. */
  maxCyclesPerSample: number
  /** The sums before the penalty: `fxCycles(sum, p)` for any other penalty. */
  sum: FxCpuCost
  max: FxCpuCost
  /** Active primitives with no entry in the table (counted as 0). */
  unmeasured: string[]
}

export type FxCpuEstimateResult =
  { status: 'ok'; estimate: FxCpuEstimate } | { status: 'incomplete'; reason: string }

export function estimateFxCpuCost(
  doc: PatchDocument,
  subpatches: SubpatchDefinitions = new Map(),
  platform: LoguePlatform = 'minilogue-xd'
): FxCpuEstimateResult {
  const module = doc.settings.logueTarget?.module ?? 'osc'
  if (!isEffectModule(module)) return { status: 'incomplete', reason: 'Not an effect patch.' }
  try {
    const { activeInstances } = resolvePlatformGraph(doc, subpatches, platform)
    const baseline = FX_CPU_BASELINE[module as LogueEffectModule]
    const sum = { ...baseline }
    const max = { ...baseline }
    const unmeasured: string[] = []
    const perInstance: FxInstanceCpuCost[] = []
    const seen = new Map<string, number>()
    const hoisted = hoistedSuffixes(activeInstances)
    const moving = (source: { suffix: string } | undefined): boolean =>
      source !== undefined && !hoisted.has(source.suffix)
    for (const inst of activeInstances) {
      if (hoisted.has(inst.suffix)) continue
      const entry =
        FX_CPU_COST_TABLE[inst.id] ?? (platform === 'nts1mkii' ? oscStandIn(inst.id) : undefined)
      if (!entry) {
        unmeasured.push(inst.id)
        continue
      }
      const count = (seen.get(inst.id) ?? 0) + 1
      seen.set(inst.id, count)
      const p = findLoguePrimitive(inst.id)!
      const valueOf = (name: string, fallback: number): number => {
        const n = Number(inst.node.params.find((v) => v.name === name)?.value)
        return Number.isFinite(n) ? n : fallback
      }
      const exposed = (name: string): boolean => {
        const pv = inst.node.params.find((v) => v.name === name)
        return (
          pv?.logueKnob?.[platform] !== undefined ||
          pv?.logueParamIndex?.[platform] !== undefined ||
          pv?.logueFollow?.[platform] !== undefined
        )
      }
      const flipped: string[] = []
      let flipChoices: string[][] = [[]]
      let movableSetting = false
      for (const spec of p.params ?? []) {
        const widget = spec.booleanWidget
        if (!widget) {
          if (exposed(spec.name)) movableSetting = true
          continue
        }
        const isFlipped =
          valueOf(spec.name, spec.default) >= widget.threshold !== spec.default >= widget.threshold
        if (isFlipped) flipped.push(spec.name)
        if (exposed(spec.name)) flipChoices = flipChoices.flatMap((c) => [c, [...c, spec.name]])
        else if (isFlipped) flipChoices = flipChoices.map((c) => [...c, spec.name])
      }
      const controlWired = (p.inlets ?? []).some(
        (i) => i.role === 'control' && moving(inst.inletSources[i.name])
      )
      const capturing = inst.id === 'logue/util/grain' && moving(inst.inletSources.trig)
      const keyOf = (flips: string[]): string =>
        capturing
          ? 'heavy-capturing'
          : [...flips, ...(controlWired ? ['control'] : [])].join('+') || 'base'
      // The one-time cost of sharing code between instances goes with the second.
      const at = (key: string): FxCpuCost | undefined => {
        const v = entry.variants[key]
        if (!v) return undefined
        if (count === 1) return v.first
        if (count > 2) return v.extra
        return { cycles: v.extra.cycles + v.shared.cycles, sdram: v.extra.sdram + v.shared.sdram }
      }
      const heaviest = (costs: FxCpuCost[]): FxCpuCost =>
        costs.reduce((a, b) => (fxCyclesOn(b, platform) > fxCyclesOn(a, platform) ? b : a))
      const all = Object.keys(entry.variants).map((k) => at(k)!)
      const key = keyOf(flipped)
      const cost = at(key) ?? heaviest(all)
      const reachable = [cost, ...flipChoices.map((c) => at(keyOf(c)) ?? heaviest(all))]
      if (movableSetting || controlWired) {
        for (const k of Object.keys(entry.variants)) {
          if (k.startsWith('heavy-')) reachable.push(at(k)!)
        }
      }
      const most = heaviest(reachable)
      perInstance.push({
        nodeName: inst.node.name ?? inst.suffix,
        suffix: inst.suffix,
        primitiveId: inst.id,
        cycles: Math.round(fxCyclesOn(cost, platform)),
        variant: `${at(key) ? key : 'worst'} #${count}`,
        maxCycles: Math.round(fxCyclesOn(most, platform)),
        cost
      })
      sum.cycles += cost.cycles
      sum.sdram += cost.sdram
      max.cycles += most.cycles
      max.sdram += most.sdram
    }
    return {
      status: 'ok',
      estimate: {
        perInstance,
        baselineCycles: Math.round(fxCyclesOn(baseline, platform)),
        cyclesPerSample: Math.round(fxCyclesOn(sum, platform)),
        maxCyclesPerSample: Math.round(fxCyclesOn(max, platform)),
        sum,
        max,
        unmeasured: [...new Set(unmeasured)]
      }
    }
  } catch (err) {
    if (err instanceof UnsupportedLogueNodeError)
      return { status: 'incomplete', reason: err.message }
    throw err
  }
}

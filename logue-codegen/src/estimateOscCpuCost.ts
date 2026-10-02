import type { LoguePlatform, PatchDocument } from '../../src/shared/domain/patch'
import { CPU_COST_BASELINE_CYCLES, CPU_COST_TABLE } from './cpuCostTable'
import { UnsupportedLogueNodeError } from './oscInstances'
import { resolvePlatformGraph } from './resolveUnit'
import { findLoguePrimitive } from './primitives'
import { isEffectModule } from './unitKinds'
import type { SubpatchDefinitions } from './subpatches'

/**
 * A minilogue xd CPU estimate: the emulator-measured cost of each active instance
 * (`cpuCostTable.ts`) plus the fixed per-unit overhead, in cycles per voice-sample on the
 * emulator's own scale (`scripts/emulateXdCycles.py`) -- an estimate for comparing patches, not a
 * hardware measurement. Each instance counts the measured variant matching it -- which checkboxes
 * are flipped from their defaults, and whether any control inlet is wired (audio inputs are always
 * counted as wired); only a combination nobody measured falls back to the primitive's worst.
 * (Counting granular at its SIZE/WINDOW-100 worst for any moved setting made a patch that plays
 * fine read 27% high.) The xd runs the oscillator once per voice.
 *
 * Two hardware anchors, both on the emulator's scale: cpiano (granular + 2 LFOs + mux, 468 when
 * measured whole) plays 4-note chords fine on a real xd; a granular patch at ~795 hung one with
 * chords held. `cpuZone` maps an estimate onto them -- between the two is simply untested.
 *
 * NTS-1 mkII: no emulator for its Cortex-M7, so the same xd table stands in (the M7 usually needs
 * fewer cycles for the same code). Its anchor is measured on a real device with
 * `scripts/stageNts1CpuProbe.ts`: ~549 MHz, and audio broke once the oscillator used ~7,750
 * cycles/sample, ~7,300 at the last good step, with the factory Submarine reverb running -- a
 * heavier effect leaves less. The osc is rendered once, not per voice. "Fine" stops at half the
 * ceiling, so a patch still fits if the stand-in is off by 2x.
 */
export const XD_VOICES = 4
/** 84 MHz / 48 kHz: everything the MCU does per output sample, all voices included. */
export const XD_CYCLES_PER_SAMPLE = 1750
/** Emulator estimate of the granular patch that hung a real xd with chords (2026-09-26). */
export const XD_HUNG_REFERENCE_CYCLES = 795
/** Emulator measurement of cpiano, which plays 4-note chords fine on a real xd (2026-09-28). */
export const XD_CONFIRMED_WORKING_CYCLES = 468

/** Oscillator cycles per sample at the last good BURN step on a real NTS-1 mkII (2026-09-28). */
export const NTS1MKII_OSC_CEILING_CYCLES = 7300
/** ~549 MHz / 48 kHz, measured on the device: everything it does per sample. */
export const NTS1MKII_CYCLES_PER_SAMPLE = 11457

/** Per platform: "fine" up to `fineUpTo`, "over" from `limit`, in cycles per voice-sample. */
export const CPU_GAUGE: Record<LoguePlatform, { fineUpTo: number; limit: number }> = {
  'minilogue-xd': { fineUpTo: XD_CONFIRMED_WORKING_CYCLES, limit: XD_HUNG_REFERENCE_CYCLES },
  nts1mkii: { fineUpTo: NTS1MKII_OSC_CEILING_CYCLES / 2, limit: NTS1MKII_OSC_CEILING_CYCLES }
}

export type CpuZone = 'fine' | 'between' | 'over'

/** Where an estimate sits against a platform's anchors, plus 0..1 across the gap between them. */
export function cpuZone(
  cyclesPerVoice: number,
  platform: LoguePlatform = 'minilogue-xd'
): { zone: CpuZone; between: number } {
  const { fineUpTo, limit } = CPU_GAUGE[platform]
  const between = Math.min(1, Math.max(0, (cyclesPerVoice - fineUpTo) / (limit - fineUpTo)))
  if (cyclesPerVoice <= fineUpTo) return { zone: 'fine', between }
  if (cyclesPerVoice < limit) return { zone: 'between', between }
  return { zone: 'over', between }
}

export interface InstanceCpuCost {
  nodeName: string
  primitiveId: string
  cycles: number
  /** Which measured variant was counted (`base`, `control`, `TRACK+control`, `worst`, ...). */
  variant: string
  /** The most this node can cost once its device-exposed params are turned (>= `cycles`). */
  maxCycles: number
}

export interface OscCpuEstimate {
  perInstance: InstanceCpuCost[]
  baselineCycles: number
  cyclesPerVoice: number
  /**
   * The most the patch can cost from the device: every exposed checkbox in either position, and
   * a settings-dependent primitive (granular) at its heavy measured cases once an exposed param
   * or a wired control input can move its settings. Equal to `cyclesPerVoice` when nothing that
   * matters is on a knob.
   */
  maxCyclesPerVoice: number
  /** Active primitives with no measurement in the table (counted as 0). */
  unmeasured: string[]
}

export type OscCpuEstimateResult =
  { status: 'ok'; estimate: OscCpuEstimate } | { status: 'incomplete'; reason: string }

export function estimateOscCpuCost(
  doc: PatchDocument,
  subpatches: SubpatchDefinitions = new Map(),
  platform: LoguePlatform = 'minilogue-xd'
): OscCpuEstimateResult {
  try {
    // Same as the RAM estimate: a patch the platform can't build gets no number.
    const { activeInstances } = resolvePlatformGraph(doc, subpatches, platform)
    // The table and both gauges' anchors are oscillator measurements (per voice, and with the
    // NTS-1 mkII's effects running); an effect runs once, on its own share, never measured.
    if (isEffectModule(doc.settings.logueTarget?.module ?? 'osc')) {
      return { status: 'incomplete', reason: "CPU use isn't measured for effects yet." }
    }
    const unmeasured: string[] = []
    const perInstance = activeInstances.map((inst): InstanceCpuCost => {
      const nodeName = inst.node.name ?? inst.suffix
      const entry = CPU_COST_TABLE[inst.id]
      // NTS-1 mkII-only primitives can't be measured on the xd emulator; one with no helper code
      // (sense/velocity: a latched member read) costs next to nothing, like every such primitive.
      if (!entry && !findLoguePrimitive(inst.id)!.helpers) {
        return { nodeName, primitiveId: inst.id, cycles: 0, variant: 'trivial', maxCycles: 0 }
      }
      if (!entry) {
        unmeasured.push(inst.id)
        return { nodeName, primitiveId: inst.id, cycles: 0, variant: 'unmeasured', maxCycles: 0 }
      }
      const primitive = findLoguePrimitive(inst.id)!
      const valueOf = (name: string, fallback: number): number => {
        const raw = inst.node.params.find((v) => v.name === name)?.value
        const n = raw === undefined ? NaN : Number(raw)
        return Number.isFinite(n) ? n : fallback
      }
      // Any device control -- a menu slot, a fixed knob, or following another param's slot.
      const exposed = (name: string): boolean => {
        const pv = inst.node.params.find((v) => v.name === name)
        return (
          pv?.logueParamIndex?.[platform] !== undefined ||
          pv?.logueKnob?.[platform] !== undefined ||
          pv?.logueFollow?.[platform] !== undefined
        )
      }
      const flipped: string[] = []
      // Each checkbox as saved, and -- if it's on a device knob -- also flipped.
      let flipChoices: string[][] = [[]]
      let movableSetting = false
      for (const spec of primitive.params ?? []) {
        const widget = spec.booleanWidget
        if (!widget) {
          if (exposed(spec.name)) movableSetting = true
          continue
        }
        const isFlipped =
          valueOf(spec.name, spec.default) >= widget.threshold !== spec.default >= widget.threshold
        if (isFlipped) flipped.push(spec.name)
        if (exposed(spec.name)) {
          flipChoices = flipChoices.flatMap((c) => [c, [...c, spec.name]])
        } else if (isFlipped) {
          flipChoices = flipChoices.map((c) => [...c, spec.name])
        }
      }
      const controlWired = (primitive.inlets ?? []).some(
        (i) => i.role === 'control' && inst.inletSources[i.name] !== undefined
      )
      const keyOf = (flips: string[]): string =>
        [...flips, ...(controlWired ? ['control'] : [])].join('+') || 'base'
      const costOf = (key: string): number => entry.variants[key] ?? entry.worst
      const key = keyOf(flipped)
      const reachable = flipChoices.map((c) => costOf(keyOf(c)))
      const heavy = Object.entries(entry.variants)
        .filter(([k]) => k.startsWith('heavy-'))
        .map(([, v]) => v)
      if (heavy.length > 0 && (movableSetting || controlWired)) reachable.push(...heavy)
      const cycles = entry.variants[key]
      const maxCycles = Math.max(cycles ?? entry.worst, ...reachable)
      return cycles === undefined
        ? { nodeName, primitiveId: inst.id, cycles: entry.worst, variant: 'worst', maxCycles }
        : { nodeName, primitiveId: inst.id, cycles, variant: key, maxCycles }
    })
    return {
      status: 'ok',
      estimate: {
        perInstance,
        baselineCycles: CPU_COST_BASELINE_CYCLES,
        cyclesPerVoice:
          CPU_COST_BASELINE_CYCLES + perInstance.reduce((sum, i) => sum + i.cycles, 0),
        maxCyclesPerVoice:
          CPU_COST_BASELINE_CYCLES + perInstance.reduce((sum, i) => sum + i.maxCycles, 0),
        unmeasured: [...new Set(unmeasured)]
      }
    }
  } catch (err) {
    if (err instanceof UnsupportedLogueNodeError)
      return { status: 'incomplete', reason: err.message }
    throw err
  }
}

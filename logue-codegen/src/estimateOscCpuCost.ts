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
 * The gauge converts the estimate to REAL cycles per voice-sample, measured through audio
 * telemetry on both devices (`scripts/hwtest/calibrateOsc.ts`, 2026-10-06: the user's
 * oscillator patches with every device control stripped). An affine fit: each patch's unit
 * shell and the voice's call cost the intercept, so per-instance costs stay on the emulator's
 * scale (the tooltip says so).
 *
 * NTS-1 mkII: no emulator for its Cortex-M7, so the same xd table stands in; the fit does the
 * rest. The osc is rendered once, not per voice.
 */
/** minilogue xd: real cycles per voice-sample = 164 + 1.40 * estimate (19 readings, -34..+35 %). */
export const XD_OSC_REAL_BASE = 164
export const XD_OSC_REAL_SCALE = 1.4
/** NTS-1 mkII: real cycles per sample = 44 + 0.83 * estimate (21 readings, -37..+54 %). */
export const NTS1MKII_OSC_REAL_BASE = 44
export const NTS1MKII_OSC_REAL_SCALE = 0.83

export const XD_VOICES = 4
/** Each xd voice's own cycles per sample (measured with 1-4 notes held: the same for each). */
export const XD_CYCLES_PER_SAMPLE = 1728
/**
 * Measured on a real xd with a sine burning an exact load (`cpuCeiling.ts --xd --osc`,
 * 2026-10-06): with 4 notes held, clean at 1225 real cycles per voice-sample, breaking up from
 * 1250; one voice alone ran to 1290 and froze at 1300 (it kept sounding, the panel and MIDI
 * stopped: the hang signature). The rest of the 1728 is what the control side needs. Both
 * recorded hangs (formant, ~1700 real; a granular patch, estimate ~795) sit past "fine".
 */
export const XD_OSC_HANG_CYCLES = 1225
/** Where an estimate 34 % low (the fit's worst) still clears the ceiling: 0.66 * 1225. */
export const XD_OSC_CLEAN_CYCLES = 808

/**
 * NTS-1 mkII, a sine burning an exact load (`cpuCeiling.ts --osc`, 2026-10-06): with factory
 * CHORUS, STEREO delay and HALL reverb on, clean to 6650 cycles per sample, dropouts from 6700
 * (twice); with the effects off, clean to 10000, dropouts from 10050 (a first run read 7350,
 * which two later ones didn't reproduce). "Fine" ends where an estimate 37 % low (the fit's
 * worst) still clears 6700. Of ~11,457 in all.
 */
export const NTS1MKII_OSC_DROPOUT_CYCLES = 6700
export const NTS1MKII_OSC_SOLO_CYCLES = 10000
/**
 * The oscillator and the three effect slots share the M7 (`cpuCeiling.ts --osc-load`, 2026-10-06):
 * a burn oscillator at 3000 left a burn effect 6800, one at 6000 left it 3800 -- the two together
 * get ~9800 cycles per sample with the factory effects off. Each gauge sees only its own unit.
 */
export const NTS1MKII_SHARED_CYCLES = 9800
export const NTS1MKII_OSC_CLEAN_CYCLES = 4200
/** ~549 MHz / 48 kHz, measured on the device: everything it does per sample. */
export const NTS1MKII_CYCLES_PER_SAMPLE = 11457

/** An estimate (emulator cycles per voice-sample) as real cycles on `platform`'s processor. */
export function oscRealCycles(estimate: number, platform: LoguePlatform): number {
  return Math.round(
    platform === 'minilogue-xd'
      ? XD_OSC_REAL_BASE + XD_OSC_REAL_SCALE * estimate
      : NTS1MKII_OSC_REAL_BASE + NTS1MKII_OSC_REAL_SCALE * estimate
  )
}

/** Per platform, in REAL cycles: "fine" up to `fineUpTo`, "over" from `limit`. */
export const CPU_GAUGE: Record<LoguePlatform, { fineUpTo: number; limit: number }> = {
  'minilogue-xd': { fineUpTo: XD_OSC_CLEAN_CYCLES, limit: XD_OSC_HANG_CYCLES },
  nts1mkii: { fineUpTo: NTS1MKII_OSC_CLEAN_CYCLES, limit: NTS1MKII_OSC_DROPOUT_CYCLES }
}

export type CpuZone = 'fine' | 'between' | 'over'

/** Where an estimate (emulator cycles) sits against a platform's measured anchors, as real
 *  cycles, plus 0..1 across the gap between them. */
export function cpuZone(
  cyclesPerVoice: number,
  platform: LoguePlatform = 'minilogue-xd'
): { zone: CpuZone; between: number } {
  return zoneFor(oscRealCycles(cyclesPerVoice, platform), CPU_GAUGE[platform])
}

/** `cpuZone` against any pair of anchors (the effect gauge's too). */
export function zoneFor(
  cycles: number,
  { fineUpTo, limit }: { fineUpTo: number; limit: number }
): { zone: CpuZone; between: number } {
  const between = Math.min(1, Math.max(0, (cycles - fineUpTo) / (limit - fineUpTo)))
  if (cycles <= fineUpTo) return { zone: 'fine', between }
  if (cycles < limit) return { zone: 'between', between }
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

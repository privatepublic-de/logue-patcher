/** Green up to `fineUpTo`, then through amber to red at `limit` (and beyond). */
function usageHue(value: number, fineUpTo: number, limit: number): number {
  if (value <= fineUpTo) return 130
  if (value >= limit) return 0
  return 130 - ((value - fineUpTo) / (limit - fineUpTo)) * 130
}

interface UsageGaugeProps {
  /** Short row label: RAM, SDRAM, CPU. */
  label: string
  /** Current usage, in the same unit as `limit`; omitted, the row is a greyed placeholder. */
  value?: number
  /** Where "fine" ends and the colour starts turning toward red. */
  fineUpTo?: number
  /** The hard (or hardware-measured) limit: a red tick, and fully red from here. */
  limit?: number
  /** A possible higher usage (e.g. with device knobs turned up), drawn as a faint extension. */
  reach?: number
  /** Show a grey tick at `fineUpTo` -- only where that point is a real anchor, not a warning. */
  markFine?: boolean
  /** A word or a percentage; everything longer belongs in the tooltip. */
  text: React.ReactNode
  tooltip: string
  className?: string
}

/**
 * The Build panel's RAM/SDRAM/CPU rows, one component so they always look alike: label, a track
 * that runs a little past `limit` (so the limit tick isn't the right edge) with a fill coloured
 * by `usageHue` and ticks, then a short value -- all on one line.
 */
function UsageGauge({
  label,
  value,
  fineUpTo = 0,
  limit = 1,
  reach,
  markFine,
  text,
  tooltip,
  className
}: UsageGaugeProps): React.JSX.Element {
  const scale = limit * 1.15
  const at = (v: number): string => `${Math.min(100, Math.max(0, (v / scale) * 100))}%`
  const color = (v: number): string => `hsl(${usageHue(v, fineUpTo, limit)} 70% 48%)`
  return (
    <div
      className={
        'build-panel__size-meter' +
        (value === undefined ? ' build-panel__size-meter--idle' : '') +
        (className ? ` ${className}` : '')
      }
      data-tooltip={tooltip}
    >
      <span className="build-panel__size-meter-label">{label}</span>
      <div className="build-panel__usage-gauge">
        {value !== undefined && (
          <>
            {reach !== undefined && reach > value && (
              <div
                className="build-panel__usage-gauge-reach"
                style={{ width: at(reach), backgroundColor: color(reach) }}
              />
            )}
            <div
              className="build-panel__usage-gauge-fill"
              style={{ width: at(value), backgroundColor: color(value) }}
            />
            {markFine && (
              <div className="build-panel__usage-gauge-mark" style={{ left: at(fineUpTo) }} />
            )}
            <div
              className="build-panel__usage-gauge-mark build-panel__usage-gauge-mark--limit"
              style={{ left: at(limit) }}
            />
          </>
        )}
      </div>
      <span className="build-panel__size-meter-text">{text}</span>
    </div>
  )
}

export default UsageGauge

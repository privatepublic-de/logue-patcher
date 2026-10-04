import { useEffect, useMemo, useRef, useState } from 'react'
import { FileAudio, Play, RotateCw, Square } from 'lucide-react'
import type { SampleAsset } from '@shared/domain/patch'
import type { PickedWavFile } from '@shared/ipc/contract'
import {
  DEFAULT_WAVETABLE_FRAME_COUNT,
  DEFAULT_WAVETABLE_FRAME_LENGTH,
  WAVETABLE_FRAME_COUNTS,
  WAVETABLE_FRAME_LENGTHS,
  importWavetable,
  type ImportedWavetable
} from '@logue-codegen/sample/importWavetable'
import {
  wavetablePyramidBytes,
  wavetableShapeProblem
} from '@logue-codegen/sample/wavetablePyramid'
import {
  cycleHarmonics,
  wavetableFrameAt,
  wavetableFrames
} from '@logue-codegen/sample/wavetableView'
import { NOTE_NAME } from '@logue-codegen/paramPresentation'
import { requireUnitKind } from '@logue-codegen/unitKinds'
import { audioContext } from './useSamplePreview'

const XD_OSC_RAM = requireUnitKind('minilogue-xd', 'osc').ramBytes
const NTS1MKII_OSC_RAM = requireUnitKind('nts1mkii', 'osc').ramBytes

const VIEW_WIDTH = 240
const CYCLE_HEIGHT = 56
const STRIP_HEIGHT = 28
/** The preview's held note: middle C, near where a sung source usually sits. */
const PREVIEW_NOTE = 60
const PREVIEW_GAIN = 0.25

function percentOf(bytes: number, budget: number): string {
  return `${Math.round((bytes / budget) * 100)}%`
}

function noteName(note: number): string {
  return NOTE_NAME.toDisplay(Math.round(note))
}

/** A frame-count choice with what the table (band-limited copies included) takes of each device. */
function framesLabel(frames: number, length: number): string {
  const bytes = wavetablePyramidBytes({ frameCount: frames, frameLength: length })
  const xd = bytes < XD_OSC_RAM ? `${percentOf(bytes, XD_OSC_RAM)} xd, ` : 'not xd, '
  return `${frames} (${xd}${percentOf(bytes, NTS1MKII_OSC_RAM)} NTS-1 mkII)`
}

interface Notice {
  text: string
  warning?: boolean
}

/** What the last import found, in words -- shown until the next import or selection. */
function importNotices(result: ImportedWavetable): Notice[] {
  const notices: Notice[] = [
    {
      text: `${result.asset.frameCount} frames from ${result.voicedSeconds.toFixed(2)} s of pitched material${
        result.skippedSeconds > 0.01
          ? ` (${result.skippedSeconds.toFixed(2)} s skipped: breaths, consonants, gaps, quiet tails)`
          : ''
      }.`
    },
    {
      text: `Sung ${noteName(result.lowestNote)}–${noteName(result.highestNote)}, mostly around ${noteName(result.medianNote)}.`
    }
  ]
  if (result.harmonicsLimitedBySource) {
    notices.push({
      text: `Up to ${result.harmonics} harmonics a frame: the file's ${result.sourceRate} Hz holds no more. A higher-rate original would be brighter.`,
      warning: true
    })
  }
  return notices
}

/**
 * A held note playing `cycle` through an OscillatorNode's PeriodicWave, updated as the cycle
 * changes (POSITION scrubbed), so the timbre is heard while dragging. The browser band-limits
 * it, which sounds like the device's tables short of their aliasing.
 */
function useCyclePreview(cycle: Float32Array | undefined): {
  playing: boolean
  toggle: () => void
} {
  const [playing, setPlaying] = useState(false)
  const nodes = useRef<{ osc: OscillatorNode; gain: GainNode } | null>(null)

  const stop = (): void => {
    nodes.current?.osc.stop()
    nodes.current?.osc.disconnect()
    nodes.current?.gain.disconnect()
    nodes.current = null
    setPlaying(false)
  }

  useEffect(() => {
    const current = nodes.current
    if (!current || !cycle) return
    const { real, imag } = cycleHarmonics(cycle, cycle.length / 4)
    current.osc.setPeriodicWave(
      audioContext().createPeriodicWave(real, imag, { disableNormalization: true })
    )
  }, [cycle, playing])

  useEffect(() => stop, [])

  const toggle = (): void => {
    if (nodes.current) return stop()
    if (!cycle) return
    const ctx = audioContext()
    void ctx.resume()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const { real, imag } = cycleHarmonics(cycle, cycle.length / 4)
    osc.setPeriodicWave(ctx.createPeriodicWave(real, imag, { disableNormalization: true }))
    osc.frequency.value = 440 * 2 ** ((PREVIEW_NOTE - 69) / 12)
    gain.gain.value = PREVIEW_GAIN
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    nodes.current = { osc, gain }
    setPlaying(true)
  }

  return { playing, toggle }
}

function setUpCanvas(canvas: HTMLCanvasElement, height: number): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const dpr = window.devicePixelRatio || 1
  canvas.width = VIEW_WIDTH * dpr
  canvas.height = height * dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, VIEW_WIDTH, height)
  return ctx
}

/**
 * The Inspector's section for `logue/osc/wavetable` (docs/PLAN-wavetable.md, phase 3): the cycle
 * at the current POSITION, a strip of every frame (dragged to scrub POSITION, one undo step), a
 * held-note preview that follows it, and the import (`importWavetable`) with its choices.
 */
function WavetableSection({
  sample,
  position,
  step,
  onPositionChange,
  onSampleChange
}: {
  sample: SampleAsset | undefined
  /** The node's POSITION dial, 0..100. */
  position: number
  /** MORPH Step: the nearest frame instead of a blend. */
  step: boolean
  /** A scrub on the frame strip: `begin`/`end` bracket one drag (one undo step). */
  onPositionChange: (value: number, phase: 'begin' | 'move' | 'end') => void
  onSampleChange: (sample: SampleAsset) => void
}): React.JSX.Element {
  const isWavetable = sample?.encoding === 'wt8' && wavetableShapeProblem(sample) === undefined
  const data = sample?.data
  const frames = useMemo(
    () => (isWavetable && sample ? wavetableFrames(sample) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the bytes and shape: a new asset with the same table doesn't redecode
    [isWavetable, data, sample?.frameLength]
  )
  const cycle = useMemo(
    () => (frames ? wavetableFrameAt(frames, position / 100, step) : undefined),
    [frames, position, step]
  )
  const [frameCount, setFrameCount] = useState<number>(
    () => sample?.frameCount ?? DEFAULT_WAVETABLE_FRAME_COUNT
  )
  const [frameLength, setFrameLength] = useState<number>(
    () => sample?.frameLength ?? DEFAULT_WAVETABLE_FRAME_LENGTH
  )
  const [evenLevels, setEvenLevels] = useState(true)
  const [notices, setNotices] = useState<Notice[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const cycleRef = useRef<HTMLCanvasElement>(null)
  const stripRef = useRef<HTMLCanvasElement>(null)
  const dragging = useRef(false)
  const preview = useCyclePreview(cycle)

  useEffect(() => {
    const canvas = cycleRef.current
    const ctx = canvas && setUpCanvas(canvas, CYCLE_HEIGHT)
    if (!canvas || !ctx || !cycle) return
    const color = getComputedStyle(canvas).color
    const mid = CYCLE_HEIGHT / 2
    ctx.globalAlpha = 0.25
    ctx.fillStyle = color
    ctx.fillRect(0, mid, VIEW_WIDTH, 1)
    ctx.globalAlpha = 1
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let x = 0; x <= VIEW_WIDTH; x++) {
      const v = cycle[Math.min(cycle.length - 1, Math.floor((x / VIEW_WIDTH) * cycle.length))]
      const y = mid - v * (mid - 3)
      if (x === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }, [cycle])

  useEffect(() => {
    const canvas = stripRef.current
    const ctx = canvas && setUpCanvas(canvas, STRIP_HEIGHT)
    if (!canvas || !ctx || !frames) return
    const style = getComputedStyle(canvas)
    const positive = style.color
    const negative = style.getPropertyValue('--color-text') || '#fff'
    // One column per frame, phase downwards: the wave's sign as the colour, its size as the
    // strength, so frames that look alike crossfade smoothly.
    const width = VIEW_WIDTH / frames.length
    frames.forEach((frame, f) => {
      for (let y = 0; y < STRIP_HEIGHT; y++) {
        const v = frame[Math.floor((y / STRIP_HEIGHT) * frame.length)]
        ctx.globalAlpha = Math.min(1, Math.abs(v) ** 0.7 * 1.2)
        ctx.fillStyle = v >= 0 ? positive : negative
        ctx.fillRect(f * width, y, Math.ceil(width), 1)
      }
    })
    ctx.globalAlpha = 1
    // Frame f sits at POSITION f / (frames - 1): the marker spans the strip's column centres.
    const x = width / 2 + (position / 100) * (VIEW_WIDTH - width)
    ctx.fillStyle = negative
    ctx.fillRect(Math.round(x) - 1, 0, 2, STRIP_HEIGHT)
  }, [frames, position])

  const positionAt = (e: React.PointerEvent<HTMLCanvasElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect()
    const width = rect.width / (frames?.length ?? 1)
    const p = (e.clientX - rect.left - width / 2) / (rect.width - width)
    return Math.round(Math.max(0, Math.min(1, p)) * 100)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!frames || e.button !== 0) return
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    onPositionChange(positionAt(e), 'begin')
  }
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (dragging.current) onPositionChange(positionAt(e), 'move')
  }
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!dragging.current) return
    dragging.current = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    onPositionChange(positionAt(e), 'end')
  }

  const runImport = async (read: () => Promise<PickedWavFile | null>): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const file = await read()
      if (!file) return
      // Let "Analysing…" paint first: the analysis holds the renderer for up to a few seconds.
      await new Promise((resolve) => setTimeout(resolve, 30))
      const imported = importWavetable(
        file.bytes,
        file.name,
        frameCount,
        frameLength,
        file.path,
        evenLevels
      )
      setNotices(importNotices(imported))
      onSampleChange(imported.asset)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const tableBytes =
    isWavetable && sample
      ? wavetablePyramidBytes({ frameCount: sample.frameCount!, frameLength: sample.frameLength! })
      : 0
  const lengthOptions = WAVETABLE_FRAME_LENGTHS.map((length) => ({
    length,
    label: `${length} (${length / 4} harmonics)`
  }))
  return (
    <div className="inspector__sample">
      <span className="inspector__params-title">Wavetable</span>
      {isWavetable && sample ? (
        <>
          <div
            className="inspector__sample-waveform-wrap"
            style={{ width: VIEW_WIDTH, height: CYCLE_HEIGHT + 2 }}
          >
            <canvas
              ref={cycleRef}
              className="inspector__sample-waveform"
              style={{ width: VIEW_WIDTH, height: CYCLE_HEIGHT }}
              aria-label={`The cycle at POSITION ${position}`}
            />
            <button
              type="button"
              className="inspector__sample-play"
              onClick={preview.toggle}
              data-tooltip={
                preview.playing
                  ? 'Stop'
                  : `Hold ${noteName(PREVIEW_NOTE)} with this cycle (follows POSITION and the strip)`
              }
              aria-label={preview.playing ? 'Stop preview' : 'Play the cycle'}
            >
              {preview.playing ? <Square size={10} /> : <Play size={10} />}
            </button>
          </div>
          <canvas
            ref={stripRef}
            className="inspector__sample-waveform inspector__wavetable-strip"
            style={{ width: VIEW_WIDTH, height: STRIP_HEIGHT }}
            aria-label="Every frame; drag to set POSITION"
            data-tooltip="Every frame, left to right. Drag to set POSITION."
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          <span className="inspector__sample-name" title={sample.sourcePath ?? sample.sourceName}>
            {sample.sourceName}
          </span>
          <span className="inspector__sample-meta">
            {sample.frameCount} frames × {sample.frameLength} points · from {sample.rate} Hz
          </span>
          <span className="inspector__sample-meta">
            {(tableBytes / 1024).toFixed(1)} KB with its band-limited copies:{' '}
            {percentOf(tableBytes, XD_OSC_RAM)} of minilogue xd,{' '}
            {percentOf(tableBytes, NTS1MKII_OSC_RAM)} of NTS-1 mkII
          </span>
          {sample.truncatedFromSeconds !== undefined && (
            <span className="inspector__description inspector__description--warning">
              Only the first 30 s of the {sample.truncatedFromSeconds.toFixed(1)} s source were
              analysed.
            </span>
          )}
          {notices.map((n) => (
            <span
              key={n.text}
              className={`inspector__description${n.warning ? ' inspector__description--warning' : ''}`}
            >
              {n.text}
            </span>
          ))}
        </>
      ) : sample ? (
        <span className="inspector__description inspector__description--warning">
          {sample.encoding === 'wt8'
            ? "This wavetable can't be read (its shape is invalid) -- load the WAV again."
            : `This node holds a sample imported for ${sample.encoding === 'mulaw8' ? 'granular' : 'the sample player'}. A wavetable is cut from the original WAV: load it here${sample.sourcePath ? ', or re-import it with the ↻ button' : ''}.`}
        </span>
      ) : (
        <span className="inspector__description">
          No wavetable yet. Load a pitched WAV (a sung or played note, a phrase): single cycles are
          cut from it along its pitch and lined up, so POSITION changes only the timbre.
        </span>
      )}
      <div className="inspector__sample-actions">
        <label className="inspector__field inspector__sample-size">
          <span>Frames</span>
          <select value={frameCount} onChange={(e) => setFrameCount(Number(e.target.value))}>
            {WAVETABLE_FRAME_COUNTS.map((n) => (
              <option key={n} value={n}>
                {framesLabel(n, frameLength)}
              </option>
            ))}
          </select>
        </label>
        <label className="inspector__field inspector__sample-size">
          <span>Points</span>
          <select value={frameLength} onChange={(e) => setFrameLength(Number(e.target.value))}>
            {lengthOptions.map((o) => (
              <option key={o.length} value={o.length}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="inspector__field inspector__sample-size">
          <span>Level</span>
          <select
            value={evenLevels ? 'even' : 'recorded'}
            onChange={(e) => setEvenLevels(e.target.value === 'even')}
          >
            <option value="even">Even out</option>
            <option value="recorded">As recorded</option>
          </select>
        </label>
      </div>
      <div className="inspector__sample-actions">
        <button
          type="button"
          className="inspector__sample-button"
          disabled={busy}
          onClick={() => void runImport(() => window.axoloti.sampleFile.pickWav())}
        >
          <FileAudio size={12} /> {busy ? 'Analysing…' : 'Load WAV…'}
        </button>
        {sample?.sourcePath && (
          <button
            type="button"
            className="inspector__sample-button"
            disabled={busy}
            onClick={() =>
              void runImport(() => window.axoloti.sampleFile.readWav(sample.sourcePath!))
            }
            data-tooltip={`Re-import ${sample.sourceName} with these settings`}
            aria-label="Re-import with these settings"
          >
            <RotateCw size={12} />
          </button>
        )}
      </div>
      {error && (
        <span className="inspector__description inspector__description--warning">{error}</span>
      )}
    </div>
  )
}

export default WavetableSection

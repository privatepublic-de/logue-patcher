import { useEffect, useMemo, useRef, useState } from 'react'
import { FileAudio, Play, RotateCw, Square, X } from 'lucide-react'
import type { SampleAsset } from '@shared/domain/patch'
import type { PickedWavFile } from '@shared/ipc/contract'
import { snapLoopPoint } from '@logue-codegen/sample/loopSnap'
import {
  DEFAULT_PLAIN_SAMPLE_MAX_LENGTH,
  MIN_LOOP_LENGTH,
  DEFAULT_SAMPLE_SIZE,
  PLAIN_SAMPLE_MAX_LENGTHS,
  SAMPLE_SIZE_CHOICES,
  decodeSampleAsset,
  importPlainSample,
  importWavSample,
  type ImportedPlainSample,
  type PlainSampleFit
} from '@logue-codegen/sample/importSample'
import { NOTE_NAME } from '@logue-codegen/paramPresentation'
import { requireUnitKind } from '@logue-codegen/unitKinds'
import { useSamplePreview, type PreviewPlayback } from './useSamplePreview'
import type { SampleLoopMode } from '@logue-codegen/sample/playbackOrder'

// Both sample players only run in oscillators; a sample's share of each device's oscillator memory.
const XD_OSC_RAM = requireUnitKind('minilogue-xd', 'osc').ramBytes
const NTS1MKII_OSC_RAM = requireUnitKind('nts1mkii', 'osc').ramBytes

const WAVEFORM_WIDTH = 240
const WAVEFORM_HEIGHT = 48
/** Pixels either side of the pointer a dragged loop point may snap within. */
const SNAP_RADIUS_PX = 4

interface LoopRange {
  start: number
  end: number
}

/** Which import a sample-reading primitive uses (`LoguePrimitive.sampleImport`). */
export type SampleImportKind = 'granular' | 'plain'

function formatSize(samples: number): string {
  return `${samples / 1024}K`
}

function percentOf(bytes: number, budget: number): string {
  return `${Math.round((bytes / budget) * 100)}%`
}

function formatSeconds(samples: number, rate: number): string {
  return `${(samples / rate).toFixed(2)} s`
}

/** A length choice with its share of the xd's oscillator memory, or of the NTS-1 mkII's once
 *  the table alone can't fit the xd. */
function choiceLabel(samples: number): string {
  return samples < XD_OSC_RAM
    ? `${formatSize(samples)} (${percentOf(samples, XD_OSC_RAM)} xd)`
    : `${formatSize(samples)} (${percentOf(samples, NTS1MKII_OSC_RAM)} NTS-1 mkII)`
}

/** The smallest length choice holding `length`, so re-importing keeps what's there. */
function initialChoice(
  choices: readonly number[],
  length: number | undefined,
  fallback: number
): number {
  if (length === undefined) return fallback
  return choices.find((c) => c >= length) ?? choices[choices.length - 1]
}

interface Notice {
  text: string
  warning?: boolean
}

/** What the last plain import did, in words -- shown until the next import or selection. */
function plainImportNotices(result: ImportedPlainSample): Notice[] {
  const notices: Notice[] = []
  if (result.bitExact) notices.push({ text: 'Stored bit-exactly from the 8-bit file.' })
  if (result.rootNote !== undefined) {
    notices.push({
      text: `ROOT set to ${NOTE_NAME.toDisplay(result.rootNote)} ${
        result.rootSource === 'smpl' ? "from the file's root key" : '(detected pitch)'
      }.`
    })
  }
  const dropped = result.droppedLoop
  if (dropped) {
    const why = {
      type: `its type (${dropped.type === 1 ? 'ping-pong' : dropped.type === 2 ? 'backward' : dropped.type}) isn't supported`,
      invalid: 'it lies outside the audio',
      short: 'it is too short to loop cleanly',
      cut: 'the cut runs through it -- pick a larger maximum or Downsample'
    }[dropped.reason]
    notices.push({ text: `The file's loop was dropped: ${why}.`, warning: true })
  }
  return notices
}

/**
 * The Inspector's sample editor: a waveform preview (with the loop, if any), what was stored,
 * how much of each platform's RAM budget the table alone takes, and the import itself.
 *  - `granular`: the whole file is resampled to fit the chosen size, so the size menu is the one
 *    choice -- a longer file just lands at a lower (more lo-fi) rate.
 *  - `plain` (`logue/osc/sample`): the file keeps its own rate as linear 8-bit; the maximum
 *    length and what to do past it (cut or downsample) are the choices. The loop's two lines can
 *    be dragged on the (unzoomed) waveform -- each lands on the best nearby zero crossing
 *    (`snapLoopPoint`), or exactly where dropped with Shift -- one undo step per drag.
 */
function SampleSection({
  kind,
  sample,
  loopMode,
  reverse,
  onSampleChange
}: {
  kind: SampleImportKind
  sample: SampleAsset | undefined
  /** The node's LOOP and REVERSE (`osc/sample`): the preview plays the way the device will. */
  loopMode: SampleLoopMode
  reverse: boolean
  /** A new or edited sample; `rootNote` (from an import) also sets ROOT. */
  onSampleChange: (sample: SampleAsset, rootNote: number | undefined) => void
}): React.JSX.Element {
  // Keyed on the bytes, not the asset: a loop edit stores a new asset with the same bytes, and a
  // new decode would stop a playing preview.
  const data = sample?.data
  const encoding = sample?.encoding
  const decoded = useMemo(
    () => (data !== undefined && encoding ? decodeSampleAsset({ data, encoding }) : undefined),
    [data, encoding]
  )
  const plain = kind === 'plain'
  const choices: readonly number[] = plain ? PLAIN_SAMPLE_MAX_LENGTHS : SAMPLE_SIZE_CHOICES
  const [size, setSize] = useState<number>(() =>
    plain
      ? initialChoice(choices, decoded?.length, DEFAULT_PLAIN_SAMPLE_MAX_LENGTH)
      : decoded && choices.includes(decoded.length)
        ? decoded.length
        : DEFAULT_SAMPLE_SIZE
  )
  const [fit, setFit] = useState<PlainSampleFit>(sample?.resampledFromRate ? 'downsample' : 'cut')
  const [notices, setNotices] = useState<Notice[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const length = decoded?.length ?? 0
  // While a marker is dragged, the dragged loop is shown and previewed; it's stored on release.
  const [dragLoop, setDragLoop] = useState<LoopRange | null>(null)
  const dragRef = useRef<{ moving: 'start' | 'end'; other: number; moved: boolean } | null>(null)
  const loopStart = dragLoop?.start ?? sample?.loopStart
  const loopEnd = dragLoop?.end ?? sample?.loopEnd
  const storedLoop =
    loopStart !== undefined && loopEnd !== undefined
      ? { start: loopStart, end: loopEnd }
      : undefined
  // LOOP on without a stored loop repeats the whole sample, as on the device.
  const playback: PreviewPlayback | undefined =
    plain && length > 0
      ? { mode: loopMode, loop: storedLoop ?? { start: 0, end: length }, reverse }
      : undefined
  const preview = useSamplePreview(decoded, sample?.rate, playheadRef, playback)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = WAVEFORM_WIDTH * dpr
    canvas.height = WAVEFORM_HEIGHT * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, WAVEFORM_WIDTH, WAVEFORM_HEIGHT)
    if (!decoded || decoded.length === 0) return
    const color = getComputedStyle(canvas).color
    if (loopStart !== undefined && loopEnd !== undefined) {
      const x0 = (loopStart / decoded.length) * WAVEFORM_WIDTH
      const x1 = (loopEnd / decoded.length) * WAVEFORM_WIDTH
      ctx.globalAlpha = 0.15
      ctx.fillStyle = color
      ctx.fillRect(x0, 0, x1 - x0, WAVEFORM_HEIGHT)
      ctx.globalAlpha = 0.8
      ctx.fillRect(Math.min(x0, WAVEFORM_WIDTH - 1), 0, 1, WAVEFORM_HEIGHT)
      ctx.fillRect(Math.min(x1, WAVEFORM_WIDTH) - 1, 0, 1, WAVEFORM_HEIGHT)
      ctx.globalAlpha = 1
    }
    ctx.fillStyle = color
    const mid = WAVEFORM_HEIGHT / 2
    const perColumn = decoded.length / WAVEFORM_WIDTH
    for (let x = 0; x < WAVEFORM_WIDTH; x++) {
      let lo = 0
      let hi = 0
      const end = Math.min(decoded.length, Math.ceil((x + 1) * perColumn))
      for (let i = Math.floor(x * perColumn); i < end; i++) {
        lo = Math.min(lo, decoded[i])
        hi = Math.max(hi, decoded[i])
      }
      const top = mid - hi * mid
      ctx.fillRect(x, top, 1, Math.max(1, (hi - lo) * mid))
    }
  }, [decoded, loopStart, loopEnd])

  const sampleAt = (e: React.PointerEvent<HTMLCanvasElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect()
    return ((e.clientX - rect.left) / rect.width) * length
  }

  const dragTo = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    if (!drag || !decoded) return
    const position = sampleAt(e)
    const point = e.shiftKey
      ? Math.round(position)
      : snapLoopPoint({
          samples: decoded,
          moving: drag.moving,
          position,
          other: drag.other,
          radius: Math.max(MIN_LOOP_LENGTH, (length / WAVEFORM_WIDTH) * SNAP_RADIUS_PX),
          minLength: MIN_LOOP_LENGTH
        })
    const clamped =
      drag.moving === 'start'
        ? Math.max(0, Math.min(point, drag.other - MIN_LOOP_LENGTH))
        : Math.min(length, Math.max(point, drag.other + MIN_LOOP_LENGTH))
    drag.moved = true
    setDragLoop(
      drag.moving === 'start'
        ? { start: clamped, end: drag.other }
        : { start: drag.other, end: clamped }
    )
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!plain || !sample || length < 2 * MIN_LOOP_LENGTH || e.button !== 0) return
    // Without a stored loop the markers sit at the sample's ends (what LOOP repeats then).
    const current = storedLoop ?? { start: 0, end: length }
    const position = sampleAt(e)
    const moving =
      Math.abs(position - current.start) <= Math.abs(position - current.end) ? 'start' : 'end'
    dragRef.current = {
      moving,
      other: moving === 'start' ? current.end : current.start,
      moved: false
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    dragTo(e)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    const next = dragLoop
    setDragLoop(null)
    if (!drag?.moved || !next || !sample) return
    if (next.start === sample.loopStart && next.end === sample.loopEnd) return
    onSampleChange({ ...sample, loopStart: next.start, loopEnd: next.end }, undefined)
  }

  const clearLoop = (): void => {
    if (!sample) return
    const cleared = { ...sample }
    delete cleared.loopStart
    delete cleared.loopEnd
    onSampleChange(cleared, undefined)
  }

  const runImport = async (read: () => Promise<PickedWavFile | null>): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const file = await read()
      if (!file) return
      if (plain) {
        const imported = importPlainSample(file.bytes, file.name, size, fit, file.path)
        setNotices(plainImportNotices(imported))
        onSampleChange(imported.asset, imported.rootNote)
      } else {
        const imported = importWavSample(file.bytes, file.name, size, file.path)
        onSampleChange(imported.asset, imported.rootNote)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // A sample stored for the other player still plays (osc/sample converts mu-law; granular
  // refuses linear, see its instanceProblem) -- say how to get the right one.
  const wrongEncoding =
    sample && (plain ? sample.encoding !== 'pcm8' : sample.encoding !== 'mulaw8')
  const cutText =
    sample?.truncatedFromSeconds !== undefined
      ? plain
        ? `The source was ${sample.truncatedFromSeconds.toFixed(2)} s long and was cut to fit -- pick a larger maximum, or Downsample, to keep more of it.`
        : `The source was ${sample.truncatedFromSeconds.toFixed(1)} s long, cut to fit at the lowest rate -- pick a larger size to keep more of it.`
      : undefined
  return (
    <div className="inspector__sample">
      <span className="inspector__params-title">Sample</span>
      {sample ? (
        <>
          <div className="inspector__sample-waveform-wrap" style={{ width: WAVEFORM_WIDTH }}>
            <canvas
              ref={canvasRef}
              className={`inspector__sample-waveform${plain ? ' inspector__sample-waveform--loop-edit' : ''}`}
              style={{ width: WAVEFORM_WIDTH, height: WAVEFORM_HEIGHT }}
              aria-label={`Waveform of ${sample.sourceName}`}
              data-tooltip={
                plain
                  ? 'Drag to move the nearer loop point (snaps to the best zero crossing; Shift: exact)'
                  : undefined
              }
              onPointerDown={onPointerDown}
              onPointerMove={dragTo}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
            <div ref={playheadRef} className="inspector__sample-playhead" aria-hidden="true" />
            <button
              type="button"
              className="inspector__sample-play"
              onClick={preview.toggle}
              data-tooltip={
                preview.playing
                  ? 'Stop'
                  : playback && (playback.mode !== 'off' || playback.reverse)
                    ? `Play the stored sample as the node will (${[
                        playback.reverse ? 'reversed' : '',
                        { off: '', forward: 'looping', pingpong: 'ping-pong' }[playback.mode]
                      ]
                        .filter(Boolean)
                        .join(', ')})`
                    : 'Play the stored sample'
              }
              aria-label={preview.playing ? 'Stop preview' : 'Play the stored sample'}
            >
              {preview.playing ? <Square size={10} /> : <Play size={10} />}
            </button>
          </div>
          <span className="inspector__sample-name" title={sample.sourcePath ?? sample.sourceName}>
            {sample.sourceName}
          </span>
          <span className="inspector__sample-meta">
            {length} samples · {sample.rate} Hz · {formatSeconds(length, sample.rate)}
            {plain && sample.encoding === 'pcm8' ? ' · 8-bit' : ''}
          </span>
          {plain && sample.resampledFromRate !== undefined && (
            <span className="inspector__sample-meta">
              Downsampled from {sample.resampledFromRate} Hz
            </span>
          )}
          {plain && (
            <span className="inspector__sample-meta inspector__sample-loop">
              {storedLoop
                ? `Loop ${storedLoop.start}–${storedLoop.end} (${formatSeconds(storedLoop.end - storedLoop.start, sample.rate)})`
                : 'No stored loop: LOOP repeats the whole sample'}
              {storedLoop && !dragLoop && (
                <button
                  type="button"
                  className="inspector__sample-clear-loop"
                  onClick={clearLoop}
                  data-tooltip="Remove the loop (LOOP then repeats the whole sample)"
                  aria-label="Remove the loop"
                >
                  <X size={10} />
                </button>
              )}
            </span>
          )}
          <span className="inspector__sample-meta">
            {(length / 1024).toFixed(1)} KB: {percentOf(length, XD_OSC_RAM)} of minilogue xd,{' '}
            {percentOf(length, NTS1MKII_OSC_RAM)} of NTS-1 mkII
          </span>
          {cutText && (
            <span className="inspector__description inspector__description--warning">
              {cutText}
            </span>
          )}
          {wrongEncoding && (
            <span className="inspector__description inspector__description--warning">
              {sample.encoding === 'wt8'
                ? `This node holds a wavetable (single cycles), which ${plain ? 'the sample player' : 'granular'} can't play -- load the WAV again.`
                : plain
                  ? 'This sample was imported for granular (mu-law, resampled). It plays, converted -- re-import it to keep the file at its own rate as 8-bit.'
                  : 'This sample was imported as linear 8-bit for the sample player; granular needs it re-imported.'}
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
      ) : (
        <span className="inspector__description">
          {plain
            ? "No sample yet. Any WAV works: it's mixed to mono and kept at its own rate as 8-bit; a loop and root key stored in the file are used."
            : "No sample yet. Any WAV works: it's mixed to mono, trimmed, and resampled to fit."}
        </span>
      )}
      <div className="inspector__sample-actions">
        <label className="inspector__field inspector__sample-size">
          <span>{plain ? 'Max length' : 'Size'}</span>
          <select value={size} onChange={(e) => setSize(Number(e.target.value))}>
            {choices.map((choice) => (
              <option key={choice} value={choice}>
                {choiceLabel(choice)}
              </option>
            ))}
          </select>
        </label>
        {plain && (
          <label className="inspector__field inspector__sample-size">
            <span>If longer</span>
            <select value={fit} onChange={(e) => setFit(e.target.value as PlainSampleFit)}>
              <option value="cut">Cut</option>
              <option value="downsample">Downsample</option>
            </select>
          </label>
        )}
      </div>
      <div className="inspector__sample-actions">
        <button
          type="button"
          className="inspector__sample-button"
          disabled={busy}
          onClick={() => void runImport(() => window.axoloti.sampleFile.pickWav())}
        >
          <FileAudio size={12} /> {busy ? 'Importing…' : 'Load WAV…'}
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

export default SampleSection

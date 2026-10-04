import { useCallback, useEffect, useRef, useState } from 'react'
import { playbackOrder, type SampleLoopMode } from '@logue-codegen/sample/playbackOrder'

// Chromium's createBuffer refuses rates below this; stored samples go down to MIN_SAMPLE_RATE (2000).
const MIN_BUFFER_RATE = 3000

let sharedContext: AudioContext | null = null

// Created on the first Play, not at load: Chromium only lets a context start after a user gesture.
export function audioContext(): AudioContext {
  sharedContext ??= new AudioContext()
  return sharedContext
}

/** How `logue/osc/sample` will play it; omitted, the table plays once, forwards. */
export interface PreviewPlayback {
  mode: SampleLoopMode
  loop: { start: number; end: number }
  reverse: boolean
}

/** What gets queued: the samples, the looped stretch of them, and (when reordered) which stored
 *  index each one is, for the playhead. */
interface PreviewBuffer {
  samples: Float32Array
  loop?: { start: number; end: number }
  indexOf?: Int32Array
}

function previewBuffer(
  decoded: Float32Array,
  playback: PreviewPlayback | undefined
): PreviewBuffer {
  if (!playback || playback.mode === 'off') {
    if (!playback?.reverse) return { samples: decoded }
  } else if (playback.mode === 'forward' && !playback.reverse) {
    return { samples: decoded, loop: playback.loop }
  }
  // Web Audio only loops forwards: lay the samples out in the device's play order.
  const order = playbackOrder(decoded.length, playback.mode, playback.loop, playback.reverse)
  const samples = Float32Array.from(order.indices, (i) => decoded[i])
  return {
    samples,
    indexOf: order.indices,
    loop:
      order.cycleFrom === undefined ? undefined : { start: order.cycleFrom, end: samples.length }
  }
}

/**
 * Plays the stored (decoded) table at its own rate in the order the device will -- what it reads,
 * not the source WAV: once, or through to the loop and round it until stopped (forwards, back and
 * forth, or mirrored with REVERSE). A plain forward loop that moves while playing (a dragged
 * marker) is applied live; any other change stops playback. The playhead element is moved
 * directly per frame, so playback never re-renders React.
 */
export function useSamplePreview(
  decoded: Float32Array | undefined,
  rate: number | undefined,
  playheadRef: React.RefObject<HTMLElement | null>,
  playback?: PreviewPlayback
): { playing: boolean; toggle: () => void } {
  const [playing, setPlaying] = useState(false)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const bufferRateRef = useRef(0)
  const frameRef = useRef(0)
  const loopRef = useRef<{ start: number; end: number } | undefined>(undefined)

  const stop = useCallback(() => {
    cancelAnimationFrame(frameRef.current)
    const source = sourceRef.current
    sourceRef.current = null
    if (source) {
      source.onended = null
      source.stop()
      source.disconnect()
    }
    if (playheadRef.current) playheadRef.current.style.display = 'none'
    setPlaying(false)
  }, [playheadRef])

  const mode = playback?.mode ?? 'off'
  const reverse = playback?.reverse ?? false
  const live = mode === 'forward' && !reverse
  const loopStart = playback?.loop.start
  const loopEnd = playback?.loop.end
  // A moved loop is applied live only where the buffer is the plain table; elsewhere it's
  // rebuilt, so the loop points join the restart conditions.
  const rebuildKey = live ? 'live' : `${loopStart}:${loopEnd}`
  useEffect(() => stop, [decoded, rate, mode, reverse, rebuildKey, stop])

  useEffect(() => {
    if (!live || loopStart === undefined || loopEnd === undefined) return
    loopRef.current = { start: loopStart, end: loopEnd }
    const source = sourceRef.current
    if (!source || !source.loop) return
    // In the buffer's own (declared) time.
    source.loopEnd = loopEnd / bufferRateRef.current
    source.loopStart = loopStart / bufferRateRef.current
  }, [live, loopStart, loopEnd])

  const toggle = useCallback(() => {
    if (sourceRef.current) {
      stop()
      return
    }
    if (!decoded || decoded.length === 0 || !rate) return
    const plan = previewBuffer(
      decoded,
      loopStart === undefined || loopEnd === undefined
        ? undefined
        : { mode, loop: { start: loopStart, end: loopEnd }, reverse }
    )
    loopRef.current = plan.loop
    const ctx = audioContext()
    void ctx.resume()
    // Below the minimum, the buffer is declared k times faster and played k times slower: same pitch.
    const k = Math.ceil(MIN_BUFFER_RATE / rate)
    bufferRateRef.current = rate * k
    const buffer = ctx.createBuffer(1, plan.samples.length, rate * k)
    buffer.getChannelData(0).set(plan.samples)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = 1 / k
    if (plan.loop) {
      source.loop = true
      source.loopStart = plan.loop.start / (rate * k)
      source.loopEnd = plan.loop.end / (rate * k)
    }
    source.connect(ctx.destination)
    source.onended = stop
    source.start()
    sourceRef.current = source
    setPlaying(true)

    // Followed per frame rather than from the start time, so a loop moved mid-play wraps right.
    let pos = 0
    let last = ctx.currentTime
    const tick = (): void => {
      const now = ctx.currentTime
      pos += (now - last) * rate
      last = now
      const current = loopRef.current
      if (current && pos >= current.end) {
        pos = current.start + ((pos - current.end) % (current.end - current.start))
      }
      const playhead = playheadRef.current
      if (playhead) {
        const at = Math.min(Math.floor(pos), plan.samples.length - 1)
        const stored = plan.indexOf ? plan.indexOf[at] : pos
        playhead.style.display = 'block'
        playhead.style.left = `${Math.min(1, stored / decoded.length) * 100}%`
      }
      frameRef.current = requestAnimationFrame(tick)
    }
    tick()
  }, [decoded, rate, mode, reverse, loopStart, loopEnd, stop, playheadRef])

  return { playing, toggle }
}

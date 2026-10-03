import type { WavetableShape } from './wavetablePyramid'
import {
  wavetableLevelCount,
  wavetableLevelLength,
  wavetableLevelOffsets
} from './wavetablePyramid'

/**
 * The player's read (`logue/osc/wavetable`'s `wavetable_step`, `wt_level`, `wt_frame_pos`) in
 * TypeScript, single precision where the C is: the Inspector's preview plays it, and the harness
 * checks the generated unit against it sample by sample. Keep the two in step.
 */
const f = Math.fround

/** Mip level plus the crossfade into the next one, for a phase increment in cycles/sample. */
export function wavetableLevel(w0: number, shape: WavetableShape): number {
  const lastLevel = wavetableLevelCount(shape.frameLength) - 1
  let x = f(w0 * shape.frameLength)
  let level = 0
  while (x >= 2 && level < lastLevel) {
    x = f(x * 0.5)
    level += 1
  }
  if (level >= lastLevel || x <= 1) return level
  return f(level + f(x - 1))
}

/** POSITION 0..1 as a frame position; `step` rounds to the nearest frame (MORPH Step). */
export function wavetableFramePos(pos01: number, shape: WavetableShape, step: boolean): number {
  const p = f(f(pos01) * (shape.frameCount - 1))
  return step ? Math.floor(f(p + 0.5)) : p
}

function levelRead(
  pyramid: Int8Array,
  shape: WavetableShape,
  level: number,
  frame: number,
  frameT: number,
  phase: number
): number {
  const len = wavetableLevelLength(shape.frameLength, level)
  const a = wavetableLevelOffsets(shape)[level] + frame * len
  const b = a + len
  const x = f(phase * len)
  let i = Math.floor(x) >>> 0
  const fr = f(x - i)
  i &= len - 1
  const j = (i + 1) & (len - 1)
  const va = f(pyramid[a + i] + f((pyramid[a + j] - pyramid[a + i]) * fr))
  const vb = f(pyramid[b + i] + f((pyramid[b + j] - pyramid[b + i]) * fr))
  return f(va + f(f(vb - va) * frameT))
}

/** One output sample, -1..1, from the pyramid (`wavetablePyramid`'s bytes as signed values). */
export function wavetableSample(
  pyramid: Int8Array,
  shape: WavetableShape,
  phase: number,
  level: number,
  framePos: number
): number {
  const lastLevel = wavetableLevelCount(shape.frameLength) - 1
  let frame = Math.floor(framePos)
  let frameT = f(framePos - frame)
  if (frame > shape.frameCount - 2) {
    frame = shape.frameCount - 2
    frameT = 1
  }
  const l0 = Math.floor(level)
  const levelT = f(level - l0)
  let v = levelRead(pyramid, shape, l0, frame, frameT, phase)
  if (levelT > 0 && l0 < lastLevel) {
    const w = levelRead(pyramid, shape, l0 + 1, frame, frameT, phase)
    v = f(v + f(f(w - v) * levelT))
  }
  return f(v * f(1 / 128))
}

/** `count` samples at a fixed note (cycles/sample `w0`) and POSITION, from phase 0. */
export function renderWavetable(
  pyramid: Int8Array,
  shape: WavetableShape,
  w0: number,
  pos01: number,
  step: boolean,
  count: number
): Float32Array {
  const out = new Float32Array(count)
  const level = wavetableLevel(w0, shape)
  const framePos = wavetableFramePos(pos01, shape, step)
  let phase = 0
  for (let i = 0; i < count; i++) {
    out[i] = wavetableSample(pyramid, shape, phase, level, framePos)
    phase = f(phase + w0)
    if (phase >= 1) phase = f(phase - 1)
  }
  return out
}

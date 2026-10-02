const ZERO_CROSSINGS = 16

/**
 * Blackman-windowed sinc resampler. The import's downsampling ratio can be large (a 10 s file
 * squeezed into 16K samples lands near 1.6 kHz), so the kernel widens with the ratio: its cutoff
 * sits just under the OUTPUT Nyquist, which is also the only anti-aliasing this sample ever gets
 * -- on-device playback is plain linear interpolation.
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  const outLength = Math.max(1, Math.round((input.length * toRate) / fromRate))
  if (fromRate === toRate) return input.slice(0, outLength)
  const out = new Float32Array(outLength)
  const step = fromRate / toRate
  const cutoff = 0.95 * Math.min(1, toRate / fromRate)
  const halfWidth = ZERO_CROSSINGS / cutoff
  for (let n = 0; n < outLength; n++) {
    const center = n * step
    const lo = Math.max(0, Math.ceil(center - halfWidth))
    const hi = Math.min(input.length - 1, Math.floor(center + halfWidth))
    let acc = 0
    let weightSum = 0
    for (let k = lo; k <= hi; k++) {
      const x = k - center
      const sx = x * cutoff
      const sinc = sx === 0 ? 1 : Math.sin(Math.PI * sx) / (Math.PI * sx)
      const w = x / halfWidth
      const blackman = 0.42 + 0.5 * Math.cos(Math.PI * w) + 0.08 * Math.cos(2 * Math.PI * w)
      const h = sinc * blackman
      acc += input[k] * h
      weightSum += h
    }
    // Per-output normalization keeps DC gain at exactly 1 near the edges, where the kernel is cut.
    out[n] = weightSum !== 0 ? acc / weightSum : 0
  }
  return out
}

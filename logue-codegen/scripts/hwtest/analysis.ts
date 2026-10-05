/**
 * Signal analysis for hardware recordings: pure functions over Float32Arrays (no I/O), tested in
 * `test/hwtest-analysis.spec.ts` on synthetic signals.
 */

export function rms(x: Float32Array): number {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * x[i]
  return Math.sqrt(s / Math.max(1, x.length))
}

export const dbfs = (v: number): number => 20 * Math.log10(Math.max(v, 1e-12))

/** In-place radix-2 FFT (re/im of a power-of-two length). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}

/** Magnitude spectrum of the largest power-of-two prefix, Hann-windowed (amplitude-normalized:
 *  a full-scale sine reads ~1 at its bin). */
export function spectrum(x: Float32Array): { mag: Float64Array; binHz: (sr: number) => number } {
  let n = 1
  while (n * 2 <= x.length) n *= 2
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n))
  fft(re, im)
  const mag = new Float64Array(n / 2)
  for (let i = 0; i < n / 2; i++) mag[i] = (Math.hypot(re[i], im[i]) * 4) / n
  return { mag, binHz: (sr) => sr / n }
}

/**
 * The strongest spectral peak above `minHz`, refined by Gaussian (log-parabolic) interpolation on
 * the Hann window's main lobe -- accurate to a small fraction of a bin for a clean tone.
 */
export function peakFrequency(
  x: Float32Array,
  sampleRate: number,
  minHz = 20,
  maxHz = sampleRate / 2
): { hz: number; amplitude: number } {
  const { mag, binHz } = spectrum(x)
  const bin = binHz(sampleRate)
  let best = Math.max(1, Math.ceil(minHz / bin))
  const last = Math.min(mag.length - 2, Math.floor(maxHz / bin))
  for (let i = best; i <= last; i++) if (mag[i] > mag[best]) best = i
  const a = Math.log(mag[best - 1] + 1e-30)
  const b = Math.log(mag[best] + 1e-30)
  const c = Math.log(mag[best + 1] + 1e-30)
  const d = (0.5 * (a - c)) / (a - 2 * b + c)
  return { hz: (best + (Number.isFinite(d) ? d : 0)) * bin, amplitude: mag[best] }
}

export const centsBetween = (hz: number, refHz: number): number => 1200 * Math.log2(hz / refHz)

export const noteHz = (note: number): number => 440 * Math.pow(2, (note - 69) / 12)

export interface GlitchScan {
  /** Start times (s) of the 32-sample windows whose residual stands out. */
  times: number[]
  /** Median residual RMS of a window: the recording's noise floor under the tones. */
  floor: number
  /** Largest window residual RMS. */
  worst: number
}

/**
 * Finds dropouts in a recording of known steady tones: each 1024-sample block is fitted with a
 * sine and cosine per frequency (least squares, so the amplitude and phase may drift slowly
 * between blocks), and 32-sample windows of what's left are compared with the floor. A gap, a
 * repeated or a skipped block leaves a residual near the tones' own level; a clean recording
 * leaves the interface's noise -- unless the whole recording is broken, which is why a caller
 * that knows the clean floor passes it. `freqs` should be measured from the recording itself
 * (`peakFrequency`), which already includes the interface's clock offset.
 */
export function scanGlitches(
  x: Float32Array,
  sampleRate: number,
  freqs: number[],
  { block = 1024, window = 32, factor = 8, floor: knownFloor = Infinity } = {}
): GlitchScan {
  const residual = new Float64Array(x.length)
  const n = 2 * freqs.length
  for (let start = 0; start < x.length; start += block) {
    const end = Math.min(x.length, start + block)
    const basis = (i: number, k: number): number => {
      const a = (2 * Math.PI * freqs[k >> 1] * i) / sampleRate
      return k & 1 ? Math.sin(a) : Math.cos(a)
    }
    const m = Array.from({ length: n }, () => new Float64Array(n + 1))
    for (let i = start; i < end; i++) {
      const b = Array.from({ length: n }, (_, k) => basis(i, k))
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) m[r][c] += b[r] * b[c]
        m[r][n] += b[r] * x[i]
      }
    }
    for (let col = 0; col < n; col++) {
      let piv = col
      for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r
      ;[m[col], m[piv]] = [m[piv], m[col]]
      for (let r = 0; r < n; r++) {
        if (r === col) continue
        const f = m[r][col] / m[col][col]
        for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c]
      }
    }
    const coef = m.map((row, r) => row[n] / row[r])
    for (let i = start; i < end; i++) {
      let y = 0
      for (let k = 0; k < n; k++) y += coef[k] * basis(i, k)
      residual[i] = x[i] - y
    }
  }
  const rmsOf: number[] = []
  for (let start = 0; start + window <= x.length; start += window) {
    let s = 0
    for (let i = start; i < start + window; i++) s += residual[i] * residual[i]
    rmsOf.push(Math.sqrt(s / window))
  }
  const sorted = [...rmsOf].sort((a, b) => a - b)
  // A recording broken everywhere has a high median: `knownFloor` (from a clean one) caps it.
  const floor = Math.min(sorted[sorted.length >> 1] ?? 0, knownFloor)
  const times: number[] = []
  rmsOf.forEach((v, k) => {
    if (v > factor * floor) times.push((k * window) / sampleRate)
  })
  return { times, floor, worst: sorted[sorted.length - 1] ?? 0 }
}

/**
 * The strongest tone in `band`, followed through consecutive `window`-sample stretches: for a
 * reading that moves (a unit whose cost changes with what it is doing), one long FFT smears the
 * tone, while ~0.17 s windows still resolve it to a fraction of a Hz.
 */
export function trackPeak(
  x: Float32Array,
  sampleRate: number,
  band: [number, number],
  window = 8192
): { hz: number[]; mean: number; max: number; min: number; minAmplitude: number } {
  const hz: number[] = []
  let minAmplitude = Infinity
  for (let start = 0; start + window <= x.length; start += window) {
    const p = peakFrequency(x.subarray(start, start + window), sampleRate, ...band)
    hz.push(p.hz)
    minAmplitude = Math.min(minAmplitude, p.amplitude)
  }
  const mean = hz.reduce((a, b) => a + b, 0) / Math.max(1, hz.length)
  return { hz, mean, max: Math.max(...hz), min: Math.min(...hz), minAmplitude }
}

/** Welch power spectrum: Hann segments of `n` samples, half overlapping, averaged. */
export function welch(
  x: Float32Array,
  n = 4096
): { power: Float64Array; binHz: (sr: number) => number } {
  const power = new Float64Array(n / 2)
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
  let count = 0
  for (let start = 0; start + n <= x.length; start += n / 2) {
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    for (let i = 0; i < n; i++) re[i] = x[start + i] * w[i]
    fft(re, im)
    for (let i = 0; i < n / 2; i++) power[i] += re[i] * re[i] + im[i] * im[i]
    count++
  }
  for (let i = 0; i < n / 2; i++) power[i] /= Math.max(1, count)
  return { power, binHz: (sr) => sr / n }
}

/** Third-octave band centres from 50 Hz to 16 kHz (base-2, 1 kHz included). */
export const THIRD_OCTAVES: number[] = Array.from(
  { length: 26 },
  (_, k) => 1000 * Math.pow(2, (k - 13) / 3)
).filter((f) => f >= 49 && f <= 16500)

/** Power per third-octave band (summed bins), in dB. */
export function bandLevels(x: Float32Array, sampleRate: number): number[] {
  // 16384 points: even the 50 Hz band then spans a few bins (at 4096 it held one).
  const { power, binHz } = welch(x, 16384)
  const bin = binHz(sampleRate)
  return THIRD_OCTAVES.map((fc) => {
    const lo = Math.ceil((fc * Math.pow(2, -1 / 6)) / bin)
    const hi = Math.floor((fc * Math.pow(2, 1 / 6)) / bin)
    let s = 0
    for (let i = lo; i <= hi; i++) s += power[i]
    return 10 * Math.log10(s + 1e-30)
  })
}

/** Level (dB, Welch power summed over the main lobe) of the tone nearest `hz`. */
export function toneLevel(x: Float32Array, sampleRate: number, hz: number): number {
  // 0.73 Hz bins and the Hann main lobe only: a 12 Hz tone next to sub-10 Hz rumble read the
  // rumble with 16384 points and +-3 bins.
  const { power, binHz } = welch(x, x.length >= 2 * 65536 ? 65536 : 16384)
  const bin = binHz(sampleRate)
  const c = Math.round(hz / bin)
  let s = 0
  for (let i = Math.max(1, c - 2); i <= c + 2 && i < power.length; i++) s += power[i]
  return 10 * Math.log10(s + 1e-30)
}

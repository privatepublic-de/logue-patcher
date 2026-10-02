export class InvalidWavError extends Error {}

export interface DecodedWav {
  sampleRate: number
  /** Already mixed down to mono, -1..1. */
  samples: Float32Array
  channels: number
  bitsPerSample: number
  isFloat: boolean
  /** From a `smpl` chunk; absent without one. */
  sampler?: WavSamplerInfo
}

/** What the import uses of a `smpl` chunk: the root key and the first loop, as stored. */
export interface WavSamplerInfo {
  /** `dwMIDIUnityNote`, 0..127. */
  unityNote: number
  /** The first loop of any type; `end` is INCLUSIVE, as in the file. */
  loop?: { start: number; end: number; type: number }
}

/** `smpl` loop type 0. The other two (1 alternating, 2 backward) aren't played. */
export const WAV_LOOP_FORWARD = 0

const FORMAT_PCM = 1
const FORMAT_FLOAT = 3
const FORMAT_EXTENSIBLE = 0xfffe

/** RIFF/WAVE: integer PCM (8/16/24/32-bit) or float (32/64-bit), any channel count, mixed to mono. */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (off: number): string =>
    String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3])
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new InvalidWavError('Not a WAV file (no RIFF/WAVE header).')
  }

  let format: number | undefined
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataOffset = -1
  let dataLength = 0
  let sampler: WavSamplerInfo | undefined
  let off = 12
  while (off + 8 <= bytes.length) {
    const id = tag(off)
    const size = view.getUint32(off + 4, true)
    const body = off + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitsPerSample = view.getUint16(body + 14, true)
      if (format === FORMAT_EXTENSIBLE && size >= 26) format = view.getUint16(body + 24, true)
    } else if (id === 'smpl' && size >= 36 && body + 36 <= bytes.length) {
      sampler = { unityNote: Math.min(127, view.getUint32(body + 12, true)) }
      const loops = view.getUint32(body + 28, true)
      const first = body + 36
      if (loops > 0 && size >= 36 + 24 && first + 24 <= bytes.length) {
        sampler.loop = {
          type: view.getUint32(first + 4, true),
          start: view.getUint32(first + 8, true),
          end: view.getUint32(first + 12, true)
        }
      }
    } else if (id === 'data') {
      dataOffset = body
      // Some writers leave the size at 0 or oversized when streaming -- read what's actually there.
      dataLength = Math.min(size, bytes.length - body)
    }
    off = body + size + (size & 1)
  }
  if (format === undefined) throw new InvalidWavError('WAV file has no fmt chunk.')
  if (dataOffset < 0) throw new InvalidWavError('WAV file has no data chunk.')
  if (channels < 1 || sampleRate <= 0)
    throw new InvalidWavError('WAV file has an invalid fmt chunk.')

  const bytesPerSample = bitsPerSample / 8
  let read: (at: number) => number
  if (format === FORMAT_PCM && bitsPerSample === 8) read = (at) => (view.getUint8(at) - 128) / 128
  else if (format === FORMAT_PCM && bitsPerSample === 16)
    read = (at) => view.getInt16(at, true) / 32768
  else if (format === FORMAT_PCM && bitsPerSample === 24)
    read = (at) =>
      (view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)) / 8388608
  else if (format === FORMAT_PCM && bitsPerSample === 32)
    read = (at) => view.getInt32(at, true) / 2147483648
  else if (format === FORMAT_FLOAT && bitsPerSample === 32) read = (at) => view.getFloat32(at, true)
  else if (format === FORMAT_FLOAT && bitsPerSample === 64) read = (at) => view.getFloat64(at, true)
  else {
    throw new InvalidWavError(
      `Unsupported WAV encoding (format ${format}, ${bitsPerSample}-bit) -- use PCM or float.`
    )
  }

  const frameBytes = bytesPerSample * channels
  const frames = Math.floor(dataLength / frameBytes)
  const samples = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    const base = dataOffset + f * frameBytes
    for (let c = 0; c < channels; c++) sum += read(base + c * bytesPerSample)
    samples[f] = sum / channels
  }
  const out: DecodedWav = {
    sampleRate,
    samples,
    channels,
    bitsPerSample,
    isFloat: format === FORMAT_FLOAT
  }
  if (sampler) out.sampler = sampler
  return out
}

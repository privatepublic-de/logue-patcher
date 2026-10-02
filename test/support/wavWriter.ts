export type WavFormat = 'pcm16' | 'pcm24' | 'float32' | 'pcm8'

/** A `smpl` chunk's root key and loops; `end` inclusive, as in the file. */
export interface WavSmpl {
  unityNote: number
  loops?: { start: number; end: number; type?: number }[]
}

/** A minimal RIFF/WAVE writer for the decoder tests -- `frames[f][c]` in -1..1. */
export function wav(
  frames: number[][],
  rate: number,
  format: WavFormat,
  smpl?: WavSmpl
): Uint8Array {
  const channels = frames[0]?.length ?? 1
  const bits = { pcm8: 8, pcm16: 16, pcm24: 24, float32: 32 }[format]
  const bps = bits / 8
  const dataLen = frames.length * channels * bps
  const dataPad = dataLen & 1
  const smplLen = smpl ? 36 + 24 * (smpl.loops?.length ?? 0) : 0
  const smplChunk = smpl ? 8 + smplLen : 0
  const buf = new ArrayBuffer(44 + dataLen + dataPad + smplChunk)
  const v = new DataView(buf)
  const tag = (off: number, s: string): void => {
    for (let i = 0; i < 4; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  tag(0, 'RIFF')
  v.setUint32(4, 36 + dataLen + dataPad + smplChunk, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, format === 'float32' ? 3 : 1, true)
  v.setUint16(22, channels, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * channels * bps, true)
  v.setUint16(32, channels * bps, true)
  v.setUint16(34, bits, true)
  tag(36, 'data')
  v.setUint32(40, dataLen, true)
  let off = 44
  for (const frame of frames) {
    for (const x of frame) {
      if (format === 'pcm8') v.setUint8(off, Math.round(x * 127) + 128)
      else if (format === 'pcm16') v.setInt16(off, Math.round(x * 32767), true)
      else if (format === 'pcm24') {
        const n = Math.round(x * 8388607)
        v.setUint8(off, n & 0xff)
        v.setUint8(off + 1, (n >> 8) & 0xff)
        v.setInt8(off + 2, n >> 16)
      } else v.setFloat32(off, x, true)
      off += bps
    }
  }
  off += dataPad
  if (smpl) {
    // After `data`, with an odd-sized data chunk before it, so the padding rule is exercised.
    tag(off, 'smpl')
    v.setUint32(off + 4, smplLen, true)
    const body = off + 8
    v.setUint32(body + 8, Math.round(1e9 / rate), true)
    v.setUint32(body + 12, smpl.unityNote, true)
    v.setUint32(body + 28, smpl.loops?.length ?? 0, true)
    smpl.loops?.forEach((loop, i) => {
      const at = body + 36 + 24 * i
      v.setUint32(at, i, true)
      v.setUint32(at + 4, loop.type ?? 0, true)
      v.setUint32(at + 8, loop.start, true)
      v.setUint32(at + 12, loop.end, true)
    })
  }
  return new Uint8Array(buf)
}

/** A mono 8-bit WAV from raw unsigned bytes, exactly as a period sampler would have stored them. */
export function wav8Raw(bytes: Uint8Array, rate: number, smpl?: WavSmpl): Uint8Array {
  return wav(
    Array.from(bytes, (b) => [(b - 128) / 127]),
    rate,
    'pcm8',
    smpl
  )
}

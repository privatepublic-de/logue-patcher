/**
 * G.711 mu-law, 8-bit. Chosen over ADPCM because grains read at arbitrary positions: ADPCM can
 * only be decoded sequentially from the start, mu-law is random-access, one byte per sample. The
 * on-device decoder is a 256-entry float table baked from `mulawDecode` below
 * (`MULAW_TABLE_HELPER`, primitives.ts) -- 1 KB of rodata for one load per read.
 */

const BIAS = 0x84
const CLIP = 32635

export function mulawEncode(sample: number): number {
  let s = Math.round(Math.max(-1, Math.min(1, sample)) * 32767)
  const sign = s < 0 ? 0x80 : 0
  if (s < 0) s = -s
  if (s > CLIP) s = CLIP
  s += BIAS
  let exponent = 7
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--
  const mantissa = (s >> (exponent + 3)) & 0x0f
  return ~(sign | (exponent << 4) | mantissa) & 0xff
}

export function mulawDecode(byte: number): number {
  const u = ~byte & 0xff
  const exponent = (u >> 4) & 0x07
  const mantissa = u & 0x0f
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS
  return ((u & 0x80) !== 0 ? -magnitude : magnitude) / 32768
}

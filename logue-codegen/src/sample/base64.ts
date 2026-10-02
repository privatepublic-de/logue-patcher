// Hand-rolled because this package runs in the renderer (no Buffer) and in main/tests (no
// guaranteed btoa), and must stay dependency-free.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const LOOKUP = new Int16Array(128).fill(-1)
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    const n = (a << 16) | (b << 8) | c
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63]
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? ALPHABET[n & 63] : '='
  }
  return out
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (LOOKUP[clean.charCodeAt(i)] << 18) |
      (LOOKUP[clean.charCodeAt(i + 1)] << 12) |
      ((i + 2 < clean.length ? LOOKUP[clean.charCodeAt(i + 2)] : 0) << 6) |
      (i + 3 < clean.length ? LOOKUP[clean.charCodeAt(i + 3)] : 0)
    if (o < out.length) out[o++] = (n >> 16) & 0xff
    if (o < out.length) out[o++] = (n >> 8) & 0xff
    if (o < out.length) out[o++] = n & 0xff
  }
  return out
}

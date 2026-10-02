/**
 * Standard zlib/IEEE CRC-32 -- the variant the minilogue xd's USER SLOT DATA checksum actually
 * uses (verified against every captured logue-cli upload). Hand-rolled rather than `node:zlib`'s
 * `crc32` so this module also runs in the renderer, where Web MIDI lives.
 */
const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Korg's "7 bit data format conversion" (NOTE 1 of both the minilogue xd and NTS-1 mkII MIDI
 * Implementations): each group of up to 7 data bytes is preceded by one byte whose bit `j` carries
 * bit 7 of the group's byte `j`. A short final group is NOT padded -- confirmed byte-exact against
 * every captured logue-cli upload (`logue-codegen/harness/sysex-emu/PROTOCOL.md`).
 */
export function pack7(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(packedLength(data.length))
  let o = 0
  for (let i = 0; i < data.length; i += 7) {
    const end = Math.min(i + 7, data.length)
    let msbs = 0
    for (let j = i; j < end; j++) if (data[j] & 0x80) msbs |= 1 << (j - i)
    out[o++] = msbs
    for (let j = i; j < end; j++) out[o++] = data[j] & 0x7f
  }
  return out
}

export function unpack7(packed: Uint8Array): Uint8Array {
  const groups = Math.ceil(packed.length / 8)
  const out = new Uint8Array(packed.length - groups)
  let o = 0
  for (let i = 0; i < packed.length; i += 8) {
    const msbs = packed[i]
    const end = Math.min(i + 8, packed.length)
    for (let j = i + 1; j < end; j++) out[o++] = packed[j] | ((msbs >> (j - i - 1)) & 1 ? 0x80 : 0)
  }
  return out
}

export function packedLength(unpackedLength: number): number {
  return unpackedLength + Math.ceil(unpackedLength / 7)
}

/**
 * Minimal reader for an old-gen unit package (`.mnlgxdunit`), which is a plain zip of
 * `<module>/manifest.json` + `<module>/payload.bin`. Hand-rolled (central directory walk +
 * `DecompressionStream('deflate-raw')`) rather than a zip dependency: this package stays
 * dependency-free, and `DecompressionStream` is a web-standard global in both Node and the
 * renderer. Only what a unit package actually uses is supported -- stored or deflated entries, no
 * zip64, no encryption, no multi-disk -- anything else throws rather than guessing.
 */
import type { LogueUnitModule } from './korgUserUnitMessages'

export interface OldGenUnitArchive {
  module: LogueUnitModule
  manifest: OldGenUnitManifest
  payload: Uint8Array
}

/** The `header` object of an old-gen `manifest.json`, as Korg's SDK and `generateOscUnit.ts` write it. */
export interface OldGenUnitManifest {
  header: {
    platform: string
    module: string
    api: string
    dev_id: number
    prg_id: number
    version: string
    name: string
    num_param: number
    /** Absent in effect manifests (Korg's dummy fx templates and this app's). */
    params?: [name: string, min: number, max: number, unit: string][]
  }
}

export class UnitArchiveError extends Error {}

const u16 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8)
const u32 = (b: Uint8Array, o: number): number => (u16(b, o) | (u16(b, o + 2) << 16)) >>> 0

export async function readZipEntries(zip: Uint8Array): Promise<Map<string, Uint8Array>> {
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (u32(zip, i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0)
    throw new UnitArchiveError('Not a zip archive (no end-of-central-directory record).')

  const entryCount = u16(zip, eocd + 10)
  let p = u32(zip, eocd + 16)
  const entries = new Map<string, Uint8Array>()
  for (let n = 0; n < entryCount; n++) {
    if (u32(zip, p) !== 0x02014b50) throw new UnitArchiveError('Corrupt zip central directory.')
    const method = u16(zip, p + 10)
    const compressedSize = u32(zip, p + 20)
    const nameLen = u16(zip, p + 28)
    const localOffset = u32(zip, p + 42)
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + u16(zip, p + 30) + u16(zip, p + 32)
    if (name.endsWith('/')) continue

    // The local header's own name/extra lengths can differ from the central directory's copy.
    const dataStart = localOffset + 30 + u16(zip, localOffset + 26) + u16(zip, localOffset + 28)
    const raw = zip.subarray(dataStart, dataStart + compressedSize)
    if (method === 0) entries.set(name, raw.slice())
    else if (method === 8) entries.set(name, await inflateRaw(raw))
    else throw new UnitArchiveError(`Unsupported zip compression method ${method} for "${name}".`)
  }
  return entries
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const MODULES: readonly LogueUnitModule[] = ['modfx', 'delfx', 'revfx', 'osc']

export async function readOldGenUnitArchive(zip: Uint8Array): Promise<OldGenUnitArchive> {
  const entries = await readZipEntries(zip)
  const manifestPath = [...entries.keys()].find((k) => /^[^/]+\/manifest\.json$/.test(k))
  if (!manifestPath) throw new UnitArchiveError('Unit package has no <module>/manifest.json.')
  // The folder is the Makefile's PROJECT (this app's units: "osc"/"fx"; Korg's templates:
  // "dummy_modfx"), so the module comes from the manifest.
  const dir = manifestPath.split('/')[0]
  const payload = entries.get(`${dir}/payload.bin`)
  if (!payload) throw new UnitArchiveError(`Unit package has no ${dir}/payload.bin.`)
  const manifest = JSON.parse(
    new TextDecoder().decode(entries.get(manifestPath))
  ) as OldGenUnitManifest
  const module = manifest.header?.module as LogueUnitModule
  if (!MODULES.includes(module)) {
    throw new UnitArchiveError(`Unit package's manifest names module "${module}", not a known one.`)
  }
  return { module, manifest, payload }
}

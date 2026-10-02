import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect } from 'vitest'
import {
  backupZip,
  backupZipName,
  describeStoredBody,
  parseBackupIndex,
  planBackup,
  readBackupZip,
  zipStored
} from '../logue-codegen/src/sysex/unitBackup'
import {
  parseLogueSysexReply,
  stripStrayEox
} from '../logue-codegen/src/sysex/korgUserUnitMessages'
import { readOldGenUnitArchive, readZipEntries } from '../logue-codegen/src/sysex/unitArchive'
import {
  buildMinilogueXdUnitBody,
  buildOldGenUnitBody
} from '../logue-codegen/src/sysex/minilogueXdUnitBody'

const FIXTURES = join(__dirname, 'fixtures/logue-sysex/minilogue-xd')

/** The body a REAL minilogue xd returned for osc slot 1 (the user's own `string` unit). */
function realStringBody(): Uint8Array {
  const raw = new Uint8Array(readFileSync(join(FIXTURES, 'real-download-osc-slot1-string.raw')))
  const reply = parseLogueSysexReply('minilogue-xd', stripStrayEox(raw))
  if (reply?.kind !== 'slotData' || !reply.body) throw new Error('fixture no longer parses')
  return reply.body
}

describe('describeStoredBody', () => {
  it('reads the real stored header back into the manifest it was built from', async () => {
    const d = describeStoredBody(realStringBody())
    const original = await readOldGenUnitArchive(
      new Uint8Array(readFileSync(join(FIXTURES, 'string.mnlgxdunit')))
    )
    expect(d.module).toBe('osc')
    expect(d.platform).toBe('minilogue-xd')
    expect(d.manifest).toEqual(original.manifest)
    expect(d.payload).toEqual(original.payload)
  })
})

describe('planBackup', () => {
  const at = new Date('2026-09-25T12:00:00Z')

  it('stores the exact body plus a unit package that re-encodes to it', async () => {
    const body = realStringBody()
    const { files, index } = planBackup('minilogue xd', [{ module: 'osc', slot: 0, body }], at)
    const byName = new Map(files.map((f) => [f.name, f.bytes]))
    expect(byName.get('osc-01-string.body.bin')).toEqual(body)
    const unit = await readOldGenUnitArchive(byName.get('osc-01-string.mnlgxdunit')!)
    expect(buildMinilogueXdUnitBody(unit.manifest, unit.payload)).toEqual(body)
    expect(index.slots[0]).toMatchObject({
      name: 'string',
      platform: 'minilogue-xd',
      unitFile: 'osc-01-string.mnlgxdunit'
    })
    expect(parseBackupIndex(new TextDecoder().decode(byName.get('index.json')))).toEqual(index)
  })

  it('records empty slots, and a prologue-built unit gets a .prlgunit', () => {
    const body = realStringBody().slice()
    body[1] = 1
    const { files, index } = planBackup(
      'minilogue xd',
      [
        { module: 'modfx', slot: 2 },
        { module: 'osc', slot: 14, body }
      ],
      at
    )
    expect(index.slots[0]).toEqual({ module: 'modfx', slot: 2, empty: true })
    expect(index.slots[1].unitFile).toBe('osc-15-string.prlgunit')
    expect(files.map((f) => f.name)).toContain('osc-15-string.prlgunit')
  })

  it("keeps only the .body.bin when the header can't be re-encoded exactly", () => {
    const body = realStringBody().slice()
    body[0x30] = 0x55
    const { files, index } = planBackup('minilogue xd', [{ module: 'osc', slot: 0, body }], at)
    expect(index.slots[0].unitFile).toBeNull()
    expect(index.slots[0].note).toMatch(/restore from the .body.bin/)
    expect(files.map((f) => f.name)).toEqual(['osc-01-string.body.bin', 'index.json'])
  })

  it('rejects an index.json that is not a backup', () => {
    expect(() => parseBackupIndex('{"hello":1}')).toThrow(/isn't a logue-patcher device backup/)
  })
})

describe('buildOldGenUnitBody', () => {
  it('accepts every old-gen platform, rejects an unknown one', async () => {
    const unit = await readOldGenUnitArchive(
      new Uint8Array(readFileSync(join(FIXTURES, 'string.mnlgxdunit')))
    )
    const prologue = { header: { ...unit.manifest.header, platform: 'prologue' } }
    expect(buildOldGenUnitBody(prologue, unit.payload)[1]).toBe(1)
    const bogus = { header: { ...unit.manifest.header, platform: 'nts1mkii' } }
    expect(() => buildOldGenUnitBody(bogus, unit.payload)).toThrow(/Unknown old-gen platform/)
  })
})

describe('zipStored', () => {
  it('round-trips through the unit-archive zip reader', async () => {
    const files = [
      { name: 'a/x.txt', bytes: new TextEncoder().encode('hello') },
      { name: 'a/y.bin', bytes: Uint8Array.from({ length: 300 }, (_, i) => i & 0xff) }
    ]
    const entries = await readZipEntries(zipStored(files))
    expect(entries.get('a/x.txt')).toEqual(files[0].bytes)
    expect(entries.get('a/y.bin')).toEqual(files[1].bytes)
  })
})

describe('backup zip', () => {
  it('is named backup-<local timestamp>.<device>.zip', () => {
    expect(backupZipName('minilogue-xd', new Date(2026, 8, 25, 14, 50, 11))).toBe(
      'backup-20260925-145011.minilogue-xd.zip'
    )
    expect(backupZipName('nts1mkii', new Date(2026, 0, 2, 3, 4, 5))).toBe(
      'backup-20260102-030405.nts1mkii.zip'
    )
  })

  it('round-trips a planned backup: index plus every restore input, byte-identical', async () => {
    const body = realStringBody()
    const { files, index } = planBackup(
      'minilogue xd',
      [
        { module: 'osc', slot: 0, body },
        { module: 'modfx', slot: 2 }
      ],
      new Date('2026-09-25T12:00:00Z')
    )
    const back = await readBackupZip(backupZip(files))
    expect(parseBackupIndex(back.indexJson)).toEqual(index)
    expect(Object.keys(back.bodies)).toEqual(['osc-01-string.body.bin'])
    expect(back.bodies['osc-01-string.body.bin']).toEqual(body)
  })

  it('rejects a zip without an index.json', async () => {
    await expect(
      readBackupZip(zipStored([{ name: 'x.txt', bytes: new Uint8Array(1) }]))
    ).rejects.toThrow(/no index.json/)
  })
})

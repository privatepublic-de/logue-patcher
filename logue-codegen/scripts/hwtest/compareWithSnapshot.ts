/**
 * Read-only: compares the device's slot 1s and current program with a snapshot folder
 * (`deviceState.ts`), e.g. after a run, or to check what a crashed run left behind.
 *
 * Usage: npx tsx logue-codegen/scripts/hwtest/compareWithSnapshot.ts [snapshot dir, default: newest]
 */
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { LogueUnitModule } from '../../src/sysex/korgUserUnitMessages'
import { BACKUP_DIR } from './deviceState'
import { Nts1Rig } from './nts1Rig'

async function main(): Promise<void> {
  const dir =
    process.argv[2] ??
    join(
      BACKUP_DIR,
      readdirSync(BACKUP_DIR)
        .filter((d) => d.startsWith('run-'))
        .sort()
        .pop()!
    )
  const rig = await Nts1Rig.connect()
  try {
    const same = (a: Uint8Array, b: Uint8Array): boolean =>
      a.length === b.length && a.every((v, i) => v === b[i])
    for (const m of ['osc', 'modfx', 'delfx', 'revfx'] as LogueUnitModule[]) {
      const file = join(dir, `${m}-slot1.bin`)
      if (existsSync(file)) {
        const now = await rig.download(m, 0)
        const want = new Uint8Array(readFileSync(file))
        console.log(`${m} slot 1: ${now && same(now, want) ? 'same' : 'DIFFERS'}`)
      } else if (existsSync(join(dir, `${m}-slot1.empty`))) {
        console.log(
          `${m} slot 1: ${(await rig.session.slotStatus(m, 0)).empty ? 'empty, same' : 'DIFFERS (not empty)'}`
        )
      }
    }
    const program = await rig.readProgram()
    const want = new Uint8Array(readFileSync(join(dir, 'program.bin')))
    console.log(`program: ${same(program, want) ? 'same' : 'DIFFERS'}`)
  } finally {
    rig.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

/**
 * Keeps the user's device recoverable around a hardware test. Every run first takes a snapshot of
 * the current program and of slot 1 of each module it will upload to, into its own folder under
 * HWTEST_BACKUP_DIR (default ~/Documents/logue-patches/backups/hwtest/run-<time>), builds its
 * test programs from that snapshot, and `restore`s it at the end -- then reads everything back
 * to confirm. If a slot or the program still holds a test unit (a run that died before
 * restoring), the newest earlier snapshot without one stands in for it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { LogueUnitModule } from '../../src/sysex/korgUserUnitMessages'
import { HWTEST_DEV_ID, type BuiltUnit } from './buildUnit'
import type { LogueRig } from './rig'

export const BACKUP_DIR =
  process.env.HWTEST_BACKUP_DIR ?? join(homedir(), 'Documents/logue-patches/backups/hwtest')

/** TABLE 2 offsets: each module's selection (12 bytes) and name (20). */
export const SELECTION: Record<
  LogueUnitModule,
  { selection: number; name: number; params: number }
> = {
  osc: { selection: 28, name: 40, params: 72 },
  modfx: { selection: 112, name: 124, params: 152 },
  delfx: { selection: 168, name: 180, params: 208 },
  revfx: { selection: 224, name: 236, params: 264 }
}

const PROGRAM_FILE = 'program.bin'
const slotFile = (m: LogueUnitModule): string => `${m}-slot1.bin`
const emptyFile = (m: LogueUnitModule): string => `${m}-slot1.empty`

export interface Snapshot {
  dir: string
  program: Uint8Array
  /** Slot 1's unit file per module, or null for an empty slot. */
  slots: Partial<Record<LogueUnitModule, Uint8Array | null>>
}

/** Test units' names (`calibrateFx.ts`' "HT n", `functional.ts`' "FN n"): the xd's only tell. */
const TEST_UNIT_NAME = /^(HT|FN) /

const selectsTestUnit = (program: Uint8Array): boolean =>
  Object.values(SELECTION).some(
    ({ selection }) =>
      new DataView(program.buffer, program.byteOffset).getUint32(selection, true) === HWTEST_DEV_ID
  )

/** Earlier snapshots, newest first. */
function earlierRuns(except: string): string[] {
  if (!existsSync(BACKUP_DIR)) return []
  return readdirSync(BACKUP_DIR)
    .filter(
      (d) =>
        d.startsWith('run-') &&
        join(BACKUP_DIR, d) !== except &&
        d.endsWith('-xd') === except.endsWith('-xd')
    )
    .sort()
    .reverse()
    .map((d) => join(BACKUP_DIR, d))
}

function fromEarlier(
  dir: string,
  what: string,
  file: string,
  emptyMarker?: string
): Uint8Array | null {
  for (const run of earlierRuns(dir)) {
    if (existsSync(join(run, file))) {
      console.log(`  ${what} holds a test unit: using ${run}'s copy`)
      return new Uint8Array(readFileSync(join(run, file)))
    }
    if (emptyMarker && existsSync(join(run, emptyMarker))) return null
  }
  throw new Error(`${what} holds a test unit and no earlier snapshot has it -- restore it by hand`)
}

export async function takeSnapshot(rig: LogueRig, modules: LogueUnitModule[]): Promise<Snapshot> {
  const d = new Date()
  const two = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
  const dir = join(BACKUP_DIR, rig.platform === 'nts1mkii' ? `run-${stamp}` : `run-${stamp}-xd`)
  mkdirSync(dir, { recursive: true })
  let program = await rig.readProgram()
  // The xd selects units by slot, so its program never names a test unit.
  if (rig.platform === 'nts1mkii' && selectsTestUnit(program)) {
    // Kept for a look: what the device held, which the run won't restore.
    writeFileSync(join(dir, 'program-as-found.bin'), program)
    program = fromEarlier(dir, 'the program', PROGRAM_FILE)!
  }
  writeFileSync(join(dir, PROGRAM_FILE), program)
  const slots: Snapshot['slots'] = {}
  for (const m of modules) {
    const status = await rig.session.slotStatus(m, 0)
    const body =
      !status.empty && (status.devId === HWTEST_DEV_ID || TEST_UNIT_NAME.test(status.name))
        ? fromEarlier(dir, `${m} slot 1`, slotFile(m), emptyFile(m))
        : status.empty
          ? null
          : ((await rig.download(m, 0)) ?? null)
    slots[m] = body
    if (body) writeFileSync(join(dir, slotFile(m)), body)
    else writeFileSync(join(dir, emptyFile(m)), '')
  }
  console.log(`snapshot: ${dir}`)
  return { dir, program, slots }
}

/** A copy of the snapshot's program to build a test program from. */
export const programFrom = (snapshot: Snapshot): Uint8Array => snapshot.program.slice()

const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])

/** Puts the snapshot back, then reads it all back: returns one line per item. */
export async function restore(rig: LogueRig, snapshot: Snapshot): Promise<string[]> {
  const lines: string[] = []
  for (const [m, body] of Object.entries(snapshot.slots) as [
    LogueUnitModule,
    Uint8Array | null
  ][]) {
    if (body) await rig.upload(m, 0, body)
    else await rig.session.clearSlot(m, 0)
    const now = body ? await rig.download(m, 0) : undefined
    const status = body ? undefined : await rig.session.slotStatus(m, 0)
    const ok = body ? !!now && same(now, body) : !!status?.empty
    lines.push(`${m} slot 1 ${body ? 'restored' : 'cleared'}${ok ? ', verified' : ', DIFFERS'}`)
  }
  await rig.writeProgram(snapshot.program)
  const program = await rig.readProgram()
  lines.push(`program restored${same(program, snapshot.program) ? ', verified' : ', DIFFERS'}`)
  return lines
}

/** A factory unit: developer id and version all ones, `index` in the module's type list. */
export const factory = (index: number): Pick<BuiltUnit, 'devId' | 'unitId' | 'version'> => ({
  devId: 0xffffffff,
  unitId: index,
  version: 0xffffffff
})

export function select(
  program: Uint8Array,
  module: LogueUnitModule,
  unit: Pick<BuiltUnit, 'devId' | 'unitId' | 'version'>,
  name = ''
): void {
  const v = new DataView(program.buffer, program.byteOffset)
  const at = SELECTION[module]
  v.setUint32(at.selection, unit.devId, true)
  v.setUint32(at.selection + 4, unit.unitId, true)
  v.setUint32(at.selection + 8, unit.version, true)
  program.fill(0, at.name, at.name + 20)
  program.set(new TextEncoder().encode(name.slice(0, 19)), at.name)
}

/** A menu param, 1-based like the program's PARAM 1..8 (an effect's PARAM 1 is its first row
 *  after TIME/DEPTH(/MIX)). */
export function setParam(
  program: Uint8Array,
  module: LogueUnitModule,
  n: number,
  value: number
): void {
  new DataView(program.buffer, program.byteOffset).setUint16(
    SELECTION[module].params + 2 * (n - 1),
    value & 0xffff,
    true
  )
}

/**
 * NTS-1 mkII: the program's voice section set out of the way of an oscillator test -- filter
 * through (6), EG open (4), no tremolo, the OSC LFO at its centre (512, no modulation; 0 is full
 * negative depth), the three effects off. TABLE 2 offsets, little-endian words.
 */
export function neutralVoice(program: Uint8Array): void {
  const v = new DataView(program.buffer, program.byteOffset)
  v.setUint16(66, 512, true)
  program[88] = 4
  v.setUint16(96, 0, true)
  program[100] = 6
  v.setUint16(108, 512, true)
  for (const m of ['modfx', 'delfx', 'revfx'] as const) select(program, m, factory(0), 'OFF')
}

/**
 * minilogue xd CCs (its MIDI implementation) that take the voice out of the way: the multi engine
 * as USR / USER1, both VCOs silent, the filter open with no resonance, drive or keytrack, EG INT
 * and LFO INT at their centres (64 = 0 %, note P10; LFO INT is bipolar too: 0 is -100 %, which
 * threw the pitch around every 100 ms), no cross mod, ring or sync (127 = off),
 * no portamento or voice-mode depth, the amp EG as a gate (instant attack, full sustain, no
 * release), the three effects off.
 */
export const XD_VOICE: [number, number][] = [
  [53, 127],
  [103, 4],
  [33, 127],
  [39, 0],
  [40, 0],
  [43, 127],
  [44, 0],
  [84, 0],
  [83, 0],
  [22, 64],
  [26, 64],
  [41, 0],
  [81, 127],
  [80, 127],
  [5, 0],
  [27, 0],
  [16, 0],
  [17, 127],
  [18, 127],
  [19, 0],
  [92, 0],
  [93, 0],
  [94, 0]
]

/** Sends `XD_VOICE` after a program write: CCs sent at once 300 ms after the write left the
 *  first case silent; a second's wait and 20 ms between CCs didn't. */
export async function neutralXdVoice(rig: LogueRig): Promise<void> {
  await new Promise((r) => setTimeout(r, 1000))
  for (const [cc, v] of XD_VOICE) {
    rig.cc(cc, v)
    await new Promise((r) => setTimeout(r, 20))
  }
}

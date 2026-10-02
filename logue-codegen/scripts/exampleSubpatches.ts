import { readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { parsePatchFile } from '../../src/shared/json/patchCodec'
import type { PatchDocument } from '../../src/shared/domain/patch'

export const examplesDir = join(
  dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'examples',
  'effects'
)

/**
 * The example folder's own subpatches, as the app finds them for a patch saved there (top level
 * only, `sub/<name>` -- main's `listLocalSubpatches`, which scripts can't import through its path
 * alias).
 */
export function exampleSubpatches(): Map<string, PatchDocument> {
  return new Map(
    readdirSync(examplesDir)
      .filter((f) => f.endsWith('.loguesub'))
      .map((f) => [
        `sub/${f.slice(0, -'.loguesub'.length)}`,
        parsePatchFile(readFileSync(join(examplesDir, f), 'utf-8'))
      ])
  )
}

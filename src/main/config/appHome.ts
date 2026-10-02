import { app } from 'electron'
import { join } from 'node:path'

/** `~/.logue-patcher` -- the one definition; a second copy once silently split config across two paths. */
export function appHomeDir(): string {
  return join(app.getPath('home'), '.logue-patcher')
}

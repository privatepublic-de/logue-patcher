import { randomBytes } from 'node:crypto'

/**
 * A safe, collision-resistant directory/file-name fragment derived from the user's own patch
 * name -- defense in depth (`main/ipc/logueBuild.ts`'s own `make` invocations always pass an
 * argv array, never a shell string, so injection isn't actually reachable either way), and the
 * trailing random suffix means a repeat build of the same patch name never collides with a
 * still-cleaning-up-from-a-previous-run staging directory. No `electron` import (matching
 * `appSettings.ts`'s own convention) so this stays directly unit-testable.
 */
export function deriveStagingName(unitName: string): string {
  const sanitized = unitName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'patch'
  return `logue-patcher-build-${sanitized}-${randomBytes(4).toString('hex')}`
}

/**
 * Plain forward-slash path helpers -- the sandboxed renderer has no Node `path` module, and this
 * app is macOS-only (see CLAUDE.md), so POSIX-only string handling is sufficient; these never
 * touch the filesystem.
 */
export function basenamePath(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

/**
 * Collapses `.`/`..` segments so two path strings referring to the same file (e.g. a direct
 * absolute path vs. one with a `./` segment) compare
 * equal -- `openPath`'s IPC handler echoes back whatever string it's given, unresolved, so callers
 * that need real path identity (tab dedup) must normalize themselves.
 */
export function normalizePath(path: string): string {
  const absolute = path.startsWith('/')
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push(seg)
      continue
    }
    out.push(seg)
  }
  return (absolute ? '/' : '') + out.join('/')
}

/** `/Users/<name>/…` -> `~/…`, display only (no `os.homedir()` in the renderer). */
export function abbreviateHome(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
}

import type { UnresolvedReference } from '@logue-codegen/unresolvedReferences'

/**
 * Plain-language rendering of one `UnresolvedReference` -- shared by ObjectNode.tsx's own canvas
 * badge (a tooltip, one issue per line) and Inspector.tsx's detail list (the same text, one row
 * each), so the two UIs can't describe the same problem two different ways. See
 * `UnresolvedReference`'s own doc comment for what each `kind` means; `'renamed-type'` is the one
 * informational (not broken) case.
 */
export function describeUnresolvedReference(ref: UnresolvedReference): string {
  switch (ref.kind) {
    case 'unrecognized-type':
      return `Type "${ref.rawName}" isn't a recognized *logue primitive -- this node won't export/build.`
    case 'missing-subpatch':
      return `Subpatch "${ref.rawName}" isn't in the subpatch library -- check the library folder in Settings, or whether the file was renamed or moved.`
    case 'renamed-type':
      return `Type "${ref.rawName}" is an old id, still resolved automatically as "${ref.renamedTo}".`
    case 'stale-param':
      return ref.renamedTo
        ? `Param "${ref.rawName}" was renamed to "${ref.renamedTo}", but its value doesn't carry over automatically: ${ref.note}`
        : ref.note
          ? `Param "${ref.rawName}": ${ref.note}`
          : `Param "${ref.rawName}" isn't declared by this primitive any more -- its value is being ignored.`
    case 'stale-inlet':
      return ref.renamedTo
        ? `A wire to inlet "${ref.rawName}" was renamed to "${ref.renamedTo}", but doesn't carry over automatically: ${ref.note}`
        : `A wire to inlet "${ref.rawName}" isn't declared by this primitive any more -- it's not connected to anything.`
    case 'stale-outlet':
      return `A wire from outlet "${ref.rawName}" isn't declared by this node any more -- it carries no signal.`
    case 'instance-problem':
      return ref.note ?? "This node can't export yet."
  }
}

/** The one-line headline for `describeUnresolvedReference`'s text (the Inspector's collapsed row). */
export function summarizeUnresolvedReference(ref: UnresolvedReference): string {
  switch (ref.kind) {
    case 'unrecognized-type':
      return 'Unknown type'
    case 'missing-subpatch':
      return 'Subpatch not found'
    case 'renamed-type':
      return 'Old type id (still works)'
    case 'stale-param':
      return ref.renamedTo
        ? `Param ${ref.rawName} renamed to ${ref.renamedTo}`
        : `Param ${ref.rawName} out of date`
    case 'stale-inlet':
      return ref.renamedTo
        ? `Inlet ${ref.rawName} renamed to ${ref.renamedTo}`
        : `Unknown inlet ${ref.rawName}`
    case 'stale-outlet':
      return `Unknown outlet ${ref.rawName}`
    case 'instance-problem':
      return "Can't export yet"
  }
}

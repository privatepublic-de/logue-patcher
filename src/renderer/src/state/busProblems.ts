import type { ObjNode, PatchDocument } from '@shared/domain/patch'
import { busProblems } from '@logue-codegen/buses'
import { flattenSubpatches } from '@logue-codegen/subpatches'
import type { UnresolvedReference } from '@logue-codegen/unresolvedReferences'
import { subpatchDefinitions } from './subpatchLibraryStore'

/** `busProblems` for the canvas: the document flattened with the saved definitions, so a send
 *  inside a subpatch counts; a document that can't flatten yet is checked on its own nodes. */
export function busProblemsFor(doc: PatchDocument): Map<string, string> {
  let nodes = doc.nodes
  try {
    nodes = flattenSubpatches(doc, subpatchDefinitions()).nodes
  } catch {
    // An unflattenable document already shows its own errors; bus counts are a best effort.
  }
  return busProblems(doc, nodes)
}

/** A bus node's problem as one more issue next to its unresolved references (badge + Inspector). */
export function withBusProblem(
  refs: UnresolvedReference[],
  node: ObjNode,
  problems: Map<string, string>
): UnresolvedReference[] {
  const note = node.name !== undefined ? problems.get(node.name) : undefined
  return note === undefined
    ? refs
    : [...refs, { kind: 'instance-problem', rawName: node.type, note }]
}

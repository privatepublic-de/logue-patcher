import { findLoguePrimitive } from '@logue-codegen/primitives'

/**
 * A primitive drawn as one row -- inlet jack(s), name, type, outlet jack -- instead of a header
 * over a port row: no params and one outlet, so there is no port label, dial or marker to lay out
 * (the polarity converters, `negate`, `abs`, `sample-delay`, ...). Two inlets only for `math/*`
 * and `logic/*` (and/or/xor), whose two operands need no label (the top jack is `a`, which `a−b`
 * names); `sample-hold`'s `in`/`trig` would. A registry primitive only: a subpatch's ports come from a
 * file that can change under it. ObjectNode.tsx, autoArrange.ts and freeSpot.ts all ask this, so
 * the drawn node and the arrange estimates agree.
 */
export function isCompactPrimitive(type: string): boolean {
  if (!type.startsWith('logue/') || type.startsWith('logue/io/')) return false
  const primitive = findLoguePrimitive(type)
  return (
    primitive !== undefined &&
    !primitive.internal &&
    (primitive.params?.length ?? 0) === 0 &&
    ((primitive.inlets?.length ?? 0) <= 1 ||
      (primitive.inlets?.length === 2 && /^logue\/(math|logic)\//.test(primitive.id))) &&
    (primitive.outlets?.length ?? 1) === 1
  )
}

/** The type text in a node's header: the primitive's `shortLabel`, else its id without `logue/`. */
export function headerTypeLabel(type: string): string {
  return findLoguePrimitive(type)?.shortLabel ?? type.replace(/^logue\//, '')
}

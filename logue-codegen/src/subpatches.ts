import type { PatchDocument, ObjNode, Net, NetSource, NetDest } from '../../src/shared/domain/patch'
import type { ParamValue } from '../../src/shared/domain/paramValueTypes'
import {
  findLoguePrimitive,
  findParamSpec,
  presentationKeyOf,
  findSingleWiredSource,
  isBufferInlet,
  outletPolarityOf,
  resolveDeclaredOutletName,
  type LogueInletRole,
  type LoguePrimitive,
  type PrimitiveParamSpec,
  type WirePolarityBucket
} from './primitives'
import { busPseudoPrimitive } from './buses'
import {
  LOGUE_AUDIO_IN_TYPE,
  LOGUE_AUDIO_OUT_TYPE,
  UnsupportedLogueNodeError
} from './oscInstances'

/**
 * Subpatches: a `.loguesub` definition is an ordinary `PatchDocument` (marked
 * `settings.subpatch`) whose `logue/io/inlet`/`logue/io/outlet` nodes declare its ports and whose
 * inner params carrying `ParamValue.subpatchExpose` declare its promoted params. A placed instance
 * is a plain `ObjNode` with `type = 'sub/<path>'` -- never an embedded copy -- so every consumer
 * needs the definitions map passed in; this module stays dependency-free (no fs), the caller
 * decides where definitions come from (main reads saved files for Export/Build, the renderer
 * keeps a watched cache for the canvas).
 *
 * Two entry points, deliberately sharing `subpatchPortNodes`/promotion lookup so canvas and
 * codegen can't disagree about a definition's interface:
 *  - `synthesizeSubpatchPrimitive`: a stand-in `LoguePrimitive` for the canvas/Inspector/Param
 *    Matrix (ports, promoted param specs, polarity) -- never reaches codegen.
 *  - `flattenSubpatches`: splices every instance's inner graph into one flat primitive-only
 *    document before `resolveAudioGraph`, so nothing downstream knows subpatches exist.
 */

export const LOGUE_SUBPATCH_INLET_TYPE = 'logue/io/inlet'
export const LOGUE_SUBPATCH_OUTLET_TYPE = 'logue/io/outlet'
export const SUBPATCH_TYPE_PREFIX = 'sub/'

export const LOGUE_SUBPATCH_INLET_DESCRIPTION =
  "One of this subpatch's inputs -- its name is the inlet's name on every placed instance."
export const LOGUE_SUBPATCH_OUTLET_DESCRIPTION =
  "One of this subpatch's outputs -- its name is the outlet's name on every placed instance."

/** Keyed by the instance `type` string (`sub/<path>`). */
export type SubpatchDefinitions = ReadonlyMap<string, PatchDocument>

export class SubpatchResolutionError extends UnsupportedLogueNodeError {}

export function isSubpatchInstanceType(type: string): boolean {
  return type.startsWith(SUBPATCH_TYPE_PREFIX)
}

export function isSubpatchPortType(type: string): boolean {
  return type === LOGUE_SUBPATCH_INLET_TYPE || type === LOGUE_SUBPATCH_OUTLET_TYPE
}

function isObjOfType(node: PatchDocument['nodes'][number], type: string): node is ObjNode {
  return node.kind === 'obj' && node.type === type && node.name !== undefined
}

/** Top-to-bottom, then left-to-right -- the order a user reads the ports off the canvas. */
function byCanvasPosition(a: ObjNode, b: ObjNode): number {
  return a.y - b.y || a.x - b.x
}

export function subpatchPortNodes(def: PatchDocument): { inlets: ObjNode[]; outlets: ObjNode[] } {
  return {
    inlets: def.nodes
      .filter((n) => isObjOfType(n, LOGUE_SUBPATCH_INLET_TYPE))
      .sort(byCanvasPosition),
    outlets: def.nodes
      .filter((n) => isObjOfType(n, LOGUE_SUBPATCH_OUTLET_TYPE))
      .sort(byCanvasPosition)
  }
}

/**
 * Whether placing `type` inside definition `target` would make `target` contain itself -- lets
 * the palette refuse a placement up front instead of only failing at Export.
 */
export function subpatchContains(defs: SubpatchDefinitions, type: string, target: string): boolean {
  if (type === target) return true
  const def = defs.get(type)
  return def !== undefined && usedSubpatchTypes(def, defs).has(target)
}

/** Every subpatch type `doc` uses, directly or through nested definitions. */
export function usedSubpatchTypes(doc: PatchDocument, defs: SubpatchDefinitions): Set<string> {
  const used = new Set<string>()
  const visit = (current: PatchDocument): void => {
    for (const node of current.nodes) {
      if (node.kind !== 'obj' || !isSubpatchInstanceType(node.type) || used.has(node.type)) continue
      used.add(node.type)
      const def = defs.get(node.type)
      if (def) visit(def)
    }
  }
  visit(doc)
  return used
}

/** `node:PARAM`, the default outer name a freshly promoted param gets. */
export function defaultPromotedParamName(nodeName: string, paramName: string): string {
  return `${nodeName}:${paramName}`
}

// ---- canvas-side stand-in primitive ------------------------------------------------------------

type PrimitiveResolver = (type: string) => LoguePrimitive | undefined

/** The codegen hooks of a canvas-only stand-in: an instance must be flattened away first. */
function codegenStubs(
  type: string
): Pick<LoguePrimitive, 'memberDecls' | 'renderExpr' | 'advanceStatement'> {
  const stub = (): never => {
    throw new SubpatchResolutionError(
      `"${type}" reached codegen unflattened -- flattenSubpatches must run before resolveAudioGraph.`
    )
  }
  return { memberDecls: stub, renderExpr: stub, advanceStatement: stub }
}

function portPseudoPrimitive(
  id: string,
  description: string,
  shape: Pick<LoguePrimitive, 'inlets' | 'outlets'>
): LoguePrimitive {
  return {
    id,
    description,
    ...shape,
    outletPolarity: 'inherit',
    stateBytesPerInstance: 0,
    ...codegenStubs(id)
  }
}

/** Registry-shaped entries for the two port nodes, so the canvas draws their one handle through
 *  the same path as any primitive. What feeds an inlet is only known per placed instance, so
 *  inside the definition its wire colour falls back to the unwired-inherit default (audio). */
const SUBPATCH_INLET_PRIMITIVE = portPseudoPrimitive(
  LOGUE_SUBPATCH_INLET_TYPE,
  LOGUE_SUBPATCH_INLET_DESCRIPTION,
  { inlets: [], outlets: [{ name: 'out' }] }
)
const SUBPATCH_OUTLET_PRIMITIVE = portPseudoPrimitive(
  LOGUE_SUBPATCH_OUTLET_TYPE,
  LOGUE_SUBPATCH_OUTLET_DESCRIPTION,
  { inlets: [{ name: 'in', role: 'audio' }], outlets: [] }
)

/**
 * Resolves a node type against the fixed registry OR the definitions map, recursing for nested
 * subpatches. `stack` guards a definition that (transitively) contains itself: the offending
 * nested type resolves to `undefined`, so the canvas degrades to its wiring-inference fallback
 * instead of recursing forever -- `flattenSubpatches` is what rejects it loudly.
 */
export function createSubpatchAwareResolver(defs: SubpatchDefinitions): PrimitiveResolver {
  const memo = new Map<string, LoguePrimitive | undefined>()
  const stack = new Set<string>()
  const resolve: PrimitiveResolver = (type) => {
    if (type === LOGUE_SUBPATCH_INLET_TYPE) return SUBPATCH_INLET_PRIMITIVE
    if (type === LOGUE_SUBPATCH_OUTLET_TYPE) return SUBPATCH_OUTLET_PRIMITIVE
    const bus = busPseudoPrimitive(type)
    if (bus) return bus
    if (!isSubpatchInstanceType(type)) return findLoguePrimitive(type)
    if (memo.has(type)) return memo.get(type)
    if (stack.has(type)) return undefined
    const def = defs.get(type)
    if (!def) return undefined
    stack.add(type)
    const synthesized = synthesizeSubpatchPrimitive(type, def, resolve)
    stack.delete(type)
    memo.set(type, synthesized)
    return synthesized
  }
  return resolve
}

/** A promoted param's spec as the outer instance sees it -- one entry per `subpatchExpose`. */
interface PromotedParam {
  node: ObjNode
  primitiveId: string
  paramValue: ParamValue
  outerName: string
  innerSpec: PrimitiveParamSpec
}

function findPromotedParams(def: PatchDocument, resolve: PrimitiveResolver): PromotedParam[] {
  const found: PromotedParam[] = []
  for (const node of def.nodes) {
    if (node.kind !== 'obj') continue
    const primitive = resolve(node.type)
    if (!primitive) continue
    for (const paramValue of node.params) {
      if (!paramValue.subpatchExpose) continue
      const innerSpec = findParamSpec(primitive, paramValue.name)
      if (!innerSpec) continue
      found.push({
        node,
        primitiveId: primitive.id,
        paramValue,
        outerName: paramValue.subpatchExpose.outerName,
        innerSpec
      })
    }
  }
  return found
}

type PolarityDeps = { buckets: Set<WirePolarityBucket>; inlets: Set<string> }

/**
 * What a definition's outlet node is actually fed by, for wire colouring: fixed buckets from
 * inner sources, plus which of the definition's own inlets it passes through (via any chain of
 * `'inherit'` primitives). Same inherit rule as `wirePolarity.ts` -- unwired inherit reads as
 * audio -- just stopping at an inlet node instead of resolving it, since what feeds an inlet is
 * only known per placed instance.
 */
function outletPolarityDeps(
  def: PatchDocument,
  outletNode: ObjNode,
  resolve: PrimitiveResolver
): PolarityDeps {
  const typeByName = new Map<string, string>()
  for (const n of def.nodes) if (n.kind === 'obj' && n.name) typeByName.set(n.name, n.type)
  const deps: PolarityDeps = { buckets: new Set(), inlets: new Set() }
  const visiting = new Set<string>()

  const sourceOf = (nodeName: string, inletName: string): NetSource | undefined =>
    findSingleWiredSource(def.nets, nodeName, inletName)

  function walk(source: NetSource): void {
    const type = typeByName.get(source.obj)
    if (type === LOGUE_SUBPATCH_INLET_TYPE) {
      deps.inlets.add(source.obj)
      return
    }
    const primitive = type ? resolve(type) : undefined
    if (!primitive) {
      deps.buckets.add('audio')
      return
    }
    const outlet = resolveDeclaredOutletName(primitive, source.outlet) ?? 'out'
    const key = `${source.obj}\u0000${outlet}`
    if (visiting.has(key)) return
    visiting.add(key)
    const { declared, inheritInlets } = outletPolarityOf(primitive, outlet)
    if (declared !== 'inherit') {
      deps.buckets.add(declared)
      return
    }
    const wired = inheritInlets
      .map((name) => sourceOf(source.obj, name))
      .filter((s): s is NetSource => s !== undefined)
    if (wired.length === 0) deps.buckets.add('audio')
    wired.forEach(walk)
  }

  const fed = sourceOf(outletNode.name!, 'in')
  if (fed) walk(fed)
  return deps
}

/** Intersection of every inner node's platform (or module) support -- a subpatch works only
 *  where all of its contents do. `undefined` = all, matching `LoguePrimitive.platforms`' and
 *  `.modules`' own convention. */
function intersectSupport<T>(
  def: PatchDocument,
  resolve: PrimitiveResolver,
  supportOf: (primitive: LoguePrimitive) => T[] | undefined
): T[] | undefined {
  let supported: T[] | undefined
  for (const node of def.nodes) {
    if (node.kind !== 'obj') continue
    const primitive = resolve(node.type)
    const inner = primitive && supportOf(primitive)
    if (!inner) continue
    supported = supported ? supported.filter((p) => inner.includes(p)) : [...inner]
  }
  return supported
}

/**
 * A `LoguePrimitive`-shaped description of a subpatch's outer interface, so every canvas
 * consumer (`ports.ts`, `wirePolarity.ts`, `ParamDial`, Inspector, Param Matrix) handles an
 * instance through the exact code path it already uses for primitives. Promoted params are
 * `freeLabel` so the Param Matrix offers a per-instance device menu name, defaulting to the outer
 * name. The codegen hooks throw: an instance must be flattened away before codegen ever runs.
 */
export function synthesizeSubpatchPrimitive(
  type: string,
  def: PatchDocument,
  resolve: PrimitiveResolver
): LoguePrimitive {
  const { inlets, outlets } = subpatchPortNodes(def)
  const outletPolarity: Record<string, WirePolarityBucket | 'inherit'> = {}
  const inheritFrom: Record<string, string[]> = {}
  const passedThrough = new Set<string>()
  for (const outlet of outlets) {
    const deps = outletPolarityDeps(def, outlet, resolve)
    if (deps.inlets.size === 0) {
      outletPolarity[outlet.name!] =
        deps.buckets.size === 1
          ? [...deps.buckets][0]
          : deps.buckets.size === 0
            ? 'audio'
            : 'inherit'
      if (deps.buckets.size > 1) inheritFrom[outlet.name!] = []
    } else {
      outletPolarity[outlet.name!] = 'inherit'
      inheritFrom[outlet.name!] = [...deps.inlets]
      deps.inlets.forEach((name) => passedThrough.add(name))
    }
  }

  const params: PrimitiveParamSpec[] = findPromotedParams(def, resolve).map((p) => {
    const authored = Number(p.paramValue.value)
    return {
      name: p.outerName,
      min: p.innerSpec.min,
      max: p.innerSpec.max,
      default: Number.isFinite(authored) ? authored : p.innerSpec.default,
      step: p.innerSpec.step,
      freeLabel: true,
      promotedFrom: presentationKeyOf(p.primitiveId, p.innerSpec),
      setStatement: codegenStubs(type).memberDecls
    }
  })

  // A port wired inside to a buffer inlet takes a buffer wire from outside, so it gets that
  // role: the canvas then refuses a signal into it, as it would on the inner node.
  const nodeTypes = new Map(def.nodes.map((n) => [n.name, (n as ObjNode).type]))
  const feedsBuffer = (portName: string): boolean =>
    def.nets.some(
      (net) =>
        net.sources.some((src) => src.obj === portName) &&
        net.dests.some((d) => {
          const inner = resolve(nodeTypes.get(d.obj) ?? '')
          return inner !== undefined && d.inlet !== undefined && isBufferInlet(inner, d.inlet)
        })
    )
  const role = (name: string): LogueInletRole =>
    feedsBuffer(name) ? 'buffer' : passedThrough.has(name) ? 'audio' : 'control'
  const firstNoteLine = def.notes
    .split('\n')
    .find((line) => line.trim().length > 0)
    ?.trim()
  return {
    id: type,
    description: firstNoteLine ?? `Subpatch "${type.slice(SUBPATCH_TYPE_PREFIX.length)}".`,
    platforms: intersectSupport(def, resolve, (p) => p.platforms),
    modules: intersectSupport(def, resolve, (p) => p.modules),
    inlets: inlets.map((n) => ({ name: n.name!, role: role(n.name!) })),
    outlets: outlets.map((n) => ({ name: n.name! })),
    outletPolarity,
    inheritFrom,
    stateBytesPerInstance: 0,
    params,
    ...codegenStubs(type)
  }
}

// ---- codegen-side flattening -------------------------------------------------------------------

type Endpoint = { obj: string; outlet?: string }

/** One document being flattened: the root, or one placed instance's copy of its definition. */
interface Scope {
  doc: PatchDocument
  path: string[]
  parent?: { scope: Scope; instanceName: string }
  kind: Map<string, 'real' | 'inlet' | 'outlet' | 'sub'>
  flatName: Map<string, string>
  children: Map<string, Scope>
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_')
}

function describeScope(scope: Scope): string {
  return scope.path.length === 0 ? 'the root patch' : `subpatch instance "${scope.path.join('/')}"`
}

/**
 * Splices every `sub/*` instance's inner graph into `root`, returning an equivalent flat document
 * of primitives plus the root's own `logue/io/audio-out` -- the only form `resolveAudioGraph`
 * understands. Pure; a document with no subpatch instances comes back as the same object, so
 * every pre-subpatch export stays byte-identical.
 *
 * Two passes. First every instance (recursively) gets its own copy of its definition's nodes:
 * fresh names (`<instance>_<inner>`, sanitized, deduped against every name already taken -- root
 * names always win), inner menu slots dropped (a definition never owns one; knob bindings stay), and each
 * promoted param overwritten with the instance's own value/slots/label -- which chains through
 * nesting, since a re-promoted param on a nested instance is just another promoted param one
 * level down. Then wires are resolved lazily, one PORT at a time: an inlet/outlet node is looked
 * through to whatever real node ultimately feeds it. Resolving per port rather than per instance
 * is what lets an instance's free-running outlet feed back into one of its own unrelated inlets
 * -- only a chain of port nodes that loops onto itself is a real cycle here; a loop through real
 * nodes is left for `resolveAudioGraph` to report, exactly as for a flat patch.
 *
 * Throws (as `SubpatchResolutionError`, an `UnsupportedLogueNodeError`, so every existing
 * "incomplete graph" handler already catches it) on: a missing definition, a definition that
 * contains itself, more than one source into one port, an unknown outlet, an instance param the
 * definition no longer exposes (renamed or removed -- its value would otherwise silently reset),
 * two promoted params sharing one outer name, `logue/io/audio-out` inside a definition, or port
 * nodes in a root patch.
 */
export function flattenSubpatches(
  root: PatchDocument,
  defs: SubpatchDefinitions,
  // The platform's device menu name limit: a DEFAULTED label (the outer name, often a long
  // generated `node:PARAM`) is cut to fit rather than failing Export; a label the user typed on
  // the instance is never touched, so an over-long one still fails loudly in `oscParams.ts`.
  maxLabelLength?: number
): PatchDocument {
  const hasSubpatchNodes = root.nodes.some(
    (n) => n.kind === 'obj' && (isSubpatchInstanceType(n.type) || isSubpatchPortType(n.type))
  )
  if (!hasSubpatchNodes) return root

  const flatNodes: PatchDocument['nodes'] = []
  const usedNames = new Set<string>()
  for (const node of root.nodes) if (node.name !== undefined) usedNames.add(sanitize(node.name))

  function claimName(wanted: string): string {
    const base = sanitize(wanted)
    let name = base
    for (let n = 2; usedNames.has(name); n++) name = `${base}_${n}`
    usedNames.add(name)
    return name
  }

  function buildScope(
    doc: PatchDocument,
    path: string[],
    overrides: ParamValue[],
    typeStack: string[],
    parent?: Scope['parent']
  ): Scope {
    const isRoot = path.length === 0
    const scope: Scope = {
      doc,
      path,
      parent,
      kind: new Map(),
      flatName: new Map(),
      children: new Map()
    }
    const where = describeScope(scope)
    const overrideByName = new Map(overrides.map((pv) => [pv.name, pv]))

    for (const node of doc.nodes) {
      // Comments mean nothing inside a definition; at the root they pass through so
      // whatever `resolveAudioGraph` already says about them stays unchanged.
      if (node.kind !== 'obj' || node.name === undefined) {
        if (isRoot) flatNodes.push(node)
        continue
      }
      if (isSubpatchPortType(node.type)) {
        if (isRoot) {
          throw new SubpatchResolutionError(
            `"${node.name}" (${node.type}) only means something inside a subpatch definition -- remove it from this patch.`
          )
        }
        scope.kind.set(node.name, node.type === LOGUE_SUBPATCH_INLET_TYPE ? 'inlet' : 'outlet')
        continue
      }
      if (!isRoot && node.type === LOGUE_AUDIO_OUT_TYPE) {
        throw new SubpatchResolutionError(
          `${where} contains "${LOGUE_AUDIO_OUT_TYPE}" -- a subpatch sends audio out through "${LOGUE_SUBPATCH_OUTLET_TYPE}" nodes instead.`
        )
      }
      if (!isRoot && node.type === LOGUE_AUDIO_IN_TYPE) {
        throw new SubpatchResolutionError(
          `${where} contains "${LOGUE_AUDIO_IN_TYPE}" -- a subpatch takes audio in through "${LOGUE_SUBPATCH_INLET_TYPE}" nodes instead.`
        )
      }
      const params = isRoot
        ? node.params
        : applyOverrides(node.params, overrideByName, maxLabelLength)
      if (isSubpatchInstanceType(node.type)) {
        scope.kind.set(node.name, 'sub')
        scope.children.set(node.name, buildChild(node.type, node.name, params, scope, typeStack))
        continue
      }
      scope.kind.set(node.name, 'real')
      const name = isRoot ? node.name : claimName(`${path.join('_')}_${node.name}`)
      scope.flatName.set(node.name, name)
      flatNodes.push(isRoot ? node : { ...node, name, params })
    }
    return scope
  }

  function buildChild(
    type: string,
    instanceName: string,
    params: ParamValue[],
    scope: Scope,
    typeStack: string[]
  ): Scope {
    const instancePath = [...scope.path, instanceName]
    if (typeStack.includes(type)) {
      throw new SubpatchResolutionError(
        `Subpatch "${type}" contains itself (${[...typeStack, type].join(' -> ')}).`
      )
    }
    const def = defs.get(type)
    if (!def) {
      throw new SubpatchResolutionError(
        `"${instancePath.join('/')}" uses subpatch "${type}", which isn't in the subpatch library -- check the library folder in Settings, or whether the file was renamed or moved.`
      )
    }
    const exposed = promotedOuterNames(def, type)
    for (const pv of params) {
      if (!exposed.has(pv.name)) {
        throw new SubpatchResolutionError(
          `"${instancePath.join('/')}" sets "${pv.name}", which subpatch "${type}" no longer exposes (renamed or removed?) -- its value and device slot would be lost. Rename it back in the subpatch, or select the instance and remove the stale value from the Inspector's issue list.`
        )
      }
    }
    return buildScope(def, instancePath, params, [...typeStack, type], {
      scope,
      instanceName
    })
  }

  const rootScope = buildScope(root, [], [], [])

  // Pass 2: resolve every wire's source through any number of port nodes, memoized per port.
  const resolved = new Map<string, Endpoint | undefined>()
  const resolving = new Set<string>()
  let scopeIds = 0
  const scopeId = new Map<Scope, number>()
  const idOf = (scope: Scope): number => {
    if (!scopeId.has(scope)) scopeId.set(scope, scopeIds++)
    return scopeId.get(scope)!
  }

  function singleSource(scope: Scope, nodeName: string, inletName: string): NetSource | undefined {
    const found = new Map<string, NetSource>()
    for (const net of scope.doc.nets) {
      if (!net.dests.some((d) => d.obj === nodeName && d.inlet === inletName)) continue
      for (const s of net.sources) found.set(`${s.obj}\u0000${s.outlet ?? ''}`, s)
    }
    if (found.size > 1) {
      throw new SubpatchResolutionError(
        `"${inletName}" of "${[...scope.path, nodeName].join('/')}" is fed by more than one source -- wire an explicit mixer object instead.`
      )
    }
    return found.size === 1 ? [...found.values()][0] : undefined
  }

  function resolveSource(scope: Scope, source: NetSource): Endpoint | undefined {
    const key = `${idOf(scope)}\u0000${source.obj}\u0000${source.outlet ?? ''}`
    if (resolved.has(key)) return resolved.get(key)
    if (resolving.has(key)) {
      throw new SubpatchResolutionError(
        `A wire in ${describeScope(scope)} loops back onto itself through subpatch ports ("${source.obj}") -- cyclic wiring isn't supported.`
      )
    }
    resolving.add(key)
    const result = resolveUncached(scope, source)
    resolving.delete(key)
    resolved.set(key, result)
    return result
  }

  function resolveUncached(scope: Scope, source: NetSource): Endpoint | undefined {
    switch (scope.kind.get(source.obj)) {
      case 'real':
        return { obj: scope.flatName.get(source.obj)!, outlet: source.outlet }
      case 'inlet': {
        const { scope: outer, instanceName } = scope.parent!
        const feeding = singleSource(outer, instanceName, source.obj)
        return feeding ? resolveSource(outer, feeding) : undefined
      }
      case 'sub': {
        const child = scope.children.get(source.obj)!
        const outlets = subpatchPortNodes(child.doc).outlets.map((n) => ({ name: n.name! }))
        const outlet = resolveDeclaredOutletName({ outlets }, source.outlet)
        if (outlet === undefined || outlets.length === 0) {
          throw new SubpatchResolutionError(
            `A wire in ${describeScope(scope)} reads outlet "${source.outlet}" of subpatch instance "${source.obj}", which its definition doesn't declare (has: ${outlets.map((o) => o.name).join(', ') || 'none'}).`
          )
        }
        const feeding = singleSource(child, outlet, 'in')
        return feeding ? resolveSource(child, feeding) : undefined
      }
      default:
        // A wire from something that doesn't exist: keep it pointing at an unregistered name so
        // `resolveAudioGraph` raises its usual error if -- and only if -- the output reaches it.
        return {
          obj: scope.path.length === 0 ? source.obj : `${scope.path.join('_')}_${source.obj}`,
          outlet: source.outlet
        }
    }
  }

  const flatNets: Net[] = []
  function emitNets(scope: Scope): void {
    // Checked up front for every port, wired onward or not, so a bad definition fails the same
    // way whether or not this particular patch happens to reach the offending port.
    for (const [name, kind] of scope.kind) if (kind === 'outlet') singleSource(scope, name, 'in')
    for (const [name, child] of scope.children) {
      for (const inlet of subpatchPortNodes(child.doc).inlets)
        singleSource(scope, name, inlet.name!)
    }
    for (const net of scope.doc.nets) {
      const dests: NetDest[] = net.dests.flatMap((dest) => {
        const kind = scope.kind.get(dest.obj)
        if (kind === 'real') return [{ obj: scope.flatName.get(dest.obj)!, inlet: dest.inlet }]
        // Root wires into nothing stay as they were; port/instance dests are reached from the
        // other side by `resolveSource`, and a definition's wires into nothing carry no signal.
        if (kind === undefined && scope.path.length === 0) return [dest]
        return []
      })
      if (dests.length === 0) continue
      const sources = net.sources
        .map((s) => resolveSource(scope, s))
        .filter((s): s is Endpoint => s !== undefined)
      if (sources.length > 0) flatNets.push({ sources, dests })
    }
    scope.children.forEach(emitNets)
  }
  emitNets(rootScope)

  return { nodes: flatNodes, nets: flatNets, settings: root.settings, notes: root.notes }
}

/** A definition's promoted outer names -- throws on a duplicate, which would otherwise merge two
 *  unrelated inner params onto one value and one device slot. */
function promotedOuterNames(def: PatchDocument, type: string): Set<string> {
  const names = new Set<string>()
  for (const node of def.nodes) {
    if (node.kind !== 'obj') continue
    for (const pv of node.params) {
      const outerName = pv.subpatchExpose?.outerName
      if (outerName === undefined) continue
      if (names.has(outerName)) {
        throw new SubpatchResolutionError(
          `Subpatch "${type}" exposes two params as "${outerName}" -- give one of them a different name.`
        )
      }
      names.add(outerName)
    }
  }
  return names
}

/**
 * An inner node's params as one placed instance sees them: device slots and slot followers
 * stripped (a definition never owns a menu slot; a fixed-knob binding is kept), and every promoted param replaced by the instance's own value/slots/
 * label for that outer name. The label defaults to the outer name so a promoted param reaches the
 * device menu under the name the user sees on the instance, not the inner primitive's spec name.
 */
function applyOverrides(
  params: ParamValue[],
  overrides: Map<string, ParamValue>,
  maxLabelLength: number | undefined
): ParamValue[] {
  return params.map((pv) => {
    // A knob binding stays: the knob is fixed hardware every instance can share, unlike a menu
    // slot (one owner per unit) or a slot number to follow (meaningful only in the root patch).
    const rest: ParamValue = { ...pv, logueParamIndex: undefined, logueFollow: undefined }
    if (!pv.subpatchExpose) return rest
    const outerName = pv.subpatchExpose.outerName
    const outer = overrides.get(outerName)
    return {
      ...rest,
      value: outer?.value ?? pv.value,
      logueParamIndex: outer?.logueParamIndex,
      logueKnob: outer?.logueKnob,
      logueFollow: outer?.logueFollow,
      label: outer?.label?.trim() || outerName.slice(0, maxLabelLength)
    }
  })
}

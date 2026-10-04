import type { Net, ObjNode, PatchDocument } from '../../src/shared/domain/patch'
import {
  BUS_SEND_GAIN_PARAM,
  findLoguePrimitive,
  type LoguePrimitive,
  type PrimitiveInletSpec,
  type PrimitiveOutletSpec
} from './primitives'
import { UnsupportedLogueNodeError } from './oscInstances'

/**
 * Buses (`docs/PLAN-buses.md`): a send adds its input onto a named bus, a receive reads the bus's
 * sum, and no wire runs between them. One namespace per unit: a send inside a subpatch reaches
 * the root's bus of the same name.
 *
 * The four placed node types are not registry primitives (the subpatch port-node precedent): the
 * canvas gets the pseudo-primitives below through `createSubpatchAwareResolver`, and
 * `resolveBuses` retypes every placed bus node to its internal registry primitive
 * (`logue/mix/bus-*`, `primitives/mix.ts`) and wires the chain, after `flattenSubpatches` and
 * before `resolveAudioGraph`. Nothing downstream knows buses exist.
 */

export const LOGUE_BUS_SEND_TYPE = 'logue/mix/send'
export const LOGUE_BUS_RECEIVE_TYPE = 'logue/mix/receive'
export const LOGUE_BUS_SEND_STEREO_TYPE = 'logue/mix/send-stereo'
export const LOGUE_BUS_RECEIVE_STEREO_TYPE = 'logue/mix/receive-stereo'

export class BusResolutionError extends UnsupportedLogueNodeError {}

interface BusNodeKind {
  role: 'send' | 'receive'
  stereo: boolean
  internalType: string
  /** The internal primitive's chain inlets, one per side, and the outlets they're fed from. */
  chainInlets: string[]
  chainOutlets: string[]
}

const BUS_NODE_KINDS: Record<string, BusNodeKind> = {
  [LOGUE_BUS_SEND_TYPE]: {
    role: 'send',
    stereo: false,
    internalType: 'logue/mix/bus-send',
    chainInlets: ['thru'],
    chainOutlets: ['out']
  },
  [LOGUE_BUS_RECEIVE_TYPE]: {
    role: 'receive',
    stereo: false,
    internalType: 'logue/mix/bus-receive',
    chainInlets: ['bus'],
    chainOutlets: ['out']
  },
  [LOGUE_BUS_SEND_STEREO_TYPE]: {
    role: 'send',
    stereo: true,
    internalType: 'logue/mix/bus-send-stereo',
    chainInlets: ['lThru', 'rThru'],
    chainOutlets: ['l', 'r']
  },
  [LOGUE_BUS_RECEIVE_STEREO_TYPE]: {
    role: 'receive',
    stereo: true,
    internalType: 'logue/mix/bus-receive-stereo',
    chainInlets: ['l', 'r'],
    chainOutlets: ['l', 'r']
  }
}

export function isBusNodeType(type: string): boolean {
  return type in BUS_NODE_KINDS
}

export function busNodeRole(type: string): 'send' | 'receive' | undefined {
  return BUS_NODE_KINDS[type]?.role
}

export function isStereoBusNodeType(type: string): boolean {
  return BUS_NODE_KINDS[type]?.stereo === true
}

/** The outlet(s) a node of `type` can put straight onto a bus (`LoguePrimitive.busOutlets`). */
export function busOutletsOf(type: string): readonly string[] | undefined {
  return findLoguePrimitive(type)?.busOutlets
}

/** A mixer with `bus` set: it sends its own output onto that bus, no send node needed. */
export function sendsDirectToBus(node: PatchDocument['nodes'][number]): node is ObjNode {
  return node.kind === 'obj' && node.bus !== undefined && busOutletsOf(node.type) !== undefined
}

/** A node's part on its bus: a bus node's own role, `'send'` for a mixer sending directly. */
export function busRoleOf(node: PatchDocument['nodes'][number]): 'send' | 'receive' | undefined {
  if (node.kind !== 'obj') return undefined
  return busNodeRole(node.type) ?? (sendsDirectToBus(node) ? 'send' : undefined)
}

/**
 * What a node on a bus needs the bus to be. Anything that SENDS mono -- a mono send node, a mono
 * mixer sending directly -- fits either: on a bus with a stereo node it adds its signal to both
 * sides (user's call, 2026-10-04/05). A mono receive can't read a stereo bus (it would lose a
 * side), so that pair is the one export error left.
 */
export function busKindOf(node: ObjNode): BusKind {
  return busKindOfType(node.type)
}

export type BusKind = 'mono' | 'stereo' | 'either'

/** `busKindOf` by type, for a node about to be placed. */
export function busKindOfType(type: string): BusKind {
  if (type === LOGUE_BUS_SEND_TYPE) return 'either'
  if (isBusNodeType(type)) return isStereoBusNodeType(type) ? 'stereo' : 'mono'
  return busOutletsOf(type)?.length === 2 ? 'stereo' : 'either'
}

/** A bus node's bus name; an unnamed one is the bus `''`. */
export function busNameOf(node: ObjNode): string {
  return node.bus ?? ''
}

function pseudoPrimitive(
  id: string,
  description: string,
  shape: { inlets: PrimitiveInletSpec[]; outlets: PrimitiveOutletSpec[]; withGain: boolean }
): LoguePrimitive {
  const stub = (): never => {
    throw new BusResolutionError(
      `"${id}" reached codegen unresolved -- resolveBuses must run before resolveAudioGraph.`
    )
  }
  return {
    id,
    description,
    inlets: shape.inlets,
    outlets: shape.outlets,
    // The dial shows the internal send's unit (dB) through the presentation key.
    ...(shape.withGain
      ? {
          params: [
            {
              ...BUS_SEND_GAIN_PARAM,
              promotedFrom: { primitiveId: BUS_NODE_KINDS[id].internalType, paramName: 'GAIN' }
            }
          ]
        }
      : {}),
    searchTerms: ['bus', 'aux', 'wireless'],
    outletPolarity: 'inherit',
    stateBytesPerInstance: 0,
    memberDecls: stub,
    renderExpr: stub,
    advanceStatement: stub
  }
}

const BUS_PSEUDO_PRIMITIVES: Record<string, LoguePrimitive> = {
  [LOGUE_BUS_SEND_TYPE]: pseudoPrimitive(
    LOGUE_BUS_SEND_TYPE,
    'Adds its input onto a named bus (at GAIN); every receive of that bus hears the sum of its sends. No wire needed between them, also across subpatches.',
    { inlets: [{ name: 'in', role: 'audio' }], outlets: [], withGain: true }
  ),
  [LOGUE_BUS_RECEIVE_TYPE]: pseudoPrimitive(
    LOGUE_BUS_RECEIVE_TYPE,
    'Reads a named bus: the sum of every send to it, wherever they are in the patch or its subpatches.',
    { inlets: [], outlets: [{ name: 'out' }], withGain: false }
  ),
  [LOGUE_BUS_SEND_STEREO_TYPE]: pseudoPrimitive(
    LOGUE_BUS_SEND_STEREO_TYPE,
    'Adds a stereo pair onto a named stereo bus (at GAIN); every stereo receive of that bus hears the sum of its sends.',
    {
      inlets: [
        { name: 'l', role: 'audio' },
        { name: 'r', role: 'audio' }
      ],
      outlets: [],
      withGain: true
    }
  ),
  [LOGUE_BUS_RECEIVE_STEREO_TYPE]: pseudoPrimitive(
    LOGUE_BUS_RECEIVE_STEREO_TYPE,
    'Reads a named stereo bus: the sum of every stereo send to it.',
    { inlets: [], outlets: [{ name: 'l' }, { name: 'r' }], withGain: false }
  )
}

/** The canvas-side stand-in for a placed bus node (codegen hooks throw). */
export function busPseudoPrimitive(type: string): LoguePrimitive | undefined {
  return BUS_PSEUDO_PRIMITIVES[type]
}

/** Every placed bus node's type, for the palette. */
export const BUS_NODE_TYPES = Object.keys(BUS_NODE_KINDS)

/**
 * Retypes every bus node to its internal primitive and chains each bus: send k's chain inlet(s)
 * <- send k-1's outlet(s), sends ordered by node name so the output is deterministic; every
 * receive <- the last send (none: unwired, so it outputs `0.f`). A document without bus nodes is
 * returned as the same object. Run on a flattened document (`flattenUnit`), so a bus is shared
 * across subpatch instances.
 */
export function resolveBuses(input: PatchDocument): PatchDocument {
  const doc = withDirectSendsExpanded(input)
  const busNodes = doc.nodes.filter((n): n is ObjNode => n.kind === 'obj' && isBusNodeType(n.type))
  if (busNodes.length === 0) return doc

  const byBus = new Map<string, ObjNode[]>()
  for (const node of busNodes) {
    const name = busNameOf(node)
    byBus.set(name, [...(byBus.get(name) ?? []), node])
  }

  const nets: Net[] = [...doc.nets]
  for (const [bus, nodes] of byBus) {
    const stereo = nodes.filter((n) => isStereoBusNodeType(n.type))
    if (stereo.length > 0 && stereo.length < nodes.length) {
      // Mono sends were widened already, so what's left mono is a receive.
      const mono = nodes.filter((n) => !isStereoBusNodeType(n.type))
      throw new BusResolutionError(
        `Bus "${bus}" is stereo, but ${mono.map((n) => `"${n.name}"`).join(', ')} ` +
          `${mono.length === 1 ? 'is a mono receive' : 'are mono receives'}: use a stereo receive (or a mono bus).`
      )
    }
    const sends = nodes
      .filter((n) => busNodeRole(n.type) === 'send')
      // By code unit, not localeCompare: the emitted order mustn't depend on the machine's locale.
      .sort((a, b) =>
        (a.name ?? '') < (b.name ?? '') ? -1 : (a.name ?? '') > (b.name ?? '') ? 1 : 0
      )
    const receives = nodes.filter((n) => busNodeRole(n.type) === 'receive')
    const chain = (from: ObjNode, to: ObjNode): void => {
      const outlets = BUS_NODE_KINDS[from.type].chainOutlets
      const inlets = BUS_NODE_KINDS[to.type].chainInlets
      outlets.forEach((outlet, i) =>
        nets.push({
          sources: [{ obj: from.name!, outlet }],
          dests: [{ obj: to.name!, inlet: inlets[i] }]
        })
      )
    }
    for (let k = 1; k < sends.length; k++) chain(sends[k - 1], sends[k])
    const last = sends[sends.length - 1]
    if (last) for (const receive of receives) chain(last, receive)
  }

  return {
    ...doc,
    nodes: doc.nodes.map((n) =>
      n.kind === 'obj' && isBusNodeType(n.type)
        ? { ...n, type: BUS_NODE_KINDS[n.type].internalType }
        : n
    ),
    nets
  }
}

/**
 * A mixer sending directly becomes a mixer plus a unity send fed from its bus outlet(s), named
 * after it (`<mixer>__bus`), so the chain below sorts it next to its mixer. The mixer keeps its
 * outlets for wires. Bit-identical to placing that send by hand.
 */
function withDirectSendsExpanded(input: PatchDocument): PatchDocument {
  const stereoBuses = new Set(
    busesIn(input.nodes)
      .filter((b) => b.stereo)
      .map((b) => b.name)
  )
  const doc = withMonoSendsWidened(input, stereoBuses)
  const direct = doc.nodes.filter(sendsDirectToBus)
  if (direct.length === 0) return doc
  const taken = new Set(doc.nodes.map((n) => n.name))
  const added: ObjNode[] = []
  const nets: Net[] = [...doc.nets]
  for (const mixer of direct) {
    const own = busOutletsOf(mixer.type)!
    const stereo = own.length === 2 || stereoBuses.has(busNameOf(mixer))
    // A mono mixer on a stereo bus feeds both sides from its one outlet.
    const outlets = stereo && own.length === 1 ? [own[0], own[0]] : own
    let name = `${mixer.name}__bus`
    for (let k = 2; taken.has(name); k++) name = `${mixer.name}__bus${k}`
    taken.add(name)
    added.push({
      kind: 'obj',
      type: stereo ? LOGUE_BUS_SEND_STEREO_TYPE : LOGUE_BUS_SEND_TYPE,
      name,
      x: mixer.x,
      y: mixer.y,
      params: [{ name: 'GAIN', value: String(BUS_SEND_GAIN_PARAM.max) }],
      bus: mixer.bus
    })
    const inlets = stereo ? ['l', 'r'] : ['in']
    outlets.forEach((outlet, i) =>
      nets.push({
        sources: [{ obj: mixer.name!, outlet }],
        dests: [{ obj: name, inlet: inlets[i] }]
      })
    )
  }
  return {
    ...doc,
    nodes: [
      ...doc.nodes.map((n) => {
        if (!sendsDirectToBus(n)) return n
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { bus: _bus, ...rest } = n
        return rest
      }),
      ...added
    ],
    nets
  }
}

/**
 * A mono send node on a stereo bus becomes a stereo send with its input wired to both sides --
 * the same code as a stereo send fed the same signal twice.
 */
function withMonoSendsWidened(doc: PatchDocument, stereoBuses: Set<string>): PatchDocument {
  const widened = new Set(
    doc.nodes
      .filter(
        (n) => n.kind === 'obj' && n.type === LOGUE_BUS_SEND_TYPE && stereoBuses.has(busNameOf(n))
      )
      .map((n) => n.name)
  )
  if (widened.size === 0) return doc
  return {
    ...doc,
    nodes: doc.nodes.map((n) =>
      widened.has(n.name) ? { ...n, type: LOGUE_BUS_SEND_STEREO_TYPE } : n
    ),
    nets: doc.nets.map((net) =>
      net.dests.some((d) => widened.has(d.obj) && d.inlet === 'in')
        ? {
            ...net,
            dests: net.dests.flatMap((d) =>
              widened.has(d.obj) && d.inlet === 'in'
                ? [
                    { ...d, inlet: 'l' },
                    { ...d, inlet: 'r' }
                  ]
                : [d]
            )
          }
        : net
    )
  }
}

/** Appended to a feedback-loop error in a document with buses: a bus closes a loop like a wire. */
export const BUS_LOOP_HINT =
  ' A bus counts as a wire here: a send fed (through any path) from a receive of its own bus closes a loop too.'

/** What one bus in a document holds -- for the canvas (insert presets, warnings, colours). */
export interface BusSummary {
  name: string
  /** Set when a stereo node is on it (mono sends then feed both sides); `mixed` when a mono
   *  receive is too (an export error). */
  stereo: boolean
  mixed: boolean
  sends: ObjNode[]
  receives: ObjNode[]
}

/** Every bus `nodes` use, in order of first appearance. */
export function busesIn(nodes: readonly PatchDocument['nodes'][number][]): BusSummary[] {
  const byName = new Map<string, BusSummary>()
  // A mono send/receive node on it: with a stereo node that's the export error `mixed`.
  const monoFixed = new Map<string, boolean>()
  for (const node of nodes) {
    const role = busRoleOf(node)
    if (role === undefined || node.kind !== 'obj') continue
    const name = busNameOf(node)
    let bus = byName.get(name)
    if (!bus) {
      bus = { name, stereo: false, mixed: false, sends: [], receives: [] }
      byName.set(name, bus)
      monoFixed.set(name, false)
    }
    const kind = busKindOf(node)
    if (kind === 'stereo') bus.stereo = true
    if (kind === 'mono') monoFixed.set(name, true)
    ;(role === 'send' ? bus.sends : bus.receives).push(node)
  }
  for (const bus of byName.values()) bus.mixed = bus.stereo && monoFixed.get(bus.name) === true
  return [...byName.values()]
}

/** A new bus node's name: the last bus it fits in the document (the one being worked on), else
 *  the first free `bus<N>`. */
export function defaultBusName(doc: PatchDocument, kind: BusKind): string {
  const buses = busesIn(doc.nodes)
  const sameKind = buses.filter(
    (b) => !b.mixed && (kind === 'either' || b.stereo === (kind === 'stereo'))
  )
  if (sameKind.length > 0) return sameKind[sameKind.length - 1].name
  const taken = new Set(buses.map((b) => b.name))
  let n = 1
  while (taken.has(`bus${n}`)) n++
  return `bus${n}`
}

/**
 * What's wrong with each bus node of `doc`, by node name. `unitNodes` is every node of the unit
 * (the document flattened, so a send inside a subpatch counts); in a subpatch definition the
 * other end usually lives in the patch using it, so only a mono/stereo clash is reported there.
 */
export function busProblems(
  doc: PatchDocument,
  unitNodes: readonly PatchDocument['nodes'][number][]
): Map<string, string> {
  const problems = new Map<string, string>()
  const buses = new Map(busesIn(unitNodes).map((b) => [b.name, b]))
  const definition = doc.settings.subpatch === true
  for (const node of doc.nodes) {
    const role = busRoleOf(node)
    if (role === undefined || node.kind !== 'obj' || node.name === undefined) continue
    const name = busNameOf(node)
    const shown = name || '(no name)'
    const bus = buses.get(name)
    if (bus?.mixed) {
      // Only a mono receive is wrong there; the rest of the bus is fine.
      if (busKindOf(node) === 'mono') {
        problems.set(
          node.name,
          `Bus "${shown}" is stereo: this mono receive can't read it (use a stereo receive).`
        )
      }
    } else if (definition || !bus) {
      continue
    } else if (role === 'receive' && bus.sends.length === 0) {
      problems.set(node.name, `Nothing sends to bus "${shown}": this receive outputs silence.`)
    } else if (role === 'send' && bus.receives.length === 0) {
      problems.set(
        node.name,
        `Nothing receives bus "${shown}": ${isBusNodeType(node.type) ? "this send isn't heard" : "this mixer's output isn't heard there"}.`
      )
    }
  }
  return problems
}

import type { Net, ObjNode, PatchDocument } from '../../src/shared/domain/patch'
import {
  BUS_SEND_GAIN_PARAM,
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
export function resolveBuses(doc: PatchDocument): PatchDocument {
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
      const mono = nodes.filter((n) => !isStereoBusNodeType(n.type))
      throw new BusResolutionError(
        `Bus "${bus}" has both mono and stereo nodes (mono: ${mono.map((n) => `"${n.name}"`).join(', ')}; ` +
          `stereo: ${stereo.map((n) => `"${n.name}"`).join(', ')}). Use one kind per bus.`
      )
    }
    const sends = nodes
      .filter((n) => busNodeRole(n.type) === 'send')
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
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

/** Appended to a feedback-loop error in a document with buses: a bus closes a loop like a wire. */
export const BUS_LOOP_HINT =
  ' A bus counts as a wire here: a send fed (through any path) from a receive of its own bus closes a loop too.'

/** What one bus in a document holds -- for the canvas (insert presets, warnings, colours). */
export interface BusSummary {
  name: string
  /** Set when every node on it is stereo; `mixed` when both kinds are (an export error). */
  stereo: boolean
  mixed: boolean
  sends: ObjNode[]
  receives: ObjNode[]
}

/** Every bus `nodes` use, in order of first appearance. */
export function busesIn(nodes: readonly PatchDocument['nodes'][number][]): BusSummary[] {
  const byName = new Map<string, BusSummary>()
  for (const node of nodes) {
    if (node.kind !== 'obj' || !isBusNodeType(node.type)) continue
    const name = busNameOf(node)
    const stereo = isStereoBusNodeType(node.type)
    let bus = byName.get(name)
    if (!bus) {
      bus = { name, stereo, mixed: false, sends: [], receives: [] }
      byName.set(name, bus)
    } else if (bus.stereo !== stereo) {
      bus.mixed = true
    }
    ;(busNodeRole(node.type) === 'send' ? bus.sends : bus.receives).push(node)
  }
  return [...byName.values()]
}

/** A new bus node's name: the last bus of its kind in the document (the one being worked on),
 *  else the first free `bus<N>`. */
export function defaultBusName(doc: PatchDocument, stereo: boolean): string {
  const buses = busesIn(doc.nodes)
  const sameKind = buses.filter((b) => !b.mixed && b.stereo === stereo)
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
    if (node.kind !== 'obj' || !isBusNodeType(node.type) || node.name === undefined) continue
    const name = busNameOf(node)
    const shown = name || '(no name)'
    const bus = buses.get(name)
    if (bus?.mixed) {
      problems.set(node.name, `Bus "${shown}" has both mono and stereo nodes, which won't build.`)
    } else if (definition || !bus) {
      continue
    } else if (busNodeRole(node.type) === 'receive' && bus.sends.length === 0) {
      problems.set(node.name, `Nothing sends to bus "${shown}": this receive outputs silence.`)
    } else if (busNodeRole(node.type) === 'send' && bus.receives.length === 0) {
      problems.set(node.name, `Nothing receives bus "${shown}": this send isn't heard.`)
    }
  }
  return problems
}

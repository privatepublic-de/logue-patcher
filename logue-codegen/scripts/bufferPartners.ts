import { isBufferOutlet, type LoguePrimitive, type PrimitiveInletSpec } from '../src/primitives'
import type { Net, ObjNode } from '../../src/shared/domain/patch'

type Endpoint = { obj: string; outlet: string }

/**
 * For a script that builds one primitive alone (the fx sweeps, the code-size measurement): a
 * buffer wire has to end at a buffer port. A writer's `buf` outlet reaches the output through a
 * `util/buffer-tap` (`output`), and a buffer inlet is fed by a `util/buffer` recording `source`
 * (`sourceFor`). Measured code of either primitive therefore includes its partner.
 */
export function bufferPartners(
  p: LoguePrimitive,
  name: string,
  source: Endpoint
): {
  nodes: ObjNode[]
  nets: Net[]
  output: Endpoint
  sourceFor(inlet: PrimitiveInletSpec): Endpoint
} {
  const node = (type: string, n: string): ObjNode => ({
    kind: 'obj',
    type,
    name: n,
    x: 0,
    y: 0,
    params: []
  })
  const wire = (from: Endpoint, to: string, inlet: string): Net => ({
    sources: [from],
    dests: [{ obj: to, inlet }]
  })
  const nodes: ObjNode[] = []
  const nets: Net[] = []
  const firstOutlet = p.outlets?.[0]?.name ?? 'out'
  let output: Endpoint = { obj: name, outlet: firstOutlet }
  if (isBufferOutlet(p, firstOutlet)) {
    const tap = `${name}_tap`
    nodes.push(node('logue/util/buffer-tap', tap))
    nets.push(wire(output, tap, 'buf'))
    output = { obj: tap, outlet: 'out' }
  }
  const writer = `${name}_buf`
  return {
    nodes,
    nets,
    output,
    sourceFor(inlet) {
      if (inlet.role !== 'buffer') return source
      if (!nodes.some((n) => n.name === writer)) {
        nodes.push(node('logue/util/buffer', writer))
        nets.push(wire(source, writer, 'in'))
      }
      return { obj: writer, outlet: 'buf' }
    }
  }
}

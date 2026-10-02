import {
  discoverLogueDevices,
  type DiscoveredDevice,
  type SysexLink
} from '@logue-codegen/sysex/deviceSession'
import { RawSysexAssembler } from '@logue-codegen/sysex/rawSysexAssembler'

/**
 * The renderer's MIDI transport, over the native helper (`window.axoloti.logueMidi`) rather than
 * Web MIDI: a real minilogue xd's long SysEx carries stray F7s that Chromium truncates at, while the
 * helper hands over raw bytes and `RawSysexAssembler` rebuilds whole messages from them.
 */

type Listener = (msg: Uint8Array) => void

const assemblers = new Map<number, RawSysexAssembler>()
const listeners = new Map<number, Set<Listener>>()
let wired = false

function wire(): void {
  if (wired) return
  wired = true
  window.axoloti.events.onLogueMidiData((sourceId, bytes) => {
    let a = assemblers.get(sourceId)
    if (!a) {
      a = new RawSysexAssembler((msg) => listeners.get(sourceId)?.forEach((l) => l(msg)))
      assemblers.set(sourceId, a)
    }
    a.push(bytes)
  })
}

function subscribe(sourceId: number, cb: Listener): () => void {
  wire()
  let set = listeners.get(sourceId)
  if (!set) listeners.set(sourceId, (set = new Set()))
  set.add(cb)
  return () => set.delete(cb)
}

function send(destinationId: number, msg: Uint8Array): void {
  // SysexLink.send is fire-and-forget by design (a lost send surfaces as the session's reply
  // timeout); still log the real reason, since that timeout alone can't say why.
  window.axoloti.logueMidi.send(destinationId, msg).catch((e) => console.error('[midi send]', e))
}

export function linkFor(inputId: string, outputId: string): SysexLink {
  return {
    send: (msg) => send(Number(outputId), msg),
    subscribe: (cb) => subscribe(Number(inputId), cb)
  }
}

export interface FoundDevice extends DiscoveredDevice {
  inputName: string
  outputName: string
}

export async function findLogueDevices(): Promise<FoundDevice[]> {
  wire()
  const { sources, destinations } = await window.axoloti.logueMidi.listPorts()
  await Promise.allSettled(sources.map((s) => window.axoloti.logueMidi.connect(s.id)))
  const found = await discoverLogueDevices(
    destinations.map((d) => ({ id: String(d.id), send: (m: Uint8Array) => send(d.id, m) })),
    sources.map((s) => ({ id: String(s.id), subscribe: (cb: Listener) => subscribe(s.id, cb) }))
  )
  // Discovery has to listen everywhere, but afterwards only a device's own input matters: stop the
  // helper forwarding keyboards, mixers and loopback ports' traffic for the rest of the session.
  const answering = new Set(found.map((d) => d.inputId))
  for (const s of sources) {
    if (answering.has(String(s.id))) continue
    assemblers.delete(s.id)
    void window.axoloti.logueMidi.disconnect(s.id).catch(() => undefined)
  }
  const name = (list: { id: number; name: string }[], id: string): string =>
    list.find((p) => String(p.id) === id)?.name ?? id
  return found.map((d) => ({
    ...d,
    inputName: name(sources, d.inputId),
    outputName: name(destinations, d.outputId)
  }))
}

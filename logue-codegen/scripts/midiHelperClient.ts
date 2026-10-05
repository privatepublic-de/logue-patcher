/**
 * The native MIDI helper (resources/bin/logue-midi-helper, built by `npm run build`) for scripts:
 * spawned directly, spoken to over its JSON-lines protocol, with SysEx reassembled per source.
 */
import { spawn } from 'child_process'
import { dirname, join } from 'path'
import { createInterface } from 'readline'
import type { SysexLink } from '../src/sysex/deviceSession'
import { RawSysexAssembler } from '../src/sysex/rawSysexAssembler'

const here = dirname(new URL(import.meta.url).pathname)
const helperPath = join(here, '..', '..', 'resources', 'bin', 'logue-midi-helper')

/** The helper's line protocol (native/logue-midi-helper/main.swift, main/midi/midiHelper.ts). */
export class Helper {
  private proc = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  private nextId = 1
  private pending = new Map<number, (msg: Record<string, unknown>) => void>()
  private assemblers = new Map<number, RawSysexAssembler>()
  private listeners = new Map<number, Set<(msg: Uint8Array) => void>>()

  constructor() {
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      const msg = JSON.parse(line) as Record<string, unknown>
      if (msg.event === 'data') {
        const source = msg.source as number
        let a = this.assemblers.get(source)
        if (!a) {
          a = new RawSysexAssembler((m) => this.listeners.get(source)?.forEach((l) => l(m)))
          this.assemblers.set(source, a)
        }
        a.push(new Uint8Array(Buffer.from(msg.data as string, 'base64')))
        return
      }
      const done = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined
      if (done) {
        this.pending.delete(msg.id as number)
        done(msg)
      }
    })
  }

  request(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, (reply) =>
        reply.ok ? resolve(reply) : reject(new Error(String(reply.error)))
      )
      this.proc.stdin.write(JSON.stringify({ ...msg, id }) + '\n')
    })
  }

  send(dest: number, bytes: Uint8Array): void {
    void this.request({ cmd: 'send', dest, data: Buffer.from(bytes).toString('base64') }).catch(
      (e) => console.error('send failed:', e)
    )
  }

  subscribe(source: number, cb: (msg: Uint8Array) => void): () => void {
    let set = this.listeners.get(source)
    if (!set) this.listeners.set(source, (set = new Set()))
    set.add(cb)
    return () => set.delete(cb)
  }

  link(input: number, output: number): SysexLink {
    return { send: (m) => this.send(output, m), subscribe: (cb) => this.subscribe(input, cb) }
  }

  close(): void {
    this.proc.stdin.end()
  }
}

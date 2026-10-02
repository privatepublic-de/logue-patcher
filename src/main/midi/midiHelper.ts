import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

export interface MidiPortInfo {
  id: number
  name: string
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Owns the `logue-midi-helper` child process (native/logue-midi-helper/main.swift): raw CoreMIDI,
 * because Chromium's Web MIDI truncates a real minilogue xd's long SysEx at a stray F7 (see
 * PROTOCOL.md). Spawned lazily on first use and respawned after a crash; pending requests of a
 * dead helper are rejected rather than left hanging.
 */
export class MidiHelper {
  private proc: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  /** Sources connected on the CURRENT process -- a respawn starts with none. */
  private connected = new Set<number>()

  constructor(
    private readonly onData: (source: number, bytes: Uint8Array) => void,
    private readonly onSetupChanged: () => void
  ) {}

  static binaryPath(): string {
    // resources/** is asarUnpacked (electron-builder.yml): a packaged app can't exec from inside
    // app.asar, so the real file lives in the sibling app.asar.unpacked tree.
    return join(__dirname, '../../resources/bin/logue-midi-helper').replace(
      /app\.asar([/\\])/,
      'app.asar.unpacked$1'
    )
  }

  async listPorts(): Promise<{ sources: MidiPortInfo[]; destinations: MidiPortInfo[] }> {
    const r = await this.request({ cmd: 'list' })
    return { sources: r.sources as MidiPortInfo[], destinations: r.destinations as MidiPortInfo[] }
  }

  async connect(source: number): Promise<void> {
    this.ensure()
    if (this.connected.has(source)) return
    await this.request({ cmd: 'connect', source })
    this.connected.add(source)
  }

  async disconnect(source: number): Promise<void> {
    if (!this.proc || !this.connected.has(source)) return
    this.connected.delete(source)
    await this.request({ cmd: 'disconnect', source })
  }

  /** Resolves once CoreMIDI has actually finished sending (MIDISendSysex completion for SysEx). */
  async send(dest: number, bytes: Uint8Array): Promise<void> {
    await this.request({ cmd: 'send', dest, data: Buffer.from(bytes).toString('base64') }, 120_000)
  }

  dispose(): void {
    this.proc?.stdin.end()
    this.proc = null
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc
    const proc = spawn(MidiHelper.binaryPath(), [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    this.connected.clear()
    createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line))
    proc.stderr.on('data', (d) => console.error('[logue-midi-helper]', String(d).trim()))
    const fail = (why: string): void => {
      if (this.proc !== proc) return
      this.proc = null
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`MIDI helper ${why}`))
      }
      this.pending.clear()
    }
    proc.on('error', (e) => fail(`failed to start: ${e.message}`))
    proc.on('exit', (code, signal) => fail(`exited (${signal ?? code})`))
    return proc
  }

  private request(
    msg: Record<string, unknown>,
    timeoutMs = 10_000
  ): Promise<Record<string, unknown>> {
    const proc = this.ensure()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MIDI helper didn't answer "${String(msg.cmd)}" within ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      proc.stdin.write(JSON.stringify({ ...msg, id }) + '\n')
    })
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.event === 'data') {
      this.onData(msg.source as number, new Uint8Array(Buffer.from(msg.data as string, 'base64')))
      return
    }
    if (msg.event === 'setup') {
      this.onSetupChanged()
      return
    }
    const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined
    if (!p) return
    this.pending.delete(msg.id as number)
    clearTimeout(p.timer)
    if (msg.ok) p.resolve(msg)
    else p.reject(new Error(String(msg.error ?? 'MIDI helper error')))
  }
}

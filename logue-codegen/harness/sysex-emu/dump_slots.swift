// Read-only probe/dumper for a real *logue device: sends one READ request per slot and saves every
// SysEx reply verbatim, so device->host behavior can be inspected before any code trusts it.
// env FN = 1A (USER SLOT DATA, default) | 19 (SLOT STATUS) | 18 (MODULE INFO) | 17 (API VERSION)
// -- only these read requests exist in this tool, never a write.
// env FAMILY = the device's family-ID byte (hex): 51 minilogue xd (default), 73 NTS-1 mkII.
//   usage: dump_slots <out-port-substring> <in-port-substring> <channel> <module-id> <out-dir> <slot>...
import CoreMIDI
import Foundation

setvbuf(stdout, nil, _IONBF, 0)
let a = CommandLine.arguments
guard a.count >= 7 else {
    print("usage: dump_slots <out-port> <in-port> <channel> <module-id> <out-dir> <slot>...")
    exit(2)
}
let (outName, inName) = (a[1], a[2])
let channel = UInt8(a[3])! & 0x0F
let module = UInt8(a[4])!
let outDir = a[5]
let slots = a[6...].map { UInt8($0)! }
let quietLimit = Double(ProcessInfo.processInfo.environment["QUIET"] ?? "0.7")!
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

func name(_ e: MIDIEndpointRef) -> String {
    var s: Unmanaged<CFString>?
    MIDIObjectGetStringProperty(e, kMIDIPropertyDisplayName, &s)
    return (s?.takeRetainedValue() as String?) ?? ""
}
func find(_ count: Int, _ get: (Int) -> MIDIEndpointRef, _ needle: String) -> MIDIEndpointRef? {
    (0..<count).map(get).first { name($0) == needle } ?? (0..<count).map(get).first { name($0).contains(needle) }
}
guard let dest = find(MIDIGetNumberOfDestinations(), { MIDIGetDestination($0) }, outName),
      let src = find(MIDIGetNumberOfSources(), { MIDIGetSource($0) }, inName) else {
    print("ports not found"); exit(1)
}
print("out: \(name(dest))  in: \(name(src))")

var client = MIDIClientRef(), inPort = MIDIPortRef(), outPort = MIDIPortRef()
MIDIClientCreate("dump_slots" as CFString, nil, nil, &client)
MIDIOutputPortCreate(client, "out" as CFString, &outPort)

let lock = NSLock()
var received: [[UInt8]] = []
var lastRx = Date()
var pending: [UInt8] = []
var trace: [String] = []
var rawStream: [UInt8] = []
let t0 = Date()
let env = ProcessInfo.processInfo.environment
MIDIInputPortCreateWithBlock(client, "in" as CFString, &inPort) { listPtr, _ in
    for packet in listPtr.unsafeSequence() {
        let len = Int(packet.pointee.length)
        let off = MemoryLayout<MIDIPacket>.offset(of: \MIDIPacket.data)!
        let bytes = UnsafeRawBufferPointer(start: UnsafeRawPointer(packet).advanced(by: off), count: len)
        lock.lock()
        if env["TRACE"] != nil {
            let sx = bytes.filter { $0 < 0xF8 }
            if !sx.isEmpty {
                trace.append(String(format: "%.4f", Date().timeIntervalSince(t0)) + " +\(sx.count)" +
                    (sx.contains(0xF0) ? " F0" : "") + (sx.contains(0xF7) ? " F7" : "") +
                    (pending.isEmpty && !sx.contains(0xF0) ? " (outside sysex)" : ""))
            }
        }
        for b in bytes where b < 0xF8 { rawStream.append(b) }
        for b in bytes {
            // Realtime bytes (Active Sensing, clock) arrive constantly and may interleave with
            // SysEx; they must neither join a message nor count as "the line is still busy".
            if b >= 0xF8 { continue }
            lastRx = Date()
            if b == 0xF0 { pending = [b] } else if !pending.isEmpty {
                pending.append(b)
                lastRx = Date()
                if b == 0xF7 { received.append(pending); pending = [] }
            }
        }
        lock.unlock()
    }
}
MIDIPortConnectSource(inPort, src, nil)

func send(_ bytes: [UInt8]) {
    var list = MIDIPacketList()
    let p = MIDIPacketListInit(&list)
    _ = MIDIPacketListAdd(&list, MemoryLayout<MIDIPacketList>.size, p, 0, bytes.count, bytes)
    MIDISend(outPort, dest, &list)
}

for slot in slots {
    lock.lock(); received = []; pending = []; rawStream = []; lastRx = Date(); lock.unlock()
    let fn = UInt8(env["FN"] ?? "1A", radix: 16)!
    guard [0x17, 0x18, 0x19, 0x1A].contains(fn) else { print("FN must be a read request"); exit(2) }
    let family = UInt8(env["FAMILY"] ?? "51", radix: 16)!
    let args: [UInt8] = fn == 0x17 ? [] : fn == 0x18 ? [module] : [module, slot]
    let req: [UInt8] = [0xF0, 0x42, 0x30 | channel, 0x00, 0x01, family, fn] + args + [0xF7]
    send(req)
    let start = Date()
    // Wait for a first reply (up to 5 s), then until the line has been quiet for 700 ms.
    while true {
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        lock.lock(); let n = received.count; let quiet = Date().timeIntervalSince(lastRx); let midMsg = !pending.isEmpty; lock.unlock()
        if n > 0 && quiet > quietLimit && !midMsg { break }
        if n == 0 && Date().timeIntervalSince(start) > 5 { break }
    }
    lock.lock(); let msgs = received; lock.unlock()
    let elapsed = String(format: "%.2f", Date().timeIntervalSince(start))
    print("slot \(slot): \(msgs.count) message(s) in \(elapsed)s: " +
          msgs.map { m in "[\(m.count) B, fn \(String(format: "%02X", m.count > 6 ? m[6] : 0))]" }.joined(separator: " "))
    lock.lock(); let tr = trace; trace = []; lock.unlock()
    if !tr.isEmpty { print("  packets (\(tr.count)): " + tr.prefix(40).joined(separator: " | ")) }
    lock.lock(); let raw = rawStream; lock.unlock()
    FileManager.default.createFile(atPath: "\(outDir)/module\(module)-slot\(slot).raw", contents: Data(raw))
    print("  raw non-realtime bytes: \(raw.count), F0 at \(raw.indices.filter { raw[$0] == 0xF0 }), F7 at \(raw.indices.filter { raw[$0] == 0xF7 })")
    for (k, m) in msgs.enumerated() {
        FileManager.default.createFile(atPath: "\(outDir)/module\(module)-slot\(slot)-\(k).syx", contents: Data(m))
    }
}

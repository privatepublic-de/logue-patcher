// Logging MIDI man-in-the-middle, for capturing what another app (e.g. KORG KONTROL Editor) sends
// a real device -- macOS has no API to sniff another process's MIDI without installing a spy
// driver. It creates two virtual ports that the other app is pointed at MANUALLY, forwards
// everything to/from the real device, and logs every SysEx in both directions, byte-exact.
//
//   usage: midi_proxy <device-out-port> <device-in-port> <logfile>
//   e.g.   midi_proxy "NTS-1 digital kit mkII NTS-1 digital kit _ SOUND" \
//                     "NTS-1 digital kit mkII NTS-1 digital kit _ KBD/KNOB" capture.log
//   Point the app's MIDI OUT at "logue proxy -> device" and its MIDI IN at "logue proxy <- device".
//
// SysEx is forwarded only once complete (and sent with MIDISendSysex, one at a time, in order), so
// a message can never be interleaved or cut by the proxy itself. Everything else passes straight
// through. This tool adds nothing and changes nothing: what the device receives is exactly what the
// app sent.
import CoreMIDI
import Foundation

setvbuf(stdout, nil, _IONBF, 0)
let a = CommandLine.arguments
guard a.count == 4 else { print("usage: midi_proxy <device-out-port> <device-in-port> <logfile>"); exit(2) }
FileManager.default.createFile(atPath: a[3], contents: nil)
let logHandle = FileHandle(forWritingAtPath: a[3])!
let t0 = Date()
let logQueue = DispatchQueue(label: "log")
func log(_ dir: String, _ b: [UInt8]) {
    let t = String(format: "%9.3f", Date().timeIntervalSince(t0))
    let line = "\(t) \(dir) [\(b.count)] " + b.map { String(format: "%02X", $0) }.joined(separator: " ") + "\n"
    logQueue.async { logHandle.write(line.data(using: .utf8)!) }
    let fn = b.count > 6 && b[0] == 0xF0 ? String(format: " fn %02X", b[6]) : ""
    print("\(t) \(dir) [\(b.count)]\(fn)")
}

func displayName(_ e: MIDIEndpointRef) -> String {
    var s: Unmanaged<CFString>?
    MIDIObjectGetStringProperty(e, kMIDIPropertyDisplayName, &s)
    return (s?.takeRetainedValue() as String?) ?? ""
}
guard let deviceOut = (0..<MIDIGetNumberOfDestinations()).map(MIDIGetDestination).first(where: { displayName($0) == a[1] }),
      let deviceIn = (0..<MIDIGetNumberOfSources()).map(MIDIGetSource).first(where: { displayName($0) == a[2] }) else {
    print("device ports not found"); exit(1)
}

var client = MIDIClientRef(), outPort = MIDIPortRef(), inPort = MIDIPortRef()
var proxySource = MIDIEndpointRef(), proxyDest = MIDIEndpointRef()
MIDIClientCreate("logue proxy" as CFString, nil, nil, &client)
MIDIOutputPortCreate(client, "out" as CFString, &outPort)
MIDISourceCreate(client, "logue proxy <- device" as CFString, &proxySource)

func packetList(_ bytes: [UInt8], _ body: (UnsafePointer<MIDIPacketList>) -> Void) {
    let size = bytes.count + 256
    let raw = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 8)
    defer { raw.deallocate() }
    let list = raw.bindMemory(to: MIDIPacketList.self, capacity: 1)
    let p = MIDIPacketListInit(list)
    _ = MIDIPacketListAdd(list, size, p, 0, bytes.count, bytes)
    body(list)
}

// Host -> device SysEx: strictly one MIDISendSysex at a time, in arrival order.
final class SysexSender {
    private let dest: MIDIEndpointRef
    init(dest: MIDIEndpointRef) { self.dest = dest }
    private var queue: [[UInt8]] = []
    private var busy = false
    private var buffer: UnsafeMutablePointer<UInt8>?
    private var request = MIDISysexSendRequest(destination: 0, data: UnsafePointer(bitPattern: 1)!, bytesToSend: 0,
                                               complete: false, reserved: (0, 0, 0), completionProc: { _ in }, completionRefCon: nil)
    func enqueue(_ m: [UInt8]) { DispatchQueue.main.async { self.queue.append(m); self.pump() } }
    private func pump() {
        guard !busy, !queue.isEmpty else { return }
        busy = true
        let m = queue.removeFirst()
        buffer = .allocate(capacity: m.count)
        buffer!.initialize(from: m, count: m.count)
        request = MIDISysexSendRequest(destination: dest, data: UnsafePointer(buffer!), bytesToSend: UInt32(m.count),
                                       complete: false, reserved: (0, 0, 0), completionProc: { req in
            let me = Unmanaged<SysexSender>.fromOpaque(req.pointee.completionRefCon!).takeUnretainedValue()
            DispatchQueue.main.async { me.buffer?.deallocate(); me.buffer = nil; me.busy = false; me.pump() }
        }, completionRefCon: Unmanaged.passUnretained(self).toOpaque())
        let st = MIDISendSysex(&request)
        if st != noErr { print("MIDISendSysex error \(st)"); busy = false }
    }
}
let sender = SysexSender(dest: deviceOut)

/** Splits a stream into complete SysEx messages and pass-through bytes (per direction). */
final class Splitter {
    var sysex: [UInt8]? = nil
    let onSysex: ([UInt8]) -> Void, onOther: ([UInt8]) -> Void
    init(onSysex: @escaping ([UInt8]) -> Void, onOther: @escaping ([UInt8]) -> Void) {
        self.onSysex = onSysex; self.onOther = onOther
    }
    func feed(_ bytes: UnsafeRawBufferPointer) {
        var other: [UInt8] = []
        for b in bytes {
            if b >= 0xF8 { other.append(b); continue }
            if b == 0xF0 { sysex = [b]; continue }
            if var s = sysex {
                s.append(b)
                if b == 0xF7 { sysex = nil; onSysex(s) } else if b & 0x80 != 0 { sysex = nil; other.append(b) } else { sysex = s }
                continue
            }
            other.append(b)
        }
        if !other.isEmpty { onOther(other) }
    }
}

let hostToDevice = Splitter(onSysex: { m in log("HOST>DEV", m); sender.enqueue(m) }, onOther: { bytes in
    packetList(bytes) { MIDISend(outPort, deviceOut, $0) }
})
let deviceToHost = Splitter(onSysex: { m in log("DEV>HOST", m); packetList(m) { MIDIReceived(proxySource, $0) } }, onOther: { bytes in
    packetList(bytes) { MIDIReceived(proxySource, $0) }
})

func eachPacket(_ listPtr: UnsafePointer<MIDIPacketList>, _ body: (UnsafeRawBufferPointer) -> Void) {
    for packet in listPtr.unsafeSequence() {
        let off = MemoryLayout<MIDIPacket>.offset(of: \MIDIPacket.data)!
        body(UnsafeRawBufferPointer(start: UnsafeRawPointer(packet).advanced(by: off), count: Int(packet.pointee.length)))
    }
}
MIDIDestinationCreateWithBlock(client, "logue proxy -> device" as CFString, &proxyDest) { list, _ in
    eachPacket(list) { hostToDevice.feed($0) }
}
MIDIInputPortCreateWithBlock(client, "in" as CFString, &inPort) { list, _ in
    eachPacket(list) { deviceToHost.feed($0) }
}
MIDIPortConnectSource(inPort, deviceIn, nil)
print("proxy up: '\(displayName(deviceOut))' / '\(displayName(deviceIn))', logging to \(a[3])")
signal(SIGINT) { _ in logQueue.sync {}; exit(0) }
RunLoop.main.run()

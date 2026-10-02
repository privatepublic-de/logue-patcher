// Fake minilogue xd on virtual CoreMIDI ports: answers the documented user-unit handshake so
// logue-cli (or the app's own uploader) will talk to it, validates and stores uploads (size +
// CRC-32, NAKing like a real device would), and logs every SysEx in both directions. Everything
// it SENDS is a guess at real-device behavior -- see PROTOCOL.md's confidence levels.
import CoreMIDI
import Foundation

let logPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "capture.log"
FileManager.default.createFile(atPath: logPath, contents: nil)
let logHandle = FileHandle(forWritingAtPath: logPath)!

func hex(_ b: [UInt8]) -> String { b.map { String(format: "%02X", $0) }.joined(separator: " ") }
func log(_ dir: String, _ b: [UInt8]) {
    let line = "\(dir) [\(b.count)] \(hex(b))\n"
    logHandle.write(line.data(using: .utf8)!)
    print(dir, "[\(b.count)]", hex(Array(b.prefix(24))), b.count > 24 ? "..." : "")
}

func pack7(_ data: [UInt8]) -> [UInt8] {
    var out: [UInt8] = []
    var i = 0
    while i < data.count {
        let chunk = Array(data[i..<min(i + 7, data.count)])
        var msb: UInt8 = 0
        for (j, byte) in chunk.enumerated() where byte & 0x80 != 0 { msb |= 1 << j }
        out.append(msb)
        out.append(contentsOf: chunk.map { $0 & 0x7F })
        i += 7
    }
    return out
}
func le32(_ v: UInt32) -> [UInt8] { [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8(v >> 24)] }

var client = MIDIClientRef()
var source = MIDIEndpointRef()
var dest = MIDIEndpointRef()
MIDIClientCreate("logue-emu" as CFString, nil, nil, &client)
MIDISourceCreate(client, "minilogue xd EMU SOUND" as CFString, &source)

func send(_ bytes: [UInt8]) {
    log("<<", bytes)
    let bufSize = bytes.count + 1024
    let raw = UnsafeMutableRawPointer.allocate(byteCount: bufSize, alignment: 8)
    defer { raw.deallocate() }
    let list = raw.bindMemory(to: MIDIPacketList.self, capacity: 1)
    var pkt = MIDIPacketListInit(list)
    pkt = MIDIPacketListAdd(list, bufSize, pkt, 0, bytes.count, bytes)
    MIDIReceived(source, list)
}

func unpack7(_ b: [UInt8]) -> [UInt8] {
    var out: [UInt8] = []
    var i = 0
    while i < b.count {
        let msbs = b[i]
        for j in 1..<min(8, b.count - i) { out.append(b[i + j] | ((msbs >> (j - 1)) & 1 == 1 ? 0x80 : 0)) }
        i += 8
    }
    return out
}
func crc32(_ data: [UInt8]) -> UInt32 {
    var c: UInt32 = 0xFFFFFFFF
    for byte in data {
        c ^= UInt32(byte)
        for _ in 0..<8 { c = c & 1 != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1 }
    }
    return c ^ 0xFFFFFFFF
}
func rd32(_ b: [UInt8], _ o: Int) -> UInt32 { UInt32(b[o]) | UInt32(b[o + 1]) << 8 | UInt32(b[o + 2]) << 16 | UInt32(b[o + 3]) << 24 }

// env CHANNEL=0-15: the device's global MIDI channel (the `3g` header byte; messages for any other
// channel are ignored, like a real device). env NAK=<hex>: answer every upload with that status
// instead of checking it (e.g. NAK=28 for a CRC error).
let env = ProcessInfo.processInfo.environment
let channel = UInt8(env["CHANNEL"].flatMap { Int($0) } ?? 0) & 0x0F
let forcedNak = env["NAK"].flatMap { UInt8($0, radix: 16) }
let hdr: [UInt8] = [0xF0, 0x42, 0x30 | channel, 0x00, 0x01, 0x51]
var slots: [String: [UInt8]] = [:]

func hexEnv(_ name: String) -> [UInt8]? {
    guard let v = env[name] else { return nil }
    return stride(from: 0, to: v.count, by: 2).map { i in
        UInt8(v[v.index(v.startIndex, offsetBy: i)..<v.index(v.startIndex, offsetBy: i + 2)], radix: 16)! }
}

func handle(_ m: [UInt8]) {
    log(">>", m)
    if m.count == 6 && m[1] == 0x7E && m[3] == 0x06 && m[4] == 0x01 {
        send([0xF0, 0x7E, channel, 0x06, 0x02, 0x42, 0x51, 0x01, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0xF7]); return
    }
    if m.count == 6 && m[1] == 0x42 && m[2] == 0x50 && m[3] == 0x00 {
        send([0xF0, 0x42, 0x50, 0x01, channel, m[4], 0x51, 0x01, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0xF7]); return
    }
    guard m.count >= 7, m[1] == 0x42, m[2] == 0x30 | channel, m[3] == 0x00, m[4] == 0x01, m[5] == 0x51 else { return }
    let fn = m[6]
    let args = Array(m[7..<(m.count - 1)])
    switch fn {
    case 0x17:
        send(hdr + [0x47, 0x02, 0x01, 0x02, 0x00, 0xF7])
    case 0x18:
        let module = args.first ?? 0
        let count: UInt8 = (module == 2 || module == 3) ? 8 : 16
        let info = hexEnv("MODINFO") ?? (le32(48 * 1024) + le32(32 * 1024) + [count, 0])
        send(hdr + [0x48, module, 0] + pack7(info) + [0xF7])
    case 0x19:
        // A real header's first 32 bytes ARE Table 6's layout, so a stored upload answers for itself.
        // A real xd answers an empty slot with a bare `49 <module> <slot>` (no data).
        if let status = slots["\(args[0])/\(args[1])"].map({ Array($0.prefix(32)) })
            ?? ((args[0] == 4 && args[1] == 2) ? hexEnv("SLOTSTAT") : nil) {
            send(hdr + [0x49, args[0], args[1], 0] + pack7(status) + [0xF7])
        } else {
            send(hdr + [0x49, args[0], args[1], 0xF7])
        }
    case 0x1A:
        // Mirrors the real xd: `4A <module> <slot> 00 pack7(size, checksum, body)`, bare when empty.
        // (It doesn't reproduce the real device's stray F7s or its unidentified checksum.)
        if let body = slots["\(args[0])/\(args[1])"] {
            send(hdr + [0x4A, args[0], args[1], 0] + pack7(le32(UInt32(body.count)) + le32(crc32(body)) + body) + [0xF7])
        } else {
            send(hdr + [0x4A, args[0], args[1], 0xF7])
        }
    case 0x4A:
        if let code = forcedNak { send(hdr + [code, 0xF7]); return }
        guard args.count > 2 else { send(hdr + [0x26, 0xF7]); return }
        let d = unpack7(Array(args[2...]))
        guard d.count >= 8 else { send(hdr + [0x26, 0xF7]); return }
        let size = Int(rd32(d, 0))
        guard d.count >= 8 + size else { print("upload short: declared \(size), got \(d.count - 8)"); send(hdr + [0x27, 0xF7]); return }
        let body = Array(d[8..<(8 + size)])
        guard crc32(body) == rd32(d, 4) else { print("upload CRC mismatch"); send(hdr + [0x28, 0xF7]); return }
        slots["\(args[0])/\(args[1])"] = body
        print("stored \(size) bytes in module \(args[0]) slot \(args[1])")
        send(hdr + [0x23, 0xF7])
    case 0x1B:
        slots.removeValue(forKey: "\(args[0])/\(args[1])")
        send(hdr + [0x23, 0xF7])
    case 0x1D:
        slots = slots.filter { !$0.key.hasPrefix("\(args[0])/") }
        send(hdr + [0x23, 0xF7])
    case 0x1E:
        let a = "\(args[0])/\(args[1])", b = "\(args[0])/\(args[2])"
        let (va, vb) = (slots[a], slots[b])
        slots[a] = vb; slots[b] = va
        send(hdr + [0x23, 0xF7])
    default:
        send(hdr + [0x26, 0xF7])
    }
}

var pending: [UInt8] = []
MIDIDestinationCreateWithBlock(client, "minilogue xd EMU KBD/KNOB" as CFString, &dest) { listPtr, _ in
    for packet in listPtr.unsafeSequence() {
        let len = Int(packet.pointee.length)
        let off = MemoryLayout<MIDIPacket>.offset(of: \MIDIPacket.data)!
        let full = Array(UnsafeRawBufferPointer(start: UnsafeRawPointer(packet).advanced(by: off), count: len).bindMemory(to: UInt8.self))
        for b in full {
            if b == 0xF0 { pending = [b] }
            else if !pending.isEmpty {
                pending.append(b)
                if b == 0xF7 { let m = pending; pending = []; handle(m) }
            }
        }
    }
}
print("emulator up, logging to \(logPath)")
RunLoop.main.run()

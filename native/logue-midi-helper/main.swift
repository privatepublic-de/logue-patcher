// logue-midi-helper: a deliberately dumb CoreMIDI <-> JSON-lines bridge, spawned by the Electron
// main process (src/main/midi/midiHelper.ts). It exists because a real minilogue xd's USB MIDI
// output inserts stray F7 bytes into long SysEx, and Chromium's Web MIDI truncates at the first
// one (logue-codegen/harness/sysex-emu/PROTOCOL.md). So this passes RAW bytes through and leaves
// every bit of SysEx parsing to tested TypeScript (logue-codegen/src/sysex/rawSysexAssembler.ts).
//
// stdin, one JSON object per line:
//   {"id":1,"cmd":"list"}
//   {"id":2,"cmd":"connect","source":<uniqueID>}     {"id":3,"cmd":"disconnect","source":<uniqueID>}
//   {"id":4,"cmd":"send","dest":<uniqueID>,"data":"<base64>"}
// stdout, one JSON object per line:
//   {"id":n,"ok":true,...} / {"id":n,"ok":false,"error":"..."}  (list adds "sources"/"destinations")
//   {"event":"data","source":<uniqueID>,"data":"<base64>"}      raw bytes, realtime (>= F8) dropped
//   {"event":"setup"}                                             ports appeared/disappeared
import CoreMIDI
import Foundation

let out = DispatchQueue(label: "stdout")
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    out.async {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
}

var client = MIDIClientRef()
var inPort = MIDIPortRef()
var outPort = MIDIPortRef()
MIDIClientCreateWithBlock("logue-midi-helper" as CFString, &client) { notification in
    if notification.pointee.messageID == .msgSetupChanged { emit(["event": "setup"]) }
}
MIDIOutputPortCreate(client, "out" as CFString, &outPort)

func uniqueID(_ e: MIDIEndpointRef) -> Int32 {
    var v: Int32 = 0
    MIDIObjectGetIntegerProperty(e, kMIDIPropertyUniqueID, &v)
    return v
}
func displayName(_ e: MIDIEndpointRef) -> String {
    var s: Unmanaged<CFString>?
    MIDIObjectGetStringProperty(e, kMIDIPropertyDisplayName, &s)
    return (s?.takeRetainedValue() as String?) ?? "?"
}
func endpoints(_ count: Int, _ get: (Int) -> MIDIEndpointRef) -> [MIDIEndpointRef] { (0..<count).map(get) }
func sources() -> [MIDIEndpointRef] { endpoints(MIDIGetNumberOfSources(), MIDIGetSource) }
func destinations() -> [MIDIEndpointRef] { endpoints(MIDIGetNumberOfDestinations(), MIDIGetDestination) }

// The source's uniqueID travels as the connection refCon, so the read block knows who sent what.
MIDIInputPortCreateWithBlock(client, "in" as CFString, &inPort) { listPtr, refCon in
    let source = Int32(truncatingIfNeeded: Int(bitPattern: refCon))
    var bytes: [UInt8] = []
    for packet in listPtr.unsafeSequence() {
        let len = Int(packet.pointee.length)
        let off = MemoryLayout<MIDIPacket>.offset(of: \MIDIPacket.data)!
        let raw = UnsafeRawBufferPointer(start: UnsafeRawPointer(packet).advanced(by: off), count: len)
        bytes.append(contentsOf: raw.filter { $0 < 0xF8 })
    }
    if !bytes.isEmpty { emit(["event": "data", "source": Int(source), "data": Data(bytes).base64EncodedString()]) }
}

/** Keeps a MIDISendSysex request (and its data) alive until CoreMIDI reports completion. */
final class SysexSend {
    let id: Any
    let buffer: UnsafeMutablePointer<UInt8>
    var request: MIDISysexSendRequest
    init(id: Any, dest: MIDIEndpointRef, bytes: [UInt8]) {
        self.id = id
        buffer = .allocate(capacity: bytes.count)
        buffer.initialize(from: bytes, count: bytes.count)
        request = MIDISysexSendRequest(destination: dest, data: UnsafePointer(buffer), bytesToSend: UInt32(bytes.count),
                                       complete: false, reserved: (0, 0, 0), completionProc: { req in
            let box = Unmanaged<SysexSend>.fromOpaque(req.pointee.completionRefCon!).takeRetainedValue()
            emit(["id": box.id, "ok": true])
            box.buffer.deallocate()
        }, completionRefCon: nil)
    }
}

func handle(_ msg: [String: Any]) {
    let id = msg["id"] ?? NSNull()
    func fail(_ e: String) { emit(["id": id, "ok": false, "error": e]) }
    switch msg["cmd"] as? String {
    case "list":
        let describe = { (e: MIDIEndpointRef) in ["id": Int(uniqueID(e)), "name": displayName(e)] as [String: Any] }
        emit(["id": id, "ok": true, "sources": sources().map(describe), "destinations": destinations().map(describe)])
    case "connect", "disconnect":
        guard let sid = msg["source"] as? Int, let src = sources().first(where: { Int(uniqueID($0)) == sid }) else {
            return fail("unknown source")
        }
        let status = msg["cmd"] as? String == "connect"
            ? MIDIPortConnectSource(inPort, src, UnsafeMutableRawPointer(bitPattern: Int(sid)))
            : MIDIPortDisconnectSource(inPort, src)
        status == noErr ? emit(["id": id, "ok": true]) : fail("CoreMIDI error \(status)")
    case "send":
        guard let did = msg["dest"] as? Int, let dest = destinations().first(where: { Int(uniqueID($0)) == did }) else {
            return fail("unknown destination")
        }
        guard let b64 = msg["data"] as? String, let data = Data(base64Encoded: b64), !data.isEmpty else {
            return fail("bad data")
        }
        let bytes = [UInt8](data)
        if bytes[0] == 0xF0 {
            let send = SysexSend(id: id, dest: dest, bytes: bytes)
            send.request.completionRefCon = Unmanaged.passRetained(send).toOpaque()
            let status = MIDISendSysex(&send.request)
            if status != noErr {
                Unmanaged<SysexSend>.fromOpaque(send.request.completionRefCon!).release()
                send.buffer.deallocate()
                fail("CoreMIDI error \(status)")
            }
        } else {
            var list = MIDIPacketList()
            let p = MIDIPacketListInit(&list)
            _ = MIDIPacketListAdd(&list, MemoryLayout<MIDIPacketList>.size, p, 0, bytes.count, bytes)
            let status = MIDISend(outPort, dest, &list)
            status == noErr ? emit(["id": id, "ok": true]) : fail("CoreMIDI error \(status)")
        }
    default:
        fail("unknown cmd")
    }
}

var lineBuffer = Data()
FileHandle.standardInput.readabilityHandler = { h in
    let chunk = h.availableData
    // Parent closed stdin (the app quit): finish queued commands and flush stdout first.
    if chunk.isEmpty {
        h.readabilityHandler = nil
        DispatchQueue.main.async { out.sync {}; exit(0) }
        return
    }
    lineBuffer.append(chunk)
    while let nl = lineBuffer.firstIndex(of: 0x0A) {
        let line = lineBuffer.subdata(in: lineBuffer.startIndex..<nl)
        lineBuffer.removeSubrange(lineBuffer.startIndex...nl)
        if let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] {
            DispatchQueue.main.async { handle(obj) }
        }
    }
}
emit(["event": "ready"])
RunLoop.main.run()

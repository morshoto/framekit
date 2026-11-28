// Test-owned process pair only. Never target Final Cut or an existing application.
import AppKit
import Carbon
import Darwin
import Foundation

let arguments = CommandLine.arguments
if (arguments.count == 2 || (arguments.count == 3 && arguments[2] == "-1701")) && arguments[1] == "listen" {
    let application = NSApplication.shared
    application.setActivationPolicy(.prohibited)
    let receiver = ShareEventReceiver(rejectionCode: arguments.count == 3 ? Int32(-1701) : Int32(errAEEventNotHandled))
    receiver.onRejectedOpen = { event in
        let direct = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))
        let value = direct?.stringValue ?? direct?.atIndex(1)?.fileURLValue?.deletingPathExtension().lastPathComponent ?? "unidentified"
        let sender = event.attributeDescriptor(forKeyword: AEKeyword(keySenderPIDAttr))?.int32Value ?? -1
        let audit = event.attributeDescriptor(forKeyword: AEKeyword(keySenderAuditTokenAttr))?.data
        let auditLength = audit?.count ?? 0
        var token = audit_token_t()
        var auditPID: Int32 = -1
        if let audit, audit.count == MemoryLayout<audit_token_t>.size {
            _ = withUnsafeMutableBytes(of: &token) { audit.copyBytes(to: $0) }
            auditPID = audit_token_to_pid(token)
        }
        print("handled:\(value):\(event.returnID):\(sender):\(auditLength):\(auditPID)"); fflush(stdout)
    }
    DispatchQueue.main.async {
        receiver.register()
        print("ready"); fflush(stdout)
    }
    application.run()
} else if arguments.count >= 4 && ((arguments[1] == "send" && (arguments.count == 4 || (arguments.count == 5 && arguments[4] == "-1701"))) || (arguments[1] == "send-file" && arguments.count == 5)), let target = Int32(arguments[2]), target > 0, ["mock-0", "mock-1", "mock-2"].contains(arguments[3]) {
    // Only send to another copy of this exact freshly built test executable.
    var path = [CChar](repeating: 0, count: 4096)
    let length = proc_pidpath(target, &path, UInt32(path.count))
    let own = URL(fileURLWithPath: arguments[0]).resolvingSymlinksInPath().path
    let targetPath = URL(fileURLWithPath: String(cString: path)).resolvingSymlinksInPath().path
    guard length > 0, targetPath == own, target != getpid() else {
        fputs("target is not the test executable\n", stderr); exit(2)
    }
    let expected = arguments[1] == "send" && arguments.count == 5 ? Int32(-1701) : Int32(errAEEventNotHandled)
    let address = NSAppleEventDescriptor(processIdentifier: target)
    let event = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEOpenDocuments), targetDescriptor: address, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
    if arguments[1] == "send-file" {
        let file = URL(fileURLWithPath: arguments[4]).resolvingSymlinksInPath()
        guard file.deletingLastPathComponent().path == URL(fileURLWithPath: own).deletingLastPathComponent().path,
              file.lastPathComponent == arguments[3] + ".fcpxml" else {
            fputs("file is not a test fixture\n", stderr); exit(2)
        }
        let list = NSAppleEventDescriptor.list()
        list.insert(NSAppleEventDescriptor(fileURL: file), at: 1)
        event.setParam(list, forKeyword: AEKeyword(keyDirectObject))
    } else {
        event.setParam(NSAppleEventDescriptor(string: arguments[3]), forKeyword: AEKeyword(keyDirectObject))
    }
    do {
        let reply = try event.sendEvent(options: [.waitForReply, .neverInteract], timeout: 3)
        guard reply.paramDescriptor(forKeyword: AEKeyword(keyErrorNumber))?.int32Value == expected else {
            fputs("unexpected reply contents\n", stderr); exit(1)
        }
        print("rejected:\(expected)")
    } catch {
        let error = error as NSError
        guard error.code == Int(expected) else { fputs("unexpected send error: \(error.code)\n", stderr); exit(1) }
        print("rejected:\(error.code)")
    }
} else {
    fputs("invalid arguments\n", stderr); exit(2)
}

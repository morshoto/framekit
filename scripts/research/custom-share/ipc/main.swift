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
        let value = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue ?? "unidentified"
        print("handled:\(value):\(event.returnID)"); fflush(stdout)
    }
    DispatchQueue.main.async {
        receiver.register()
        print("ready"); fflush(stdout)
    }
    application.run()
} else if (arguments.count == 4 || (arguments.count == 5 && arguments[4] == "-1701")) && arguments[1] == "send", let target = Int32(arguments[2]), target > 0, ["mock-0", "mock-1", "mock-2"].contains(arguments[3]) {
    // Only send to another copy of this exact freshly built test executable.
    var path = [CChar](repeating: 0, count: 4096)
    let length = proc_pidpath(target, &path, UInt32(path.count))
    let own = URL(fileURLWithPath: arguments[0]).resolvingSymlinksInPath().path
    let targetPath = URL(fileURLWithPath: String(cString: path)).resolvingSymlinksInPath().path
    guard length > 0, targetPath == own, target != getpid() else {
        fputs("target is not the test executable\n", stderr); exit(2)
    }
    let expected = arguments.count == 5 ? Int32(-1701) : Int32(errAEEventNotHandled)
    let address = NSAppleEventDescriptor(processIdentifier: target)
    let event = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEOpenDocuments), targetDescriptor: address, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
    event.setParam(NSAppleEventDescriptor(string: arguments[3]), forKeyword: AEKeyword(keyDirectObject))
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

// Disposable test app. No custom Share capability, file I/O, or Final Cut events.
import Foundation
import AppKit
import Carbon
import Darwin

@objc(MockAsset)
final class MockAsset: NSObject { @objc dynamic let uniqueID = "asset-1" }
@objc(MockMakeCommand)
final class MockMakeCommand: NSScriptCommand {
    override func performDefaultImplementation() -> Any? {
        fputs("MOCK MAKE COMMAND INVOKED\n", stderr)
        return "mock-result"
    }
}
final class Receiver: NSObject {
    @objc func ping(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        let loaded = NSScriptSuiteRegistry.shared().suiteNames.contains { $0 == "Mock Suite" || $0 == "MockSuite" }
        reply.setParam(NSAppleEventDescriptor(string: loaded ? "pong:loaded" : "pong:absent"), forKeyword: AEKeyword(keyDirectObject))
    }
}
let args = CommandLine.arguments
if args.count == 2 && args[1] == "listen" {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    let receiver = Receiver()
    DispatchQueue.main.async {
        NSAppleEventManager.shared().setEventHandler(receiver, andSelector: #selector(Receiver.ping(_:withReplyEvent:)),
            forEventClass: AEEventClass(kCoreEventClass), andEventID: AEEventID(kAEOpenDocuments))
        print("ready"); fflush(stdout)
    }
    withExtendedLifetime(receiver) { app.run() }
} else if args.count == 4 && args[1] == "send", let target = Int32(args[2]), target > 0, ["ping", "make"].contains(args[3]) {
    var path = [CChar](repeating: 0, count: 4096)
    let length = proc_pidpath(target, &path, UInt32(path.count))
    let own = URL(fileURLWithPath: args[0]).resolvingSymlinksInPath().path
    let targetPath = URL(fileURLWithPath: String(cString: path)).resolvingSymlinksInPath().path
    guard length > 0, own == targetPath, target != getpid() else { fputs("target is not the test executable\n", stderr); exit(2) }
    let make = args[3] == "make"
    let event = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass), eventID: make ? AEEventID(0x6372656c) : AEEventID(kAEOpenDocuments),
        targetDescriptor: NSAppleEventDescriptor(processIdentifier: target), returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
    if make { event.setParam(NSAppleEventDescriptor(typeCode: OSType(0x61736574)), forKeyword: AEKeyword(0x6b6f636c)) }
    else { event.setParam(NSAppleEventDescriptor(string: "ping"), forKeyword: AEKeyword(keyDirectObject)) }
    do {
        let reply = try event.sendEvent(options: [.waitForReply, .neverInteract], timeout: 3)
        if !make, let value = reply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue, value.hasPrefix("pong:") { print(value); exit(0) }
        if make, reply.paramDescriptor(forKeyword: AEKeyword(keyErrorNumber))?.int32Value == Int32(errAEEventNotHandled) { print("make-rejected:-1708"); exit(0) }
        fputs("unexpected reply\n", stderr); exit(1)
    } catch {
        if make, (error as NSError).code == Int(errAEEventNotHandled) { print("make-rejected:-1708"); exit(0) }
        fputs("unexpected error: \(error)\n", stderr); exit(1)
    }
} else { fputs("invalid arguments\n", stderr); exit(2) }

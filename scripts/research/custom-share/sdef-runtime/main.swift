// Disposable test app. No custom Share capability, file I/O, or Final Cut events.
import Foundation
import AppKit
import Carbon
import Darwin

@objc(MockAsset)
final class MockAsset: NSObject {
    @objc dynamic let uniqueID = "asset-1"
    @objc dynamic let name = "Synthetic"
}
enum MockStore { static var assets: [MockAsset] = [] }
extension NSApplication {
    @objc dynamic var assets: [MockAsset] { MockStore.assets }
    @objc(valueInAssetsWithUniqueID:) func asset(withID id: String) -> MockAsset? {
        let matches = MockStore.assets.filter { $0.uniqueID == id }
        return matches.count == 1 ? matches[0] : nil
    }
}
@objc(MockMakeCommand)
final class MockMakeCommand: NSScriptCommand {
    override func performDefaultImplementation() -> Any? {
        fputs("MOCK MAKE COMMAND INVOKED\n", stderr)
        guard let description = NSScriptClassDescription(for: NSApplication.self) else {
            scriptErrorNumber = Int(errAEEventNotHandled); return nil
        }
        let asset = MockAsset()
        MockStore.assets.append(asset)
        return NSUniqueIDSpecifier(containerClassDescription: description, containerSpecifier: nil, key: "assets", uniqueID: asset.uniqueID)
    }
}
final class Receiver: NSObject {
    @objc func ping(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        let registry = NSScriptSuiteRegistry.shared()
        let loaded = registry.suiteNames.contains { $0 == "Mock Suite" || $0 == "MockSuite" }
        let command = registry.commandDescription(withAppleEventClass: AEEventClass(0x636f7265), andAppleEventCode: AEEventID(0x6372656c))?.commandClassName ?? "none"
        reply.setParam(NSAppleEventDescriptor(string: "pong:\(loaded ? "loaded" : "absent"):\(command)"), forKeyword: AEKeyword(keyDirectObject))
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
    let event = NSAppleEventDescriptor(eventClass: make ? AEEventClass(0x636f7265) : AEEventClass(kCoreEventClass), eventID: make ? AEEventID(0x6372656c) : AEEventID(kAEOpenDocuments),
        targetDescriptor: NSAppleEventDescriptor(processIdentifier: target), returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
    if make { event.setParam(NSAppleEventDescriptor(typeCode: OSType(0x61736574)), forKeyword: AEKeyword(0x6b6f636c)) }
    else { event.setParam(NSAppleEventDescriptor(string: "ping"), forKeyword: AEKeyword(keyDirectObject)) }
    do {
        let reply = try event.sendEvent(options: [.waitForReply, .neverInteract], timeout: 3)
        if !make, let value = reply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue, value.hasPrefix("pong:") { print(value); exit(0) }
        if make, let result = reply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject)),
           result.descriptorType == DescType(typeObjectSpecifier),
           result.forKeyword(AEKeyword(keyAEDesiredClass))?.typeCodeValue == OSType(0x61736574),
           result.forKeyword(AEKeyword(keyAEKeyForm))?.typeCodeValue == OSType(formUniqueID),
           result.forKeyword(AEKeyword(keyAEKeyData))?.stringValue == "asset-1" {
            let property = NSAppleEventDescriptor.record()
            property.setDescriptor(NSAppleEventDescriptor(typeCode: OSType(typeProperty)), forKeyword: AEKeyword(keyAEDesiredClass))
            property.setDescriptor(NSAppleEventDescriptor(typeCode: OSType(formPropertyID)), forKeyword: AEKeyword(keyAEKeyForm))
            property.setDescriptor(NSAppleEventDescriptor(typeCode: OSType(0x706e616d)), forKeyword: AEKeyword(keyAEKeyData))
            property.setDescriptor(result, forKeyword: AEKeyword(keyAEContainer))
            guard let typed = property.coerce(toDescriptorType: DescType(typeObjectSpecifier)) else { exit(1) }
            let get = NSAppleEventDescriptor(eventClass: AEEventClass(0x636f7265), eventID: AEEventID(0x67657464),
                targetDescriptor: NSAppleEventDescriptor(processIdentifier: target), returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
            get.setParam(typed, forKeyword: AEKeyword(keyDirectObject))
            let getReply = try get.sendEvent(options: [.waitForReply, .neverInteract], timeout: 3)
            guard getReply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue == "Synthetic" else {
                fputs("unexpected get reply: \(getReply)\n", stderr); exit(1)
            }
            let wrong = NSAppleEventDescriptor.record()
            wrong.setDescriptor(NSAppleEventDescriptor(typeCode: OSType(0x61736574)), forKeyword: AEKeyword(keyAEDesiredClass))
            wrong.setDescriptor(NSAppleEventDescriptor(typeCode: OSType(formUniqueID)), forKeyword: AEKeyword(keyAEKeyForm))
            wrong.setDescriptor(NSAppleEventDescriptor(string: "unknown"), forKeyword: AEKeyword(keyAEKeyData))
            guard let parent = result.forKeyword(AEKeyword(keyAEContainer)),
                  let fake = wrong.coerce(toDescriptorType: DescType(typeObjectSpecifier)) else { exit(1) }
            fake.setDescriptor(parent, forKeyword: AEKeyword(keyAEContainer))
            property.setDescriptor(fake, forKeyword: AEKeyword(keyAEContainer))
            guard let invalidProperty = property.coerce(toDescriptorType: DescType(typeObjectSpecifier)) else { exit(1) }
            let invalid = NSAppleEventDescriptor(eventClass: AEEventClass(0x636f7265), eventID: AEEventID(0x67657464),
                targetDescriptor: NSAppleEventDescriptor(processIdentifier: target), returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
            invalid.setParam(invalidProperty, forKeyword: AEKeyword(keyDirectObject))
            var rejected = false
            do {
                let invalidReply = try invalid.sendEvent(options: [.waitForReply, .neverInteract], timeout: 3)
                rejected = invalidReply.paramDescriptor(forKeyword: AEKeyword(keyErrorNumber))?.int32Value == Int32(errAENoSuchObject)
            } catch { rejected = (error as NSError).code == Int(errAENoSuchObject) }
            guard rejected else { fputs("unknown asset did not produce errAENoSuchObject\n", stderr); exit(1) }
            print("make:asset-1:get:Synthetic:unknown-rejected"); exit(0)
        }
        fputs("unexpected reply\n", stderr); exit(1)
    } catch {
        fputs("unexpected error: \(error)\n", stderr); exit(1)
    }
} else { fputs("invalid arguments\n", stderr); exit(2) }

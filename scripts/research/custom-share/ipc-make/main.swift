// Test-only synthetic make receiver. No Final Cut events or file writes.
import AppKit
import Carbon
import Darwin
import Foundation

private let assetType = OSType(0x61736574) // aset
private let objectClass = AEKeyword(0x6b6f636c) // kocl
private let makeEvent = AEEventID(0x6372656c) // crel

final class TestMakeReceiver: NSObject {
    static var active: TestMakeReceiver?
    let containerDescription: NSScriptClassDescription
    override init() {
        let asset = NSScriptClassDescription(suiteName: "Mock IPC", className: "MockAsset", dictionary: ["AppleEventCode": "aset"])!
        NSScriptSuiteRegistry.shared().register(asset)
        containerDescription = NSScriptClassDescription(suiteName: "Mock IPC", className: "application", dictionary: [
            "AppleEventCode": "capp", "ToManyRelationships": ["assets": ["AppleEventCode": "aset", "Type": "MockAsset"]]
        ])!
        super.init()
    }
    @objc func handlePing(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        reply.setParam(NSAppleEventDescriptor(string: "pong"), forKeyword: AEKeyword(keyDirectObject))
    }
    @objc func handleMake(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        fputs("make received\n", stderr)
        guard event.paramDescriptor(forKeyword: objectClass)?.typeCodeValue == assetType else {
            reply.setParam(NSAppleEventDescriptor(int32: Int32(errAEEventNotHandled)), forKeyword: AEKeyword(keyErrorNumber))
            return
        }
        let specifier = NSUniqueIDSpecifier(containerClassDescription: containerDescription,
            containerSpecifier: nil, key: "assets", uniqueID: "test-asset-" + UUID().uuidString.lowercased())
        guard let descriptor = specifier.descriptor else {
            reply.setParam(NSAppleEventDescriptor(int32: Int32(errAEEventNotHandled)), forKeyword: AEKeyword(keyErrorNumber))
            return
        }
        reply.setParam(descriptor, forKeyword: AEKeyword(keyDirectObject))
        fputs("make replied\n", stderr)
    }
}

let args = CommandLine.arguments
if args.count == 2 && args[1] == "listen" {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    let receiver = TestMakeReceiver()
    TestMakeReceiver.active = receiver
    DispatchQueue.main.async {
        NSAppleEventManager.shared().setEventHandler(receiver, andSelector: #selector(TestMakeReceiver.handleMake(_:withReplyEvent:)),
            forEventClass: AEEventClass(kCoreEventClass), andEventID: makeEvent)
        NSAppleEventManager.shared().setEventHandler(receiver, andSelector: #selector(TestMakeReceiver.handlePing(_:withReplyEvent:)),
            forEventClass: AEEventClass(kCoreEventClass), andEventID: AEEventID(kAEOpenDocuments))
        print("ready"); fflush(stdout)
    }
    withExtendedLifetime(receiver) { app.run() }
} else if args.count == 3 && ["ping", "send", "send-invalid"].contains(args[1]), let target = Int32(args[2]), target > 0 {
    var path = [CChar](repeating: 0, count: 4096)
    let length = proc_pidpath(target, &path, UInt32(path.count))
    let own = URL(fileURLWithPath: args[0]).resolvingSymlinksInPath().path
    let targetPath = URL(fileURLWithPath: String(cString: path)).resolvingSymlinksInPath().path
    guard length > 0, targetPath == own, target != getpid() else {
        fputs("target is not the test executable\n", stderr); exit(2)
    }
    let address = NSAppleEventDescriptor(processIdentifier: target)
    let event = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass), eventID: args[1] == "ping" ? AEEventID(kAEOpenDocuments) : makeEvent,
        targetDescriptor: address, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
    if args[1] == "ping" { event.setParam(NSAppleEventDescriptor(string: "ping"), forKeyword: AEKeyword(keyDirectObject)) }
    else { event.setParam(NSAppleEventDescriptor(typeCode: args[1] == "send" ? assetType : OSType(0x62616421)), forKeyword: objectClass) }
    do {
        let response = try event.sendEvent(options: [.waitForReply, .neverInteract], timeout: 3)
        if args[1] == "ping", response.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue == "pong" {
            print("pong"); exit(0)
        }
        if args[1] == "send-invalid", response.paramDescriptor(forKeyword: AEKeyword(keyErrorNumber))?.int32Value == Int32(errAEEventNotHandled) {
            print("invalid rejected"); exit(0)
        }
        guard let result = response.paramDescriptor(forKeyword: AEKeyword(keyDirectObject)),
              result.descriptorType == DescType(typeObjectSpecifier),
              result.forKeyword(AEKeyword(keyAEDesiredClass))?.typeCodeValue == assetType,
              result.forKeyword(AEKeyword(keyAEKeyForm))?.typeCodeValue == OSType(formUniqueID),
              let id = result.forKeyword(AEKeyword(keyAEKeyData))?.stringValue,
              id.hasPrefix("test-asset-"), UUID(uuidString: String(id.dropFirst("test-asset-".count))) != nil else {
            fputs("invalid specifier response\n", stderr); exit(1)
        }
        print("specifier:aset:ID  :\(id)")
    } catch {
        if args[1] == "send-invalid", (error as NSError).code == Int(errAEEventNotHandled) {
            print("invalid rejected"); exit(0)
        }
        fputs("send failed: \(error)\n", stderr); exit(1)
    }
} else { fputs("invalid arguments\n", stderr); exit(2) }

// Test-only synthetic make receiver. No Final Cut events or file writes.
import AppKit
import Carbon
import Darwin
import Foundation

private let assetType = OSType(0x61736574) // aset
private let scriptingClass = AEEventClass(0x636f7265) // core
private let objectClass = AEKeyword(0x6b6f636c) // kocl
private let makeEvent = AEEventID(0x6372656c) // crel
private let getEvent = AEEventID(0x67657464) // getd
private let locationProperty = OSType(0x6c6f636e) // locn
private let propertiesKeyword = AEKeyword(0x70726474) // prdt
private let nameKeyword = AEKeyword(0x706e616d) // pnam
private let locationType = DescType(0x61736c63) // aslc
private let folderKeyword = AEKeyword(0x61736664) // asfd
private let basenameKeyword = AEKeyword(0x6173626e) // asbn
private let descriptionKeyword = AEKeyword(0x61736864) // ashd
private let mediaKeyword = AEKeyword(0x6173686d) // ashm

final class TestMakeReceiver: NSObject {
    static var active: TestMakeReceiver?
    let containerDescription: NSScriptClassDescription
    var issued = [String: String]()
    override init() {
        let asset = NSScriptClassDescription(suiteName: "Mock IPC", className: "MockAsset", dictionary: ["AppleEventCode": "aset"])!
        NSScriptSuiteRegistry.shared().register(asset)
        containerDescription = NSScriptClassDescription(suiteName: "Mock IPC", className: "application", dictionary: [
            "AppleEventCode": "capp", "ToManyRelationships": ["assets": ["AppleEventCode": "aset", "Type": "MockAsset"]]
        ])!
        super.init()
    }
    @objc func handlePing(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        var handler: AEEventHandlerUPP?
        var reference: UnsafeMutableRawPointer?
        let status = AEGetEventHandler(scriptingClass, makeEvent, &handler, &reference, false)
        reply.setParam(NSAppleEventDescriptor(string: "pong:\(status)"), forKeyword: AEKeyword(keyDirectObject))
    }
    @objc func handleMake(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        fputs("make received\n", stderr)
        guard event.paramDescriptor(forKeyword: objectClass)?.typeCodeValue == assetType,
              let name = event.paramDescriptor(forKeyword: propertiesKeyword)?.forKeyword(nameKeyword)?.stringValue,
              name == "Synthetic" else {
            reply.setParam(NSAppleEventDescriptor(int32: Int32(errAEEventNotHandled)), forKeyword: AEKeyword(keyErrorNumber))
            return
        }
        let id = "test-asset-" + UUID().uuidString.lowercased()
        let specifier = NSUniqueIDSpecifier(containerClassDescription: containerDescription,
            containerSpecifier: nil, key: "assets", uniqueID: id)
        guard let descriptor = specifier.descriptor else {
            reply.setParam(NSAppleEventDescriptor(int32: Int32(errAEEventNotHandled)), forKeyword: AEKeyword(keyErrorNumber))
            return
        }
        issued[id] = name
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(TestMakeReceiver.handleGet(_:withReplyEvent:)),
            forEventClass: scriptingClass, andEventID: getEvent)
        reply.setParam(descriptor, forKeyword: AEKeyword(keyDirectObject))
        fputs("make replied\n", stderr)
    }
    @objc func handleGet(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        let property = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))
        let asset = property?.forKeyword(AEKeyword(keyAEContainer))
        guard property?.descriptorType == DescType(typeObjectSpecifier),
              property?.forKeyword(AEKeyword(keyAEDesiredClass))?.typeCodeValue == OSType(typeProperty),
              property?.forKeyword(AEKeyword(keyAEKeyForm))?.typeCodeValue == OSType(formPropertyID),
              property?.forKeyword(AEKeyword(keyAEKeyData))?.typeCodeValue == locationProperty,
              asset?.descriptorType == DescType(typeObjectSpecifier),
              asset?.forKeyword(AEKeyword(keyAEDesiredClass))?.typeCodeValue == assetType,
              asset?.forKeyword(AEKeyword(keyAEKeyForm))?.typeCodeValue == OSType(formUniqueID),
              let id = asset?.forKeyword(AEKeyword(keyAEKeyData))?.stringValue, let name = issued[id] else {
            reply.setParam(NSAppleEventDescriptor(int32: Int32(errAEEventNotHandled)), forKeyword: AEKeyword(keyErrorNumber))
            return
        }
        let location = NSAppleEventDescriptor.record()
        location.setDescriptor(NSAppleEventDescriptor(fileURL: URL(fileURLWithPath: "/synthetic/share-output", isDirectory: true)), forKeyword: folderKeyword)
        location.setDescriptor(NSAppleEventDescriptor(string: name), forKeyword: basenameKeyword)
        location.setDescriptor(NSAppleEventDescriptor(boolean: true), forKeyword: descriptionKeyword)
        location.setDescriptor(NSAppleEventDescriptor(boolean: false), forKeyword: mediaKeyword)
        guard let typed = location.coerce(toDescriptorType: locationType) else {
            reply.setParam(NSAppleEventDescriptor(int32: Int32(errAEEventNotHandled)), forKeyword: AEKeyword(keyErrorNumber)); return
        }
        reply.setParam(typed, forKeyword: AEKeyword(keyDirectObject))
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
            forEventClass: scriptingClass, andEventID: makeEvent)
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
    let event = NSAppleEventDescriptor(eventClass: args[1] == "ping" ? AEEventClass(kCoreEventClass) : scriptingClass, eventID: args[1] == "ping" ? AEEventID(kAEOpenDocuments) : makeEvent,
        targetDescriptor: address, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
    if args[1] == "ping" { event.setParam(NSAppleEventDescriptor(string: "ping"), forKeyword: AEKeyword(keyDirectObject)) }
    else {
        event.setParam(NSAppleEventDescriptor(typeCode: args[1] == "send" ? assetType : OSType(0x62616421)), forKeyword: objectClass)
        let properties = NSAppleEventDescriptor.record()
        properties.setDescriptor(NSAppleEventDescriptor(string: "Synthetic"), forKeyword: nameKeyword)
        event.setParam(properties, forKeyword: propertiesKeyword)
    }
    do {
        let response = try event.sendEvent(options: [.waitForReply, .neverInteract], timeout: 3)
        if args[1] == "ping", let value = response.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue, value.hasPrefix("pong:") {
            print(value); exit(0)
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
        let record = NSAppleEventDescriptor.record()
        record.setDescriptor(NSAppleEventDescriptor(typeCode: OSType(typeProperty)), forKeyword: AEKeyword(keyAEDesiredClass))
        record.setDescriptor(NSAppleEventDescriptor(typeCode: OSType(formPropertyID)), forKeyword: AEKeyword(keyAEKeyForm))
        record.setDescriptor(NSAppleEventDescriptor(typeCode: locationProperty), forKeyword: AEKeyword(keyAEKeyData))
        record.setDescriptor(result, forKeyword: AEKeyword(keyAEContainer))
        guard let property = record.coerce(toDescriptorType: DescType(typeObjectSpecifier)) else {
            fputs("cannot construct property specifier\n", stderr); exit(1)
        }
        let get = NSAppleEventDescriptor(eventClass: scriptingClass, eventID: getEvent,
            targetDescriptor: address, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
        get.setParam(property, forKeyword: AEKeyword(keyDirectObject))
        let getReply = try get.sendEvent(options: [.waitForReply, .neverInteract], timeout: 3)
        let location = getReply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))
        guard location?.descriptorType == locationType,
              location?.forKeyword(folderKeyword)?.fileURLValue?.path == "/synthetic/share-output",
              location?.forKeyword(basenameKeyword)?.stringValue == "Synthetic",
              location?.forKeyword(descriptionKeyword)?.booleanValue == true,
              location?.forKeyword(mediaKeyword)?.booleanValue == false else {
            fputs("invalid property response\n", stderr); exit(1)
        }
        let wrongAsset = NSAppleEventDescriptor.record()
        wrongAsset.setDescriptor(NSAppleEventDescriptor(typeCode: assetType), forKeyword: AEKeyword(keyAEDesiredClass))
        wrongAsset.setDescriptor(NSAppleEventDescriptor(typeCode: OSType(formUniqueID)), forKeyword: AEKeyword(keyAEKeyForm))
        wrongAsset.setDescriptor(NSAppleEventDescriptor(string: "test-asset-00000000-0000-0000-0000-000000000000"), forKeyword: AEKeyword(keyAEKeyData))
        guard let parent = result.forKeyword(AEKeyword(keyAEContainer)),
              let fake = wrongAsset.coerce(toDescriptorType: DescType(typeObjectSpecifier)) else {
            fputs("cannot construct invalid asset specifier\n", stderr); exit(1)
        }
        fake.setDescriptor(parent, forKeyword: AEKeyword(keyAEContainer))
        record.setDescriptor(fake, forKeyword: AEKeyword(keyAEContainer))
        guard let invalidProperty = record.coerce(toDescriptorType: DescType(typeObjectSpecifier)) else { exit(1) }
        let invalidGet = NSAppleEventDescriptor(eventClass: scriptingClass, eventID: getEvent,
            targetDescriptor: address, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
        invalidGet.setParam(invalidProperty, forKeyword: AEKeyword(keyDirectObject))
        var rejected = false
        do {
            let invalidReply = try invalidGet.sendEvent(options: [.waitForReply, .neverInteract], timeout: 3)
            rejected = invalidReply.paramDescriptor(forKeyword: AEKeyword(keyErrorNumber))?.int32Value == Int32(errAEEventNotHandled)
        } catch { rejected = (error as NSError).code == Int(errAEEventNotHandled) }
        guard rejected else { fputs("unknown asset was not rejected\n", stderr); exit(1) }
        print("specifier:aset:ID  :\(id):location:aslc:unknown-rejected")
    } catch {
        if args[1] == "send-invalid", (error as NSError).code == Int(errAEEventNotHandled) {
            print("invalid rejected"); exit(0)
        }
        fputs("send failed: \(error)\n", stderr); exit(1)
    }
} else { fputs("invalid arguments\n", stderr); exit(2) }

// Disposable test app. No custom Share capability, file I/O, or Final Cut events.
import Foundation
import AppKit
import Carbon
import Darwin

let testShareDirectory = ProcessInfo.processInfo.environment["FRAMEKIT_TEST_SHARE_DIR"] ?? "/synthetic/share-output"
func testSharePath(_ name: String) -> String {
    URL(fileURLWithPath: testShareDirectory, isDirectory: true).appendingPathComponent("\(name).fcpxml").path
}

// Test-only conversion for string metadata and the two documented string-list options.
extension NSDictionary {
    @objc(scriptingUserDefinedRecordWithDescriptor:)
    class func testUserRecord(with descriptor: NSAppleEventDescriptor) -> NSDictionary? {
        fputs("MOCK USER RECORD DECODER INVOKED\n", stderr)
        guard descriptor.descriptorType == DescType(typeAERecord),
              let fields = descriptor.forKeyword(AEKeyword(keyASUserRecordFields)),
              fields.descriptorType == DescType(typeAEList), fields.numberOfItems % 2 == 0 else { return nil }
        var values = [String: Any]()
        var index = 1
        while index <= fields.numberOfItems {
            guard let keyDescriptor = fields.atIndex(index), let valueDescriptor = fields.atIndex(index + 1),
                  [DescType(typeUnicodeText), DescType(typeUTF8Text)].contains(keyDescriptor.descriptorType),
                  let key = keyDescriptor.stringValue, !key.isEmpty, values[key] == nil else { return nil }
            if [DescType(typeUnicodeText), DescType(typeUTF8Text)].contains(valueDescriptor.descriptorType), let value = valueDescriptor.stringValue {
                values[key] = value
            } else if ["availableMetadataSets", "availableDescriptionVersions"].contains(key), valueDescriptor.descriptorType == DescType(typeAEList) {
                var list = [String]()
                for itemIndex in 1...Swift.max(valueDescriptor.numberOfItems, 1) {
                    guard itemIndex <= valueDescriptor.numberOfItems, let item = valueDescriptor.atIndex(itemIndex),
                          [DescType(typeUnicodeText), DescType(typeUTF8Text)].contains(item.descriptorType),
                          let value = item.stringValue, !value.isEmpty, !list.contains(value) else { return nil }
                    list.append(value)
                }
                values[key] = list
            } else { return nil }
            index += 2
        }
        return values as NSDictionary
    }
    @objc(scriptingUserDefinedRecordDescriptor)
    func testUserRecordDescriptor() -> NSAppleEventDescriptor? {
        guard let values = self as? [String: String] else { return nil }
        let record = NSAppleEventDescriptor.record()
        let fields = NSAppleEventDescriptor.list()
        var index = 1
        for key in values.keys.sorted() {
            fields.insert(NSAppleEventDescriptor(string: key), at: index)
            fields.insert(NSAppleEventDescriptor(string: values[key]!), at: index + 1)
            index += 2
        }
        record.setDescriptor(fields, forKeyword: AEKeyword(keyASUserRecordFields))
        return record
    }
}

@objc(MockAsset)
final class MockAsset: NSObject {
    @objc dynamic let uniqueID: String
    @objc dynamic let name: String
    @objc dynamic let metadata: NSDictionary
    @objc dynamic let dataOptions: NSDictionary
    init(id: String, name: String, metadata: [String: String], options: [String: String]) {
        self.uniqueID = id; self.name = name; self.metadata = metadata as NSDictionary; self.dataOptions = options as NSDictionary
    }
    @objc dynamic var locationInfo: NSDictionary {
        ["folder": URL(fileURLWithPath: testShareDirectory, isDirectory: true),
         "basename": name, "hasDescription": true, "hasMedia": false]
    }
}
enum MockStore { static var assets: [MockAsset] = [] }
extension NSApplication {
    @objc dynamic var assets: [MockAsset] { MockStore.assets }
    @objc(valueInAssetsWithUniqueID:) func asset(withID id: String) -> MockAsset? {
        if let receiver = Receiver.active, ProcessInfo.processInfo.environment["FRAMEKIT_TEST_USE_DELEGATE"] != "1" {
            Receiver.reportRegistration("before-reregister")
            if ProcessInfo.processInfo.environment["FRAMEKIT_TEST_NO_REREGISTER"] != "1" {
                NSAppleEventManager.shared().setEventHandler(receiver, andSelector: #selector(Receiver.ping(_:withReplyEvent:)),
                    forEventClass: AEEventClass(kCoreEventClass), andEventID: AEEventID(kAEOpenDocuments))
            }
            Receiver.reportRegistration("after-lookup")
        }
        let matches = MockStore.assets.filter { $0.uniqueID == id }
        return matches.count == 1 ? matches[0] : nil
    }
}
@objc(MockMakeCommand)
final class MockMakeCommand: NSCreateCommand {
    override func performDefaultImplementation() -> Any? {
        fputs("MOCK MAKE COMMAND INVOKED\n", stderr)
        guard let description = NSScriptClassDescription(for: NSApplication.self) else {
            scriptErrorNumber = Int(errAEEventNotHandled); return nil
        }
        let properties = evaluatedArguments?["KeyDictionary"] as? [String: Any]
        let metadata = properties?["metadata"] as? [String: String]
        let incoming = properties?["dataOptions"] as? [String: [String]]
        guard properties == nil || properties?["name"] as? String == "Named" && metadata?["example.test.title"] == "Incoming"
              && incoming?["availableMetadataSets"] == ["General View", "Camera View"]
              && incoming?["availableDescriptionVersions"] == ["1.11", "1.10"] else {
            scriptErrorNumber = Int(errAEEventNotHandled); return nil
        }
        let asset = MockAsset(id: "asset-\(MockStore.assets.count + 1)", name: properties == nil ? "Synthetic" : "Named",
            metadata: metadata ?? ["example.test.title": "Synthetic metadata"],
            options: ["metadataSet": "General View", "descriptionVersion": "1.11"])
        MockStore.assets.append(asset)
        return NSUniqueIDSpecifier(containerClassDescription: description, containerSpecifier: nil, key: "assets", uniqueID: asset.uniqueID)
    }
}
final class Receiver: NSObject {
    static var active: Receiver?
    static var initialHandler: UInt?
    static var initialReference: UnsafeMutableRawPointer?
    static func reportRegistration(_ stage: String) {
        var handler: AEEventHandlerUPP?
        var reference: UnsafeMutableRawPointer?
        let status = AEGetEventHandler(AEEventClass(kCoreEventClass), AEEventID(kAEOpenDocuments), &handler, &reference, false)
        let address = unsafeBitCast(handler, to: UInt.self)
        if stage == "initial" { initialHandler = address; initialReference = reference }
        let same = status == noErr && address == initialHandler && reference == initialReference
        fputs("MOCK OPEN REGISTRATION \(stage) status=\(status) initial=\(same)\n", stderr)
    }
    @objc func ping(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        if let list = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject)), list.descriptorType == DescType(typeAEList) {
            fputs("MOCK OPEN HANDLER INVOKED\n", stderr)
            let matches = MockStore.assets.filter { asset in
                list.numberOfItems == 1 && list.atIndex(1)?.fileURLValue?.path == testSharePath(asset.name)
            }
            guard matches.count == 1, let description = NSScriptClassDescription(for: NSApplication.self),
                  let descriptor = NSUniqueIDSpecifier(containerClassDescription: description, containerSpecifier: nil,
                      key: "assets", uniqueID: matches[0].uniqueID).descriptor else {
                reply.setParam(NSAppleEventDescriptor(int32: Int32(errAEEventNotHandled)), forKeyword: AEKeyword(keyErrorNumber)); return
            }
            reply.setParam(descriptor, forKeyword: AEKeyword(keyDirectObject)); return
        }
        let registry = NSScriptSuiteRegistry.shared()
        let loaded = registry.suiteNames.contains { $0 == "Mock Suite" || $0 == "MockSuite" }
        let commandDescription = registry.commandDescription(withAppleEventClass: AEEventClass(0x636f7265), andAppleEventCode: AEEventID(0x6372656c))
        let command = commandDescription?.commandClassName ?? "none"
        let propertyCode = commandDescription?.appleEventCodeForArgument(withName: "KeyDictionary") ?? 0
        reply.setParam(NSAppleEventDescriptor(string: "pong:\(loaded ? "loaded" : "absent"):\(command):\(propertyCode)"), forKeyword: AEKeyword(keyDirectObject))
    }
}
final class MockDelegate: NSObject, NSApplicationDelegate {
    func application(_ application: NSApplication, open urls: [URL]) {
        fputs("MOCK DELEGATE OPEN INVOKED\n", stderr)
        guard let reply = NSAppleEventManager.shared().currentReplyAppleEvent else { fputs("MOCK DELEGATE NO CURRENT REPLY\n", stderr); return }
        fputs("MOCK DELEGATE HAS CURRENT REPLY\n", stderr)
        if urls.count == 1 && FileManager.default.fileExists(atPath: urls[0].path) { fputs("MOCK DELEGATE FILE EXISTS\n", stderr) }
        let matches = MockStore.assets.filter { asset in urls.count == 1 && urls[0].path == testSharePath(asset.name) }
        guard matches.count == 1, let description = NSScriptClassDescription(for: NSApplication.self),
              let descriptor = NSUniqueIDSpecifier(containerClassDescription: description, containerSpecifier: nil,
                  key: "assets", uniqueID: matches[0].uniqueID).descriptor else {
            reply.setParam(NSAppleEventDescriptor(int32: Int32(errAEEventNotHandled)), forKeyword: AEKeyword(keyErrorNumber)); application.reply(toOpenOrPrint: .failure); return
        }
        reply.setParam(descriptor, forKeyword: AEKeyword(keyDirectObject))
        application.reply(toOpenOrPrint: .success)
    }
}
let args = CommandLine.arguments
if args.count == 2 && args[1] == "conversion-control" {
    let unsupported: NSDictionary = ["synthetic": 42]
    guard unsupported.testUserRecordDescriptor() == nil else { fputs("unsupported metadata accepted\n", stderr); exit(1) }
    let malformed = NSAppleEventDescriptor.record()
    let odd = NSAppleEventDescriptor.list()
    odd.insert(NSAppleEventDescriptor(string: "key"), at: 1)
    malformed.setDescriptor(odd, forKeyword: AEKeyword(keyASUserRecordFields))
    guard NSDictionary.testUserRecord(with: malformed) == nil else { fputs("odd metadata accepted\n", stderr); exit(1) }
    let duplicates = NSAppleEventDescriptor.list()
    for (index, value) in ["key", "one", "key", "two"].enumerated() {
        duplicates.insert(NSAppleEventDescriptor(string: value), at: index + 1)
    }
    malformed.setDescriptor(duplicates, forKeyword: AEKeyword(keyASUserRecordFields))
    guard NSDictionary.testUserRecord(with: malformed) == nil else { fputs("duplicate metadata accepted\n", stderr); exit(1) }
    for invalid in [NSAppleEventDescriptor(int32: 42), NSAppleEventDescriptor(boolean: true),
                    NSAppleEventDescriptor(fileURL: URL(fileURLWithPath: "/synthetic")), NSAppleEventDescriptor.record()] {
        let fields = NSAppleEventDescriptor.list()
        fields.insert(NSAppleEventDescriptor(string: "key"), at: 1)
        fields.insert(invalid, at: 2)
        malformed.setDescriptor(fields, forKeyword: AEKeyword(keyASUserRecordFields))
        guard NSDictionary.testUserRecord(with: malformed) == nil else { fputs("coerced metadata accepted\n", stderr); exit(1) }
        let invalidKey = NSAppleEventDescriptor.list()
        invalidKey.insert(invalid, at: 1)
        invalidKey.insert(NSAppleEventDescriptor(string: "value"), at: 2)
        malformed.setDescriptor(invalidKey, forKeyword: AEKeyword(keyASUserRecordFields))
        guard NSDictionary.testUserRecord(with: malformed) == nil else { fputs("coerced metadata key accepted\n", stderr); exit(1) }
    }
    for invalid in [NSAppleEventDescriptor.list(), NSAppleEventDescriptor(int32: 1), NSAppleEventDescriptor(boolean: true)] {
        let options = NSAppleEventDescriptor.record()
        let fields = NSAppleEventDescriptor.list()
        fields.insert(NSAppleEventDescriptor(string: "availableMetadataSets"), at: 1)
        fields.insert(invalid, at: 2)
        options.setDescriptor(fields, forKeyword: AEKeyword(keyASUserRecordFields))
        guard NSDictionary.testUserRecord(with: options) == nil else { fputs("invalid options accepted\n", stderr); exit(1) }
    }
    for items in [[NSAppleEventDescriptor(int32: 1)], [NSAppleEventDescriptor(string: "same"), NSAppleEventDescriptor(string: "same")]] {
        let options = NSAppleEventDescriptor.record()
        let fields = NSAppleEventDescriptor.list()
        let list = NSAppleEventDescriptor.list()
        for (index, item) in items.enumerated() { list.insert(item, at: index + 1) }
        fields.insert(NSAppleEventDescriptor(string: "availableDescriptionVersions"), at: 1)
        fields.insert(list, at: 2)
        options.setDescriptor(fields, forKeyword: AEKeyword(keyASUserRecordFields))
        guard NSDictionary.testUserRecord(with: options) == nil else { fputs("invalid option list accepted\n", stderr); exit(1) }
    }
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    guard let d = NSScriptSuiteRegistry.shared().commandDescription(withAppleEventClass: AEEventClass(0x636f7265), andAppleEventCode: AEEventID(0x6372656c)) else { exit(2) }
    let c = MockMakeCommand(commandDescription: d)
    c.arguments = ["ObjectClass": NSNumber(value: OSType(0x61736574)), "KeyDictionary": ["name": "Synthetic"]]
    guard c.isWellFormed, let args = c.evaluatedArguments,
          (args["ObjectClass"] as? NSNumber)?.uint32Value == OSType(0x61736574),
          (args["KeyDictionary"] as? [String: String])?["name"] == "Synthetic" else {
        fputs("synthetic command arguments not well formed\n", stderr); exit(1)
    }
    print("unsupported-rejected:command-well-formed")
} else if args.count == 2 && args[1] == "listen" {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    let receiver = Receiver()
    let delegate = MockDelegate()
    if ProcessInfo.processInfo.environment["FRAMEKIT_TEST_USE_DELEGATE"] == "1" { app.delegate = delegate }
    Receiver.active = receiver
    DispatchQueue.main.async {
        NSAppleEventManager.shared().setEventHandler(receiver, andSelector: #selector(Receiver.ping(_:withReplyEvent:)),
            forEventClass: AEEventClass(kCoreEventClass), andEventID: AEEventID(0x666b7069))
        if ProcessInfo.processInfo.environment["FRAMEKIT_TEST_USE_DELEGATE"] != "1" {
            NSAppleEventManager.shared().setEventHandler(receiver, andSelector: #selector(Receiver.ping(_:withReplyEvent:)),
                forEventClass: AEEventClass(kCoreEventClass), andEventID: AEEventID(kAEOpenDocuments))
            Receiver.reportRegistration("initial")
        }
        print("ready"); fflush(stdout)
    }
    withExtendedLifetime((receiver, delegate)) { app.run() }
} else if args.count == 4 && args[1] == "send", let target = Int32(args[2]), target > 0, ["ping", "make", "make-properties"].contains(args[3]) {
    var path = [CChar](repeating: 0, count: 4096)
    let length = proc_pidpath(target, &path, UInt32(path.count))
    let own = URL(fileURLWithPath: args[0]).resolvingSymlinksInPath().path
    let targetPath = URL(fileURLWithPath: String(cString: path)).resolvingSymlinksInPath().path
    guard length > 0, own == targetPath, target != getpid() else { fputs("target is not the test executable\n", stderr); exit(2) }
    let make = args[3] != "ping"
    let event = NSAppleEventDescriptor(eventClass: make ? AEEventClass(0x636f7265) : AEEventClass(kCoreEventClass), eventID: make ? AEEventID(0x6372656c) : AEEventID(0x666b7069),
        targetDescriptor: NSAppleEventDescriptor(processIdentifier: target), returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
    if make {
        event.setParam(NSAppleEventDescriptor(typeCode: OSType(0x61736574)), forKeyword: AEKeyword(0x6b6f636c))
        if args[3] == "make-properties" {
            let properties = NSAppleEventDescriptor.record()
            properties.setDescriptor(NSAppleEventDescriptor(string: "Named"), forKeyword: AEKeyword(0x706e616d))
            let fields = NSAppleEventDescriptor.list()
            fields.insert(NSAppleEventDescriptor(string: "example.test.title"), at: 1)
            fields.insert(NSAppleEventDescriptor(string: "Incoming"), at: 2)
            let metadata = NSAppleEventDescriptor.record()
            metadata.setDescriptor(fields, forKeyword: AEKeyword(keyASUserRecordFields))
            properties.setDescriptor(metadata, forKeyword: AEKeyword(0x6d657461))
            let optionsFields = NSAppleEventDescriptor.list()
            for (index, pair) in [("availableMetadataSets", ["General View", "Camera View"]), ("availableDescriptionVersions", ["1.11", "1.10"])].enumerated() {
                optionsFields.insert(NSAppleEventDescriptor(string: pair.0), at: index * 2 + 1)
                let items = NSAppleEventDescriptor.list()
                for (itemIndex, item) in pair.1.enumerated() { items.insert(NSAppleEventDescriptor(string: item), at: itemIndex + 1) }
                optionsFields.insert(items, at: index * 2 + 2)
            }
            let options = NSAppleEventDescriptor.record()
            options.setDescriptor(optionsFields, forKeyword: AEKeyword(keyASUserRecordFields))
            properties.setDescriptor(options, forKeyword: AEKeyword(0x646f7074))
            event.setParam(properties, forKeyword: AEKeyword(0x70726474))
        }
    }
    else { event.setParam(NSAppleEventDescriptor(string: "ping"), forKeyword: AEKeyword(keyDirectObject)) }
    do {
        let reply = try event.sendEvent(options: [.waitForReply, .neverInteract], timeout: 3)
        if args[3] == "make-properties", let result = reply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject)),
           result.descriptorType == DescType(typeObjectSpecifier),
           result.forKeyword(AEKeyword(keyAEDesiredClass))?.typeCodeValue == OSType(0x61736574),
           result.forKeyword(AEKeyword(keyAEKeyForm))?.typeCodeValue == OSType(formUniqueID),
           result.forKeyword(AEKeyword(keyAEKeyData))?.stringValue == "asset-2" {
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
            guard getReply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue == "Named" else { exit(1) }
            property.setDescriptor(NSAppleEventDescriptor(typeCode: OSType(0x6d657461)), forKeyword: AEKeyword(keyAEKeyData))
            guard let metadataSpecifier = property.coerce(toDescriptorType: DescType(typeObjectSpecifier)) else { exit(1) }
            let metadataGet = NSAppleEventDescriptor(eventClass: AEEventClass(0x636f7265), eventID: AEEventID(0x67657464),
                targetDescriptor: NSAppleEventDescriptor(processIdentifier: target), returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
            metadataGet.setParam(metadataSpecifier, forKeyword: AEKeyword(keyDirectObject))
            let metadataReply = try metadataGet.sendEvent(options: [.waitForReply, .neverInteract], timeout: 3)
            let metadata = metadataReply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.forKeyword(AEKeyword(keyASUserRecordFields))
            guard metadata?.numberOfItems == 2, metadata?.atIndex(1)?.stringValue == "example.test.title",
                  metadata?.atIndex(2)?.stringValue == "Incoming" else { fputs("incoming metadata mismatch: \(metadataReply)\n", stderr); exit(1) }
            property.setDescriptor(NSAppleEventDescriptor(typeCode: OSType(0x646f7074)), forKeyword: AEKeyword(keyAEKeyData))
            guard let optionsSpecifier = property.coerce(toDescriptorType: DescType(typeObjectSpecifier)) else { exit(1) }
            let optionsGet = NSAppleEventDescriptor(eventClass: AEEventClass(0x636f7265), eventID: AEEventID(0x67657464),
                targetDescriptor: NSAppleEventDescriptor(processIdentifier: target), returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
            optionsGet.setParam(optionsSpecifier, forKeyword: AEKeyword(keyDirectObject))
            let optionsReply = try optionsGet.sendEvent(options: [.waitForReply, .neverInteract], timeout: 3)
            let fields = optionsReply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.forKeyword(AEKeyword(keyASUserRecordFields))
            guard fields?.numberOfItems == 4, fields?.atIndex(1)?.stringValue == "descriptionVersion", fields?.atIndex(2)?.stringValue == "1.11",
                  fields?.atIndex(3)?.stringValue == "metadataSet", fields?.atIndex(4)?.stringValue == "General View" else { fputs("data options mismatch: \(optionsReply)\n", stderr); exit(1) }
            print("properties:asset-2:get:Named:metadata:Incoming:options:verified"); exit(0)
        }
        if !make, let value = reply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue, value.hasPrefix("pong:") { print(value); exit(0) }
        if args[3] == "make", let result = reply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject)),
           result.descriptorType == DescType(typeObjectSpecifier),
           result.forKeyword(AEKeyword(keyAEDesiredClass))?.typeCodeValue == OSType(0x61736574),
           result.forKeyword(AEKeyword(keyAEKeyForm))?.typeCodeValue == OSType(formUniqueID),
           result.forKeyword(AEKeyword(keyAEKeyData))?.stringValue == "asset-1" {
            fputs("make-response-received\n", stderr)
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
            property.setDescriptor(NSAppleEventDescriptor(typeCode: OSType(0x6c6f636e)), forKeyword: AEKeyword(keyAEKeyData))
            guard let locationSpecifier = property.coerce(toDescriptorType: DescType(typeObjectSpecifier)) else { exit(1) }
            let locationGet = NSAppleEventDescriptor(eventClass: AEEventClass(0x636f7265), eventID: AEEventID(0x67657464),
                targetDescriptor: NSAppleEventDescriptor(processIdentifier: target), returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
            locationGet.setParam(locationSpecifier, forKeyword: AEKeyword(keyDirectObject))
            let locationReply = try locationGet.sendEvent(options: [.waitForReply, .neverInteract], timeout: 3)
            let location = locationReply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))
            let coercedLocation = location?.coerce(toDescriptorType: DescType(0x61736c63))
            let emptyLocation = NSAppleEventDescriptor.record().coerce(toDescriptorType: DescType(0x61736c63))
            guard let typedLocation = coercedLocation, typedLocation.descriptorType == DescType(0x61736c63),
                  typedLocation.forKeyword(AEKeyword(0x61736664))?.fileURLValue?.path == testShareDirectory,
                  typedLocation.forKeyword(AEKeyword(0x6173626e))?.stringValue == "Synthetic",
                  typedLocation.forKeyword(AEKeyword(0x61736864))?.booleanValue == true,
                  typedLocation.forKeyword(AEKeyword(0x6173686d))?.booleanValue == false else {
                fputs("location coercion lost fields\n", stderr); exit(1)
            }
            guard emptyLocation?.descriptorType == DescType(0x61736c63), emptyLocation?.numberOfItems == 0 else {
                fputs("empty record coercion changed behavior\n", stderr); exit(1)
            }
            fputs("location-coercion:fields-retained:empty-accepted\n", stderr)
            guard location?.descriptorType == DescType(typeAERecord),
                  location?.forKeyword(AEKeyword(0x61736664))?.fileURLValue?.path == testShareDirectory,
                  location?.forKeyword(AEKeyword(0x6173626e))?.stringValue == "Synthetic",
                  location?.forKeyword(AEKeyword(0x61736864))?.booleanValue == true,
                  location?.forKeyword(AEKeyword(0x6173686d))?.booleanValue == false else {
                fputs("unexpected location reply: \(locationReply)\n", stderr); exit(1)
            }
            property.setDescriptor(NSAppleEventDescriptor(typeCode: OSType(0x6d657461)), forKeyword: AEKeyword(keyAEKeyData))
            guard let metadataSpecifier = property.coerce(toDescriptorType: DescType(typeObjectSpecifier)) else { exit(1) }
            let metadataGet = NSAppleEventDescriptor(eventClass: AEEventClass(0x636f7265), eventID: AEEventID(0x67657464),
                targetDescriptor: NSAppleEventDescriptor(processIdentifier: target), returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
            metadataGet.setParam(metadataSpecifier, forKeyword: AEKeyword(keyDirectObject))
            let metadataReply = try metadataGet.sendEvent(options: [.waitForReply, .neverInteract], timeout: 3)
            let metadata = metadataReply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))
            let userFields = metadata?.forKeyword(AEKeyword(keyASUserRecordFields))
            guard metadata?.descriptorType == DescType(typeAERecord), userFields?.numberOfItems == 2,
                  userFields?.atIndex(1)?.stringValue == "example.test.title",
                  userFields?.atIndex(2)?.stringValue == "Synthetic metadata" else {
                fputs("unexpected metadata reply: \(metadataReply)\n", stderr); exit(1)
            }
            property.setDescriptor(NSAppleEventDescriptor(typeCode: OSType(0x706e616d)), forKeyword: AEKeyword(keyAEKeyData))
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
            let openEvent = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEOpenDocuments),
                targetDescriptor: NSAppleEventDescriptor(processIdentifier: target), returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
            let files = NSAppleEventDescriptor.list()
            files.insert(NSAppleEventDescriptor(fileURL: URL(fileURLWithPath: testSharePath("Synthetic"))), at: 1)
            openEvent.setParam(files, forKeyword: AEKeyword(keyDirectObject))
            let openReply = try openEvent.sendEvent(options: [.waitForReply, .neverInteract], timeout: 3)
            let openResult = openReply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))
            guard openResult?.descriptorType == DescType(typeObjectSpecifier),
                  openResult?.forKeyword(AEKeyword(keyAEKeyData))?.stringValue == "asset-1" else {
                fputs("unexpected open reply: \(openReply)\n", stderr); exit(1)
            }
            let wrongFiles = NSAppleEventDescriptor.list()
            wrongFiles.insert(NSAppleEventDescriptor(fileURL: URL(fileURLWithPath: testSharePath("Unknown"))), at: 1)
            openEvent.setParam(wrongFiles, forKeyword: AEKeyword(keyDirectObject))
            var openRejected = false
            do {
                let invalidReply = try openEvent.sendEvent(options: [.waitForReply, .neverInteract], timeout: 3)
                openRejected = invalidReply.paramDescriptor(forKeyword: AEKeyword(keyErrorNumber))?.int32Value == Int32(errAEEventNotHandled)
            } catch { openRejected = (error as NSError).code == Int(errAEEventNotHandled) }
            guard openRejected else { fputs("unknown output not rejected\n", stderr); exit(1) }
            print("make:asset-1:get:Synthetic:location:reco:metadata:verified:unknown-rejected:open:asset-1:open-unknown-rejected"); exit(0)
        }
        fputs("unexpected reply: \(reply)\n", stderr); exit(1)
    } catch {
        fputs("unexpected error: \(error)\n", stderr); exit(1)
    }
} else { fputs("invalid arguments\n", stderr); exit(2) }

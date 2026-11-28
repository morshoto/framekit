// Research-only Apple Event boundary. Never authenticates or accepts a native callback.
import Foundation
import AppKit
import Carbon

final class MockShareJournal {
    private enum State { case pending, completed, cancelled }
    private struct Record { let generation: Int; var state: State }
    private var records: [UUID: Record] = [:]
    private let lock = NSLock()

    func begin(_ id: UUID, generation: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard generation > 0, records[id] == nil else { return false }
        records[id] = Record(generation: generation, state: .pending)
        return true
    }

    func complete(_ id: UUID, generation: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard var record = records[id], record.generation == generation, record.state == .pending else { return false }
        record.state = .completed
        records[id] = record
        return true
    }

    func cancel(_ id: UUID) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard var record = records[id], record.state == .pending else { return false }
        record.state = .cancelled
        records[id] = record
        return true
    }
}

final class ShareEventReceiver: NSObject {
    private let rejectionCode: Int32
    init(rejectionCode: Int32 = Int32(errAEEventNotHandled)) {
        self.rejectionCode = rejectionCode
        super.init()
    }
    var onRejectedOpen: ((NSAppleEventDescriptor) -> Void)?
    // Registration is exercised only in the isolated test process.
    func register() {
        NSAppleEventManager.shared().setEventHandler(self,
            andSelector: #selector(handleOpen(_:withReplyEvent:)),
            forEventClass: AEEventClass(kCoreEventClass), andEventID: AEEventID(kAEOpenDocuments))
    }

    func unregister() {
        NSAppleEventManager.shared().removeEventHandler(forEventClass: AEEventClass(kCoreEventClass), andEventID: AEEventID(kAEOpenDocuments))
    }

    @objc func handleOpen(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        // Open Document does not itself establish an authenticated sender or exact target.
        // Do not consume files or commit a receipt until a separately proven correlation exists.
        onRejectedOpen?(event)
        reply.setParam(NSAppleEventDescriptor(int32: rejectionCode), forKeyword: AEKeyword(keyErrorNumber))
    }
}

// Synthetic KVC model. It does not represent an authenticated native asset.
@objc(ResearchAsset)
final class ResearchAsset: NSObject {
    @objc dynamic let uniqueID: String
    @objc dynamic let name: String
    @objc dynamic let locationInfo: NSDictionary
    @objc dynamic let libraryInfo: NSDictionary
    @objc dynamic var metadata: NSDictionary = [:]
    @objc dynamic var dataOptions: NSDictionary = [:]

    init(id: UUID, name: String, root: URL) {
        self.uniqueID = id.uuidString.lowercased()
        self.name = name
        let folder = root.appendingPathComponent(id.uuidString.lowercased(), isDirectory: true)
        self.locationInfo = ["folder": folder, "basename": name, "hasDescription": true, "hasMedia": false]
        self.libraryInfo = ["folder": folder, "basename": name, "hasArchive": false, "hasDescription": false]
    }
}

// This in-memory lexical lookup is not a secure file containment or sender check.
final class MockAssetRegistry {
    private let root: URL
    private let lock = NSLock()
    private var assets: [ResearchAsset] = []

    init(root: URL) { self.root = root }

    func make(name: String) -> ResearchAsset? {
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty,
              name.range(of: "^[A-Za-z0-9 _-]+$", options: .regularExpression) != nil else { return nil }
        lock.lock(); defer { lock.unlock() }
        let asset = ResearchAsset(id: UUID(), name: name, root: root)
        assets.append(asset)
        return asset
    }

    func matchOutput(_ url: URL) -> ResearchAsset? {
        guard url.isFileURL else { return nil }
        lock.lock(); defer { lock.unlock() }
        let matches = assets.filter { asset in
            guard let folder = asset.locationInfo["folder"] as? URL else { return false }
            return url == folder.appendingPathComponent("\(asset.name).fcpxml")
        }
        return matches.count == 1 ? matches[0] : nil
    }
}

extension MockAssetRegistry {
    // Constructs a Cocoa value only; no app scripting container is registered or resolved.
    func makeSpecifier(name: String, containerDescription: NSScriptClassDescription) -> (asset: ResearchAsset, specifier: NSUniqueIDSpecifier)? {
        let probe = NSUniqueIDSpecifier(containerClassDescription: containerDescription,
            containerSpecifier: nil, key: "assets", uniqueID: "probe")
        guard probe.descriptor?.forKeyword(AEKeyword(keyAEDesiredClass))?.typeCodeValue == OSType(0x61736574),
              let asset = make(name: name) else { return nil }
        let specifier = NSUniqueIDSpecifier(containerClassDescription: containerDescription,
            containerSpecifier: nil, key: "assets", uniqueID: asset.uniqueID)
        return (asset, specifier)
    }
}

// Real scripting entrypoint remains disabled until sender and target are authenticated.
@objc(ResearchMakeCommand)
final class ResearchMakeCommand: NSScriptCommand {
    override func performDefaultImplementation() -> Any? {
        scriptErrorNumber = Int(errAEEventNotHandled)
        scriptErrorString = "Unverified sender and target"
        return nil
    }
}

import Foundation
import AppKit
import Carbon

func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fatalError(message) }
}

let model = MockShareJournal()
let id = UUID()
require(model.begin(id, generation: 1), "begin failed")
let lock = NSLock()
var accepted = 0
DispatchQueue.concurrentPerform(iterations: 32) { _ in
    if model.complete(id, generation: 1) {
        lock.lock(); accepted += 1; lock.unlock()
    }
}
require(accepted == 1, "duplicate callback accepted")
require(!model.complete(id, generation: 1), "duplicate accepted after completion")
let stale = UUID()
require(model.begin(stale, generation: 2), "second begin failed")
require(!model.complete(stale, generation: 1), "stale generation accepted")
require(model.cancel(stale), "cancel failed")
require(!model.complete(stale, generation: 2), "cancelled callback accepted")
require(!MockShareJournal().complete(id, generation: 1), "restart inferred state")

let event = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEOpenDocuments), targetDescriptor: nil, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
let reply = NSAppleEventDescriptor.record()
let receiver = ShareEventReceiver()
receiver.handleOpen(event, withReplyEvent: reply)
require(reply.paramDescriptor(forKeyword: AEKeyword(keyErrorNumber))?.int32Value == Int32(errAEEventNotHandled), "unverified sender must be rejected")

require(receiver.responds(to: #selector(ShareEventReceiver.handleOpen(_:withReplyEvent:))), "handler selector missing")
receiver.register()
receiver.unregister()
let unauthenticated = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEOpenDocuments), targetDescriptor: nil, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
let files = NSAppleEventDescriptor.list()
files.insert(NSAppleEventDescriptor(string: "file:///synthetic/Example.fcpxml"), at: 1)
unauthenticated.setParam(files, forKeyword: AEKeyword(keyDirectObject))
let unauthenticatedReply = NSAppleEventDescriptor.record()
receiver.handleOpen(unauthenticated, withReplyEvent: unauthenticatedReply)
require(unauthenticatedReply.paramDescriptor(forKeyword: AEKeyword(keyErrorNumber))?.int32Value == Int32(errAEEventNotHandled), "untrusted file accepted")

let registry = MockAssetRegistry(root: URL(fileURLWithPath: "/synthetic/share-root", isDirectory: true))
let firstAsset = registry.make(name: "Example")!
let secondAsset = registry.make(name: "Example")!
require(firstAsset.uniqueID != secondAsset.uniqueID, "asset ids collided")
require(firstAsset.locationInfo["basename"] as? String == "Example", "base name mismatch")
require(firstAsset.locationInfo["hasDescription"] as? Bool == true, "description flag missing")
require(firstAsset.locationInfo["hasMedia"] as? Bool == false, "unexpected media flag")
let firstFolder = firstAsset.locationInfo["folder"] as! URL
let secondFolder = secondAsset.locationInfo["folder"] as! URL
require(firstFolder != secondFolder, "asset directories collided")
let firstOutput = firstFolder.appendingPathComponent("Example.fcpxml")
require(registry.matchOutput(firstOutput)?.uniqueID == firstAsset.uniqueID, "asset path did not correlate")
require(registry.matchOutput(secondFolder.appendingPathComponent("Example.fcpxml"))?.uniqueID == secondAsset.uniqueID, "second output miscorrelated")
require(registry.matchOutput(firstFolder.appendingPathComponent("Other.fcpxml")) == nil, "wrong output accepted")
require(registry.matchOutput(URL(fileURLWithPath: "/synthetic/other/Example.fcpxml")) == nil, "foreign path accepted")
require(registry.make(name: "../escape") == nil, "invalid name accepted")
require(firstAsset.value(forKey: "uniqueID") as? String == firstAsset.uniqueID, "KVC id mismatch")

require(NSClassFromString("ResearchAsset") === ResearchAsset.self, "Objective-C class not registered")
require(firstAsset.value(forKey: "locationInfo") is NSDictionary, "KVC location unavailable")
require(firstAsset.value(forKey: "libraryInfo") is NSDictionary, "KVC library unavailable")
require(firstAsset.value(forKey: "metadata") is NSDictionary, "KVC metadata unavailable")
require(firstAsset.value(forKey: "dataOptions") is NSDictionary, "KVC data options unavailable")
print("Swift mock asset, callback controls and fail-closed Apple Event handler passed")

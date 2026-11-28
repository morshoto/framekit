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
print("Swift mock callback controls and fail-closed Apple Event handler passed")

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

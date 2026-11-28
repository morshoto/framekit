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
    // Optional registration for an isolated test app; never invoked by these tests.
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
        reply.setParam(NSAppleEventDescriptor(int32: Int32(errAEEventNotHandled)), forKeyword: AEKeyword(keyErrorNumber))
    }
}

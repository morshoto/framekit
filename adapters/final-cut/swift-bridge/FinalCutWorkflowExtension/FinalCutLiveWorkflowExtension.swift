import CoreMedia
import Foundation
import AppKit

#if os(macOS)
import Darwin
#endif

import ProExtensionHost

private let protocolVersion = 1

private struct RationalTime: Codable {
    let value: String
    let timescale: String

    init(_ time: CMTime) {
        value = String(time.value)
        timescale = String(time.timescale)
    }
}

private struct RationalTimeRange: Codable {
    let start: RationalTime
    let duration: RationalTime
}

private struct LiveState: Codable {
    struct Project: Codable {
        let id: String
        let name: String
    }

    struct Sequence: Codable {
        let id: String
        let name: String
        let startTime: RationalTime
        let duration: RationalTime
        let frameDuration: RationalTime
    }

    let project: Project?
    let sequence: Sequence?
    let playheadTime: RationalTime?
    let sequenceTimeRange: RationalTimeRange?
    let revision: Revision
}

private struct Revision: Codable {
    let id: String
    let sequence: Int
    let timestamp: String
}

private struct LiveChange: Codable {
    let kind: String
    let revision: Revision
    let state: LiveState
}

private struct BridgeRequest: Codable {
    let version: Int
    let id: String
    let method: String
    let afterSequence: Int?
    let waitMs: Int?
}

private struct EditorCapabilities: Codable {
    let projectRead: Bool
    let timelineSnapshotRead: Bool
    let timelineWrite: Bool
    let timelineArtifactWrite: Bool
    let readAfterWrite: Bool
    let incrementalChanges: Bool
    let rollback: Bool
    let assetDiscovery: Bool
    let liveStateRead: Bool
    let playheadWrite: Bool
    let playbackControl: Bool
}

private struct AnalyzerCapabilities: Codable {
    let speechTranscribe: Bool
    let speechVad: Bool
    let audioLoudness: Bool
    let visualTrack: Bool
}

private struct RuntimeCapabilities: Codable {
    let editor: EditorCapabilities
    let analyzers: AnalyzerCapabilities
}

private struct Identity: Codable {
    let name: String
    let version: String
    let backend: String
}

private struct BridgeResult: Codable {
    let identity: Identity
    let capabilities: RuntimeCapabilities
    let state: LiveState?
    let changes: [LiveChange]?
}

private struct BridgeError: Codable {
    let code: String
    let message: String
}

private struct BridgeResponse: Codable {
    let version: Int
    let id: String
    let ok: Bool
    let result: BridgeResult?
    let error: BridgeError?
}

private final class UnixJSONServer {
    private let path: String
    private let handler: (BridgeRequest) -> BridgeResponse
    private var serverFD: Int32 = -1

    init(path: String, handler: @escaping (BridgeRequest) -> BridgeResponse) throws {
        self.path = path
        self.handler = handler
        try start()
    }

    deinit {
        if serverFD >= 0 { close(serverFD) }
        unlink(path)
    }

    private func start() throws {
        #if os(macOS)
        serverFD = socket(AF_UNIX, SOCK_STREAM, 0)
        guard serverFD >= 0 else { throw POSIXError(.EIO) }
        unlink(path)

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(path.utf8) + [0]
        let maxPathBytes = MemoryLayout<sockaddr_un>.size - MemoryLayout<sa_family_t>.size
        guard pathBytes.count <= maxPathBytes else { throw POSIXError(.ENAMETOOLONG) }
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            destination.copyBytes(from: pathBytes)
        }
        let addressLength = socklen_t(MemoryLayout<sockaddr_un>.offset(of: \sockaddr_un.sun_path)! + pathBytes.count)
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(serverFD, $0, addressLength)
            }
        }
        guard bound == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        guard listen(serverFD, 8) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        _ = chmod(path, S_IRUSR | S_IWUSR)

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.acceptLoop()
        }
        #else
        throw POSIXError(.ENOTSUP)
        #endif
    }

    private func acceptLoop() {
        while serverFD >= 0 {
            let client = accept(serverFD, nil, nil)
            guard client >= 0 else { continue }
            DispatchQueue.global(qos: .userInitiated).async { [handler] in
                Self.handle(client: client, handler: handler)
            }
        }
    }

    private static func handle(client: Int32, handler: (BridgeRequest) -> BridgeResponse) {
        defer { close(client) }
        var input = Data()
        var byte: UInt8 = 0
        while read(client, &byte, 1) == 1 {
            input.append(byte)
            if byte == 10 { break }
        }
        guard let request = try? JSONDecoder().decode(BridgeRequest.self, from: input) else { return }
        guard let output = try? JSONEncoder().encode(handler(request)) else { return }
        _ = output.withUnsafeBytes { bytes in
            write(client, bytes.baseAddress, output.count)
        }
        var newline: UInt8 = 10
        _ = withUnsafePointer(to: &newline) { write(client, $0, 1) }
    }
}

private final class TimelineObserver: NSObject, FCPXTimelineObserver {
    var onChange: (String) -> Void

    init(onChange: @escaping (String) -> Void) {
        self.onChange = onChange
    }

    func activeSequenceChanged() { onChange("active-sequence-changed") }
    func playheadTimeChanged() { onChange("playhead-changed") }
    func sequenceTimeRangeChanged() { onChange("sequence-time-range-changed") }
}

/// Workflow Extension host object. Final Cut creates the extension in-process;
/// Framekit connects to the local socket published by this object.
@objc(FinalCutLiveWorkflowExtension)
public final class FinalCutLiveWorkflowExtension: NSViewController {
    private var host: FCPXHost?
    private var observer: TimelineObserver?
    private var server: UnixJSONServer?
    private var startupRetryTimer: Timer?
    private weak var statusLabel: NSTextField?
    private let stateLock = NSLock()
    private var revision = 0
    private var changes: [LiveChange] = []

    public override func loadView() {
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 120))
        let label = NSTextField(labelWithString: "Framekit live bridge")
        label.alignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        statusLabel = label
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
        self.view = view
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        startBridgeIfPossible()
    }

    public override func viewDidAppear() {
        super.viewDidAppear()
        // Final Cut can finish wiring the host after viewDidLoad. Retry from
        // viewDidAppear so the bridge is started only once the extension is
        // actually hosted by Final Cut.
        startBridgeIfPossible()
    }

    private func startBridgeIfPossible() {
        guard server == nil else { return }
        guard let host = ProExtensionHostSingleton() as? FCPXHost else {
            statusLabel?.stringValue = "Waiting for Final Cut host"
            NSLog("Framekit Final Cut live bridge is waiting for the Workflow Extension host")
            scheduleBridgeRetry()
            return
        }
        startupRetryTimer?.invalidate()
        startupRetryTimer = nil
        self.host = host
        if observer == nil {
            let observer = TimelineObserver(onChange: { [weak self] kind in self?.record(kind: kind) })
            self.observer = observer
            host.timeline?.add(observer)
        }
        let socket = ProcessInfo.processInfo.environment["FRAMEKIT_FINAL_CUT_SOCKET"]
            ?? defaultSocketPath()
        do {
            server = try UnixJSONServer(path: socket) { [weak self] request in
                self?.handle(request) ?? BridgeResponse(version: protocolVersion, id: request.id, ok: false, result: nil, error: BridgeError(code: "FINAL_CUT_LIVE_UNAVAILABLE", message: "extension is shutting down"))
            }
            statusLabel?.stringValue = "Framekit live bridge ready"
            NSLog("Framekit Final Cut live bridge listening at %@", socket)
        } catch {
            statusLabel?.stringValue = "Bridge failed: \(error.localizedDescription)"
            NSLog("Framekit Final Cut live bridge failed to start at %@: %@", socket, String(describing: error))
        }
    }

    private func defaultSocketPath() -> String {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        return documents.deletingLastPathComponent().appendingPathComponent("framekit.sock").path
    }

    deinit {
        startupRetryTimer?.invalidate()
        if let host, let observer { host.timeline?.remove(observer) }
    }

    private func scheduleBridgeRetry() {
        guard startupRetryTimer == nil else { return }
        startupRetryTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] timer in
            guard let self else {
                timer.invalidate()
                return
            }
            guard self.server == nil else {
                timer.invalidate()
                self.startupRetryTimer = nil
                return
            }
            self.startBridgeIfPossible()
        }
    }

    private func handle(_ request: BridgeRequest) -> BridgeResponse {
        let identity = Identity(name: "Final Cut Pro", version: "Workflow Extension", backend: "workflow-extension-ipc")
        let capabilities = RuntimeCapabilities(
            editor: EditorCapabilities(projectRead: true, timelineSnapshotRead: false, timelineWrite: false, timelineArtifactWrite: false, readAfterWrite: false, incrementalChanges: true, rollback: false, assetDiscovery: false, liveStateRead: true, playheadWrite: false, playbackControl: false),
            analyzers: AnalyzerCapabilities(speechTranscribe: false, speechVad: false, audioLoudness: false, visualTrack: false)
        )
        switch request.method {
        case "capabilities":
            return BridgeResponse(version: protocolVersion, id: request.id, ok: true, result: BridgeResult(identity: identity, capabilities: capabilities, state: nil, changes: nil), error: nil)
        case "state":
            do {
                return BridgeResponse(version: protocolVersion, id: request.id, ok: true, result: BridgeResult(identity: identity, capabilities: capabilities, state: try state(), changes: nil), error: nil)
            } catch {
                return failure(request, code: "ACTIVE_SEQUENCE_UNAVAILABLE", message: String(describing: error))
            }
        case "changes":
            let after = request.afterSequence ?? 0
            let currentChanges = stateLock.withLock { changes }
            if request.waitMs ?? 0 > 0 && currentChanges.allSatisfy({ $0.revision.sequence <= after }) {
                Thread.sleep(forTimeInterval: Double(min(request.waitMs ?? 0, 30_000)) / 1000.0)
            }
            let result = stateLock.withLock { changes.filter { $0.revision.sequence > after } }
            return BridgeResponse(version: protocolVersion, id: request.id, ok: true, result: BridgeResult(identity: identity, capabilities: capabilities, state: nil, changes: result), error: nil)
        case "projects", "select-project":
            return failure(request, code: "CAPABILITY_UNAVAILABLE", message: "Final Cut Workflow Extension does not expose project catalog or selection")
        default:
            return failure(request, code: "UNSUPPORTED_METHOD", message: request.method)
        }
    }

    private func failure(_ request: BridgeRequest, code: String, message: String) -> BridgeResponse {
        BridgeResponse(version: protocolVersion, id: request.id, ok: false, result: nil, error: BridgeError(code: code, message: message))
    }

    private func record(kind: String) {
        stateLock.lock()
        revision += 1
        stateLock.unlock()
        guard let current = try? state() else { return }
        stateLock.withLock {
            changes.append(LiveChange(kind: kind, revision: current.revision, state: current))
            if changes.count > 100 { changes.removeFirst(changes.count - 100) }
        }
    }

    private func state() throws -> LiveState {
        guard let host, let timeline = host.timeline, let sequence = timeline.activeSequence else {
            throw NSError(domain: "Framekit", code: 1, userInfo: [NSLocalizedDescriptionKey: "no active sequence"])
        }
        let project = (sequence.container as? FCPXProject).map {
            LiveState.Project(id: "final-cut:project:\($0.uid)", name: $0.name)
        }
        let projectID = project?.id ?? "final-cut:project:unknown"
        // The public host API exposes no immutable sequence identifier. This
        // project-scoped name identity is intentionally treated as mutable;
        // native handles fail closed when the identity changes.
        let sequenceName = sequence.name ?? "active-sequence"
        let liveSequence = LiveState.Sequence(id: "\(projectID):sequence:\(sequenceName)", name: sequenceName, startTime: RationalTime(sequence.startTime), duration: RationalTime(sequence.duration), frameDuration: RationalTime(sequence.frameDuration))
        let selectedRange = RationalTimeRange(start: RationalTime(timeline.sequenceTimeRange.start), duration: RationalTime(timeline.sequenceTimeRange.duration))
        let currentRevision = stateLock.withLock { revision }
        return LiveState(project: project, sequence: liveSequence, playheadTime: RationalTime(timeline.playheadTime()), sequenceTimeRange: selectedRange, revision: Revision(id: "rev-\(currentRevision)", sequence: currentRevision, timestamp: ISO8601DateFormatter().string(from: Date())))
    }
}

private extension NSLock {
    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}

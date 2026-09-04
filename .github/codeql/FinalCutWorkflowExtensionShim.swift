#if FRAMEKIT_CODEQL
import CoreMedia
import Foundation

public enum NSTextAlignment {
    case center
}

public struct NSRect {
    public init(x: Double, y: Double, width: Double, height: Double) {}
}

class NSLayoutConstraint: NSObject {
    static func activate(_ constraints: [NSLayoutConstraint]) {}
}

class NSLayoutXAxisAnchor: NSObject {
    func constraint(equalTo anchor: NSLayoutXAxisAnchor) -> NSLayoutConstraint {
        NSLayoutConstraint()
    }
}

class NSLayoutYAxisAnchor: NSObject {
    func constraint(equalTo anchor: NSLayoutYAxisAnchor) -> NSLayoutConstraint {
        NSLayoutConstraint()
    }
}

public class NSView: NSObject {
    let centerXAnchor = NSLayoutXAxisAnchor()
    let centerYAnchor = NSLayoutYAxisAnchor()

    public init(frame: NSRect = NSRect(x: 0, y: 0, width: 0, height: 0)) {}

    func addSubview(_ view: NSView) {}
}

class NSTextField: NSView {
    init(labelWithString string: String) { super.init() }

    var alignment: NSTextAlignment = .center
    var translatesAutoresizingMaskIntoConstraints = false
    var stringValue = ""
}

open class NSViewController: NSObject {
    open var view: NSView!

    open func loadView() {}
    open func viewDidLoad() {}
    open func viewDidAppear() {}
}

protocol FCPXTimelineObserver: AnyObject {
    func activeSequenceChanged()
    func playheadTimeChanged()
    func sequenceTimeRangeChanged()
}

class FCPXObject: NSObject {
    var container: FCPXObject?
    var name: String! = ""
}

class FCPXSequence: FCPXObject {
    var startTime = CMTime.zero
    var duration = CMTime.zero
    var frameDuration = CMTime.zero
}

class FCPXProject: FCPXObject {
    var uid: String! = ""
    var sequence = FCPXSequence()
}

class FCPXTimeline: NSObject {
    var activeSequence: FCPXSequence?
    var sequenceTimeRange = CMTimeRange(start: .zero, duration: .zero)

    func playheadTime() -> CMTime { .zero }
    func add(_ observer: FCPXTimelineObserver) {}
    func remove(_ observer: FCPXTimelineObserver) {}
}

class FCPXHost: NSObject {
    var name: String! = ""
    var bundleIdentifier: String! = ""
    var versionString: String! = ""
    var timeline: FCPXTimeline?
}

func ProExtensionHostSingleton() -> AnyObject {
    FCPXHost()
}
#endif

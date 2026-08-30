import CoreMedia
import Foundation

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

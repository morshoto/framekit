import AppKit

@main
final class ContainerApp: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.terminate(nil)
    }
}

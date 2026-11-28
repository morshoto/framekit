// Research prototype only; intentionally refuses all Open Document events.
import AppKit

let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
let receiver = ShareEventReceiver()
receiver.register()
application.run()

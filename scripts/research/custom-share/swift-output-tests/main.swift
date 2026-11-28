import Foundation

func require(_ value: @autoclosure () -> Bool, _ message: String) {
    if !value() { fputs("\(message)\n", stderr); exit(1) }
}
func rejects(_ body: () throws -> Void) -> Bool {
    do { try body(); return false } catch { return true }
}

let manager = FileManager.default
let parent = manager.temporaryDirectory.appendingPathComponent("framekit-output-\(UUID().uuidString)", isDirectory: true)
let root = parent.appendingPathComponent("asset", isDirectory: true)
try manager.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? manager.removeItem(at: parent) }
let xml = Data("<fcpxml/>".utf8)
let expected = "979b046eafb48ab6dee711d09591a6bdef92f0b1da8780d5ecab43d760608a0a"
let output = root.appendingPathComponent("Example.fcpxml")
try xml.write(to: output)
let result = try inspectOutput(directory: root, name: "Example.fcpxml", expectedDigest: expected)
require(result.sha256 == expected && result.size == xml.count, "expected digest mismatch")
require(rejects { _ = try inspectOutput(directory: root, name: "Example.fcpxml", expectedDigest: String(repeating: "0", count: 64)) }, "stale file accepted")
require(rejects { _ = try inspectOutput(directory: root, name: "../Example.fcpxml", expectedDigest: expected) }, "traversal accepted")
let link = root.appendingPathComponent("Link.fcpxml")
try manager.createSymbolicLink(at: link, withDestinationURL: output)
require(rejects { _ = try inspectOutput(directory: root, name: "Link.fcpxml", expectedDigest: expected) }, "symlink output accepted")
let linkedRoot = parent.appendingPathComponent("linked", isDirectory: true)
try manager.createSymbolicLink(at: linkedRoot, withDestinationURL: root)
require(rejects { _ = try inspectOutput(directory: linkedRoot, name: "Example.fcpxml", expectedDigest: expected) }, "symlink directory accepted")
require(rejects { _ = try inspectOutput(directory: root, name: "Missing.fcpxml", expectedDigest: expected) }, "missing file accepted")

let foreign = parent.appendingPathComponent("foreign.fcpxml")
try xml.write(to: foreign)
let hardLink = root.appendingPathComponent("HardLink.fcpxml")
try manager.linkItem(at: foreign, to: hardLink)
let hardLinkResult = try inspectOutput(directory: root, name: "HardLink.fcpxml", expectedDigest: expected)
require(hardLinkResult.sha256 == expected, "hard-link characterization changed")

let savedFile = root.appendingPathComponent("saved.fcpxml")
let replacedFile = rejects {
    _ = try inspectOutput(directory: root, name: "Example.fcpxml", expectedDigest: expected, afterOpen: {
        try manager.moveItem(at: output, to: savedFile)
        try xml.write(to: output)
    })
}
require(replacedFile, "replaced file accepted")
try manager.removeItem(at: output)
try manager.moveItem(at: savedFile, to: output)

let moved = parent.appendingPathComponent("original", isDirectory: true)
let outside = parent.appendingPathComponent("other", isDirectory: true)
try manager.createDirectory(at: outside, withIntermediateDirectories: true)
let swapped = rejects {
    _ = try inspectOutput(directory: root, name: "Example.fcpxml", expectedDigest: expected, afterOpen: {
        try manager.moveItem(at: root, to: moved)
        try manager.createSymbolicLink(at: root, withDestinationURL: outside)
    })
}
require(swapped, "replaced directory accepted")

print("Swift descriptor-relative output controls passed")

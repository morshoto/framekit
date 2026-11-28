// Local Cocoa Scripting characterization; no Apple Event is sent.
import Foundation
import AppKit
import Carbon

@objc(ResearchSpecifierAsset)
final class SpecifierAsset: NSObject {
    @objc dynamic let uniqueID: String
    init(_ id: String) { uniqueID = id }
}

@objc(ResearchSpecifierContainer)
final class SpecifierContainer: NSObject {
    @objc dynamic var assets = [SpecifierAsset("first"), SpecifierAsset("second")]
    @objc(valueInAssetsWithUniqueID:) func asset(_ id: String) -> SpecifierAsset? {
        let matches = assets.filter { $0.uniqueID == id }
        return matches.count == 1 ? matches[0] : nil
    }
}

let suite: [String: Any] = ["Name": "Framekit Specifier Test", "AppleEventCode": "fksr", "Classes": [
    "ResearchSpecifierAsset": ["AppleEventCode": "aset"],
    "ResearchSpecifierContainer": ["AppleEventCode": "capp", "ToManyRelationships": [
        "assets": ["AppleEventCode": "aset", "Type": "ResearchSpecifierAsset"]
    ]]
]]
NSScriptSuiteRegistry.shared().loadSuite(with: suite, from: Bundle.main)
guard let description = NSScriptClassDescription(for: SpecifierContainer.self),
      description.key(withAppleEventCode: OSType(0x61736574)) == "assets" else {
    fatalError("test suite did not register its assets relationship")
}
let container = SpecifierContainer()
let specifier = NSUniqueIDSpecifier(containerClassDescription: description,
    containerSpecifier: nil, key: "assets", uniqueID: "second")
guard specifier.objectsByEvaluating(withContainers: container) as? SpecifierAsset === container.assets[1],
      let descriptor = specifier.descriptor else { fatalError("local test specifier failed") }
let context = NSScriptExecutionContext.shared()
let previous = context.topLevelObject
context.topLevelObject = container
defer { context.topLevelObject = previous }
// Characterization on the tested macOS: unlike explicit-container evaluation,
// reconstruction still returns nil even after suite and execution-context setup.
// This is not a universal assertion about a real app's scripting dictionary.
guard NSScriptObjectSpecifier(descriptor: descriptor) == nil else {
    fatalError("descriptor reconstruction behavior changed; investigate")
}
print("Registered test suite resolved the asset; descriptor reconstruction returned nil")

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("native diagnostics identify unavailable times and document-open errors", { skip: process.platform !== "darwin" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "framekit-live-times-"));
  try {
    const main = join(dir, "main.swift");
    writeFileSync(main, `import CoreMedia\nimport Foundation\nlet good = CMTime(value: 0, timescale: 24)\nlet failures = unavailableLiveTimeFields([("sequence.startTime", good), ("sequence.duration", .invalid), ("timeline.playheadTime", .indefinite)])\nprint(failures.joined(separator: ","))\nprint(validatedLivePlayhead(.invalid) == nil ? "absent" : "present")\nprint(validatedLivePlayhead(good) == nil ? "absent" : "present")\nlet underlying = NSError(domain: "NSPOSIXErrorDomain", code: 13)\nlet error = NSError(domain: "NSCocoaErrorDomain", code: 257, userInfo: [NSLocalizedDescriptionKey: "open failed", NSUnderlyingErrorKey: underlying])\nprint(deliveryErrorDescription(error))\n`);
    const bridge = resolve("adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FinalCutLiveWorkflowExtension.swift");
    const shim = resolve(".github/codeql/FinalCutWorkflowExtensionShim.swift");
    const binary = join(dir, "check");
    execFileSync("xcrun", ["swiftc", "-D", "FRAMEKIT_CODEQL", bridge, shim, main, "-o", binary], { stdio: "pipe" });
    assert.equal(execFileSync(binary, { encoding: "utf8" }).trim(), "sequence.duration,timeline.playheadTime\nabsent\npresent\nopen failed [NSCocoaErrorDomain:257; underlying NSPOSIXErrorDomain:13]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

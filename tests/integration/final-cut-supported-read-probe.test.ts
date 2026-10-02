import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  classifySupportedSurfaces,
  collectProbeReport,
  parseAppleEventDictionary,
} from "../../scripts/final-cut-supported-read-probe.mjs";

const fixturePath = new URL("../fixtures/final-cut-supported-read-probe-10.7.1.json", import.meta.url);

test("parses the exact read-only Apple Event surfaces relevant to timeline reads", () => {
  const dictionary = parseAppleEventDictionary(`
    <dictionary>
      <suite name="Final Cut Pro Library" code="fxlm">
        <access-group identifier="com.apple.FinalCut.library.inspection" access="r"/>
        <command name="get" code="coregetd"/>
        <class name="project" code="fxpj">
          <property name="id" type="text" access="r"/>
          <element type="sequence" code="fxsq" access="r"/>
        </class>
        <class name="sequence" code="fxsq">
          <property name="start time" type="media time" access="r"/>
          <property name="duration" type="media time" access="r"/>
          <property name="frame duration" type="media time" access="r"/>
        </class>
        <record-type name="media time" code="cmtm">
          <property name="value" code="cmtv" type="number"/>
          <property name="timescale" code="cmts" type="integer"/>
        </record-type>
      </suite>
    </dictionary>
  `);

  assert.deepEqual(dictionary.commands, [{ suite: "Final Cut Pro Library", suiteCode: "fxlm", name: "get", code: "coregetd" }]);
  assert.deepEqual(dictionary.accessGroups, [{ suite: "Final Cut Pro Library", suiteCode: "fxlm", identifier: "com.apple.FinalCut.library.inspection", access: "r" }]);
  assert.deepEqual(dictionary.classes.map(({ name }) => name), ["project", "sequence"]);
  assert.equal(dictionary.classes[0]?.code, "fxpj");
  assert.deepEqual(dictionary.classes[0]?.elements, [{ type: "sequence", code: "fxsq", access: "r" }]);
  assert.deepEqual(dictionary.recordTypes[0]?.properties.map(({ name }) => name), ["value", "timescale"]);
});

test("classifies captured Final Cut evidence as advisory metadata-only", async () => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const result = classifySupportedSurfaces(fixture.supportedSurfaces);

  assert.equal(result.classification, "metadata-only");
  assert.equal(result.evaluatedSurface, "Apple Event object model");
  assert.equal(result.completeSnapshotCandidate, false);
  assert.equal(result.canonicalCapabilityPromoted, false);
  assert.ok(result.missingRequirements.includes("timeline occurrences"));
  assert.ok(result.missingRequirements.includes("exact occurrence timing"));
  assert.ok(result.missingRequirements.includes("storyline relationships"));
  assert.ok(result.missingRequirements.includes("source-bound revision"));
});

test("even a complete-looking declared surface remains unpromoted pending empirical validation", () => {
  const property = (name: string, type = "text") => ({ name, type, access: "r" });
  const completeSurface = {
    appleEvents: {
      accessGroups: [{ identifier: "com.apple.FinalCut.library.inspection", suiteCode: "fxlm", access: "r" }],
      commands: [{ name: "get", suiteCode: "fxap", code: "coregetd" }],
      classes: [
        {
          name: "project",
          suiteCode: "fxlm",
          properties: ["id", "name", "revision"].map((name) => property(name)),
          elements: [{ type: "sequence", access: "r" }],
        },
        {
          name: "sequence",
          suiteCode: "fxlm",
          properties: [
            property("id"),
            property("name"),
            property("start time", "media time"),
            property("duration", "media time"),
            property("frame duration", "media time"),
          ],
          elements: [{ type: "clip occurrence", access: "r" }],
        },
        {
          name: "clip occurrence",
          suiteCode: "fxlm",
          properties: [
            property("id"),
            property("start time", "media time"),
            property("duration", "media time"),
            property("source start", "media time"),
            property("source duration", "media time"),
            property("media id"),
            property("role"),
            property("storyline"),
          ],
          elements: [],
        },
      ],
    },
    workflowExtension: { readOnlyMembers: [], stateFields: [], capabilities: {} },
  };
  const result = classifySupportedSurfaces(completeSurface);

  assert.equal(result.classification, "complete-direct-snapshot-candidate");
  assert.equal(result.completeSnapshotCandidate, true);
  assert.equal(result.canonicalCapabilityPromoted, false);
  assert.equal(result.missingRequirements.length, 0);
  assert.ok(result.promotionRequirements.some((requirement: string) => requirement.includes("collection completeness")));
});

test("does not classify unspecified or writable dictionary properties as a complete candidate", () => {
  const result = classifySupportedSurfaces({
    appleEvents: {
      accessGroups: [{ suiteCode: "fxlm", access: "r" }],
      commands: [{ name: "get", suiteCode: "fxap" }],
      classes: [
        { name: "project", suiteCode: "fxlm", properties: [{ name: "id", access: "r" }, { name: "name" }], elements: [] },
        { name: "sequence", suiteCode: "fxlm", properties: [{ name: "id", access: "r" }, { name: "name", access: "rw" }], elements: [] },
      ],
    },
  });

  assert.equal(result.classification, "metadata-only");
  assert.equal(result.completeSnapshotCandidate, false);
  assert.ok(result.missingRequirements.includes("project identity"));
  assert.ok(result.missingRequirements.includes("supported read-only query") === false);
});

test("probe reads metadata and declarations without launching or controlling Final Cut", async () => {
  const commands: string[] = [];
  const report = await collectProbeReport({
    appPath: "/Applications/Final Cut Pro.app",
    commandRunner: async (command, args) => {
      commands.push(command);
      if (command === "/usr/libexec/PlistBuddy") {
        const key = args[1]?.replace("Print :", "");
        if (args[2]?.includes("ProExtensionHost.framework")) return "41000.8.16";
        return ({
          CFBundleIdentifier: "com.apple.FinalCut",
          CFBundleShortVersionString: "10.7.1",
          CFBundleVersion: "410082",
          ProExtensionHostVersion: "41000.8.16",
        } as Record<string, string>)[key ?? ""] ?? "";
      }
      if (command === "sdef") {
        return `<dictionary><suite name="Final Cut Pro"><access-group identifier="com.apple.FinalCut.library.inspection" access="r"/><command name="get" code="getd"/><class name="project"><property name="id" access="r"/><element type="sequence" access="r"/></class><class name="sequence"><property name="id" access="r"/><property name="start time" access="r"/><property name="duration" access="r"/><property name="frame duration" access="r"/></class></suite></dictionary>`;
      }
      throw new Error(`unexpected command: ${command}`);
    },
    hostHeader: "@interface FCPXTimeline\n@property(nonatomic, readonly) FCPXSequence *activeSequence;\n- (CMTime)playheadTime;\n- (CMTime)movePlayheadTo:(CMTime)time;\n@end",
    extensionSource: "private let protocolVersion = 1\nprivate struct LiveState: Codable { let playheadTime: RationalTime? }\nEditorCapabilities(canonicalTimelineMode: \"metadata-only\", timelineSnapshotRead: false, incrementalChanges: true, liveStateRead: true, backgroundLibraryInspection: false)",
  });

  assert.deepEqual(commands, ["/usr/libexec/PlistBuddy", "/usr/libexec/PlistBuddy", "/usr/libexec/PlistBuddy", "/usr/libexec/PlistBuddy", "sdef"]);
  assert.equal(report.finalCut.version, "10.7.1");
  assert.equal(report.finalCut.build, "410082");
  assert.equal(report.finalCut.proExtensionHostVersion, "41000.8.16");
  assert.equal(report.supportedSurfaces.workflowExtension.capabilities.canonicalTimelineMode, "metadata-only");
  assert.deepEqual(report.classification, classifySupportedSurfaces(report.supportedSurfaces));
});

test("fails closed when the app or its supported dictionary cannot be inspected", async () => {
  const report = await collectProbeReport({
    appPath: "/missing/Final Cut Pro.app",
    commandRunner: async () => { throw new Error("not installed"); },
    hostHeader: "",
    extensionSource: "",
  });

  assert.equal(report.finalCut.version, null);
  assert.equal(report.classification.classification, "unsupported/unknown");
  assert.equal(report.classification.completeSnapshotCandidate, false);
  assert.equal(report.classification.canonicalCapabilityPromoted, false);
});

test("documents the advisory probe and its #415/#452 decision boundary", async () => {
  const documentation = await readFile(new URL("../../docs/final-cut/ui-free-read-capability-probe.md", import.meta.url), "utf8");

  assert.match(documentation, /pnpm run probe:final-cut-read/);
  assert.match(documentation, /#415/);
  assert.match(documentation, /#452/);
  assert.match(documentation, /never promotes `canonicalDocument\.read`/);
});

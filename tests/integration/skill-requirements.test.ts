import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSkillRequirements,
  resolveSkillRequirements,
  SkillRequirementsUnavailableError,
  type RuntimeCapabilities,
  type SkillManifest,
} from "@framekit/runtime";

function capabilities(overrides: Partial<RuntimeCapabilities["editor"]> = {}, analyzerOverrides: Partial<RuntimeCapabilities["analyzers"]> = {}): RuntimeCapabilities {
  return {
    editor: {
      projectRead: true,
      timelineSnapshotRead: true,
      timelineWrite: true,
      timelineArtifactWrite: false,
      readAfterWrite: true,
      incrementalChanges: false,
      rollback: true,
      assetDiscovery: false,
      liveStateRead: false,
      playheadWrite: false,
      frameCapture: false,
      semanticOperations: { "add-marker": true },
      ...overrides,
    },
    analyzers: {
      speechTranscribe: false,
      speechVad: false,
      audioLoudness: false,
      visualTrack: false,
      ...analyzerOverrides,
    },
  };
}

function manifest(requirements: SkillManifest["requirements"]): SkillManifest {
  return {
    contractVersion: 1,
    id: "fixture.skill",
    version: "0.0.1",
    title: "Fixture Skill",
    description: "A deterministic fixture.",
    inputSchema: { type: "object", properties: {} },
    requirements,
  };
}

test("allOf resolves editor, analyzer, and semantic operation requirements", () => {
  const result = resolveSkillRequirements(manifest({
    type: "allOf",
    requirements: [
      { type: "editor", capability: "timelineSnapshotRead" },
      { type: "analyzer", capability: "speechTranscribe" },
      { type: "operation", operation: "add-marker" },
    ],
  }), {
    capabilities: capabilities({}, { speechTranscribe: true }),
    editor: { name: "Fixture", version: "1", backend: "fixture" },
    revision: { id: "rev-2", sequence: 2, timestamp: new Date(2).toISOString() },
  });

  assert.equal(result.available, true);
  assert.equal(result.missingRequirements.length, 0);
  assert.deepEqual(result.satisfiedRequirementPath, [
    "requirements.requirements[0]",
    "requirements.requirements[1]",
    "requirements.requirements[2]",
  ]);
  assert.equal(result.context.backend, "fixture");
  assert.equal(result.context.revision?.id, "rev-2");
});

test("anyOf selects the first satisfied path deterministically", () => {
  const result = resolveSkillRequirements(manifest({
    type: "anyOf",
    requirements: [
      { type: "analyzer", capability: "speechTranscribe" },
      { type: "operation", operation: "add-marker" },
    ],
  }), { capabilities: capabilities() });

  assert.equal(result.available, true);
  assert.deepEqual(result.satisfiedRequirementPath, ["requirements.requirements[1]"]);
});

test("missing requirements identify exact diagnostics and stable reason codes", () => {
  const result = resolveSkillRequirements(manifest({
    type: "allOf",
    requirements: [
      { type: "editor", capability: "timelineWrite" },
      { type: "analyzer", capability: "speechVad" },
      { type: "operation", operation: "trim-clip" },
    ],
  }), { capabilities: capabilities({ timelineWrite: false }) });

  assert.equal(result.available, false);
  assert.deepEqual(result.reasonCodes, [
    "MISSING_EDITOR_CAPABILITY",
    "MISSING_ANALYZER_CAPABILITY",
    "UNSUPPORTED_SEMANTIC_OPERATION",
  ]);
  assert.deepEqual(result.missingRequirements.map((item) => item.name), ["timelineWrite", "speechVad", "trim-clip"]);
});

test("failed alternatives report every missing path", () => {
  const result = resolveSkillRequirements(manifest({
    type: "anyOf",
    requirements: [
      { type: "editor", capability: "timelineWrite" },
      { type: "analyzer", capability: "audioLoudness" },
    ],
  }), { capabilities: capabilities({ timelineWrite: false }) });

  assert.equal(result.available, false);
  assert.equal(result.missingRequirements.at(-1)?.code, "NO_ALTERNATIVE_SATISFIED");
  assert.deepEqual(result.missingRequirements.slice(0, 2).map((item) => item.path), [
    "requirements.requirements[0]",
    "requirements.requirements[1]",
  ]);
});

test("unknown and empty requirements fail closed", () => {
  const unknown = resolveSkillRequirements(manifest({ type: "future-capability" } as never), { capabilities: capabilities() });
  assert.equal(unknown.available, false);
  assert.deepEqual(unknown.reasonCodes, ["UNKNOWN_REQUIREMENT"]);

  const empty = resolveSkillRequirements(manifest({ type: "allOf", requirements: [] }), { capabilities: capabilities() });
  assert.equal(empty.available, false);
  assert.deepEqual(empty.reasonCodes, ["EMPTY_REQUIREMENT_GROUP"]);
});

test("assertion throws a structured unmet-requirements error", () => {
  assert.throws(
    () => assertSkillRequirements(manifest({ type: "editor", capability: "timelineWrite" }), { capabilities: capabilities({ timelineWrite: false }) }),
    (error: unknown) => {
      assert.ok(error instanceof SkillRequirementsUnavailableError);
      assert.equal(error.code, "SKILL_REQUIREMENTS_UNMET");
      assert.equal(error.availability.missingRequirements[0]?.name, "timelineWrite");
      return true;
    },
  );
});

test("metadata-only live capability sets do not satisfy mutation requirements", () => {
  const result = resolveSkillRequirements(manifest({
    type: "allOf",
    requirements: [
      { type: "editor", capability: "timelineSnapshotRead" },
      { type: "editor", capability: "timelineWrite" },
      { type: "editor", capability: "rollback" },
      { type: "operation", operation: "add-marker" },
    ],
  }), {
    capabilities: capabilities({
      timelineSnapshotRead: true,
      timelineWrite: false,
      rollback: false,
      semanticOperations: {},
      canonicalTimelineMode: "metadata-only",
      projectCatalogRead: true,
      projectSelection: true,
    }),
  });

  assert.equal(result.available, false);
  assert.deepEqual(result.missingRequirements.map((item) => item.name), ["timelineWrite", "rollback", "add-marker"]);
});

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentVideoRuntime, type RuntimeCapabilities } from "@framekit/runtime";
import { FcpxmlDocumentAdapter, FinalCutLiveAdapter } from "@framekit/final-cut";
import { createAddMarkerSkill, InMemoryEditorAdapter } from "@framekit/testkit";

async function runFixture(runtime: AgentVideoRuntime) {
  runtime.registerSkill(createAddMarkerSkill());
  const before = await runtime.inspectProject();
  const listed = runtime.listSkills();
  assert.deepEqual(listed.map((skill) => skill.id), ["fixture.add-marker"]);
  assert.equal(runtime.inspectSkill("fixture.add-marker", "0.0.2").version, "0.0.2");
  const preview = await runtime.previewSkill({
    skillId: "fixture.add-marker",
    version: "0.0.2",
    baseRevision: before.revision,
    input: { name: "Conformance", start: 1 },
  });
  assert.deepEqual(await runtime.inspectProject(), before);
  const execution = await runtime.executeSkill(preview.previewToken);
  assert.equal(execution.status, "VERIFIED");
  assert.equal(execution.rollback.attempted, false);
  const after = await runtime.inspectProject();
  assert.equal(after.timeline.markers[0]?.name, "Conformance");
  return {
    operationType: preview.plan.operations[0]?.type,
    status: execution.status,
    markerName: after.timeline.markers[0]?.name,
  };
}

test("neutral add-marker Skill passes the complete in-memory conformance lifecycle", async () => {
  const adapter = new InMemoryEditorAdapter({
    projectId: "conformance-memory",
    projectName: "Conformance",
    timelineId: "conformance-memory-timeline",
    timelineName: "Main",
    clips: [],
  });
  assert.deepEqual(await runFixture(new AgentVideoRuntime(adapter)), {
    operationType: "add-marker",
    status: "VERIFIED",
    markerName: "Conformance",
  });
});

test("the same add-marker Skill runs through the FCPXML adapter when artifact capabilities match", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-skill-conformance-"));
  const path = join(directory, "fixture.fcpxml");
  await writeFile(path, `<?xml version="1.0"?><fcpxml version="1.11"><resources/><library><event><project uid="conformance-project" name="Conformance"><sequence uid="conformance-sequence" name="Main" duration="0s"><spine/></sequence></project></event></library></fcpxml>`);
  const adapter = new FcpxmlDocumentAdapter(path);
  const capabilities = await adapter.getCapabilities();
  assert.equal(capabilities.editor.timelineArtifactWrite, true);
  assert.equal(capabilities.editor.semanticOperations?.["add-marker"], true);
  assert.deepEqual(await runFixture(new AgentVideoRuntime(adapter)), {
    operationType: "add-marker",
    status: "VERIFIED",
    markerName: "Conformance",
  });
});

test("metadata-only live mode reports the fixture Skill as unavailable", async () => {
  const metadataOnly: RuntimeCapabilities = {
    editor: {
      projectRead: false,
      timelineSnapshotRead: false,
      timelineWrite: false,
      timelineArtifactWrite: false,
      readAfterWrite: false,
      incrementalChanges: false,
      rollback: false,
      assetDiscovery: false,
      liveStateRead: true,
      playheadWrite: false,
      frameCapture: false,
      canonicalTimelineMode: "metadata-only",
      projectCatalogRead: false,
      projectSelection: false,
      semanticOperations: {},
    },
    analyzers: {
      speechTranscribe: false,
      speechVad: false,
      audioLoudness: false,
      visualTrack: false,
    },
  };
  const adapter = new FinalCutLiveAdapter({
    request: async (request) => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
        capabilities: metadataOnly,
      },
    }),
  });
  const runtime = new AgentVideoRuntime(adapter);
  runtime.registerSkill(createAddMarkerSkill());
  const inspection = await runtime.inspectSkillAvailability("fixture.add-marker");
  assert.equal(inspection.availability.available, false);
  assert.equal(inspection.availability.context.backend, "workflow-extension-ipc");
  assert.ok(inspection.availability.reasonCodes.length > 0);
});

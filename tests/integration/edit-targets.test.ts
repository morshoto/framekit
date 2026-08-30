import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FcpxmlDocumentAdapter } from "@framekit/final-cut";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

function fixtureAdapter() {
  return new InMemoryEditorAdapter({
    projectId: "project-live",
    projectName: "Live Project",
    timelineId: "sequence-live",
    timelineName: "Main",
    clips: [{ id: "clip-1", name: "Interview", start: 0, duration: 10, track: 1 }],
  });
}

test("editor timeline edits bind the active project, sequence, and verification target", async () => {
  const runtime = new AgentVideoRuntime(fixtureAdapter());
  const before = await runtime.inspectProject();

  const transaction = await runtime.editTimeline(
    { projectId: before.projectId, sequenceId: before.timeline.id },
    { type: "rename-clip", clipId: "clip-1", name: "Live rename", baseRevision: before.revision },
  );

  assert.deepEqual(transaction.target, {
    kind: "editor.timeline",
    projectId: "project-live",
    sequenceId: "sequence-live",
  });
  assert.deepEqual(transaction.verification?.target, transaction.target);
  assert.equal(transaction.after.timeline.clips[0]?.name, "Live rename");

  await assert.rejects(
    runtime.editTimeline(
      { projectId: "wrong-project", sequenceId: before.timeline.id },
      { type: "rename-clip", clipId: "clip-1", name: "Must not write", baseRevision: transaction.after.revision },
    ),
    /TARGET_MISMATCH/,
  );
  assert.equal((await runtime.inspectProject()).timeline.clips[0]?.name, "Live rename");
});

test("artifact edits mutate only the identified FCPXML artifact", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-edit-targets-"));
  const artifactPath = join(directory, "managed.fcpxml");
  await writeFile(artifactPath, `<?xml version="1.0"?><fcpxml><resources/><library><event><project uid="project-artifact" name="Artifact Project"><sequence uid="sequence-artifact" duration="1s"><spine><asset-clip id="clip-artifact" name="Original" offset="0s" duration="1s" /></spine></sequence></project></event></library></fcpxml>`);
  const runtime = new AgentVideoRuntime(new FcpxmlDocumentAdapter(artifactPath));
  const before = await runtime.inspectProject();

  assert.deepEqual(await runtime.inspectArtifact(), {
    id: `fcpxml:${artifactPath}`,
    path: artifactPath,
    format: "fcpxml",
  });

  const transaction = await runtime.editArtifact(
    artifactPath,
    { type: "rename-clip", clipId: "clip-artifact", name: "Artifact rename", baseRevision: before.revision },
  );

  assert.deepEqual(transaction.target, {
    kind: "artifact",
    artifactId: `fcpxml:${artifactPath}`,
    artifactPath,
  });
  assert.deepEqual(transaction.verification?.target, transaction.target);
  assert.match(await readFile(artifactPath, "utf8"), /name="Artifact rename"/);

  await assert.rejects(
    runtime.editTimeline(
      { projectId: before.projectId, sequenceId: before.timeline.id },
      { type: "rename-clip", clipId: "clip-artifact", name: "Must not be live", baseRevision: transaction.after.revision },
    ),
    /CAPABILITY_UNAVAILABLE: editor timeline mutation/,
  );
  await assert.rejects(
    runtime.editArtifact(
      join(directory, "other.fcpxml"),
      { type: "rename-clip", clipId: "clip-artifact", name: "Must not write", baseRevision: transaction.after.revision },
    ),
    /TARGET_MISMATCH/,
  );
  assert.match(await readFile(artifactPath, "utf8"), /name="Artifact rename"/);
});

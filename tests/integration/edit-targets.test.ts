import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FcpxmlDocumentAdapter, FinalCutProjectPublisher } from "@framekit/final-cut";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: string; text?: unknown } | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first?.text, "string");
  return first.text as string;
}

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

test("MCP publishing requires the verified artifact target and returns the created target", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-mcp-publish-"));
  const artifactPath = join(directory, "managed.fcpxml");
  await writeFile(artifactPath, `<?xml version="1.0"?><fcpxml><resources/><library><event><project uid="project-artifact" name="Artifact Project"><sequence uid="sequence-artifact" duration="1s"><spine><asset-clip id="clip-artifact" name="Original" offset="0s" duration="1s" /></spine></sequence></project></event></library></fcpxml>`);
  const runtime = new AgentVideoRuntime(new FcpxmlDocumentAdapter(artifactPath));
  const before = await runtime.inspectProject();
  const transaction = await runtime.editArtifact(
    artifactPath,
    { type: "rename-clip", clipId: "clip-artifact", name: "Published source", baseRevision: before.revision },
  );
  const server = createMcpServer(runtime, {
    projectPublisher: new FinalCutProjectPublisher({
      enabled: true,
      sourcePath: artifactPath,
      waitMs: 0,
      executor: async () => "imported",
    }),
  });
  const client = new Client({ name: "artifact-publish-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const published = await client.callTool({
      name: "artifact.publish",
      arguments: { artifactPath, transactionId: transaction.id, confirm: true },
    });
    assert.equal(published.isError, undefined);
    const result = JSON.parse(textFrom(published));
    assert.deepEqual(result.sourceTarget, { kind: "artifact", artifactPath });
    assert.deepEqual(result.createdTarget, { kind: "editor.project", projectName: "Artifact Project" });

    const unconfirmed = await client.callTool({
      name: "artifact.publish",
      arguments: { artifactPath, transactionId: transaction.id, confirm: false },
    });
    assert.equal(unconfirmed.isError, true);
    assert.match(textFrom(unconfirmed), /PUBLISH_CONFIRMATION_REQUIRED/);

    const wrongTarget = await client.callTool({
      name: "artifact.publish",
      arguments: { artifactPath: join(directory, "other.fcpxml"), transactionId: transaction.id, confirm: true },
    });
    assert.equal(wrongTarget.isError, true);
    assert.match(textFrom(wrongTarget), /PUBLISH_TARGET_MISMATCH/);
  } finally {
    await client.close();
    await server.close();
  }
});

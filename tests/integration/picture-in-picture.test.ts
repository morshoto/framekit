import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FcpxmlDocumentAdapter } from "@framekit/final-cut";
import { AgentVideoRuntime, canonicalSnapshotDigest } from "@framekit/runtime";
import type { WorkflowOperation } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

const fixture = {
  projectId: "pip-project",
  projectName: "Picture in Picture Fixture",
  timelineId: "pip-sequence",
  timelineName: "Main Edit",
  clips: [{
    id: "primary-occurrence",
    mediaId: "primary-media",
    name: "Presenter",
    start: 0,
    duration: 10,
    track: 0,
    role: "video" as const,
  }],
  media: [
    {
      mediaId: "primary-media",
      source: "/fixtures/presenter.mov",
      mediaKind: "video" as const,
      duration: 10,
      sourceDigest: "sha256:presenter",
    },
    {
      mediaId: "pip-media",
      source: "/fixtures/guest.mov",
      mediaKind: "video" as const,
      duration: 6,
      sourceDigest: "sha256:guest",
    },
  ],
};

function pipOperation(): Extract<WorkflowOperation, { type: "timeline.picture-in-picture.add" }> {
  return {
    type: "timeline.picture-in-picture.add",
    occurrenceId: "guest-pip",
    mediaId: "pip-media",
    attachedTo: "primary-occurrence",
    start: 2,
    duration: 4,
    targetLane: 1,
    position: { x: 320, y: -180 },
    scale: 0.35,
    crop: { top: 0.1, right: 0.05, bottom: 0.1, left: 0.05 },
    frame: { style: "solid", color: "#FFFFFF", width: 8 },
  };
}

function fcpxmlPipOperation(): Extract<WorkflowOperation, { type: "timeline.picture-in-picture.add" }> {
  const { frame: _frame, ...operation } = pipOperation();
  return operation;
}

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.ok(first);
  assert.equal(typeof first?.text, "string");
  return first.text as string;
}

function jsonFrom(result: unknown): any {
  const text = textFrom(result);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`MCP tool failed: ${text}`);
  }
}

test("PIP preview is non-mutating and execute verifies transform and frame state", async () => {
  const adapter = new InMemoryEditorAdapter(fixture);
  const runtime = new AgentVideoRuntime(adapter);
  const before = await runtime.inspectProject();
  const beforeDigest = canonicalSnapshotDigest(before);

  const preview = await runtime.previewEdit({
    baseRevision: before.revision,
    operations: [pipOperation()],
  });

  assert.equal(preview.expectedDiff.added.length, 1);
  assert.deepEqual(await runtime.inspectProject(), before);

  const transaction = await runtime.executeEdit(preview.previewToken);

  assert.equal(transaction.status, "VERIFIED");
  const pip = transaction.after.timeline.clips.find((clip) => clip.id === "guest-pip");
  assert.ok(pip);
  assert.equal(pip.track, 1);
  assert.equal(pip.attachedTo, "primary-occurrence");
  assert.deepEqual(pip.position, { x: 320, y: -180 });
  assert.equal(pip.scale, 0.35);
  assert.deepEqual(pip.crop, { top: 0.1, right: 0.05, bottom: 0.1, left: 0.05 });
  assert.deepEqual(pip.frame, { style: "solid", color: "#FFFFFF", width: 8 });
  assert.equal(transaction.diff.added[0]?.itemId, "guest-pip");
  assert.equal((await runtime.verifyTransaction(transaction.id)).passed, true);

  const undone = await runtime.undo(transaction.id);
  assert.equal(canonicalSnapshotDigest(undone), beforeDigest);
});

test("PIP remains available independently when masking is unavailable", async () => {
  const adapter = new InMemoryEditorAdapter(fixture);
  const runtime = new AgentVideoRuntime(adapter);
  const capabilities = await runtime.inspectEditor();

  assert.equal(capabilities.capabilities.families?.editing.pictureInPicture.available, true);
  assert.equal(capabilities.capabilities.families?.editing.masking.available, false);
});

test("MCP exposes the complete deterministic PIP preview, execute, diff, verify, undo loop", async () => {
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter(fixture));
  const server = createMcpServer(runtime);
  const client = new Client({ name: "picture-in-picture-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const before = jsonFrom(await client.callTool({ name: "project.inspect", arguments: {} }));
    const preview = jsonFrom(await client.callTool({
      name: "editor.timeline.edit.preview",
      arguments: {
        projectId: before.projectId,
        sequenceId: before.timeline.id,
        baseRevision: before.revision,
        operations: [pipOperation()],
      },
    }));
    assert.equal(preview.expectedDiff.added[0].itemId, "guest-pip");

    const transaction = jsonFrom(await client.callTool({
      name: "editor.timeline.edit.execute",
      arguments: { previewToken: preview.previewToken },
    }));
    assert.equal(transaction.status, "VERIFIED");
    assert.equal(jsonFrom(await client.callTool({
      name: "edit.diff",
      arguments: { transactionId: transaction.id },
    })).added[0].itemId, "guest-pip");
    assert.equal(jsonFrom(await client.callTool({
      name: "edit.verify",
      arguments: { transactionId: transaction.id },
    })).passed, true);
    const undone = jsonFrom(await client.callTool({
      name: "edit.undo",
      arguments: { transactionId: transaction.id },
    }));
    assert.equal(undone.timeline.clips.length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("PIP rejects invalid connected lanes, crops, and non-video media", async () => {
  const adapter = new InMemoryEditorAdapter(fixture);
  const runtime = new AgentVideoRuntime(adapter);
  const before = await runtime.inspectProject();

  await assert.rejects(
    runtime.previewEdit({
      baseRevision: before.revision,
      operations: [{ ...pipOperation(), targetLane: 0 }],
    }),
    /INVALID_OPERATION/,
  );
  await assert.rejects(
    runtime.previewEdit({
      baseRevision: before.revision,
      operations: [{ ...pipOperation(), crop: { top: 0.6, right: 0, bottom: 0.5, left: 0 } }],
    }),
    /INVALID_OPERATION/,
  );
  await assert.rejects(
    runtime.previewEdit({
      baseRevision: before.revision,
      operations: [{ ...pipOperation(), mediaId: "missing-media" }],
    }),
    /MEDIA_NOT_FOUND/,
  );
  assert.equal(canonicalSnapshotDigest(await runtime.inspectProject()), canonicalSnapshotDigest(before));
});

test("FCPXML PIP preview and undo preserve canonical artifact state", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-pip-fcpxml-"));
  const artifactPath = join(directory, "pip.fcpxml");
  const originalXml = `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.11">
  <resources>
    <asset id="primary-media" name="Presenter" src="file:///fixtures/presenter.mov" duration="10s" />
    <asset id="pip-media" name="Guest" src="file:///fixtures/guest.mov" duration="6s" />
  </resources>
  <library>
    <event name="PIP Event">
      <project uid="project-pip" name="PIP Project">
        <sequence uid="sequence-pip" name="Main Edit" duration="10s" format="r-format">
          <spine>
            <asset-clip id="primary-occurrence" name="Presenter" ref="primary-media" offset="0s" start="0s" duration="10s" />
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
  await writeFile(artifactPath, originalXml, "utf8");
  const adapter = new FcpxmlDocumentAdapter(artifactPath);
  const runtime = new AgentVideoRuntime(adapter);
  const before = await runtime.inspectProject();
  const beforeDigest = canonicalSnapshotDigest(before);

  const preview = await runtime.previewArtifactEdit(artifactPath, {
    baseRevision: before.revision,
    operations: [fcpxmlPipOperation()],
  });
  assert.equal(preview.expectedDiff.added[0]?.itemId, "guest-pip");
  assert.equal(await readFile(artifactPath, "utf8"), originalXml);

  await assert.rejects(
    runtime.previewArtifactEdit(artifactPath, {
      baseRevision: before.revision,
      operations: [pipOperation()],
    }),
    /CAPABILITY_UNAVAILABLE: FCPXML picture-in-picture frame/,
  );
  assert.equal(await readFile(artifactPath, "utf8"), originalXml);

  const transaction = await runtime.executeEdit(preview.previewToken);
  assert.equal(transaction.status, "VERIFIED");
  const pip = transaction.after.timeline.clips.find((clip) => clip.id === "guest-pip");
  assert.ok(pip);
  assert.deepEqual(pip.position, { x: 320, y: -180 });
  assert.equal(pip.scale, 0.35);
  assert.deepEqual(pip.crop, { top: 0.1, right: 0.05, bottom: 0.1, left: 0.05 });
  assert.equal(pip.frame, undefined);
  const writtenXml = await readFile(artifactPath, "utf8");
  assert.match(writtenXml, /adjust-transform/);
  assert.match(writtenXml, /<adjust-crop mode="crop">/);
  assert.match(writtenXml, /<crop-rect top="10%" right="5%" bottom="10%" left="5%"><\/crop-rect>/);
  assert.doesNotMatch(writtenXml, /frame-style|frame-color|frame-width/);

  await runtime.undo(transaction.id);
  assert.equal(canonicalSnapshotDigest(await runtime.inspectProject()), beforeDigest);
});

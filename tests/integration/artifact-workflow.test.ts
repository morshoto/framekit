import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FcpxmlDocumentAdapter } from "@framekit/final-cut";
import { AgentVideoRuntime } from "@framekit/runtime";
import {
  BACKGROUND_ARTIFACT_WORKFLOW,
} from "../../apps/mcp-server/src/routing.js";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

const FCPXML = `<?xml version="1.0"?>
<fcpxml version="1.11">
  <resources />
  <library><event><project uid="artifact-workflow-project" name="Artifact Workflow">
    <sequence uid="artifact-workflow-sequence" duration="1s"><spine>
      <asset-clip id="artifact-workflow-clip" name="Original" offset="0s" duration="1s" />
    </spine></sequence>
  </project></event></library>
</fcpxml>`;

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("MCP exposes the explicit background artifact workflow", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-artifact-workflow-"));
  const artifactPath = join(directory, "project.fcpxml");
  await writeFile(artifactPath, FCPXML);
  const server = createMcpServer(new AgentVideoRuntime(new FcpxmlDocumentAdapter(artifactPath)), {
    connectionStatus: () => ({ state: "disconnected" }),
  });
  const client = new Client({ name: "artifact-workflow-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    for (const name of [
      "artifact.inspect",
      "artifact.edit.preview",
      "artifact.edit.execute",
      "artifact.edit.diff",
      "artifact.edit.verify",
      "artifact.edit.undo",
    ]) {
      assert.ok(tools.tools.find((tool) => tool.name === name), `${name} must be registered`);
    }
    for (const name of ["artifact.edit.preview", "artifact.edit.execute", "artifact.edit.diff", "artifact.edit.verify", "artifact.edit.undo"]) {
      const tool = tools.tools.find((candidate) => candidate.name === name);
      assert.match(tool?.description ?? "", /artifact/i, name);
      assert.match(tool?.description ?? "", /Final Cut|background/i, name);
    }

    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.deepEqual(editor.workflows.artifact, {
      mode: "background-artifact",
      tools: BACKGROUND_ARTIFACT_WORKFLOW,
      requiresFinalCutFrontmost: false,
      changesOpenTimeline: false,
    });

    const route = JSON.parse(textFrom(await client.callTool({
      name: "editing.route",
      arguments: { operation: "artifact.edit" },
    })));
    assert.equal(route.status, "editor-selected");
    assert.equal(route.selectedPath, "artifact");
    assert.deepEqual(route.workflow, BACKGROUND_ARTIFACT_WORKFLOW);
    assert.match(route.reason.message, /background|artifact/i);

    const inspectedArtifact = JSON.parse(textFrom(await client.callTool({ name: "artifact.inspect", arguments: {} })));
    assert.equal(inspectedArtifact.path, artifactPath);
    assert.equal(inspectedArtifact.digest, digest(FCPXML));

    const before = JSON.parse(textFrom(await client.callTool({ name: "project.inspect", arguments: {} })));
    const preview = JSON.parse(textFrom(await client.callTool({
      name: "artifact.edit.preview",
      arguments: {
        artifactPath,
        baseRevision: before.revision,
        operations: [{
          type: "rename-clip",
          clipId: "artifact-workflow-clip",
          name: "Background rename",
        }],
      },
    })));
    assert.equal(preview.artifact.mode, "background-artifact");
    assert.equal(preview.artifact.revisionScope, "artifact");
    assert.equal(preview.artifact.digest, digest(FCPXML));
    assert.equal(preview.artifact.mutatesOpenTimeline, false);

    const executed = JSON.parse(textFrom(await client.callTool({
      name: "artifact.edit.execute",
      arguments: { previewToken: preview.previewToken },
    })));
    assert.equal(executed.status, "VERIFIED");
    assert.equal(executed.artifact.mode, "background-artifact");
    assert.equal(executed.artifact.revisionScope, "artifact");
    assert.equal(executed.artifact.digest, executed.artifactDigest);
    assert.equal(executed.artifact.mutatesOpenTimeline, false);

    const diff = JSON.parse(textFrom(await client.callTool({
      name: "artifact.edit.diff",
      arguments: { artifactPath, transactionId: executed.id },
    })));
    assert.equal(diff.provenance.surface, "artifact");
    assert.equal(diff.provenance.revisionScope, "artifact");
    assert.equal(diff.provenance.digest, executed.artifactDigest);
    assert.equal(diff.provenance.mutatesOpenTimeline, false);

    const verification = JSON.parse(textFrom(await client.callTool({
      name: "artifact.edit.verify",
      arguments: { artifactPath, transactionId: executed.id },
    })));
    assert.equal(verification.provenance.surface, "artifact");
    assert.equal(verification.provenance.revisionScope, "artifact");
    assert.equal(verification.provenance.digest, executed.artifactDigest);

    const undone = JSON.parse(textFrom(await client.callTool({
      name: "artifact.edit.undo",
      arguments: { artifactPath, transactionId: executed.id },
    })));
    assert.equal(undone.provenance.surface, "artifact");
    assert.equal(undone.provenance.revisionScope, "artifact");
    const restoredArtifact = await readFile(artifactPath, "utf8");
    assert.equal(undone.provenance.digest, digest(restoredArtifact));
    assert.match(restoredArtifact, /name="Original"/);
    assert.equal(undone.provenance.mutatesOpenTimeline, false);

    const wrongPath = await client.callTool({
      name: "artifact.edit.diff",
      arguments: { artifactPath: `${artifactPath}.other`, transactionId: executed.id },
    });
    assert.equal(wrongPath.isError, true);
    assert.match(textFrom(wrongPath), /TARGET_MISMATCH/);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact preview rejects a changed source digest before execution", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-artifact-source-"));
  const artifactPath = join(directory, "project.fcpxml");
  await writeFile(artifactPath, FCPXML);
  const adapter = new FcpxmlDocumentAdapter(artifactPath);
  const runtime = new AgentVideoRuntime(adapter);

  try {
    const before = await runtime.inspectProject();
    const preview = await runtime.previewArtifactEdit(artifactPath, {
      baseRevision: before.revision,
      operations: [{ type: "rename-clip", clipId: "artifact-workflow-clip", name: "Not applied" }],
    });
    const changed = FCPXML.replace("Original", "External change");
    await writeFile(artifactPath, changed);

    await assert.rejects(runtime.executeEdit(preview.previewToken), /ARTIFACT_SOURCE_CHANGED/);
    assert.equal(await readFile(artifactPath, "utf8"), changed);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

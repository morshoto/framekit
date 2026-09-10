import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FcpxmlDocumentAdapter,
  FinalCutSessionAdapter,
} from "@framekit/final-cut";
import type { ContextRevision, ProjectSnapshot, WorkflowOperation } from "@framekit/runtime";
import { AgentVideoRuntime } from "@framekit/runtime";

const FCPXML = `<?xml version="1.0"?>
<fcpxml version="1.11">
  <resources />
  <library><event name="Event"><project uid="project-routing" name="Routing Project">
    <sequence uid="sequence-routing" duration="1s"><spine>
      <asset-clip id="clip-routing" name="Original" offset="0s" duration="1s" />
    </spine></sequence>
  </project></event></library>
</fcpxml>`;

class TrackingFcpxmlAdapter extends FcpxmlDocumentAdapter {
  public previewCalls = 0;
  public applyCalls = 0;

  public override async previewTransaction(
    operations: WorkflowOperation[],
    expectedRevision: ContextRevision,
  ): Promise<ProjectSnapshot> {
    this.previewCalls += 1;
    return super.previewTransaction(operations, expectedRevision);
  }

  public override async applyTransaction(
    operations: WorkflowOperation[],
    expectedRevision: ContextRevision,
  ): Promise<void> {
    this.applyCalls += 1;
    return super.applyTransaction(operations, expectedRevision);
  }
}

test("Final Cut sessions route artifact composite transactions to the mutation provider", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-finalcut-routing-"));
  const artifactPath = join(directory, "project.fcpxml");

  try {
    await writeFile(artifactPath, FCPXML);
    const mutation = new TrackingFcpxmlAdapter(artifactPath);
    const runtime = new AgentVideoRuntime(new FinalCutSessionAdapter({
      snapshot: new FcpxmlDocumentAdapter(artifactPath),
      mutation,
    }));
    const before = await runtime.inspectProject();
    const inspected = await runtime.inspectEditor();

    assert.equal(inspected.capabilities.editor.compositeTransactions, true);
    assert.equal(inspected.capabilities.families?.editing.compositeTransactions.available, true);
    assert.equal(inspected.capabilities.families?.editing.compositeTransactions.backend, "fcpxml-document");

    const preview = await runtime.previewArtifactEdit(artifactPath, {
      baseRevision: before.revision,
      operations: [{ type: "rename-clip", clipId: before.timeline.clips[0]!.id, name: "Renamed" }],
    });
    assert.equal(mutation.previewCalls, 1);
    assert.equal(preview.expectedDiff.modified[0]?.after?.name, "Renamed");

    const transaction = await runtime.executeEdit(preview.previewToken);
    assert.equal(mutation.applyCalls, 1);
    assert.equal(transaction.status, "VERIFIED");
    assert.equal(transaction.after.timeline.clips[0]?.name, "Renamed");
    assert.equal(transaction.verification?.passed, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

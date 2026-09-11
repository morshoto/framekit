import assert from "node:assert/strict";
import test from "node:test";
import { FinalCutNativeAutomationAdapter } from "@framekit/final-cut";

const separator = String.fromCharCode(31);

function context(selectedName: string, undoCommand: string, selectedIdentity = selectedName ? `native:${selectedName}` : ""): string {
  return [
    "true",
    "Final Cut Pro",
    selectedName ? "1" : "0",
    selectedName,
    selectedName ? "AXClip" : "",
    undoCommand ? "true" : "false",
    "true",
    "",
    "",
    "",
    "true",
    "true",
    "timeline",
    "1",
    "false",
    "false",
    "Final Cut Pro",
    "false",
    undoCommand,
    selectedIdentity,
  ].join(separator);
}

function liveState(revision: number) {
  return {
    project: { id: "project-1", name: "Edit" },
    sequence: {
      id: "sequence-1",
      name: "Edit",
      startTime: { value: "0", timescale: "1" },
      duration: { value: "20", timescale: "1" },
      frameDuration: { value: "1", timescale: "24" },
    },
    playheadTime: { value: "3", timescale: "1" },
    sequenceTimeRange: {
      start: { value: "0", timescale: "1" },
      duration: { value: "20", timescale: "1" },
    },
    revision: {
      id: `rev-${revision}`,
      sequence: revision,
      timestamp: new Date(revision).toISOString(),
    },
  };
}

function addOccurrence(adapter: FinalCutNativeAutomationAdapter): void {
  const internals = adapter as unknown as {
    occurrenceHandles: Map<string, unknown>;
  };
  internals.occurrenceHandles.set("occurrence-1", {
    handle: "occurrence-1",
    mediaHandle: "media-1",
    name: "Subject",
    start: "2/1",
    duration: "4/1",
    timelineOffset: 120,
    sequenceId: "sequence-1",
    revision: "rev-1",
    nativeIdentity: "native:Subject",
  });
}

function rectangleMask() {
  return {
    mode: "rectangle" as const,
    bounds: { x: 0.1, y: 0.2, width: 0.6, height: 0.7 },
  };
}

test("native masking advertises a bounded path and verifies Draw Mask readback", async () => {
  const scripts: string[] = [];
  let revision = 1;
  let maskApplied = false;
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    liveState: async () => liveState(revision),
    executor: async (script) => {
      scripts.push(script);
      if (script.includes("Apply native Draw Mask")) {
        maskApplied = true;
        revision = 2;
        return "FRAMEKIT_NATIVE_MASK_READBACK|rectangle|0.1|0.2|0.6|0.7";
      }
      if (script.includes('click menu item "Undo Add Draw Mask"')) {
        maskApplied = false;
        revision = 3;
        return "undone";
      }
      if (script.includes("timelineWindowAvailable") || script.includes("set selectedName to \"\"")) {
        return context(maskApplied ? "Subject" : "Subject", maskApplied ? "Undo Add Draw Mask" : "Undo");
      }
      return "";
    },
  });
  addOccurrence(adapter);

  assert.equal(adapter.capabilities().masking, true);
  const mask = rectangleMask();
  const preview = await adapter.previewMask({ occurrenceHandle: "occurrence-1", mask });
  assert.equal(revision, 1);
  assert.deepEqual(preview.mask, mask);

  const result = await adapter.executeMask(preview.previewToken);
  assert.equal(result.verification.verified, true);
  assert.deepEqual(result.observedMask, mask);
  assert.equal(result.afterRevision.id, "rev-2");
  assert.equal(result.undoAvailable, true);
  assert.ok(scripts.some((script) => script.includes("Apply native Draw Mask")));
  assert.ok(scripts.some((script) => script.includes("FRAMEKIT_NATIVE_MASK_READBACK")));

  const undone = await adapter.undo(result.operationId);
  assert.equal(undone.undone, true);
  assert.equal(undone.verification.verified, true);
  assert.equal(revision, 3);
});

test("native masking rolls back when requested configuration is not read back", async () => {
  let revision = 1;
  let maskApplied = false;
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    liveState: async () => liveState(revision),
    executor: async (script) => {
      if (script.includes("Apply native Draw Mask")) {
        maskApplied = true;
        revision = 2;
        return "FRAMEKIT_NATIVE_MASK_READBACK|rectangle|0|0|0.5|0.5";
      }
      if (script.includes('click menu item "Undo Add Draw Mask"')) {
        maskApplied = false;
        revision = 3;
        return "undone";
      }
      if (script.includes("timelineWindowAvailable") || script.includes("set selectedName to \"\"")) {
        return context("Subject", maskApplied ? "Undo Add Draw Mask" : "Undo");
      }
      return "";
    },
  });
  addOccurrence(adapter);

  const preview = await adapter.previewMask({ occurrenceHandle: "occurrence-1", mask: rectangleMask() });
  await assert.rejects(
    adapter.executeMask(preview.previewToken),
    /FINAL_CUT_NATIVE_VERIFICATION_FAILED:.*rolled back/,
  );
  assert.equal(revision, 3);
  assert.equal(maskApplied, false);
});

test("native masking rejects a same-name occurrence with a different identity", async () => {
  let selectedIdentity = "native:Subject";
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    liveState: async () => liveState(1),
    executor: async (script) => {
      if (script.includes("timelineWindowAvailable") || script.includes("set selectedName to \"\"")) {
        return context("Subject", "Undo", selectedIdentity);
      }
      return "";
    },
  });
  addOccurrence(adapter);

  const preview = await adapter.previewMask({ occurrenceHandle: "occurrence-1", mask: rectangleMask() });
  selectedIdentity = "native:Subject-duplicate";
  await assert.rejects(
    adapter.executeMask(preview.previewToken),
    /FINAL_CUT_NATIVE_OCCURRENCE_HANDLE_STALE: selected timeline occurrence changed/,
  );
});

test("native masking rolls back when post-command context observation fails", async () => {
  let clock = 0;
  let preflightCalls = 0;
  let revision = 1;
  let maskApplied = false;
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    nativePreflightTimeoutMs: 5,
    liveState: async () => liveState(revision),
    executor: async (script) => {
      if (script.includes("on preflightResult")) {
        preflightCalls += 1;
        if (maskApplied && preflightCalls === 3) throw new Error("post-command context unavailable");
        return context("Subject", maskApplied ? "Undo Add Draw Mask" : "Undo");
      }
      if (script.includes("selectedTimelineItem")) return context("Subject", maskApplied ? "Undo Add Draw Mask" : "Undo");
      if (script.includes("Apply native Draw Mask")) {
        maskApplied = true;
        revision = 2;
        return "FRAMEKIT_NATIVE_MASK_READBACK|rectangle|0.1|0.2|0.6|0.7";
      }
      if (script.includes('click menu item "Undo Add Draw Mask"')) {
        maskApplied = false;
        revision = 3;
        return "undone";
      }
      return "";
    },
  });
  addOccurrence(adapter);

  const preview = await adapter.previewMask({ occurrenceHandle: "occurrence-1", mask: rectangleMask() });
  await assert.rejects(
    adapter.executeMask(preview.previewToken),
    /mask placement was rolled back/,
  );
  assert.equal(maskApplied, false);
  assert.equal(revision, 3);
});

test("native masking rolls back when Final Cut exposes no new apply revision", async () => {
  let clock = 0;
  let revision = 1;
  let maskApplied = false;
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    liveState: async () => liveState(revision),
    executor: async (script) => {
      if (script.includes("on preflightResult") || script.includes("selectedTimelineItem")) {
        return context("Subject", maskApplied ? "Undo Add Draw Mask" : "Undo");
      }
      if (script.includes("Apply native Draw Mask")) {
        maskApplied = true;
        return "FRAMEKIT_NATIVE_MASK_READBACK|rectangle|0.1|0.2|0.6|0.7";
      }
      if (script.includes('click menu item "Undo Add Draw Mask"')) {
        maskApplied = false;
        revision = 2;
        return "undone";
      }
      return "";
    },
  });
  addOccurrence(adapter);

  const preview = await adapter.previewMask({ occurrenceHandle: "occurrence-1", mask: rectangleMask() });
  await assert.rejects(
    adapter.executeMask(preview.previewToken),
    /mask placement was rolled back/,
  );
  assert.equal(maskApplied, false);
  assert.equal(revision, 2);
});

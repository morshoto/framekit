import assert from "node:assert/strict";
import test from "node:test";
import { FinalCutNativeAutomationAdapter } from "@framekit/final-cut";

const fieldSeparator = String.fromCharCode(31);
const recordSeparator = String.fromCharCode(30);

function context(
  selectedName: string,
  selectedRole: string,
  undoCommand: string,
): string {
  return [
    "true",
    "Final Cut Pro",
    selectedName ? "1" : "0",
    selectedName,
    selectedRole,
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
    selectedName ? `test:${selectedName}` : "",
  ].join(fieldSeparator);
}

function liveState(revision: number, playhead = "0") {
  return {
    project: { id: "project-1", name: "Edit" },
    sequence: {
      id: "sequence-1",
      name: "Edit",
      startTime: { value: "0", timescale: "1" },
      duration: { value: "20", timescale: "1" },
      frameDuration: { value: "1", timescale: "24" },
    },
    playheadTime: { value: playhead, timescale: "1" },
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

function productionOccurrenceOutput(name: string, sourceIdentity: string, timelineOffset: string): string {
  return [name, "AXClip", sourceIdentity, timelineOffset].join(fieldSeparator) + recordSeparator;
}

test("native Final Cut adapter discovers and verifies a transition between adjacent occurrences", async () => {
  const scripts: string[] = [];
  let revision = 1;
  let playhead = "0";
  let transitionAdded = false;
  const live = async () => liveState(revision, playhead);
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    liveState: live,
    sleep: async () => {},
    executor: async (script) => {
      scripts.push(script);
      if (script.includes("transitionSearchField")) {
        return ["Cross Dissolve", "fcp://transition/cross"].join(fieldSeparator) + recordSeparator;
      }
      if (script.includes("set searchQuery to \"before\"")) {
        return ["Before", "AXClip", "before-source", "before-source"].join(fieldSeparator) + recordSeparator;
      }
      if (script.includes("set searchQuery to \"after\"")) {
        return ["After", "AXClip", "after-source", "after-source"].join(fieldSeparator) + recordSeparator;
      }
      if (script.includes("set sourceIdentity to \"before-source\"")) {
        return productionOccurrenceOutput("Before", "before-source", "40");
      }
      if (script.includes("set sourceIdentity to \"after-source\"")) {
        return productionOccurrenceOutput("After", "after-source", "160");
      }
      if (script.includes("Framekit occurrence range start")) {
        playhead = script.includes("+ 40") ? "0" : "4";
        return "";
      }
      if (script.includes("Framekit occurrence range end")) {
        playhead = script.includes("+ 40") ? "4" : "8";
        return "";
      }
      if (script.includes('keystroke "p" using {control down}')) {
        playhead = script.includes('"00:00:04:00"') ? "4" : "0";
        return "";
      }
      if (script.includes("00:00:04:00")) {
        playhead = "4";
        return "";
      }
      if (script.includes("keystroke \"t\" using {command down}")) {
        transitionAdded = true;
        revision = 2;
        return "FRAMEKIT_NATIVE_TRANSITION_DURATION=1/1";
      }
      if (script.includes('click menu item "Undo Add Transition"')) {
        transitionAdded = false;
        revision = 3;
        return "undone";
      }
      if (script.includes("on preflightResult") || script.includes("set selectedName to \"\"")) {
        return context(transitionAdded ? "Cross Dissolve" : "", transitionAdded ? "transition" : "", transitionAdded ? "Undo Add Transition" : "Undo");
      }
      return "";
    },
  });

  const [transition] = await adapter.searchTransitions("Cross Dissolve");
  assert.deepEqual(transition, {
    id: "final-cut:transition:fcp://transition/cross",
    kind: "transition",
    name: "Cross Dissolve",
    vendor: "Final Cut Pro",
    identity: "fcp://transition/cross",
  });
  const [transitionById] = await adapter.searchTransitions(transition!.id);
  assert.deepEqual(transitionById, transition);
  assert.equal(scripts.some((script) => script.includes('set value of transitionSearchField to ""') && script.includes('collectTransitionMatches(UI elements of mainWindow, 0, "fcp://transition/cross", true')), true);
  assert.equal(scripts.some((script) => script.includes('menu item "Transitions" of menu 1 of menu item "Show in Workspace"')), true);
  assert.equal(scripts.filter((script) => script.includes("transitionSearchField")).every((script) => !script.includes("entire contents of front window")), true);

  const [beforeMedia] = await adapter.searchMedia("before");
  const [afterMedia] = await adapter.searchMedia("after");
  assert.ok(beforeMedia);
  assert.ok(afterMedia);
  const beforeOccurrence = (await adapter.locateOccurrence(beforeMedia.handle)).occurrences[0];
  const afterOccurrence = (await adapter.locateOccurrence(afterMedia.handle)).occurrences[0];
  assert.ok(beforeOccurrence);
  assert.ok(afterOccurrence);

  const preview = await adapter.previewTransitionAdd({
    asset: transition!,
    beforeOccurrenceHandle: beforeOccurrence.handle,
    afterOccurrenceHandle: afterOccurrence.handle,
    duration: { value: "1", timescale: "1" },
  });
  assert.deepEqual(preview.editPoint, { value: "4", timescale: "1" });
  assert.equal(revision, 1);

  const result = await adapter.executeTransitionAdd(preview.previewToken);
  assert.equal(result.verification.verified, true);
  assert.equal(result.afterRevision.id, "rev-2");
  assert.deepEqual(result.observedDuration, { value: "1", timescale: "1" });
  assert.equal(result.undoAvailable, true);
  assert.equal(scripts.some((script) => script.includes("keystroke \"t\" using {command down}")), true);
  assert.equal(scripts.filter((script) => script.includes("keystroke \"t\" using {command down}")).length, 1);
  assert.equal(scripts.some((script) => script.includes('button "Create Transition"')), true);
  assert.equal(scripts.some((script) => script.includes('countTransitionItems(UI elements of mainWindow, 0, "fcp://transition/cross"')), true);
  assert.equal(scripts.some((script) => script.includes("set durationText to \"1/1\"")), true);
  assert.equal(scripts.some((script) => script.includes("if not durationApplied then error")), true);
  assert.equal(scripts.some((script) => script.includes("Framekit occurrence range start") && script.includes('keystroke "i" using {shift down}')), true);
  assert.equal(scripts.some((script) => script.includes("Framekit occurrence range end") && script.includes('keystroke "o" using {shift down}')), true);
  assert.equal(scripts.some((script) => script.includes('click menu item "Zoom to Fit"') && script.includes("delay 0.5")), true);
  assert.equal(scripts.some((script) => script.includes("set value of searchField to searchQuery") && script.includes("key code 36")), true);
  assert.equal(scripts.some((script) => script.includes('keystroke "p" using {control down}') && script.includes('"00:00:04:00"')), true);

  const undone = await adapter.undo(result.operationId);
  assert.equal(undone.undone, true);
  assert.equal(undone.verification.verified, true);
  assert.equal(revision, 3);
});

test("native transition previews fail closed for non-adjacent or stale edit points", async () => {
  let revision = 1;
  let playhead = "0";
  let afterStart = "5/1";
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    liveState: async () => liveState(revision, playhead),
    sleep: async () => {},
    executor: async (script) => {
      if (script.includes("on preflightResult") || script.includes("set selectedName to \"\"")) {
        return context("", "", "Undo");
      }
      if (script.includes("set sourceIdentity to \"before-source\"")) return productionOccurrenceOutput("Before", "before-source", "40");
      if (script.includes("set sourceIdentity to \"after-source\"")) return productionOccurrenceOutput("After", "after-source", "160");
      if (script.includes("Framekit occurrence range start")) {
        playhead = script.includes("+ 40") ? "0" : afterStart.split("/")[0]!;
        return "";
      }
      if (script.includes("Framekit occurrence range end")) {
        playhead = script.includes("+ 40") ? "4" : String(Number(afterStart.split("/")[0]!) + 4);
        return "";
      }
      if (script.includes('keystroke "p" using {control down}')) {
        playhead = script.includes('"00:00:04:00"') ? "4" : "0";
        return "";
      }
      if (script.includes("set searchQuery to \"before\"")) return ["Before", "AXClip", "before-source", "before-source"].join(fieldSeparator) + recordSeparator;
      if (script.includes("set searchQuery to \"after\"")) return ["After", "AXClip", "after-source", "after-source"].join(fieldSeparator) + recordSeparator;
      return "";
    },
  });
  const [beforeMedia] = await adapter.searchMedia("before");
  const [afterMedia] = await adapter.searchMedia("after");
  assert.ok(beforeMedia);
  assert.ok(afterMedia);
  const before = (await adapter.locateOccurrence(beforeMedia.handle)).occurrences[0];
  let after = (await adapter.locateOccurrence(afterMedia.handle)).occurrences[0];
  assert.ok(before);
  assert.ok(after);

  await assert.rejects(
    adapter.previewTransitionAdd({
      asset: { id: "transition-1", kind: "transition", name: "Cross Dissolve", vendor: "Final Cut Pro", identity: "fcp://transition/cross" },
      beforeOccurrenceHandle: before.handle,
      afterOccurrenceHandle: after.handle,
      duration: { value: "1", timescale: "1" },
    }),
    /FINAL_CUT_NATIVE_EDIT_POINT_INVALID/,
  );

  afterStart = "4/1";
  after = (await adapter.locateOccurrence(afterMedia.handle)).occurrences[0];
  assert.ok(after);
  const validPreview = await adapter.previewTransitionAdd({
    asset: { id: "transition-1", kind: "transition", name: "Cross Dissolve", vendor: "Final Cut Pro", identity: "fcp://transition/cross" },
    beforeOccurrenceHandle: before.handle,
    afterOccurrenceHandle: after.handle,
    duration: { value: "1", timescale: "1" },
  }).catch((error) => {
    assert.fail(`expected a valid adjacent preview, got ${String(error)}`);
  });
  revision = 2;
  await assert.rejects(adapter.executeTransitionAdd(validPreview.previewToken), /FINAL_CUT_NATIVE_PREVIEW_STALE/);
});

test("native transition placement rolls back when native duration readback disagrees", async () => {
  const scripts: string[] = [];
  let revision = 1;
  let playhead = "0";
  let transitionAdded = false;
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    liveState: async () => liveState(revision, playhead),
    sleep: async () => {},
    executor: async (script) => {
      scripts.push(script);
      if (script.includes("set searchQuery to \"before\"")) return ["Before", "AXClip", "before-source", "before-source"].join(fieldSeparator) + recordSeparator;
      if (script.includes("set searchQuery to \"after\"")) return ["After", "AXClip", "after-source", "after-source"].join(fieldSeparator) + recordSeparator;
      if (script.includes("set sourceIdentity to \"before-source\"")) return productionOccurrenceOutput("Before", "before-source", "40");
      if (script.includes("set sourceIdentity to \"after-source\"")) return productionOccurrenceOutput("After", "after-source", "160");
      if (script.includes("Framekit occurrence range start")) {
        playhead = script.includes("+ 40") ? "0" : "4";
        return "";
      }
      if (script.includes("Framekit occurrence range end")) {
        playhead = script.includes("+ 40") ? "4" : "8";
        return "";
      }
      if (script.includes('keystroke "p" using {control down}')) {
        playhead = script.includes('"00:00:04:00"') ? "4" : "0";
        return "";
      }
      if (script.includes("keystroke \"t\" using {command down}")) {
        transitionAdded = true;
        revision = 2;
        return "FRAMEKIT_NATIVE_TRANSITION_DURATION=2/1";
      }
      if (script.includes('click menu item "Undo Add Transition"')) {
        transitionAdded = false;
        revision = 3;
        return "undone";
      }
      if (script.includes("on preflightResult") || script.includes("set selectedName to \"\"")) {
        return context(transitionAdded ? "Cross Dissolve" : "", transitionAdded ? "transition" : "", transitionAdded ? "Undo Add Transition" : "Undo");
      }
      return "";
    },
  });
  const [beforeMedia] = await adapter.searchMedia("before");
  const [afterMedia] = await adapter.searchMedia("after");
  assert.ok(beforeMedia);
  assert.ok(afterMedia);
  const before = (await adapter.locateOccurrence(beforeMedia.handle)).occurrences[0];
  const after = (await adapter.locateOccurrence(afterMedia.handle)).occurrences[0];
  assert.ok(before);
  assert.ok(after);
  const preview = await adapter.previewTransitionAdd({
    asset: { id: "transition-1", kind: "transition", name: "Cross Dissolve", vendor: "Final Cut Pro", identity: "fcp://transition/cross" },
    beforeOccurrenceHandle: before.handle,
    afterOccurrenceHandle: after.handle,
    duration: { value: "1", timescale: "1" },
  });

  await assert.rejects(adapter.executeTransitionAdd(preview.previewToken), /read back 2\/1.*transition placement was rolled back/);
  assert.equal(transitionAdded, false);
  assert.equal(revision, 3);
  assert.equal(scripts.some((script) => script.includes('click menu item "Undo Add Transition"')), true);
});

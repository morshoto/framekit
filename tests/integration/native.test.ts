import assert from "node:assert/strict";
import test from "node:test";
import { FinalCutNativeAutomationAdapter } from "@framekit/final-cut";

const separator = String.fromCharCode(31);

function context(frontmost: boolean, windowName: string, selectedName: string, selectedCount: number, undo: boolean): string {
  return [frontmost ? "true" : "false", windowName, String(selectedCount), selectedName, selectedName ? "UI element" : "", undo ? "true" : "false", "true"].join(separator);
}

test("native Final Cut adapter edits the active selection and uses native undo", async () => {
  const scripts: string[] = [];
  const contextOutputs = [
    context(true, "Final Cut Pro", "Interview", 1, true),
    context(true, "Final Cut Pro", "Interview Clean", 1, true),
    context(true, "Final Cut Pro", "Interview Clean", 1, true),
    context(true, "Final Cut Pro", "Interview", 1, true),
  ];
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    executor: async (script) => {
      scripts.push(script);
      return script.includes("entire contents") ? contextOutputs.shift()! : "";
    },
  });

  const result = await adapter.edit({ type: "rename-selected-clip", name: "Interview Clean" });
  assert.equal(result.verification.verified, true);
  assert.equal(result.verification.level, "selection-observed");
  assert.equal(result.before.target.name, "Interview");
  assert.equal(result.after.target.name, "Interview Clean");
  assert.match(result.command, /Apply Custom Name/);
  assert.equal(scripts.some((script) => script.includes("Apply Custom Name")), true);
  assert.equal(scripts.some((script) => script.includes("focused text field")), false);
  assert.equal(scripts.some((script) => script.includes("first text field of front window")), true);

  const undone = await adapter.undo(result.operationId);
  assert.equal(undone.undone, true);
  assert.equal(undone.context.target.name, "Interview");
  assert.equal(scripts.some((script) => script.includes('keystroke "z" using {command down}')), true);
});

test("native Final Cut adapter refuses edits without a selected clip", async () => {
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    executor: async (script) => script.includes("entire contents")
      ? context(true, "Final Cut Pro", "", 0, true)
      : "",
  });

  await assert.rejects(
    adapter.edit({ type: "set-selected-clip-gain", gainDb: -3 }),
    /FINAL_CUT_NATIVE_SELECTION_REQUIRED/,
  );
});

test("native Final Cut adapter is disabled by default", async () => {
  const adapter = new FinalCutNativeAutomationAdapter({ enabled: false });
  const inspected = await adapter.inspect();
  assert.equal(inspected.available, false);
  assert.equal(adapter.capabilities().selectionEdit, false);
  await assert.rejects(
    adapter.undo("native-op-missing"),
    /CAPABILITY_UNAVAILABLE/,
  );
});

test("native Final Cut adapter searches, locates, previews, and verifies a Blade", async () => {
  const separator = String.fromCharCode(31);
  const recordSeparator = String.fromCharCode(30);
  const scripts: string[] = [];
  let occurrenceReads = 0;
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    now: () => 1_000,
    executor: async (script) => {
      scripts.push(script);
      if (script.includes('set frontWindow to window "Final Cut Pro"')) return context(true, "Final Cut Pro", "Interview", 1, true);
      if (script.includes('AXBrowserMedia')) return `Interview${separator}AXBrowserMedia${recordSeparator}`;
      if (script.includes('set output to ""') && script.includes("xOffset")) {
        occurrenceReads += 1;
        return occurrenceReads === 1
          ? `Interview${separator}AXRow${recordSeparator}`
          : `Interview${separator}AXRow${recordSeparator}Interview${separator}AXRow${recordSeparator}`;
      }
      return "";
    },
  });

  const matches = await adapter.searchMedia("Interview");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].name, "Interview");
  assert.equal(scripts.some((script) => script.includes('set searchX to (item 1 of origin) + 240')), true);
  assert.equal(scripts.some((script) => script.includes('perform action "AXConfirm" of searchField')), false);
  assert.equal(scripts.some((script) => script.includes('keystroke "f" using {command down}')), false);
  const occurrences = await adapter.locateOccurrence(matches[0].handle);
  assert.equal(occurrences.status, "unique");
  assert.equal(occurrences.occurrences.length, 1);
  const preview = await adapter.previewBlade(occurrences.occurrences[0].handle);
  assert.equal(preview.command, "Blade at playhead");
  const result = await adapter.executeBlade(preview.previewToken);
  assert.equal(result.verification.verified, true);
  assert.equal(result.resultingSegments.length, 2);
  assert.equal(scripts.some((script) => script.includes("Blade")), true);
});

test("native Final Cut media selection refocuses Final Cut after dismissing the extension window", async () => {
  const scripts: string[] = [];
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    executor: async (script) => {
      scripts.push(script);
      if (script.includes('set frontWindow to window "Final Cut Pro"')) {
        return context(true, "Final Cut Pro", "", 0, false);
      }
      if (script.includes("click at {(item 1 of origin) + 275") && script.includes("set frontmost to true")) {
        return "selected";
      }
      if (script.includes("AXBrowserMedia")) return `Interview${separator}AXBrowserMedia${String.fromCharCode(30)}`;
      return "";
    },
  });

  const [match] = await adapter.searchMedia("Interview");
  const selected = await adapter.selectMedia(match.handle);
  assert.equal(selected.target.kind, "browser-media");
  assert.equal(scripts.filter((script) => script.includes("set frontmost to true")).length >= 2, true);
});

test("native UI transactions pause and resume live connection supervision", async () => {
  const events: string[] = [];
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    suspendLiveConnection: () => events.push("suspend"),
    resumeLiveConnection: () => events.push("resume"),
    executor: async (script) => {
      if (script.includes('set frontWindow to window "Final Cut Pro"')) return context(true, "Final Cut Pro", "", 0, false);
      if (script.includes("AXBrowserMedia")) return `Interview${separator}AXBrowserMedia${String.fromCharCode(30)}`;
      return "";
    },
  });

  await adapter.searchMedia("Interview");
  assert.deepEqual(events, ["suspend", "resume"]);
});

test("native Final Cut Blade previews expire and stale handles fail closed", async () => {
  let clock = 1_000;
  const separator = String.fromCharCode(31);
  const recordSeparator = String.fromCharCode(30);
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    now: () => clock,
    executor: async (script) => {
      if (script.includes('set frontWindow to window "Final Cut Pro"')) return context(true, "Final Cut Pro", "Interview", 1, true);
      if (script.includes('AXBrowserMedia')) return `Interview${separator}AXBrowserMedia${recordSeparator}`;
      if (script.includes('set output to ""') && script.includes("xOffset")) return `Interview${separator}AXRow${recordSeparator}`;
      return "";
    },
  });
  const [match] = await adapter.searchMedia("Interview");
  await assert.rejects(adapter.locateOccurrence("media-stale"), /MEDIA_HANDLE_STALE/);
  const located = await adapter.locateOccurrence(match.handle);
  const [occurrence] = located.occurrences;
  const preview = await adapter.previewBlade(occurrence.handle);
  clock += 31_000;
  await assert.rejects(adapter.executeBlade(preview.previewToken), /PREVIEW_STALE/);
});

test("native Final Cut rejects ambiguous occurrences and an out-of-range playhead", async () => {
  const separator = String.fromCharCode(31);
  const recordSeparator = String.fromCharCode(30);
  const liveState = async () => ({
    project: { id: "project-1", name: "Edit" },
    sequence: { id: "sequence-1", name: "Edit", startTime: { value: "0", timescale: "1" }, duration: { value: "20", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
    playheadTime: { value: "0", timescale: "1" },
    sequenceTimeRange: { start: { value: "0", timescale: "1" }, duration: { value: "20", timescale: "1" } },
    revision: { id: "rev-1", sequence: 1, timestamp: new Date(0).toISOString() },
  });
  const ambiguous = new FinalCutNativeAutomationAdapter({
    enabled: true,
    executor: async (script) => {
      if (script.includes('set frontWindow to window "Final Cut Pro"')) return context(true, "Final Cut Pro", "Interview", 1, true);
      if (script.includes('AXBrowserMedia')) return `Interview${separator}AXBrowserMedia${recordSeparator}`;
      if (script.includes("xOffset")) return `Interview${separator}AXRow${recordSeparator}Interview${separator}AXRow${recordSeparator}`;
      return "";
    },
    liveState,
  });
  const [match] = await ambiguous.searchMedia("Interview");
  const located = await ambiguous.locateOccurrence(match.handle);
  assert.equal(located.status, "ambiguous");
  await assert.rejects(ambiguous.previewBlade(located.occurrences[0].handle), /AMBIGUOUS_OCCURRENCE/);

  const outOfRange = new FinalCutNativeAutomationAdapter({
    enabled: true,
    executor: async (script) => {
      if (script.includes('set frontWindow to window "Final Cut Pro"')) return context(true, "Final Cut Pro", "Interview", 1, true);
      if (script.includes('AXBrowserMedia')) return `Interview${separator}AXBrowserMedia${recordSeparator}`;
      if (script.includes("xOffset")) return `Interview${separator}AXRow${separator}10/1${separator}2/1${recordSeparator}`;
      return "";
    },
    liveState,
  });
  const [outOfRangeMatch] = await outOfRange.searchMedia("Interview");
  const outOfRangeOccurrence = (await outOfRange.locateOccurrence(outOfRangeMatch.handle)).occurrences[0];
  await assert.rejects(outOfRange.previewBlade(outOfRangeOccurrence.handle), /PLAYHEAD_OUTSIDE_OCCURRENCE/);
});

test("native Final Cut previews and executes a primary-storyline delete range", async () => {
  let revision = 1;
  let duration = "20";
  let playhead = "0";
  const scripts: string[] = [];
  const liveState = async () => ({
    project: { id: "project-1", name: "Edit" },
    sequence: { id: "sequence-1", name: "Edit", startTime: { value: "0", timescale: "1" }, duration: { value: duration, timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
    playheadTime: { value: playhead, timescale: "1" },
    sequenceTimeRange: { start: { value: "0", timescale: "1" }, duration: { value: duration, timescale: "1" } },
    revision: { id: `rev-${revision}`, sequence: revision, timestamp: new Date(revision).toISOString() },
  });
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    liveState,
    executor: async (script) => {
      scripts.push(script);
      if (script.includes("00:00:10:00")) playhead = "10";
      if (script.includes("00:00:15:00")) playhead = "15";
      if (script.includes("key code 51")) {
        duration = "15";
        revision = 2;
      }
      if (script.includes('set frontWindow to window "Final Cut Pro"')) return context(true, "Final Cut Pro", "Interview", 1, true);
      return "";
    },
  });

  const preview = await adapter.previewDeleteRange({
    start: { value: "10", timescale: "1" },
    end: { value: "15", timescale: "1" },
  });
  assert.equal(preview.operation, "delete-range");
  assert.deepEqual(preview.expectedAfterDuration, { value: "15", timescale: "1" });
  assert.match(preview.command, /Delete primary storyline range/);
  const result = await adapter.executeDeleteRange(preview.previewToken);
  assert.equal(result.verification.verified, true);
  assert.deepEqual(result.afterDuration, { value: "15", timescale: "1" });
  assert.equal(scripts.some((script) => script.includes("00:00:10:00")), true);
  assert.equal(scripts.some((script) => script.includes("00:00:15:00")), true);
  assert.equal(scripts.some((script) => script.includes("key code 51")), true);
});

test("native Final Cut trim-to-duration deletes the tail and is idempotent when already short enough", async () => {
  let revision = 1;
  let duration = "20";
  let playhead = "0";
  const liveState = async () => ({
    project: { id: "project-1", name: "Edit" },
    sequence: { id: "sequence-1", name: "Edit", startTime: { value: "0", timescale: "1" }, duration: { value: duration, timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
    playheadTime: { value: playhead, timescale: "1" },
    sequenceTimeRange: { start: { value: "0", timescale: "1" }, duration: { value: duration, timescale: "1" } },
    revision: { id: `rev-${revision}`, sequence: revision, timestamp: new Date(revision).toISOString() },
  });
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    liveState,
    executor: async (script) => {
      if (script.includes("00:00:12:00")) playhead = "12";
      if (script.includes("00:00:20:00")) playhead = "20";
      if (script.includes("key code 51")) {
        duration = "12";
        revision = 2;
      }
      return script.includes('set frontWindow to window "Final Cut Pro"')
        ? context(true, "Final Cut Pro", "Interview", 1, true)
        : "";
    },
  });

  const preview = await adapter.previewTrimToDuration({ value: "12", timescale: "1" });
  assert.deepEqual(preview.range.start, { value: "12", timescale: "1" });
  assert.deepEqual(preview.range.end, { value: "20", timescale: "1" });
  const result = await adapter.executeTrimToDuration(preview.previewToken);
  assert.equal(result.verification.verified, true);
  assert.deepEqual(result.afterDuration, { value: "12", timescale: "1" });

  const noopPreview = await adapter.previewTrimToDuration({ value: "30", timescale: "1" });
  assert.deepEqual(noopPreview.range.start, { value: "0", timescale: "1" });
  assert.deepEqual(noopPreview.range.end, { value: "0", timescale: "1" });
  const noop = await adapter.executeTrimToDuration(noopPreview.previewToken);
  assert.equal(noop.verification.verified, true);
  assert.equal(noop.undoAvailable, false);
});

test("native Final Cut range previews reject invalid and stale ranges", async () => {
  let revision = "rev-1";
  let clock = 1_000;
  const liveState = async () => ({
    project: { id: "project-1", name: "Edit" },
    sequence: { id: "sequence-1", name: "Edit", startTime: { value: "0", timescale: "1" }, duration: { value: "20", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
    playheadTime: { value: "0", timescale: "1" },
    sequenceTimeRange: { start: { value: "0", timescale: "1" }, duration: { value: "20", timescale: "1" } },
    revision: { id: revision, sequence: 1, timestamp: new Date(0).toISOString() },
  });
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    now: () => clock,
    liveState,
    executor: async (script) => script.includes('set frontWindow to window "Final Cut Pro"')
      ? context(true, "Final Cut Pro", "Interview", 1, true)
      : "",
  });

  await assert.rejects(
    adapter.previewDeleteRange({ start: { value: "5", timescale: "1" }, end: { value: "5", timescale: "1" } }),
    /INVALID_OPERATION: delete range must have start before end/,
  );
  await assert.rejects(
    adapter.previewDeleteRange({ start: { value: "19", timescale: "1" }, end: { value: "21", timescale: "1" } }),
    /RANGE_OUT_OF_BOUNDS/,
  );
  const expiring = await adapter.previewDeleteRange({ start: { value: "5", timescale: "1" }, end: { value: "6", timescale: "1" } });
  clock += 31_000;
  await assert.rejects(adapter.executeDeleteRange(expiring.previewToken), /PREVIEW_STALE/);
  const preview = await adapter.previewDeleteRange({ start: { value: "5", timescale: "1" }, end: { value: "6", timescale: "1" } });
  revision = "rev-2";
  await assert.rejects(adapter.executeDeleteRange(preview.previewToken), /PREVIEW_STALE/);
});

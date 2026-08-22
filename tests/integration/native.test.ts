import assert from "node:assert/strict";
import test from "node:test";
import { FinalCutNativeAutomationAdapter } from "@framekit/final-cut";

const separator = String.fromCharCode(31);

function context(
  frontmost: boolean,
  windowName: string,
  selectedName: string,
  selectedCount: number,
  undo: boolean,
  timelineWindowAvailable = Boolean(windowName),
  timelineFocused = frontmost && timelineWindowAvailable,
  focusTarget = timelineFocused ? "timeline" : timelineWindowAvailable ? "unknown" : "none",
  focusAttempts = 0,
  undoCommand = undo ? "Undo" : "",
): string {
  return [
    frontmost ? "true" : "false",
    windowName,
    String(selectedCount),
    selectedName,
    selectedName ? "UI element" : "",
    undo ? "true" : "false",
    "true",
    "",
    "",
    "",
    timelineWindowAvailable ? "true" : "false",
    timelineFocused ? "true" : "false",
    focusTarget,
    String(focusAttempts),
    "",
    "",
    windowName,
    "false",
    undoCommand,
  ].join(separator);
}

function contextWithOverlay(
  frontmost: boolean,
  windowName: string,
  selectedName: string,
  selectedCount: number,
  undo: boolean,
  options: {
    timelineFocused?: boolean;
    focusTarget?: string;
    focusAttempts?: number;
    framekitWindowAvailable?: boolean;
    framekitWindowMinimized?: boolean;
    focusedWindowName?: string;
    overlayBlocked?: boolean;
  } = {},
): string {
  const values = context(
    frontmost,
    windowName,
    selectedName,
    selectedCount,
    undo,
    true,
    options.timelineFocused ?? true,
    options.focusTarget ?? (options.timelineFocused === false ? "unknown" : "timeline"),
    options.focusAttempts ?? 1,
  ).split(separator);
  values[14] = options.framekitWindowAvailable === undefined ? "false" : String(options.framekitWindowAvailable);
  values[15] = options.framekitWindowMinimized === undefined ? "false" : String(options.framekitWindowMinimized);
  values[16] = options.focusedWindowName ?? windowName;
  values[17] = options.overlayBlocked === undefined ? "false" : String(options.overlayBlocked);
  return values.join(separator);
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
      return script.includes("entire contents") || script.includes("timelineWindowAvailable") ? contextOutputs.shift()! : "";
    },
  });

  const result = await adapter.edit({ type: "rename-selected-clip", name: "Interview Clean" });
  assert.equal(result.verification.verified, true);
  assert.equal(result.verification.level, "selection-observed");
  assert.equal(result.before.target.name, "Interview");
  assert.equal(result.after.target.name, "Interview Clean");
  assert.match(result.command, /Apply Custom Name/);
  assert.equal(scripts.some((script) => script.includes("Apply Custom Name")), true);
  assert.equal(scripts.some((script) => script.includes("timelineWindowAvailable")), true);
  assert.equal(scripts.some((script) => script.includes("Apply Custom Name") && script.includes("tell application \"Final Cut Pro\" to activate")), false);
  assert.equal(scripts.some((script) => script.includes("focused text field")), false);
  assert.equal(scripts.some((script) => script.includes("first text field of front window")), true);

  const undone = await adapter.undo(result.operationId);
  assert.equal(undone.undone, true);
  assert.equal(undone.context.target.name, "Interview");
  assert.equal(scripts.some((script) => script.includes('click menu item "Undo" of menu "Edit"')), true);
  assert.equal(scripts.filter((script) => script.includes("timelineWindowAvailable")).length >= 4, true);
});

test("native Final Cut Undo recovers when frontmost is lost after preflight", async () => {
  let preflightCalls = 0;
  let undoCalls = 0;
  let renamed = false;
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    executor: async (script) => {
      if (script.includes("timelineWindowAvailable")) {
        preflightCalls += 1;
        return context(true, "Final Cut Pro", renamed ? "Interview Clean" : "Interview", 1, true);
      }
      if (script.includes("Apply Custom Name")) {
        renamed = true;
      } else if (script.includes('click menu item "Undo" of menu "Edit"')) {
        undoCalls += 1;
        if (undoCalls === 1) {
          throw new Error("FINAL_CUT_NATIVE_AUTOMATION_FAILED: execution error: Final Cut is not frontmost (-1719)");
        }
        renamed = false;
      }
      return "";
    },
  });

  const result = await adapter.edit({ type: "rename-selected-clip", name: "Interview Clean" });
  const undone = await adapter.undo(result.operationId);
  assert.equal(undone.undone, true);
  assert.equal(undone.context.target.name, "Interview");
  assert.equal(undoCalls, 2);
  assert.equal(preflightCalls >= 5, true);
});

test("native range undo uses Final Cut's Undo Delete Range command and restores duration", async () => {
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
      if (script.includes('click menu item "Undo Delete Range"')) {
        duration = "20";
        revision = 3;
      }
      return script.includes('set frontWindow to window "Final Cut Pro"')
        ? context(true, "Final Cut Pro", "Interview", 1, true, true, true, "timeline", 1, "Undo Delete Range")
        : "";
    },
  });

  const preview = await adapter.previewDeleteRange({ start: { value: "10", timescale: "1" }, end: { value: "15", timescale: "1" } });
  const result = await adapter.executeDeleteRange(preview.previewToken);
  assert.equal(result.undoAvailable, true);
  assert.equal(result.undoCommand, "Undo Delete Range");
  const undone = await adapter.undo(result.operationId);
  assert.equal(undone.undone, true);
  assert.equal(undone.verification.verified, true);
  assert.deepEqual((await liveState()).sequence.duration, { value: "20", timescale: "1" });
  assert.equal(scripts.some((script) => script.includes('click menu item "Undo Delete Range" of menu "Edit"')), true);
  assert.equal(scripts.some((script) => script.includes('menu items of menu "Edit" of menu bar 1')), true);
});

test("native Blade undo uses Final Cut's Undo Blade command", async () => {
  const recordSeparator = String.fromCharCode(30);
  const scripts: string[] = [];
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    executor: async (script) => {
      scripts.push(script);
      if (script.includes('set frontWindow to window "Final Cut Pro"')) {
        return context(true, "Final Cut Pro", "Interview", 1, true, true, true, "timeline", 1, "Undo Blade");
      }
      if (script.includes('set output to ""') && script.includes("xOffset")) {
        return `Interview${separator}${"AXRow"}${recordSeparator}Interview${separator}${"AXRow"}${recordSeparator}`;
      }
      return "";
    },
  });
  const media = { handle: "media-1", name: "Interview" };
  const occurrence = { handle: "occurrence-1", mediaHandle: media.handle, name: media.name };
  (adapter as unknown as { mediaHandles: Map<string, unknown>; occurrenceHandles: Map<string, unknown> }).mediaHandles.set(media.handle, media);
  (adapter as unknown as { mediaHandles: Map<string, unknown>; occurrenceHandles: Map<string, unknown> }).occurrenceHandles.set(occurrence.handle, occurrence);
  const preview = await adapter.previewBlade(occurrence.handle);
  const result = await adapter.executeBlade(preview.previewToken);
  assert.equal(result.undoCommand, "Undo Blade");
  const undone = await adapter.undo(result.operationId);
  assert.equal(undone.undone, true);
  assert.equal(undone.verification.verified, true);
  assert.equal(scripts.some((script) => script.includes('click menu item "Undo Blade" of menu "Edit"')), true);
});

test("native Undo fails closed when Final Cut has no enabled Undo command", async () => {
  let renamed = false;
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    executor: async (script) => {
      if (script.includes("Apply Custom Name")) renamed = true;
      return script.includes('set frontWindow to window "Final Cut Pro"')
        ? context(true, "Final Cut Pro", renamed ? "Interview Clean" : "Interview", 1, false)
        : "";
    },
  });
  const result = await adapter.edit({ type: "rename-selected-clip", name: "Interview Clean" });
  assert.equal(result.undoAvailable, false);
  await assert.rejects(adapter.undo(result.operationId), /FINAL_CUT_NATIVE_UNDO_UNAVAILABLE/);
  await assert.rejects(adapter.undo("native-op-missing"), /FINAL_CUT_NATIVE_UNDO_UNAVAILABLE/);
});

test("native Undo rejects an operation after the timeline revision changes", async () => {
  let revision = 1;
  let renamed = false;
  const liveState = async () => ({
    project: { id: "project-1", name: "Edit" },
    sequence: { id: "sequence-1", name: "Edit", startTime: { value: "0", timescale: "1" }, duration: { value: "20", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
    playheadTime: { value: "0", timescale: "1" },
    sequenceTimeRange: { start: { value: "0", timescale: "1" }, duration: { value: "20", timescale: "1" } },
    revision: { id: `rev-${revision}`, sequence: revision, timestamp: new Date(revision).toISOString() },
  });
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    liveState,
    executor: async (script) => {
      if (script.includes("Apply Custom Name")) {
        renamed = true;
        revision = 2;
      }
      return script.includes('set frontWindow to window "Final Cut Pro"')
        ? context(true, "Final Cut Pro", renamed ? "Interview Clean" : "Interview", 1, true, true, true, "timeline", 1, "Undo")
        : "";
    },
  });
  const result = await adapter.edit({ type: "rename-selected-clip", name: "Interview Clean" });
  revision = 3;
  await assert.rejects(adapter.undo(result.operationId), /FINAL_CUT_NATIVE_UNDO_STALE/);
});

test("native Undo rejects when Final Cut changes the current Undo command", async () => {
  let undoCommand = "Undo Rename";
  let renamed = false;
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    executor: async (script) => {
      if (script.includes("Apply Custom Name")) renamed = true;
      return script.includes('set frontWindow to window "Final Cut Pro"')
        ? context(true, "Final Cut Pro", renamed ? "Interview Clean" : "Interview", 1, true, true, true, "timeline", 1, undoCommand)
        : "";
    },
  });
  const result = await adapter.edit({ type: "rename-selected-clip", name: "Interview Clean" });
  undoCommand = "Undo Delete Range";
  await assert.rejects(adapter.undo(result.operationId), /FINAL_CUT_NATIVE_UNDO_COMMAND_CHANGED/);
});

test("native Undo reports failed restoration when Final Cut exposes no new revision", async () => {
  let clock = 0;
  let revision = 1;
  let renamed = false;
  const liveState = async () => ({
    project: { id: "project-1", name: "Edit" },
    sequence: { id: "sequence-1", name: "Edit", startTime: { value: "0", timescale: "1" }, duration: { value: "20", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
    playheadTime: { value: "0", timescale: "1" },
    sequenceTimeRange: { start: { value: "0", timescale: "1" }, duration: { value: "20", timescale: "1" } },
    revision: { id: `rev-${revision}`, sequence: revision, timestamp: new Date(revision).toISOString() },
  });
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    liveState,
    executor: async (script) => {
      if (script.includes("Apply Custom Name")) {
        renamed = true;
        revision = 2;
      }
      return script.includes('set frontWindow to window "Final Cut Pro"')
        ? context(true, "Final Cut Pro", renamed ? "Interview Clean" : "Interview", 1, true, true, true, "timeline", 1, "Undo")
        : "";
    },
  });
  const result = await adapter.edit({ type: "rename-selected-clip", name: "Interview Clean" });
  await assert.rejects(adapter.undo(result.operationId), /FINAL_CUT_NATIVE_UNDO_VERIFICATION_FAILED/);
});

test("native Final Cut adapter refuses edits without a selected clip", async () => {
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    executor: async (script) => script.includes("entire contents") || script.includes("timelineWindowAvailable")
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

test("native Final Cut focus uses semantic candidates and returns diagnostics without editing", async () => {
  const scripts: string[] = [];
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    executor: async (script) => {
      scripts.push(script);
      return script.includes("timelineWindowAvailable")
        ? context(true, "Final Cut Pro", "Interview", 1, true, true, true, "timeline", 2)
        : "";
    },
  });

  const focused = await adapter.focusTimeline();
  assert.equal(focused.available, true);
  assert.equal(focused.timelineFocused, true);
  assert.equal(focused.focusTarget, "timeline");
  assert.equal(focused.focusAttempts, 2);
  assert.equal(scripts.some((script) => script.includes("semanticPoints")), true);
  assert.equal(scripts.some((script) => script.includes("fallbackPoints")), true);
  assert.equal(scripts.some((script) => script.includes("AXFocusedUIElement")), true);
  assert.equal(scripts.some((script) => script.includes("key code 51")), false);
  assert.equal(scripts.some((script) => script.includes("menu item \"Marker\"")), false);
});

test("native Final Cut focus preserves the last focus diagnostic on failure", async () => {
  let clock = 0;
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    executor: async (script) => script.includes("timelineWindowAvailable")
      ? context(true, "Final Cut Pro", "Interview", 1, true, true, false, "browser", 3)
      : "",
  });

  const focused = await adapter.focusTimeline();
  assert.equal(focused.available, false);
  assert.equal(focused.error?.code, "FINAL_CUT_NATIVE_TIMELINE_FOCUS_REQUIRED");
  assert.equal(focused.frontmost, true);
  assert.equal(focused.timelineWindowAvailable, true);
  assert.equal(focused.timelineFocused, false);
  assert.equal(focused.focusTarget, "browser");
  assert.equal(focused.focusAttempts, 3);
});

test("native Final Cut preflight minimizes the Framekit overlay and raises the timeline", async () => {
  const scripts: string[] = [];
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    executor: async (script) => {
      scripts.push(script);
      return script.includes("timelineWindowAvailable")
        ? contextWithOverlay(true, "Final Cut Pro", "Interview", 1, true, {
            framekitWindowAvailable: true,
            framekitWindowMinimized: true,
            focusedWindowName: "Final Cut Pro",
          })
        : "";
    },
  });

  const focused = await adapter.focusTimeline();
  assert.equal(focused.timelineFocused, true);
  assert.equal(focused.framekitWindowAvailable, true);
  assert.equal(focused.framekitWindowMinimized, true);
  assert.equal(focused.focusedWindowName, "Final Cut Pro");
  assert.equal(scripts.some((script) => script.includes('perform action "AXMinimize" of framekitWindow')), true);
  assert.equal(scripts.some((script) => script.includes('perform action "AXRaise" of frontWindow')), true);
  assert.equal(scripts.some((script) => script.includes('perform action "AXPress" of clickedElement')), true);
  assert.equal(scripts.some((script) => script.includes('value of attribute "AXFocusedWindow"')), true);
  assert.equal(scripts.some((script) => script.includes('click button 1 of window "Framekit"')), false);
  assert.equal(scripts.some((script) => script.includes('button "close"')), false);
  assert.equal(scripts.some((script) => /click\s+button|button\s+"/i.test(script)), false);
});

test("native Final Cut returns an overlay-blocked error when Framekit cannot be minimized", async () => {
  let clock = 0;
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    executor: async (script) => script.includes("timelineWindowAvailable")
      ? contextWithOverlay(true, "Final Cut Pro", "Interview", 1, true, {
          framekitWindowAvailable: true,
          framekitWindowMinimized: false,
          focusedWindowName: "Framekit",
          timelineFocused: false,
          focusTarget: "unknown",
          overlayBlocked: true,
        })
      : "",
  });

  const focused = await adapter.focusTimeline();
  assert.equal(focused.available, false);
  assert.equal(focused.error?.code, "FINAL_CUT_NATIVE_OVERLAY_BLOCKED");
  assert.equal(focused.framekitWindowAvailable, true);
  assert.equal(focused.framekitWindowMinimized, false);
  assert.equal(focused.focusedWindowName, "Framekit");
  assert.equal(focused.overlayBlocked, true);
});

test("native Final Cut treats a Framekit-focused race as overlay blocked", async () => {
  let clock = 0;
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    executor: async (script) => script.includes("timelineWindowAvailable")
      ? contextWithOverlay(true, "Final Cut Pro", "Interview", 1, true, {
          framekitWindowAvailable: true,
          framekitWindowMinimized: true,
          focusedWindowName: "Framekit",
          timelineFocused: false,
          focusTarget: "unknown",
          overlayBlocked: true,
        })
      : "",
  });

  const focused = await adapter.focusTimeline();
  assert.equal(focused.error?.code, "FINAL_CUT_NATIVE_OVERLAY_BLOCKED");
  assert.equal(focused.focusedWindowName, "Framekit");
  assert.equal(focused.timelineFocused, false);
});

test("native Final Cut retries when the process loses frontmost status during focus", async () => {
  let clock = 0;
  let preflightCalls = 0;
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    executor: async (script) => {
      if (!script.includes("timelineWindowAvailable")) return "";
      preflightCalls += 1;
      return preflightCalls === 1
        ? contextWithOverlay(false, "Final Cut Pro", "Interview", 1, true, {
            framekitWindowAvailable: true,
            framekitWindowMinimized: true,
            focusedWindowName: "Final Cut Pro",
            timelineFocused: false,
            focusTarget: "unknown",
          })
        : contextWithOverlay(true, "Final Cut Pro", "Interview", 1, true, {
            framekitWindowAvailable: true,
            framekitWindowMinimized: true,
            focusedWindowName: "Final Cut Pro",
          });
    },
  });

  const focused = await adapter.focusTimeline();
  assert.equal(focused.available, true);
  assert.equal(focused.frontmost, true);
  assert.equal(focused.timelineFocused, true);
  assert.equal(preflightCalls >= 2, true);
});

test("native Final Cut preview fails closed when overlay recovery fails", async () => {
  let clock = 0;
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    executor: async (script) => script.includes("timelineWindowAvailable")
      ? contextWithOverlay(true, "Final Cut Pro", "Interview", 1, true, {
          framekitWindowAvailable: true,
          framekitWindowMinimized: false,
          focusedWindowName: "Framekit",
          timelineFocused: false,
          focusTarget: "unknown",
          overlayBlocked: true,
        })
      : "",
    liveState: async () => ({
      project: { id: "project-1", name: "Edit" },
      sequence: { id: "sequence-1", name: "Edit", startTime: { value: "0", timescale: "1" }, duration: { value: "20", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
      playheadTime: { value: "0", timescale: "1" },
      sequenceTimeRange: { start: { value: "0", timescale: "1" }, duration: { value: "20", timescale: "1" } },
      revision: { id: "rev-1", sequence: 1, timestamp: new Date(0).toISOString() },
    }),
  });

  await assert.rejects(
    adapter.previewDeleteRange({ start: { value: "10", timescale: "1" }, end: { value: "15", timescale: "1" } }),
    /FINAL_CUT_NATIVE_OVERLAY_BLOCKED:/,
  );
});

test("native range preview and execute share overlay preflight and fail closed before mutation", async () => {
  let clock = 0;
  let preflightCalls = 0;
  let duration = "20";
  let revision = 1;
  const scripts: string[] = [];
  const liveState = async () => ({
    project: { id: "project-1", name: "Edit" },
    sequence: { id: "sequence-1", name: "Edit", startTime: { value: "0", timescale: "1" }, duration: { value: duration, timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
    playheadTime: { value: "0", timescale: "1" },
    sequenceTimeRange: { start: { value: "0", timescale: "1" }, duration: { value: duration, timescale: "1" } },
    revision: { id: `rev-${revision}`, sequence: revision, timestamp: new Date(revision).toISOString() },
  });
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    liveState,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    executor: async (script) => {
      scripts.push(script);
      if (script.includes("timelineWindowAvailable")) {
        preflightCalls += 1;
        return preflightCalls === 1
          ? contextWithOverlay(true, "Final Cut Pro", "Interview", 1, true, { framekitWindowMinimized: true })
          : contextWithOverlay(true, "Final Cut Pro", "Interview", 1, true, {
              framekitWindowAvailable: true,
              framekitWindowMinimized: false,
              focusedWindowName: "Framekit",
              timelineFocused: false,
              focusTarget: "unknown",
              overlayBlocked: true,
            });
      }
      if (script.includes("key code 51")) {
        duration = "15";
        revision = 2;
      }
      return "";
    },
  });

  const preview = await adapter.previewDeleteRange({ start: { value: "10", timescale: "1" }, end: { value: "15", timescale: "1" } });
  await assert.rejects(adapter.executeDeleteRange(preview.previewToken), /FINAL_CUT_NATIVE_OVERLAY_BLOCKED/);
  assert.equal(preflightCalls >= 2, true);
  assert.equal(duration, "20");
  assert.equal(revision, 1);
  assert.equal(scripts.some((script) => script.includes("key code 51")), false);
});

test("native timeline preflight retries a focus race before editing", async () => {
  let clock = 0;
  let preflightCalls = 0;
  let renamed = false;
  const scripts: string[] = [];
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    executor: async (script) => {
      scripts.push(script);
      if (script.includes("timelineWindowAvailable")) {
        preflightCalls += 1;
        return preflightCalls < 3
          ? context(false, "Final Cut Pro", "Interview", 1, true, true, false, "unknown")
          : context(true, "Final Cut Pro", renamed ? "Interview Clean" : "Interview", 1, true);
      }
      if (script.includes("Apply Custom Name")) {
        renamed = true;
        return "";
      }
      return script.includes("entire contents") ? context(true, "Final Cut Pro", "Interview Clean", 1, true) : "";
    },
  });

  const result = await adapter.edit({ type: "rename-selected-clip", name: "Interview Clean" });
  assert.equal(result.verification.verified, true);
  assert.equal(preflightCalls >= 3, true);
  assert.equal(scripts.some((script) => script.includes("tell application \"Final Cut Pro\" to activate")), true);
});

test("native Final Cut recovers when frontmost is lost after preflight", async () => {
  let preflightCalls = 0;
  let editCalls = 0;
  let renamed = false;
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    executor: async (script) => {
      if (script.includes("timelineWindowAvailable")) {
        preflightCalls += 1;
        return context(true, "Final Cut Pro", renamed ? "Interview Clean" : "Interview", 1, true);
      }
      if (script.includes("Apply Custom Name")) {
        editCalls += 1;
        if (editCalls === 1) {
          throw new Error("FINAL_CUT_NATIVE_AUTOMATION_FAILED: execution error: Final Cut is not frontmost (-1719)");
        }
        renamed = true;
      }
      return "";
    },
  });

  const result = await adapter.edit({ type: "rename-selected-clip", name: "Interview Clean" });
  assert.equal(result.verification.verified, true);
  assert.equal(editCalls, 2);
  assert.equal(preflightCalls >= 3, true);
});

test("native Final Cut refuses a retry when focus recovery changes the selection", async () => {
  let preflightCalls = 0;
  let editCalls = 0;
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    executor: async (script) => {
      if (script.includes("timelineWindowAvailable")) {
        preflightCalls += 1;
        return context(true, "Final Cut Pro", preflightCalls === 1 ? "Interview" : "Other", 1, true);
      }
      if (script.includes("Apply Custom Name")) {
        editCalls += 1;
        if (editCalls === 1) {
          throw new Error("FINAL_CUT_NATIVE_AUTOMATION_FAILED: execution error: Final Cut is not frontmost (-1719)");
        }
      }
      return "";
    },
  });

  await assert.rejects(
    adapter.edit({ type: "rename-selected-clip", name: "Interview Clean" }),
    /FINAL_CUT_NATIVE_RETRY_TARGET_CHANGED/,
  );
  assert.equal(editCalls, 1);
});

test("native Final Cut refuses a retry when focus recovery changes the playhead", async () => {
  let preflightCalls = 0;
  let markerCalls = 0;
  let playhead = "0";
  const liveState = async () => ({
    project: { id: "project-1", name: "Edit" },
    sequence: { id: "sequence-1", name: "Edit", startTime: { value: "0", timescale: "1" }, duration: { value: "20", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
    playheadTime: { value: playhead, timescale: "1" },
    sequenceTimeRange: { start: { value: "0", timescale: "1" }, duration: { value: "20", timescale: "1" } },
    revision: { id: "rev-1", sequence: 1, timestamp: new Date(0).toISOString() },
  });
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    liveState,
    executor: async (script) => {
      if (script.includes("timelineWindowAvailable")) {
        preflightCalls += 1;
        if (preflightCalls === 2) playhead = "5";
        return context(true, "Final Cut Pro", "", 0, true);
      }
      if (script.includes('menu item "Marker"')) {
        markerCalls += 1;
        throw new Error("FINAL_CUT_NATIVE_AUTOMATION_FAILED: execution error: Final Cut is not frontmost (-1719)");
      }
      return "";
    },
  });

  await assert.rejects(
    adapter.edit({ type: "add-marker-at-playhead", name: "Review" }),
    /FINAL_CUT_NATIVE_RETRY_TARGET_CHANGED/,
  );
  assert.equal(markerCalls, 1);
});

test("native timeline preflight reports a missing timeline window without mutating", async () => {
  let clock = 0;
  const scripts: string[] = [];
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    executor: async (script) => {
      scripts.push(script);
      return script.includes("timelineWindowAvailable")
        ? context(false, "", "", 0, false, false, false, "none")
        : "";
    },
  });

  await assert.rejects(
    adapter.edit({ type: "add-marker-at-playhead", name: "marker" }),
    /FINAL_CUT_NATIVE_NO_TIMELINE_WINDOW/,
  );
  assert.equal(scripts.some((script) => script.includes("menu item \"Marker\"")), false);
});

test("native timeline preflight distinguishes background Final Cut and unfocused timeline targets", async () => {
  let clock = 0;
  const background = new FinalCutNativeAutomationAdapter({
    enabled: true,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    executor: async (script) => script.includes("timelineWindowAvailable")
      ? context(false, "Final Cut Pro", "Interview", 1, true, true, false, "unknown")
      : "",
  });
  await assert.rejects(
    background.edit({ type: "add-marker-at-playhead", name: "marker" }),
    /FINAL_CUT_NATIVE_NOT_FRONTMOST/,
  );

  for (const focusTarget of ["browser", "text-field"] as const) {
    clock = 0;
    const unfocused = new FinalCutNativeAutomationAdapter({
      enabled: true,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      executor: async (script) => script.includes("timelineWindowAvailable")
        ? context(true, "Final Cut Pro", "Interview", 1, true, true, false, focusTarget)
        : "",
    });
    await assert.rejects(
      unfocused.edit({ type: "add-marker-at-playhead", name: "marker" }),
      /FINAL_CUT_NATIVE_TIMELINE_FOCUS_REQUIRED/,
    );
  }
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
  assert.equal(scripts.filter((script) => script.includes("timelineWindowAvailable")).length >= 3, true);
});

test("native Final Cut media selection refocuses Final Cut without closing the extension window", async () => {
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
  assert.equal(scripts.some((script) => script.includes('click button 1 of window "Framekit"')), false);
});

test("native Final Cut preserves explicit command errors over embedded frontmost guards", async () => {
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    executor: async (script) => {
      if (script.includes('set frontWindow to window "Final Cut Pro"')) return context(true, "Final Cut Pro", "", 0, false);
      if (script.includes("AXBrowserMedia")) throw new Error("FINAL_CUT_NATIVE_AUTOMATION_FAILED: FINAL_CUT_NATIVE_SEARCH_UNAVAILABLE: Browser search field was not hit; source contains -1719 guard");
      return "";
    },
  });

  await assert.rejects(adapter.searchMedia("Interview"), /FINAL_CUT_NATIVE_SEARCH_UNAVAILABLE/);
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
  assert.equal(scripts.filter((script) => script.includes("timelineWindowAvailable")).length >= 3, true);
});

test("native range recovery restarts positioning before deleting", async () => {
  let revision = 1;
  let duration = "20";
  let playhead = "0";
  let preflightCalls = 0;
  let startPlayheadCalls = 0;
  let markStartCalls = 0;
  let endPlayheadCalls = 0;
  let deleteCalls = 0;
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
      if (script.includes("timelineWindowAvailable")) {
        preflightCalls += 1;
        return context(true, "Final Cut Pro", "Interview", 1, true);
      }
      if (script.includes("00:00:10:00")) {
        startPlayheadCalls += 1;
        playhead = "10";
      }
      if (script.includes("00:00:15:00")) {
        endPlayheadCalls += 1;
        playhead = "15";
      }
      if (script.includes('keystroke "i"')) {
        markStartCalls += 1;
        if (markStartCalls === 1) {
          throw new Error("FINAL_CUT_NATIVE_AUTOMATION_FAILED: execution error: Final Cut is not frontmost (-1719)");
        }
      }
      if (script.includes("key code 51")) {
        deleteCalls += 1;
        duration = "15";
        revision = 2;
      }
      return "";
    },
  });

  const preview = await adapter.previewDeleteRange({
    start: { value: "10", timescale: "1" },
    end: { value: "15", timescale: "1" },
  });
  const result = await adapter.executeDeleteRange(preview.previewToken);
  assert.equal(result.verification.verified, true);
  assert.equal(startPlayheadCalls, 2);
  assert.equal(markStartCalls, 2);
  assert.equal(endPlayheadCalls, 1);
  assert.equal(deleteCalls, 1);
  assert.equal(preflightCalls >= 4, true);
});

test("native Final Cut trim-to-duration deletes the tail and is idempotent when already short enough", async () => {
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
  assert.equal(scripts.filter((script) => script.includes("timelineWindowAvailable")).length >= 3, true);

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

test("native range execute re-runs preflight and fails closed before mutation", async () => {
  let clock = 0;
  let preflightReady = true;
  let deleteCommandIssued = false;
  const liveState = async () => ({
    project: { id: "project-1", name: "Edit" },
    sequence: { id: "sequence-1", name: "Edit", startTime: { value: "0", timescale: "1" }, duration: { value: "20", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
    playheadTime: { value: "0", timescale: "1" },
    sequenceTimeRange: { start: { value: "0", timescale: "1" }, duration: { value: "20", timescale: "1" } },
    revision: { id: "rev-1", sequence: 1, timestamp: new Date(0).toISOString() },
  });
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    liveState,
    executor: async (script) => {
      if (script.includes("timelineWindowAvailable")) {
        return preflightReady
          ? context(true, "Final Cut Pro", "Interview", 1, true)
          : context(false, "", "", 0, false, false, false, "none");
      }
      if (script.includes("key code 51")) deleteCommandIssued = true;
      return "";
    },
  });

  const preview = await adapter.previewDeleteRange({
    start: { value: "5", timescale: "1" },
    end: { value: "6", timescale: "1" },
  });
  preflightReady = false;
  await assert.rejects(adapter.executeDeleteRange(preview.previewToken), /FINAL_CUT_NATIVE_NO_TIMELINE_WINDOW/);
  assert.equal(deleteCommandIssued, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { FinalCutNativeAutomationAdapter } from "@framekit/final-cut";

const separator = String.fromCharCode(31);

function context(frontmost: boolean, windowName: string, selectedName: string, selectedCount: number, undo: boolean): string {
  return [frontmost ? "true" : "false", windowName, String(selectedCount), selectedName, selectedName ? "UI element" : "", undo ? "true" : "false"].join(separator);
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

import assert from "node:assert/strict";
import test from "node:test";
import { FinalCutNativeAutomationAdapter } from "@framekit/final-cut";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const fieldSeparator = String.fromCharCode(31);
const recordSeparator = String.fromCharCode(30);

test("headed title evidence records the revision restored by Undo", async () => {
  const runner = await readFile(join(process.cwd(), "scripts/final-cut-title-discovery-headed-e2e.mjs"), "utf8");
  assert.match(runner, /undoRevision:\s*undone\.context\?\.revision\?\.id/);
  assert.match(runner, /target:\s*\{\s*sequenceId:\s*preview\.sequenceId/);
});

function context(frontmost = true): string {
  return [
    String(frontmost),
    "Final Cut Pro",
    "0",
    "",
    "",
    "false",
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
    "Undo",
    "",
  ].join(fieldSeparator);
}

function browserContext(frontmost = true): string {
  return [String(frontmost), "true"].join(fieldSeparator);
}

test("native Final Cut adapter discovers stable title assets without a timeline", async () => {
  const scripts: string[] = [];
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    nativePreflightTimeoutMs: 1,
    sleep: async () => {},
    executor: async (script) => {
      scripts.push(script);
      if (script.includes("titleBrowserPreflightResult")) return browserContext();
      if (script.includes("titleSearchField")) {
        return ["Lower Third", "fcp://title/lower-third"].join(fieldSeparator) + recordSeparator;
      }
      throw new Error("timeline preflight should not run for title discovery");
    },
  });

  const titles = await adapter.searchTitles("Lower Third");

  assert.deepEqual(titles, [{
    id: "final-cut:title:fcp://title/lower-third",
    kind: "title",
    name: "Lower Third",
    vendor: "Final Cut Pro",
    identity: "fcp://title/lower-third",
  }]);
  assert.equal(scripts.some((script) => script.includes("on preflightResult")), false);
  assert.equal(scripts.some((script) => script.includes("titleBrowserPreflightResult")), true);
  assert.equal(scripts.some((script) => script.includes("titleSearchField")), true);
});

test("native title discovery fails closed when the browser returns no assets", async () => {
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    executor: async (script) => script.includes("titleBrowserPreflightResult") ? browserContext() : "",
  });

  assert.equal(adapter.capabilities().titleDiscovery, true);
  await assert.rejects(
    adapter.searchTitles(""),
    /FINAL_CUT_NATIVE_TITLE_DISCOVERY_EMPTY/,
  );
  assert.equal(adapter.capabilities().titleDiscovery, false);
});

test("native title discovery capability follows the enabled native provider", () => {
  const enabled = new FinalCutNativeAutomationAdapter({ enabled: true });
  const disabled = new FinalCutNativeAutomationAdapter({ enabled: false });

  assert.equal(enabled.capabilities().titleDiscovery, true);
  assert.equal(disabled.capabilities().titleDiscovery, false);
});

test("native title discovery fails closed without browser identities or frontmost access", async () => {
  const missingIdentity = new FinalCutNativeAutomationAdapter({
    enabled: true,
    executor: async (script) => {
      if (script.includes("titleBrowserPreflightResult")) return browserContext();
      return ["Lower Third", ""].join(fieldSeparator) + recordSeparator;
    },
  });
  await assert.rejects(missingIdentity.searchTitles("Lower Third"), /FINAL_CUT_NATIVE_TITLE_ID_UNAVAILABLE/);

  const background = new FinalCutNativeAutomationAdapter({
    enabled: true,
    nativePreflightTimeoutMs: 1,
    sleep: async () => {},
    executor: async (script) => script.includes("titleBrowserPreflightResult") ? browserContext(false) : "",
  });
  await assert.rejects(background.searchTitles("Lower Third"), /FINAL_CUT_NATIVE_NOT_FRONTMOST/);

  const disabled = new FinalCutNativeAutomationAdapter({ enabled: false });
  await assert.rejects(disabled.searchTitles("Lower Third"), /CAPABILITY_UNAVAILABLE/);
});

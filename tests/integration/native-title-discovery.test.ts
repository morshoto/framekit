import assert from "node:assert/strict";
import test from "node:test";
import { FinalCutNativeAutomationAdapter } from "@framekit/final-cut";

const fieldSeparator = String.fromCharCode(31);
const recordSeparator = String.fromCharCode(30);

function context(): string {
  return [
    "true",
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

test("native Final Cut adapter discovers stable title assets", async () => {
  const scripts: string[] = [];
  const adapter = new FinalCutNativeAutomationAdapter({
    enabled: true,
    executor: async (script) => {
      scripts.push(script);
      if (script.includes("on preflightResult") || script.includes('set selectedName to ""')) return context();
      if (script.includes("titleSearchField")) {
        return ["Lower Third", "fcp://title/lower-third"].join(fieldSeparator) + recordSeparator;
      }
      return "";
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
  assert.equal(scripts.some((script) => script.includes("titleSearchField")), true);
});

test("native title discovery capability follows the enabled native provider", () => {
  const enabled = new FinalCutNativeAutomationAdapter({ enabled: true });
  const disabled = new FinalCutNativeAutomationAdapter({ enabled: false });

  assert.equal(enabled.capabilities().titleDiscovery, true);
  assert.equal(disabled.capabilities().titleDiscovery, false);
});

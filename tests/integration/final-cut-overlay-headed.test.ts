import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";

const runnerPath = join(process.cwd(), "scripts/final-cut-overlay-headed-e2e.mjs");
const e2eDocsPath = join(process.cwd(), "docs/tests/final-cut-live-e2e.md");
const accessibilityModulePath = "../../scripts/final-cut-overlay-accessibility.mjs";

test("headed overlay probe discovers Framekit windows owned by Final Cut", async () => {
  const { ensureFramekitWindowVisible } = await import(accessibilityModulePath);
  const scripts: string[] = [];
  const visible = await ensureFramekitWindowVisible(async (_command: string, args: string[]) => {
    scripts.push(args[1] ?? "");
    return { stdout: "false" };
  });

  assert.equal(visible, false);
  assert.match(scripts[0], /tell process "Final Cut Pro"/);
  assert.match(scripts[0], /repeat with candidateWindow in windows/);
  assert.match(scripts[0], /candidateWindowName contains "Framekit"/);
  assert.match(scripts[0], /set framekitWindow to contents of candidateWindow/);
  assert.match(scripts[0], /set finalCutProcess to process "Final Cut Pro"/);
  assert.match(scripts[0], /end tell\s+if framekitWindow is missing value[\s\S]*repeat with candidateProcess in processes/);
  assert.doesNotMatch(scripts[0], /window "Framekit"/);
});

test("headed overlay probe reports actionable Accessibility diagnostics", async () => {
  const { ensureFramekitWindowVisible } = await import(accessibilityModulePath);
  const cases = [
    ["FINAL_CUT_E2E_ACCESSIBILITY_PERMISSION_REQUIRED", "Accessibility permission"],
    ["FINAL_CUT_E2E_FINAL_CUT_PROCESS_MISSING", "Open Final Cut Pro"],
    ["FINAL_CUT_E2E_OVERLAY_WRONG_PROCESS", "outside Final Cut Pro"],
    ["FINAL_CUT_E2E_OVERLAY_WINDOW_MISSING", "open the Framekit extension"],
  ] as const;

  for (const [code, guidance] of cases) {
    await assert.rejects(
      ensureFramekitWindowVisible(async () => {
        throw new Error(code);
      }),
      (error: unknown) => {
        assert.match(String(error), new RegExp(code));
        assert.match(String(error), new RegExp(guidance, "i"));
        assert.doesNotMatch(String(error), /private|media|osascript -e/i);
        return true;
      },
    );
  }
});

test("headed overlay probe fails closed unless visibility is explicitly verified", async () => {
  const { ensureFramekitWindowVisible } = await import(accessibilityModulePath);

  for (const stdout of ["true", "", "unexpected"] as const) {
    await assert.rejects(
      ensureFramekitWindowVisible(async () => ({ stdout })),
      /FINAL_CUT_E2E_OVERLAY_NOT_VISIBLE: the Framekit window could not be made visible/i,
    );
  }
});

test("headed runner delegates overlay preparation to the bounded probe", async () => {
  const runner = await readFile(runnerPath, "utf8");

  assert.match(runner, /final-cut-overlay-accessibility\.mjs/);
  assert.match(runner, /ensureFramekitWindowVisible/);
  assert.doesNotMatch(runner, /window "Framekit"/);
  assert.ok(runner.indexOf("ensureFramekitWindowVisible()") < runner.indexOf('callJson("editor.native.trim-to-duration.preview"'));
});

test("headed overlay documentation explains Accessibility recovery diagnostics", async () => {
  const documentation = await readFile(e2eDocsPath, "utf8");

  assert.match(documentation, /FINAL_CUT_E2E_ACCESSIBILITY_PERMISSION_REQUIRED/);
  assert.match(documentation, /FINAL_CUT_E2E_FINAL_CUT_PROCESS_MISSING/);
  assert.match(documentation, /FINAL_CUT_E2E_OVERLAY_WRONG_PROCESS/);
  assert.match(documentation, /FINAL_CUT_E2E_OVERLAY_WINDOW_MISSING/);
  assert.match(documentation, /FINAL_CUT_E2E_OVERLAY_NOT_VISIBLE/);
  assert.match(documentation, /do not expose private paths\s+or media/i);
});

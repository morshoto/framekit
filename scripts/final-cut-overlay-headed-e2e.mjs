import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile as execFileCallback } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const execFile = promisify(execFileCallback);
const expectedProject = process.env.FRAMEKIT_FINAL_CUT_E2E_PROJECT;

if (!expectedProject) {
  throw new Error("Set FRAMEKIT_FINAL_CUT_E2E_PROJECT before running the overlay headed E2E");
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", join(root, "apps/mcp-server/src/main.ts")],
  env: {
    ...process.env,
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_AUTO_CONNECT: "0",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "1",
  },
  stderr: "pipe",
});
const client = new Client({ name: "framekit-overlay-headed-e2e", version: "0.1.0" });

try {
  await client.connect(transport);
  const visible = await framekitWindowMinimized();
  if (visible !== false) {
    throw new Error("FINAL_CUT_E2E_OVERLAY_NOT_VISIBLE: leave the Framekit window visible over Final Cut before running this test");
  }

  const focused = await callJson("editor.native.focus");
  if (!focused.available || !focused.frontmost || !focused.timelineWindowAvailable || !focused.timelineFocused || focused.focusTarget !== "timeline") {
    throw new Error(`FINAL_CUT_E2E_OVERLAY_FOCUS_FAILED: ${focused.error?.code ?? "FINAL_CUT_NATIVE_TIMELINE_FOCUS_REQUIRED"}: ${focused.error?.message ?? "timeline focus was not verified"}`);
  }
  if (focused.framekitWindowAvailable !== true || focused.framekitWindowMinimized !== true || focused.focusedWindowName !== "Final Cut Pro") {
    throw new Error("FINAL_CUT_E2E_OVERLAY_NOT_MINIMIZED: Framekit was not detected and minimized while focusing Final Cut");
  }

  const liveBefore = await callJson("editor.live.inspect");
  if (liveBefore.project?.name !== expectedProject) {
    throw new Error(`FINAL_CUT_E2E_PROJECT_MISMATCH: expected ${expectedProject}, observed ${liveBefore.project?.name ?? "unknown"}`);
  }
  const originalDuration = liveBefore.sequenceTimeRange?.duration ?? liveBefore.sequence?.duration;
  const frameDuration = liveBefore.sequence?.frameDuration;
  if (!originalDuration || !frameDuration) throw new Error("FINAL_CUT_E2E_DURATION_UNAVAILABLE: live sequence duration is required");
  const oneSecond = { value: frameDuration.timescale, timescale: frameDuration.timescale };
  const targetDuration = subtractRational(originalDuration, oneSecond);
  if (BigInt(targetDuration.value) <= 0n) throw new Error("FINAL_CUT_E2E_DURATION_TOO_SHORT: disposable trim requires a sequence longer than one second");

  const preview = await callJson("editor.native.trim-to-duration.preview", { duration: targetDuration });
  const trimmed = await callJson("editor.native.trim-to-duration.execute", { previewToken: preview.previewToken });
  if (!trimmed.verification?.verified) throw new Error("FINAL_CUT_E2E_TRIM_VERIFICATION_FAILED: disposable trim was not verified");
  await assertLiveDuration(targetDuration, "trim");
  await callJson("editor.native.undo", { operationId: trimmed.operationId });
  await assertLiveDuration(originalDuration, "undo");

  process.stdout.write(JSON.stringify({
    passed: true,
    project: expectedProject,
    overlayDetected: focused.framekitWindowAvailable,
    overlayMinimized: focused.framekitWindowMinimized,
    focusedWindow: focused.focusedWindowName,
    trimOperationId: trimmed.operationId,
    restored: true,
  }, null, 2));
  process.stdout.write("\n");
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

async function framekitWindowMinimized() {
  const script = `
tell application "System Events"
  tell process "Final Cut Pro"
    try
      return (value of attribute "AXMinimized" of window "Framekit") as text
    on error
      error "FINAL_CUT_E2E_OVERLAY_WINDOW_MISSING"
    end try
  end tell
end tell`;
  const result = await execFile("osascript", ["-e", script]);
  return result.stdout.trim() === "true";
}

async function callJson(name, arguments_ = {}) {
  const result = await client.callTool({ name, arguments: arguments_ });
  const text = result.content?.find((item) => item.type === "text")?.text ?? "";
  if (result.isError) throw new Error(text || `${name} failed`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} returned invalid JSON: ${text}`);
  }
}

async function assertLiveDuration(expected, operation) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const live = await callJson("editor.live.inspect");
    const actual = live.sequenceTimeRange?.duration ?? live.sequence?.duration;
    if (actual && sameRational(actual, expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`FINAL_CUT_E2E_${operation.toUpperCase().replaceAll("-", "_")}_DURATION_FAILED`);
}

function subtractRational(left, right) {
  const leftValue = BigInt(left.value);
  const leftScale = BigInt(left.timescale);
  const rightValue = BigInt(right.value);
  const rightScale = BigInt(right.timescale);
  return normalizeRational(leftValue * rightScale - rightValue * leftScale, leftScale * rightScale);
}

function sameRational(left, right) {
  return BigInt(left.value) * BigInt(right.timescale) === BigInt(right.value) * BigInt(left.timescale);
}

function normalizeRational(value, scale) {
  const divisor = gcd(value < 0n ? -value : value, scale);
  return { value: (value / divisor).toString(), timescale: (scale / divisor).toString() };
}

function gcd(left, right) {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a || 1n;
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceEnvironment, sanitizeRoughCutEvidence } from "./final-cut-evidence.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expectedProject = process.env.FRAMEKIT_FINAL_CUT_E2E_PROJECT;
const mediaPath = process.env.FRAMEKIT_FINAL_CUT_E2E_MEDIA_PATH;
const mediaDirectory = process.env.FRAMEKIT_FINAL_CUT_E2E_MEDIA_DIRECTORY;
const titleQuery = process.env.FRAMEKIT_FINAL_CUT_E2E_TITLE_QUERY;
const titleText = process.env.FRAMEKIT_FINAL_CUT_E2E_TITLE_TEXT ?? "Framekit rough-cut proof";
const placement = process.env.FRAMEKIT_FINAL_CUT_E2E_PLACEMENT ?? "append";
const titleDuration = parseRational(process.env.FRAMEKIT_FINAL_CUT_E2E_TITLE_DURATION ?? "3/1");

if (process.argv.includes("--help")) {
  process.stdout.write([
    "Headed native Final Cut rough-cut acceptance E2E",
    "",
    "Required:",
    "  FRAMEKIT_FINAL_CUT_E2E_PROJECT=exact-disposable-project-name",
    "  FRAMEKIT_FINAL_CUT_E2E_MEDIA_PATH=/absolute/path/to/exact-video.mov",
    "  FRAMEKIT_FINAL_CUT_E2E_TITLE_QUERY=title-browser-search-query",
    "",
    "Optional:",
    "  FRAMEKIT_FINAL_CUT_E2E_MEDIA_DIRECTORY=directory-for-directory-workflow-status",
    "  FRAMEKIT_FINAL_CUT_E2E_PLACEMENT=append|insert",
    "  FRAMEKIT_FINAL_CUT_E2E_TITLE_TEXT=title-text",
    "  FRAMEKIT_FINAL_CUT_E2E_TITLE_DURATION=positive-value/timescale",
    "",
    "The resulting rough cut remains in the disposable Final Cut project.",
  ].join("\n"));
  process.stdout.write("\n");
  process.exit(0);
}

if (!expectedProject || !titleQuery) {
  throw new Error("Set FRAMEKIT_FINAL_CUT_E2E_PROJECT and FRAMEKIT_FINAL_CUT_E2E_TITLE_QUERY before running the headed rough-cut E2E");
}
if (placement !== "append" && placement !== "insert") {
  throw new Error("FRAMEKIT_FINAL_CUT_E2E_PLACEMENT must be append or insert");
}
if (!mediaPath && !mediaDirectory) {
  throw new Error("Set FRAMEKIT_FINAL_CUT_E2E_MEDIA_PATH or FRAMEKIT_FINAL_CUT_E2E_MEDIA_DIRECTORY before running the headed rough-cut E2E");
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", join(root, "apps/mcp-server/src/main.ts")],
  env: {
    ...process.env,
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_AUTO_CONNECT: "1",
    FRAMEKIT_FINAL_CUT_HEADLESS: "0",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "1",
  },
  stderr: "pipe",
});
const client = new Client({ name: "framekit-rough-cut-headed-e2e", version: "0.1.0" });
const stepResults = [
  "connection.status",
  "editor.inspect",
  "editor.native.inspect",
  "editor.live.inspect.before",
  "preflight.trim.preview",
  "preflight.trim.execute",
  "preflight.undo",
  "preflight.live.inspect.restored",
  "media.resolve",
  "media.import",
  "media.discover",
  "media.select",
  "rough-cut.live.inspect.before",
  "media.placement.preview",
  "media.placement.execute",
  "media.occurrence.verify",
  "animation.discover",
  "animation.preview",
  "animation.execute",
  "rough-cut.live.inspect.after",
].map((name) => ({ name, status: "unrun" }));
const toolResults = [];

const exitCode = await run();
process.exitCode = exitCode;

async function run() {
  try {
    await client.connect(transport);

    const connection = await runStep("connection.status", async () => {
      let latest;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        latest = await callJson("connection.status");
        if (latest.state === "ready") {
          recordTool("connection.status");
          return latest;
        }
        await delay(500);
      }
      throw new Error(`FINAL_CUT_E2E_CONNECTION_UNAVAILABLE: ${latest?.state ?? "unknown"}`);
    });
    if (connection.state !== "ready") throw new Error("FINAL_CUT_E2E_CONNECTION_UNAVAILABLE: connection did not become ready");

    const inspected = await runStep("editor.inspect", async () => {
      const result = await callJson("editor.inspect");
      recordTool("editor.inspect");
      const processMode = result.preflight?.processMode ?? result.processMode;
      if (processMode !== "headed") throw new Error(`CAPABILITY_UNAVAILABLE: headed process mode is required, observed ${processMode ?? "unknown"}`);
      requireCapabilities(result.native, [
        "mediaLibrarySearch",
        "mediaImport",
        "mediaSelection",
        "mediaAppend",
        "mediaInsert",
        "titleDiscovery",
        "titlePlacement",
        "timelineFocus",
        "undo",
      ]);
      return result;
    });

    await runStep("editor.native.inspect", async () => {
      const result = await callJson("editor.native.inspect");
      recordTool("editor.native.inspect");
      if (!result.available || !result.frontmost || !result.timelineWindowAvailable || !result.timelineFocused || result.focusTarget !== "timeline") {
        throw new Error(`CAPABILITY_UNAVAILABLE: headed Final Cut timeline preflight failed (${result.error?.code ?? "timeline focus required"})`);
      }
      if (result.project && result.project !== expectedProject) {
        throw new Error(`FINAL_CUT_E2E_PROJECT_MISMATCH: expected ${expectedProject}, observed ${result.project}`);
      }
      return result;
    });

    const liveBefore = await runStep("editor.live.inspect.before", async () => {
      const result = await callJson("editor.live.inspect");
      recordTool("editor.live.inspect");
      requireLiveTarget(result, expectedProject);
      return result;
    });

    const preflight = await disposableUndoPreflight(liveBefore);
    const resolution = await runStep("media.resolve", async () => resolveMediaInput(mediaPath, mediaDirectory));
    const imported = await runStep("media.import", async () => {
      const result = await callJson("editor.native.media.import", { path: resolution.path });
      recordTool("editor.native.media.import");
      if (result.kind !== "video" || !result.mediaHandle || !result.name || basename(result.sourcePath ?? "") !== basename(resolution.path)) {
        throw new Error("FINAL_CUT_E2E_MEDIA_IMPORT_FAILED: import did not return a stable video handle and exact filename");
      }
      return result;
    });

    const discovered = await runStep("media.discover", async () => {
      const results = await callJson("editor.native.media.search", { query: imported.name });
      recordTool("editor.native.media.search");
      if (!Array.isArray(results) || results.length !== 1 || results[0]?.handle !== imported.mediaHandle || !results[0]?.sourceIdentity) {
        throw new Error("FINAL_CUT_E2E_MEDIA_DISCOVERY_FAILED: imported media did not resolve to one stable Browser result");
      }
      return results[0];
    });

    await runStep("media.select", async () => {
      const result = await callJson("editor.native.media.select", { mediaHandle: discovered.handle });
      recordTool("editor.native.media.select");
      if (!result.target || result.target.kind !== "browser-media") {
        throw new Error("FINAL_CUT_E2E_MEDIA_SELECTION_FAILED: imported media was not selected in the Browser");
      }
      return result;
    });

    const workflowBefore = await runStep("rough-cut.live.inspect.before", async () => {
      const result = await callJson("editor.live.inspect");
      recordTool("editor.live.inspect");
      requireLiveTarget(result, expectedProject);
      return result;
    });

    const mediaPlacement = await placeMedia(discovered.handle);
    const occurrence = await runStep("media.occurrence.verify", async () => {
      const located = await callJson("editor.native.timeline.locate", { mediaHandle: discovered.handle });
      recordTool("editor.native.timeline.locate");
      if (located.status !== "unique" || located.occurrences?.length !== 1) {
        throw new Error("FINAL_CUT_E2E_MEDIA_OCCURRENCE_AMBIGUOUS: expected one imported media occurrence after placement");
      }
      const candidate = located.occurrences[0];
      const identity = candidate.nativeIdentity ?? candidate.identity;
      if (candidate.mediaHandle !== discovered.handle || !identity || !candidate.start || !candidate.duration) {
        throw new Error("FINAL_CUT_E2E_MEDIA_OCCURRENCE_UNVERIFIED: placement did not return a stable occurrence identity and range");
      }
      if (!sameRational(candidate.duration, mediaPlacement.range.duration)) {
        throw new Error("FINAL_CUT_E2E_MEDIA_OCCURRENCE_UNVERIFIED: occurrence duration did not match the inserted range");
      }
      return { ...candidate, id: identity };
    });

    const animation = await placeTitle();
    const liveAfter = await runStep("rough-cut.live.inspect.after", async () => {
      const result = await callJson("editor.live.inspect");
      recordTool("editor.live.inspect");
      requireLiveTarget(result, expectedProject);
      if (result.revision?.id !== animation.result.afterRevision?.id) {
        throw new Error("FINAL_CUT_E2E_REVISION_UNVERIFIED: final live revision did not match the verified title placement revision");
      }
      return result;
    });

    const evidence = sanitizeRoughCutEvidence({
      passed: true,
      recordedAt: new Date().toISOString(),
      editor: inspected.identity,
      capabilities: inspected.capabilities,
      nativeCapabilities: inspected.native,
      project: {
        before: liveIdentity(workflowBefore, "before project"),
        after: liveIdentity(liveAfter, "after project"),
      },
      sequence: {
        before: sequenceIdentity(workflowBefore, "before sequence"),
        after: sequenceIdentity(liveAfter, "after sequence"),
      },
      media: {
        resolution: { status: "passed", name: basename(resolution.path), kind: "video" },
        imported: { status: "passed", name: imported.name, kind: imported.kind, mediaHandle: imported.mediaHandle },
        occurrence: { id: occurrence.id, name: occurrence.name, start: occurrence.start, duration: occurrence.duration },
      },
      placement: {
        operation: mediaPlacement.operation,
        range: mediaPlacement.range,
        beforeDuration: mediaPlacement.beforeDuration,
        afterDuration: mediaPlacement.afterDuration,
        verified: mediaPlacement.result.verification.verified,
      },
      animation: {
        kind: "title",
        asset: {
          id: animation.asset.id,
          name: animation.asset.name,
          vendor: animation.asset.vendor,
          backend: animation.asset.metadata.discovery.backend,
          guarantee: animation.asset.metadata.discovery.guarantee,
        },
        occurrenceId: animation.result.after?.target?.identity,
        range: { start: animation.result.start, duration: animation.result.duration },
        verified: animation.result.verification.verified,
      },
      revisions: {
        before: liveBefore.revision.id,
        after: animation.result.afterRevision.id,
        restored: preflight.restored.revision.id,
      },
      verification: { import: true, placement: true, animation: true, undo: true },
      rollback: { status: "passed", restored: preflight.undo.undone },
      stepResults,
      toolResults,
    }, await evidenceEnvironment(root));
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    return 0;
  } catch (error) {
    const reasonCode = errorCode(error);
    const status = isUnavailable(reasonCode) ? "unavailable" : "failed";
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      evidenceType: "headed-native-rough-cut-acceptance",
      passed: false,
      status,
      reasonCode,
      steps: stepResults,
      toolResults,
    }, null, 2)}\n`);
    process.stderr.write(`${reasonCode}: headed rough-cut acceptance did not pass\n`);
    return status === "unavailable" ? 2 : 1;
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

async function disposableUndoPreflight(liveBefore) {
  const originalDuration = liveBefore.sequenceTimeRange?.duration ?? liveBefore.sequence?.duration;
  const frameDuration = liveBefore.sequence?.frameDuration;
  if (!originalDuration || !frameDuration) throw new Error("CAPABILITY_UNAVAILABLE: live sequence duration and frame duration are required for the disposable Undo preflight");
  const targetDuration = subtractRational(originalDuration, frameDuration);
  if (compareRational(targetDuration, zeroRational()) <= 0) throw new Error("FINAL_CUT_E2E_DURATION_TOO_SHORT: disposable Undo preflight requires more than one frame");

  const preview = await runStep("preflight.trim.preview", async () => {
    const result = await callJson("editor.native.trim-to-duration.preview", { duration: targetDuration });
    recordTool("editor.native.trim-to-duration.preview");
    if (!result.previewToken) throw new Error("FINAL_CUT_E2E_PREFLIGHT_FAILED: trim preview did not return a token");
    return result;
  });
  const trimmed = await runStep("preflight.trim.execute", async () => {
    const result = await callJson("editor.native.trim-to-duration.execute", { previewToken: preview.previewToken });
    recordTool("editor.native.trim-to-duration.execute");
    if (!result.verification?.verified) throw new Error("FINAL_CUT_E2E_PREFLIGHT_FAILED: disposable trim was not verified");
    return result;
  });
  const undo = await runStep("preflight.undo", async () => {
    const result = await callJson("editor.native.undo", { operationId: trimmed.operationId });
    recordTool("editor.native.undo");
    if (!result.undone || !result.verification?.verified) throw new Error("FINAL_CUT_E2E_PREFLIGHT_UNDO_FAILED: disposable Undo was not verified");
    return result;
  });
  const restored = await runStep("preflight.live.inspect.restored", async () => {
    const result = await callJson("editor.live.inspect");
    recordTool("editor.live.inspect");
    const duration = result.sequenceTimeRange?.duration ?? result.sequence?.duration;
    if (!duration || !sameRational(duration, originalDuration)) throw new Error("FINAL_CUT_E2E_PREFLIGHT_UNDO_FAILED: original sequence duration was not restored");
    return result;
  });
  return { trimmed, undo, restored };
}

async function placeMedia(mediaHandle) {
  const before = await callJson("editor.live.inspect");
  recordTool("editor.live.inspect");
  const previewName = placement === "append" ? "editor.native.media.append.preview" : "editor.native.media.insert.preview";
  const executeName = placement === "append" ? "editor.native.media.append.execute" : "editor.native.media.insert.execute";
  const preview = await runStep("media.placement.preview", async () => {
    const result = await callJson(previewName, { mediaHandle });
    recordTool(previewName);
    if (!result.previewToken || !result.beforeDuration || !result.insertionTime || result.operation !== placement) {
      throw new Error("FINAL_CUT_E2E_MEDIA_PLACEMENT_PREVIEW_FAILED: preview did not return the target, range, and revision");
    }
    return result;
  });
  const result = await runStep("media.placement.execute", async () => {
    const next = await callJson(executeName, { previewToken: preview.previewToken });
    recordTool(executeName);
    if (!next.verification?.verified || !next.afterDuration || next.beforeRevision?.id === next.afterRevision?.id) {
      throw new Error("FINAL_CUT_E2E_MEDIA_PLACEMENT_FAILED: media placement was not verified with a new revision and duration");
    }
    return next;
  });
  const duration = subtractRational(result.afterDuration, result.beforeDuration);
  if (compareRational(duration, zeroRational()) <= 0) throw new Error("FINAL_CUT_E2E_MEDIA_PLACEMENT_FAILED: placement did not increase the sequence duration");
  if (placement === "append" && compareRational(preview.insertionTime, result.beforeDuration) !== 0n) {
    throw new Error("FINAL_CUT_E2E_MEDIA_PLACEMENT_FAILED: append insertion time did not equal the pre-edit duration");
  }
  return {
    operation: placement,
    beforeDuration: result.beforeDuration,
    afterDuration: result.afterDuration,
    range: { start: preview.insertionTime, duration },
    result,
  };
}

async function placeTitle() {
  const assets = await runStep("animation.discover", async () => {
    const result = await callJson("editor.assets", { kind: "title", query: titleQuery });
    recordTool("editor.assets");
    const matches = Array.isArray(result)
      ? result.filter((asset) => asset.id?.startsWith("final-cut:title:"))
      : [];
    if (matches.length !== 1) throw new Error(`FINAL_CUT_E2E_TITLE_AMBIGUOUS: expected one native title, observed ${matches.length}`);
    const asset = matches[0];
    if (asset.metadata?.discovery?.backend !== "final-cut-accessibility"
      || asset.metadata?.discovery?.guarantee !== "observed"
      || !asset.metadata?.identity) {
      throw new Error("FINAL_CUT_E2E_TITLE_PROVENANCE_FAILED: title discovery did not return observed native identity");
    }
    return asset;
  });
  const preview = await runStep("animation.preview", async () => {
    const result = await callJson("editor.native.title.add.preview", {
      assetId: assets.id,
      text: titleText,
      duration: titleDuration,
    });
    recordTool("editor.native.title.add.preview");
    if (!result.previewToken || result.asset?.id !== assets.id || !result.start || !result.duration || !result.revision) {
      throw new Error("FINAL_CUT_E2E_TITLE_PREVIEW_FAILED: native title preview did not preserve identity, range, and revision");
    }
    return result;
  });
  const result = await runStep("animation.execute", async () => {
    const next = await callJson("editor.native.title.add.execute", { previewToken: preview.previewToken });
    recordTool("editor.native.title.add.execute");
    if (!next.verification?.verified
      || next.asset?.id !== assets.id
      || !next.after?.target?.identity
      || next.beforeRevision?.id === next.afterRevision?.id
      || !next.undoAvailable) {
      throw new Error("FINAL_CUT_E2E_TITLE_PLACEMENT_FAILED: visible title placement was not read-back verified");
    }
    return next;
  });
  return { asset: assets, preview, result };
}

async function resolveMediaInput(path, directory) {
  if (!path) {
    throw new Error("CAPABILITY_UNAVAILABLE: MCP directory media resolution is unavailable; no exact video filename was selected");
  }
  const normalized = path.trim();
  if (!normalized || !basename(normalized)) throw new Error("FINAL_CUT_E2E_MEDIA_INPUT_INVALID: an exact video path is required");
  if (directory && !directory.trim()) throw new Error("FINAL_CUT_E2E_MEDIA_DIRECTORY_INVALID: directory input is empty");
  return { path: normalized, source: directory ? "directory-with-exact-file" : "exact-file" };
}

async function runStep(name, action) {
  const step = stepResults.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`FINAL_CUT_E2E_STEP_INVALID: ${name}`);
  try {
    const result = await action();
    step.status = "passed";
    return result;
  } catch (error) {
    step.status = isUnavailable(errorCode(error)) ? "unavailable" : "failed";
    throw error;
  }
}

async function callJson(name, arguments_ = {}) {
  const result = await client.callTool({ name, arguments: arguments_ });
  const content = result.content?.find((item) => item.type === "text")?.text ?? "";
  if (result.isError) throw new Error(content || `${name} failed`);
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`${name} returned invalid JSON`);
  }
}

function recordTool(name, status = "passed") {
  toolResults.push({ name, status });
}

function requireCapabilities(capabilities, names) {
  for (const name of names) {
    if (capabilities?.[name] !== true) throw new Error(`CAPABILITY_UNAVAILABLE: native ${name} is required`);
  }
}

function requireLiveTarget(live, project) {
  if (live.project?.name !== project) throw new Error(`FINAL_CUT_E2E_PROJECT_MISMATCH: expected ${project}, observed ${live.project?.name ?? "unknown"}`);
  if (!live.project?.id || !live.sequence?.id || !live.sequence?.name || !live.revision?.id) {
    throw new Error("FINAL_CUT_E2E_LIVE_STATE_UNAVAILABLE: project, sequence, and revision identities are required");
  }
  if (!(live.sequenceTimeRange?.duration ?? live.sequence?.duration)) throw new Error("FINAL_CUT_E2E_LIVE_STATE_UNAVAILABLE: sequence range is required");
}

function liveIdentity(live, label) {
  return { id: requireString(live.project?.id, `${label} id`), name: requireString(live.project?.name, `${label} name`) };
}

function sequenceIdentity(live, label) {
  return { id: requireString(live.sequence?.id, `${label} id`), name: requireString(live.sequence?.name, `${label} name`) };
}

function parseRational(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match || match[2] === "0" || BigInt(match[1]) <= 0n) throw new Error(`FINAL_CUT_E2E_DURATION_INVALID: expected a positive rational value/timescale, observed ${value}`);
  return { value: match[1], timescale: match[2] };
}

function subtractRational(left, right) {
  return normalizeRational(
    BigInt(left.value) * BigInt(right.timescale) - BigInt(right.value) * BigInt(left.timescale),
    BigInt(left.timescale) * BigInt(right.timescale),
  );
}

function sameRational(left, right) {
  const leftRational = rationalObject(left);
  const rightRational = rationalObject(right);
  return BigInt(leftRational.value) * BigInt(rightRational.timescale)
    === BigInt(rightRational.value) * BigInt(leftRational.timescale);
}

function rationalObject(value) {
  if (typeof value === "string") {
    const match = /^(\d+)\/(\d+)$/.exec(value);
    if (!match || match[2] === "0") throw new Error("FINAL_CUT_E2E_RATIONAL_INVALID: native occurrence range is not rational");
    return { value: match[1], timescale: match[2] };
  }
  return value;
}

function compareRational(left, right) {
  return BigInt(left.value) * BigInt(right.timescale) - BigInt(right.value) * BigInt(left.timescale);
}

function normalizeRational(value, scale) {
  const divisor = gcd(value < 0n ? -value : value, scale);
  return { value: (value / divisor).toString(), timescale: (scale / divisor).toString() };
}

function zeroRational() {
  return { value: "0", timescale: "1" };
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

function errorCode(error) {
  return String(error).match(/\b(?:CAPABILITY_UNAVAILABLE|FINAL_CUT_[A-Z0-9_]+|INVALID_OPERATION)\b/)?.[0] ?? "FINAL_CUT_E2E_FAILED";
}

function isUnavailable(code) {
  return code === "CAPABILITY_UNAVAILABLE" || code.includes("_UNAVAILABLE") || code.includes("_NOT_READY") || code.includes("_NOT_FRONTMOST");
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`FINAL_CUT_E2E_LIVE_STATE_UNAVAILABLE: ${label} is missing`);
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

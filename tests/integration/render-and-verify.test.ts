import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import {
  createFramekitRenderRequest,
  createFramekitRenderResult,
  renderAndVerifyFramekitProject,
  type FramekitRenderArtifactVerifier,
  type FramekitRenderParameters,
  type TimelineIr,
} from "@framekit/runtime";
import { FfmpegRenderVerifier, FfmpegTimelineRenderer } from "../../adapters/headless/typescript/src/index.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();

test("render-and-verify returns verified provenance and independent artifact metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-render-and-verify-"));
  try {
    await execFileAsync(process.execPath, ["scripts/generate-headless-render-fixtures.mjs", directory], {
      cwd: repositoryRoot,
      env: process.env,
    });
    const timeline = await fixtureTimeline(directory);
    const parameters = renderParameters(join(directory, "verified.mp4"));
    const request = createFramekitRenderRequest({
      timeline,
      target: { projectId: timeline.project.id, sequenceId: timeline.sequence.id },
      parameters,
    });
    const outcome = await renderAndVerifyFramekitProject(
      request,
      new FfmpegTimelineRenderer({ ffmpegPath: process.env.FFMPEG_BIN || "ffmpeg" }),
      new FfmpegRenderVerifier({ ffprobePath: process.env.FFPROBE_BIN || "ffprobe" }),
      {
        semanticAssertions: [{
          name: "fixture-semantics",
          verify: ({ plan, artifact }) => ({
            name: "fixture-semantics",
            passed: plan.timeline.sequence.occurrences.map(({ id }) => id).join(",") === "occurrence-red,occurrence-blue"
              && plan.timeline.sequence.transitions?.[0]?.id === "transition-red-blue"
              && artifact.durationSeconds > 1.95,
            detail: "canonical fixture ordering, transition identity, and rendered duration are retained",
          }),
        }],
      },
    );
    assert.equal(outcome.status, "passed");
    assert.equal(outcome.render?.projectRevision.id, timeline.revision.id);
    assert.match(outcome.render?.planDigest ?? "", /^[a-f0-9]{64}$/);
    assert.equal(outcome.verification?.artifact?.width, 320);
    assert.equal(outcome.verification?.artifact?.height, 180);
    assert.match(outcome.verification?.artifact?.fileDigest ?? "", /^[a-f0-9]{64}$/);
    assert.equal(outcome.verification?.checks.every(({ passed }) => passed), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("render-and-verify does not report provider success when independent verification fails", async () => {
  const timeline = minimalTimeline();
  const request = createFramekitRenderRequest({
    timeline,
    target: { projectId: timeline.project.id, sequenceId: timeline.sequence.id },
    parameters: renderParameters("/tmp/render-and-verify.mp4"),
  });
  const verifier: FramekitRenderArtifactVerifier = {
    async verify() {
      return {
        status: "failed",
        checks: [{ name: "fixture-check", passed: false, detail: "fixture assertion failed" }],
        error: { code: "RENDER_SEMANTICS_FAILED", message: "fixture assertion failed" },
      };
    },
  };
  const provider = {
    id: "fixture-provider",
    version: "1",
    capabilities: () => ({ renderer: { id: "fixture-provider", version: "1" }, features: { "local-media": "supported" as const, "structural-edits": "supported" as const } }),
    async render(plan: Parameters<typeof createFramekitRenderResult>[0]) {
      return createFramekitRenderResult(plan, { path: plan.parameters.outputPath, format: plan.parameters.format });
    },
  };
  const outcome = await renderAndVerifyFramekitProject(request, provider, verifier);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.render?.status, "rendered");
  assert.equal(outcome.verification?.status, "failed");
});

test("render-and-verify preserves explicit unavailable state", async () => {
  const timeline = minimalTimeline();
  const request = createFramekitRenderRequest({
    timeline,
    target: { projectId: timeline.project.id, sequenceId: timeline.sequence.id },
    parameters: renderParameters("/tmp/render-and-verify-unavailable.mp4"),
  });
  const unavailableProvider = {
    id: "unavailable",
    version: "1",
    capabilities: () => ({ renderer: { id: "unavailable", version: "1" }, features: { "local-media": "supported" as const, "structural-edits": "supported" as const } }),
    async render() { throw new Error("RENDERER_UNAVAILABLE: ffmpeg is not configured"); },
  };
  const outcome = await renderAndVerifyFramekitProject(request, unavailableProvider, { verify: async () => ({ status: "passed", checks: [] }) });
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.error?.code, "RENDERER_UNAVAILABLE");
});

async function fixtureTimeline(directory: string): Promise<TimelineIr> {
  const redPath = join(directory, "fixture-red-440hz.mp4");
  const bluePath = join(directory, "fixture-blue-880hz.mp4");
  return {
    ...minimalTimeline(),
    sequence: {
      ...minimalTimeline().sequence,
      durationTime: { value: "2", timescale: "1" },
      occurrences: [
        { ...minimalTimeline().sequence.occurrences[0]!, id: "occurrence-red", name: "Red", durationTime: { value: "1", timescale: "1" }, mediaId: "media-red", gainDb: 6, transform: { scaleX: 1.25, scaleY: 1.25 } },
        { ...minimalTimeline().sequence.occurrences[0]!, id: "occurrence-blue", name: "Blue", startTime: { value: "1", timescale: "1" }, durationTime: { value: "1", timescale: "1" }, mediaId: "media-blue", transform: undefined },
      ],
      titles: [{ id: "title-opening", text: "OPEN", startTime: { value: "0", timescale: "1" }, durationTime: { value: "1", timescale: "2" }, lane: 1 }],
      transitions: [{ id: "transition-red-blue", kind: "cross-dissolve", beforeOccurrenceId: "occurrence-red", afterOccurrenceId: "occurrence-blue", durationTime: { value: "1", timescale: "4" } }],
    },
    resources: [
      fixtureResource("media-red", redPath, await digest(redPath)),
      fixtureResource("media-blue", bluePath, await digest(bluePath)),
    ],
  };
}

function minimalTimeline(): TimelineIr {
  return {
    schemaVersion: 1,
    project: { id: "project-render-and-verify", name: "Render and verify" },
    sequence: {
      id: "sequence-render-and-verify",
      name: "Master",
      durationTime: { value: "1", timescale: "1" },
      frameDuration: { value: "1", timescale: "30" },
      occurrences: [{ id: "occurrence-source", name: "Source", startTime: { value: "0", timescale: "1" }, durationTime: { value: "1", timescale: "1" }, sourceStartTime: { value: "0", timescale: "1" }, track: 0, role: "video", mediaId: "media-source" }],
      storyElements: [],
      markers: [],
      captions: [],
      titles: [],
      transitions: [],
    },
    resources: [fixtureResource("media-source", "/tmp/source.mp4", "0".repeat(64))],
    revision: { id: "revision-render-and-verify", sequence: 3, timestamp: "2026-10-05T00:00:00.000Z" },
  };
}

function fixtureResource(id: string, source: string, sourceDigest: string) {
  return {
    id,
    name: id,
    mediaKind: "video" as const,
    source,
    sourceKind: "local-file" as const,
    sourceDigest,
    metadata: {
      durationTime: { value: "1", timescale: "1" },
      streams: [
        { kind: "video" as const, width: 320, height: 180, frameRate: { value: "30", timescale: "1" } },
        { kind: "audio" as const, sampleRate: 48000, channels: 1 },
      ],
    },
  };
}

function renderParameters(outputPath: string): FramekitRenderParameters {
  return { outputPath, format: "mp4", width: 320, height: 180, frameRate: { value: "30", timescale: "1" } };
}

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

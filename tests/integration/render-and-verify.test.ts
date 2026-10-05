import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import {
  createFramekitRenderPlan,
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
          verify: async ({ plan, artifact }) => {
            const earlyFrame = await frameAt(artifact.path, 0.25, directory, "semantic-early");
            const early = ppmPixel(earlyFrame, 160, 120);
            const transformedEdge = ppmPixel(earlyFrame, 10, 10);
            const transition = ppmPixel(await frameAt(artifact.path, 0.9, directory, "semantic-transition"), 160, 120);
            const late = ppmPixel(await frameAt(artifact.path, 1.2, directory, "semantic-late"), 10, 160);
            const titleFrame = await frameAt(artifact.path, 0.25, directory, "semantic-title");
            const noTitleFrame = await frameAt(artifact.path, 0.75, directory, "semantic-no-title");
            const sourceVolume = await meanVolume(join(directory, "fixture-red-440hz.mp4"));
            const outputVolume = await meanVolume(artifact.path);
            const pixelsAndAudioPass = early.r > 150 && early.b < 80
              && transformedEdge.r < 20 && transformedEdge.g < 20 && transformedEdge.b < 20
              && transition.r > 20 && transition.b > 20
              && late.b > 150 && late.r < 80
              && countBrightPixels(titleFrame, 80, 240, 40, 140) > countBrightPixels(noTitleFrame, 80, 240, 40, 140) + 5
              && Math.abs((outputVolume - sourceVolume) - 6) < 1.5;
            return {
            name: "fixture-semantics",
            passed: plan.timeline.sequence.occurrences.map(({ id }) => id).join(",") === "occurrence-red,occurrence-blue"
              && plan.timeline.sequence.transitions?.[0]?.id === "transition-red-blue"
              && artifact.durationSeconds > 1.95
              && pixelsAndAudioPass,
              detail: "canonical fixture ordering plus rendered pixels, transform padding, title window, cross-dissolve, and audio gain are verified",
            };
          },
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

    const rangedFrame = await frameAt(outcome.verification!.artifact!.path, 1.4, directory, "range-selected");
    const unrangedTimeline = structuredClone(timeline);
    unrangedTimeline.sequence.occurrences[1]!.sourceStartTime = { value: "0", timescale: "1" };
    const unrangedParameters = renderParameters(join(directory, "unranged.mp4"));
    const unrangedRequest = createFramekitRenderRequest({
      timeline: unrangedTimeline,
      target: { projectId: unrangedTimeline.project.id, sequenceId: unrangedTimeline.sequence.id },
      parameters: unrangedParameters,
    });
    const unrangedRenderer = new FfmpegTimelineRenderer({ ffmpegPath: process.env.FFMPEG_BIN || "ffmpeg" });
    const unrangedPlan = createFramekitRenderPlan(unrangedRequest, unrangedRenderer.capabilities(unrangedRequest));
    await unrangedRenderer.render(unrangedPlan);
    const unrangedFrame = await frameAt(unrangedParameters.outputPath, 1.4, directory, "range-ignored");
    assert.notEqual(frameDigest(rangedFrame), frameDigest(unrangedFrame), "sourceStartTime must change the verified artifact segment");
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

test("render-and-verify rejects a passed verification without artifact metadata", async () => {
  const timeline = minimalTimeline();
  const request = createFramekitRenderRequest({
    timeline,
    target: { projectId: timeline.project.id, sequenceId: timeline.sequence.id },
    parameters: renderParameters("/tmp/render-and-verify-contract.mp4"),
  });
  const provider = {
    id: "fixture-provider",
    version: "1",
    capabilities: () => ({ renderer: { id: "fixture-provider", version: "1" }, features: { "local-media": "supported" as const, "structural-edits": "supported" as const } }),
    async render(plan: Parameters<typeof createFramekitRenderResult>[0]) {
      return createFramekitRenderResult(plan, { path: plan.parameters.outputPath, format: plan.parameters.format });
    },
  };
  const outcome = await renderAndVerifyFramekitProject(request, provider, { verify: async () => ({ status: "passed", checks: [] }) });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.verification?.error?.code, "RENDER_VERIFICATION_CONTRACT_INVALID");
});

test("ffprobe verifier treats missing output as failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-render-verifier-missing-"));
  try {
    const timeline = minimalTimeline();
    const request = createFramekitRenderRequest({
      timeline,
      target: { projectId: timeline.project.id, sequenceId: timeline.sequence.id },
      parameters: renderParameters(join(directory, "missing.mp4")),
    });
    const capabilities = { renderer: { id: "fixture-provider", version: "1" }, features: { "local-media": "supported" as const, "structural-edits": "supported" as const } };
    const plan = createFramekitRenderPlan(request, capabilities);
    const result = createFramekitRenderResult(plan, { path: plan.parameters.outputPath, format: plan.parameters.format });
    const verification = await new FfmpegRenderVerifier({ ffprobePath: process.env.FFPROBE_BIN || "ffprobe" }).verify(plan, result);
    assert.equal(verification.status, "failed");
    assert.equal(verification.error?.code, "RENDER_OUTPUT_MISSING");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ffprobe verifier requires canonical audio streams", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-render-verifier-audio-"));
  try {
    const outputPath = join(directory, "video-only.mp4");
    await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=1",
      "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", outputPath,
    ], { cwd: repositoryRoot, env: process.env });
    const timeline = minimalTimeline();
    const request = createFramekitRenderRequest({
      timeline,
      target: { projectId: timeline.project.id, sequenceId: timeline.sequence.id },
      parameters: renderParameters(outputPath),
    });
    const capabilities = { renderer: { id: "fixture-provider", version: "1" }, features: { "local-media": "supported" as const, "structural-edits": "supported" as const } };
    const plan = createFramekitRenderPlan(request, capabilities);
    const result = createFramekitRenderResult(plan, { path: outputPath, format: plan.parameters.format });
    const verification = await new FfmpegRenderVerifier({ ffprobePath: process.env.FFPROBE_BIN || "ffprobe" }).verify(plan, result);
    assert.equal(verification.status, "failed");
    assert.equal(verification.checks.find((check) => check.name === "audio-stream")?.passed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ffprobe verifier rejects output identity or bytes changing during verification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-render-verifier-stability-"));
  try {
    const outputPath = join(directory, "output.mp4");
    await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=1",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", outputPath,
    ], { cwd: repositoryRoot, env: process.env });
    const ffprobeWrapper = join(directory, "mutating-ffprobe.mjs");
    await writeFile(ffprobeWrapper, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from \"node:fs\";",
      "import { spawnSync } from \"node:child_process\";",
      "const result = spawnSync(process.env.FFPROBE_REAL_BIN, process.argv.slice(2), { encoding: \"utf8\" });",
      "process.stdout.write(result.stdout ?? \"\");",
      "process.stderr.write(result.stderr ?? \"\");",
      "appendFileSync(process.argv.at(-1), \"changed during verification\");",
      "process.exit(result.status ?? 1);",
    ].join("\n"));
    await chmod(ffprobeWrapper, 0o755);
    const timeline = minimalTimeline();
    timeline.sequence.durationTime = { value: "1", timescale: "1" };
    const request = createFramekitRenderRequest({
      timeline,
      target: { projectId: timeline.project.id, sequenceId: timeline.sequence.id },
      parameters: renderParameters(outputPath),
    });
    const plan = createFramekitRenderPlan(request, {
      renderer: { id: "fixture-provider", version: "1" },
      features: { "local-media": "supported", "structural-edits": "supported" },
    });
    const result = createFramekitRenderResult(plan, { path: outputPath, format: plan.parameters.format });
    const verification = await new FfmpegRenderVerifier({
      ffprobePath: ffprobeWrapper,
      env: { FFPROBE_REAL_BIN: process.env.FFPROBE_BIN || "ffprobe" },
    }).verify(plan, result);
    assert.equal(verification.status, "failed");
    assert.equal(verification.error?.code, "RENDER_OUTPUT_CHANGED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
        { ...minimalTimeline().sequence.occurrences[0]!, id: "occurrence-red", name: "Red", durationTime: { value: "1", timescale: "1" }, sourceStartTime: { value: "1", timescale: "4" }, mediaId: "media-red", gainDb: 6, transform: { scaleX: 0.5, scaleY: 0.5 } },
        { ...minimalTimeline().sequence.occurrences[0]!, id: "occurrence-blue", name: "Blue", startTime: { value: "1", timescale: "1" }, durationTime: { value: "1", timescale: "1" }, sourceStartTime: { value: "1", timescale: "2" }, mediaId: "media-blue", transform: undefined },
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
      durationTime: { value: "2", timescale: "1" },
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
      durationTime: { value: "2", timescale: "1" },
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

function frameDigest(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function frameAt(videoPath: string, seconds: number, directory: string, label: string): Promise<Buffer> {
  const framePath = join(directory, `${label}.ppm`);
  await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-i", videoPath, "-ss", String(seconds), "-frames:v", "1", "-f", "image2", framePath], { cwd: repositoryRoot, env: process.env });
  return readFile(framePath);
}

function ppmPixel(contents: Buffer, x: number, y: number): { r: number; g: number; b: number } {
  const headerEnd = contents.indexOf(Buffer.from("\n255\n")) + "\n255\n".length;
  const header = contents.subarray(0, headerEnd).toString("ascii").trim().split(/\s+/);
  const width = Number(header[1]);
  const offset = headerEnd + (y * width + x) * 3;
  return { r: contents[offset]!, g: contents[offset + 1]!, b: contents[offset + 2]! };
}

function countBrightPixels(contents: Buffer, left: number, right: number, top: number, bottom: number): number {
  const headerEnd = contents.indexOf(Buffer.from("\n255\n")) + "\n255\n".length;
  const header = contents.subarray(0, headerEnd).toString("ascii").trim().split(/\s+/);
  const width = Number(header[1]);
  let count = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = headerEnd + (y * width + x) * 3;
      if (contents[offset]! > 180 && contents[offset + 1]! > 180 && contents[offset + 2]! > 180) count += 1;
    }
  }
  return count;
}

async function meanVolume(videoPath: string): Promise<number> {
  const result = await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "info", "-ss", "0.1", "-t", "0.5", "-i", videoPath, "-af", "volumedetect", "-f", "null", "-"], { cwd: repositoryRoot, env: process.env, maxBuffer: 8 * 1024 * 1024 });
  const match = result.stderr.match(/mean_volume:\s*(-?[0-9.]+) dB/);
  assert.ok(match, `volumedetect did not produce mean volume for ${videoPath}`);
  return Number(match[1]);
}

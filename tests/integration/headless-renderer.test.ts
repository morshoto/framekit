import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  createFramekitRenderPlan,
  createFramekitRenderRequest,
  type FramekitRenderParameters,
  type TimelineIr,
} from "@framekit/runtime";
import { FfmpegTimelineRenderer } from "../../adapters/headless/typescript/src/index.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();

test("FFmpeg Timeline IR renderer produces a deterministic playable artifact without mutating sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-ffmpeg-renderer-"));
  try {
    await execFileAsync(process.execPath, ["scripts/generate-headless-render-fixtures.mjs", directory], {
      cwd: repositoryRoot,
      env: process.env,
    });
    const redPath = join(directory, "fixture-red-440hz.mp4");
    const bluePath = join(directory, "fixture-blue-880hz.mp4");
    const redBefore = createHash("sha256").update(await readFile(redPath)).digest("hex");
    const blueBefore = createHash("sha256").update(await readFile(bluePath)).digest("hex");
    const source = await timeline(redPath, bluePath);
    const parameters: FramekitRenderParameters = {
      outputPath: join(directory, "final.mp4"),
      format: "mp4",
      width: 320,
      height: 180,
      frameRate: { value: "30", timescale: "1" },
      overwrite: false,
    };
    const renderer = new FfmpegTimelineRenderer({ ffmpegPath: process.env.FFMPEG_BIN || "ffmpeg" });
    const request = createFramekitRenderRequest({
      timeline: source,
      target: { projectId: source.project.id, sequenceId: source.sequence.id },
      parameters,
    });
    const plan = createFramekitRenderPlan(request, renderer.capabilities(request));
    const result = await renderer.render(plan);
    assert.equal(result.output.path, parameters.outputPath);
    assert.equal(result.verificationRequired, true);
    const probe = await execFileAsync(process.env.FFPROBE_BIN || "ffprobe", [
      "-v", "error",
      "-show_entries", "stream=codec_type,width,height,r_frame_rate,sample_rate,channels",
      "-show_entries", "format=duration",
      "-of", "json",
      parameters.outputPath,
    ], { cwd: repositoryRoot, env: process.env });
    const metadata = JSON.parse(probe.stdout) as {
      streams: Array<Record<string, string | number>>;
      format: { duration: string };
    };
    const video = metadata.streams.find((stream) => stream.codec_type === "video");
    const audio = metadata.streams.find((stream) => stream.codec_type === "audio");
    assert.equal(video?.width, 320);
    assert.equal(video?.height, 180);
    assert.equal(video?.r_frame_rate, "30/1");
    assert.equal(audio?.sample_rate, "48000");
    assert.equal(audio?.channels, 1);
    assert.ok(Number(metadata.format.duration) > 1.95 && Number(metadata.format.duration) < 2.05);
    assert.equal(createHash("sha256").update(await readFile(redPath)).digest("hex"), redBefore);
    assert.equal(createHash("sha256").update(await readFile(bluePath)).digest("hex"), blueBefore);

    const repeatParameters = { ...parameters, outputPath: join(directory, "final-repeat.mp4") };
    const repeatRequest = createFramekitRenderRequest({
      timeline: source,
      target: { projectId: source.project.id, sequenceId: source.sequence.id },
      parameters: repeatParameters,
    });
    const repeatPlan = createFramekitRenderPlan(repeatRequest, renderer.capabilities(repeatRequest));
    await renderer.render(repeatPlan);
    assert.deepEqual(await digest(parameters.outputPath), await digest(repeatParameters.outputPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FFmpeg renderer reports unsupported required semantics before rendering", () => {
  const source = timelineWithoutMedia();
  source.sequence.captions.push({
    id: "caption-unsupported",
    text: "not rendered",
    startTime: { value: "0", timescale: "1" },
    durationTime: { value: "1", timescale: "1" },
  });
  const renderer = new FfmpegTimelineRenderer();
  const request = createFramekitRenderRequest({
    timeline: source,
    target: { projectId: source.project.id, sequenceId: source.sequence.id },
    parameters: parameters("/tmp/unsupported.mp4"),
  });
  assert.equal(renderer.capabilities(request).features["structural-edits"], "unsupported");
  assert.throws(() => createFramekitRenderPlan(request, renderer.capabilities(request)), /RENDER_CAPABILITY_UNAVAILABLE/);
});

async function timeline(redPath: string, bluePath: string): Promise<TimelineIr> {
  return {
    ...timelineWithoutMedia(),
    resources: [
      resource("media-red", redPath, await digest(redPath)),
      resource("media-blue", bluePath, await digest(bluePath)),
    ],
  };
}

function timelineWithoutMedia(): TimelineIr {
  return {
    schemaVersion: 1,
    project: { id: "project-headless-render", name: "Headless render" },
    sequence: {
      id: "sequence-headless-render",
      name: "Master",
      durationTime: { value: "2", timescale: "1" },
      frameDuration: { value: "1", timescale: "30" },
      occurrences: [
        {
          id: "occurrence-red",
          name: "Red",
          startTime: { value: "0", timescale: "1" },
          durationTime: { value: "1", timescale: "1" },
          sourceStartTime: { value: "0", timescale: "1" },
          track: 0,
          role: "video",
          mediaId: "media-red",
          gainDb: 6,
          transform: { scaleX: 1.25, scaleY: 1.25 },
        },
        {
          id: "occurrence-blue",
          name: "Blue",
          startTime: { value: "1", timescale: "1" },
          durationTime: { value: "1", timescale: "1" },
          sourceStartTime: { value: "0", timescale: "1" },
          track: 0,
          role: "video",
          mediaId: "media-blue",
        },
      ],
      storyElements: [],
      markers: [],
      captions: [],
      titles: [
        {
          id: "title-opening",
          text: "OPEN",
          startTime: { value: "0", timescale: "1" },
          durationTime: { value: "1", timescale: "2" },
          lane: 1,
          style: { fontSize: 24, color: "white", alignment: "center" },
        },
        {
          id: "title-closing",
          text: "CLOSE",
          startTime: { value: "3", timescale: "2" },
          durationTime: { value: "1", timescale: "2" },
          lane: 1,
        },
      ],
      transitions: [{
        id: "transition-red-blue",
        kind: "cross-dissolve",
        beforeOccurrenceId: "occurrence-red",
        afterOccurrenceId: "occurrence-blue",
        durationTime: { value: "1", timescale: "4" },
      }],
    },
    resources: [
      resource("media-red", "/tmp/framekit-red.mp4", "0".repeat(64)),
      resource("media-blue", "/tmp/framekit-blue.mp4", "0".repeat(64)),
    ],
    revision: { id: "revision-headless-render", sequence: 1, timestamp: "2026-10-05T00:00:00.000Z" },
  };
}

function resource(id: string, source: string, sourceDigest: string) {
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

function parameters(outputPath: string): FramekitRenderParameters {
  return { outputPath, format: "mp4", width: 320, height: 180, frameRate: { value: "30", timescale: "1" } };
}

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

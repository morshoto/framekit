import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    const earlyFrame = await frameAt(parameters.outputPath, 0.25, directory, "early");
    const transitionFrame = await frameAt(parameters.outputPath, 0.9, directory, "transition");
    const lateFrame = await frameAt(parameters.outputPath, 1.2, directory, "late");
    const openingTitleFrame = await frameAt(parameters.outputPath, 0.25, directory, "opening-title");
    const noTitleFrame = await frameAt(parameters.outputPath, 0.75, directory, "no-title");
    const earlyPixel = ppmPixel(earlyFrame, 10, 160);
    const transitionPixel = ppmPixel(transitionFrame, 10, 160);
    const latePixel = ppmPixel(lateFrame, 10, 160);
    assert.ok(earlyPixel.r > 150 && earlyPixel.b < 80, `expected early red frame, got ${JSON.stringify(earlyPixel)}`);
    assert.ok(transitionPixel.r > 20 && transitionPixel.b > 20, `expected cross-dissolve blend, got ${JSON.stringify(transitionPixel)}`);
    assert.ok(latePixel.b > 150 && latePixel.r < 80, `expected late blue frame, got ${JSON.stringify(latePixel)}`);
    assert.ok(countBrightPixels(openingTitleFrame, 80, 240, 40, 140) > countBrightPixels(noTitleFrame, 80, 240, 40, 140) + 5);
    const sourceMeanVolume = await meanVolume(redPath, directory, "source-volume");
    const outputMeanVolume = await meanVolume(parameters.outputPath, directory, "output-volume");
    assert.ok(Math.abs((outputMeanVolume - sourceMeanVolume) - 6) < 1.5, `expected +6 dB gain, got ${outputMeanVolume - sourceMeanVolume} dB`);

    const transformed = structuredClone(source);
    transformed.sequence.occurrences[0]!.transform = { scaleX: 0.5, scaleY: 0.5, positionX: 90, positionY: 0 };
    const transformParameters = { ...parameters, outputPath: join(directory, "transform.mp4") };
    const transformRequest = createFramekitRenderRequest({
      timeline: transformed,
      target: { projectId: transformed.project.id, sequenceId: transformed.sequence.id },
      parameters: transformParameters,
    });
    const transformPlan = createFramekitRenderPlan(transformRequest, renderer.capabilities(transformRequest));
    await renderer.render(transformPlan);
    const transformedFrame = await frameAt(transformParameters.outputPath, 0.5, directory, "transformed");
    const paddedPixel = ppmPixel(transformedFrame, 10, 90);
    const contentPixel = ppmPixel(transformedFrame, 200, 90);
    assert.ok(paddedPixel.r < 20 && paddedPixel.g < 20 && paddedPixel.b < 20, `expected transformed pad, got ${JSON.stringify(paddedPixel)}`);
    assert.ok(contentPixel.r > 150 && contentPixel.g < 80 && contentPixel.b < 80, `expected transformed content, got ${JSON.stringify(contentPixel)}`);
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

test("FFmpeg renderer commits no-clobber output atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-ffmpeg-renderer-output-race-"));
  try {
    await execFileAsync(process.execPath, ["scripts/generate-headless-render-fixtures.mjs", directory], { cwd: repositoryRoot, env: process.env });
    const sourcePath = join(directory, "fixture-red-440hz.mp4");
    const outputPath = join(directory, "race.mp4");
    const wrapperPath = join(directory, "race-ffmpeg.mjs");
    await writeFile(wrapperPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from \"node:fs\";",
      "import { spawnSync } from \"node:child_process\";",
      "writeFileSync(process.env.FRAMEKIT_TEST_RACE_OUTPUT, \"concurrent output\");",
      "const result = spawnSync(process.env.FFMPEG_REAL_BIN, process.argv.slice(2), { stdio: \"inherit\" });",
      "process.exit(result.status ?? 1);",
    ].join("\n"));
    await chmod(wrapperPath, 0o755);
    const source = await timeline(sourcePath, sourcePath);
    source.sequence.occurrences = [source.sequence.occurrences[0]!];
    source.sequence.durationTime = { value: "1", timescale: "1" };
    source.sequence.titles = [];
    source.sequence.transitions = [];
    const renderParameters = { ...parameters(outputPath), overwrite: false };
    const renderer = new FfmpegTimelineRenderer({
      ffmpegPath: wrapperPath,
      env: { FRAMEKIT_TEST_RACE_OUTPUT: outputPath, FFMPEG_REAL_BIN: process.env.FFMPEG_BIN || "ffmpeg" },
    });
    const request = createFramekitRenderRequest({ timeline: source, target: { projectId: source.project.id, sequenceId: source.sequence.id }, parameters: renderParameters });
    const plan = createFramekitRenderPlan(request, renderer.capabilities(request));
    await assert.rejects(renderer.render(plan), /HEADLESS_RENDER_OUTPUT_EXISTS/);
    assert.equal(await readFile(outputPath, "utf8"), "concurrent output");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FFmpeg renderer rejects media changed during rendering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-ffmpeg-renderer-source-race-"));
  try {
    await execFileAsync(process.execPath, ["scripts/generate-headless-render-fixtures.mjs", directory], { cwd: repositoryRoot, env: process.env });
    const sourcePath = join(directory, "fixture-red-440hz.mp4");
    const outputPath = join(directory, "changed.mp4");
    const wrapperPath = join(directory, "mutate-ffmpeg.mjs");
    await writeFile(wrapperPath, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from \"node:fs\";",
      "import { spawnSync } from \"node:child_process\";",
      "appendFileSync(process.env.FRAMEKIT_TEST_MUTATE_SOURCE, \"changed during render\");",
      "const result = spawnSync(process.env.FFMPEG_REAL_BIN, process.argv.slice(2), { stdio: \"inherit\" });",
      "process.exit(result.status ?? 1);",
    ].join("\n"));
    await chmod(wrapperPath, 0o755);
    const source = await timeline(sourcePath, sourcePath);
    source.sequence.occurrences = [source.sequence.occurrences[0]!];
    source.sequence.durationTime = { value: "1", timescale: "1" };
    source.sequence.titles = [];
    source.sequence.transitions = [];
    const renderer = new FfmpegTimelineRenderer({
      ffmpegPath: wrapperPath,
      env: { FRAMEKIT_TEST_MUTATE_SOURCE: sourcePath, FFMPEG_REAL_BIN: process.env.FFMPEG_BIN || "ffmpeg" },
    });
    const request = createFramekitRenderRequest({ timeline: source, target: { projectId: source.project.id, sequenceId: source.sequence.id }, parameters: parameters(outputPath) });
    const plan = createFramekitRenderPlan(request, renderer.capabilities(request));
    await assert.rejects(renderer.render(plan), /HEADLESS_RENDER_MEDIA_CHANGED/);
    await assert.rejects(readFile(outputPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

async function frameAt(videoPath: string, seconds: number, directory: string, label: string): Promise<Buffer> {
  const framePath = join(directory, `${label}.ppm`);
  await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", [
    "-v", "error", "-i", videoPath, "-ss", String(seconds), "-frames:v", "1", "-f", "image2", framePath,
  ], { cwd: repositoryRoot, env: process.env });
  return readFile(framePath);
}

function ppmPixel(contents: Buffer, x: number, y: number): { r: number; g: number; b: number } {
  const headerEnd = contents.indexOf(Buffer.from("\n255\n")) + "\n255\n".length;
  const header = contents.subarray(0, headerEnd).toString("ascii").trim().split(/\s+/);
  assert.equal(header[0], "P6");
  const width = Number(header[1]);
  const height = Number(header[2]);
  assert.ok(x >= 0 && x < width && y >= 0 && y < height);
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

async function meanVolume(videoPath: string, directory: string, label: string): Promise<number> {
  const result = await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", [
    "-v", "info", "-ss", "0.1", "-t", "0.5", "-i", videoPath, "-af", "volumedetect", "-f", "null", "-",
  ], { cwd: repositoryRoot, env: process.env, maxBuffer: 8 * 1024 * 1024 });
  const match = result.stderr.match(/mean_volume:\s*(-?[0-9.]+) dB/);
  assert.ok(match, `volumedetect did not produce mean volume for ${label}`);
  return Number(match[1]);
}

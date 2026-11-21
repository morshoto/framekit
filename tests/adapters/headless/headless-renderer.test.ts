import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { createMediaFixturePool } from "../../support/headless/media-fixtures.js";
import {
  createFramekitRenderPlan,
  createFramekitRenderRequest,
  type FramekitRenderParameters,
  type TimelineIr,
} from "@framekit/runtime";
import { FfmpegMediaMetadataProbe, FfmpegRenderVerifier, FfmpegStoryboardRenderer, FfmpegTimelineRenderer } from "../../../adapters/headless/typescript/src/index.js";
import { resolveFontFile } from "../../../adapters/headless/typescript/src/ffmpeg-renderer.js";
import { compileTimelineIrToFcpxml, FcpxmlDocumentAdapter } from "@framekit/final-cut/fcpxml";

const execFileAsync = promisify(execFile);
const mediaFixtures = createMediaFixturePool();

test("media probe retains declared video color metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-color-probe-"));
  try {
    const source = join(directory, "bt709.mp4");
    await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=320x180:r=30:d=1", "-vf", "setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-movflags", "+write_colr", source]);
    const video = (await new FfmpegMediaMetadataProbe().probe(source)).streams.find((stream) => stream.kind === "video");
    assert.deepEqual(video?.color, { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" });
    await mediaFixtures.copyTo(directory);
    const unspecified = (await new FfmpegMediaMetadataProbe().probe(join(directory, "fixture-red-440hz.mp4"))).streams.find((stream) => stream.kind === "video");
    assert.equal(unspecified?.color, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
after(() => mediaFixtures.dispose());
const repositoryRoot = process.cwd();

test("FFmpeg renderer refuses an unimplemented nonzero source origin", async () => {
  const source = timelineWithoutMedia();
  source.resources[0]!.metadata!.durationTime = { value: "20", timescale: "1" };
  Object.assign(source.resources[0]!, { sourceRange: { start: { value: "10", timescale: "1" }, duration: { value: "20", timescale: "1" } } });
  source.sequence.occurrences[0]!.sourceStartTime = { value: "10", timescale: "1" };
  const renderer = new FfmpegTimelineRenderer();
  const request = createFramekitRenderRequest({ timeline: source, target: { projectId: source.project.id, sequenceId: source.sequence.id }, parameters: parameters("/tmp/framekit-test-output.mp4") });
  const plan = createFramekitRenderPlan(request, renderer.capabilities(request));
  await assert.rejects(renderer.render(plan), /HEADLESS_RENDER_UNSUPPORTED.*source.*origin/i);
});

test("FFmpeg renderer rejects a missing explicitly configured title font", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-title-font-"));
  try {
    await mediaFixtures.copyTo(directory);
    const source = await timeline(join(directory, "fixture-red-440hz.mp4"), join(directory, "fixture-blue-880hz.mp4"));
    const output = join(directory, "output.mp4");
    const renderer = new FfmpegTimelineRenderer({ env: { FRAMEKIT_RENDER_FONT: join(directory, "missing.otf") } });
    const request = createFramekitRenderRequest({ timeline: source, target: { projectId: source.project.id, sequenceId: source.sequence.id }, parameters: parameters(output) });
    const capabilities = renderer.capabilities(request);
    assert.equal(capabilities.features.titles, "unsupported");
    const plan = createFramekitRenderPlan(request, { ...capabilities, features: { ...capabilities.features, titles: "supported" } });
    await assert.rejects(renderer.render(plan), /title font.*(available|inspect)/i);
    await assert.rejects(readFile(output), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FFmpeg renderer rejects titles with unavailable glyphs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-title-glyphs-"));
  try {
    await mediaFixtures.copyTo(directory);
    const source = await timeline(join(directory, "fixture-red-440hz.mp4"), join(directory, "fixture-blue-880hz.mp4"));
    source.sequence.titles![0]!.text = "A\u{10ffff}";
    const fontPath = join(directory, "font.otf");
    await writeFile(fontPath, Buffer.from(await readFile(join(repositoryRoot, "tests/fixtures/fonts/noto-sans-jp-test.otf.base64"), "utf8"), "base64"));
    const renderer = new FfmpegTimelineRenderer({ env: { FRAMEKIT_RENDER_FONT: fontPath } });
    const output = join(directory, "missing-glyph.mp4");
    const request = createFramekitRenderRequest({ timeline: source, target: { projectId: source.project.id, sequenceId: source.sequence.id }, parameters: parameters(output) });
    const capabilities = renderer.capabilities(request);
    assert.equal(capabilities.features.titles, "unsupported");
    const plan = createFramekitRenderPlan(request, { ...capabilities, features: { ...capabilities.features, titles: "supported" } });
    await assert.rejects(renderer.render(plan), /selected font lacks glyph U\+10FFFF/i);
    await assert.rejects(readFile(output), /ENOENT/);
    source.sequence.titles![0]!.text = "A\u200dA";
    const joined = createFramekitRenderRequest({ timeline: source, target: { projectId: source.project.id, sequenceId: source.sequence.id }, parameters: parameters(output) });
    const joinedCapabilities = renderer.capabilities(joined);
    assert.equal(joinedCapabilities.features.titles, "unsupported");
    const joinedPlan = createFramekitRenderPlan(joined, { ...joinedCapabilities, features: { ...joinedCapabilities.features, titles: "supported" } });
    await assert.rejects(renderer.render(joinedPlan), /unverified shaping sequence/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FFmpeg renders a supported mixed-script title without tofu", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-title-mixed-script-"));
  try {
    await mediaFixtures.copyTo(directory);
    const fontPath = join(directory, "font.otf");
    await writeFile(fontPath, Buffer.from(await readFile(join(repositoryRoot, "tests/fixtures/fonts/noto-sans-jp-test.otf.base64"), "utf8"), "base64"));
    const relativeFont = relative(process.cwd(), fontPath);
    assert.equal(resolveFontFile(relativeFont), fontPath);
    const source = await timeline(join(directory, "fixture-red-440hz.mp4"), join(directory, "fixture-blue-880hz.mp4"));
    source.sequence.titles = [{ id: "mixed-title", text: "A日", startTime: { value: "0", timescale: "1" }, durationTime: { value: "1", timescale: "2" }, lane: 1 }];
    source.sequence.transitions = [];
    delete source.sequence.occurrences[0]!.transform;
    source.sequence.occurrences[0]!.sourceStartTime = { value: "1", timescale: "5" };
    const output = join(directory, "mixed.mp4");
    const renderer = new FfmpegTimelineRenderer({ env: { FRAMEKIT_RENDER_FONT: relativeFont } });
    const originalFontBytes = await readFile(fontPath);
    source.sequence.titles![0]!.font = { family: "Noto Sans CJK JP", style: "Regular", postscriptName: "NotoSansCJKjp-Regular", digest: createHash("sha256").update(originalFontBytes).digest("hex") };
    assert.deepEqual(renderer.inspectTitleFont(["A日"]), source.sequence.titles![0]!.font);
    assert.equal(renderer.inspectTitleFont(["A\u{10ffff}"]), undefined);
    for (const changedFont of [{ ...source.sequence.titles![0]!.font, digest: "f".repeat(64) }, { ...source.sequence.titles![0]!.font, family: "Different family" }]) {
      const changed = structuredClone(source);
      changed.sequence.titles![0]!.font = changedFont;
      const changedRequest = createFramekitRenderRequest({ timeline: changed, target: { projectId: changed.project.id, sequenceId: changed.sequence.id }, parameters: { ...parameters(output), width: 1280, height: 720 } });
      const capabilities = renderer.capabilities(changedRequest);
      assert.equal(capabilities.features.titles, "unsupported");
      const forcedPlan = createFramekitRenderPlan(changedRequest, { ...capabilities, features: { ...capabilities.features, titles: "supported" } });
      await assert.rejects(renderer.render(forcedPlan), /HEADLESS_RENDER_UNSUPPORTED.*title font/i);
      await assert.rejects(readFile(output), /ENOENT/);
    }
    const fontSymlink = join(directory, "font-symlink.otf");
    const fontHardlink = join(directory, "font-hardlink.otf");
    await symlink(fontPath, fontSymlink);
    await link(fontPath, fontHardlink);
    for (const destination of [fontPath, fontSymlink, fontHardlink]) {
      const collision = createFramekitRenderRequest({ timeline: source, target: { projectId: source.project.id, sequenceId: source.sequence.id }, parameters: { ...parameters(destination), width: 1280, height: 720, overwrite: true } });
      await assert.rejects(renderer.render(createFramekitRenderPlan(collision, renderer.capabilities(collision))), /OUTPUT_INVALID.*font/i);
      assert.deepEqual(await readFile(fontPath), originalFontBytes);
    }
    const request = createFramekitRenderRequest({ timeline: source, target: { projectId: source.project.id, sequenceId: source.sequence.id }, parameters: { ...parameters(output), width: 1280, height: 720 } });
    const plan = createFramekitRenderPlan(request, renderer.capabilities(request));
    const originalFont = await readFile(fontPath);
    await writeFile(fontPath, Buffer.concat([originalFont, Buffer.from([0])]));
    await assert.rejects(renderer.render(plan), /PLAN_MISMATCH.*font changed/i);
    await assert.rejects(readFile(output), /ENOENT/);
    await writeFile(fontPath, originalFont);
    await renderer.render(plan);
    const priorFont = process.env.FRAMEKIT_RENDER_FONT;
    try {
      process.env.FRAMEKIT_RENDER_FONT = fontPath;
      const storyboard = await new FfmpegStoryboardRenderer().render(source, { width: 1280, height: 720 });
      const sheet = join(directory, "sheet.png");
      const storyFrame = join(directory, "story.ppm");
      const scaledFrame = join(directory, "scaled.ppm");
      await writeFile(sheet, Buffer.from(storyboard.data, "base64"));
      await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-i", sheet, "-vf", "crop=640:360:0:0", "-frames:v", "1", storyFrame]);
      await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-i", output, "-ss", "0.25", "-vf", "scale=640:360", "-frames:v", "1", scaledFrame]);
      const bounds = (frame: Buffer) => {
        let left = 640, right = -1, top = 360, bottom = -1;
        for (let y = 110; y < 220; y++) for (let x = 200; x < 440; x++) {
          const pixel = ppmPixel(frame, x, y);
          if (pixel.r > 180 && pixel.g > 180 && pixel.b > 180) {
            left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
          }
        }
        assert.ok(right >= left && bottom >= top, "title pixels are visible");
        return { left, right, top, bottom };
      };
      const storyboardBounds = bounds(await readFile(storyFrame));
      const renderedBounds = bounds(await readFile(scaledFrame));
      for (const edge of ["left", "right", "top", "bottom"] as const) {
        assert.ok(Math.abs(storyboardBounds[edge] - renderedBounds[edge]) <= 3, `${edge}: storyboard ${storyboardBounds[edge]}, render ${renderedBounds[edge]}`);
      }
    } finally {
      if (priorFont === undefined) delete process.env.FRAMEKIT_RENDER_FONT;
      else process.env.FRAMEKIT_RENDER_FONT = priorFont;
    }
    const actual = await frameAt(output, 0.25, directory, "actual-mixed");
    const reference = async (name: string, text: string) => {
      await writeFile(join(directory, `${name}.txt`), text, "utf8");
      await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=1280x720:r=30:d=1", "-vf", `drawtext=fontfile=font.otf:textfile=${name}.txt:expansion=none:fontcolor=white:fontsize=44:x=(w-text_w)/2:y=h/2-text_h`, "-frames:v", "1", `${name}.ppm`], { cwd: directory });
      return readFile(join(directory, `${name}.ppm`));
    };
    const expected = await reference("expected", "A日");
    const tofu = await reference("tofu", "A\u{10ffff}");
    const maskDistance = (left: Buffer, right: Buffer) => {
      let different = 0;
      for (let y = 280; y < 400; y++) for (let x = 480; x < 800; x++) {
        const a = ppmPixel(left, x, y); const b = ppmPixel(right, x, y);
        if ((a.r > 180 && a.g > 180 && a.b > 180) !== (b.r > 180 && b.g > 180 && b.b > 180)) different++;
      }
      return different;
    };
    const expectedDistance = maskDistance(actual, expected);
    const tofuDistance = maskDistance(actual, tofu);
    assert.ok(tofuDistance > expectedDistance + 30, `expected reference distance ${expectedDistance}, tofu distance ${tofuDistance}`);
    const xml = compileTimelineIrToFcpxml(source, { target: { provider: "final-cut", libraryUid: "test-library", eventUid: "test-event", projectUid: "test-project", sequenceUid: "test-sequence" } });
    const xmlPath = join(directory, "mixed.fcpxml");
    await writeFile(xmlPath, xml.xml);
    const readback = await new FcpxmlDocumentAdapter(xmlPath).readProject();
    const title = readback.timeline.storyElements.find((item) => item.id === "mixed-title");
    assert.equal(title?.text, "A日");
    assert.deepEqual(title?.startTime, { value: "0", timescale: "1" });
    assert.deepEqual(title?.durationTime, { value: "1", timescale: "2" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("basic 720p title fits the observed Final Cut bounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-title-720-parity-"));
  try {
    await mediaFixtures.copyTo(directory);
    const source = await timeline(join(directory, "fixture-red-440hz.mp4"), join(directory, "fixture-blue-880hz.mp4"));
    delete source.sequence.occurrences[0]!.transform;
    source.sequence.transitions = [];
    source.sequence.titles = [{ id: "title", text: "FADE", startTime: { value: "4", timescale: "5" }, durationTime: { value: "1", timescale: "6" }, lane: 1 }];
    const outputPath = join(directory, "title.mp4");
    const renderer = new FfmpegTimelineRenderer();
    const request = createFramekitRenderRequest({ timeline: source, target: { projectId: source.project.id, sequenceId: source.sequence.id }, parameters: { ...parameters(outputPath), width: 1280, height: 720 } });
    await renderer.render(createFramekitRenderPlan(request, renderer.capabilities(request)));
    const frame = await frameAt(outputPath, 0.9, directory, "title");
    const pixels: Array<[number, number]> = [];
    for (let y = 250; y < 450; y++) for (let x = 480; x < 800; x++) {
      const pixel = ppmPixel(frame, x, y);
      if (pixel.r > 210 && pixel.g > 210 && pixel.b > 210) pixels.push([x, y]);
    }
    assert.ok(pixels.length > 0, "the title must be visible");
    const xs = pixels.map(([x]) => x); const ys = pixels.map(([, y]) => y);
    const width = Math.max(...xs) - Math.min(...xs) + 1;
    const height = Math.max(...ys) - Math.min(...ys) + 1;
    const centerX = (Math.max(...xs) + Math.min(...xs)) / 2;
    const centerY = (Math.max(...ys) + Math.min(...ys)) / 2;
    // Independent native reference: 720p Final Cut export, SHA-256
    // 5ccb88eb9c8021498b7c8abef3390508f6694c6449c373623d41872dcdccd1dd.
    assert.ok(Math.abs(width - 103) <= 10.3 && Math.abs(height - 30) <= 3, `title bounds ${width}x${height}`);
    assert.ok(Math.abs(centerX - 640) <= 12.8 && Math.abs(centerY - 344.5) <= 7.2, `title center ${centerX},${centerY}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("BT.709 dissolve samples meet the 720p Final Cut reference bounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-dissolve-color-"));
  try {
    const paths = [join(directory, "red.mp4"), join(directory, "blue.mp4")];
    for (const [index, color] of ["red", "blue"].entries()) {
      await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=${color}:s=1280x720:r=30:d=2`, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-vf", "scale=in_color_matrix=bt601:out_color_matrix=bt709,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-c:a", "aac", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-movflags", "+write_colr", "-shortest", paths[index]!]);
    }
    const source = await timeline(paths[0]!, paths[1]!);
    const probe = new FfmpegMediaMetadataProbe();
    for (const resource of source.resources) resource.metadata = await probe.probe(resource.source!);
    delete source.sequence.occurrences[0]!.transform;
    source.sequence.occurrences[0]!.sourceStartTime = { value: "1", timescale: "5" };
    source.sequence.occurrences[1]!.sourceStartTime = { value: "1", timescale: "2" };
    source.sequence.transitions![0]!.durationTime = { value: "1", timescale: "5" };
    source.sequence.titles = [];
    const outputPath = join(directory, "dissolve.mp4");
    const renderer = new FfmpegTimelineRenderer();
    const request = createFramekitRenderRequest({ timeline: source, target: { projectId: source.project.id, sequenceId: source.sequence.id }, parameters: { ...parameters(outputPath), width: 1280, height: 720 } });
    await renderer.render(createFramekitRenderPlan(request, renderer.capabilities(request)));
    const raw = await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-i", outputPath, "-map", "0:v:0", "-vf", "crop=2:2:2:2,format=rgb24", "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1"], { encoding: "buffer" });
    const bytes = raw.stdout as unknown as Buffer;
    // Native Final Cut 720p BT.709 export, SHA-256 5ccb88eb9c8021498b7c8abef3390508f6694c6449c373623d41872dcdccd1dd.
    const native = [[242, 0, 69], [218, 0, 124], [190, 0, 160], [161, 0, 193], [123, 0, 218], [69, 0, 242]];
    for (const [index, expected] of native.entries()) {
      const frame = index + 24;
      const observed = [...bytes.subarray(frame * 12, frame * 12 + 3)];
      assert.ok(observed.length === 3 && observed.every((value, channel) => Math.abs(value - expected[channel]!) <= 20), `frame ${frame}: ${observed} vs ${expected}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FFmpeg dissolve preserves incoming video and audio timing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-dissolve-timing-"));
  try {
    await mediaFixtures.copyTo(directory);
    const moving = join(directory, "moving.mp4");
    await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=black:s=320x180:r=30:d=2", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=2", "-vf", "geq=lum='16+N*3':cb=128:cr=128", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", moving]);
    const source = await timeline(join(directory, "fixture-red-440hz.mp4"), moving);
    source.sequence.titles = [];
    delete source.sequence.occurrences[0]!.transform;
    const output = join(directory, "dissolve.mp4");
    const renderer = new FfmpegTimelineRenderer();
    const missingHandle = structuredClone(source);
    missingHandle.sequence.occurrences[1]!.sourceStartTime = { value: "0", timescale: "1" };
    const invalid = createFramekitRenderRequest({ timeline: missingHandle, target: { projectId: source.project.id, sequenceId: source.sequence.id }, parameters: parameters(join(directory, "missing-handle.mp4")) });
    await assert.rejects(renderer.render(createFramekitRenderPlan(invalid, renderer.capabilities(invalid))), /incoming source handles/i);
    await assert.rejects(readFile(invalid.parameters.outputPath), /ENOENT/);
    const request = createFramekitRenderRequest({ timeline: source, target: { projectId: source.project.id, sequenceId: source.sequence.id }, parameters: parameters(output) });
    await renderer.render(createFramekitRenderPlan(request, renderer.capabilities(request)));
    const blend = ppmPixel(await frameAt(output, 0.9, directory, "dissolve-blend"), 160, 150);
    assert.ok(blend.r > blend.g + 20 && blend.g > 10, `expected both source contributions: ${JSON.stringify(blend)}`);
    const levels: number[] = [];
    for (const [label, outputTime, sourceTime] of [["middle", 1.5, 1.0], ["tail", 1.96, 1.46]] as const) {
      const actual = ppmPixel(await frameAt(output, outputTime, directory, `${label}-actual`), 160, 150).r;
      const expected = ppmPixel(await frameAt(moving, sourceTime, directory, `${label}-source`), 160, 150).r;
      assert.ok(Math.abs(actual - expected) <= 8, `${label}: output ${actual}, expected source ${expected}`);
      levels.push(actual);
    }
    assert.ok(levels[1]! - levels[0]! > 15, "incoming video must still move at the tail");
    const tailAudio = await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "info", "-ss", "1.75", "-t", "0.2", "-i", output, "-af", "volumedetect", "-f", "null", "-"]);
    const mean = tailAudio.stderr.match(/mean_volume:\s*(-?[0-9.]+) dB/);
    assert.ok(mean && Number(mean[1]) > -35, `incoming tail audio missing: ${mean?.[1]}`);

    // At 30000/1001 fps, a five-frame transition starts at frame 25 and
    // ends at the frame-30 cut. Inspect decoded frame numbers, not seeks.
    const fractionalPaths = [join(directory, "fractional-red.mp4"), join(directory, "fractional-blue.mp4")];
    for (const [index, color] of ["red", "blue"].entries()) {
      await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=${color}:s=320x180:r=30000/1001:d=3`, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", fractionalPaths[index]!]);
    }
    const fractional = await timeline(fractionalPaths[0]!, fractionalPaths[1]!);
    const frame = (count: number) => ({ value: String(count * 1001), timescale: "30000" });
    fractional.sequence.frameDuration = frame(1);
    fractional.sequence.durationTime = frame(60);
    fractional.sequence.titles = [];
    delete fractional.sequence.occurrences[0]!.transform;
    fractional.sequence.occurrences[0]!.durationTime = frame(30);
    fractional.sequence.occurrences[0]!.sourceStartTime = frame(0);
    fractional.sequence.occurrences[1]!.startTime = frame(30);
    fractional.sequence.occurrences[1]!.durationTime = frame(30);
    fractional.sequence.occurrences[1]!.sourceStartTime = frame(15);
    fractional.sequence.transitions![0]!.durationTime = frame(5);
    for (const resource of fractional.resources) {
      resource.metadata!.durationTime = { value: "3", timescale: "1" };
      resource.metadata!.streams[0]!.frameRate = { value: "30000", timescale: "1001" };
    }
    const fractionalOutput = join(directory, "fractional-dissolve.mp4");
    const fractionalRequest = createFramekitRenderRequest({ timeline: fractional, target: { projectId: fractional.project.id, sequenceId: fractional.sequence.id }, parameters: { ...parameters(fractionalOutput), frameRate: { value: "30000", timescale: "1001" } } });
    await renderer.render(createFramekitRenderPlan(fractionalRequest, renderer.capabilities(fractionalRequest)));
    const decoded = await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-i", fractionalOutput, "-map", "0:v:0", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
    const frames = decoded.stdout as unknown as Buffer;
    const frameSize = 320 * 180 * 3;
    assert.equal(frames.length, 60 * frameSize);
    const pixel = (index: number) => Array.from(frames.subarray(index * frameSize, index * frameSize + 3));
    const pre = pixel(24), start = pixel(25), firstBlend = pixel(26), mixed = pixel(27), cut = pixel(30), last = pixel(59);
    assert.ok(pre[0]! > 220 && pre[2]! < 20, `frame 24 must be red: ${pre}`);
    assert.ok(start[0]! > 220 && start[2]! < 20, `frame 25 must start on red: ${start}`);
    assert.ok(firstBlend[0]! > 30 && firstBlend[2]! > 30, `frame 26 must blend: ${firstBlend}`);
    assert.ok(mixed[0]! > 30 && mixed[2]! > 30, `frame 27 must blend: ${mixed}`);
    assert.ok(cut[2]! > 220 && cut[0]! < 20, `frame 30 must be blue: ${cut}`);
    assert.ok(last[2]! > 220 && last[0]! < 20, `frame 59 must be blue: ${last}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FFmpeg renderer preserves apostrophes in title text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-ffmpeg-renderer-apostrophe-"));
  try {
    await mediaFixtures.copyTo(directory);
    const sourceWithApostrophe = await timeline(
      join(directory, "fixture-red-440hz.mp4"),
      join(directory, "fixture-blue-880hz.mp4"),
    );
    sourceWithApostrophe.sequence.titles![0]!.text = "Framekit's";
    const sourceWithoutApostrophe = structuredClone(sourceWithApostrophe);
    sourceWithoutApostrophe.sequence.titles![0]!.text = "Framekits";

    const renderer = new FfmpegTimelineRenderer({ ffmpegPath: process.env.FFMPEG_BIN || "ffmpeg" });
    const render = async (source: TimelineIr, outputPath: string) => {
      const request = createFramekitRenderRequest({
        timeline: source,
        target: { projectId: source.project.id, sequenceId: source.sequence.id },
        parameters: parameters(outputPath),
      });
      const plan = createFramekitRenderPlan(request, renderer.capabilities(request));
      return renderer.render(plan);
    };
    const withApostrophePath = join(directory, "with-apostrophe.mp4");
    const withoutApostrophePath = join(directory, "without-apostrophe.mp4");
    await render(sourceWithApostrophe, withApostrophePath);
    await render(sourceWithoutApostrophe, withoutApostrophePath);

    const withApostropheFrame = await frameAt(withApostrophePath, 0.25, directory, "with-apostrophe");
    const withoutApostropheFrame = await frameAt(withoutApostrophePath, 0.25, directory, "without-apostrophe");
    assert.notEqual(
      frameDigest(withApostropheFrame),
      frameDigest(withoutApostropheFrame),
      "rendered frame should include the apostrophe glyph",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FFmpeg renderer ends titles before the cut frame", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-title-boundary-"));
  try {
    await mediaFixtures.copyTo(directory);
    const source = await timeline(join(directory, "fixture-red-440hz.mp4"), join(directory, "fixture-blue-880hz.mp4"));
    source.sequence.transitions = [];
    delete source.sequence.occurrences[0]!.transform;
    source.sequence.titles = [source.sequence.titles![0]!];
    source.sequence.titles[0]!.durationTime = { value: "1", timescale: "1" };
    const renderer = new FfmpegTimelineRenderer();
    const render = async (timeline: TimelineIr, label: string, frameRate = { value: "30", timescale: "1" }) => {
      const output = join(directory, `${label}.mp4`);
      const request = createFramekitRenderRequest({ timeline, target: { projectId: timeline.project.id, sequenceId: timeline.sequence.id }, parameters: { ...parameters(output), frameRate } });
      await renderer.render(createFramekitRenderPlan(request, renderer.capabilities(request)));
      return output;
    };
    const baseline = structuredClone(source);
    baseline.sequence.titles = [];
    const baselinePath = await render(baseline, "baseline");
    const output = await render(source, "boundary");
    const bright = async (path: string, index: number, label: string) => {
      const frame = join(directory, `${label}-${index}.ppm`);
      await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-i", path, "-vf", `select=eq(n\\,${index})`, "-frames:v", "1", frame]);
      return countBrightPixels(await readFile(frame), 80, 240, 40, 140);
    };
    const assertTitle = async (path: string, index: number, present: boolean, label: string, referencePath = baselinePath) => {
      const actual = await bright(path, index, label);
      const reference = await bright(referencePath, index, `${label}-baseline`);
      const difference = actual - reference;
      assert.ok(present ? difference > 30 : Math.abs(difference) < 30,
        `frame ${index}: expected title ${present ? "present" : "absent"}; bright-pixel difference ${difference}`);
    };
    for (const [index, present] of [[29, true], [30, false], [31, false]] as const) {
      await assertTitle(output, index, present, "cut");
    }
    source.sequence.titles[0]!.startTime = { value: "2", timescale: "30" };
    const fractionalOutput = await render(source, "fractional");
    for (const [index, present] of [[32, false], [33, false], [1, false], [2, true], [31, true]] as const) {
      await assertTitle(fractionalOutput, index, present, "fractional");
    }
    source.sequence.titles[0]!.startTime = { value: "1", timescale: "20" };
    source.sequence.titles[0]!.durationTime = { value: "9", timescale: "10" };
    const offGridOutput = await render(source, "off-grid");
    for (const [index, present] of [[1, false], [2, true], [28, true], [29, false]] as const) {
      await assertTitle(offGridOutput, index, present, "off-grid");
    }
    const fractionalRate = { value: "30000", timescale: "1001" };
    const rateBaseline = await render(baseline, "rate-baseline", fractionalRate);
    source.sequence.titles[0]!.startTime = { value: "1001", timescale: "15000" };
    source.sequence.titles[0]!.durationTime = { value: "1001", timescale: "1000" };
    const rateOutput = await render(source, "fractional-rate", fractionalRate);
    for (const [index, present] of [[1, false], [2, true], [31, true], [32, false], [33, false]] as const) {
      await assertTitle(rateOutput, index, present, "fractional-rate", rateBaseline);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FFmpeg renderer keeps title text separate from drawtext options", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-ffmpeg-renderer-title-textfile-"));
  try {
    await mediaFixtures.copyTo(directory);
    const source = await timeline(
      join(directory, "fixture-red-440hz.mp4"),
      join(directory, "fixture-blue-880hz.mp4"),
    );
    source.sequence.titles = [source.sequence.titles![0]!];
    source.sequence.titles[0]!.text = "Framekit's";

    const capturePath = join(directory, "captured-render.json");
    const fakeFfmpegPath = join(directory, "fake-ffmpeg.mjs");
    await writeFile(fakeFfmpegPath, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const filterGraph = args[args.indexOf("-filter_complex") + 1];
const titleFile = filterGraph.match(/textfile='([^']+)'/)?.[1];
if (!titleFile) throw new Error("drawtext title did not use a text file");
writeFileSync(process.env.FRAMEKIT_FAKE_CAPTURE, JSON.stringify({
  filterGraph,
  titleText: readFileSync(join(process.cwd(), titleFile), "utf8"),
}));
writeFileSync(args.at(-1), "fake render output");
`);
    await chmod(fakeFfmpegPath, 0o755);

    const renderer = new FfmpegTimelineRenderer({
      ffmpegPath: fakeFfmpegPath,
      env: { FRAMEKIT_FAKE_CAPTURE: capturePath },
    });
    const outputPath = join(directory, "captured-output.mp4");
    const request = createFramekitRenderRequest({
      timeline: source,
      target: { projectId: source.project.id, sequenceId: source.sequence.id },
      parameters: parameters(outputPath),
    });
    await renderer.render(createFramekitRenderPlan(request, renderer.capabilities(request)));

    const captured = JSON.parse(await readFile(capturePath, "utf8")) as {
      filterGraph: string;
      titleText: string;
    };
    assert.equal(captured.titleText, "Framekit's");
    assert.match(captured.filterGraph, /textfile='title-0\.txt':expansion=none:fontcolor=white:fontsize=24/);
    assert.doesNotMatch(captured.filterGraph, /Framekit's/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FFmpeg Timeline IR renderer honors explicit output frame rate without mutating sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-ffmpeg-renderer-"));
  try {
    await mediaFixtures.copyTo(directory);
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
      frameRate: { value: "24", timescale: "1" },
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
    assert.equal(video?.r_frame_rate, "24/1");
    assert.equal(audio?.sample_rate, "48000");
    assert.equal(audio?.channels, 1);
    assert.ok(Number(metadata.format.duration) > 1.95 && Number(metadata.format.duration) < 2.05);
    const earlyFrame = await frameAt(parameters.outputPath, 0.25, directory, "early");
    const transitionFrame = await frameAt(parameters.outputPath, 0.9, directory, "transition");
    const lateFrame = await frameAt(parameters.outputPath, 1.2, directory, "late");
    const rangedBlueFrame = await frameAt(parameters.outputPath, 1.4, directory, "ranged-blue");
    const openingTitleFrame = await frameAt(parameters.outputPath, 0.25, directory, "opening-title");
    const noTitleFrame = await frameAt(parameters.outputPath, 0.75, directory, "no-title");
    const closingTitleFrame = await frameAt(parameters.outputPath, 1.75, directory, "closing-title");
    const noClosingTitleFrame = await frameAt(parameters.outputPath, 1.4, directory, "no-closing-title");
    const earlyPixel = ppmPixel(earlyFrame, 10, 160);
    const transitionPixel = ppmPixel(transitionFrame, 10, 160);
    const latePixel = ppmPixel(lateFrame, 10, 160);
    const rangedPixel = ppmPixel(rangedBlueFrame, 160, 150);
    const unscaledMarkerPixel = ppmPixel(rangedBlueFrame, 20, 90);
    assert.ok(earlyPixel.r > 150 && earlyPixel.b < 80, `expected early red frame, got ${JSON.stringify(earlyPixel)}`);
    assert.ok(transitionPixel.r > 20 && transitionPixel.b > 20, `expected cross-dissolve blend, got ${JSON.stringify(transitionPixel)}`);
    assert.ok(latePixel.b > 150 && latePixel.r < 80, `expected late blue frame, got ${JSON.stringify(latePixel)}`);
    assert.ok(rangedPixel.g > 150 && rangedPixel.b > 150 && rangedPixel.r < 80, `expected non-zero source range to select the cyan scene, got ${JSON.stringify(rangedPixel)}`);
    assert.ok(countBrightPixels(openingTitleFrame, 80, 240, 40, 140) > countBrightPixels(noTitleFrame, 80, 240, 40, 140) + 5, "opening title should render at normalized center only during its window");
    assert.ok(countBrightPixels(closingTitleFrame, 40, 120, 20, 60) > countBrightPixels(noClosingTitleFrame, 40, 120, 20, 60) + 5, "closing title should render at its normalized upper-left position only during its window");
    assert.ok(unscaledMarkerPixel.r < 80, `expected the untransformed marker to leave the left edge blue/cyan, got ${JSON.stringify(unscaledMarkerPixel)}`);
    const unranged = structuredClone(source);
    unranged.sequence.occurrences[1]!.sourceStartTime = { value: "1", timescale: "4" };
    const unrangedParameters = { ...parameters, outputPath: join(directory, "unranged.mp4") };
    const unrangedRequest = createFramekitRenderRequest({
      timeline: unranged,
      target: { projectId: unranged.project.id, sequenceId: unranged.sequence.id },
      parameters: unrangedParameters,
    });
    const unrangedPlan = createFramekitRenderPlan(unrangedRequest, renderer.capabilities(unrangedRequest));
    await renderer.render(unrangedPlan);
    const unrangedFrame = await frameAt(unrangedParameters.outputPath, 1.1, directory, "unranged-blue");
    const rangedComparison = await frameAt(parameters.outputPath, 1.1, directory, "ranged-comparison");
    assert.notEqual(frameDigest(rangedComparison), frameDigest(unrangedFrame), "sourceStartTime must affect the selected rendered segment");

    const scaledBlue = structuredClone(source);
    scaledBlue.sequence.occurrences[1]!.transform = { scaleX: 1.25, scaleY: 1.25 };
    const scaledBlueParameters = { ...parameters, outputPath: join(directory, "scaled-blue.mp4") };
    const scaledBlueRequest = createFramekitRenderRequest({
      timeline: scaledBlue,
      target: { projectId: scaledBlue.project.id, sequenceId: scaledBlue.sequence.id },
      parameters: scaledBlueParameters,
    });
    const scaledBluePlan = createFramekitRenderPlan(scaledBlueRequest, renderer.capabilities(scaledBlueRequest));
    await renderer.render(scaledBluePlan);
    const scaledBlueFrame = await frameAt(scaledBlueParameters.outputPath, 1.4, directory, "scaled-blue");
    const scaledMarkerPixel = ppmPixel(scaledBlueFrame, 20, 90);
    assert.ok(scaledMarkerPixel.r > 150 && scaledMarkerPixel.g > 150 && scaledMarkerPixel.b > 150, `expected scale 1.25 to move the white marker over the left edge, got ${JSON.stringify(scaledMarkerPixel)}`);
    const sourceMeanVolume = await meanVolume(redPath, directory, "source-volume");
    const outputMeanVolume = await meanVolume(parameters.outputPath, directory, "output-volume");
    assert.ok(Math.abs((outputMeanVolume - sourceMeanVolume) - (6 - 3.0103)) < 1.5, `expected +6 dB gain with mono downmix, got ${outputMeanVolume - sourceMeanVolume} dB`);

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

test("FFmpeg renderer fills a trailing video gap with black while music continues", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-ffmpeg-renderer-tail-"));
  try {
    await mediaFixtures.copyTo(directory);
    const musicPath = join(directory, "music-tail.wav");
    await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "sine=frequency=1760:sample_rate=48000:duration=2.5",
      "-c:a", "pcm_s16le", "-y", musicPath,
    ], { cwd: repositoryRoot, env: process.env });

    const source = await timeline(join(directory, "fixture-red-440hz.mp4"), join(directory, "fixture-blue-880hz.mp4"));
    source.sequence.durationTime = { value: "5", timescale: "2" };
    const music = audioResource("music-tail", musicPath, await digest(musicPath));
    music.metadata.durationTime = { value: "5", timescale: "2" };
    source.resources.push(music);
    source.sequence.occurrences.push({
      id: "music-tail",
      name: "Music through trailing gap",
      startTime: { value: "0", timescale: "1" },
      durationTime: { value: "5", timescale: "2" },
      sourceStartTime: { value: "0", timescale: "1" },
      track: 1,
      role: "music",
      mediaId: "music-tail",
      gainDb: -6,
    });
    const outputPath = join(directory, "trailing-gap.mp4");
    const renderer = new FfmpegTimelineRenderer({ ffmpegPath: process.env.FFMPEG_BIN || "ffmpeg" });
    const request = createFramekitRenderRequest({
      timeline: source,
      target: { projectId: source.project.id, sequenceId: source.sequence.id },
      parameters: parameters(outputPath),
    });
    const plan = createFramekitRenderPlan(request, renderer.capabilities(request));

    await renderer.render(plan);

    const probe = await execFileAsync(process.env.FFPROBE_BIN || "ffprobe", [
      "-v", "error",
      "-show_entries", "stream=codec_type,width,height,r_frame_rate,sample_rate,channels",
      "-show_entries", "format=duration",
      "-of", "json",
      outputPath,
    ], { cwd: repositoryRoot, env: process.env });
    const metadata = JSON.parse(probe.stdout) as {
      streams: Array<Record<string, string | number>>;
      format: { duration: string };
    };
    assert.ok(Number(metadata.format.duration) > 2.45 && Number(metadata.format.duration) < 2.55);

    const tailFrame = await frameAt(outputPath, 2.25, directory, "black-tail");
    const tailPixel = ppmPixel(tailFrame, 160, 90);
    assert.ok(tailPixel.r < 20 && tailPixel.g < 20 && tailPixel.b < 20, `expected black video after the final clip, got ${JSON.stringify(tailPixel)}`);

    const tailAudio = await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", [
      "-v", "error", "-ss", "2", "-t", "0.4", "-i", outputPath,
      "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1",
    ], { cwd: repositoryRoot, env: process.env, encoding: "buffer", maxBuffer: 2 * 1024 * 1024 });
    assert.ok(frequencyAmplitude(tailAudio.stdout as unknown as Buffer, 1_760, 48_000) > 0.002, "independent music should continue through the black video tail");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FFmpeg renders a title during a cross-dissolve", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-ffmpeg-transition-title-"));
  try {
    await mediaFixtures.copyTo(directory);
    const source = await timeline(join(directory, "fixture-red-440hz.mp4"), join(directory, "fixture-blue-880hz.mp4"));
    source.sequence.titles = [{
      id: "transition-title",
      text: "FADE",
      startTime: { value: "3", timescale: "4" },
      durationTime: { value: "1", timescale: "2" },
      lane: 1,
      style: { fontSize: 32, color: "white", alignment: "center" },
    }];
    const wrapperPath = join(directory, "capture-ffmpeg.mjs");
    const filterArgsPath = join(directory, "filter-args.json");
    await writeFile(wrapperPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from \"node:fs\";",
      "import { spawnSync } from \"node:child_process\";",
      "writeFileSync(process.env.FRAMEKIT_TEST_FILTER_ARGS, JSON.stringify(process.argv.slice(2)));",
      "const result = spawnSync(process.env.FFMPEG_REAL_BIN, process.argv.slice(2), { stdio: \"inherit\" });",
      "process.exit(result.status ?? 1);",
    ].join("\n"));
    await chmod(wrapperPath, 0o755);
    const renderer = new FfmpegTimelineRenderer({
      ffmpegPath: wrapperPath,
      env: { FRAMEKIT_TEST_FILTER_ARGS: filterArgsPath, FFMPEG_REAL_BIN: process.env.FFMPEG_BIN || "ffmpeg" },
    });
    const outputPath = join(directory, "transition-title.mp4");
    const request = createFramekitRenderRequest({
      timeline: source,
      target: { projectId: source.project.id, sequenceId: source.sequence.id },
      parameters: parameters(outputPath),
    });
    const plan = createFramekitRenderPlan(request, renderer.capabilities(request));
    await renderer.render(plan);
    const ffmpegArgs = JSON.parse(await readFile(filterArgsPath, "utf8")) as string[];
    const filterGraph = ffmpegArgs[ffmpegArgs.indexOf("-filter_complex") + 1];
    assert.match(filterGraph!, /\[video-xfade-padded\]format=yuv420p\[video-titles-base\];\[video-titles-base\]drawtext=/);

    const withoutTitle = structuredClone(source);
    withoutTitle.sequence.titles = [];
    const plainPath = join(directory, "transition-plain.mp4");
    const plainRequest = createFramekitRenderRequest({
      timeline: withoutTitle,
      target: { projectId: withoutTitle.project.id, sequenceId: withoutTitle.sequence.id },
      parameters: parameters(plainPath),
    });
    await renderer.render(createFramekitRenderPlan(plainRequest, renderer.capabilities(plainRequest)));
    const titleFrame = await frameAt(outputPath, 0.9, directory, "transition-title-frame");
    const plainFrame = await frameAt(plainPath, 0.9, directory, "transition-plain-frame");
    assert.ok(
      countBrightPixels(titleFrame, 80, 240, 40, 140) > countBrightPixels(plainFrame, 80, 240, 40, 140) + 5,
      "title should be visible over the cross-dissolve",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FFmpeg mixes independent music with source audio at the requested gain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-ffmpeg-music-mix-"));
  try {
    await mediaFixtures.copyTo(directory);
    const musicPath = join(directory, "music-1760hz.wav");
    await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "sine=frequency=1760:sample_rate=48000:duration=2",
      "-c:a", "pcm_s16le", "-y", musicPath,
    ], { cwd: repositoryRoot, env: process.env });

    const source = await timeline(join(directory, "fixture-red-440hz.mp4"), join(directory, "fixture-blue-880hz.mp4"));
    source.resources.push(audioResource("music", musicPath, await digest(musicPath)));
    source.sequence.titles = [{ id: "transition-title", text: "FADE", startTime: { value: "3", timescale: "4" }, durationTime: { value: "1", timescale: "2" }, lane: 1 }];
    source.sequence.occurrences.push({
      id: "music-bed",
      name: "Music bed",
      startTime: { value: "0", timescale: "1" },
      durationTime: { value: "2", timescale: "1" },
      sourceStartTime: { value: "0", timescale: "1" },
      track: 1,
      role: "music",
      mediaId: "music",
      gainDb: -6,
    });
    const outputPath = join(directory, "music-mix.mp4");
    const renderer = new FfmpegTimelineRenderer({ ffmpegPath: process.env.FFMPEG_BIN || "ffmpeg" });
    const request = createFramekitRenderRequest({
      timeline: source,
      target: { projectId: source.project.id, sequenceId: source.sequence.id },
      parameters: parameters(outputPath),
    });
    const capabilities = renderer.capabilities(request);
    assert.ok(request.requiredFeatures.includes("audio-mixing"));
    assert.equal(capabilities.features["audio-mixing"], "supported");
    const plan = createFramekitRenderPlan(request, capabilities);

    await renderer.render(plan);
    const pcm = await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", [
      "-v", "error", "-i", outputPath, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1",
    ], { cwd: repositoryRoot, env: process.env, encoding: "buffer", maxBuffer: 2 * 1024 * 1024 });
    const samples = pcm.stdout as unknown as Buffer;
    const sourceMusicPcm = await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", [
      "-v", "error", "-i", musicPath, "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1",
    ], { cwd: repositoryRoot, env: process.env, encoding: "buffer", maxBuffer: 2 * 1024 * 1024 });

    assert.ok(frequencyAmplitude(samples, 440, 48_000) > 0.002, "source audio should remain audible in the mix");
    const observedMusicAmplitude = frequencyAmplitude(samples, 1_760, 48_000);
    const expectedMusicAmplitude = frequencyAmplitude(sourceMusicPcm.stdout as unknown as Buffer, 1_760, 48_000) * 10 ** (-6 / 20);
    assert.ok(observedMusicAmplitude > 0.002, "independent music should remain audible in the mix");
    const nativeDownmixExpected = expectedMusicAmplitude * Math.SQRT1_2;
    assert.ok(Math.abs(20 * Math.log10(observedMusicAmplitude / nativeDownmixExpected)) <= 1,
      `mono music must match the Final Cut stereo downmix within 1 dB: ${observedMusicAmplitude} vs ${nativeDownmixExpected}`);
    const window = (from: number, to: number) => samples.subarray(Math.round(from * 48_000) * 4, Math.round(to * 48_000) * 4);
    for (const [label, audio, expectedTone] of [["early", window(0.1, 0.5), 440], ["tail", window(1.5, 1.9), 880]] as const) {
      assert.ok(frequencyAmplitude(audio, expectedTone, 48_000) > 0.002, `${label} source audio must remain audible`);
      assert.ok(frequencyAmplitude(audio, 1_760, 48_000) > 0.002, `${label} music must remain audible`);
    }
    const blendAudio = window(0.82, 0.94);
    assert.ok(frequencyAmplitude(blendAudio, 440, 48_000) > 0.002, "outgoing audio must be present during the dissolve");
    assert.ok(frequencyAmplitude(blendAudio, 880, 48_000) > 0.002, "incoming audio must be present during the dissolve");
    assert.ok(frequencyAmplitude(blendAudio, 1_760, 48_000) > 0.002, "music must remain present during the dissolve");
    // Independent Final Cut export measurements follow a half-sine envelope.
    // Sample each quiet edge against its own unblended source level so that
    // overall gain and channel-layout differences do not mask the curve.
    const incomingBase = frequencyAmplitude(window(1.5, 1.9), 880, 48_000);
    const outgoingBase = frequencyAmplitude(window(0.1, 0.5), 440, 48_000);
    // 25 ms contains a whole number of cycles for all three fixture tones.
    for (const start of [0.775, 0.8, 0.8625, 0.925, 0.95]) {
      const measured = window(start, start + 0.025);
      const progress = (start + 0.0125 - 0.75) / 0.25;
      const incomingExpected = (1 - Math.cos(Math.PI * progress)) / 2;
      const incoming = frequencyAmplitude(measured, 880, 48_000) / incomingBase;
      const outgoing = frequencyAmplitude(measured, 440, 48_000) / outgoingBase;
      assert.ok(Math.abs(incoming - incomingExpected) < 0.035, `incoming at ${start}: ${incoming} vs ${incomingExpected}`);
      assert.ok(Math.abs(outgoing - (1 - incomingExpected)) < 0.035, `outgoing at ${start}: ${outgoing} vs ${1 - incomingExpected}`);
    }
    const noTitle = structuredClone(source);
    noTitle.sequence.titles = [];
    const plain = join(directory, "music-no-title.mp4");
    const plainRequest = createFramekitRenderRequest({ timeline: noTitle, target: { projectId: noTitle.project.id, sequenceId: noTitle.sequence.id }, parameters: parameters(plain) });
    await renderer.render(createFramekitRenderPlan(plainRequest, renderer.capabilities(plainRequest)));
    const titledFrame = await frameAt(outputPath, 0.9, directory, "music-title-frame");
    const plainFrame = await frameAt(plain, 0.9, directory, "music-no-title-frame");
    assert.ok(countBrightPixels(titledFrame, 80, 240, 40, 140) > countBrightPixels(plainFrame, 80, 240, 40, 140) + 5, "title must remain visible over the mixed dissolve");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FFmpeg renders both occurrences that reuse one music resource", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-ffmpeg-reused-music-"));
  try {
    await mediaFixtures.copyTo(directory);
    const musicPath = join(directory, "reused-music.wav");
    await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "sine=frequency=1760:sample_rate=48000:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=2200:sample_rate=48000:duration=1",
      "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[music]",
      "-map", "[music]", "-c:a", "pcm_s16le", "-y", musicPath,
    ], { cwd: repositoryRoot, env: process.env });
    const source = await timeline(join(directory, "fixture-red-440hz.mp4"), join(directory, "fixture-blue-880hz.mp4"));
    delete source.sequence.occurrences[0]!.transform;
    source.sequence.titles = [];
    source.sequence.transitions = [];
    source.resources.push(audioResource("reused-music", musicPath, await digest(musicPath)));
    for (const [index, start] of [0, 1].entries()) {
      source.sequence.occurrences.push({
        id: `music-${index}`,
        name: `Music ${index}`,
        startTime: { value: String(start), timescale: "1" },
        durationTime: { value: "1", timescale: "1" },
        sourceStartTime: { value: String(start), timescale: "1" },
        track: 1,
        role: "music",
        mediaId: "reused-music",
        gainDb: -6,
      });
    }
    const outputPath = join(directory, "reused-music.mp4");
    const renderer = new FfmpegTimelineRenderer({ ffmpegPath: process.env.FFMPEG_BIN || "ffmpeg" });
    const request = createFramekitRenderRequest({
      timeline: source,
      target: { projectId: source.project.id, sequenceId: source.sequence.id },
      parameters: parameters(outputPath),
    });
    const plan = createFramekitRenderPlan(request, renderer.capabilities(request));
    const render = await renderer.render(plan);
    const verification = await new FfmpegRenderVerifier({ ffprobePath: process.env.FFPROBE_BIN || "ffprobe" }).verify(plan, render);
    assert.equal(verification.status, "passed");
    const pcm = await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", [
      "-v", "error", "-i", outputPath, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1",
    ], { cwd: repositoryRoot, env: process.env, encoding: "buffer", maxBuffer: 2 * 1024 * 1024 });
    const samples = pcm.stdout as unknown as Buffer;
    const window = (start: number) => samples.subarray(start * 48_000 * 4, (start + 1) * 48_000 * 4);
    const firstAmplitude = frequencyAmplitude(window(0), 1_760, 48_000);
    const secondAmplitude = frequencyAmplitude(window(1), 2_200, 48_000);
    assert.ok(firstAmplitude > 0.002, `first occurrence should be audible, got ${firstAmplitude}`);
    assert.ok(secondAmplitude > 0.002, `reused second occurrence should be audible, got first=${firstAmplitude}, second=${secondAmplitude}`);

    // Two trimmed uses of the same asset, separated by a gap, must keep
    // their own source offsets and gains rather than sharing playback state.
    const sourceDigest = await digest(musicPath);
    const trimmed = structuredClone(source);
    const first = trimmed.sequence.occurrences.find((item) => item.id === "music-0")!;
    const second = trimmed.sequence.occurrences.find((item) => item.id === "music-1")!;
    first.startTime = { value: "1", timescale: "3" };
    first.sourceStartTime = { value: "1", timescale: "3" };
    first.durationTime = { value: "1", timescale: "3" };
    first.gainDb = -6;
    second.startTime = { value: "4", timescale: "3" };
    second.sourceStartTime = { value: "4", timescale: "3" };
    second.durationTime = { value: "1", timescale: "3" };
    second.gainDb = -12;
    const trimmedOutput = join(directory, "trimmed-reused-music.mp4");
    const trimmedRequest = createFramekitRenderRequest({ timeline: trimmed, target: { projectId: trimmed.project.id, sequenceId: trimmed.sequence.id }, parameters: parameters(trimmedOutput) });
    await renderer.render(createFramekitRenderPlan(trimmedRequest, renderer.capabilities(trimmedRequest)));
    const trimmedPcm = await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-i", trimmedOutput, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"], { encoding: "buffer", maxBuffer: 2 * 1024 * 1024 });
    const trimmedSamples = trimmedPcm.stdout as unknown as Buffer;
    const interval = (start: number, end: number) => trimmedSamples.subarray(Math.round(start * 48_000) * 4, Math.round(end * 48_000) * 4);
    const firstTone = frequencyAmplitude(interval(0.4, 0.6), 1_760, 48_000);
    const secondTone = frequencyAmplitude(interval(1.4, 1.6), 2_200, 48_000);
    assert.ok(firstTone > 0.002 && secondTone > 0.002, "both trimmed source ranges must be audible");
    // The source sine amplitude is 0.125; frequencyAmplitude returns half
    // the peak amplitude. Include the supported mono channel attenuation.
    const fixtureTone = 0.125 * 0.5 * Math.SQRT1_2;
    for (const [observed, gainDb] of [[firstTone, -6], [secondTone, -12]] as const) {
      const expected = fixtureTone * 10 ** (gainDb / 20);
      assert.ok(Math.abs(20 * Math.log10(observed / expected)) <= 1, `music at ${gainDb} dB: ${observed} versus ${expected}`);
    }
    const red = frequencyAmplitude(interval(0.4, 0.6), 440, 48_000);
    const blue = frequencyAmplitude(interval(1.4, 1.6), 880, 48_000);
    // Video fixture audio is an AAC-encoded 0.125-amplitude sine with the
    // first source at +6 dB and the second at its original gain.
    for (const [observed, gainDb] of [[red, 6], [blue, 0]] as const) {
      const expected = fixtureTone * 10 ** (gainDb / 20);
      assert.ok(Math.abs(20 * Math.log10(observed / expected)) <= 1, `source at ${gainDb} dB: ${observed} versus ${expected}`);
    }
    assert.ok(Math.abs(secondTone / firstTone - 10 ** (-6 / 20)) < 0.08, `independent -6 dB gain difference: ${secondTone / firstTone}`);
    assert.ok(frequencyAmplitude(interval(0.8, 1.0), 1_760, 48_000) < firstTone * 0.05, "first tone must stop in the gap");
    assert.ok(frequencyAmplitude(interval(0.8, 1.0), 2_200, 48_000) < secondTone * 0.05, "second tone must not start in the gap");
    assert.equal(await digest(musicPath), sourceDigest, "rendering trimmed occurrences must not modify the source");
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

test("FFmpeg renderer rejects an explicit nonzero sequence timecode origin", () => {
  const source = timelineWithoutMedia();
  const renderer = new FfmpegTimelineRenderer();
  const capabilities = () => {
    const request = createFramekitRenderRequest({
      timeline: source,
      target: { projectId: source.project.id, sequenceId: source.sequence.id },
      parameters: parameters("/tmp/origin.mp4"),
    });
    return renderer.capabilities(request);
  };

  source.sequence.timecodeStart = { value: "0", timescale: "30" };
  assert.equal(capabilities().features["structural-edits"], "supported");
  source.sequence.timecodeStart = { value: "3600", timescale: "1" };
  assert.equal(capabilities().features["structural-edits"], "unsupported");
  source.sequence.timecodeStart = { value: "0", timescale: "1" };
  source.sequence.frameGridOrigin = { value: "1", timescale: "48" };
  assert.equal(capabilities().features["structural-edits"], "unsupported");
});

test("FFmpeg renderer commits no-clobber output atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-ffmpeg-renderer-output-race-"));
  try {
    await mediaFixtures.copyTo(directory);
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
    await mediaFixtures.copyTo(directory);
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
          sourceStartTime: { value: "1", timescale: "4" },
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
          sourceStartTime: { value: "1", timescale: "2" },
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
          position: { x: 0, y: 0 },
        },
        {
          id: "title-closing",
          text: "CLOSE",
          startTime: { value: "3", timescale: "2" },
          durationTime: { value: "1", timescale: "2" },
          lane: 1,
          position: { x: -0.5, y: 0.5 },
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
      durationTime: { value: "2", timescale: "1" },
      streams: [
        { kind: "video" as const, width: 320, height: 180, frameRate: { value: "30", timescale: "1" } },
        { kind: "audio" as const, sampleRate: 48000, channels: 1 },
      ],
    },
  };
}

function audioResource(id: string, source: string, sourceDigest: string) {
  return {
    id,
    name: "Music bed",
    mediaKind: "audio" as const,
    source,
    sourceKind: "local-file" as const,
    sourceDigest,
    metadata: {
      durationTime: { value: "2", timescale: "1" },
      streams: [{ kind: "audio" as const, sampleRate: 48_000, channels: 1 }],
    },
  };
}

function frequencyAmplitude(samples: Buffer, frequency: number, sampleRate: number): number {
  const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate);
  let previous = 0;
  let previous2 = 0;
  const sampleCount = Math.floor(samples.length / 4);
  for (let index = 0; index < sampleCount; index += 1) {
    const current = samples.readFloatLE(index * 4) + coefficient * previous - previous2;
    previous2 = previous;
    previous = current;
  }
  const power = previous2 ** 2 + previous ** 2 - coefficient * previous * previous2;
  return Math.sqrt(Math.max(0, power)) / sampleCount;
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

function frameDigest(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
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

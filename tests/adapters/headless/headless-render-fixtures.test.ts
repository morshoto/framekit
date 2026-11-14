import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const manifestPath = join(repositoryRoot, "tests/fixtures/headless-render/manifest.json");

test("headless render fixtures are reproducible and encode the canonical QA assertions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headless-render-fixtures-"));
  try {
    await execFileAsync(process.execPath, ["scripts/generate-headless-render-fixtures.mjs", directory], {
      cwd: repositoryRoot,
      env: process.env,
    });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      sources: Array<{
        id: string;
        filename: string;
        width: number;
        height: number;
        durationSeconds: number;
        frameRate: { value: string; timescale: string };
        sampleRate: number;
        channels: number;
        temporalVisual?: boolean;
        temporalSamples?: Array<{ timeSeconds: number; x: number; y: number; color: "blue" | "cyan" }>;
      }>;
      expectedWorkflow: { sourceOrder: string[]; sourceRanges: Array<{ sourceId: string; startTime: { value: string; timescale: string }; durationTime: { value: string; timescale: string } }>; titleWindows: unknown[]; transition: unknown; transform: { scaleX: number; scaleY: number }; audioGainDb: number };
    };
    assert.equal(manifest.sources.length, 3);
    assert.deepEqual(manifest.expectedWorkflow.sourceOrder, ["fixture-red-440hz", "fixture-blue-880hz"]);
    assert.deepEqual(manifest.expectedWorkflow.sourceRanges, [
      { sourceId: "fixture-red-440hz", startTime: { value: "1", timescale: "4" }, durationTime: { value: "1", timescale: "1" } },
      { sourceId: "fixture-blue-880hz", startTime: { value: "1", timescale: "2" }, durationTime: { value: "1", timescale: "1" } },
    ]);
    assert.deepEqual(manifest.expectedWorkflow.titleWindows, [
      { id: "title-opening", startTime: { value: "0", timescale: "1" }, durationTime: { value: "1", timescale: "2" }, position: { x: 0, y: 0 } },
      { id: "title-closing", startTime: { value: "3", timescale: "2" }, durationTime: { value: "1", timescale: "2" }, position: { x: -0.5, y: 0.5 } },
    ]);
    assert.deepEqual(manifest.expectedWorkflow.transition, {
      kind: "cross-dissolve",
      boundaryTime: { value: "1", timescale: "1" },
      durationTime: { value: "1", timescale: "4" },
    });
    assert.deepEqual(manifest.expectedWorkflow.transform, { scaleX: 1.25, scaleY: 1.25 });
    assert.equal(manifest.expectedWorkflow.audioGainDb, 6);

    for (const source of manifest.sources) {
      const probe = await execFileAsync(process.env.FFPROBE_BIN || "ffprobe", [
        "-v", "error",
        "-show_entries", "stream=codec_type,width,height,r_frame_rate,sample_rate,channels",
        "-show_entries", "format=duration",
        "-of", "json",
        join(directory, source.filename),
      ], { cwd: repositoryRoot, env: process.env });
      const result = JSON.parse(probe.stdout) as { streams: Array<Record<string, string | number>>; format: { duration: string } };
      const video = result.streams.find((stream) => stream.codec_type === "video");
      const audio = result.streams.find((stream) => stream.codec_type === "audio");
      assert.equal(video?.width, source.width);
      assert.equal(video?.height, source.height);
      assert.equal(video?.r_frame_rate, `${source.frameRate.value}/${source.frameRate.timescale}`);
      assert.equal(audio?.sample_rate, String(source.sampleRate));
      assert.equal(audio?.channels, source.channels);
      assert.ok(Number(result.format.duration) > source.durationSeconds - 0.01 && Number(result.format.duration) < source.durationSeconds + 0.01);
    }

    const temporalSource = manifest.sources.find((source) => source.temporalVisual);
    assert.ok(temporalSource);
    assert.ok(temporalSource.temporalSamples);
    assert.deepEqual(temporalSource.temporalSamples, [
      { timeSeconds: 0.25, x: 160, y: 150, color: "blue" },
      { timeSeconds: 0.75, x: 160, y: 150, color: "cyan" },
    ]);
    const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
    const pixelAt = async (time: number, x: number, y: number) => {
      const framePath = join(directory, `temporal-${time}.ppm`);
      await execFileAsync(ffmpeg, [
        "-v", "error", "-ss", String(time), "-i", join(directory, temporalSource.filename),
        "-frames:v", "1", "-f", "image2", framePath,
      ], { cwd: repositoryRoot, env: process.env });
      return ppmPixel(await readFile(framePath), x, y);
    };
    for (const sample of temporalSource.temporalSamples) {
      const pixel = await pixelAt(sample.timeSeconds, sample.x, sample.y);
      if (sample.color === "blue") {
        assert.ok(pixel.b > 180 && pixel.r < 80 && pixel.g < 80, `expected blue at ${sample.timeSeconds}s, got ${JSON.stringify(pixel)}`);
      } else {
        assert.ok(pixel.g > 180 && pixel.b > 180 && pixel.r < 80, `expected cyan at ${sample.timeSeconds}s, got ${JSON.stringify(pixel)}`);
      }
    }
    const selectedBlueRange = manifest.expectedWorkflow.sourceRanges.find(({ sourceId }) => sourceId === temporalSource.id);
    assert.ok(selectedBlueRange);
    assert.deepEqual(selectedBlueRange.startTime, { value: "1", timescale: "2" });
    assert.ok(0.75 >= Number(selectedBlueRange.startTime.value) / Number(selectedBlueRange.startTime.timescale));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function ppmPixel(contents: Buffer, x: number, y: number): { r: number; g: number; b: number } {
  const headerEnd = contents.indexOf(Buffer.from("\n255\n")) + "\n255\n".length;
  const header = contents.subarray(0, headerEnd).toString("ascii").trim().split(/\s+/);
  const width = Number(header[1]);
  const offset = headerEnd + (y * width + x) * 3;
  return { r: contents[offset]!, g: contents[offset + 1]!, b: contents[offset + 2]! };
}

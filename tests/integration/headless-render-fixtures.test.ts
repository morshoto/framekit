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
      sources: Array<{ id: string; filename: string; width: number; height: number; durationSeconds: number; frameRate: { value: string; timescale: string }; sampleRate: number; channels: number; temporalVisual?: boolean }>;
      expectedWorkflow: { sourceOrder: string[]; sourceRanges: Array<{ sourceId: string; startTime: { value: string; timescale: string }; durationTime: { value: string; timescale: string } }>; titleWindows: unknown[]; transition: unknown; transform: { scaleX: number; scaleY: number }; audioGainDb: number };
    };
    assert.equal(manifest.sources.length, 2);
    assert.deepEqual(manifest.expectedWorkflow.sourceOrder, ["fixture-red-440hz", "fixture-blue-880hz"]);
    assert.deepEqual(manifest.expectedWorkflow.sourceRanges, [
      { sourceId: "fixture-red-440hz", startTime: { value: "1", timescale: "4" }, durationTime: { value: "1", timescale: "1" } },
      { sourceId: "fixture-blue-880hz", startTime: { value: "1", timescale: "2" }, durationTime: { value: "1", timescale: "1" } },
    ]);
    assert.equal(manifest.expectedWorkflow.titleWindows.length, 2);
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
    const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
    const frameDigest = async (time: number) => (await execFileAsync(ffmpeg, [
      "-v", "error", "-ss", String(time), "-i", join(directory, temporalSource.filename),
      "-frames:v", "1", "-f", "md5", "-",
    ], { cwd: repositoryRoot, env: process.env })).stdout.trim();
    assert.notEqual(await frameDigest(0.5), await frameDigest(1.5));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

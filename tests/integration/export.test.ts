import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FinalCutVideoExporter } from "@framekit/final-cut";
import type { FinalCutVideoExportRequest } from "@framekit/final-cut";
import type { NativeFinalCutContext } from "@framekit/final-cut";

test("video exporter uses a supported preset and returns verified output metadata", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-export-"));
  const outputPath = join(directory, "final.mp4");
  const scripts: string[] = [];
  const result = await new FinalCutVideoExporter({
    enabled: true,
    executor: async (script) => {
      scripts.push(script);
      await writeFile(outputPath, "fixture video");
      return "started";
    },
    probe: async () => ({
      durationSeconds: 12,
      width: 1920,
      height: 1080,
      frameRate: 30,
      hasAudio: true,
      videoCodec: "h264",
      audioCodec: "aac",
    }),
    waitMs: 50,
    pollMs: 1,
    sleep: async () => undefined,
  }).exportVideo({
    outputPath,
    preset: "master",
    expected: {
      durationSeconds: 12,
      width: 1920,
      height: 1080,
      frameRate: 30,
      hasAudio: true,
    },
  });

  assert.equal(result.verified, true);
  assert.equal(result.completed, true);
  assert.equal(result.outputPath, outputPath);
  assert.equal(result.preset, "master");
  assert.equal(result.metadata.durationSeconds, 12);
  assert.equal(result.metadata.width, 1920);
  assert.equal(result.metadata.height, 1080);
  assert.equal(result.metadata.frameRate, 30);
  assert.equal(result.metadata.hasAudio, true);
  assert.equal(result.metadata.videoCodec, "h264");
  assert.equal(result.metadata.audioCodec, "aac");
  assert.match(scripts[0] ?? "", /Export File/);
  assert.match(scripts[0] ?? "", /final\.mp4/);
});

test("video exporter refuses a pre-existing output unless overwrite is explicit", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-export-existing-"));
  const outputPath = join(directory, "final.mp4");
  await writeFile(outputPath, "stale video");
  let called = false;
  const exporter = new FinalCutVideoExporter({
    enabled: true,
    executor: async () => {
      called = true;
      return "started";
    },
    probe: async () => ({ durationSeconds: 1, width: 1, height: 1, frameRate: 1, hasAudio: false }),
  });

  await assert.rejects(
    exporter.exportVideo({ outputPath, preset: "master" }),
    /FINAL_CUT_EXPORT_OUTPUT_EXISTS/,
  );
  assert.equal(called, false);
});

test("video exporter detects completion before probing metadata", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-export-timeout-"));
  const outputPath = join(directory, "missing.mp4");
  let probed = false;
  const exporter = new FinalCutVideoExporter({
    enabled: true,
    executor: async () => "started",
    probe: async () => {
      probed = true;
      return { durationSeconds: 1, width: 1920, height: 1080, frameRate: 30, hasAudio: true };
    },
    waitMs: 0,
    sleep: async () => undefined,
  });

  await assert.rejects(
    exporter.exportVideo({ outputPath, preset: "master" }),
    /FINAL_CUT_EXPORT_COMPLETION_TIMEOUT/,
  );
  assert.equal(probed, false);
});

test("video exporter rejects unsupported presets before automation", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-export-preset-"));
  const outputPath = join(directory, "final.mp4");
  let called = false;
  const exporter = new FinalCutVideoExporter({
    enabled: true,
    executor: async () => {
      called = true;
      return "started";
    },
    waitMs: 0,
  });

  await assert.rejects(
    exporter.exportVideo({ outputPath, preset: "unsupported" } as unknown as FinalCutVideoExportRequest),
    /INVALID_EXPORT_PRESET/,
  );
  assert.equal(called, false);
});

test("video exporter verifies every requested media property", async () => {
  const cases: Array<{
    name: string;
    expected: NonNullable<FinalCutVideoExportRequest["expected"]>;
    error: RegExp;
  }> = [
    { name: "duration", expected: { durationSeconds: 9 }, error: /expected duration/ },
    { name: "width", expected: { width: 1280 }, error: /expected width/ },
    { name: "height", expected: { height: 720 }, error: /expected height/ },
    { name: "frame rate", expected: { frameRate: 24 }, error: /expected frame rate/ },
    { name: "audio presence", expected: { hasAudio: false }, error: /expected audio presence/ },
  ];

  for (const [index, candidate] of cases.entries()) {
    const directory = await mkdtemp(join(os.tmpdir(), `framekit-export-mismatch-${index}-`));
    const outputPath = join(directory, "final.mp4");
    const exporter = new FinalCutVideoExporter({
      enabled: true,
      executor: async () => {
        await writeFile(outputPath, "fixture video");
        return "started";
      },
      probe: async () => ({ durationSeconds: 12, width: 1920, height: 1080, frameRate: 30, hasAudio: true }),
      sleep: async () => undefined,
    });

    await assert.rejects(
      exporter.exportVideo({ outputPath, preset: "master", expected: candidate.expected }),
      candidate.error,
      candidate.name,
    );
  }
});

test("video exporter fails closed when native timeline preflight is unavailable", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-export-preflight-"));
  const outputPath = join(directory, "final.mp4");
  let called = false;
  const exporter = new FinalCutVideoExporter({
    enabled: true,
    preflight: async () => ({
      available: false,
      error: {
        code: "FINAL_CUT_NATIVE_TIMELINE_FOCUS_REQUIRED",
        message: "timeline focus required",
      },
    } as unknown as NativeFinalCutContext),
    executor: async () => {
      called = true;
      return "started";
    },
    waitMs: 0,
  });

  await assert.rejects(
    exporter.exportVideo({ outputPath, preset: "master" }),
    /FINAL_CUT_NATIVE_TIMELINE_FOCUS_REQUIRED/,
  );
  assert.equal(called, false);
});

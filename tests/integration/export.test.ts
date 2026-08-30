import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FinalCutVideoExporter } from "@framekit/final-cut";
import type { FinalCutVideoExportRequest } from "@framekit/final-cut";
import type { FinalCutVideoExporterOptions } from "@framekit/final-cut";
import type { NativeFinalCutContext } from "@framekit/final-cut";

function stagingPathFromScript(script: string): string {
  const match = script.match(/set value of first text field of front window to "([^"]+)"/);
  assert.ok(match?.[1], "export script should contain a staging path");
  return match[1];
}

test("video exporter uses a supported preset and returns verified output metadata", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-export-"));
  const outputPath = join(directory, "final.mp4");
  const scripts: string[] = [];
  const result = await new FinalCutVideoExporter({
    enabled: true,
    executor: async (script) => {
      scripts.push(script);
      await writeFile(stagingPathFromScript(script), "fixture video");
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
      semantic: {
        audio: {
          integratedLufs: -18,
          truePeakDb: -3,
          silenceMs: 120,
          audibleSamples: 1_000,
          analyzedDurationSeconds: 12,
        },
        sourceDigest: "sha256:rain",
      },
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
      assertions: [
        { type: "audio-audibility", minAudibleSamples: 1 },
        { type: "audio-coverage", expectedSeconds: 12 },
        { type: "audio-loudness", targetLufs: -18, toleranceDb: 0.5 },
        { type: "audio-source", sourceDigest: "sha256:rain" },
        { type: "stream", target: "audio", expected: true },
      ],
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
  assert.equal(result.verification.passed, true);
  assert.deepEqual(result.verification.checks.map((check) => check.name), [
    "audio-audibility",
    "audio-coverage",
    "audio-loudness",
    "audio-source",
    "stream",
  ]);
  assert.match(scripts[0] ?? "", /Export File/);
  assert.match(scripts[0] ?? "", /menu 1 of menu item "Share" of menu "File"/);
  assert.match(scripts[0] ?? "", /whose name starts with "Export File"/);
  assert.match(scripts[0] ?? "", /\.final\.framekit-[0-9a-f-]+\.mp4/);
});

test("video exporter rejects semantic audio failures before replacing output", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-export-semantic-failure-"));
  const outputPath = join(directory, "final.mp4");
  await writeFile(outputPath, "previous verified video");
  const exporter = new FinalCutVideoExporter({
    enabled: true,
    probeAvailable: true,
    executor: async (script) => {
      await writeFile(stagingPathFromScript(script), "silent replacement");
      return "started";
    },
    probe: async () => ({
      durationSeconds: 12,
      width: 1920,
      height: 1080,
      frameRate: 30,
      hasAudio: true,
      semantic: {
        audio: { integratedLufs: -42, truePeakDb: -40, silenceMs: 12_000, audibleSamples: 0, analyzedDurationSeconds: 12 },
      },
    }),
    sleep: async () => undefined,
  });

  await assert.rejects(
    exporter.exportVideo({
      outputPath,
      preset: "master",
      overwrite: true,
      expected: { assertions: [{ type: "audio-loudness", targetLufs: -18 }] },
    }),
    /FINAL_CUT_EXPORT_SEMANTIC_VERIFICATION_FAILED.*expected.*observed/,
  );
  assert.equal(await readFile(outputPath, "utf8"), "previous verified video");
});

test("video exporter reports unavailable semantic analyzers explicitly", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-export-semantic-unavailable-"));
  const outputPath = join(directory, "final.mp4");
  const exporter = new FinalCutVideoExporter({
    enabled: true,
    executor: async (script) => {
      await writeFile(stagingPathFromScript(script), "unverified output");
      return "started";
    },
    probe: async () => ({ durationSeconds: 12, width: 1920, height: 1080, frameRate: 30, hasAudio: true }),
    sleep: async () => undefined,
  });

  await assert.rejects(
    exporter.exportVideo({
      outputPath,
      preset: "master",
      expected: { assertions: [{ type: "audio-audibility" }] },
    }),
    /FINAL_CUT_EXPORT_SEMANTIC_UNAVAILABLE/,
  );
});

test("video exporter preserves the existing output until a replacement is verified", async () => {
  const failures: Array<{
    name: string;
    configure: (options: FinalCutVideoExporterOptions) => void;
    expected?: FinalCutVideoExportRequest["expected"];
    error: RegExp;
  }> = [
    {
      name: "invalid expectation",
      configure: () => {},
      expected: { width: 0 } as unknown as FinalCutVideoExportRequest["expected"],
      error: /INVALID_EXPORT/,
    },
    {
      name: "native preflight failure",
      configure: (options) => {
        options.preflight = async () => ({
          available: false,
          error: { code: "FINAL_CUT_NATIVE_TIMELINE_FOCUS_REQUIRED", message: "timeline focus required" },
        } as unknown as NativeFinalCutContext);
      },
      error: /FINAL_CUT_NATIVE_TIMELINE_FOCUS_REQUIRED/,
    },
    {
      name: "automation failure",
      configure: (options) => {
        options.executor = async () => {
          throw new Error("FINAL_CUT_EXPORT_AUTOMATION_FAILED: export failed");
        };
      },
      error: /FINAL_CUT_EXPORT_AUTOMATION_FAILED/,
    },
  ];

  for (const failure of failures) {
    const directory = await mkdtemp(join(os.tmpdir(), `framekit-export-preserve-${failure.name.replaceAll(" ", "-")}-`));
    const outputPath = join(directory, "final.mp4");
    await writeFile(outputPath, "previous verified video");
    const options: FinalCutVideoExporterOptions = {
      enabled: true,
      probeAvailable: true,
      probeAvailability: async () => true,
      executor: async (script: string) => {
        await writeFile(stagingPathFromScript(script), "new video");
        return "started";
      },
      probe: async () => ({ durationSeconds: 12, width: 1920, height: 1080, frameRate: 30, hasAudio: true }),
      sleep: async () => undefined,
    };
    failure.configure(options);
    const exporter = new FinalCutVideoExporter(options);

    await assert.rejects(
      exporter.exportVideo({ outputPath, preset: "master", overwrite: true, expected: failure.expected }),
      failure.error,
      failure.name,
    );
    assert.equal(await readFile(outputPath, "utf8"), "previous verified video", failure.name);
  }
});

test("video exporter replaces an existing output only after verification", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-export-replace-"));
  const outputPath = join(directory, "final.mp4");
  await writeFile(outputPath, "previous verified video");
  let outputDuringExport = "";
  const exporter = new FinalCutVideoExporter({
    enabled: true,
    probeAvailable: true,
    executor: async (script) => {
      outputDuringExport = await readFile(outputPath, "utf8");
      await writeFile(stagingPathFromScript(script), "replacement video");
      return "started";
    },
    probe: async () => ({ durationSeconds: 12, width: 1920, height: 1080, frameRate: 30, hasAudio: true }),
    sleep: async () => undefined,
  });

  await exporter.exportVideo({ outputPath, preset: "master", overwrite: true });
  assert.equal(outputDuringExport, "previous verified video");
  assert.equal(await readFile(outputPath, "utf8"), "replacement video");
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
    const stagedExporter = new FinalCutVideoExporter({
      enabled: true,
      executor: async (script) => {
        await writeFile(stagingPathFromScript(script), "fixture video");
        return "started";
      },
      probe: async () => ({ durationSeconds: 12, width: 1920, height: 1080, frameRate: 30, hasAudio: true }),
      sleep: async () => undefined,
    });

    await assert.rejects(
      stagedExporter.exportVideo({ outputPath, preset: "master", expected: candidate.expected }),
      candidate.error,
      candidate.name,
    );
  }
});

test("video exporter waits for stable output before probing metadata", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-export-stable-"));
  const outputPath = join(directory, "final.mp4");
  let stagingPath = "";
  let sleepCalls = 0;
  let probeCalls = 0;
  const exporter = new FinalCutVideoExporter({
    enabled: true,
    executor: async (script) => {
      stagingPath = stagingPathFromScript(script);
      await writeFile(stagingPath, "first partial output");
      return "started";
    },
    probe: async () => {
      probeCalls += 1;
      return { durationSeconds: 12, width: 1920, height: 1080, frameRate: 30, hasAudio: true };
    },
    sleep: async () => {
      sleepCalls += 1;
      if (sleepCalls === 1) await writeFile(stagingPath, "second completed output");
    },
  });

  await exporter.exportVideo({ outputPath, preset: "master" });
  assert.ok(sleepCalls >= 2);
  assert.equal(probeCalls, 1);
});

test("video exporter checks probe availability before native automation", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-export-probe-"));
  const outputPath = join(directory, "final.mp4");
  await writeFile(outputPath, "previous verified video");
  let preflightCalled = false;
  let executorCalled = false;
  const exporter = new FinalCutVideoExporter({
    enabled: true,
    probeAvailable: true,
    probeAvailability: async () => false,
    preflight: async () => {
      preflightCalled = true;
      return {} as NativeFinalCutContext;
    },
    executor: async () => {
      executorCalled = true;
      return "started";
    },
  });

  await assert.rejects(
    exporter.exportVideo({ outputPath, preset: "master", overwrite: true }),
    /FINAL_CUT_EXPORT_METADATA_UNAVAILABLE/,
  );
  assert.equal(preflightCalled, false);
  assert.equal(executorCalled, false);
  assert.equal(await readFile(outputPath, "utf8"), "previous verified video");
});

test("video exporter fails closed when native timeline preflight is unavailable", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-export-preflight-"));
  const outputPath = join(directory, "final.mp4");
  let called = false;
  const exporter = new FinalCutVideoExporter({
    enabled: true,
    probeAvailability: async () => true,
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

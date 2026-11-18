import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { evaluateExportMeasurements, measureExport } from "../../../scripts/manual-import-qa.js";

const valid = () => ({
  durationSeconds: 3,
  samples: [
    { timeSeconds: 0.5, rgb: [235, 20, 20] as [number, number, number] },
    { timeSeconds: 1.5, rgb: [20, 235, 20] as [number, number, number] },
    { timeSeconds: 2.5, rgb: [20, 20, 235] as [number, number, number] },
  ],
  toneAmplitudes: [0.025, 0.024, 0.023],
});

test("manual import output checks independently verify timing, clip colors and music", () => {
  const result = evaluateExportMeasurements(valid());
  assert.equal(result.status, "PASS");
  assert.equal(result.nativeImport, "UNVERIFIED");
  assert.equal(result.titleEditability, "UNVERIFIED");
  assert.equal(result.finalCutProvenance, "UNVERIFIED");
});

test("manual import output checks reject incorrect duration, order and silent audio", () => {
  for (const invalid of [
    { ...valid(), durationSeconds: 2.6 },
    { ...valid(), samples: [valid().samples[1]!, valid().samples[0]!, valid().samples[2]!] },
    { ...valid(), toneAmplitudes: [0.025, 0, 0.023] },
    { ...valid(), toneAmplitudes: [0.025, Number.NaN, 0.023] },
  ]) assert.equal(evaluateExportMeasurements(invalid).status, "FAIL");
});


test("measures real media and rejects a silent copy without claiming Final Cut provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-manual-measure-"));
  const run = promisify(execFile);
  try {
    const video = join(directory, "observed.mp4");
    const silent = join(directory, "silent.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-n",
      "-f", "lavfi", "-i", "color=red:s=320x180:r=30:d=1",
      "-f", "lavfi", "-i", "color=lime:s=320x180:r=30:d=1",
      "-f", "lavfi", "-i", "color=blue:s=320x180:r=30:d=1",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=3",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-map", "3:a",
      "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "3", video]);
    const measured = await measureExport(video);
    assert.equal(evaluateExportMeasurements(measured).status, "PASS");
    assert.equal(evaluateExportMeasurements(measured).finalCutProvenance, "UNVERIFIED");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-n", "-i", video, "-an", "-c:v", "copy", silent]);
    assert.equal(evaluateExportMeasurements(await measureExport(silent)).status, "FAIL");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

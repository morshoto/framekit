import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { FcpxmlDocumentAdapter } from "@framekit/final-cut";
import { evaluateExportMeasurements, measureExport, prepareManualImportFixture, verifyManualExport } from "../../../scripts/manual-import-qa.js";

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


test("prepares three trimmed clips through production MCP without claiming native acceptance", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-765-prepare-"));
  try {
    const destination = join(root, "fixture");
    const result = await prepareManualImportFixture(destination);
    assert.equal(result.nativeImport, "UNVERIFIED");
    assert.equal(result.finalCutExport, "UNVERIFIED");
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.sources.length, 4);
    for (const source of manifest.sources) {
      const actual = createHash("sha256").update(await readFile(join(destination, source.filename))).digest("hex");
      assert.equal(actual, source.sha256);
    }
    assert.equal(createHash("sha256").update(await readFile(result.artifactPath)).digest("hex"), manifest.artifact.sha256);
    const xml = await new FcpxmlDocumentAdapter(result.artifactPath).readProject();
    const source = (id: string | undefined) => xml.media.find((item) => item.mediaId === id)?.source;
    assert.deepEqual(xml.timeline.clips.filter((clip) => clip.track === 0).map((clip) => [source(clip.mediaId), clip.sourceStart, clip.duration]), [
      [join(destination, "red.mp4"), 1, 1], [join(destination, "green.mp4"), 1, 1], [join(destination, "blue.mp4"), 1, 1],
    ]);
    assert.equal(xml.timeline.storyElements.find((item) => item.kind === "title")?.text, "FRAMEKIT QA");
    assert.match(await readFile(result.artifactPath, "utf8"), /<adjust-volume amount="-12dB" \/>/);
    await assert.rejects(prepareManualImportFixture(destination), /EEXIST/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("output inspection binds source hashes and keeps native evidence unverified", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-765-inspect-"));
  const run = promisify(execFile);
  try {
    const fixture = join(root, "fixture");
    await prepareManualImportFixture(fixture);
    const output = join(root, "synthetic.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-n",
      "-f", "lavfi", "-i", "color=red:s=320x180:r=30:d=1",
      "-f", "lavfi", "-i", "color=lime:s=320x180:r=30:d=1",
      "-f", "lavfi", "-i", "color=blue:s=320x180:r=30:d=1",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=3",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-map", "3:a",
      "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "3", output]);
    const report = await verifyManualExport(fixture, output, join(root, "observations"));
    assert.equal(report.measurements.status, "PASS");
    assert.equal(report.measurements.finalCutProvenance, "UNVERIFIED");
    assert.equal(report.measurements.titleEditability, "UNVERIFIED");
    assert.equal(report.titleVisibility, "UNVERIFIED");
    assert.ok((await readFile(report.titleFramePath)).length > 0);
    await assert.rejects(verifyManualExport(fixture, output, join(root, "observations")), /EEXIST/);
    await writeFile(join(fixture, "red.mp4"), "changed");
    await assert.rejects(verifyManualExport(fixture, output, join(root, "another-observation")), /source.*changed/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

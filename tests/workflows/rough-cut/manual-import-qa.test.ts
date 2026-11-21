import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { FcpxmlDocumentAdapter } from "@framekit/final-cut";
import { compareDissolveParity, compareDissolveVideos, evaluateDissolveExportMeasurements, evaluateExportMeasurements, evaluateRevisedExportMeasurements, inspectDissolveExport, measureDissolveExport, measureExport, measureFixtureTitleBounds, prepareManualImportFixture, verifyManualExport, verifyPreparedArtifact } from "../../../scripts/manual-import-qa.js";

const valid = () => ({
  durationSeconds: 3,
  frameCount: 90,
  frameRate: "30/1",
  boundarySamples: [
    { frameNumber: 29, rgb: [235, 20, 20] as [number, number, number] },
    { frameNumber: 30, rgb: [20, 235, 20] as [number, number, number] },
    { frameNumber: 59, rgb: [20, 235, 20] as [number, number, number] },
    { frameNumber: 60, rgb: [20, 20, 235] as [number, number, number] },
  ],
  samples: [
    { timeSeconds: 0.5, rgb: [235, 20, 20] as [number, number, number] },
    { timeSeconds: 1.5, rgb: [20, 235, 20] as [number, number, number] },
    { timeSeconds: 2.5, rgb: [20, 20, 235] as [number, number, number] },
  ],
  toneAmplitudes: [0.025, 0.024, 0.023],
});

test("dissolve parity applies declared bounds without claiming native proof", () => {
  const reference = {
    durationSeconds: 2, frameCount: 60, frameRate: "30/1",
    frames: [
      { frameNumber: 23, rgb: [244, 0, 0] as [number, number, number] },
      { frameNumber: 25, rgb: [212, 0, 124] as [number, number, number] },
      { frameNumber: 27, rgb: [157, 0, 194] as [number, number, number] },
      { frameNumber: 29, rgb: [70, 0, 236] as [number, number, number] },
      { frameNumber: 30, rgb: [0, 251, 255] as [number, number, number] },
    ],
    audio: [
      { timeSeconds: 0.5, outgoing: 0.088, incoming: 0, music: 0.022 },
      { timeSeconds: 0.825, outgoing: 0.084, incoming: 0.004, music: 0.022 },
      { timeSeconds: 0.9, outgoing: 0.044, incoming: 0.044, music: 0.022 },
      { timeSeconds: 0.975, outgoing: 0.004, incoming: 0.084, music: 0.022 },
      { timeSeconds: 1.5, outgoing: 0, incoming: 0.088, music: 0.022 },
    ],
  };
  const revised = structuredClone(reference);
  for (const window of revised.audio) window.music *= 10 ** (3 / 20);
  assert.equal(evaluateDissolveExportMeasurements(revised, -9).status, "PASS");
  assert.equal(evaluateDissolveExportMeasurements(revised).status, "FAIL");
  assert.equal(evaluateDissolveExportMeasurements(reference, -9).status, "FAIL");
  assert.equal(compareDissolveParity(revised, revised, { x: 589, y: 330, width: 103, height: 30 }, { x: 589, y: 330, width: 103, height: 30 }, -9).status, "PASS");
  const alteredRevision = structuredClone(revised);
  alteredRevision.audio[2]!.music *= 0.7;
  assert.equal(compareDissolveParity(revised, alteredRevision, { x: 589, y: 330, width: 103, height: 30 }, { x: 589, y: 330, width: 103, height: 30 }, -9).status, "FAIL");
  const bounds = { x: 589, y: 330, width: 103, height: 30 };
  const result = compareDissolveParity(reference, structuredClone(reference), bounds, bounds);
  assert.equal(result.status, "PASS");
  assert.equal(result.nativeImport, "UNVERIFIED");
  assert.equal(result.exactBoundaries, "UNVERIFIED");
  const edgeColor = structuredClone(reference); edgeColor.frames[2]!.rgb[0] -= 20;
  assert.equal(compareDissolveParity(reference, edgeColor, bounds, bounds).checks.colors, true);
  assert.equal(compareDissolveParity(reference, reference, { ...bounds, width: 100 }, { ...bounds, width: 110 }).checks.titleSize, true);
  const dark = structuredClone(reference); dark.frames[2]!.rgb[0] -= 21;
  assert.equal(compareDissolveParity(reference, dark, bounds, bounds).checks.colors, false);
  const quiet = structuredClone(reference); quiet.audio[2]!.music *= 0.8;
  assert.equal(compareDissolveParity(reference, quiet, bounds, bounds).checks.audio, false);
  assert.equal(compareDissolveParity(reference, reference, bounds, { ...bounds, width: 80 }).checks.titleSize, false);
  assert.equal(compareDissolveParity(reference, reference, bounds, { ...bounds, x: bounds.x + 15 }).checks.titlePosition, false);
  const missing = structuredClone(reference); missing.frames.pop();
  assert.equal(compareDissolveParity(reference, missing, bounds, bounds).status, "FAIL");
  assert.equal(compareDissolveParity(reference, reference, bounds, { ...bounds, width: NaN }).status, "FAIL");
});

test("title measurement uses the specified frame and rejects missing titles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-title-measure-"));
  try {
    const video = join(directory, "title.mp4");
    await promisify(execFile)(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=1280x720:r=30:d=2", "-vf", "drawbox=x=600:y=330:w=80:h=30:color=white:t=fill:enable='between(n,24,29)'", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", video]);
    assert.deepEqual(await measureFixtureTitleBounds(video, 27), { x: 600, y: 330, width: 80, height: 30 });
    await assert.rejects(measureFixtureTitleBounds(video, 30), /TITLE_NOT_DETECTED/);
    await assert.rejects(compareDissolveVideos(video, video, join(directory, "report")), /AUDIO_FORMAT_UNSUPPORTED/);
    await assert.rejects(readFile(join(directory, "report", "parity.json")), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("video parity comparison binds bytes and reports unverified native evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-parity-videos-"));
  try {
    const reference = join(directory, "reference.mp4"), candidate = join(directory, "candidate.mp4");
    await promisify(execFile)(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-filter_complex_threads", "1",
      "-f", "lavfi", "-i", "color=red:s=1280x720:r=30:d=1",
      "-f", "lavfi", "-i", "color=blue:s=1280x720:r=30:d=0.2",
      "-f", "lavfi", "-i", "color=cyan:s=1280x720:r=30:d=1",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=1.2",
      "-f", "lavfi", "-i", "sine=frequency=1760:sample_rate=48000:duration=2",
      "-filter_complex", "[1:v][2:v]concat=n=2:v=1:a=0,settb=1/30[vc];[0:v][vc]xfade=transition=fade:duration=0.2:offset=0.8,drawbox=x=600:y=330:w=80:h=30:color=white:t=fill:enable='between(n,24,29)'[v];[3:a][4:a]acrossfade=d=0.2:c1=hsin:c2=hsin[a];[5:a]volume=-12dB[m];[a][m]amix=inputs=2:normalize=0[aout]",
      "-map", "[v]", "-map", "[aout]", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-ar", "48000", "-t", "2", reference]);
    await promisify(execFile)(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-i", reference, "-c:v", "copy", "-af", "pan=mono|c0=0.7071067811865476*c0+0.7071067811865476*c1", "-c:a", "aac", "-ar", "48000", candidate]);
    const report = await compareDissolveVideos(reference, candidate, join(directory, "report"));
    assert.equal(report.comparison.status, "PASS");
    assert.equal(report.comparison.exactBoundaries, "UNVERIFIED");
    assert.equal(report.comparison.finalCutProvenance, "UNVERIFIED");
    assert.equal(report.referenceSha256, createHash("sha256").update(await readFile(reference)).digest("hex"));
    assert.equal(report.candidateSha256, createHash("sha256").update(await readFile(candidate)).digest("hex"));
    await assert.rejects(compareDissolveVideos(reference, reference, join(directory, "wrong-format")), /AUDIO_FORMAT_UNSUPPORTED/);
    const quiet = join(directory, "quiet.mp4");
    await promisify(execFile)(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-i", candidate, "-c:v", "copy", "-af", "volume=-2dB", "-c:a", "aac", quiet]);
    const negative = await compareDissolveVideos(reference, quiet, join(directory, "quiet-report"));
    assert.equal(negative.comparison.status, "FAIL");
    assert.equal(negative.comparison.checks.audio, false);
    const misleading = join(directory, "multiple-audio.mp4");
    await promisify(execFile)(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-i", reference, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-map", "0:v:0", "-map", "1:a:0", "-map", "0:a:0", "-c:v", "copy", "-c:a", "aac", "-t", "2", misleading]);
    const wrongStream = await compareDissolveVideos(reference, misleading, join(directory, "multiple-audio-report"));
    assert.equal(wrongStream.comparison.status, "FAIL", "a silent validated first stream must not be masked by a matching secondary stream");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("revised export checks verify clip boundaries and music through the black tail", () => {
  const revised = { ...valid(), samples: [
    { timeSeconds: 0.5, rgb: [20, 20, 235] as [number, number, number] },
    { timeSeconds: 1.5, rgb: [235, 20, 20] as [number, number, number] },
    { timeSeconds: 2.25, rgb: [20, 235, 20] as [number, number, number] },
    { timeSeconds: 2.75, rgb: [0, 0, 0] as [number, number, number] },
  ], boundarySamples: [
    { frameNumber: 29, rgb: [20, 20, 235] as [number, number, number] },
    { frameNumber: 30, rgb: [235, 20, 20] as [number, number, number] },
    { frameNumber: 59, rgb: [235, 20, 20] as [number, number, number] },
    { frameNumber: 60, rgb: [20, 235, 20] as [number, number, number] },
    { frameNumber: 74, rgb: [20, 235, 20] as [number, number, number] },
    { frameNumber: 75, rgb: [0, 0, 0] as [number, number, number] },
  ], toneAmplitudes: [0.02, 0.02, 0.02, 0.02] };
  assert.equal(evaluateRevisedExportMeasurements(revised).status, "PASS");
  assert.equal(evaluateRevisedExportMeasurements({ ...revised, boundarySamples: revised.boundarySamples.slice(0, 4) }).status, "FAIL");
  assert.equal(evaluateRevisedExportMeasurements({ ...revised, toneAmplitudes: [0.02, 0.02, 0.02, 0] }).status, "FAIL");
  assert.equal(evaluateRevisedExportMeasurements({ ...revised, durationSeconds: 2.5 }).status, "FAIL");
});

test("revised export measurement decodes real clip and tail boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-revised-measure-"));
  try {
    const video = join(directory, "revised.mp4");
    await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-n",
      "-f", "lavfi", "-i", "color=blue:s=320x180:r=30:d=1",
      "-f", "lavfi", "-i", "color=red:s=320x180:r=30:d=1",
      "-f", "lavfi", "-i", "color=lime:s=320x180:r=30:d=0.5",
      "-f", "lavfi", "-i", "color=black:s=320x180:r=30:d=0.5",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=3",
      "-filter_complex", "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]", "-map", "[v]", "-map", "4:a",
      "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "3", video]);
    const measured = await measureExport(video, "revised");
    assert.equal(evaluateRevisedExportMeasurements(measured).status, "PASS");
    assert.equal(evaluateRevisedExportMeasurements(measured).finalCutProvenance, "UNVERIFIED");
    assert.equal(evaluateExportMeasurements(measured).status, "FAIL");
    const dissolvePath = join(directory, "dissolve.mp4");
    await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-n", "-filter_complex_threads", "1",
      "-f", "lavfi", "-i", "color=red:s=320x180:r=30:d=1",
      "-f", "lavfi", "-i", "color=blue:s=320x180:r=30:d=0.2",
      "-f", "lavfi", "-i", "color=cyan:s=320x180:r=30:d=1",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=1.2",
      "-f", "lavfi", "-i", "sine=frequency=1760:sample_rate=48000:duration=2",
      "-filter_complex", "[1:v][2:v]concat=n=2:v=1:a=0,settb=1/30[vc];[0:v][vc]xfade=transition=fade:duration=0.2:offset=0.8[v];[3:a][4:a]acrossfade=d=0.2:c1=hsin:c2=hsin[a];[5:a]volume=-12dB[m];[a][m]amix=inputs=2:normalize=0[aout]",
      "-map", "[v]", "-map", "[aout]", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "2", dissolvePath]);
    const dissolve = await measureDissolveExport(dissolvePath);
    const evaluation = evaluateDissolveExportMeasurements(dissolve);
    assert.equal(evaluation.status, "PASS");
    assert.equal(evaluation.finalCutProvenance, "UNVERIFIED");
    const reportDirectory = join(directory, "dissolve-report");
    const report = await inspectDissolveExport(dissolvePath, reportDirectory);
    assert.equal(report.exportSha256, createHash("sha256").update(await readFile(dissolvePath)).digest("hex"));
    assert.equal(report.measurements.status, "PASS");
    assert.equal(report.measurements.nativeImport, "UNVERIFIED");
    assert.equal(report.titleVisibility, "UNVERIFIED");
    assert.deepEqual(JSON.parse(await readFile(join(reportDirectory, "observation.json"), "utf8")), report);
    await assert.rejects(inspectDissolveExport(dissolvePath, reportDirectory), /EEXIST/);
    const silent = join(directory, "silent-dissolve.mp4");
    await promisify(execFile)("ffmpeg", ["-v", "error", "-i", dissolvePath, "-an", "-c:v", "copy", silent]);
    assert.equal(evaluateDissolveExportMeasurements(await measureDissolveExport(silent)).status, "FAIL");
  } finally { await rm(directory, { recursive: true, force: true }); }
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

  // Independent expected semantics for a two-second red-to-blue edit with a
  // six-frame dissolve, 440/880 Hz sources and a 1760 Hz music bed.
  const dissolve = {
    durationSeconds: 2, frameCount: 60, frameRate: "30/1",
    frames: [
      { frameNumber: 23, rgb: [244, 30, 0] as [number, number, number] },
      { frameNumber: 25, rgb: [212, 31, 124] as [number, number, number] },
      { frameNumber: 27, rgb: [157, 30, 194] as [number, number, number] },
      { frameNumber: 29, rgb: [70, 11, 236] as [number, number, number] },
      { frameNumber: 30, rgb: [60, 251, 255] as [number, number, number] },
    ],
    audio: [
      { timeSeconds: 0.5, outgoing: 0.088, incoming: 0, music: 0.022 },
      { timeSeconds: 0.825, outgoing: 0.084, incoming: 0.004, music: 0.022 },
      { timeSeconds: 0.9, outgoing: 0.044, incoming: 0.044, music: 0.022 },
      { timeSeconds: 0.975, outgoing: 0.004, incoming: 0.084, music: 0.022 },
      { timeSeconds: 1.5, outgoing: 0, incoming: 0.088, music: 0.022 },
    ],
  };
  const result = evaluateDissolveExportMeasurements(dissolve);
  assert.equal(result.status, "PASS");
  assert.equal(result.nativeImport, "UNVERIFIED");
  assert.equal(result.titleEditability, "UNVERIFIED");
  assert.equal(result.finalCutProvenance, "UNVERIFIED");
  const hardCut = structuredClone(dissolve);
  for (const frame of hardCut.frames.slice(1, 4)) frame.rgb = [244, 30, 0];
  const silentMusic = structuredClone(dissolve);
  silentMusic.audio[2]!.music = 0;
  const badFade = structuredClone(dissolve);
  badFade.audio[2]!.incoming = 0;
  const linearFade = structuredClone(dissolve);
  linearFade.audio[1]!.outgoing = 0.077;
  linearFade.audio[1]!.incoming = 0.011;
  linearFade.audio[3]!.outgoing = 0.011;
  linearFade.audio[3]!.incoming = 0.077;
  for (const invalid of [{ ...dissolve, frameCount: 66 }, hardCut, silentMusic, badFade, linearFade, { ...dissolve, frames: dissolve.frames.slice(0, 4) }]) {
    assert.equal(evaluateDissolveExportMeasurements(invalid).status, "FAIL");
  }
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
    const previousProvider = process.env.FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER;
    process.env.FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER = "native";
    let result: Awaited<ReturnType<typeof prepareManualImportFixture>>;
    try { result = await prepareManualImportFixture(destination); }
    finally {
      if (previousProvider === undefined) delete process.env.FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER;
      else process.env.FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER = previousProvider;
    }
    assert.equal(result.nativeImport, "UNVERIFIED");
    assert.equal(result.finalCutExport, "UNVERIFIED");
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    const input = JSON.parse(await readFile(join(destination, "input-edit.json"), "utf8"));
    const preview = JSON.parse(await readFile(join(destination, "preview-receipt.json"), "utf8"));
    const execution = JSON.parse(await readFile(join(destination, "execution-receipt.json"), "utf8"));
    assert.equal(input.schemaVersion, 1);
    assert.equal(input.request.projectId, preview.projectId);
    assert.equal(input.request.sequenceId, preview.sequenceId);
    assert.deepEqual(input.request.expectedRevision, preview.baseRevision);
    assert.deepEqual(input.request.edit.clips.map((clip: { mediaId: string }) => clip.mediaId), manifest.sources.slice(0, 3).map((source: { mediaId: string }) => source.mediaId));
    assert.equal(input.request.edit.music.mediaId, manifest.sources[3].mediaId);
    assert.match(preview.planDigest, /^[a-f0-9]{64}$/);
    assert.equal(execution.planDigest, preview.planDigest);
    assert.equal(execution.approved, true);
    assert.equal(execution.committed, true);
    assert.deepEqual(execution.revision, manifest.artifact.revision);
    assert.equal(execution.export.sha256, manifest.artifact.sha256);
    assert.equal(execution.export.digest, execution.export.sha256);
    assert.equal(execution.export.verified, true);
    for (const filename of ["input-edit.json", "preview-receipt.json", "execution-receipt.json"]) {
      assert.equal(createHash("sha256").update(await readFile(join(destination, filename))).digest("hex"), manifest.receipts[filename]);
    }
    assert.equal(manifest.sources.length, 4);
    assert.match(manifest.candidate.commit, /^[a-f0-9]{40}$/);
    assert.equal(typeof manifest.candidate.dirty, "boolean");
    assert.ok(manifest.candidate.framekitVersion);
    assert.ok(manifest.environment.nodeVersion);
    assert.match(manifest.environment.ffmpegVersion, /^ffmpeg version /);
    assert.equal(manifest.environment.finalCutVersion, "UNVERIFIED");
    assert.ok(manifest.environment.osVersion);
    assert.equal(new Set(manifest.sources.map((source: { mediaId: string }) => source.mediaId)).size, 4);
    for (const source of manifest.sources) {
      assert.ok(source.mediaId);
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
    const xmlText = await readFile(result.artifactPath, "utf8");
    assert.match(xmlText, /<format id="r1" name="FFVideoFormat720p30" frameDuration="1\/30s" width="1280" height="720"\s*\/>/);
    assert.match(xmlText, /<adjust-volume amount="-12dB" \/>/);
    await verifyPreparedArtifact(result.artifactPath, destination);
    await writeFile(result.artifactPath, xmlText.replace('frameDuration="1/30s"', 'frameDuration="1/25s"'));
    await assert.rejects(verifyPreparedArtifact(result.artifactPath, destination), /frame duration/i);
    await writeFile(result.artifactPath, xmlText.replace('frameDuration="1/30s"', 'frameDuration="2/60s"'));
    await verifyPreparedArtifact(result.artifactPath, destination);
    const gainMoved = xmlText.replace('<adjust-volume amount="-12dB" />', '')
      .replace(/(<asset-clip\b[^>]*name="clip-1"[^>]*>)/, '$1<adjust-volume amount="-12dB" />');
    await writeFile(result.artifactPath, gainMoved);
    await assert.rejects(verifyPreparedArtifact(result.artifactPath, destination), /music/i);
    const tags = xmlText.match(/<asset-clip\b[^>]*>/g) ?? [];
    const primary = tags.find((tag) => !tag.includes('audioRole="music"'))!;
    const music = tags.find((tag) => tag.includes('audioRole="music"'))!;
    const primaryRef = /ref="([^"]+)"/.exec(primary)![1]!;
    await writeFile(result.artifactPath, xmlText.replace(music, music.replace(/ref="[^"]+"/, `ref="${primaryRef}"`)));
    await assert.rejects(verifyPreparedArtifact(result.artifactPath, destination), /music/i);
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

test("manual QA CLI explains preparation and never runs with missing arguments", async () => {
  const run = promisify(execFile);
  const script = join(process.cwd(), "scripts/manual-import-qa.ts");
  const help = await run(process.execPath, ["--import", "tsx", script, "--help"]);
  assert.match(help.stdout, /prepare/);
  assert.match(help.stdout, /inspect/);
  assert.match(help.stdout, /UNVERIFIED/);
  await assert.rejects(run(process.execPath, ["--import", "tsx", script, "prepare"]), { code: 2 });
});

test("output inspection rejects a one-frame clip-boundary error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-frame-boundary-"));
  const run = promisify(execFile);
  try {
    const video = join(directory, "shifted.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-n",
      "-f", "lavfi", "-i", "color=red:s=320x180:r=30:d=1",
      "-f", "lavfi", "-i", "color=lime:s=320x180:r=30:d=2",
      "-f", "lavfi", "-i", "color=blue:s=320x180:r=30:d=1",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=3",
      "-filter_complex", "[0:v]trim=end_frame=29,setpts=PTS-STARTPTS[a];[1:v]trim=end_frame=31,setpts=PTS-STARTPTS[b];[a][b][2:v]concat=n=3:v=1:a=0[v]",
      "-map", "[v]", "-map", "3:a", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "3", video]);
    assert.equal(evaluateExportMeasurements(await measureExport(video)).status, "FAIL");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

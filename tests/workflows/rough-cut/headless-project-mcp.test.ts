import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chmod, link, mkdir, open, readFile, readdir, mkdtemp, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FcpxmlDocumentAdapter } from "@framekit/final-cut";
import { compileTimelineIrToFcpxml } from "../../../adapters/final-cut/typescript/src/timeline-ir-fcpxml.js";
import { HeadlessProjectService, externalEditOperations } from "@framekit/headless-application";
import { createTimelineIrFromProjectSnapshot, FramekitProjectStore, timelineIrDigest, type FramekitProjectDocument, type TimelineIr } from "@framekit/runtime";
import { FfmpegMediaMetadataProbe, FfmpegRenderVerifier, FfmpegTimelineRenderer, FfmpegStoryboardRenderer } from "../../../adapters/headless/typescript/src/index.js";

const execFileAsync = promisify(execFile);

test("production MCP preserves approval for an unsampled dissolve", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-788-dissolve-mcp-"));
  const here = dirname(fileURLToPath(import.meta.url));
  const environment: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    FRAMEKIT_EDITOR: "final-cut-live", FRAMEKIT_AUTO_CONNECT: "0", FRAMEKIT_FINAL_CUT_HEADLESS: "1",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0", FRAMEKIT_FINAL_CUT_SOCKET: join(directory, "missing.sock"),
    FRAMEKIT_STATE_DIR: join(directory, "state"),
  };
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    await execFileAsync(process.execPath, ["scripts/generate-headless-render-fixtures.mjs", directory], { cwd: process.cwd(), env: process.env });
    for (const name of ["fixture-red-440hz.mp4", "fixture-blue-880hz.mp4"]) {
      const original = join(directory, name);
      const tagged = join(directory, `tagged-${name}`);
      await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-i", original, "-vf", "scale=in_color_matrix=bt601:out_color_matrix=bt709,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-c:a", "copy", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-movflags", "+write_colr", tagged]);
      await rename(tagged, original);
    }
    ({ client, transport } = await connectProductionClient(here, environment));
    const created = payload(await client.callTool({ name: "headless.project.create", arguments: { timeline: emptyTimeline() } }));
    const projectId = created.timeline.project.id;
    const sequenceId = created.timeline.sequence.id;
    let revision = created.timeline.revision;
    const sources: any[] = [];
    for (const name of ["fixture-red-440hz.mp4", "fixture-blue-880hz.mp4"]) {
      const registered = payload(await client.callTool({ name: "headless.media.register", arguments: { projectId, sourcePath: join(directory, name), expectedRevision: revision } }));
      sources.push(registered.resource);
      revision = registered.project.timeline.revision;
    }
    const shot = (order: number, source: any, start: number) => ({ order, sourceIdentity: { mediaId: source.id, source: source.source, sourceDigest: source.sourceDigest, mediaKind: "video", duration: 2 }, range: { start, end: start + 1 }, confidence: 1, matchedProperties: ["selected"], rationale: "approved source range" });
    const request = {
      projectId, sequenceId,
      plan: { planner: { id: "framekit.rough-cut", version: 1 }, revision, query: { query: "dissolve" }, shots: [shot(1, sources[0], 0.2), shot(2, sources[1], 0.5)], warnings: [] },
      operations: [{ type: "add-transition", transition: { id: "fade", kind: "cross-dissolve", beforeOccurrenceId: "rough-cut-1", afterOccurrenceId: "rough-cut-2", durationTime: { value: "1", timescale: "5" } } }],
      render: { outputPath: join(directory, "render.mp4"), format: "mp4", width: 320, height: 180, frameRate: { value: "30", timescale: "1" } },
      fcpxml: { path: join(directory, "edit.fcpxml"), target: { provider: "final-cut", libraryUid: "test-library", eventUid: "test-event", projectUid: "test-project", sequenceUid: "test-sequence" } },
    };
    const result = await client.callTool({ name: "headless.rough-cut.preview", arguments: request });
    assert.notEqual(result.isError, true, toolErrorText(result));
    const preview = payload(result);
    assert.match(preview.planDigest, /^[a-f0-9]{64}$/);
    assert.match(preview.storyboardUnavailable, /HEADLESS_STORYBOARD_UNSUPPORTED/);
    assert.equal(preview.storyboard, undefined);
    assert.equal((result.content as Array<{ type: string }>).some((item) => item.type === "image"), false);
    const before = payload(await client.callTool({ name: "headless.project.inspect", arguments: { projectId } }));
    assert.deepEqual(before.timeline.revision, revision);
    assert.equal(before.timeline.sequence.occurrences.length, 0);
    const changed = { ...request, operations: [{ ...request.operations[0]!, transition: { ...request.operations[0]!.transition, durationTime: { value: "1", timescale: "10" } } }] };
    const rejected = await client.callTool({ name: "headless.rough-cut.execute", arguments: { ...changed, approved: true, planDigest: preview.planDigest } });
    assert.equal(rejected.isError, true);
    assert.match(toolErrorText(rejected), /PLAN_MISMATCH/);
    const executed = payload(await client.callTool({ name: "headless.rough-cut.execute", arguments: { ...request, approved: true, planDigest: preview.planDigest } }));
    assert.equal(executed.committed, true);
    assert.equal(executed.render.status, "passed");
    assert.equal(executed.fcpxmlArtifact.verified, true);
    assert.deepEqual(executed.after.timeline.revision, preview.after.timeline.revision);
    assert.match(await readFile(request.fcpxml.path, "utf8"), /<transition name="Cross Dissolve"/);
  } finally {
    await client?.close();
    await transport?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rough-cut dissolve preview binds render and FCPXML output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-dissolve-rough-cut-"));
  try {
    await execFileAsync(process.execPath, ["scripts/generate-headless-render-fixtures.mjs", directory], { cwd: process.cwd(), env: process.env });
    for (const name of ["fixture-red-440hz.mp4", "fixture-blue-880hz.mp4"]) {
      const original = join(directory, name);
      const tagged = join(directory, `tagged-${name}`);
      await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-i", original, "-vf", "scale=in_color_matrix=bt601:out_color_matrix=bt709,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-c:a", "copy", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-movflags", "+write_colr", tagged]);
      await rename(tagged, original);
    }
    const musicPath = join(directory, "music.wav");
    await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=1760:sample_rate=48000:duration=2", "-c:a", "pcm_s16le", musicPath]);
    const service = new HeadlessProjectService({ directory: join(directory, "projects"), mediaProbe: new FfmpegMediaMetadataProbe(), renderer: new FfmpegTimelineRenderer(), verifier: new FfmpegRenderVerifier(), storyboard: new FfmpegStoryboardRenderer() });
    const created = await service.create(emptyTimeline());
    let revision = created.timeline.revision;
    const resources: TimelineIr["resources"] = [];
    for (const path of [join(directory, "fixture-red-440hz.mp4"), join(directory, "fixture-blue-880hz.mp4"), musicPath]) {
      const registered = await service.registerMedia(created.timeline.project.id, path, revision);
      resources.push(registered.resource);
      revision = registered.project.timeline.revision;
    }
    const shot = (order: number, source: typeof resources[number], start: number) => ({ order, sourceIdentity: { mediaId: source.id, source: source.source!, sourceDigest: source.sourceDigest!, mediaKind: "video" as const, duration: 2 }, range: { start, end: start + 1 }, confidence: 1, matchedProperties: ["selected"], rationale: "approved source range" });
    const request = {
      projectId: created.timeline.project.id, sequenceId: created.timeline.sequence.id,
      plan: { planner: { id: "framekit.rough-cut", version: 1 }, revision, query: { query: "dissolve" }, shots: [shot(1, resources[0]!, 0.2), shot(2, resources[1]!, 0.5)], warnings: [] },
      operations: [
        { type: "add-transition" as const, transition: { id: "fade", kind: "cross-dissolve" as const, beforeOccurrenceId: "rough-cut-1", afterOccurrenceId: "rough-cut-2", durationTime: { value: "1", timescale: "5" } } },
        { type: "add-title" as const, title: { id: "title", text: "FADE", startTime: { value: "4", timescale: "5" }, durationTime: { value: "1", timescale: "6" }, lane: 1 } },
        { type: "insert-occurrence" as const, occurrence: { id: "music", name: "Music", startTime: { value: "0", timescale: "1" }, durationTime: { value: "2", timescale: "1" }, sourceStartTime: { value: "0", timescale: "1" }, track: 1, role: "music" as const, mediaId: resources[2]!.id, gainDb: -12 } },
      ],
      render: { outputPath: join(directory, "render.mp4"), format: "mp4" as const, width: 320, height: 180, frameRate: { value: "30", timescale: "1" } },
      fcpxml: { path: join(directory, "edit.fcpxml"), target: { provider: "final-cut" as const, libraryUid: "test-library", eventUid: "test-event", projectUid: "test-project", sequenceUid: "test-sequence" } },
    };
    const freshProbe = new FfmpegMediaMetadataProbe();
    const mismatchedProbe = { probe: async (path: string) => {
      const observed = await freshProbe.probe(path);
      const video = observed.streams.find((stream) => stream.kind === "video");
      if (video?.color) video.color.transfer = "smpte2084";
      return observed;
    } };
    const mismatched = new HeadlessProjectService({ directory: join(directory, "projects"), mediaProbe: mismatchedProbe });
    await assert.rejects(mismatched.previewRoughCut(request), /MEDIA_METADATA_CHANGED/);
    const missingFont = new HeadlessProjectService({
      directory: join(directory, "projects"),
      mediaProbe: new FfmpegMediaMetadataProbe(),
      renderer: new FfmpegTimelineRenderer({ env: { FRAMEKIT_RENDER_FONT: join(directory, "missing.otf") } }),
      verifier: new FfmpegRenderVerifier(),
    });
    await assert.rejects(missingFont.previewRoughCut(request), /RENDER_CAPABILITY_UNAVAILABLE.*titles/);
    const noRenderer = new HeadlessProjectService({ directory: join(directory, "projects"), mediaProbe: new FfmpegMediaMetadataProbe() });
    await assert.rejects(noRenderer.previewRoughCut(request), /RENDER_UNAVAILABLE.*title/);
    const fontPath = join(directory, "selected.otf");
    await writeFile(fontPath, Buffer.from(await readFile("tests/fixtures/fonts/noto-sans-jp-test.otf.base64", "utf8"), "base64"));
    const fontService = new HeadlessProjectService({ directory: join(directory, "projects"), mediaProbe: new FfmpegMediaMetadataProbe(), renderer: new FfmpegTimelineRenderer({ env: { FRAMEKIT_RENDER_FONT: fontPath } }), verifier: new FfmpegRenderVerifier() });
    const titleRequest = { ...request, operations: request.operations.map((operation) => operation.type === "add-title" ? { ...operation, title: { ...operation.title, text: "A日" } } : operation) };
    const unsupportedTitle = { ...titleRequest, operations: titleRequest.operations.map((operation) => operation.type === "add-title" ? { ...operation, title: { ...operation.title, text: "A\u{10ffff}" } } : operation) };
    await assert.rejects(fontService.previewRoughCut(unsupportedTitle), /RENDER_CAPABILITY_UNAVAILABLE.*titles/);
    const concreteRenderer = new FfmpegTimelineRenderer({ env: { FRAMEKIT_RENDER_FONT: fontPath } });
    const noDestinationCheck = new HeadlessProjectService({ directory: join(directory, "projects"), mediaProbe: new FfmpegMediaMetadataProbe(), renderer: { id: concreteRenderer.id, version: concreteRenderer.version, capabilities: (input) => concreteRenderer.capabilities(input), render: (plan) => concreteRenderer.render(plan) } });
    await assert.rejects(noDestinationCheck.previewRoughCut(titleRequest), /RENDER_UNAVAILABLE.*output safety/);
    const noFace = new HeadlessProjectService({ directory: join(directory, "projects"), mediaProbe: new FfmpegMediaMetadataProbe(), renderer: { id: concreteRenderer.id, version: concreteRenderer.version, capabilities: (input) => ({ ...concreteRenderer.capabilities(input), titleFontFace: undefined }), validateTitleOutput: (input, paths) => concreteRenderer.validateTitleOutput(input, paths), render: (plan) => concreteRenderer.render(plan) } });
    await assert.rejects(noFace.previewRoughCut(titleRequest), /RENDER_CAPABILITY_UNAVAILABLE.*titles/);
    const originalFontBeforePreview = await readFile(fontPath);
    const fontCollision = { ...titleRequest, render: { ...titleRequest.render, outputPath: fontPath, overwrite: true } };
    await assert.rejects(fontService.previewRoughCut(fontCollision), /OUTPUT_INVALID.*font/i);
    const xmlFontCollision = { ...titleRequest, fcpxml: { ...titleRequest.fcpxml, path: fontPath, overwrite: true } };
    await assert.rejects(fontService.previewRoughCut(xmlFontCollision), /OUTPUT_INVALID.*font/i);
    assert.deepEqual(await readFile(fontPath), originalFontBeforePreview);
    for (const titleFontDigest of [undefined, "f".repeat(64)]) {
      const mismatchedStoryboard = new HeadlessProjectService({ directory: join(directory, "projects"), mediaProbe: new FfmpegMediaMetadataProbe(), renderer: new FfmpegTimelineRenderer({ env: { FRAMEKIT_RENDER_FONT: fontPath } }), storyboard: { render: async () => ({ data: "fake", mimeType: "image/png", samples: [], limitations: [], titleFontDigest }) } });
      const result = await mismatchedStoryboard.previewRoughCut(titleRequest, undefined, true);
      assert.equal(result.storyboard, undefined);
      assert.match(result.storyboardUnavailable!, /STORYBOARD_UNSUPPORTED.*font/i);
    }
    const swappableXml = { ...titleRequest, fcpxml: { ...titleRequest.fcpxml, overwrite: true } };
    const beforeSwap = await fontService.previewRoughCut(swappableXml);
    await link(fontPath, swappableXml.fcpxml.path);
    await assert.rejects(fontService.executeRoughCut({ ...swappableXml, approved: true, planDigest: beforeSwap.planDigest }), /OUTPUT_INVALID.*font/i);
    assert.deepEqual(await readFile(fontPath), originalFontBeforePreview);
    assert.equal(existsSync(request.render.outputPath), false);
    await unlink(swappableXml.fcpxml.path);
    const approvedTitle = await fontService.previewRoughCut(titleRequest);
    const originalFont = await readFile(fontPath);
    assert.equal(approvedTitle.titleFont?.digest, createHash("sha256").update(originalFont).digest("hex"));
    assert.deepEqual(approvedTitle.titleFont?.face, { family: "Noto Sans CJK JP", style: "Regular", postscriptName: "NotoSansCJKjp-Regular" });
    // Pre-upgrade approvals may have no font identity or only the old digest.
    const approvalRecord = await readFile(join(directory, "projects", `${approvedTitle.planDigest}.approval.json`), "utf8");
    const stable = (value: any): string => value === null || typeof value !== "object" ? JSON.stringify(value)
      : Array.isArray(value) ? `[${value.map(stable).join(",")}]`
      : `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
    for (const legacyKind of ["font", "face"] as const) {
      const legacy = JSON.parse(approvalRecord);
      if (legacyKind === "font") delete legacy.titleFont;
      else delete legacy.titleFont.face;
      delete legacy.planDigest;
      delete legacy.evidenceDigest;
      legacy.planDigest = createHash("sha256").update(stable(legacy)).digest("hex");
      legacy.evidenceDigest = createHash("sha256").update(stable(legacy)).digest("hex");
      await writeFile(join(directory, "projects", `${legacy.planDigest}.approval.json`), JSON.stringify(legacy));
      await assert.rejects(fontService.executeRoughCut({ ...titleRequest, approved: true, planDigest: legacy.planDigest }), /PLAN_MISMATCH.*font/i);
    }
    await writeFile(fontPath, Buffer.concat([originalFont, Buffer.from([0])]));
    await assert.rejects(fontService.executeRoughCut({ ...titleRequest, approved: true, planDigest: approvedTitle.planDigest }), /PLAN_MISMATCH.*font/i);
    assert.equal(existsSync(request.render.outputPath), false);
    assert.equal(existsSync(request.fcpxml.path), false);
    await rm(fontPath);
    await assert.rejects(fontService.executeRoughCut({ ...titleRequest, approved: true, planDigest: approvedTitle.planDigest }), /PLAN_MISMATCH.*font/i);
    assert.equal(existsSync(request.render.outputPath), false);
    assert.deepEqual((await service.open(created.timeline.project.id)).timeline.revision, revision);
    const directTimeline = structuredClone((await service.open(created.timeline.project.id)).timeline);
    directTimeline.project.id = "direct-dissolve-check";
    directTimeline.sequence.durationTime = { value: "2", timescale: "1" };
    directTimeline.sequence.occurrences = [
      { id: "a", name: "A", mediaId: resources[0]!.id, role: "video", track: 0, startTime: { value: "0", timescale: "1" }, durationTime: { value: "1", timescale: "1" }, sourceStartTime: { value: "1", timescale: "5" } },
      { id: "b", name: "B", mediaId: resources[1]!.id, role: "video", track: 0, startTime: { value: "1", timescale: "1" }, durationTime: { value: "1", timescale: "1" }, sourceStartTime: { value: "1", timescale: "2" } },
    ];
    directTimeline.sequence.transitions = [{ id: "fade", kind: "cross-dissolve", beforeOccurrenceId: "a", afterOccurrenceId: "b", durationTime: { value: "1", timescale: "5" } }];
    const direct = await service.create(directTimeline);
    await assert.rejects(mismatched.exportFcpxml(direct.timeline.project.id, direct.timeline.sequence.id, direct.timeline.revision, join(directory, "direct.fcpxml"), request.fcpxml.target), /MEDIA_METADATA_CHANGED/);
    const preview = await service.previewRoughCut(request, undefined, true);
    assert.match(preview.storyboardUnavailable!, /HEADLESS_STORYBOARD_UNSUPPORTED/);
    assert.match(preview.planDigest, /^[a-f0-9]{64}$/);
    assert.equal(preview.after.timeline.sequence.transitions?.[0]?.id, "fade");
    assert.ok(preview.fcpxml.coverage.degraded.includes("native-title-font-availability-unverified"));
    const changed = { ...request, operations: [{ ...request.operations[0]!, transition: { ...request.operations[0]!.transition!, durationTime: { value: "1", timescale: "10" } } }, ...request.operations.slice(1)] };
    await assert.rejects(service.executeRoughCut({ ...changed, approved: true, planDigest: preview.planDigest }), /PLAN_MISMATCH/);
    const executed = await service.executeRoughCut({ ...request, approved: true, planDigest: preview.planDigest });
    assert.equal(executed.committed, true);
    assert.equal(executed.render.status, "passed");
    assert.equal(executed.fcpxmlArtifact.verified, true);
    assert.deepEqual(executed.after.timeline.revision, preview.after.timeline.revision);
    const proof = await service.verifyPublishableRoughCut(executed.executionId, request.fcpxml.path);
    assert.deepEqual(proof.titleFont, preview.titleFont);
    const renderRecordPath = join(directory, "projects", `${executed.render.renderId}.json`);
    const originalRenderRecord = await readFile(renderRecordPath, "utf8");
    for (const mutation of ["font", "face", "renderer", "missing", "title", "revision", "render-revision", "target", "output", "verification", "verified-artifact", "failed-check", "empty-checks"] as const) {
      const record = JSON.parse(originalRenderRecord);
      if (mutation === "font") record.outcome.plan.capabilities.titleFontDigest = "f".repeat(64);
      if (mutation === "face") record.outcome.plan.capabilities.titleFontFace.family = "Different family";
      if (mutation === "renderer") {
        record.outcome.plan.renderer.version = "different";
        record.outcome.plan.capabilities.renderer.version = "different";
        record.outcome.render.renderer.version = "different";
      }
      if (mutation === "missing") delete record.outcome.plan.capabilities.titleFontDigest;
      if (mutation === "title") record.outcome.plan.timeline.sequence.titles[0].text = "Different title";
      if (mutation === "revision") record.outcome.plan.projectRevision.id = "different-revision";
      if (mutation === "render-revision") record.outcome.render.projectRevision.id = "different-revision";
      if (mutation === "target") record.outcome.plan.target.sequenceId = "different-sequence";
      if (mutation === "output") {
        record.outcome.plan.parameters.outputPath = join(directory, "other.mp4");
        record.outcome.render.output.path = record.outcome.plan.parameters.outputPath;
      }
      if (mutation === "verification") delete record.outcome.verification;
      if (mutation === "verified-artifact") record.outcome.verification.artifact.fileDigest = "f".repeat(64);
      if (mutation === "failed-check") record.outcome.verification.checks[0].passed = false;
      if (mutation === "empty-checks") record.outcome.verification.checks = [];
      const { planDigest: _oldPlanDigest, ...changedPlan } = record.outcome.plan;
      record.outcome.plan.planDigest = createHash("sha256").update(stable(changedPlan)).digest("hex");
      record.outcome.render.planDigest = record.outcome.plan.planDigest;
      await writeFile(renderRecordPath, JSON.stringify(record));
      await assert.rejects(service.verifyPublishableRoughCut(executed.executionId, request.fcpxml.path), /RENDER_EVIDENCE_MISMATCH.*font/i);
    }
    await writeFile(renderRecordPath, originalRenderRecord);
    assert.deepEqual(await service.verifyPublishableRoughCut(executed.executionId, request.fcpxml.path), proof);
    const xml = await readFile(request.fcpxml.path, "utf8");
    assert.match(xml, /name="Rough cut 1: approved source range" offset="0s" start="1\/5s" duration="9\/10s"/);
    assert.match(xml, /<transition name="Cross Dissolve" offset="4\/5s" duration="1\/5s"/);
    assert.match(xml, /name="Rough cut 2: approved source range" offset="9\/10s" start="2\/5s" duration="11\/10s"/);
    assert.match(xml, /<filter-video ref="effect-cross-dissolve"/);
    assert.match(xml, /<filter-audio ref="effect-audio-crossfade"/);
    assert.match(xml, /name="Music"/);
    assert.match(xml, /<text><text-style ref="title-style-1">FADE<\/text-style><\/text>/);
    assert.ok(xml.includes(`font="${preview.titleFont!.face.family}" fontFace="${preview.titleFont!.face.style}"`));
    assert.ok(xml.includes(`key="com.framekit.title-font-sha256" value="${preview.titleFont!.digest}"`));
    const readback = await new FcpxmlDocumentAdapter(request.fcpxml.path).readProject();
    const recovered = createTimelineIrFromProjectSnapshot(readback);
    assert.deepEqual(recovered.sequence.transitions, preview.after.timeline.sequence.transitions);
    const expected = preview.after.timeline.sequence.occurrences.find((item) => item.id === "rough-cut-2")!;
    const actual = recovered.sequence.occurrences.find((item) => item.id === "rough-cut-2")!;
    assert.deepEqual(actual.startTime, expected.startTime);
    assert.deepEqual(actual.durationTime, expected.durationTime);
    assert.deepEqual(actual.sourceStartTime, expected.sourceStartTime);
    assert.equal(readback.media.find((item) => item.mediaId === actual.mediaId)?.source, resources[1]!.source);
    // Revise the approved finishing edit without changing its dissolve or source bindings.
    const v1Revision = executed.after.timeline.revision;
    const v1XmlDigest = createHash("sha256").update(xml).digest("hex");
    const v1VideoDigest = createHash("sha256").update(await readFile(request.render.outputPath)).digest("hex");
    const command = { schemaVersion: 1 as const, expectedRevision: v1Revision, operations: [
      { type: "remove-title" as const, titleId: "title" },
      { type: "add-title" as const, title: { id: "title-v2", text: "FADE 2", startTime: { value: "4", timescale: "5" }, durationTime: { value: "1", timescale: "6" }, lane: 1, font: { ...preview.titleFont!.face, digest: preview.titleFont!.digest } } },
      { type: "set-gain" as const, occurrenceId: "music", gainDb: -9 },
    ] };
    const v2Preview = await service.previewEdit(request.projectId, command, request.sequenceId);
    assert.deepEqual((await service.open(request.projectId)).timeline.revision, v1Revision);
    assert.equal(v2Preview.after.timeline.sequence.titles?.[0]?.text, "FADE 2");
    assert.equal(v2Preview.after.timeline.sequence.occurrences.find((item) => item.id === "music")?.gainDb, -9);
    const revised = await service.executeEdit(request.projectId, command, request.sequenceId);
    const v2Revision = revised.after.timeline.revision;
    assert.notEqual(v2Revision.id, v1Revision.id);
    assert.deepEqual(revised.after.timeline.sequence.transitions, preview.after.timeline.sequence.transitions);
    assert.deepEqual(revised.after.timeline.sequence.occurrences.filter((item) => item.role === "video"), preview.after.timeline.sequence.occurrences.filter((item) => item.role === "video"));
    const v2XmlPath = join(directory, "edit-v2.fcpxml");
    await assert.rejects(service.exportFcpxml(request.projectId, request.sequenceId, v1Revision, v2XmlPath, request.fcpxml.target), /STALE/);
    const v2Xml = await service.exportFcpxml(request.projectId, request.sequenceId, v2Revision, v2XmlPath, request.fcpxml.target);
    const v2VideoPath = join(directory, "render-v2.mp4");
    await assert.rejects(service.render(request.projectId, request.sequenceId, { ...request.render, outputPath: v2VideoPath }, v1Revision), /STALE/);
    const v2Render = await service.render(request.projectId, request.sequenceId, { ...request.render, outputPath: v2VideoPath }, v2Revision);
    assert.equal(v2Render.status, "passed");
    assert.deepEqual(v2Render.requestedRevision, v2Revision);
    assert.deepEqual(v2Xml.provenance.revision, v2Revision);
    assert.notEqual(v2Xml.provenance.destination.projectUid, executed.fcpxml.provenance.destination.projectUid);
    const revisedXml = await readFile(v2XmlPath, "utf8");
    assert.match(revisedXml, /<text><text-style ref="title-style-1">FADE 2<\/text-style><\/text>/);
    assert.match(revisedXml, /<adjust-volume amount="-9dB"/);
    assert.match(revisedXml, /<transition name="Cross Dissolve" offset="4\/5s" duration="1\/5s"/);
    const v2Readback = await new FcpxmlDocumentAdapter(v2XmlPath).readProject();
    const v2Timeline = createTimelineIrFromProjectSnapshot(v2Readback);
    assert.deepEqual(v2Timeline.sequence.transitions, revised.after.timeline.sequence.transitions);
    for (const expectedClip of revised.after.timeline.sequence.occurrences.filter((item) => item.role === "video")) {
      const observedClip = v2Timeline.sequence.occurrences.find((item) => item.id === expectedClip.id)!;
      assert.ok(observedClip);
      assert.deepEqual([observedClip.sourceStartTime, observedClip.startTime, observedClip.durationTime], [expectedClip.sourceStartTime, expectedClip.startTime, expectedClip.durationTime]);
      assert.equal(v2Readback.media.find((item) => item.mediaId === observedClip.mediaId)?.source, resources.find((item) => item.id === expectedClip.mediaId)?.source);
    }
    const oldMusic = toneAmplitude(await readAudioWindow(request.render.outputPath, 0.2), 1760);
    const newMusic = toneAmplitude(await readAudioWindow(v2VideoPath, 0.2), 1760);
    assert.ok(oldMusic > 0.002 && Math.abs(20 * Math.log10(newMusic / oldMusic) - 3) < 0.5, "the revised render must contain the approved 3 dB music increase");
    const centerBrightPixels = (frame: Buffer) => {
      let count = 0;
      for (let y = 50; y < 100; y++) for (let x = 110; x < 210; x++) {
        const offset = (y * 320 + x) * 3;
        if (frame[offset]! > 200 && frame[offset + 1]! > 200 && frame[offset + 2]! > 200) count++;
      }
      return count;
    };
    const beforeTitle = centerBrightPixels(await readVideoFrame(v2VideoPath, 0.7));
    const duringTitle = centerBrightPixels(await readVideoFrame(v2VideoPath, 0.85));
    assert.ok(duringTitle > beforeTitle + 20, "the revised title window must add bright pixels in the title region");
    assert.equal(createHash("sha256").update(await readFile(request.fcpxml.path)).digest("hex"), v1XmlDigest);
    assert.equal(createHash("sha256").update(await readFile(request.render.outputPath)).digest("hex"), v1VideoDigest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact-first production MCP edits, restores, exports and renders fractional-frame media", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-artifact-first-e2e-"));
  const here = dirname(fileURLToPath(import.meta.url));
  const environment: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    FRAMEKIT_EDITOR: "final-cut-live", FRAMEKIT_AUTO_CONNECT: "0", FRAMEKIT_FINAL_CUT_HEADLESS: "1",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0", FRAMEKIT_FINAL_CUT_SOCKET: join(directory, "missing-final-cut.sock"),
    FRAMEKIT_STATE_DIR: join(directory, "state"),
  };
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    const nativeCalls = join(directory, "native-calls.log");
    const sentinelBin = join(directory, "sentinel-bin");
    await mkdir(sentinelBin);
    for (const command of ["osascript", "swift", "open", "pluginkit"]) {
      const script = join(sentinelBin, command);
      await writeFile(script, `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(nativeCalls)}, ${JSON.stringify(`${command}\n`)}); process.exit(77);\n`);
      await chmod(script, 0o755);
    }
    environment.PATH = `${sentinelBin}:${process.env.PATH ?? ""}`;
    const paths = [join(directory, "a", "same.mp4"), join(directory, "b", "same.mp4")];
    await mkdir(dirname(paths[0]!), { recursive: true });
    await mkdir(dirname(paths[1]!), { recursive: true });
    await generateSegmentedSource(paths[0]!, [
      { color: "red", duration: 1 },
      { color: "lime", duration: 1 },
      { color: "yellow", duration: 2 },
    ], 440);
    await generateSegmentedSource(paths[1]!, [{ color: "blue", duration: 4 }], 660);
    const sha = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
    const sourceDigests = await Promise.all(paths.map(sha));
    const reservationPath = join(directory, "state", "canonical-recovery", "pending.json");
    const reservation = JSON.stringify({ version: 2, kind: "native-operation", owner: "00000000-0000-4000-8000-000000000001", operation: "native.searchmedia" }) + "\n";
    await mkdir(dirname(reservationPath), { recursive: true });
    await writeFile(reservationPath, reservation);
    ({ client, transport } = await connectProductionClient(here, environment));
    const callTool = async (request: { name: string; arguments?: Record<string, unknown> }) => {
      try {
        return await client!.callTool(request);
      } catch (cause) {
        throw new Error(`artifact MCP ${request.name} failed`, { cause });
      }
    };
    const route = payload(await callTool({ name: "editing.route", arguments: { operation: "timeline.edit", path: "headless", editType: "split-occurrence" } }));
    assert.equal(route.status, "headless-selected");
    const timeline = emptyTimeline();
    timeline.sequence.frameDuration = { value: "1001", timescale: "24000" };
    const created = payload(await callTool({ name: "headless.project.create", arguments: { timeline } }));
    const projectId = created.timeline.project.id;
    const sequenceId = created.timeline.sequence.id;
    const a = payload(await callTool({ name: "headless.media.register", arguments: { projectId, sourcePath: paths[0], expectedRevision: created.timeline.revision } }));
    const b = payload(await callTool({ name: "headless.media.register", arguments: { projectId, sourcePath: paths[1], expectedRevision: a.project.timeline.revision } }));
    const search = payload(await callTool({ name: "headless.media.search", arguments: { projectId, query: "same.mp4" } }));
    assert.deepEqual(search.media.map((item: any) => item.id).sort(), [a.resource.id, b.resource.id].sort());
    const frame = (count: number) => ({ value: String(count * 1001), timescale: "24000" });
    const shot = (id: string, mediaId: string, sourceFrame: number) => ({ ...occurrence(id, mediaId), durationTime: frame(24), sourceStartTime: frame(sourceFrame) });
    const placements = [shot("a", a.resource.id, 12), shot("b", b.resource.id, 0), shot("repeat-a", a.resource.id, 36)];
    const placed = payload(await callTool({ name: "headless.edit.execute", arguments: {
      projectId, sequenceId, expectedRevision: b.project.timeline.revision,
      operations: placements.map((item) => ({ type: "insert-occurrence", placement: "append", occurrence: item })),
    } }));
    // Publish the first immutable version before restarting the production server.
    const v1Path = join(directory, "version-1.fcpxml");
    const v1Target = { provider: "final-cut", libraryUid: "library", eventUid: "event", projectUid: "project-v1", sequenceUid: "sequence-v1", materialization: "versioned" };
    const v1 = payload(await callTool({ name: "headless.fcpxml.export", arguments: {
      projectId, sequenceId, expectedRevision: placed.after.timeline.revision, outputPath: v1Path, target: v1Target,
    } }));
    assert.equal(v1.artifact.verified, true);
    const v1Digest = await sha(v1Path);
    await client!.close();
    await transport!.close();
    ({ client, transport } = await connectProductionClient(here, environment));
    const afterRestart = payload(await callTool({ name: "headless.project.inspect", arguments: { projectId } }));
    assert.deepEqual(afterRestart.timeline, placed.after.timeline);
    const splitOperation = [{ type: "split-occurrence", occurrenceId: "a", splitOffsetTime: frame(12), newOccurrenceId: "a-right" }];
    const preview = payload(await callTool({ name: "headless.edit.preview", arguments: {
      projectId, sequenceId, expectedRevision: placed.after.timeline.revision, operations: splitOperation,
    } }));
    assert.equal(preview.after.timeline.sequence.occurrences.length, 4);
    assert.deepEqual(payload(await callTool({ name: "headless.project.inspect", arguments: { projectId } })).timeline, afterRestart.timeline);
    const split = payload(await callTool({ name: "headless.edit.execute", arguments: {
      projectId, sequenceId, expectedRevision: placed.after.timeline.revision,
      operations: [{ type: "split-occurrence", occurrenceId: "a", splitOffsetTime: frame(12), newOccurrenceId: "a-right" }],
    } }));
    const reorderOps = [
      { type: "move-occurrence", occurrenceId: "repeat-a", startTime: frame(24) },
      { type: "move-occurrence", occurrenceId: "b", startTime: frame(48) },
    ];
    const stale = await callTool({ name: "headless.edit.execute", arguments: { projectId, sequenceId, expectedRevision: placed.after.timeline.revision, operations: reorderOps } });
    assert.match(toolErrorText(stale), /STALE/);
    const moved = payload(await callTool({ name: "headless.edit.execute", arguments: { projectId, sequenceId, expectedRevision: split.after.timeline.revision, operations: reorderOps } }));
    const undone = payload(await callTool({ name: "headless.edit.undo", arguments: { projectId, sequenceId, undoId: moved.undoId, expectedRevision: moved.after.timeline.revision } }));
    assert.equal(undone.verification.verified, true);
    assert.deepEqual(undone.project.timeline.sequence, split.after.timeline.sequence);
    const redone = payload(await callTool({ name: "headless.edit.execute", arguments: { projectId, sequenceId, expectedRevision: undone.project.timeline.revision, operations: reorderOps } }));
    const revision = redone.after.timeline.revision;
    const outputPath = join(directory, "final.mp4");
    const xmlPath = join(directory, "final.fcpxml");
    const target = { provider: "final-cut", libraryUid: "library", eventUid: "event", projectUid: "project", sequenceUid: "sequence", materialization: "versioned" };
    const exported = payload(await callTool({ name: "headless.fcpxml.export", arguments: { projectId, sequenceId, expectedRevision: revision, outputPath: xmlPath, target } }));
    assert.equal(exported.artifact.verified, true);
    assert.notEqual(exported.provenance.revision.id, v1.provenance.revision.id);
    assert.equal(await sha(v1Path), v1Digest);
    const overwrite = await callTool({ name: "headless.fcpxml.export", arguments: { projectId, sequenceId, expectedRevision: revision, outputPath: v1Path, target: v1Target } });
    assert.equal(overwrite.isError, true);
    assert.equal(await sha(v1Path), v1Digest);
    const render = payload(await callTool({ name: "headless.render", arguments: { projectId, sequenceId, expectedRevision: revision, parameters: { outputPath, format: "mp4", width: 320, height: 180, frameRate: { value: "24000", timescale: "1001" } } } }));
    assert.equal(render.status, "passed");
    const parsed = await new FcpxmlDocumentAdapter(xmlPath).readProject();
    const sourceFor = (id: string | undefined) => parsed.media.find((item) => item.mediaId === id)?.source;
    assert.deepEqual(parsed.timeline.clips.map((clip) => sourceFor(clip.mediaId)), [paths[0], paths[0], paths[0], paths[1]]);
    assert.ok(Math.abs((parsed.timeline.clips[0]!.sourceStart ?? NaN) - 0.5005) < 0.001);
    assert.ok(Math.abs((parsed.timeline.clips[1]!.sourceStart ?? NaN) - 1.001) < 0.001);
    assert.ok(Math.abs((parsed.timeline.clips[2]!.sourceStart ?? NaN) - 1.5015) < 0.001);
    assert.ok(Math.abs(parsed.timeline.clips[3]!.start - 2.002) < 0.001);
    const pixel = (buffer: Buffer) => [buffer[0]!, buffer[1]!, buffer[2]!];
    // These samples are independently stated from the requested source ranges:
    // a's first half is red, its split right half is green, and repeat-a crosses
    // from green into yellow before the blue source begins at timeline 2.002s.
    for (const [time, expected] of [[0.25, "red"], [0.75, "green"], [1.25, "green"], [1.75, "yellow"], [2.5, "blue"]] as const) {
      const observed = pixel(await readVideoFrame(outputPath, time));
      const [r, g, b] = observed;
      const matches = expected === "red" ? r! > g! + 100 && r! > b! + 100
        : expected === "green" ? g! > r! + 100 && g! > b! + 100
        : expected === "yellow" ? r! > b! + 100 && g! > b! + 100
        : b! > r! + 100 && b! > g! + 100;
      assert.ok(matches, `expected ${expected} at ${time}s, observed ${observed}`);
    }
    const probe = JSON.parse((await execFileAsync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "format=duration:stream=codec_type,r_frame_rate,nb_read_frames,duration", "-of", "json", outputPath])).stdout);
    assert.ok(Math.abs(Number(probe.format.duration) - 3.003) < 0.1);
    const video = probe.streams.find((stream: any) => stream.codec_type === "video");
    assert.equal(video.r_frame_rate, "24000/1001");
    assert.equal(Number(video.nb_read_frames), 72);
    assert.ok(Math.abs(Number(video.duration) - 3.003) < 0.002);
    const trimRemove = [
      { type: "trim-occurrence", occurrenceId: "repeat-a", sourceStartTime: frame(24), durationTime: frame(12) },
      { type: "remove-occurrence", occurrenceId: "b" },
    ];
    const beforeTrim = payload(await callTool({ name: "headless.project.inspect", arguments: { projectId } }));
    const trimPreview = payload(await callTool({ name: "headless.edit.preview", arguments: { projectId, sequenceId, expectedRevision: revision, operations: trimRemove } }));
    const revisedClip = trimPreview.after.timeline.sequence.occurrences.find((item: any) => item.id === "repeat-a");
    assert.deepEqual(revisedClip.sourceStartTime, { value: "1001", timescale: "1000" });
    assert.deepEqual(revisedClip.durationTime, { value: "1001", timescale: "2000" });
    assert.equal(trimPreview.after.timeline.sequence.occurrences.some((item: any) => item.id === "b"), false);
    assert.deepEqual(payload(await callTool({ name: "headless.project.inspect", arguments: { projectId } })).timeline, beforeTrim.timeline);
    const wrongTarget = await callTool({ name: "headless.edit.execute", arguments: { projectId, sequenceId: "wrong-sequence", expectedRevision: revision, operations: trimRemove } });
    assert.equal(wrongTarget.isError, true);
    const trimmed = payload(await callTool({ name: "headless.edit.execute", arguments: { projectId, sequenceId, expectedRevision: revision, operations: trimRemove } }));
    const v3Path = join(directory, "version-3.fcpxml");
    const v3Target = { ...v1Target, projectUid: "project-v3", sequenceUid: "sequence-v3" };
    const v3 = payload(await callTool({ name: "headless.fcpxml.export", arguments: { projectId, sequenceId, expectedRevision: trimmed.after.timeline.revision, outputPath: v3Path, target: v3Target } }));
    assert.equal(v3.artifact.verified, true);
    const v3Document = await new FcpxmlDocumentAdapter(v3Path).readProject();
    assert.deepEqual(v3Document.timeline.clips.map((clip) => [clip.sourceStart, clip.duration]), [[0.5005, 0.5005], [1.001, 0.5005], [1.001, 0.5005]]);
    const restored = payload(await callTool({ name: "headless.edit.undo", arguments: { projectId, sequenceId, expectedRevision: trimmed.after.timeline.revision, undoId: trimmed.undoId } }));
    assert.equal(restored.verification.verified, true);
    assert.deepEqual(restored.project.timeline.sequence, beforeTrim.timeline.sequence);
    assert.equal(await sha(v1Path), v1Digest);
    const hiddenPath = `${paths[1]!}.missing`;
    await rename(paths[1]!, hiddenPath);
    try {
      const missing = await callTool({ name: "headless.project.inspect", arguments: { projectId } });
      assert.match(toolErrorText(missing), /MEDIA_MISSING/);
    } finally {
      await rename(hiddenPath, paths[1]!);
    }
    assert.deepEqual(await Promise.all(paths.map(sha)), sourceDigests);
    assert.equal(await readFile(reservationPath, "utf8"), reservation);
    assert.equal(existsSync(nativeCalls), false, "headless workflow must not invoke a native command");
    t.diagnostic(`artifact_evidence=${JSON.stringify({
      schemaVersion: 1,
      sources: sourceDigests.map((sha256, index) => ({ fixtureId: index === 0 ? "a" : "b", sha256 })),
      fcpxml: { sha256: await sha(xmlPath), sourceOrder: ["a", "a", "a", "b"] },
      video: { sha256: await sha(outputPath), frames: Number(video.nb_read_frames), frameRate: video.r_frame_rate, duration: Number(video.duration) },
      native: "not-run",
    })}`);
  } finally {
    await client?.close();
    await transport?.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test("headless media search returns both registered same-name sources through production MCP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headless-media-search-"));
  const here = dirname(fileURLToPath(import.meta.url));
  const environment: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_AUTO_CONNECT: "0",
    FRAMEKIT_FINAL_CUT_HEADLESS: "1",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0",
    FRAMEKIT_FINAL_CUT_SOCKET: join(directory, "missing-final-cut.sock"),
    FRAMEKIT_STATE_DIR: join(directory, "state"),
  };
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    const reservationPath = join(directory, "state", "canonical-recovery", "pending.json");
    const reservation = JSON.stringify({ version: 2, kind: "native-operation", owner: "00000000-0000-4000-8000-000000000001", operation: "native.searchmedia" }) + "\n";
    await mkdir(dirname(reservationPath), { recursive: true });
    await writeFile(reservationPath, reservation);
    const paths = [join(directory, "a", "same.mp4"), join(directory, "b", "same.mp4")];
    await mkdir(dirname(paths[0]!), { recursive: true });
    await mkdir(dirname(paths[1]!), { recursive: true });
    await generateSegmentedSource(paths[0]!, [{ color: "red", duration: 1 }], 440);
    await generateSegmentedSource(paths[1]!, [{ color: "blue", duration: 1 }], 660);
    ({ client, transport } = await connectProductionClient(here, environment));
    const created = payload(await client.callTool({ name: "headless.project.create", arguments: { timeline: emptyTimeline() } }));
    const projectId = created.timeline.project.id;
    const first = payload(await client.callTool({ name: "headless.media.register", arguments: { projectId, sourcePath: paths[0], expectedRevision: created.timeline.revision } }));
    const second = payload(await client.callTool({ name: "headless.media.register", arguments: { projectId, sourcePath: paths[1], expectedRevision: first.project.timeline.revision } }));
    const found = payload(await client.callTool({ name: "headless.media.search", arguments: { projectId, query: "same.mp4" } }));
    assert.deepEqual(found.revision, second.project.timeline.revision);
    assert.deepEqual(found.media.map((item: any) => item.id).sort(), [first.resource.id, second.resource.id].sort());
    assert.deepEqual(found.media.map((item: any) => item.source).sort(), paths.sort());
    const exact = payload(await client.callTool({ name: "headless.media.search", arguments: { projectId, query: first.resource.id } }));
    assert.deepEqual(exact.media.map((item: any) => item.id), [first.resource.id]);
    const absent = payload(await client.callTool({ name: "headless.media.search", arguments: { projectId, query: "not-present" } }));
    assert.deepEqual(absent.media, []);
    assert.equal(await readFile(reservationPath, "utf8"), reservation);
  } finally {
    await client?.close();
    await transport?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("headless project list includes valid project IDs that resemble render records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headless-project-list-"));
  try {
    const service = new HeadlessProjectService({ directory });
    const ids = ["render-example", "render-00000000-0000-4000-8000-000000000001", "rough-cut-00000000-0000-4000-8000-000000000002", `${"a".repeat(64)}.approval`];
    for (const id of ids) {
      const timeline = emptyTimeline();
      timeline.project.id = id;
      await service.create(timeline);
    }
    assert.deepEqual((await service.list()).map((project) => project.projectId).sort(), ids.sort());
    await writeFile(join(directory, "corrupt.json"), "not-json");
    await assert.rejects(service.list(), /PROJECT_CORRUPT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("headless project list rejects a project whose stored ID differs from its filename", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headless-project-id-"));
  try {
    const service = new HeadlessProjectService({ directory });
    const timeline = emptyTimeline();
    timeline.project.id = "actual";
    await service.create(timeline);
    const original = await readFile(join(directory, "actual.json"), "utf8");
    await writeFile(join(directory, "different.json"), original);
    await assert.rejects(service.list(), /PROJECT.*(IDENTITY|MISMATCH|CORRUPT)/);
    assert.equal(await readFile(join(directory, "actual.json"), "utf8"), original);
    assert.equal(await readFile(join(directory, "different.json"), "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("headless export checks the revision of the media-validated snapshot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headless-export-snapshot-"));
  const oldTimeline = emptyTimeline();
  oldTimeline.resources.push({
    id: "missing", name: "missing.mp4", mediaKind: "video", source: join(directory, "missing.mp4"),
    sourceKind: "local-file", sourceDigest: "0".repeat(64),
  });
  const newTimeline = emptyTimeline();
  newTimeline.revision = { ...newTimeline.revision, id: "newer", sequence: 1 };
  const metadata = { createdAt: oldTimeline.revision.timestamp, updatedAt: oldTimeline.revision.timestamp };
  const oldProject = { schemaVersion: 1 as const, metadata, timeline: oldTimeline };
  const newProject = { schemaVersion: 1 as const, metadata, timeline: newTimeline };
  let loadCount = 0;
  t.mock.method(FramekitProjectStore.prototype, "load", async () => ++loadCount % 2 ? oldProject : newProject);
  const service = new HeadlessProjectService({ directory, mediaProbe: { probe: async () => { throw new Error("not used"); } } });
  const outputPath = join(directory, "out.fcpxml");
  const target = { provider: "final-cut" as const, libraryUid: "library", eventUid: "event", projectUid: "project", sequenceUid: "sequence" };
  try {
    await assert.rejects(service.exportFcpxml(oldTimeline.project.id, oldTimeline.sequence.id, oldTimeline.revision, outputPath, target), /STALE/);
    assert.equal(existsSync(outputPath), false);
    const opened = await service.open(oldTimeline.project.id);
    assert.equal(opened.timeline.revision.id, "newer");
  } finally {
    t.mock.restoreAll();
    await rm(directory, { recursive: true, force: true });
  }
});

test("headless edits and rough cuts stay bound to the validated snapshot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headless-snapshot-race-"));
  const older = emptyTimeline();
  const newer = structuredClone(older);
  newer.revision = { ...older.revision, id: "newer", sequence: 1 };
  const metadata = { createdAt: older.revision.timestamp, updatedAt: older.revision.timestamp };
  const oldProject = { schemaVersion: 1 as const, metadata, timeline: older };
  const newProject = { schemaVersion: 1 as const, metadata, timeline: newer };
  let loadCount = 0;
  let latestProject = newProject;
  t.mock.method(FramekitProjectStore.prototype, "load", async () => ++loadCount === 1 ? oldProject : latestProject);
  let saves = 0;
  t.mock.method(FramekitProjectStore.prototype, "save", async (project: FramekitProjectDocument) => { saves++; return project; });
  const service = new HeadlessProjectService({ directory });
  const command = { schemaVersion: 1 as const, expectedRevision: newer.revision, operations: [] };
  try {
    await assert.rejects(service.previewEdit(older.project.id, command, older.sequence.id), /STALE/);
    loadCount = 0;
    await assert.rejects(service.executeEdit(older.project.id, command, older.sequence.id), /STALE/);
    assert.equal(saves, 0);
    loadCount = 0;
    await assert.rejects(service.previewEdit(older.project.id, { ...command, expectedRevision: older.revision }, older.sequence.id), /STALE/);
    loadCount = 0;
    latestProject = { ...oldProject, timeline: { ...older, project: { ...older.project, name: "changed with same revision" } } };
    await assert.rejects(service.previewEdit(older.project.id, { ...command, expectedRevision: older.revision }, older.sequence.id), /STALE/);
    latestProject = newProject;
    loadCount = 0;
    const request = {
      projectId: older.project.id, sequenceId: older.sequence.id,
      plan: { planner: { id: "test", version: 1 }, revision: newer.revision, query: { query: "test" }, shots: [], warnings: [] },
      render: { outputPath: join(directory, "out.mp4"), format: "mp4" as const, width: 16, height: 16, frameRate: { value: "30", timescale: "1" } },
      fcpxml: { path: join(directory, "out.fcpxml"), target: { provider: "final-cut" as const, libraryUid: "l", eventUid: "e", projectUid: "p", sequenceUid: "s" } },
    };
    await assert.rejects(service.previewRoughCut(request), /STALE/);
  } finally {
    t.mock.restoreAll();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production MCP exports an edited headless project as FCPXML without a rough-cut plan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headless-fcpxml-"));
  const here = dirname(fileURLToPath(import.meta.url));
  const environment: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    FRAMEKIT_EDITOR: "final-cut-live", FRAMEKIT_AUTO_CONNECT: "0", FRAMEKIT_FINAL_CUT_HEADLESS: "1",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0", FRAMEKIT_FINAL_CUT_SOCKET: join(directory, "missing-final-cut.sock"),
    FRAMEKIT_STATE_DIR: join(directory, "state"),
  };
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    const sourcePath = join(directory, "source.mp4");
    const outputPath = join(directory, "edit.fcpxml");
    await generateSegmentedSource(sourcePath, [{ color: "red", duration: 2 }], 440);
    ({ client, transport } = await connectProductionClient(here, environment));
    const created = payload(await client.callTool({ name: "headless.project.create", arguments: { timeline: emptyTimeline() } }));
    const projectId = created.timeline.project.id;
    const sequenceId = created.timeline.sequence.id;
    const media = payload(await client.callTool({ name: "headless.media.register", arguments: { projectId, sourcePath, expectedRevision: created.timeline.revision } }));
    const edit = payload(await client.callTool({ name: "headless.edit.execute", arguments: {
      projectId, sequenceId, expectedRevision: media.project.timeline.revision,
      operations: [{ type: "insert-occurrence", placement: "append", occurrence: { ...occurrence("clip-1", media.resource.id), sourceStartTime: { value: "1", timescale: "2" } } }],
    } }));
    const target = { provider: "final-cut", libraryUid: "library", eventUid: "event", projectUid: "project", sequenceUid: "sequence", materialization: "versioned" };
    const args = { projectId, sequenceId, outputPath, target };
    const stale = await client.callTool({ name: "headless.fcpxml.export", arguments: { ...args, expectedRevision: media.project.timeline.revision } });
    assert.match(toolErrorText(stale), /STALE/);
    assert.equal(existsSync(outputPath), false);
    const exported = payload(await client.callTool({ name: "headless.fcpxml.export", arguments: { ...args, expectedRevision: edit.after.timeline.revision } }));
    assert.equal(exported.artifact.verified, true);
    assert.deepEqual(exported.provenance.revision, edit.after.timeline.revision);
    const parsed = await new FcpxmlDocumentAdapter(outputPath).readProject();
    assert.equal(parsed.timeline.clips.length, 1);
    assert.equal(parsed.timeline.clips[0]?.sourceStart, 0.5);
    assert.equal(parsed.timeline.clips[0]?.duration, 1);
    assert.equal(parsed.media.find((item) => item.mediaId === parsed.timeline.clips[0]?.mediaId)?.source, sourcePath);
    const pending = join(environment.FRAMEKIT_STATE_DIR!, "canonical-recovery", "pending.json");
    await mkdir(dirname(pending), { recursive: true });
    await writeFile(pending, "synthetic reservation");
    const protectedResult = await client.callTool({ name: "headless.fcpxml.export", arguments: { ...args, outputPath: pending, expectedRevision: edit.after.timeline.revision } });
    assert.match(toolErrorText(protectedResult), /OUTPUT.*COLLISION/);
    assert.equal(await readFile(pending, "utf8"), "synthetic reservation");
    const originalXml = await readFile(outputPath, "utf8");
    const duplicate = await client.callTool({ name: "headless.fcpxml.export", arguments: { ...args, expectedRevision: edit.after.timeline.revision } });
    assert.match(toolErrorText(duplicate), /EXIST|OVERWRITE/);
    assert.equal(await readFile(outputPath, "utf8"), originalXml);
    const fifo = join(directory, "existing.fifo");
    await execFileAsync("mkfifo", [fifo]);
    const fifoRequest = client.callTool({ name: "headless.fcpxml.export", arguments: { ...args, outputPath: fifo, expectedRevision: edit.after.timeline.revision } });
    let cancelFifoTimer = () => {};
    const fifoResult = await Promise.race([
      fifoRequest,
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(resolve, 5000);
        cancelFifoTimer = () => clearTimeout(timer);
      }),
    ]);
    cancelFifoTimer();
    if (!fifoResult) {
      // Unblock a regressed implementation before failing the test.
      const writer = await open(fifo, "w");
      await writer.close();
      await fifoRequest;
    }
    assert.ok(fifoResult, "existing FIFO must be rejected without reading it");
    assert.match(toolErrorText(fifoResult), /EXIST|OVERWRITE/);
    assert.equal((await stat(fifo)).isFIFO(), true);
    const concurrentArgs = { ...args, outputPath: join(directory, "concurrent.fcpxml"), expectedRevision: edit.after.timeline.revision };
    const concurrent = await Promise.all([
      client.callTool({ name: "headless.fcpxml.export", arguments: concurrentArgs }),
      client.callTool({ name: "headless.fcpxml.export", arguments: concurrentArgs }),
    ]);
    assert.equal(concurrent.filter((result) => !result.isError).length, 1);
    assert.equal(concurrent.filter((result) => result.isError).length, 1);
  } finally {
    await client?.close();
    await transport?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("approved headless edits execute only a matching issued preview", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-approved-edit-"));
  const here = dirname(fileURLToPath(import.meta.url));
  const environment: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    FRAMEKIT_EDITOR: "final-cut-live", FRAMEKIT_AUTO_CONNECT: "0", FRAMEKIT_FINAL_CUT_HEADLESS: "1",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0", FRAMEKIT_FINAL_CUT_SOCKET: join(directory, "missing.sock"),
    FRAMEKIT_STATE_DIR: join(directory, "state"),
  };
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    ({ client, transport } = await connectProductionClient(here, environment));
    const initial = payload(await client.callTool({ name: "headless.project.create", arguments: { timeline: emptyTimeline() } }));
    const projectId = initial.timeline.project.id, sequenceId = initial.timeline.sequence.id;
    const request = { projectId, sequenceId, expectedRevision: initial.timeline.revision,
      operations: [{ type: "add-marker", marker: { id: "approved", name: "Approved", startTime: { value: "0", timescale: "1" }, durationTime: { value: "0", timescale: "1" } } }] };
    const preview = payload(await client.callTool({ name: "headless.edit.approved-preview", arguments: request }));
    assert.equal(typeof preview.previewToken, "string");
    const stalePreview = payload(await client.callTool({ name: "headless.edit.approved-preview", arguments: request }));
    const execute = { projectId, sequenceId, previewToken: preview.previewToken, approved: true };
    for (const invalid of [{ ...execute, sequenceId: "wrong-sequence" }, { ...execute, previewToken: "missing-token" }, { ...execute, approved: false }]) {
      const result = await client.callTool({ name: "headless.edit.approved-execute", arguments: invalid });
      assert.equal(result.isError, true);
    }
    assert.deepEqual(payload(await client.callTool({ name: "headless.project.inspect", arguments: { projectId } })).timeline, initial.timeline);
    const attempts = await Promise.all([
      client.callTool({ name: "headless.edit.approved-execute", arguments: execute }),
      client.callTool({ name: "headless.edit.approved-execute", arguments: execute }),
    ]);
    assert.equal(attempts.filter((result) => !result.isError).length, 1);
    assert.equal(attempts.filter((result) => result.isError).length, 1);
    const committed = payload(attempts.find((result) => !result.isError)!);
    assert.equal(committed.after.timeline.sequence.markers[0].id, "approved");
    assert.equal((await client.callTool({ name: "headless.edit.approved-execute", arguments: execute })).isError, true);
    const stale = await client.callTool({ name: "headless.edit.approved-execute", arguments: { ...execute, previewToken: stalePreview.previewToken } });
    assert.equal(stale.isError, true);
    assert.match(toolErrorText(stale), /STALE/);
    const next = payload(await client.callTool({ name: "headless.edit.approved-preview", arguments: { ...request, expectedRevision: committed.after.timeline.revision, operations: [{ ...request.operations[0], marker: { ...request.operations[0].marker, id: "after-restart" } }] } }));
    await client.close(); await transport.close();
    ({ client, transport } = await connectProductionClient(here, environment));
    const lost = await client.callTool({ name: "headless.edit.approved-execute", arguments: { projectId, sequenceId, previewToken: next.previewToken, approved: true } });
    assert.equal(lost.isError, true);
    assert.deepEqual(payload(await client.callTool({ name: "headless.project.inspect", arguments: { projectId } })).timeline, committed.after.timeline);
  } finally {
    await client?.close(); await transport?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("approved headless edit rejects a changed base with the same revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-approved-base-"));
  try {
    const service = new HeadlessProjectService({ directory });
    const initial = await service.create(emptyTimeline());
    const projectId = initial.timeline.project.id, sequenceId = initial.timeline.sequence.id;
    const marker = (id: string) => ({ id, name: id, startTime: { value: "0", timescale: "1" }, durationTime: { value: "0", timescale: "1" } });
    const preview = await service.previewApprovedEdit(projectId, { schemaVersion: 1, expectedRevision: initial.timeline.revision,
      operations: [{ type: "add-marker", marker: marker("approved") }] }, sequenceId);
    const store = new FramekitProjectStore(join(directory, `${projectId}.json`));
    const changed = await store.load();
    changed.timeline.sequence.markers.push(marker("unapproved"));
    await store.save(changed, initial.timeline.revision);
    await assert.rejects(service.executeApprovedEdit(projectId, sequenceId, preview.previewToken), /HEADLESS_EDIT_PREVIEW_MISMATCH/);
    assert.deepEqual((await service.open(projectId)).timeline, changed.timeline);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("approved headless edit tokens expire without mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-approved-expiry-"));
  const realNow = Date.now;
  try {
    let now = realNow();
    Date.now = () => now;
    const service = new HeadlessProjectService({ directory });
    const initial = await service.create(emptyTimeline());
    const projectId = initial.timeline.project.id, sequenceId = initial.timeline.sequence.id;
    const preview = await service.previewApprovedEdit(projectId, { schemaVersion: 1, expectedRevision: initial.timeline.revision,
      operations: [{ type: "add-marker", marker: { id: "expired", name: "Expired", startTime: { value: "0", timescale: "1" }, durationTime: { value: "0", timescale: "1" } } }] }, sequenceId);
    now += 10 * 60 * 1000;
    await assert.rejects(service.executeApprovedEdit(projectId, sequenceId, preview.previewToken), /HEADLESS_EDIT_PREVIEW_INVALID/);
    assert.deepEqual((await service.open(projectId)).timeline, initial.timeline);
  } finally { Date.now = realNow; await rm(directory, { recursive: true, force: true }); }
});

test("headless edit Undo survives MCP restart and verifies the restored project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headless-undo-"));
  const here = dirname(fileURLToPath(import.meta.url));
  const environment: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_AUTO_CONNECT: "0",
    FRAMEKIT_FINAL_CUT_HEADLESS: "1",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0",
    FRAMEKIT_FINAL_CUT_SOCKET: join(directory, "missing-final-cut.sock"),
    FRAMEKIT_STATE_DIR: join(directory, "state"),
  };
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    ({ client, transport } = await connectProductionClient(here, environment));
    const initial = payload(await client.callTool({ name: "headless.project.create", arguments: { timeline: emptyTimeline() } }));
    const projectId = initial.timeline.project.id;
    const sequenceId = initial.timeline.sequence.id;
    const edit = payload(await client.callTool({ name: "headless.edit.execute", arguments: {
      projectId, sequenceId, expectedRevision: initial.timeline.revision,
      operations: [{ type: "add-marker", marker: { id: "marker-1", name: "Marker", startTime: { value: "0", timescale: "1" }, durationTime: { value: "0", timescale: "1" } } }],
    } }));
    assert.equal(typeof edit.undoId, "string");
    assert.equal(edit.after.timeline.sequence.markers.length, 1);
    await client.close();
    await transport.close();
    ({ client, transport } = await connectProductionClient(here, environment));
    const undoArgs = { projectId, sequenceId, undoId: edit.undoId, expectedRevision: edit.after.timeline.revision };
    const wrongTarget = await client.callTool({ name: "headless.edit.undo", arguments: { ...undoArgs, sequenceId: "wrong-sequence" } });
    assert.match(toolErrorText(wrongTarget), /HEADLESS_UNDO_INVALID|MISMATCH/);
    const wrongRevision = await client.callTool({ name: "headless.edit.undo", arguments: { ...undoArgs, expectedRevision: initial.timeline.revision } });
    assert.match(toolErrorText(wrongRevision), /HEADLESS_UNDO_STALE/);
    const missing = await client.callTool({ name: "headless.edit.undo", arguments: { ...undoArgs, undoId: `undo-00000000-0000-4000-8000-000000000001-${"0".repeat(64)}` } });
    assert.match(toolErrorText(missing), /HEADLESS_UNDO_INVALID/);
    const malformed = await client.callTool({ name: "headless.edit.undo", arguments: { ...undoArgs, undoId: "../undo-invalid" } });
    assert.match(toolErrorText(malformed), /HEADLESS_UNDO_INVALID/);
    const historyPath = join(directory, "state", "projects", "undo", `${edit.undoId.slice(0, 41)}.json`);
    const history = await readFile(historyPath, "utf8");
    const damaged = JSON.parse(history);
    damaged.before.timeline.sequence.markers.push({ id: "forged", name: "Forged", startTime: { value: "0", timescale: "1" }, durationTime: { value: "0", timescale: "1" } });
    damaged.beforeDigest = timelineIrDigest(damaged.before.timeline);
    const { checksum: _checksum, ...content } = damaged;
    const canonical = (value: any): string => value === null || typeof value !== "object" ? JSON.stringify(value)
      : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
      : `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
    damaged.checksum = createHash("sha256").update(canonical(content)).digest("hex");
    await writeFile(historyPath, JSON.stringify(damaged));
    const corrupt = await client.callTool({ name: "headless.edit.undo", arguments: undoArgs });
    assert.match(toolErrorText(corrupt), /HEADLESS_UNDO_INVALID/);
    assert.deepEqual(payload(await client.callTool({ name: "headless.project.inspect", arguments: { projectId } })).timeline, edit.after.timeline);
    await writeFile(historyPath, history);
    const restored = payload(await client.callTool({ name: "headless.edit.undo", arguments: {
      ...undoArgs,
    } }));
    assert.equal(restored.verification.verified, true);
    const inspected = payload(await client.callTool({ name: "headless.project.inspect", arguments: { projectId } }));
    assert.deepEqual(inspected.timeline.sequence, initial.timeline.sequence);
    assert.deepEqual(inspected.timeline.resources, initial.timeline.resources);
    assert.equal(inspected.timeline.revision.sequence, edit.after.timeline.revision.sequence + 1);
    assert.deepEqual(inspected.timeline.revision, restored.project.timeline.revision);
    const stale = await client.callTool({ name: "headless.edit.undo", arguments: {
      projectId, sequenceId, undoId: edit.undoId, expectedRevision: edit.after.timeline.revision,
    } });
    assert.match(toolErrorText(stale), /STALE|MISMATCH/);
    assert.deepEqual(payload(await client.callTool({ name: "headless.project.inspect", arguments: { projectId } })), inspected);
    const next = payload(await client.callTool({ name: "headless.edit.execute", arguments: {
      projectId, sequenceId, expectedRevision: inspected.timeline.revision,
      operations: [{ type: "add-marker", marker: { id: "marker-2", name: "Second", startTime: { value: "0", timescale: "1" }, durationTime: { value: "0", timescale: "1" } } }],
    } }));
    const nextHistoryPath = join(directory, "state", "projects", "undo", `${next.undoId.slice(0, 41)}.json`);
    const nextHistory = await readFile(nextHistoryPath, "utf8");
    await writeFile(nextHistoryPath, history);
    const substituted = await client.callTool({ name: "headless.edit.undo", arguments: {
      projectId, sequenceId, undoId: next.undoId, expectedRevision: next.after.timeline.revision,
    } });
    assert.match(toolErrorText(substituted), /HEADLESS_UNDO_INVALID/);
    assert.deepEqual(payload(await client.callTool({ name: "headless.project.inspect", arguments: { projectId } })).timeline, next.after.timeline);
    await writeFile(nextHistoryPath, nextHistory);
    const later = payload(await client.callTool({ name: "headless.edit.execute", arguments: {
      projectId, sequenceId, expectedRevision: next.after.timeline.revision,
      operations: [{ type: "add-marker", marker: { id: "marker-3", name: "Third", startTime: { value: "0", timescale: "1" }, durationTime: { value: "0", timescale: "1" } } }],
    } }));
    const intervening = await client.callTool({ name: "headless.edit.undo", arguments: {
      projectId, sequenceId, undoId: next.undoId, expectedRevision: later.after.timeline.revision,
    } });
    assert.match(toolErrorText(intervening), /HEADLESS_UNDO_STALE/);
    assert.deepEqual(payload(await client.callTool({ name: "headless.project.inspect", arguments: { projectId } })).timeline, later.after.timeline);
  } finally {
    await client?.close();
    await transport?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("headless Undo rejects changed or missing media and a validation race", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headless-undo-media-"));
  try {
    const source = join(directory, "source.mov");
    const bytes = "synthetic original media";
    await writeFile(source, bytes);
    const options = { directory: join(directory, "projects"), mediaProbe: { probe: async () => ({
      durationTime: { value: "2", timescale: "1" },
      streams: [{ kind: "video" as const, width: 32, height: 32, frameRate: { value: "30", timescale: "1" } }],
    }) } };
    const service = new HeadlessProjectService(options);
    const initial = await service.create(emptyTimeline());
    const projectId = initial.timeline.project.id;
    const sequenceId = initial.timeline.sequence.id;
    const registered = await service.registerMedia(projectId, source, initial.timeline.revision);
    const edit = await service.executeEdit(projectId, {
      schemaVersion: 1, expectedRevision: registered.project.timeline.revision,
      operations: [{ type: "add-marker", marker: { id: "one", name: "One", startTime: { value: "0", timescale: "1" }, durationTime: { value: "0", timescale: "1" } } }],
    }, sequenceId);
    const projectPath = join(options.directory, `${projectId}.json`);
    const before = await readFile(projectPath, "utf8");
    const restarted = new HeadlessProjectService(options);
    await writeFile(source, "changed media");
    await assert.rejects(restarted.undoEdit(projectId, sequenceId, edit.undoId, edit.after.timeline.revision), /MEDIA_CHANGED/);
    assert.equal(await readFile(projectPath, "utf8"), before);
    await rm(source);
    await assert.rejects(restarted.undoEdit(projectId, sequenceId, edit.undoId, edit.after.timeline.revision), /MEDIA_MISSING/);
    assert.equal(await readFile(projectPath, "utf8"), before);
    await writeFile(source, bytes);
    const newer = structuredClone(edit.after);
    newer.timeline.revision = { ...newer.timeline.revision, id: "intervening", sequence: newer.timeline.revision.sequence + 1 };
    let loads = 0;
    t.mock.method(FramekitProjectStore.prototype, "load", async () => ++loads === 1 ? edit.after : newer);
    await assert.rejects(restarted.undoEdit(projectId, sequenceId, edit.undoId, edit.after.timeline.revision), /STALE/);
    t.mock.restoreAll();
    assert.equal(await readFile(projectPath, "utf8"), before);
    const restored = await restarted.undoEdit(projectId, sequenceId, edit.undoId, edit.after.timeline.revision);
    assert.equal(restored.verification.verified, true);
    assert.deepEqual(restored.project.timeline.sequence, registered.project.timeline.sequence);
  } finally {
    t.mock.restoreAll();
    await rm(directory, { recursive: true, force: true });
  }
});

test("headless Undo reports save and independent readback failures without verified success", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headless-undo-failure-"));
  try {
    const service = new HeadlessProjectService({ directory });
    const initial = await service.create(emptyTimeline());
    const projectId = initial.timeline.project.id;
    const sequenceId = initial.timeline.sequence.id;
    const expectedDigest = timelineIrDigest(initial.timeline);
    const edit = await service.executeEdit(projectId, {
      schemaVersion: 1, expectedRevision: initial.timeline.revision,
      operations: [{ type: "add-marker", marker: { id: "one", name: "One", startTime: { value: "0", timescale: "1" }, durationTime: { value: "0", timescale: "1" } } }],
    }, sequenceId);
    const path = join(directory, `${projectId}.json`);
    const committedBytes = await readFile(path, "utf8");
    t.mock.method(FramekitProjectStore.prototype, "save", async () => { throw new Error("injected pre-write failure"); });
    await assert.rejects(service.undoEdit(projectId, sequenceId, edit.undoId, edit.after.timeline.revision), /pre-write failure/);
    t.mock.restoreAll();
    assert.equal(await readFile(path, "utf8"), committedBytes);
    assert.equal(timelineIrDigest((await service.inspect(projectId)).timeline), timelineIrDigest(edit.after.timeline));

    const realSave = FramekitProjectStore.prototype.save;
    const realLoad = FramekitProjectStore.prototype.load;
    let saved = false;
    t.mock.method(FramekitProjectStore.prototype, "save", async function(this: FramekitProjectStore, project: FramekitProjectDocument, revision?: TimelineIr["revision"]) {
      const result = await realSave.call(this, project, revision);
      saved = true;
      return result;
    });
    t.mock.method(FramekitProjectStore.prototype, "load", async function(this: FramekitProjectStore) {
      const project = await realLoad.call(this);
      if (saved) project.timeline.sequence.markers.push({ id: "unexpected", name: "Unexpected", startTime: { value: "0", timescale: "1" }, durationTime: { value: "0", timescale: "1" } });
      return project;
    });
    await assert.rejects(service.undoEdit(projectId, sequenceId, edit.undoId, edit.after.timeline.revision), /HEADLESS_UNDO_UNVERIFIED/);
    t.mock.restoreAll();
    const persisted = await service.inspect(projectId);
    assert.equal(timelineIrDigest(persisted.timeline), expectedDigest);
    assert.deepEqual(persisted.timeline.sequence, initial.timeline.sequence);
    assert.equal(persisted.timeline.revision.sequence, edit.after.timeline.revision.sequence + 1);
  } finally {
    t.mock.restoreAll();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent headless Undo attempts cannot both restore the same revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headless-undo-concurrent-"));
  try {
    const service = new HeadlessProjectService({ directory });
    const initial = await service.create(emptyTimeline());
    const projectId = initial.timeline.project.id;
    const sequenceId = initial.timeline.sequence.id;
    const edit = await service.executeEdit(projectId, {
      schemaVersion: 1, expectedRevision: initial.timeline.revision,
      operations: [{ type: "add-marker", marker: { id: "one", name: "One", startTime: { value: "0", timescale: "1" }, durationTime: { value: "0", timescale: "1" } } }],
    }, sequenceId);
    const attempts = await Promise.allSettled([
      service.undoEdit(projectId, sequenceId, edit.undoId, edit.after.timeline.revision),
      service.undoEdit(projectId, sequenceId, edit.undoId, edit.after.timeline.revision),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
    const restored = await service.inspect(projectId);
    assert.deepEqual(restored.timeline.sequence, initial.timeline.sequence);
    assert.equal(restored.timeline.revision.sequence, edit.after.timeline.revision.sequence + 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production rough-cut tools expose digest-bound edit operations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-rough-cut-operations-"));
  const here = dirname(fileURLToPath(import.meta.url));
  const environment: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_AUTO_CONNECT: "0",
    FRAMEKIT_FINAL_CUT_HEADLESS: "1",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0",
    FRAMEKIT_FINAL_CUT_SOCKET: join(directory, "missing-final-cut.sock"),
    FRAMEKIT_FCPXML_PATH: join(directory, "missing-project.fcpxml"),
    FRAMEKIT_STATE_DIR: directory,
  };
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    ({ client, transport } = await connectProductionClient(here, environment));
    const tools = await client.listTools();
    for (const name of ["headless.rough-cut.preview", "headless.rough-cut.execute"]) {
      const tool = tools.tools.find((entry) => entry.name === name);
      assert.ok(tool, `${name} is registered`);
      assert.ok((tool.inputSchema as any).properties.operations, `${name} accepts edit operations`);
    }
    const publishPreview = tools.tools.find((entry) => entry.name === "artifact.publish.preview");
    assert.ok(publishPreview);
    assert.ok((publishPreview.inputSchema as any).properties.headlessExecutionId);
  } finally {
    await client?.close();
    await transport?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("headless project media can be understood and planned without a Final Cut connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headless-analysis-"));
  const here = dirname(fileURLToPath(import.meta.url));
  const sourcePath = join(directory, "source.mp4");
  const stateDirectory = join(directory, "state");
  const speechAnalyzer = await makeHeadlessSpeechAnalyzer(directory);
  const audioAnalyzer = await makeFixedAnalyzer(directory, "audio", JSON.stringify({
    integratedLufs: -18,
    truePeakDb: -3,
    silenceMs: 0,
    analyzedDurationSeconds: 5,
  }));
  const environment: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_AUTO_CONNECT: "0",
    FRAMEKIT_FINAL_CUT_HEADLESS: "1",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0",
    FRAMEKIT_FINAL_CUT_SOCKET: join(directory, "missing-final-cut.sock"),
    FRAMEKIT_STATE_DIR: stateDirectory,
    FRAMEKIT_SPEECH_ANALYZER: speechAnalyzer,
    FRAMEKIT_SPEECH_ANALYZER_VERSION: "test-vad@1",
    FRAMEKIT_SPEECH_REQUIRE_VAD: "1",
    FRAMEKIT_AUDIO_ANALYZER: audioAnalyzer,
  };
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    await generateSegmentedSource(sourcePath, [{ color: "blue", duration: 5 }], 440);
    const unrelatedSource = {
      mediaId: "000-unrelated-project-media",
      source: join(directory, "unrelated.mp4"),
      sourceDigest: "f".repeat(64),
      mediaKind: "video",
      duration: 5,
    };
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(join(stateDirectory, "semantic-media-index.json"), JSON.stringify({
      schemaVersion: 1,
      entries: [{
        mediaId: unrelatedSource.mediaId,
        source: unrelatedSource.source,
        sourceIdentity: unrelatedSource,
        semantic: {
          subjects: [], scenes: [], environments: [], timeOfDay: [], moods: [],
          usableRanges: [{ start: 0, end: 5 }], transcript: "highlight",
        },
        analysis: [{ capability: "speech", status: "analyzed" }],
        speech: {
          words: [{ text: "highlight", start: 0.5, end: 1.4, confidence: 0.99 }],
          vadSegments: [{ start: 0, end: 2, kind: "speech", confidence: 0.99 }],
        },
        analysisRevision: { id: "unrelated-revision", sequence: 1, timestamp: "2026-10-12T00:00:00.000Z" },
      }],
    }));
    ({ client, transport } = await connectProductionClient(here, environment));

    const connection = payload(await client.callTool({ name: "connection.status", arguments: {} }));
    assert.notEqual(connection.state, "ready");
    const created = payload(await client.callTool({ name: "headless.project.create", arguments: { timeline: emptyTimeline() } }));
    const projectId = created.timeline.project.id;
    const registered = payload(await client.callTool({ name: "headless.media.register", arguments: {
      projectId,
      sourcePath,
      expectedRevision: created.timeline.revision,
    } }));

    const understanding = payload(await client.callTool({ name: "media.understand", arguments: {
      projectId,
      mediaId: registered.resource.id,
    } }));
    assert.equal(understanding.sourceIdentity.sourceDigest, registered.resource.sourceDigest);
    assert.equal(understanding.speech.capability, "transcription-plus-vad");
    assert.equal(understanding.audio.integratedLufs, -18);
    assert.ok(understanding.analysis.every((status: any) => status.status === "analyzed" || status.status === "unavailable"));

    const plan = payload(await client.callTool({ name: "rough-cut.plan", arguments: {
      projectId,
      query: "highlight",
      maxShots: 1,
    } }));
    assert.deepEqual(plan.revision, understanding.analysisRevision);
    assert.equal(plan.shots.length, 1);
    assert.equal(plan.shots[0].sourceIdentity.mediaId, registered.resource.id);
    assert.equal(plan.shots[0].evidence.vad.kind, "speech");
    assert.equal(plan.shots[0].evidence.audio.integratedLufs, -18);

    const preview = payload(await client.callTool({ name: "headless.rough-cut.preview", arguments: {
      projectId,
      sequenceId: created.timeline.sequence.id,
      plan,
      render: { outputPath: join(directory, "highlight.mp4"), format: "mp4", width: 320, height: 180, frameRate: { value: "30", timescale: "1" } },
      fcpxml: {
        path: join(directory, "highlight.fcpxml"),
        target: {
          provider: "final-cut",
          libraryUid: "codex-workflow-library",
          eventUid: "codex-workflow-event",
          projectUid: "codex-workflow-project",
          sequenceUid: "codex-workflow-sequence",
          materialization: "versioned",
        },
      },
    } }));
    const executed = payload(await client.callTool({ name: "headless.rough-cut.execute", arguments: {
      projectId,
      sequenceId: created.timeline.sequence.id,
      plan,
      render: preview.outputIntent.render,
      fcpxml: preview.outputIntent.fcpxml,
      approved: true,
      planDigest: preview.planDigest,
    } }));
    assert.equal(executed.committed, true);
    assert.deepEqual(executed.render.outcome.render.projectRevision, executed.after.timeline.revision);
    assert.deepEqual(executed.fcpxml.provenance.revision, executed.after.timeline.revision);
    const projects = payload(await client.callTool({ name: "headless.project.list", arguments: {} }));
    assert.ok(projects.some((project: any) => project.projectId === projectId));
  } finally {
    await client?.close();
    await transport?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production rough-cut MCP workflow previews and commits B-A-C video, title, and mixed music", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-issue-517-mvp-"));
  const here = dirname(fileURLToPath(import.meta.url));
  const environment: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_AUTO_CONNECT: "0",
    FRAMEKIT_FINAL_CUT_HEADLESS: "1",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0",
    FRAMEKIT_FINAL_CUT_SOCKET: join(directory, "missing-final-cut.sock"),
    FRAMEKIT_FCPXML_PATH: join(directory, "missing-project.fcpxml"),
    FRAMEKIT_FINAL_CUT_LIBRARY_UID: "issue-517-disposable-library",
    FRAMEKIT_STATE_DIR: join(directory, "state"),
  };
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    const sourcePaths = {
      a: join(directory, "source-a.mp4"),
      b: join(directory, "source-b.mp4"),
      c: join(directory, "source-c.mp4"),
      music: join(directory, "music.wav"),
    };
    await generateSegmentedSource(sourcePaths.a, [{ color: "red", duration: 10 }, { color: "green", duration: 12 }], 440);
    await generateSegmentedSource(sourcePaths.b, [{ color: "red", duration: 5 }, { color: "blue", duration: 8 }], 550);
    await generateSegmentedSource(sourcePaths.c, [{ color: "red", duration: 2 }, { color: "yellow", duration: 10 }], 660);
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
      "sine=frequency=1760:sample_rate=48000:duration=30", "-c:a", "pcm_s16le", sourcePaths.music,
    ]);
    ({ client, transport } = await connectProductionClient(here, environment));
    const tools = await client.listTools();
    const previewTool = tools.tools.find((tool) => tool.name === "headless.rough-cut.preview");
    assert.ok(previewTool);
    assert.ok((previewTool.inputSchema as any).properties.operations);

    const timeline = emptyTimeline();
    timeline.project.id = "issue-517-mvp-project";
    timeline.project.name = "Issue 517 MVP QA";
    timeline.sequence.id = "issue-517-mvp-sequence";
    timeline.sequence.name = "B-A-C MVP";
    // An empty project may still carry a positive placeholder sequence duration.
    timeline.sequence.durationTime = { value: "1", timescale: "1" };
    const created = payload(await client.callTool({ name: "headless.project.create", arguments: { timeline } }));
    const projectId = timeline.project.id;
    const sequenceId = timeline.sequence.id;
    const registrations: Record<string, any> = {};
    let revision = created.timeline.revision;
    for (const [key, sourcePath] of Object.entries(sourcePaths)) {
      const registered = payload(await client.callTool({ name: "headless.media.register", arguments: {
        projectId,
        sourcePath,
        expectedRevision: revision,
      } }));
      registrations[key] = registered.resource;
      revision = registered.project.timeline.revision;
    }
    assert.deepEqual(Object.keys(registrations), ["a", "b", "c", "music"]);
    const registeredProject = payload(await client.callTool({ name: "headless.project.inspect", arguments: { projectId } }));
    assert.deepEqual(registeredProject.timeline.resources.map((resource: any) => resource.source), Object.values(sourcePaths));

    const shot = (order: number, key: "a" | "b" | "c", start: number, end: number) => ({
      order,
      sourceIdentity: {
        mediaId: registrations[key].id,
        source: registrations[key].source,
        sourceDigest: registrations[key].sourceDigest,
        mediaKind: "video" as const,
        duration: Number(registrations[key].metadata.durationTime.value) / Number(registrations[key].metadata.durationTime.timescale),
      },
      range: { start, end },
      confidence: 1,
      matchedProperties: [`source:${key}`],
      rationale: `approved source ${key.toUpperCase()} range`,
    });
    const plan = {
      planner: { id: "framekit.issue-517.qa", version: 1 },
      revision,
      query: { query: "MVP order B, A, C with source audio retained" },
      shots: [shot(1, "b", 5, 13), shot(2, "a", 10, 22), shot(3, "c", 2, 12)],
      warnings: [],
    };
    const operations = [
      {
        type: "insert-occurrence",
        occurrence: {
          id: "issue-517-music",
          name: "Issue 517 independent music bed",
          startTime: { value: "0", timescale: "1" },
          durationTime: { value: "30", timescale: "1" },
          sourceStartTime: { value: "0", timescale: "1" },
          track: 1,
          role: "music",
          mediaId: registrations.music.id,
          gainDb: -12,
        },
      },
      {
        type: "add-title",
        title: {
          id: "issue-517-opening-title",
          text: "FrameKit MVP Test",
          startTime: { value: "0", timescale: "1" },
          durationTime: { value: "6", timescale: "1" },
          lane: 1,
        },
      },
    ];
    const outputPath = join(directory, "issue-517-mvp.mp4");
    const fcpxmlPath = environment.FRAMEKIT_FCPXML_PATH!;
    const request = {
      projectId,
      sequenceId,
      plan,
      operations,
      sourceAudioPolicy: "preserve-and-mix",
      render: { outputPath, format: "mp4", width: 320, height: 180, frameRate: { value: "30", timescale: "1" } },
      fcpxml: {
        path: fcpxmlPath,
        target: {
          provider: "final-cut",
          libraryUid: "issue-517-disposable-library",
          eventUid: "issue-517-event",
          projectUid: "issue-517-project",
          sequenceUid: "issue-517-sequence",
          materialization: "versioned",
        },
      },
    };
    const unsampledRequest = { ...request, plan: { ...plan, shots: Array.from({ length: 13 }, (_, index) => shot(index + 1, "a", 0, 1)) }, operations: [] };
    const unsampledResult = await client.callTool({ name: "headless.rough-cut.preview", arguments: unsampledRequest });
    assert.notEqual(unsampledResult.isError, true);
    const unsampled = payload(unsampledResult);
    assert.match(unsampled.planDigest, /^[a-f0-9]{64}$/);
    assert.equal(unsampled.storyboard, undefined);
    assert.match(unsampled.storyboardUnavailable, /HEADLESS_STORYBOARD_LIMIT/);
    assert.equal((unsampledResult.content as Array<{ type: string }>).some((item) => item.type === "image"), false);
    const previewResult = await client.callTool({ name: "headless.rough-cut.preview", arguments: request });
    let preview = payload(previewResult);
    const storyboardImage = (previewResult.content as Array<{ type: string; data?: string; mimeType?: string }>).find((item) => item.type === "image");
    assert.equal(storyboardImage?.mimeType, "image/png");
    assert.ok(Buffer.from(storyboardImage!.data!, "base64").length > 100);
    assert.equal(preview.storyboard.samples.filter((sample: any) => sample.kind === "shot").length, 3);
    assert.equal(preview.storyboard.samples.filter((sample: any) => sample.kind === "title").length, 1);
    assert.equal(preview.storyboard.planDigest, preview.planDigest);
    assert.equal(preview.storyboard.titleFontDigest, preview.titleFont.digest);
    assert.deepEqual(preview.storyboard.revision, preview.after.timeline.revision);
    assert.deepEqual(preview.storyboard.samples.map((sample: any) => [sample.kind, sample.mediaId]), [
      ["shot", registrations.b.id], ["title", registrations.b.id], ["shot", registrations.a.id], ["shot", registrations.c.id],
    ]);
    const sheetPath = join(directory, "preview.png");
    await writeFile(sheetPath, Buffer.from(storyboardImage!.data!, "base64"));
    const tile = async (x: number, y: number) => {
      const { stdout } = await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", sheetPath, "-vf", `crop=640:360:${x}:${y},scale=320:180`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", maxBuffer: 320 * 180 * 3 + 1024 });
      return stdout as unknown as Buffer;
    };
    assertPixelDominates(await tile(0, 0), "blue");
    assert.ok(countBrightPixels(await tile(640, 0)) > 100, "title midpoint is visible on the storyboard");
    assertPixelDominates(await tile(1280, 0), "green");
    assertPixelDominates(await tile(0, 360), "yellow");
    assert.equal(preview.before.timeline.sequence.occurrences.length, 0);
    assert.equal(preview.before.timeline.revision.sequence, revision.sequence);
    assert.deepEqual(preview.after.timeline.sequence.occurrences.filter((occurrence: any) => occurrence.track === 0).map((occurrence: any) => [
      occurrence.mediaId, rationalSeconds(occurrence.startTime), rationalSeconds(occurrence.sourceStartTime), rationalSeconds(occurrence.durationTime),
    ]), [
      [registrations.b.id, 0, 5, 8],
      [registrations.a.id, 8, 10, 12],
      [registrations.c.id, 20, 2, 10],
    ]);
    const musicOccurrence = preview.after.timeline.sequence.occurrences.find((occurrence: any) => occurrence.id === "issue-517-music");
    assert.deepEqual([musicOccurrence.mediaId, rationalSeconds(musicOccurrence.startTime), rationalSeconds(musicOccurrence.sourceStartTime), rationalSeconds(musicOccurrence.durationTime)], [registrations.music.id, 0, 0, 30]);
    assert.deepEqual(preview.after.timeline.sequence.titles?.map((title: any) => [title.text, rationalSeconds(title.startTime), rationalSeconds(title.durationTime)]), [["FrameKit MVP Test", 0, 6]]);
    assert.equal(musicOccurrence.track, 1);
    assert.equal(musicOccurrence.gainDb, -12);
    assert.equal(preview.outputIntent.sourceAudioPolicy, "preserve-and-mix");
    assert.deepEqual(preview.diff.operations, preview.command.operations);
    assert.ok(preview.fcpxml.coverage.exact.includes("editable-titles"));
    assert.ok(preview.fcpxml.coverage.exact.includes("connected-elements"));
    assert.ok(preview.fcpxml.coverage.exact.includes("gain"));
    assert.equal(preview.fcpxml.provenance.revision.id, preview.after.timeline.revision.id);
    await assert.rejects(stat(outputPath), { code: "ENOENT" });
    await assert.rejects(stat(fcpxmlPath), { code: "ENOENT" });

    const rejected = await client.callTool({ name: "headless.rough-cut.execute", arguments: {
      ...request, approved: false, planDigest: preview.planDigest,
    } });
    assert.equal(rejected.isError, true);
    const changed = await client.callTool({ name: "headless.rough-cut.execute", arguments: {
      ...request,
      operations: operations.map((operation, index) => index === 0
        ? { ...operation, occurrence: { ...operation.occurrence, gainDb: -6 } }
        : operation),
      approved: true,
      planDigest: preview.planDigest,
    } });
    assert.equal(changed.isError, true);
    assert.match(toolErrorText(changed), /HEADLESS_ROUGH_CUT_PLAN_MISMATCH/);
    const redirected = await client.callTool({ name: "headless.rough-cut.execute", arguments: {
      ...request,
      fcpxml: { ...request.fcpxml, path: join(directory, "unreviewed-output.fcpxml") },
      approved: true,
      planDigest: preview.planDigest,
    } });
    assert.equal(redirected.isError, true);
    assert.match(toolErrorText(redirected), /HEADLESS_ROUGH_CUT_PLAN_MISMATCH/);
    const unchanged = payload(await client.callTool({ name: "headless.project.inspect", arguments: { projectId } }));
    assert.equal(unchanged.timeline.revision.id, revision.id);
    assert.equal(unchanged.timeline.sequence.occurrences.length, 0);

    // Revise the title after seeing the contact sheet, then preview again.
    const originalDigest = preview.planDigest;
    const revisedRequest = { ...request, operations: operations.map((operation) => operation.type === "add-title"
      ? { ...operation, title: { ...operation.title!, text: "Revised title" } }
      : operation) };
    const revisedResult = await client.callTool({ name: "headless.rough-cut.preview", arguments: revisedRequest });
    preview = payload(revisedResult);
    const revisedImage = (revisedResult.content as Array<{ type: string; data?: string }>).find((item) => item.type === "image");
    assert.notEqual(revisedImage?.data, storyboardImage?.data);
    assert.notEqual(preview.planDigest, originalDigest);
    const stale = await client.callTool({ name: "headless.rough-cut.execute", arguments: { ...revisedRequest, approved: true, planDigest: originalDigest } });
    assert.equal(stale.isError, true);
    assert.match(toolErrorText(stale), /HEADLESS_ROUGH_CUT_PLAN_MISMATCH/);

    const executed = payload(await client.callTool({ name: "headless.rough-cut.execute", arguments: {
      ...revisedRequest, approved: true, planDigest: preview.planDigest,
    } }));
    assert.equal(executed.committed, true);
    assert.equal(executed.render.status, "passed");
    assert.equal(executed.fcpxmlArtifact.verified, true);
    const nativeReadiness = payload(await client.callTool({
      name: "editor.native.handoff.readiness",
      arguments: {},
    }));
    assert.equal(nativeReadiness.status, "blocked", "Phase B stays blocked without native handoff readiness");
    assert.ok(nativeReadiness.reasons.length > 0, "the readiness blocker is retained in the #517 acceptance evidence");
    assert.equal(nativeReadiness.createdTarget, undefined, "FCPXML UIDs are not native target identities");
    assert.equal(executed.render.outcome.render.projectRevision.id, executed.after.timeline.revision.id);
    assert.equal(executed.fcpxml.provenance.revision.id, executed.after.timeline.revision.id);
    assert.equal((await stat(outputPath)).isFile(), true);
    assert.equal((await stat(fcpxmlPath)).isFile(), true);

    const publishPreview = payload(await client.callTool({
      name: "artifact.publish.preview",
      arguments: {
        artifactPath: fcpxmlPath,
        headlessExecutionId: executed.executionId,
        targetLibraryPath: join(directory, "Approved Headless Publish.fcpbundle"),
      },
    }));
    assert.equal(publishPreview.sourceTransactionId, `headless-rough-cut:${executed.executionId}`);
    assert.equal(publishPreview.sourceProof.planDigest, preview.planDigest);
    assert.equal(publishPreview.sourceProof.renderId, executed.render.renderId);
    const renderBytes = await readFile(outputPath);
    assert.deepEqual(publishPreview.sourceProof.renderArtifact, {
      path: outputPath, digest: createHash("sha256").update(renderBytes).digest("hex"), bytes: renderBytes.length,
    });
    assert.equal(publishPreview.sourceProof.destination.projectUid, executed.fcpxml.destination.projectUid);
    assert.equal(publishPreview.sourceProof.destination.sequenceUid, executed.fcpxml.destination.sequenceUid);
    const approvedMediaDigests = Object.values(registrations)
      .map((resource: any) => ({ source: resource.source, sha256: resource.sourceDigest }))
      .sort((left: any, right: any) => left.source.localeCompare(right.source));
    assert.deepEqual(publishPreview.sourceProof.sourceMediaDigests, approvedMediaDigests);
    assert.equal("targetBinding" in publishPreview, false);
    const publishBlocked = payload(await client.callTool({
      name: "artifact.publish.execute",
      arguments: { jobId: publishPreview.jobId, confirm: true },
    }));
    assert.equal(publishBlocked.state, "awaiting-final-cut");

    const outputMetadata = await new FfmpegMediaMetadataProbe().probe(outputPath);
    assert.equal(rationalSeconds(outputMetadata.durationTime), 30);
    assert.ok(outputMetadata.streams.some((stream: any) => stream.kind === "video"));
    assert.ok(outputMetadata.streams.some((stream: any) => stream.kind === "audio"));
    assertPixelDominates(await readVideoFrame(outputPath, 2), "blue");
    assertPixelDominates(await readVideoFrame(outputPath, 10), "green");
    assertPixelDominates(await readVideoFrame(outputPath, 22), "yellow");
    assert.ok(countBrightPixels(await readVideoFrame(outputPath, 2)) > 100, "the opening title is visible during its range");
    assert.equal(countBrightPixels(await readVideoFrame(outputPath, 7)), 0, "the title ends after six seconds");
    assertAudioMix(await readAudioWindow(outputPath, 2), 550);
    assertAudioMix(await readAudioWindow(outputPath, 10), 440);
    assertAudioMix(await readAudioWindow(outputPath, 22), 660);

    const xml = await readFile(fcpxmlPath, "utf8");
    const finalCutDtd = "/Applications/Final Cut Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_11.dtd";
    if (existsSync(finalCutDtd)) {
      await execFileAsync("xmllint", ["--noout", "--dtdvalid", pathToFileURL(finalCutDtd).href, fcpxmlPath]);
    }
    assert.match(xml, /<text><text-style ref="title-style-1">Revised title<\/text-style><\/text>/);
    assert.match(xml, /<asset-clip [^>]*duration="30s"[^>]*lane="1"[^>]*audioRole="music"/);
    assert.match(xml, /<md key="com\.framekit\.id" value="issue-517-music" \/>/);
    assert.match(xml, /<adjust-volume amount="-12dB" \/>/);
    assert.equal((xml.match(/hasAudio="1"/g) ?? []).length, 4);
    assert.match(xml, /issue-517-b|source-b\.mp4/);
    assert.match(xml, /issue-517-a|source-a\.mp4/);
    assert.match(xml, /issue-517-c|source-c\.mp4/);
    const fcpxmlReadback = await new FcpxmlDocumentAdapter(fcpxmlPath).readProject();
    const sourceFor = (mediaId: string | undefined) => fcpxmlReadback.media.find((media) => media.mediaId === mediaId)?.source;
    assert.deepEqual(fcpxmlReadback.timeline.clips.map((clip) => [
      sourceFor(clip.mediaId), clip.start, clip.sourceStart, clip.duration, clip.track, clip.role,
    ]), [
      [sourcePaths.b, 0, 5, 8, 0, undefined],
      [sourcePaths.music, 0, 0, 30, 1, "music"],
      [sourcePaths.a, 8, 10, 12, 0, undefined],
      [sourcePaths.c, 20, 2, 10, 0, undefined],
    ]);
    assert.deepEqual(fcpxmlReadback.timeline.storyElements.filter((element) => element.kind === "title").map(({ text, start, duration, lane }) => [text, start, duration, lane]), [["Revised title", 0, 6, 1]]);
  } finally {
    await client?.close();
    await transport?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production stdio MCP persists and reopens the headless project and render record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headless-mcp-"));
  const here = dirname(fileURLToPath(import.meta.url));
  const environment: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_AUTO_CONNECT: "0",
    FRAMEKIT_FINAL_CUT_HEADLESS: "1",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0",
    FRAMEKIT_FINAL_CUT_SOCKET: join(directory, "missing-final-cut.sock"),
    FRAMEKIT_FCPXML_PATH: join(directory, "missing-project.fcpxml"),
    FRAMEKIT_STATE_DIR: join(directory, "state"),
  };
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    await execFileAsync(process.execPath, ["scripts/generate-headless-render-fixtures.mjs", directory], { cwd: process.cwd(), env: process.env });
    ({ client, transport } = await connectProductionClient(here, environment));

    const listedTools = await client.listTools();
    assert.ok(listedTools.tools.some((tool) => tool.name === "headless.project.create"));
    assert.ok(listedTools.tools.some((tool) => tool.name === "headless.render.inspect"));
    assert.match(client.getInstructions() ?? "", /headless Framekit-owned project/i);

    const supportedRoute = payload(await client.callTool({ name: "editing.route", arguments: {
      operation: "timeline.edit",
      editType: "rename-occurrence",
    } }));
    assert.equal(supportedRoute.status, "headless-selected");
    assert.equal(supportedRoute.selectedPath, "headless");
    assert.deepEqual(supportedRoute.requiredCapabilities, ["headless.timeline.edit.rename-occurrence"]);

    for (const editType of ["reduce-noise", "set-color-correction", "ripple-delete"]) {
      const unsupportedRoute = payload(await client.callTool({ name: "editing.route", arguments: {
        operation: "timeline.edit",
        editType,
      } }));
      assert.equal(unsupportedRoute.status, "unavailable");
      assert.equal(unsupportedRoute.selectedPath, "none");
      assert.equal(unsupportedRoute.reason.code, "HEADLESS_UNAVAILABLE");
      assert.equal(unsupportedRoute.reason.unavailable.capability, `headless.timeline.edit.${editType}`);
    }

    const created = payload(await client.callTool({ name: "headless.project.create", arguments: { timeline: emptyTimeline() } }));
    assert.equal(created.timeline.project.id, "mcp-headless-project");
    const listed = payload(await client.callTool({ name: "headless.project.list", arguments: {} }));
    assert.equal(listed[0].projectId, "mcp-headless-project");

    const red = payload(await client.callTool({ name: "headless.media.register", arguments: {
      projectId: "mcp-headless-project",
      sourcePath: join(directory, "fixture-red-440hz.mp4"),
      expectedRevision: created.timeline.revision,
    } }));
    const blue = payload(await client.callTool({ name: "headless.media.register", arguments: {
      projectId: "mcp-headless-project",
      sourcePath: join(directory, "fixture-blue-880hz.mp4"),
      expectedRevision: red.project.timeline.revision,
    } }));
    const redResource = red.resource;
    const blueResource = blue.resource;
    const firstPreview = payload(await client.callTool({ name: "headless.edit.preview", arguments: {
      projectId: "mcp-headless-project",
      sequenceId: "mcp-headless-sequence",
      expectedRevision: blue.project.timeline.revision,
      operations: [{ type: "insert-occurrence", placement: "append", occurrence: occurrence("occurrence-red", redResource.id) }],
    } }));
    assert.equal(firstPreview.before.timeline.sequence.occurrences.length, 0);
    const first = payload(await client.callTool({ name: "headless.edit.execute", arguments: {
      projectId: "mcp-headless-project",
      sequenceId: "mcp-headless-sequence",
      expectedRevision: blue.project.timeline.revision,
      operations: [{ type: "insert-occurrence", placement: "append", occurrence: occurrence("occurrence-red", redResource.id) }],
    } }));
    const second = payload(await client.callTool({ name: "headless.edit.execute", arguments: {
      projectId: "mcp-headless-project",
      sequenceId: "mcp-headless-sequence",
      expectedRevision: first.after.timeline.revision,
      operations: [{ type: "insert-occurrence", placement: "append", occurrence: { ...occurrence("occurrence-blue", blueResource.id), sourceStartTime: { value: "1", timescale: "4" } } }],
    } }));
    const selectedFont = new FfmpegTimelineRenderer({ env: environment }).inspectTitleFont(["OPEN"]);
    assert.ok(selectedFont);
    const finished = payload(await client.callTool({ name: "headless.edit.execute", arguments: {
      projectId: "mcp-headless-project",
      sequenceId: "mcp-headless-sequence",
      expectedRevision: second.after.timeline.revision,
      operations: [
        { type: "set-gain", occurrenceId: "occurrence-red", gainDb: 6 },
        { type: "set-transform", occurrenceId: "occurrence-red", transform: { scaleX: 1.25, scaleY: 1.25 } },
        { type: "add-title", title: { id: "title-opening", text: "OPEN", startTime: { value: "0", timescale: "1" }, durationTime: { value: "1", timescale: "2" }, lane: 1, font: selectedFont } },
        { type: "add-transition", transition: { id: "transition-red-blue", kind: "cross-dissolve", beforeOccurrenceId: "occurrence-red", afterOccurrenceId: "occurrence-blue", durationTime: { value: "1", timescale: "4" } } },
      ],
    } }));
    const render = payload(await client.callTool({ name: "headless.render", arguments: {
      projectId: "mcp-headless-project",
      sequenceId: "mcp-headless-sequence",
      expectedRevision: finished.after.timeline.revision,
      parameters: { outputPath: join(directory, "mcp-final.mp4"), format: "mp4", width: 320, height: 180, frameRate: { value: "30", timescale: "1" } },
    } }));
    assert.equal(render.status, "passed");
    assert.equal(render.outcome.verification.status, "passed");
    for (const [outputPath, code] of [[join(directory, "mcp-final.mp4"), "HEADLESS_RENDER_OUTPUT_EXISTS"], [join(directory, "missing", "output.mp4"), "HEADLESS_RENDER_OUTPUT_INVALID"]]) {
      const failed = await client.callTool({ name: "headless.render", arguments: {
        projectId: "mcp-headless-project", sequenceId: "mcp-headless-sequence", expectedRevision: finished.after.timeline.revision,
        parameters: { outputPath, format: "mp4", width: 320, height: 180, frameRate: { value: "30", timescale: "1" } },
      } });
      assert.equal(failed.isError, true);
      const record = JSON.parse(toolErrorText(failed));
      assert.equal(record.outcome.error.code, code);
      const inspectedFailure = payload(await client.callTool({ name: "headless.render.inspect", arguments: { renderId: record.renderId } }));
      assert.equal(inspectedFailure.status, "failed");
      assert.equal(inspectedFailure.outcome.error.code, code);
    }
    const inspected = payload(await client.callTool({ name: "headless.render.inspect", arguments: { renderId: render.renderId } }));
    assert.equal(inspected.status, "passed");
    assert.equal(inspected.outcome.render.projectRevision.id, finished.after.timeline.revision.id);
    await client.close();
    await transport.close();
    client = undefined;
    transport = undefined;

    ({ client, transport } = await connectProductionClient(here, environment));
    const reopened = payload(await client.callTool({ name: "headless.project.open", arguments: { projectId: "mcp-headless-project" } }));
    assert.equal(reopened.timeline.revision.id, finished.after.timeline.revision.id);
    const reopenedRender = payload(await client.callTool({ name: "headless.render.inspect", arguments: { renderId: render.renderId } }));
    assert.equal(reopenedRender.status, "passed");
    assert.equal(reopenedRender.outcome.render.projectRevision.id, finished.after.timeline.revision.id);
  } finally {
    await client?.close();
    await transport?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("headless project open fails closed when local media has no metadata probe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headless-no-probe-"));
  try {
    const withProbe = new HeadlessProjectService({ directory, mediaProbe: new FfmpegMediaMetadataProbe() });
    const created = await withProbe.create({
      ...emptyTimeline(),
      resources: [{
        id: "local-media-1",
        name: "source.mp4",
        mediaKind: "video",
        source: "/tmp/source.mp4",
        sourceKind: "local-file",
        sourceDigest: "a".repeat(64),
      }],
    });
    const withoutProbe = new HeadlessProjectService({ directory });
    await assert.rejects(withoutProbe.open(created.timeline.project.id), (error: unknown) => (
      error instanceof Error
      && error.message.startsWith("HEADLESS_MEDIA_PROBE_UNAVAILABLE:")
    ));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("headless rough-cut preview and execution preserve provenance and produce verified artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headless-rough-cut-"));
  try {
    await execFileAsync(process.execPath, ["scripts/generate-headless-render-fixtures.mjs", directory], { cwd: process.cwd(), env: process.env });
    const service = new HeadlessProjectService({
      directory: join(directory, "projects"),
      mediaProbe: new FfmpegMediaMetadataProbe(),
      renderer: new FfmpegTimelineRenderer(),
      verifier: new FfmpegRenderVerifier(),
      clock: () => "2026-10-05T00:00:00.000Z",
    });
    const created = await service.create(emptyTimeline());
    const registered = await service.registerMedia(created.timeline.project.id, join(directory, "fixture-red-440hz.mp4"), created.timeline.revision);
    const source = registered.resource;
    const plan = {
      planner: { id: "framekit.rough-cut", version: 1 },
      revision: registered.project.timeline.revision,
      query: { query: "speech" },
      shots: [{
        order: 1,
        sourceIdentity: {
          mediaId: source.id,
          source: source.source!,
          sourceDigest: source.sourceDigest!,
          mediaKind: "video" as const,
          duration: 2,
        },
        range: { start: 0.25, end: 1.25 },
        confidence: 0.91,
        matchedProperties: ["query:speech"],
        rationale: "contains the approved speech highlight",
      }],
      warnings: [],
    };
    const request = {
      projectId: created.timeline.project.id,
      sequenceId: created.timeline.sequence.id,
      plan,
      render: {
        outputPath: join(directory, "rough-cut.mp4"),
        format: "mp4" as const,
        width: 320,
        height: 180,
        frameRate: { value: "30", timescale: "1" },
      },
      fcpxml: {
        path: join(directory, "rough-cut.fcpxml"),
        target: {
          provider: "final-cut" as const,
          libraryUid: "library-v017",
          eventUid: "event-v017",
          projectUid: "project-v017",
          sequenceUid: "sequence-v017",
        },
      },
    };
    // A render-only preview must not require invented Final Cut identifiers.
    const { fcpxml: omittedTarget, ...renderOnly } = request;
    const withoutExport = await service.previewRoughCut(renderOnly as any);
    assert.deepEqual(withoutExport.fcpxml, { status: "not-requested" });
    assert.equal(withoutExport.outputIntent.render.outputPath, request.render.outputPath);
    const withExport = await service.previewRoughCut(request);
    await assert.rejects(service.executeRoughCut({ ...renderOnly, approved: true, planDigest: withExport.planDigest } as any), /PLAN_MISMATCH/);
    await assert.rejects(service.executeRoughCut({ ...request, approved: true, planDigest: withoutExport.planDigest }), /PLAN_MISMATCH/);
    const reservation = join(directory, "projects", "canonical-recovery", "pending.json");
    await mkdir(dirname(reservation), { recursive: true });
    const reservationBytes = "synthetic retained reservation";
    await writeFile(reservation, reservationBytes);
    const reservationHardlink = join(directory, "reservation-hardlink.json");
    const reservationSymlink = join(directory, "reservation-symlink.json");
    await link(reservation, reservationHardlink);
    await symlink(reservation, reservationSymlink);
    // Static aliases beneath protected state are part of the protected subtree.
    const relocatedState = join(directory, "relocated-state");
    await mkdir(relocatedState, { recursive: true });
    const relocatedReservation = join(relocatedState, "pending.mp4");
    await writeFile(relocatedReservation, "synthetic reservation via directory link");
    const stateLink = join(directory, "projects", "relocated");
    await symlink(relocatedState, stateLink);
    await symlink(join(directory, "projects"), join(relocatedState, "cycle"));
    for (const path of [relocatedReservation, join(stateLink, "pending.mp4"), join(stateLink, "future.fcpxml")]) {
      await assert.rejects(service.previewRoughCut({ ...request, render: { ...request.render, outputPath: path, overwrite: true } }), /OUTPUT.*COLLISION/);
      await assert.rejects(service.render(created.timeline.project.id, created.timeline.sequence.id, { ...request.render, outputPath: path, overwrite: true }, registered.project.timeline.revision), /OUTPUT.*COLLISION/);
    }
    assert.equal(await readFile(relocatedReservation, "utf8"), "synthetic reservation via directory link");
    const unreadableLink = join(directory, "projects", "unresolved-state-link");
    await symlink(join(directory, "missing-state-target"), unreadableLink);
    await assert.rejects(service.previewRoughCut(request), /ENOENT/);
    await unlink(unreadableLink);

    const otherSource = join(directory, "other-project-source.mp4");
    await generateSegmentedSource(otherSource, [{ color: "blue", duration: 2 }], 440);
    const otherTimeline = emptyTimeline();
    otherTimeline.project.id = "other-project";
    const other = await service.create(otherTimeline);
    await service.registerMedia(other.timeline.project.id, otherSource, other.timeline.revision);
    // A valid project record may itself be a static symlink in the store.
    const otherProjectPath = join(directory, "projects", `${other.timeline.project.id}.json`);
    const relocatedProject = join(directory, "other-project-record.json");
    await rename(otherProjectPath, relocatedProject);
    await symlink(relocatedProject, otherProjectPath);
    const otherSourceLink = join(directory, "other-project-source-link.mp4");
    await link(otherSource, otherSourceLink);
    for (const path of [otherSource, otherSourceLink]) {
      await assert.rejects(service.previewRoughCut({ ...request, render: { ...request.render, outputPath: path, overwrite: true } }), /OUTPUT.*COLLISION/);
      await assert.rejects(service.render(created.timeline.project.id, created.timeline.sequence.id, { ...request.render, outputPath: path, overwrite: true }, registered.project.timeline.revision), /OUTPUT.*COLLISION/);
    }
    const protectedOutputs = [reservation, reservationHardlink, reservationSymlink, join(dirname(reservation), "new-artifact.fcpxml")];
    for (const path of protectedOutputs) {
      await assert.rejects(service.previewRoughCut({ ...request, fcpxml: { ...request.fcpxml, path, overwrite: true } }), /OUTPUT.*COLLISION/);
      await assert.rejects(service.exportFcpxml(created.timeline.project.id, created.timeline.sequence.id, registered.project.timeline.revision, path, request.fcpxml.target), /OUTPUT.*COLLISION/);
      await assert.rejects(service.render(created.timeline.project.id, created.timeline.sequence.id, { ...request.render, outputPath: path, overwrite: true }, registered.project.timeline.revision), /OUTPUT.*COLLISION/);
    }
    assert.equal(await readFile(reservation, "utf8"), reservationBytes);
    const hardlink = join(directory, "source-hardlink.mp4");
    const sourceAlias = join(directory, "source-symlink.mp4");
    await link(source.source!, hardlink);
    await symlink(source.source!, sourceAlias);
    for (const path of [source.source!, hardlink, sourceAlias, join(directory, "projects", `${created.timeline.project.id}.json`), request.render.outputPath]) {
      await assert.rejects(service.previewRoughCut({ ...request, fcpxml: { ...request.fcpxml, path, overwrite: true } }), /OUTPUT.*COLLISION/);
    }
    await assert.rejects(service.previewRoughCut({ ...request, render: { ...request.render, outputPath: source.source!, overwrite: true } }), /OUTPUT.*COLLISION/);
    const preview = await service.previewRoughCut(request);
    const collisionId = `${preview.planDigest}.approval`;
    const collisionPath = join(directory, "projects", `${collisionId}.json`);
    await rm(collisionPath);
    const collisionTimeline = emptyTimeline();
    collisionTimeline.project.id = collisionId;
    const collision = await service.create(collisionTimeline);
    await assert.rejects(service.previewRoughCut(request), /COLLISION|EXISTS/i);
    assert.deepEqual(await service.open(collisionId), collision);
    await rm(collisionPath);
    assert.equal((await service.previewRoughCut(request)).planDigest, preview.planDigest);
    assert.equal((await service.previewRoughCut(request)).planDigest, preview.planDigest);
    assert.equal(preview.before.timeline.sequence.occurrences.length, 0);
    assert.deepEqual(preview.after.timeline.sequence.occurrences[0]?.sourceStartTime, { value: "4", timescale: "15" });
    assert.equal(preview.after.timeline.sequence.occurrences[0]?.durationTime.value, "1");
    assert.deepEqual(preview.provenance[0]?.sourceRange.startTime, { value: "4", timescale: "15" });
    assert.deepEqual(preview.provenance[0]?.sourceRange.durationTime, { value: "1", timescale: "1" });
    assert.equal(preview.provenance[0]?.rationale, "contains the approved speech highlight");
    assert.equal(preview.outputIntent.fcpxml.target.projectUid, "project-v017");
    await assert.rejects(
      service.executeRoughCut({ ...request, approved: false, planDigest: preview.planDigest }),
      /HEADLESS_ROUGH_CUT_APPROVAL_REQUIRED:/,
    );
    await assert.rejects(
      service.executeRoughCut({ ...request, approved: true, planDigest: "0".repeat(64) }),
      /HEADLESS_ROUGH_CUT_PLAN_MISMATCH:/,
    );
    await assert.rejects(
      service.previewRoughCut({ ...request, plan: { ...plan, revision: { ...plan.revision, sequence: plan.revision.sequence + 1 } } }),
      /HEADLESS_ROUGH_CUT_STALE_REVISION:/,
    );
    await assert.rejects(
      service.previewRoughCut({ ...request, plan: { ...plan, shots: [{ ...plan.shots[0]!, sourceIdentity: { ...plan.shots[0]!.sourceIdentity, sourceDigest: "f".repeat(64) } }] } }),
      /HEADLESS_ROUGH_CUT_SOURCE_MISMATCH:/,
    );

    await rm(collisionPath);
    for (const code of ["HEADLESS_STORYBOARD_SOURCE_CHANGED", "UNEXPECTED_RENDER_FAILURE"]) {
      const failing = new HeadlessProjectService({ directory: join(directory, "projects"), mediaProbe: new FfmpegMediaMetadataProbe(), storyboard: { render: async () => { throw new Error(`${code}: failure`); } } });
      await assert.rejects(failing.previewRoughCut(request, undefined, true), new RegExp(code));
      await assert.rejects(readFile(collisionPath), /ENOENT/);
    }
    const fallback = new HeadlessProjectService({ directory: join(directory, "projects"), mediaProbe: new FfmpegMediaMetadataProbe(), clock: () => "2026-10-05T00:00:00.000Z", storyboard: { render: async () => { throw new Error("HEADLESS_STORYBOARD_UNSUPPORTED: composition"); } } });
    const fallbackPreview = await fallback.previewRoughCut(request, undefined, true);
    assert.equal(fallbackPreview.planDigest, preview.planDigest);
    assert.match(fallbackPreview.storyboardUnavailable!, /HEADLESS_STORYBOARD_UNSUPPORTED/);
    assert.equal(fallbackPreview.storyboard, undefined);

    const resumedAfterPreview = new HeadlessProjectService({
      directory: join(directory, "projects"),
      mediaProbe: new FfmpegMediaMetadataProbe(),
      renderer: new FfmpegTimelineRenderer(),
      verifier: new FfmpegRenderVerifier(),
    });
    const executed = await resumedAfterPreview.executeRoughCut({ ...request, approved: true, planDigest: fallbackPreview.planDigest });
    assert.equal(executed.committed, true);
    assert.equal(executed.render.status, "passed");
    assert.equal(executed.fcpxmlArtifact.verified, true);
    assert.deepEqual(executed.after.timeline.revision, executed.transaction.after.timeline.revision);
    assert.deepEqual((executed.render.outcome as any).render.projectRevision, executed.transaction.after.timeline.revision);
    assert.deepEqual(executed.fcpxml.provenance.revision, executed.transaction.after.timeline.revision);
    assert.equal(typeof (executed as any).executionId, "string");
    assert.equal(typeof (resumedAfterPreview as any).verifyPublishableRoughCut, "function");
    const executionId = (executed as any).executionId as string;
    const proof = await resumedAfterPreview.verifyPublishableRoughCut(executionId, request.fcpxml.path);
    // A legacy execution can refer to a project that predates connected-audio
    // stream-bound checks. Publication must not issue proof for that state.
    const legacyProofProject = await resumedAfterPreview.open(created.timeline.project.id);
    const legacyResource = structuredClone(legacyProofProject.timeline.resources[0]!);
    legacyResource.id = "legacy-unverified-audio";
    legacyResource.mediaKind = "audio";
    legacyResource.metadata = { durationTime: { value: "2", timescale: "1" }, streams: [{ kind: "audio", sampleRate: 48000, channels: 1 }] };
    legacyProofProject.timeline.resources.push(legacyResource);
    legacyProofProject.timeline.sequence.occurrences.push({ id: "legacy-music", name: "Legacy", mediaId: legacyResource.id,
      startTime: { value: "0", timescale: "1" }, sourceStartTime: { value: "0", timescale: "1" }, durationTime: { value: "1", timescale: "1" }, track: 1, role: "music" });
    const originalOpen = resumedAfterPreview.open;
    resumedAfterPreview.open = async () => structuredClone(legacyProofProject);
    try {
      await assert.rejects(resumedAfterPreview.verifyPublishableRoughCut(executionId, request.fcpxml.path), /audio stream bounds/);
      // Plausible but fabricated bounds must not turn an unobserved source into proof.
      legacyResource.metadata!.streams[0]!.sourceRange = { start: { value: "0", timescale: "1" }, duration: { value: "2", timescale: "1" } };
      await assert.rejects(resumedAfterPreview.verifyPublishableRoughCut(executionId, request.fcpxml.path), /MEDIA_METADATA_CHANGED/);
    } finally {
      resumedAfterPreview.open = originalOpen;
    }
    assert.equal(proof.sourceRevision.id, plan.revision.id);
    assert.equal(proof.canonicalRevision.id, executed.after.timeline.revision.id);
    assert.equal(proof.planDigest, preview.planDigest);
    assert.deepEqual(proof.renderer, (executed.render.outcome as any).plan.renderer);
    assert.equal(proof.destination.projectUid, executed.fcpxml.destination.projectUid);
    assert.equal(proof.destination.sequenceUid, executed.fcpxml.destination.sequenceUid);
    assert.deepEqual(proof.sourceMediaDigests, [{ source: source.source, sha256: source.sourceDigest }]);
    const renderedBytes = await readFile(request.render.outputPath);
    assert.deepEqual(proof.renderArtifact, {
      path: request.render.outputPath,
      digest: createHash("sha256").update(renderedBytes).digest("hex"),
      bytes: renderedBytes.length,
    });
    assert.equal("targetBinding" in proof, false);
    const restarted = new HeadlessProjectService({
      directory: join(directory, "projects"),
      mediaProbe: new FfmpegMediaMetadataProbe(),
      renderer: new FfmpegTimelineRenderer(),
      verifier: new FfmpegRenderVerifier(),
    });
    assert.deepEqual(await (restarted as any).verifyPublishableRoughCut(executionId, request.fcpxml.path), proof);
    // A render record is separate from the approved execution record. Even a
    // self-consistent digest must not authorize a different no-title render.
    const renderRecordPath = join(directory, "projects", `${executed.render.renderId}.json`);
    const originalRenderRecord = await readFile(renderRecordPath, "utf8");
    const stableRender = (value: any): string => value === null || typeof value !== "object" ? JSON.stringify(value)
      : Array.isArray(value) ? `[${value.map(stableRender).join(",")}]`
      : `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableRender(child)}`).join(",")}}`;
    for (const mutation of ["title", "target", "revision", "parameters", "output", "missing-verification", "artifact-digest", "artifact-path", "renderer", "renderer-all", "contract-version", "verification-required", "failed-check", "empty-checks"] as const) {
      const saved = JSON.parse(originalRenderRecord);
      if (mutation === "title") saved.outcome.plan.timeline.sequence.titles = [{ id: "injected", text: "not approved", startTime: { value: "0", timescale: "1" }, durationTime: { value: "1", timescale: "2" }, lane: 1 }];
      if (mutation === "target") saved.outcome.plan.target.sequenceId = "other-sequence";
      if (mutation === "revision") saved.outcome.plan.projectRevision.sequence++;
      if (mutation === "parameters") saved.outcome.plan.parameters.width++;
      if (mutation === "output") saved.outcome.render.output.path = join(directory, "other.mp4");
      if (mutation === "missing-verification") delete saved.outcome.verification;
      if (mutation === "artifact-digest") saved.outcome.verification.artifact.fileDigest = "f".repeat(64);
      if (mutation === "artifact-path") delete saved.outcome.verification.artifact.path;
      if (mutation === "renderer") saved.outcome.render.renderer.id = "other-renderer";
      if (mutation === "renderer-all") {
        saved.outcome.plan.renderer.id = "other-renderer";
        saved.outcome.plan.capabilities.renderer.id = "other-renderer";
        saved.outcome.render.renderer.id = "other-renderer";
      }
      if (mutation === "contract-version") saved.outcome.render.contractVersion++;
      if (mutation === "verification-required") saved.outcome.render.verificationRequired = false;
      if (mutation === "failed-check") saved.outcome.verification.checks[0].passed = false;
      if (mutation === "empty-checks") saved.outcome.verification.checks = [];
      const { planDigest: _oldDigest, ...planBase } = saved.outcome.plan;
      saved.outcome.plan.planDigest = createHash("sha256").update(stableRender(planBase)).digest("hex");
      saved.outcome.render.planDigest = saved.outcome.plan.planDigest;
      await writeFile(renderRecordPath, JSON.stringify(saved));
      await assert.rejects(restarted.verifyPublishableRoughCut(executionId, request.fcpxml.path), /HEADLESS_ROUGH_CUT_RENDER_EVIDENCE_MISMATCH/, mutation);
    }
    await writeFile(renderRecordPath, originalRenderRecord);
    assert.deepEqual(await restarted.verifyPublishableRoughCut(executionId, request.fcpxml.path), proof);
    const originalRender = await readFile(request.render.outputPath);
    const alteredRender = Buffer.from(originalRender);
    alteredRender[Math.floor(alteredRender.length / 2)]! ^= 1;
    await writeFile(request.render.outputPath, alteredRender);
    await assert.rejects(
      (restarted as any).verifyPublishableRoughCut(executionId, request.fcpxml.path),
      /HEADLESS_ROUGH_CUT_RENDER_CHANGED:/,
    );
    await rm(request.render.outputPath);
    await assert.rejects(
      (restarted as any).verifyPublishableRoughCut(executionId, request.fcpxml.path),
      /HEADLESS_ROUGH_CUT_RENDER_CHANGED:/,
    );
    await writeFile(request.render.outputPath, originalRender);
    assert.deepEqual(await (restarted as any).verifyPublishableRoughCut(executionId, request.fcpxml.path), proof);
    const relocatedRender = `${request.render.outputPath}.saved`;
    await rename(request.render.outputPath, relocatedRender);
    await symlink(relocatedRender, request.render.outputPath);
    await assert.rejects(
      (restarted as any).verifyPublishableRoughCut(executionId, request.fcpxml.path),
      /HEADLESS_ROUGH_CUT_RENDER_CHANGED:/,
    );
    await unlink(request.render.outputPath);
    await rename(relocatedRender, request.render.outputPath);
    assert.deepEqual(await (restarted as any).verifyPublishableRoughCut(executionId, request.fcpxml.path), proof);
    if (process.platform !== "win32") {
      await rename(request.render.outputPath, relocatedRender);
      await execFileAsync("mkfifo", [request.render.outputPath]);
      const result = (restarted as any).verifyPublishableRoughCut(executionId, request.fcpxml.path)
        .then(() => "unexpected success", (error: Error) => error.message);
      let timer: NodeJS.Timeout | undefined;
      const observed = await Promise.race([result, new Promise<string>((resolve) => { timer = setTimeout(() => resolve("timed out"), 2000); })]);
      if (timer) clearTimeout(timer);
      if (observed === "timed out") {
        // Unblock a defective reader so the test can fail and clean up.
        const fifo = await open(request.render.outputPath, constants.O_RDWR | constants.O_NONBLOCK);
        await fifo.close();
        await result;
      }
      await unlink(request.render.outputPath);
      await rename(relocatedRender, request.render.outputPath);
      assert.match(observed, /HEADLESS_ROUGH_CUT_RENDER_CHANGED:/);
    }
    const originalSource = await readFile(source.source!);
    const alteredSource = Buffer.from(originalSource);
    alteredSource[Math.floor(alteredSource.length / 2)]! ^= 1;
    await writeFile(source.source!, alteredSource);
    await assert.rejects(
      (restarted as any).verifyPublishableRoughCut(executionId, request.fcpxml.path),
      /MEDIA_CHANGED:/,
    );
    await rm(source.source!);
    await assert.rejects(
      (restarted as any).verifyPublishableRoughCut(executionId, request.fcpxml.path),
      /MEDIA_MISSING:/,
    );
    await writeFile(source.source!, originalSource);
    assert.deepEqual(await (restarted as any).verifyPublishableRoughCut(executionId, request.fcpxml.path), proof);
    // Records predating either binding have valid checksums but cannot authorize publication.
    const executionPath = join(directory, "projects", `${executionId}.json`);
    const currentExecution = await readFile(executionPath, "utf8");
    const stable = (value: any): string => value === null || typeof value !== "object" ? JSON.stringify(value)
      : Array.isArray(value) ? `[${value.map(stable).join(",")}]`
      : `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
    for (const missing of ["renderArtifact", "renderer"]) {
      const legacy = JSON.parse(currentExecution);
      delete legacy[missing];
      delete legacy.evidenceDigest;
      legacy.evidenceDigest = createHash("sha256").update(stable(legacy)).digest("hex");
      await writeFile(executionPath, JSON.stringify(legacy));
      await assert.rejects(
        (restarted as any).verifyPublishableRoughCut(executionId, request.fcpxml.path),
        /HEADLESS_ROUGH_CUT_RENDER_EVIDENCE_MISMATCH:/,
        missing,
      );
    }
    await writeFile(executionPath, currentExecution);
    assert.deepEqual(await (restarted as any).verifyPublishableRoughCut(executionId, request.fcpxml.path), proof);
    const savedXml = `${request.fcpxml.path}.saved`;
    await rename(request.fcpxml.path, savedXml);
    await symlink(savedXml, request.fcpxml.path);
    await assert.rejects(
      (restarted as any).verifyPublishableRoughCut(executionId, request.fcpxml.path),
      /HEADLESS_ROUGH_CUT_ARTIFACT_CHANGED:/,
    );
    await unlink(request.fcpxml.path);
    await rename(savedXml, request.fcpxml.path);
    assert.deepEqual(await (restarted as any).verifyPublishableRoughCut(executionId, request.fcpxml.path), proof);
    if (process.platform !== "win32") {
      await rename(request.fcpxml.path, savedXml);
      await execFileAsync("mkfifo", [request.fcpxml.path]);
      const result = (restarted as any).verifyPublishableRoughCut(executionId, request.fcpxml.path)
        .then(() => "unexpected success", (error: Error) => error.message);
      let timer: NodeJS.Timeout | undefined;
      const observed = await Promise.race([result, new Promise<string>((resolve) => { timer = setTimeout(() => resolve("timed out"), 2000); })]);
      if (timer) clearTimeout(timer);
      if (observed === "timed out") {
        const fifo = await open(request.fcpxml.path, constants.O_RDWR | constants.O_NONBLOCK);
        await fifo.close();
        await result;
      }
      await unlink(request.fcpxml.path);
      await rename(savedXml, request.fcpxml.path);
      assert.match(observed, /HEADLESS_ROUGH_CUT_ARTIFACT_CHANGED:/);
    }
    const originalXml = await readFile(request.fcpxml.path);
    const alteredXml = Buffer.from(originalXml);
    alteredXml[Math.floor(alteredXml.length / 2)]! ^= 1;
    await writeFile(request.fcpxml.path, alteredXml);
    await assert.rejects(
      (restarted as any).verifyPublishableRoughCut(executionId, request.fcpxml.path),
      /HEADLESS_ROUGH_CUT_ARTIFACT_CHANGED:/,
    );
    await writeFile(request.fcpxml.path, originalXml);
    const inspectRender = restarted.inspectRender.bind(restarted);
    (restarted as any).inspectRender = async (id: string) => {
      const inspected = await inspectRender(id);
      await writeFile(request.fcpxml.path, alteredXml);
      return inspected;
    };
    await assert.rejects(
      (restarted as any).verifyPublishableRoughCut(executionId, request.fcpxml.path),
      /HEADLESS_ROUGH_CUT_ARTIFACT_CHANGED:/,
    );
    (restarted as any).inspectRender = inspectRender;
    await writeFile(request.fcpxml.path, originalXml);
    await writeFile(request.fcpxml.path, "tampered FCPXML");
    await assert.rejects(
      (restarted as any).verifyPublishableRoughCut(executionId, request.fcpxml.path),
      /HEADLESS_ROUGH_CUT_ARTIFACT_CHANGED:/,
    );
    assert.equal(await readFile(request.fcpxml.path, "utf8"), "tampered FCPXML");
    const secondRequest = {
      ...request,
      plan: { ...plan, revision: executed.after.timeline.revision },
      render: { ...request.render, outputPath: join(directory, "second.mp4") },
      fcpxml: { ...request.fcpxml, path: join(directory, "second.fcpxml") },
    };
    const secondPreview = await resumedAfterPreview.previewRoughCut(secondRequest);
    assert.equal(secondPreview.after.timeline.sequence.occurrences.length, 2);
    assert.notEqual(secondPreview.provenance[0]?.occurrenceId, preview.provenance[0]?.occurrenceId);
    const secondExecuted = await resumedAfterPreview.executeRoughCut({ ...secondRequest, approved: true, planDigest: secondPreview.planDigest });
    assert.equal(secondExecuted.committed, true);
    assert.equal(secondExecuted.render.status, "passed");
    assert.equal(secondExecuted.fcpxmlArtifact.verified, true);
    assert.equal((await service.open(created.timeline.project.id)).timeline.revision.sequence, registered.project.timeline.revision.sequence + 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rough-cut history failure reports the committed revision without execution proof", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-rough-cut-history-failure-"));
  try {
    await execFileAsync(process.execPath, ["scripts/generate-headless-render-fixtures.mjs", directory], { cwd: process.cwd(), env: process.env });
    const projects = join(directory, "projects");
    const service = new HeadlessProjectService({ directory: projects, mediaProbe: new FfmpegMediaMetadataProbe(), renderer: new FfmpegTimelineRenderer(), verifier: new FfmpegRenderVerifier() });
    const created = await service.create(emptyTimeline());
    const registered = await service.registerMedia(created.timeline.project.id, join(directory, "fixture-red-440hz.mp4"), created.timeline.revision);
    const source = registered.resource;
    const request = {
      projectId: created.timeline.project.id, sequenceId: created.timeline.sequence.id,
      plan: { planner: { id: "framekit.rough-cut", version: 1 }, revision: registered.project.timeline.revision, query: { query: "speech" }, shots: [{ order: 1, sourceIdentity: { mediaId: source.id, source: source.source!, sourceDigest: source.sourceDigest!, mediaKind: "video" as const, duration: 2 }, range: { start: 0.25, end: 1.25 }, confidence: 0.9, matchedProperties: ["query:speech"], rationale: "selected" }], warnings: [] },
      render: { outputPath: join(directory, "rough-cut.mp4"), format: "mp4" as const, width: 320, height: 180, frameRate: { value: "30", timescale: "1" } },
      fcpxml: { path: join(directory, "rough-cut.fcpxml"), target: { provider: "final-cut" as const, libraryUid: "library", eventUid: "event", projectUid: "project", sequenceUid: "sequence" } },
    };
    const preview = await service.previewRoughCut(request);
    (service as any).saveRoughCutExecution = async () => { throw new Error("injected history failure"); };
    let message = "";
    await assert.rejects(service.executeRoughCut({ ...request, approved: true, planDigest: preview.planDigest }), (error: unknown) => {
      message = String(error);
      return /HEADLESS_ROUGH_CUT_HISTORY_UNCONFIRMED/.test(message);
    });
    assert.match(message, /reinspect.*before retry/i);
    assert.match(message, /no execution.*publish proof/i);
    const details = JSON.parse(message.slice(message.indexOf("{")));
    assert.equal(details.projectId, request.projectId);
    assert.equal(details.sequenceId, request.sequenceId);
    assert.match(details.executionId, /^rough-cut-/);
    const reopened = await new HeadlessProjectService({ directory: projects, mediaProbe: new FfmpegMediaMetadataProbe() }).open(request.projectId);
    assert.deepEqual(details.committedRevision, reopened.timeline.revision);
    assert.equal(reopened.timeline.revision.sequence, registered.project.timeline.revision.sequence + 1);
    await assert.rejects(service.verifyPublishableRoughCut(details.executionId, request.fcpxml.path), /HEADLESS_ROUGH_CUT_EXECUTION_NOT_FOUND/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("render and rough-cut execution history cannot replace projects with matching IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-history-collision-"));
  try {
    const service = new HeadlessProjectService({ directory });
    const cases = [
      { id: "render-00000000-0000-4000-8000-000000000001", method: "saveRender", field: "renderId" },
      { id: "rough-cut-00000000-0000-4000-8000-000000000002", method: "saveRoughCutExecution", field: "executionId" },
    ];
    for (const { id, method, field } of cases) {
      const timeline = emptyTimeline();
      timeline.project.id = id;
      const original = await service.create(timeline);
      await assert.rejects((service as any)[method]({ [field]: id }), /COLLISION|EXISTS/i);
      assert.deepEqual(await service.open(id), original);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("storyboard rejects stale media and cleans up after cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-storyboard-test-"));
  try {
    const source = join(directory, "source.mp4");
    await generateVideoAtFrameRate(source, 30, 2);
    const sourceDigest = createHash("sha256").update(await readFile(source)).digest("hex");
    const timeline = emptyTimeline();
    timeline.sequence.durationTime = { value: "1", timescale: "1" };
    timeline.sequence.occurrences = [occurrence("shot", "media")];
    timeline.resources = [{ id: "media", name: "source", mediaKind: "video", source, sourceKind: "local-file", sourceDigest }];
    const renderer = new FfmpegStoryboardRenderer({ temporaryDirectory: directory });
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    await assert.rejects(renderer.render(timeline, { width: 320, height: 180 }, alreadyCancelled.signal), /abort/i);
    const result = await renderer.render(timeline, { width: 320, height: 180 });
    assert.equal(result.samples[0]?.sourceDigest, sourceDigest);
    assert.equal(result.samples[0]?.sourceSeconds, 0);
    assert.ok(Buffer.from(result.data, "base64").length > 100);
    assert.equal((await readdir(directory)).filter((name) => name.startsWith("framekit-storyboard-")).length, 0);
    const missingGlyph = structuredClone(timeline);
    missingGlyph.sequence.titles = [{ id: "missing-glyph", text: "A\u{10ffff}", startTime: { value: "0", timescale: "1" }, durationTime: { value: "1", timescale: "1" }, lane: 1 }];
    const fontPath = join(directory, "font.otf");
    await writeFile(fontPath, Buffer.from(await readFile(join(process.cwd(), "tests/fixtures/fonts/noto-sans-jp-test.otf.base64"), "utf8"), "base64"));
    const priorFont = process.env.FRAMEKIT_RENDER_FONT;
    try {
      process.env.FRAMEKIT_RENDER_FONT = relative(process.cwd(), fontPath);
      await assert.rejects(renderer.render(missingGlyph, { width: 320, height: 180 }), /selected font lacks glyph U\+10FFFF/i);
      const supported = structuredClone(missingGlyph);
      supported.sequence.titles![0]!.text = "A日";
      assert.ok(Buffer.from((await renderer.render(supported, { width: 320, height: 180 })).data, "base64").length > 100);
    } finally {
      if (priorFont === undefined) delete process.env.FRAMEKIT_RENDER_FONT;
      else process.env.FRAMEKIT_RENDER_FONT = priorFont;
    }
    const oversized = structuredClone(timeline);
    oversized.sequence.occurrences = Array.from({ length: 13 }, (_, index) => ({ ...occurrence(`shot-${index}`, "media"), startTime: { value: String(index), timescale: "1" } }));
    await assert.rejects(renderer.render(oversized, { width: 320, height: 180 }), /HEADLESS_STORYBOARD_LIMIT/);
    const failing = join(directory, "failing-ffmpeg");
    await writeFile(failing, "#!/usr/bin/env node\nprocess.exit(2);\n");
    await chmod(failing, 0o755);
    await assert.rejects(new FfmpegStoryboardRenderer({ temporaryDirectory: directory, ffmpegPath: failing }).render(timeline, { width: 320, height: 180 }));
    assert.equal((await readdir(directory)).filter((name) => name.startsWith("framekit-storyboard-")).length, 0);

    // No cached image may be reused after the source bytes change.
    await writeFile(source, "changed");
    await assert.rejects(renderer.render(timeline, { width: 320, height: 180 }), /HEADLESS_STORYBOARD_SOURCE_CHANGED/);
    await generateVideoAtFrameRate(source, 30, 2);
    timeline.resources[0]!.sourceDigest = createHash("sha256").update(await readFile(source)).digest("hex");
    const changing = join(directory, "changing-ffmpeg");
    await writeFile(changing, `#!/usr/bin/env node\nconst { spawnSync } = require('node:child_process'); const { appendFileSync } = require('node:fs'); const result = spawnSync('ffmpeg', process.argv.slice(2)); appendFileSync(${JSON.stringify(source)}, 'changed'); process.exit(result.status ?? 1);\n`);
    await chmod(changing, 0o755);
    await assert.rejects(new FfmpegStoryboardRenderer({ temporaryDirectory: directory, ffmpegPath: changing }).render(timeline, { width: 320, height: 180 }), /HEADLESS_STORYBOARD_SOURCE_CHANGED/);
    assert.equal((await readdir(directory)).filter((name) => name.startsWith("framekit-storyboard-")).length, 0);
    await generateVideoAtFrameRate(source, 30, 2);
    timeline.resources[0]!.sourceDigest = createHash("sha256").update(await readFile(source)).digest("hex");
    const slow = join(directory, "slow-ffmpeg");
    await writeFile(slow, "#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 30000);\n");
    await chmod(slow, 0o755);
    const controller = new AbortController();
    const pending = new FfmpegStoryboardRenderer({ temporaryDirectory: directory, ffmpegPath: slow }).render(timeline, { width: 320, height: 180 }, controller.signal);
    const timer = setTimeout(() => controller.abort(), 200);
    await assert.rejects(pending, /abort/i);
    clearTimeout(timer);
    assert.equal((await readdir(directory)).filter((name) => name.startsWith("framekit-storyboard-")).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inferred rough-cut ranges align duration to the sequence frame grid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headless-rough-cut-frame-grids-"));
  const sourcePath = join(directory, "source-24fps.mp4");
  try {
    await generateVideoAtFrameRate(sourcePath, 24, 2);
    const timeline = emptyTimeline();
    timeline.sequence.frameDuration = { value: "1", timescale: "30" };
    const service = new HeadlessProjectService({
      directory: join(directory, "projects"),
      mediaProbe: new FfmpegMediaMetadataProbe(),
    });
    const created = await service.create(timeline);
    const registered = await service.registerMedia(created.timeline.project.id, sourcePath, created.timeline.revision);
    const source = registered.resource;
    assert.deepEqual(source.metadata?.streams.find((stream) => stream.kind === "video")?.frameRate, {
      value: "24",
      timescale: "1",
    });
    const sourceDuration = Number(source.metadata!.durationTime.value) / Number(source.metadata!.durationTime.timescale);
    const makeRequest = (range: { start: number; end: number }) => ({
      projectId: created.timeline.project.id,
      sequenceId: created.timeline.sequence.id,
      plan: {
        planner: { id: "framekit.rough-cut", version: 1 },
        revision: registered.project.timeline.revision,
        query: { query: "frame grid" },
        shots: [{
          order: 1,
          sourceIdentity: {
            mediaId: source.id,
            source: source.source!,
            sourceDigest: source.sourceDigest!,
            mediaKind: "video" as const,
            duration: sourceDuration,
          },
          range,
          confidence: 0.9,
          matchedProperties: ["query:frame grid"],
          rationale: "verify common source and sequence frame timing",
        }],
        warnings: [],
      },
      render: {
        outputPath: join(directory, "rough-cut.mp4"),
        format: "mp4" as const,
        width: 320,
        height: 180,
        frameRate: { value: "30", timescale: "1" },
      },
      fcpxml: {
        path: join(directory, "rough-cut.fcpxml"),
        target: {
          provider: "final-cut" as const,
          libraryUid: "library-frame-grid",
          eventUid: "event-frame-grid",
          projectUid: "project-frame-grid",
          sequenceUid: "sequence-frame-grid",
        },
      },
    });

    await assert.rejects(service.previewRoughCut(makeRequest({ start: 0, end: 0.75 }), undefined, true), /HEADLESS_STORYBOARD_UNAVAILABLE/);
    const preview = await service.previewRoughCut(makeRequest({ start: 0, end: 0.75 }));
    assert.deepEqual(preview.after.timeline.sequence.occurrences[0]?.durationTime, { value: "23", timescale: "30" });
    assert.deepEqual(preview.provenance[0]?.sourceRange.durationTime, { value: "23", timescale: "30" });

    // 24 fps and 24000/1001 fps share a frame only every 41.7 seconds.
    // A short valid range must not be rounded to that common interval.
    const fractionalTimeline = emptyTimeline();
    fractionalTimeline.sequence.frameDuration = { value: "1001", timescale: "24000" };
    const fractionalService = new HeadlessProjectService({ directory: join(directory, "fractional-projects"), mediaProbe: new FfmpegMediaMetadataProbe() });
    const fractionalCreated = await fractionalService.create(fractionalTimeline);
    const fractionalRegistered = await fractionalService.registerMedia(fractionalCreated.timeline.project.id, sourcePath, fractionalCreated.timeline.revision);
    const fractionalRequest = makeRequest({ start: 0, end: 0.75 });
    fractionalRequest.projectId = fractionalCreated.timeline.project.id;
    fractionalRequest.sequenceId = fractionalCreated.timeline.sequence.id;
    fractionalRequest.plan.revision = fractionalRegistered.project.timeline.revision;
    fractionalRequest.plan.shots[0]!.sourceIdentity.mediaId = fractionalRegistered.resource.id;
    const fractionalPreview = await fractionalService.previewRoughCut(fractionalRequest);
    assert.deepEqual(fractionalPreview.after.timeline.sequence.occurrences[0]?.durationTime, { value: "3003", timescale: "4000" });
    const nearEnd = await fractionalService.previewRoughCut({ ...fractionalRequest, plan: { ...fractionalRequest.plan, shots: [{ ...fractionalRequest.plan.shots[0]!, range: { start: 1.5, end: sourceDuration } }] } });
    assert.ok(rationalSeconds(nearEnd.provenance[0]!.sourceRange.startTime!) + rationalSeconds(nearEnd.provenance[0]!.sourceRange.durationTime!) <= sourceDuration);

    // The FCPXML compiler also rounds source starts to the sequence grid.
    // A long range ending at the media boundary must remain within the source
    // after that second rounding step, not just in the canonical timeline.
    const longSourcePath = join(directory, "long-source.mp4");
    await generateVideoAtFrameRate(longSourcePath, 24, 1002 / 24);
    const longRegistered = await fractionalService.registerMedia(fractionalCreated.timeline.project.id, longSourcePath, fractionalRegistered.project.timeline.revision);
    const longSource = longRegistered.resource;
    const longDuration = rationalSeconds(longSource.metadata!.durationTime);
    const longRequest = { ...fractionalRequest, plan: { ...fractionalRequest.plan, revision: longRegistered.project.timeline.revision, shots: [{ ...fractionalRequest.plan.shots[0]!, sourceIdentity: { mediaId: longSource.id, source: longSource.source!, sourceDigest: longSource.sourceDigest!, mediaKind: "video" as const, duration: longDuration }, range: { start: 1 / 24, end: longDuration } }] } };
    const longPreview = await fractionalService.previewRoughCut(longRequest);
    const compiled = compileTimelineIrToFcpxml(longPreview.after.timeline, { target: longRequest.fcpxml.target });
    const clip = compiled.xml.match(/<asset-clip\b[^>]*>/)?.[0];
    assert.ok(clip);
    const start = clip.match(/\bstart="(\d+)(?:\/(\d+))?s"/)?.slice(1);
    const duration = clip.match(/\bduration="(\d+)(?:\/(\d+))?s"/)?.slice(1);
    assert.ok(start && duration);
    const renderedEnd = Number(start[0]) / Number(start[1] ?? 1) + Number(duration[0]) / Number(duration[1] ?? 1);
    assert.ok(renderedEnd <= longDuration, `exported source end ${renderedEnd} exceeds ${longDuration}`);

    await assert.rejects(
      service.previewRoughCut(makeRequest({ start: -0.01, end: 0.75 })),
      /HEADLESS_ROUGH_CUT_RANGE_INVALID: source range must be finite and non-empty/,
    );
    await assert.rejects(
      service.previewRoughCut(makeRequest({ start: sourceDuration - 0.5, end: sourceDuration + 0.01 })),
      /HEADLESS_ROUGH_CUT_RANGE_INVALID: source range exceeds/,
    );

    let startSampling!: () => void;
    let finishSampling!: () => void;
    const started = new Promise<void>((resolve) => { startSampling = resolve; });
    const finish = new Promise<void>((resolve) => { finishSampling = resolve; });
    const concurrent = new HeadlessProjectService({
      directory: join(directory, "projects"), mediaProbe: new FfmpegMediaMetadataProbe(),
      storyboard: { render: async () => { startSampling(); await finish; return { data: "", mimeType: "image/png", samples: [], limitations: [] }; } },
    });
    const approvalsBefore = (await readdir(join(directory, "projects"))).filter((name) => name.endsWith(".approval.json")).sort();
    const pending = concurrent.previewRoughCut(makeRequest({ start: 0, end: 0.5 }));
    await started;
    await service.executeEdit(created.timeline.project.id, {
      schemaVersion: 1, expectedRevision: registered.project.timeline.revision,
      operations: [{ type: "insert-occurrence", occurrence: occurrence("concurrent", source.id) }],
    }, created.timeline.sequence.id);
    finishSampling();
    await assert.rejects(pending, /HEADLESS_ROUGH_CUT_STALE_REVISION/);
    assert.deepEqual((await readdir(join(directory, "projects"))).filter((name) => name.endsWith(".approval.json")).sort(), approvalsBefore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function emptyTimeline(): TimelineIr {
  return {
    schemaVersion: 1,
    project: { id: "mcp-headless-project", name: "MCP Headless Project" },
    sequence: { id: "mcp-headless-sequence", name: "Master", durationTime: { value: "0", timescale: "1" }, frameDuration: { value: "1", timescale: "30" }, occurrences: [], storyElements: [], markers: [], captions: [], titles: [], transitions: [] },
    resources: [],
    revision: { id: "mcp-revision-0", sequence: 0, timestamp: "2026-10-05T00:00:00.000Z" },
  };
}

function occurrence(id: string, mediaId: string) {
  return { id, name: id, startTime: { value: "0", timescale: "1" }, durationTime: { value: "1", timescale: "1" }, sourceStartTime: { value: "0", timescale: "1" }, track: 0, role: "video" as const, mediaId };
}

function payload(result: unknown): any {
  const value = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  assert.equal(value.isError, undefined);
  assert.equal(value.content?.[0]?.type, "text");
  return JSON.parse(value.content?.[0]?.text ?? "null");
}

function toolErrorText(result: unknown): string {
  const value = result as { content?: Array<{ type?: string; text?: string }> };
  return value.content?.[0]?.type === "text" ? value.content[0].text ?? "" : "";
}

async function connectProductionClient(here: string, environment: Record<string, string>): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: process.env.FRAMEKIT_TEST_MCP_ENTRYPOINT
      ? [process.env.FRAMEKIT_TEST_MCP_ENTRYPOINT]
      : ["--import", "tsx", join(here, "../../../apps/mcp-server/src/main.ts")],
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "headless-project-production-stdio-test", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
}

async function makeHeadlessSpeechAnalyzer(directory: string): Promise<string> {
  const analyzerPath = join(directory, "speech-analyzer.mjs");
  await writeFile(analyzerPath, [
    "#!/usr/bin/env node",
    'let input = "";',
    'for await (const chunk of process.stdin) input += chunk;',
    "const request = JSON.parse(input);",
    "const range = request.range ?? { start: 0, end: request.media.duration };",
    "process.stdout.write(JSON.stringify({",
    "  schemaVersion: 1,",
    "  mediaId: request.media.mediaId,",
    "  sourceIdentity: request.media,",
    "  requestedRange: range,",
    "  observedRange: range,",
    "  revision: request.revision,",
    '  provider: { id: "command.speech", provider: "command", version: "test-vad@1" },',
    '  words: [{ text: "highlight", start: 0.5, end: 1.4, confidence: 0.99 }],',
    '  vadSegments: [{ start: 0, end: 2, kind: "speech", confidence: 0.99 }],',
    '  sourceTimebase: { value: "1", timescale: "1000" },',
    "}));",
  ].join("\n"));
  await chmod(analyzerPath, 0o755);
  return analyzerPath;
}

async function makeFixedAnalyzer(directory: string, name: string, output: string): Promise<string> {
  const analyzerPath = join(directory, `${name}-analyzer.mjs`);
  await writeFile(analyzerPath, [
    "#!/usr/bin/env node",
    `process.stdout.write(${JSON.stringify(output)});`,
  ].join("\n"));
  await chmod(analyzerPath, 0o755);
  return analyzerPath;
}

async function generateSegmentedSource(
  path: string,
  segments: Array<{ color: string; duration: number }>,
  frequency: number,
): Promise<void> {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const segment of segments) {
    args.push("-f", "lavfi", "-i", `color=c=${segment.color}:s=320x180:r=30:d=${segment.duration}`);
  }
  const audioIndex = segments.length;
  const duration = segments.reduce((total, segment) => total + segment.duration, 0);
  args.push("-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=${duration}`);
  args.push(
    "-filter_complex", `${segments.map((_, index) => `[${index}:v]`).join("")}concat=n=${segments.length}:v=1:a=0[outv]`,
    "-map", "[outv]", "-map", `${audioIndex}:a`, "-t", String(duration),
    "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", path,
  );
  await execFileAsync("ffmpeg", args);
}

async function generateVideoAtFrameRate(path: string, frameRate: number, duration: number): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=red:s=320x180:r=${frameRate}:d=${duration}`,
    "-an", "-t", String(duration), "-c:v", "libx264", "-preset", "ultrafast",
    "-threads", "1", "-pix_fmt", "yuv420p", path,
  ]);
}

async function readVideoFrame(path: string, seconds: number): Promise<Buffer> {
  const { stdout } = await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-ss", String(seconds), "-i", path,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 320 * 180 * 3 + 1024 });
  return stdout as unknown as Buffer;
}

async function readAudioWindow(path: string, seconds: number): Promise<Float32Array> {
  const { stdout } = await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-ss", String(seconds), "-t", "0.5", "-i", path,
    "-vn", "-f", "f32le", "-ac", "1", "-ar", "48000", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 48_000 * 4 + 1024 });
  const buffer = stdout as unknown as Buffer;
  return new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
}

function assertPixelDominates(frame: Buffer, color: "blue" | "green" | "yellow"): void {
  assert.equal(frame.length, 320 * 180 * 3);
  const offset = (10 * 320 + 10) * 3;
  const [red, green, blue] = [frame[offset]!, frame[offset + 1]!, frame[offset + 2]!];
  if (color === "blue") assert.ok(blue > red + 100 && blue > green + 100, `expected blue source content, got RGB ${red},${green},${blue}`);
  if (color === "green") assert.ok(green > red + 50 && green > blue + 20, `expected green source content, got RGB ${red},${green},${blue}`);
  if (color === "yellow") assert.ok(red > blue + 100 && green > blue + 100, `expected yellow source content, got RGB ${red},${green},${blue}`);
}

function countBrightPixels(frame: Buffer): number {
  let count = 0;
  for (let offset = 0; offset < frame.length; offset += 3) {
    if (frame[offset]! > 160 && frame[offset + 1]! > 160 && frame[offset + 2]! > 160) count += 1;
  }
  return count;
}

function assertAudioMix(samples: Float32Array, sourceFrequency: number): void {
  assert.ok(samples.length >= 20_000);
  const sourceAmplitude = toneAmplitude(samples, sourceFrequency);
  const musicAmplitude = toneAmplitude(samples, 1760);
  assert.ok(sourceAmplitude > 0.01, `source audio at ${sourceFrequency} Hz is present (${sourceAmplitude})`);
  assert.ok(musicAmplitude > 0.002, `independent music at 1760 Hz is present (${musicAmplitude})`);
  const ratio = musicAmplitude / sourceAmplitude;
  assert.ok(ratio > 0.17 && ratio < 0.34, `music gain is approximately -12 dB (amplitude ratio ${ratio})`);
}

function toneAmplitude(samples: Float32Array, frequency: number, sampleRate = 48_000): number {
  const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate);
  let previous = 0;
  let previousPrevious = 0;
  for (const sample of samples) {
    const current = sample + coefficient * previous - previousPrevious;
    previousPrevious = previous;
    previous = current;
  }
  const power = previous * previous + previousPrevious * previousPrevious - coefficient * previous * previousPrevious;
  return (2 * Math.sqrt(Math.max(0, power))) / samples.length;
}

function rationalSeconds(time: { value: string; timescale: string }): number {
  return Number(time.value) / Number(time.timescale);
}

test("external JSON binds one font through preview, render and FCPXML", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-json-title-font-"));
  const here = dirname(fileURLToPath(import.meta.url));
  const fontPath = join(directory, "font.otf");
  const fontBytes = Buffer.from(await readFile(join(process.cwd(), "tests/fixtures/fonts/noto-sans-jp-test.otf.base64"), "utf8"), "base64");
  await writeFile(fontPath, fontBytes);
  const environment: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    FRAMEKIT_EDITOR: "final-cut-live", FRAMEKIT_AUTO_CONNECT: "0", FRAMEKIT_FINAL_CUT_HEADLESS: "1",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0", FRAMEKIT_FINAL_CUT_SOCKET: join(directory, "missing.sock"),
    FRAMEKIT_STATE_DIR: join(directory, "state"), FRAMEKIT_RENDER_FONT: fontPath,
  };
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    const video = join(directory, "source.mp4");
    await generateVideoAtFrameRate(video, 30, 2);
    ({ client, transport } = await connectProductionClient(here, environment));
    const initial = payload(await client.callTool({ name: "headless.project.create", arguments: { timeline: emptyTimeline() } }));
    const projectId = initial.timeline.project.id;
    const sequenceId = initial.timeline.sequence.id;
    const source = payload(await client.callTool({ name: "headless.media.register", arguments: { projectId, sourcePath: video, expectedRevision: initial.timeline.revision } }));
    const revision = source.project.timeline.revision;
    const edit = { schemaVersion: 1, clips: [{ id: "clip", mediaId: source.resource.id, sourceStartTime: { value: "0", timescale: "1" }, durationTime: { value: "1", timescale: "1" } }], title: { id: "title", text: "A日", startTime: { value: "0", timescale: "1" }, durationTime: { value: "1", timescale: "1" } } };
    const args = { projectId, sequenceId, expectedRevision: revision, edit };
    const preview = payload(await client.callTool({ name: "headless.edit-json.preview", arguments: args }));
    const font = { family: "Noto Sans CJK JP", style: "Regular", postscriptName: "NotoSansCJKjp-Regular", digest: createHash("sha256").update(fontBytes).digest("hex") };
    assert.deepEqual(preview.after.timeline.sequence.titles[0].font, font);
    assert.deepEqual(payload(await client.callTool({ name: "headless.project.inspect", arguments: { projectId } })).timeline, source.project.timeline);
    await writeFile(fontPath, Buffer.concat([fontBytes, Buffer.from([0])]));
    const changed = await client.callTool({ name: "headless.edit-json.execute", arguments: { ...args, approved: true, planDigest: preview.planDigest } });
    assert.equal(changed.isError, true);
    assert.match(toolErrorText(changed), /STALE_PREVIEW|FONT/i);
    assert.deepEqual(payload(await client.callTool({ name: "headless.project.inspect", arguments: { projectId } })).timeline, source.project.timeline);
    await writeFile(fontPath, fontBytes);
    const executed = payload(await client.callTool({ name: "headless.edit-json.execute", arguments: { ...args, approved: true, planDigest: preview.planDigest } }));
    assert.deepEqual(executed.after.timeline.sequence.titles[0].font, font);
    const target = { provider: "final-cut", libraryUid: "library", eventUid: "event", projectUid: "project", sequenceUid: "sequence", materialization: "versioned" };
    const xmlPath = join(directory, "edit.fcpxml");
    const exportArgs = { projectId, sequenceId, expectedRevision: executed.after.timeline.revision, outputPath: xmlPath, target };
    await writeFile(fontPath, Buffer.concat([fontBytes, Buffer.from([0])]));
    const wrongExport = await client.callTool({ name: "headless.fcpxml.export", arguments: exportArgs });
    assert.equal(wrongExport.isError, true);
    assert.equal(existsSync(xmlPath), false);
    await writeFile(fontPath, fontBytes);
    const exported = payload(await client.callTool({ name: "headless.fcpxml.export", arguments: exportArgs }));
    assert.ok(exported.coverage.degraded.includes("native-title-font-availability-unverified"));
    const xml = await readFile(xmlPath, "utf8");
    assert.match(xml, /font="Noto Sans CJK JP" fontFace="Regular"/);
    assert.ok(xml.includes(`key="com.framekit.title-font-sha256" value="${font.digest}"`));
    const parsed = await new FcpxmlDocumentAdapter(xmlPath).readProject();
    assert.equal(parsed.timeline.storyElements.find(({ kind }) => kind === "title")?.text, "A日");
    const legacyTimeline = structuredClone(executed.after.timeline);
    legacyTimeline.project.id = "legacy-unbound-title";
    delete legacyTimeline.sequence.titles[0].font;
    const legacy = payload(await client.callTool({ name: "headless.project.create", arguments: { timeline: legacyTimeline } }));
    const legacyPath = join(directory, "legacy.fcpxml");
    const legacyExport = await client.callTool({ name: "headless.fcpxml.export", arguments: { projectId: legacy.timeline.project.id, sequenceId, expectedRevision: legacy.timeline.revision, outputPath: legacyPath, target } });
    assert.equal(legacyExport.isError, true);
    assert.match(toolErrorText(legacyExport), /TITLE_FONT_UNBOUND/);
    assert.equal(existsSync(legacyPath), false);
    const legacyRenderPath = join(directory, "legacy.mp4");
    await writeFile(fontPath, Buffer.concat([fontBytes, Buffer.from([0])]));
    const legacyRender = await client.callTool({ name: "headless.render", arguments: { projectId: legacy.timeline.project.id, sequenceId, expectedRevision: legacy.timeline.revision, parameters: { outputPath: legacyRenderPath, format: "mp4", width: 320, height: 180, frameRate: { value: "30", timescale: "1" } } } });
    assert.equal(legacyRender.isError, true, "unbound legacy titles must not render with an implicit font");
    assert.match(toolErrorText(legacyRender), /TITLE_FONT_UNBOUND/);
    assert.equal(existsSync(legacyRenderPath), false);
    await writeFile(fontPath, fontBytes);
    const output = join(directory, "render.mp4");
    const renderArgs = { projectId, sequenceId, expectedRevision: executed.after.timeline.revision, parameters: { outputPath: output, format: "mp4", width: 320, height: 180, frameRate: { value: "30", timescale: "1" } } };
    await writeFile(fontPath, Buffer.concat([fontBytes, Buffer.from([0])]));
    const wrongFont = await client.callTool({ name: "headless.render", arguments: renderArgs });
    assert.equal(payload(wrongFont).status, "unavailable");
    assert.equal(existsSync(output), false);
    await writeFile(fontPath, fontBytes);
    const rendered = payload(await client.callTool({ name: "headless.render", arguments: renderArgs }));
    assert.equal(rendered.status, "passed");
  } finally {
    await client?.close();
    await transport?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("external edit JSON previews registered clips, a title and music without mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-json-edit-"));
  const here = dirname(fileURLToPath(import.meta.url));
  const environment: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    FRAMEKIT_EDITOR: "final-cut-live", FRAMEKIT_AUTO_CONNECT: "0", FRAMEKIT_FINAL_CUT_HEADLESS: "1",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0", FRAMEKIT_FINAL_CUT_SOCKET: join(directory, "missing.sock"),
    FRAMEKIT_STATE_DIR: join(directory, "state"), FRAMEKIT_RENDER_FONT: join(directory, "font.otf"),
  };
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    await writeFile(environment.FRAMEKIT_RENDER_FONT!, Buffer.from(await readFile(join(process.cwd(), "tests/fixtures/fonts/noto-sans-jp-test.otf.base64"), "utf8"), "base64"));
    const calls = join(directory, "native-calls.log");
    const sentinelBin = join(directory, "sentinel-bin");
    await mkdir(sentinelBin);
    for (const command of ["osascript", "swift", "open", "pluginkit"]) {
      const script = join(sentinelBin, command);
      await writeFile(script, `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(`${command}\n`)}); process.exit(77);\n`);
      await chmod(script, 0o755);
    }
    environment.PATH = `${sentinelBin}:${process.env.PATH ?? ""}`;
    const reservationPath = join(directory, "state", "canonical-recovery", "pending.json");
    const reservation = JSON.stringify({ version: 2, kind: "native-operation", owner: "00000000-0000-4000-8000-000000000001", operation: "native.searchmedia" }) + "\n";
    await mkdir(dirname(reservationPath), { recursive: true });
    await writeFile(reservationPath, reservation);
    const video = join(directory, "a", "same.mp4");
    const video2 = join(directory, "b", "same.mp4");
    await mkdir(dirname(video), { recursive: true });
    await mkdir(dirname(video2), { recursive: true });
    const music = join(directory, "music.wav");
    await generateSegmentedSource(video, [{ color: "red", duration: 3 }], 440);
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=blue:s=320x180:r=24:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", video2]);
    const sourcePaths = [video, video2, music];
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=3", "-c:a", "pcm_s16le", music]);
    ({ client, transport } = await connectProductionClient(here, environment));
    const timeline = emptyTimeline();
    const initial = payload(await client.callTool({ name: "headless.project.create", arguments: { timeline } }));
    const projectId = timeline.project.id;
    const a = payload(await client.callTool({ name: "headless.media.register", arguments: { projectId, sourcePath: video, expectedRevision: initial.timeline.revision } }));
    const a2 = payload(await client.callTool({ name: "headless.media.register", arguments: { projectId, sourcePath: video2, expectedRevision: a.project.timeline.revision } }));
    const b = payload(await client.callTool({ name: "headless.media.register", arguments: { projectId, sourcePath: music, expectedRevision: a2.project.timeline.revision } }));
    assert.notEqual(a.resource.id, a2.resource.id);
    {
      // A caller-created project must not forge audio stream metadata for a silent video.
      const silentVideo = join(directory, "silent.mp4");
      await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=red:s=320x180:r=30:d=2", "-c:v", "libx264", "-threads", "1", silentVideo]);
      const silentTimeline = emptyTimeline();
      silentTimeline.project.id = "silent-role-source";
      const silentCreated = payload(await client.callTool({ name: "headless.project.create", arguments: { timeline: silentTimeline } }));
      const silentRegistered = payload(await client.callTool({ name: "headless.media.register", arguments: { projectId: silentTimeline.project.id, sourcePath: silentVideo, expectedRevision: silentCreated.timeline.revision } }));
      const forgedTimeline = structuredClone(silentRegistered.project.timeline);
      forgedTimeline.project.id = "forged-dialogue-source";
      forgedTimeline.resources[0].metadata.streams.push(structuredClone(a.resource.metadata.streams.find((item: any) => item.kind === "audio")));
      const forged = payload(await client.callTool({ name: "headless.project.create", arguments: { timeline: forgedTimeline } }));
      const forgedArgs = { projectId: forgedTimeline.project.id, sequenceId: forgedTimeline.sequence.id, expectedRevision: forged.timeline.revision, edit: { schemaVersion: 1, clips: [{ id: "clip", mediaId: silentRegistered.resource.id, sourceStartTime: { value: "0", timescale: "1" }, durationTime: { value: "1", timescale: "1" }, nativeAudioRole: "dialogue" }] } };
      for (const tool of ["headless.edit-json.preview", "headless.edit-json.execute"]) {
        const result = await client.callTool({ name: tool, arguments: { ...forgedArgs, ...(tool.endsWith("execute") ? { approved: true, planDigest: "0".repeat(64) } : {}) } });
        assert.equal(result.isError, true, `${tool} must re-probe source audio streams`);
        assert.match(toolErrorText(result), /MEDIA_METADATA_CHANGED/);
      }
      assert.deepEqual(payload(await client.callTool({ name: "headless.project.inspect", arguments: { projectId: forgedTimeline.project.id } })).timeline, forged.timeline);
      const existing = structuredClone(forgedTimeline);
      existing.project.id = "forged-existing-dialogue";
      existing.sequence.occurrences = [{ ...occurrence("clip", silentRegistered.resource.id), nativeAudioRole: "dialogue" }];
      existing.sequence.durationTime = { value: "1", timescale: "1" };
      const createdExisting = payload(await client.callTool({ name: "headless.project.create", arguments: { timeline: existing } }));
      const xmlPath = join(directory, "forged-dialogue.fcpxml");
      const exported = await client.callTool({ name: "headless.fcpxml.export", arguments: { projectId: existing.project.id, sequenceId: existing.sequence.id, expectedRevision: createdExisting.timeline.revision, outputPath: xmlPath, target: { provider: "final-cut", libraryUid: "library", eventUid: "event", projectUid: "project", sequenceUid: "sequence", materialization: "versioned" } } });
      assert.equal(exported.isError, true);
      assert.match(toolErrorText(exported), /MEDIA_METADATA_CHANGED/);
      assert.equal(existsSync(xmlPath), false);
      const renderPath = join(directory, "forged-dialogue.mp4");
      const rendered = await client.callTool({ name: "headless.render", arguments: { projectId: existing.project.id, sequenceId: existing.sequence.id, expectedRevision: createdExisting.timeline.revision, parameters: { outputPath: renderPath, format: "mp4", width: 320, height: 180, frameRate: { value: "30", timescale: "1" } } } });
      assert.equal(rendered.isError, true);
      assert.match(toolErrorText(rendered), /MEDIA_METADATA_CHANGED/);
      assert.equal(existsSync(renderPath), false);
    }
    const probeScript = join(directory, "probe-fixture.mjs");
    const mockProbe = async (startPts: number, formatStart: string) => {
      const response = { streams: [{ codec_type: "video", width: 320, height: 180, r_frame_rate: "30/1", time_base: "1/90000", start_pts: startPts, duration_ts: 90000 }], format: { duration: "3.000000", start_time: formatStart } };
      await writeFile(probeScript, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(response))});\n`);
      await chmod(probeScript, 0o755);
      return (await new FfmpegMediaMetadataProbe({ ffprobePath: probeScript }).probe(video)).streams[0]!.sourceRange;
    };
    assert.deepEqual(await mockProbe(6000, "0.066667"), { start: { value: "0", timescale: "1" }, duration: { value: "1", timescale: "1" } });
    assert.deepEqual(await mockProbe(6000, "0.066666"), { start: { value: "1", timescale: "1500000" }, duration: { value: "1", timescale: "1" } });
    assert.equal(await mockProbe(6000, "0.066668"), undefined);
    assert.deepEqual(await mockProbe(9000, "0.000000"), { start: { value: "1", timescale: "10" }, duration: { value: "1", timescale: "1" } });
    const sourceDigests = await Promise.all(sourcePaths.map(async (path) => createHash("sha256").update(await readFile(path)).digest("hex")));
    const seconds = (n: number) => ({ value: String(n), timescale: "1" });
    const edit = { schemaVersion: 1 as const, clips: [
      { id: "clip-a", mediaId: a.resource.id, sourceStartTime: seconds(0), durationTime: seconds(1), nativeAudioRole: "dialogue" },
      { id: "clip-b", mediaId: a2.resource.id, sourceStartTime: seconds(0), durationTime: seconds(1) },
    ], title: { id: "title", text: "A日", startTime: seconds(0), durationTime: seconds(1) },
    music: { id: "music", mediaId: b.resource.id, sourceStartTime: seconds(0), startTime: seconds(0), durationTime: seconds(2), gainDb: -12 } };
    for (const [variant, withTitle, withMusic] of [["clips", false, false], ["title", true, false], ["music", false, true]] as const) {
      const newTimeline = emptyTimeline();
      newTimeline.project.id = `partial-${variant}`;
      newTimeline.sequence.id = `sequence-${variant}`;
      const created = payload(await client.callTool({ name: "headless.project.create", arguments: { timeline: newTimeline } }));
      const registeredVideo = payload(await client.callTool({ name: "headless.media.register", arguments: { projectId: newTimeline.project.id, sourcePath: video, expectedRevision: created.timeline.revision } }));
      const registeredAudio = payload(await client.callTool({ name: "headless.media.register", arguments: { projectId: newTimeline.project.id, sourcePath: music, expectedRevision: registeredVideo.project.timeline.revision } }));
      const partialEdit = { schemaVersion: 1, clips: [{ ...edit.clips[0], mediaId: registeredVideo.resource.id }],
        ...(withTitle ? { title: edit.title } : {}), ...(withMusic ? { music: { ...edit.music, mediaId: registeredAudio.resource.id, durationTime: seconds(1) } } : {}) };
      const args = { projectId: newTimeline.project.id, sequenceId: newTimeline.sequence.id, expectedRevision: registeredAudio.project.timeline.revision, edit: partialEdit };
      const before = payload(await client.callTool({ name: "headless.project.inspect", arguments: { projectId: newTimeline.project.id } }));
      const partialPreview = payload(await client.callTool({ name: "headless.edit-json.preview", arguments: args }));
      assert.deepEqual(payload(await client.callTool({ name: "headless.project.inspect", arguments: { projectId: newTimeline.project.id } })).timeline, before.timeline);
      const partialExecuted = payload(await client.callTool({ name: "headless.edit-json.execute", arguments: { ...args, approved: true, planDigest: partialPreview.planDigest } }));
      assert.equal(partialExecuted.after.timeline.sequence.titles.length, Number(withTitle));
      assert.equal(partialExecuted.after.timeline.sequence.occurrences.filter((item: any) => item.role === "music").length, Number(withMusic));
      if (variant === "music") {
        const musicExport = payload(await client.callTool({ name: "headless.fcpxml.export", arguments: { projectId: newTimeline.project.id, sequenceId: newTimeline.sequence.id, expectedRevision: partialExecuted.after.timeline.revision, outputPath: join(directory, "bounded-music.fcpxml"), target: { provider: "final-cut", libraryUid: "library", eventUid: "event", projectUid: "music", sequenceUid: "sequence", materialization: "versioned" } } }));
        assert.equal(musicExport.artifact.verified, true, "bounded WAV must remain exportable");
      }
      if (variant === "clips") {
        const revision = partialExecuted.after.timeline.revision;
        const rendered = payload(await client.callTool({ name: "headless.render", arguments: { projectId: newTimeline.project.id, sequenceId: newTimeline.sequence.id, expectedRevision: revision, parameters: { outputPath: join(directory, "clips-only.mp4"), format: "mp4", width: 320, height: 180, frameRate: { value: "30", timescale: "1" } } } }));
        assert.equal(rendered.status, "passed");
        const exported = payload(await client.callTool({ name: "headless.fcpxml.export", arguments: { projectId: newTimeline.project.id, sequenceId: newTimeline.sequence.id, expectedRevision: revision, outputPath: join(directory, "clips-only.fcpxml"), target: { provider: "final-cut", libraryUid: "library", eventUid: "event", projectUid: "partial", sequenceUid: "sequence", materialization: "versioned" } } }));
        assert.equal(exported.artifact.verified, true);
      }
    }
    const shiftedTimeline = structuredClone(b.project.timeline);
    const shiftedStream = shiftedTimeline.resources.find((item: any) => item.id === a.resource.id).metadata.streams.find((item: any) => item.kind === "video");
    shiftedStream.sourceRange.start = { value: "1", timescale: "100" };
    const shiftedEdit = { ...edit, clips: [{ ...edit.clips[0], sourceStartTime: { value: "1", timescale: "30" } }] };
    assert.throws(() => externalEditOperations(shiftedEdit, shiftedTimeline, shiftedTimeline.revision), /source frame grid/);
    shiftedStream.sourceRange.start = { value: "1", timescale: "30" };
    assert.doesNotThrow(() => externalEditOperations(shiftedEdit, shiftedTimeline, shiftedTimeline.revision));
    // WAV audio has no ffprobe start fields, but its single stream has exact sample bounds.
    const wavStream = b.resource.metadata.streams.find((stream: any) => stream.kind === "audio");
    assert.deepEqual(wavStream.sourceRange, { start: seconds(0), duration: seconds(3) });
    const boundedMusic = structuredClone(b.project.timeline);
    const boundedStream = boundedMusic.resources.find((item: any) => item.id === b.resource.id).metadata.streams.find((stream: any) => stream.kind === "audio");
    boundedStream.sourceRange = { start: seconds(1), duration: seconds(1) };
    assert.throws(() => externalEditOperations(edit, boundedMusic, boundedMusic.revision), /range exceeds audio stream bounds/);
    assert.throws(() => externalEditOperations({ ...edit, music: { ...edit.music, sourceStartTime: seconds(1) } }, boundedMusic, boundedMusic.revision), /range exceeds audio stream bounds/);
    assert.doesNotThrow(() => externalEditOperations({ ...edit, music: { ...edit.music, sourceStartTime: seconds(1), durationTime: seconds(1) } }, boundedMusic, boundedMusic.revision));
    // A subtitle can extend the container beyond the selected audio stream.
    const subtitle = join(directory, "later.srt");
    const shortMusic = join(directory, "short-music.mka");
    await writeFile(subtitle, "1\n00:00:02,000 --> 00:00:03,000\ntext\n");
    await execFileAsync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=48000", "-i", subtitle, "-map", "0:a", "-map", "1:s", "-c:a", "pcm_s16le", "-c:s", "srt", shortMusic]);
    const shortTimeline = emptyTimeline();
    shortTimeline.project.id = "short-music";
    shortTimeline.sequence.id = "short-music-sequence";
    const shortCreated = payload(await client.callTool({ name: "headless.project.create", arguments: { timeline: shortTimeline } }));
    const shortVideo = payload(await client.callTool({ name: "headless.media.register", arguments: { projectId: shortTimeline.project.id, sourcePath: video, expectedRevision: shortCreated.timeline.revision } }));
    const shortAudio = payload(await client.callTool({ name: "headless.media.register", arguments: { projectId: shortTimeline.project.id, sourcePath: shortMusic, expectedRevision: shortVideo.project.timeline.revision } }));
    const shortEdit = { ...edit, clips: [{ ...edit.clips[0], mediaId: shortVideo.resource.id }, { ...edit.clips[1], mediaId: shortVideo.resource.id }], title: undefined,
      music: { ...edit.music, mediaId: shortAudio.resource.id } };
    const shortArgs = { projectId: shortTimeline.project.id, sequenceId: shortTimeline.sequence.id, expectedRevision: shortAudio.project.timeline.revision, edit: shortEdit };
    const genericOperations = [
      ...shortEdit.clips.map((clip) => ({ type: "insert-occurrence", placement: "append", occurrence: { ...clip, name: clip.id, startTime: seconds(0), track: 0, role: "video" } })),
      { type: "insert-occurrence", occurrence: { ...shortEdit.music, name: shortEdit.music.id, track: 1, role: "music" } },
    ];
    const genericPreview = await client.callTool({ name: "headless.edit.preview", arguments: { projectId: shortTimeline.project.id, sequenceId: shortTimeline.sequence.id, expectedRevision: shortAudio.project.timeline.revision, operations: genericOperations } });
    assert.equal(genericPreview.isError, true, "general editing must also reject unverifiable music bounds");
    assert.match(toolErrorText(genericPreview), /audio stream bounds/);
    const genericAudioOperations = genericOperations.map((operation, index) => index === 2 ? { ...operation, occurrence: { ...operation.occurrence, role: "audio" } } : operation);
    const genericAudioPreview = await client.callTool({ name: "headless.edit.preview", arguments: { projectId: shortTimeline.project.id, sequenceId: shortTimeline.sequence.id, expectedRevision: shortAudio.project.timeline.revision, operations: genericAudioOperations } });
    assert.equal(genericAudioPreview.isError, true, "audio role must not bypass music source bounds");
    assert.match(toolErrorText(genericAudioPreview), /audio stream bounds/);
    const genericExecution = await client.callTool({ name: "headless.edit.execute", arguments: { projectId: shortTimeline.project.id, sequenceId: shortTimeline.sequence.id, expectedRevision: shortAudio.project.timeline.revision, operations: genericOperations } });
    assert.equal(genericExecution.isError, true);
    assert.match(toolErrorText(genericExecution), /audio stream bounds/);
    assert.deepEqual(payload(await client.callTool({ name: "headless.project.inspect", arguments: { projectId: shortTimeline.project.id } })).timeline, shortAudio.project.timeline);
    const validGeneric = [
      ...edit.clips.map((clip) => ({ type: "insert-occurrence", placement: "append", occurrence: { ...clip, name: clip.id, startTime: seconds(0), track: 0, role: "video" } })),
      { type: "insert-occurrence", occurrence: { ...edit.music, name: edit.music.id, track: 1, role: "music" } },
    ];
    const validGenericPreview = await client.callTool({ name: "headless.edit.preview", arguments: { projectId, sequenceId: timeline.sequence.id, expectedRevision: b.project.timeline.revision, operations: validGeneric } });
    assert.notEqual(validGenericPreview.isError, true, "bounded WAV remains valid for general editing");
    const shortRoughCut = { projectId: shortTimeline.project.id, sequenceId: shortTimeline.sequence.id,
      plan: { planner: { id: "short-music-test", version: 1 }, revision: shortAudio.project.timeline.revision, query: { query: "test" }, warnings: [],
        shots: [{ order: 1, sourceIdentity: { mediaId: shortVideo.resource.id, source: shortVideo.resource.source, sourceDigest: shortVideo.resource.sourceDigest, mediaKind: "video", duration: 3 }, range: { start: 0, end: 2 }, confidence: 1, matchedProperties: [], rationale: "test" }] },
      operations: [genericOperations[2]], render: { outputPath: join(directory, "short-music.mp4"), format: "mp4", width: 320, height: 180, frameRate: { value: "30", timescale: "1" } },
      fcpxml: { path: join(directory, "short-music.fcpxml"), target: { provider: "final-cut", libraryUid: "library", eventUid: "event", projectUid: "short", sequenceUid: "short", materialization: "versioned" } } };
    const shortRoughPreview = await client.callTool({ name: "headless.rough-cut.preview", arguments: shortRoughCut });
    assert.equal(shortRoughPreview.isError, true, "rough-cut preview must reject unverifiable music bounds");
    assert.match(toolErrorText(shortRoughPreview), /audio stream bounds/);
    // A legacy project can already contain an unverified music occurrence.
    const legacyTimeline = structuredClone(shortAudio.project.timeline);
    legacyTimeline.project.id = "legacy-short-music";
    legacyTimeline.sequence.id = "legacy-short-sequence";
    legacyTimeline.sequence.durationTime = seconds(2);
    legacyTimeline.sequence.occurrences = [
      { ...shortEdit.clips[0], name: "legacy-video", startTime: seconds(0), durationTime: seconds(2), track: 0, role: "video" },
      { ...shortEdit.music, name: "legacy-music", track: 1, role: "music" },
    ];
    const forgedTimeline = structuredClone(legacyTimeline);
    forgedTimeline.project.id = "forged-audio-bounds";
    forgedTimeline.sequence.id = "forged-audio-sequence";
    forgedTimeline.resources.find((resource: any) => resource.id === shortAudio.resource.id).metadata.streams.find((stream: any) => stream.kind === "audio").sourceRange = { start: seconds(0), duration: seconds(3) };
    const forged = payload(await client.callTool({ name: "headless.project.create", arguments: { timeline: forgedTimeline } }));
    const forgedOutput = join(directory, "forged-audio.mp4");
    const forgedRender = await client.callTool({ name: "headless.render", arguments: { projectId: forgedTimeline.project.id, sequenceId: forgedTimeline.sequence.id, expectedRevision: forged.timeline.revision,
      parameters: { outputPath: forgedOutput, format: "mp4", width: 320, height: 180, frameRate: { value: "30", timescale: "1" } } } });
    assert.equal(forgedRender.isError, true, "caller-provided bounds must be checked against the source");
    assert.match(toolErrorText(forgedRender), /MEDIA_METADATA_CHANGED/);
    await assert.rejects(stat(forgedOutput), { code: "ENOENT" });
    const forgedEditArgs = { projectId: forgedTimeline.project.id, sequenceId: forgedTimeline.sequence.id, expectedRevision: forged.timeline.revision,
      operations: [{ type: "set-gain", occurrenceId: shortEdit.music.id, gainDb: -6 }] };
    for (const tool of ["headless.edit.preview", "headless.edit.execute"]) {
      const rejected = await client.callTool({ name: tool, arguments: forgedEditArgs });
      assert.equal(rejected.isError, true, `${tool} must re-probe the changed source`);
      assert.match(toolErrorText(rejected), /MEDIA_METADATA_CHANGED/);
    }
    const forgedRough = { ...shortRoughCut, projectId: forgedTimeline.project.id, sequenceId: forgedTimeline.sequence.id,
      plan: { ...shortRoughCut.plan, revision: forged.timeline.revision }, operations: [],
      render: { ...shortRoughCut.render, outputPath: join(directory, "forged-rough.mp4") },
      fcpxml: { ...shortRoughCut.fcpxml, path: join(directory, "forged-rough.fcpxml") } };
    const forgedRoughPreview = await client.callTool({ name: "headless.rough-cut.preview", arguments: forgedRough });
    assert.equal(forgedRoughPreview.isError, true);
    assert.match(toolErrorText(forgedRoughPreview), /MEDIA_METADATA_CHANGED/);
    const forgedXmlPath = join(directory, "forged-audio.fcpxml");
    const forgedXml = await client.callTool({ name: "headless.fcpxml.export", arguments: { projectId: forgedTimeline.project.id, sequenceId: forgedTimeline.sequence.id, expectedRevision: forged.timeline.revision, outputPath: forgedXmlPath, target: shortRoughCut.fcpxml.target } });
    assert.equal(forgedXml.isError, true);
    assert.match(toolErrorText(forgedXml), /MEDIA_METADATA_CHANGED/);
    await assert.rejects(stat(forgedXmlPath), { code: "ENOENT" });
    assert.deepEqual(payload(await client.callTool({ name: "headless.project.inspect", arguments: { projectId: forgedTimeline.project.id } })).timeline, forged.timeline);
    const legacy = payload(await client.callTool({ name: "headless.project.create", arguments: { timeline: legacyTimeline } }));
    const legacyRough = { ...shortRoughCut, projectId: legacyTimeline.project.id, sequenceId: legacyTimeline.sequence.id,
      plan: { ...shortRoughCut.plan, revision: legacy.timeline.revision }, operations: [],
      render: { ...shortRoughCut.render, outputPath: join(directory, "legacy-rough.mp4") },
      fcpxml: { ...shortRoughCut.fcpxml, path: join(directory, "legacy-rough.fcpxml") } };
    const legacyPreview = await client.callTool({ name: "headless.rough-cut.preview", arguments: legacyRough });
    assert.equal(legacyPreview.isError, true, "rough-cut must reject unverified existing music");
    assert.match(toolErrorText(legacyPreview), /audio stream bounds/);
    const legacyRenderPath = join(directory, "legacy-render.mp4");
    const legacyRender = await client.callTool({ name: "headless.render", arguments: { projectId: legacyTimeline.project.id, sequenceId: legacyTimeline.sequence.id, expectedRevision: legacy.timeline.revision,
      parameters: { outputPath: legacyRenderPath, format: "mp4", width: 320, height: 180, frameRate: { value: "30", timescale: "1" } } } });
    assert.equal(legacyRender.isError, true, "render must reject unverified existing music");
    assert.match(toolErrorText(legacyRender), /audio stream bounds/);
    await assert.rejects(stat(legacyRenderPath), { code: "ENOENT" });
    const legacyExportPath = join(directory, "legacy-export.fcpxml");
    const legacyExport = await client.callTool({ name: "headless.fcpxml.export", arguments: { projectId: legacyTimeline.project.id, sequenceId: legacyTimeline.sequence.id, expectedRevision: legacy.timeline.revision, outputPath: legacyExportPath, target: legacyRough.fcpxml.target } });
    assert.equal(legacyExport.isError, true, "FCPXML export must reject unverified existing music");
    assert.match(toolErrorText(legacyExport), /audio stream bounds/);
    await assert.rejects(stat(legacyExportPath), { code: "ENOENT" });
    const rejectedShort = await client.callTool({ name: "headless.edit-json.preview", arguments: shortArgs });
    assert.equal(rejectedShort.isError, true);
    assert.match(toolErrorText(rejectedShort), /audio stream bounds/);
    assert.deepEqual(payload(await client.callTool({ name: "headless.project.inspect", arguments: { projectId: shortTimeline.project.id } })).timeline, shortAudio.project.timeline);
    // A multi-stream music file must not silently select its first audio stream.
    const ambiguousMusic = structuredClone(b.project.timeline);
    const multistreamMusic = join(directory, "multistream.m4a");
    await execFileAsync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=48000", "-f", "lavfi", "-i", "sine=frequency=880:duration=3:sample_rate=48000", "-map", "0:a", "-map", "1:a", "-c:a", "aac", multistreamMusic]);
    const musicMetadata = await new FfmpegMediaMetadataProbe().probe(multistreamMusic);
    assert.equal(musicMetadata.streams.filter((stream) => stream.kind === "audio").length, 2);
    assert.deepEqual(musicMetadata.streams.filter((stream) => stream.kind === "audio").map((stream) => stream.sourceRange), [
      { start: seconds(0), duration: seconds(1) }, { start: seconds(0), duration: seconds(3) },
    ]);
    ambiguousMusic.resources.find((item: any) => item.id === b.resource.id).metadata = musicMetadata;
    assert.throws(() => externalEditOperations(edit, ambiguousMusic, ambiguousMusic.revision), /EXTERNAL_EDIT_INVALID:.*exactly one audio stream/);
    const multiTimeline = emptyTimeline();
    multiTimeline.project.id = "ambiguous-music";
    multiTimeline.sequence.id = "ambiguous-music-sequence";
    const multiCreated = payload(await client.callTool({ name: "headless.project.create", arguments: { timeline: multiTimeline } }));
    const multiVideo = payload(await client.callTool({ name: "headless.media.register", arguments: { projectId: multiTimeline.project.id, sourcePath: video, expectedRevision: multiCreated.timeline.revision } }));
    const multiAudio = payload(await client.callTool({ name: "headless.media.register", arguments: { projectId: multiTimeline.project.id, sourcePath: multistreamMusic, expectedRevision: multiVideo.project.timeline.revision } }));
    const multiEdit = { ...edit, clips: [{ ...edit.clips[0], mediaId: multiVideo.resource.id }], title: undefined,
      music: { ...edit.music, mediaId: multiAudio.resource.id, durationTime: seconds(1) } };
    const multiArgs = { projectId: multiTimeline.project.id, sequenceId: multiTimeline.sequence.id, expectedRevision: multiAudio.project.timeline.revision, edit: multiEdit };
    const rejectedMulti = await client.callTool({ name: "headless.edit-json.preview", arguments: multiArgs });
    assert.equal(rejectedMulti.isError, true);
    assert.match(toolErrorText(rejectedMulti), /exactly one audio stream/);
    const multiAfter = payload(await client.callTool({ name: "headless.project.inspect", arguments: { projectId: multiTimeline.project.id } }));
    assert.deepEqual(multiAfter.timeline, multiAudio.project.timeline);
    for (const count of [0, 2]) {
      const ambiguous = structuredClone(b.project.timeline);
      const resource = ambiguous.resources.find((item: any) => item.id === a.resource.id);
      const audio = resource.metadata.streams.find((item: any) => item.kind === "audio");
      resource.metadata.streams = resource.metadata.streams.filter((item: any) => item.kind !== "audio");
      for (let index = 0; index < count; index++) resource.metadata.streams.push(structuredClone(audio));
      assert.throws(() => externalEditOperations(edit, ambiguous, ambiguous.revision), /requires one audio stream/);
    }
    assert.throws(() => externalEditOperations({ ...edit, clips: [{ ...edit.clips[0]!, nativeAudioRole: "music" }] }, b.project.timeline, b.project.timeline.revision), /supported dialogue role/);
    assert.doesNotThrow(() => externalEditOperations({ ...edit, clips: [{ ...edit.clips[0]!, nativeAudioRole: "dialogue.alternate" }] }, b.project.timeline, b.project.timeline.revision));
    for (const nativeAudioRole of ["dialogue.inter\nview", "dialogue.inter\rview", "dialogue.inter\tview", "dialogue\n"]) {
      const invalidRole = { ...edit, clips: [{ ...edit.clips[0]!, nativeAudioRole }] };
      assert.throws(() => externalEditOperations(invalidRole, b.project.timeline, b.project.timeline.revision), /supported dialogue role/);
      const result = await client.callTool({ name: "headless.edit-json.preview", arguments: { projectId, sequenceId: timeline.sequence.id, expectedRevision: b.project.timeline.revision, edit: invalidRole } });
      assert.equal(result.isError, true, nativeAudioRole);
    }
    for (const gainDb of [-60, 12]) {
      assert.doesNotThrow(() => externalEditOperations({ ...edit, music: { ...edit.music, gainDb } }, b.project.timeline, b.project.timeline.revision));
    }
    for (const gainDb of [-60.01, 12.01, 40, Infinity, NaN]) {
      assert.throws(() => externalEditOperations({ ...edit, music: { ...edit.music, gainDb } }, b.project.timeline, b.project.timeline.revision), /EXTERNAL_EDIT_INVALID: music.gainDb.*-60.*12/);
    }
    for (const [name, invalidEdit] of [
      ["video stream exhausted", { ...edit, clips: [{ ...edit.clips[1], sourceStartTime: seconds(1) }] }],
      ["unsupported title glyphs", { ...edit, title: { ...edit.title, text: "Hello 世界 🎬" } }],
      ["illegal XML title", { ...edit, title: { ...edit.title, text: "bad\u0000title" } }],
      ["unknown source", { ...edit, clips: [{ ...edit.clips[0], mediaId: "missing" }] }],
      ["audio used as video", { ...edit, clips: [{ ...edit.clips[0], mediaId: b.resource.id }] }],
      ["video used as music", { ...edit, music: { ...edit.music, mediaId: a.resource.id } }],
      ["excessive music gain", { ...edit, music: { ...edit.music, gainDb: 40 } }],
      ["unsupported clip audio role", { ...edit, clips: [{ ...edit.clips[0], nativeAudioRole: "music" }] }],
      ["off-grid source start", { ...edit, clips: [{ ...edit.clips[0], sourceStartTime: { value: "1", timescale: "60" } }] }],
      ["source start between source frames", { ...edit, clips: [{ ...edit.clips[1], sourceStartTime: { value: "1", timescale: "30" }, durationTime: { value: "1", timescale: "2" } }] }],
      ["unsupported title styling", { ...edit, title: { ...edit.title, style: { color: "red" } } }],
      ["title crossing clip boundaries", { ...edit, title: { ...edit.title, durationTime: seconds(2) } }],
      ["source range outside media", { ...edit, clips: [{ ...edit.clips[0], sourceStartTime: seconds(3), durationTime: seconds(1) }] }],
    ] as const) {
      for (const tool of ["headless.edit-json.preview", "headless.edit-json.execute"]) {
        const rejected = await client.callTool({ name: tool, arguments: {
          projectId, sequenceId: timeline.sequence.id, expectedRevision: b.project.timeline.revision, edit: invalidEdit,
          ...(tool === "headless.edit-json.execute" ? { approved: true, planDigest: "0".repeat(64) } : {}),
        } });
        assert.equal(rejected.isError, true, `${tool}: ${name}`);
        if (name === "video stream exhausted") assert.match(toolErrorText(rejected), /video stream bounds/);
        if (name === "illegal XML title") assert.match(toolErrorText(rejected), /illegal XML character/);
        if (tool === "headless.edit-json.preview" && name === "source start between source frames") {
          assert.match(toolErrorText(rejected), /source frame grid/);
        }
      }
    }
    const futureRevision = { ...b.project.timeline.revision, id: "future-revision", sequence: b.project.timeline.revision.sequence + 1 };
    assert.throws(() => externalEditOperations(edit, b.project.timeline, futureRevision), /PROJECT_EDIT_STALE_REVISION/);
    for (const tool of ["headless.edit-json.preview", "headless.edit-json.execute"]) {
      const rejected = await client.callTool({ name: tool, arguments: { projectId, sequenceId: timeline.sequence.id,
        expectedRevision: a.project.timeline.revision, edit,
        ...(tool === "headless.edit-json.execute" ? { approved: true, planDigest: "0".repeat(64) } : {}) } });
      assert.equal(rejected.isError, true);
      assert.match(toolErrorText(rejected), /PROJECT_EDIT_STALE_REVISION/);
    }
    const preview = payload(await client.callTool({ name: "headless.edit-json.preview", arguments: {
      projectId, sequenceId: timeline.sequence.id, expectedRevision: b.project.timeline.revision, edit,
    } }));
    assert.deepEqual(preview.after.timeline.sequence.occurrences.filter((item: any) => item.track === 0).map((item: any) => item.id), ["clip-a", "clip-b"]);
    assert.equal(preview.after.timeline.sequence.occurrences.find((item: any) => item.id === "clip-a").nativeAudioRole, "dialogue");
    assert.equal(preview.after.timeline.sequence.occurrences.find((item: any) => item.id === "clip-b").nativeAudioRole, undefined);
    assert.equal(preview.after.timeline.sequence.titles[0].text, "A日");
    assert.equal(preview.after.timeline.sequence.occurrences.find((item: any) => item.id === "music").gainDb, -12);
    const inspected = payload(await client.callTool({ name: "headless.project.inspect", arguments: { projectId } }));
    assert.deepEqual(inspected.timeline, b.project.timeline);
    assert.match(preview.planDigest, /^[a-f0-9]{64}$/);
    const renamed = `${video}.saved`;
    await rename(video, renamed);
    try {
      const missing = await client.callTool({ name: "headless.edit-json.execute", arguments: {
        projectId, sequenceId: timeline.sequence.id, expectedRevision: b.project.timeline.revision, edit, approved: true, planDigest: preview.planDigest,
      } });
      assert.equal(missing.isError, true, "missing source must block execution");
      await writeFile(video, "changed source");
      const changedSource = await client.callTool({ name: "headless.edit-json.execute", arguments: {
        projectId, sequenceId: timeline.sequence.id, expectedRevision: b.project.timeline.revision, edit, approved: true, planDigest: preview.planDigest,
      } });
      assert.equal(changedSource.isError, true, "changed source must block execution");
      await unlink(video);
    } finally {
      await rename(renamed, video);
    }
    const notApproved = await client.callTool({ name: "headless.edit-json.execute", arguments: {
      projectId, sequenceId: timeline.sequence.id, expectedRevision: b.project.timeline.revision, edit, approved: false, planDigest: preview.planDigest,
    } });
    assert.equal(notApproved.isError, true, "execution requires explicit approval");
    const changed = await client.callTool({ name: "headless.edit-json.execute", arguments: {
      projectId, sequenceId: timeline.sequence.id, expectedRevision: b.project.timeline.revision,
      edit: { ...edit, title: { ...edit.title, text: "日A" } }, approved: true, planDigest: preview.planDigest,
    } });
    assert.equal(changed.isError, true, "execute must reject a different edit than the preview");
    const changedRole = await client.callTool({ name: "headless.edit-json.execute", arguments: {
      projectId, sequenceId: timeline.sequence.id, expectedRevision: b.project.timeline.revision,
      edit: { ...edit, clips: [{ ...edit.clips[0], nativeAudioRole: "dialogue.alternate" }, edit.clips[1]] }, approved: true, planDigest: preview.planDigest,
    } });
    assert.equal(changedRole.isError, true, "execute must reject a role different from the approved preview");
    assert.match(toolErrorText(changedRole), /EXTERNAL_EDIT_STALE_PREVIEW/);
    assert.deepEqual(payload(await client.callTool({ name: "headless.project.inspect", arguments: { projectId } })).timeline, b.project.timeline);
    const executed = payload(await client.callTool({ name: "headless.edit-json.execute", arguments: {
      projectId, sequenceId: timeline.sequence.id, expectedRevision: b.project.timeline.revision, edit, approved: true, planDigest: preview.planDigest,
    } }));
    assert.equal(executed.committed, true);
    const stale = await client.callTool({ name: "headless.edit-json.execute", arguments: {
      projectId, sequenceId: timeline.sequence.id, expectedRevision: b.project.timeline.revision, edit, approved: true, planDigest: preview.planDigest,
    } });
    assert.equal(stale.isError, true, "a stale preview cannot be executed again");
    const secondEdit = { ...edit, clips: edit.clips.map((clip) => ({ ...clip, id: `second-${clip.id}` })),
      title: { ...edit.title, id: "second-title" }, music: { ...edit.music, id: "second-music" } };
    const nonempty = await client.callTool({ name: "headless.edit-json.preview", arguments: {
      projectId, sequenceId: timeline.sequence.id, expectedRevision: executed.after.timeline.revision, edit: secondEdit,
    } });
    assert.equal(nonempty.isError, true, "a complete external edit must not silently append to an existing timeline");
    assert.deepEqual(executed.after.timeline.sequence.occurrences.filter((item: any) => item.track === 0).map((item: any) => item.id), ["clip-a", "clip-b"]);
    const xmlPath = join(directory, "edit.fcpxml");
    const target = { provider: "final-cut", libraryUid: "library", eventUid: "event", projectUid: "project", sequenceUid: "sequence", materialization: "versioned" };
    const exported = payload(await client.callTool({ name: "headless.fcpxml.export", arguments: {
      projectId, sequenceId: timeline.sequence.id, expectedRevision: executed.after.timeline.revision, outputPath: xmlPath, target,
    } }));
    assert.equal(exported.artifact.verified, true);
    assert.equal(exported.provenance.revision.id, executed.after.timeline.revision.id);
    const parsed = await new FcpxmlDocumentAdapter(xmlPath).readProject();
    assert.equal(parsed.timeline.clips.find((clip) => clip.id === "clip-a")?.nativeAudioRole, "dialogue");
    assert.match(await readFile(xmlPath, "utf8"), /<asset-clip[^>]*audioRole="dialogue"/);
    const sourceFor = (id: string | undefined) => parsed.media.find((item) => item.mediaId === id)?.source;
    assert.deepEqual(parsed.timeline.clips.filter((clip) => [video, video2].includes(sourceFor(clip.mediaId) ?? "")).map((clip) => [sourceFor(clip.mediaId), clip.sourceStart, clip.duration]), [[video, 0, 1], [video2, 0, 1]]);
    assert.deepEqual(parsed.timeline.clips.filter((clip) => sourceFor(clip.mediaId) === music).map((clip) => [clip.sourceStart, clip.duration]), [[0, 2]]);
    assert.equal(parsed.timeline.storyElements.find((item) => item.kind === "title")?.text, "A日");
    assert.match(await readFile(xmlPath, "utf8"), /<adjust-volume amount="-12dB" \/>/);
    assert.deepEqual(await Promise.all(sourcePaths.map(async (path) => createHash("sha256").update(await readFile(path)).digest("hex"))), sourceDigests);
    assert.equal(await readFile(reservationPath, "utf8"), reservation);
    assert.equal(existsSync(calls), false, "JSON workflow must not invoke native commands");
  } finally {
    await client?.close();
    await transport?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rough cut binds appended titles to an existing selected font", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-review-title-"));
  try {
    await execFileAsync(process.execPath, ["scripts/generate-headless-render-fixtures.mjs", directory], { cwd: process.cwd(), env: process.env });
    const service = new HeadlessProjectService({ directory: join(directory, "projects"), mediaProbe: new FfmpegMediaMetadataProbe(), renderer: new FfmpegTimelineRenderer(), verifier: new FfmpegRenderVerifier() });
    const created = await service.create(emptyTimeline());
    const registered = await service.registerMedia(created.timeline.project.id, join(directory, "fixture-red-440hz.mp4"), created.timeline.revision);
    const font = service.selectTitleFont(["FIRST", "SECOND"]);
    const edit = await service.executeEdit(created.timeline.project.id, { schemaVersion: 1, expectedRevision: registered.project.timeline.revision, operations: [
      { type: "insert-occurrence", placement: "append", occurrence: occurrence("first", registered.resource.id) },
      { type: "add-title", title: { id: "first-title", text: "FIRST", startTime: { value: "0", timescale: "1" }, durationTime: { value: "1", timescale: "2" }, lane: 1, font } },
    ] }, created.timeline.sequence.id);
    const source = registered.resource;
    const request = { projectId: created.timeline.project.id, sequenceId: created.timeline.sequence.id,
      plan: { planner: { id: "framekit.rough-cut", version: 1 }, revision: edit.after.timeline.revision, query: { query: "speech" }, shots: [{ order: 1, sourceIdentity: { mediaId: source.id, source: source.source!, sourceDigest: source.sourceDigest!, mediaKind: "video" as const, duration: 2 }, range: { start: 0.25, end: 1.25 }, confidence: 0.91, matchedProperties: ["query:speech"], rationale: "test" }], warnings: [] },
      operations: [{ type: "add-title" as const, title: { id: "second-title", text: "SECOND", startTime: { value: "1", timescale: "1" }, durationTime: { value: "1", timescale: "2" }, lane: 1 } }],
      render: { outputPath: join(directory, "render.mp4"), format: "mp4" as const, width: 320, height: 180, frameRate: { value: "30", timescale: "1" } },
      fcpxml: { path: join(directory, "render.fcpxml"), target: { provider: "final-cut" as const, libraryUid: "lib", eventUid: "event", projectUid: "project", sequenceUid: "sequence" } },
    };
    await assert.rejects(service.previewRoughCut({ ...request, operations: [{ ...request.operations[0]!, title: { ...request.operations[0]!.title, font: { ...font, digest: "0".repeat(64) } } }] }), /FCPXML_TITLE_FONT_MISMATCH/);
    const preview = await service.previewRoughCut(request);
    assert.deepEqual(preview.after.timeline.sequence.titles?.find((title) => title.id === "second-title")?.font, font);
    const result = await service.executeRoughCut({ ...request, approved: true, planDigest: preview.planDigest });
    assert.deepEqual(result.after.timeline.sequence.titles?.find((title) => title.id === "second-title")?.font, font);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

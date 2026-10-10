import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FcpxmlDocumentAdapter } from "@framekit/final-cut";
import { type TimelineIr } from "@framekit/runtime";
import { FfmpegMediaMetadataProbe, FfmpegRenderVerifier, FfmpegTimelineRenderer } from "../../adapters/headless/typescript/src/index.js";
import { HeadlessProjectService } from "../../apps/mcp-server/src/headless-projects.js";

const execFileAsync = promisify(execFile);

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
    const fcpxmlPath = join(directory, "issue-517-mvp.fcpxml");
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
    const preview = payload(await client.callTool({ name: "headless.rough-cut.preview", arguments: request }));
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

    const executed = payload(await client.callTool({ name: "headless.rough-cut.execute", arguments: {
      ...request, approved: true, planDigest: preview.planDigest,
    } }));
    assert.equal(executed.committed, true);
    assert.equal(executed.render.status, "passed");
    assert.equal(executed.fcpxmlArtifact.verified, true);
    assert.equal(executed.render.outcome.render.projectRevision.id, executed.after.timeline.revision.id);
    assert.equal(executed.fcpxml.provenance.revision.id, executed.after.timeline.revision.id);
    assert.equal((await stat(outputPath)).isFile(), true);
    assert.equal((await stat(fcpxmlPath)).isFile(), true);

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
    assert.match(xml, /<text>FrameKit MVP Test<\/text>/);
    assert.match(xml, /<asset-clip id="issue-517-music"[^>]*duration="30s"[^>]*lane="1"[^>]*audioRole="music"/);
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
    assert.deepEqual(fcpxmlReadback.timeline.storyElements.filter((element) => element.kind === "title").map(({ text, start, duration, lane }) => [text, start, duration, lane]), [["FrameKit MVP Test", 0, 6, 1]]);
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
    FRAMEKIT_STATE_DIR: directory,
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
      operations: [{ type: "insert-occurrence", placement: "append", occurrence: occurrence("occurrence-blue", blueResource.id) }],
    } }));
    const finished = payload(await client.callTool({ name: "headless.edit.execute", arguments: {
      projectId: "mcp-headless-project",
      sequenceId: "mcp-headless-sequence",
      expectedRevision: second.after.timeline.revision,
      operations: [
        { type: "set-gain", occurrenceId: "occurrence-red", gainDb: 6 },
        { type: "set-transform", occurrenceId: "occurrence-red", transform: { scaleX: 1.25, scaleY: 1.25 } },
        { type: "add-title", title: { id: "title-opening", text: "OPEN", startTime: { value: "0", timescale: "1" }, durationTime: { value: "1", timescale: "2" }, lane: 1 } },
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
    const preview = await service.previewRoughCut(request);
    assert.equal(preview.before.timeline.sequence.occurrences.length, 0);
    assert.deepEqual(preview.after.timeline.sequence.occurrences[0]?.sourceStartTime, { value: "1", timescale: "4" });
    assert.equal(preview.after.timeline.sequence.occurrences[0]?.durationTime.value, "1");
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

    const executed = await service.executeRoughCut({ ...request, approved: true, planDigest: preview.planDigest });
    assert.equal(executed.committed, true);
    assert.equal(executed.render.status, "passed");
    assert.equal(executed.fcpxmlArtifact.verified, true);
    assert.match(await readFile(request.fcpxml.path, "utf8"), /start="1\/4s"/);
    assert.equal((await service.open(created.timeline.project.id)).timeline.revision.sequence, registered.project.timeline.revision.sequence + 1);
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
    args: ["--import", "tsx", join(here, "../../apps/mcp-server/src/main.ts")],
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "headless-project-production-stdio-test", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
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

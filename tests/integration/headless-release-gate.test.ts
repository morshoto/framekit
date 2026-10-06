import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { TimelineIr } from "@framekit/runtime";

const execFileAsync = promisify(execFile);

test("production stdio MCP completes the v0.1.15 headless edit-to-video release gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headless-release-gate-"));
  const fixtureDirectory = join(directory, "fixtures");
  const stateDirectory = join(directory, "state");
  const outputPath = join(directory, "verified-final.mp4");
  const toolTranscript: ToolTranscriptEntry[] = [];
  const serverLogs: string[] = [];
  const evidenceDirectory = process.env.FRAMEKIT_HEADLESS_RELEASE_GATE_EVIDENCE_DIR;
  const evidenceState: Record<string, any> = {};
  try {
    await execFileAsync(process.execPath, ["scripts/generate-headless-render-fixtures.mjs", fixtureDirectory], {
      cwd: process.cwd(),
      env: process.env,
    });
    const fixtureManifest = JSON.parse(await readFile(join(fixtureDirectory, "manifest.json"), "utf8")) as {
      expectedWorkflow: {
        sourceOrder: string[];
        sourceRanges: Array<{ sourceId: string; startTime: { value: string; timescale: string }; durationTime: { value: string; timescale: string } }>;
        titleWindows: Array<{ id: string; startTime: { value: string; timescale: string }; durationTime: { value: string; timescale: string }; position: { x: number; y: number } }>;
        transition: { kind: "cross-dissolve"; durationTime: { value: string; timescale: string } };
        transform: { scaleX: number; scaleY: number };
        audioGainDb: number;
        output: { width: number; height: number; frameRate: { value: string; timescale: string }; durationSeconds: number };
      };
    };
    assert.deepEqual(fixtureManifest.expectedWorkflow.sourceOrder, ["fixture-red-440hz", "fixture-blue-880hz"]);
    assert.deepEqual(fixtureManifest.expectedWorkflow.sourceRanges.map(({ sourceId }) => sourceId), fixtureManifest.expectedWorkflow.sourceOrder);
    const sourcePaths = [
      join(fixtureDirectory, "fixture-red-440hz.mp4"),
      join(fixtureDirectory, "fixture-blue-880hz.mp4"),
      join(fixtureDirectory, "fixture-green-1320hz.mp4"),
    ];
    const sourceDigestsBefore = await Promise.all(sourcePaths.map(digest));

    const first = await connectProductionServer(stateDirectory, "server-1", directory, toolTranscript, serverLogs);
    let projectBeforeRestart: any;
    let projectAfterUnsupportedRender: any;
    let renderId: string;
    try {
      const tools = await first.client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === "headless.project.create"));
      assert.match(first.client.getInstructions() ?? "", /headless Framekit-owned project/i);

      const route = payload(await first.client.callTool({
        name: "editing.route",
        arguments: { operation: "timeline.edit" },
      }));
      assert.equal(route.status, "unavailable");
      assert.equal(route.selectedPath, "none");
      assert.equal(route.reason.code, "HEADLESS_UNAVAILABLE");
      assert.deepEqual(route.missingCapabilities, ["headless.timeline.edit"]);

      const created = payload(await first.client.callTool({
        name: "headless.project.create",
        arguments: { timeline: emptyTimeline() },
      }));
      evidenceState.createdProject = created;
      const projectId = created.timeline.project.id;
      const sequenceId = created.timeline.sequence.id;
      const supportedRoute = payload(await first.client.callTool({
        name: "editing.route",
        arguments: { operation: "timeline.edit", editType: "insert-occurrence" },
      }));
      assert.equal(supportedRoute.status, "headless-selected");
      assert.equal(supportedRoute.selectedPath, "headless");
      assert.equal(supportedRoute.reason.code, "HEADLESS_SELECTED");
      evidenceState.routing = { unsupported: route, supported: supportedRoute };

      const registrations: any[] = [];
      let revision = created.timeline.revision;
      for (const sourcePath of sourcePaths) {
        const registered = payload(await first.client.callTool({
          name: "headless.media.register",
          arguments: { projectId, sourcePath, expectedRevision: revision },
        }));
        registrations.push(registered.resource);
        revision = registered.project.timeline.revision;
      }
      assert.equal(registrations.length, 3);
      evidenceState.mediaRegistrations = registrations;
      evidenceState.revisionAfterMediaRegistration = revision;

      const beforePreview = payload(await first.client.callTool({
        name: "headless.project.inspect",
        arguments: { projectId },
      }));
      const preview = payload(await first.client.callTool({
        name: "headless.edit.preview",
        arguments: {
          projectId,
          sequenceId,
          expectedRevision: revision,
          operations: [{
            type: "insert-occurrence",
            placement: "append",
            occurrence: occurrence("occurrence-red", registrations[0].id, fixtureManifest.expectedWorkflow.sourceRanges[0]),
          }],
        },
      }));
      assert.equal(preview.before.timeline.revision.sequence, revision.sequence);
      assert.equal(preview.after.timeline.sequence.occurrences.length, 1);
      assert.deepEqual(payload(await first.client.callTool({
        name: "headless.project.inspect",
        arguments: { projectId },
      })), beforePreview, "preview must not mutate the project");

      const firstEdit = payload(await first.client.callTool({
        name: "headless.edit.execute",
        arguments: {
          projectId,
          sequenceId,
          expectedRevision: revision,
          operations: [{
            type: "insert-occurrence",
            placement: "append",
            occurrence: occurrence("occurrence-red", registrations[0].id, fixtureManifest.expectedWorkflow.sourceRanges[0]),
          }],
        },
      }));
      const secondEdit = payload(await first.client.callTool({
        name: "headless.edit.execute",
        arguments: {
          projectId,
          sequenceId,
          expectedRevision: firstEdit.after.timeline.revision,
          operations: [{
            type: "insert-occurrence",
            placement: "append",
            occurrence: occurrence("occurrence-blue", registrations[1].id, fixtureManifest.expectedWorkflow.sourceRanges[1]),
          }],
        },
      }));
      const finished = payload(await first.client.callTool({
        name: "headless.edit.execute",
        arguments: {
          projectId,
          sequenceId,
          expectedRevision: secondEdit.after.timeline.revision,
          operations: [
            { type: "set-gain", occurrenceId: "occurrence-red", gainDb: fixtureManifest.expectedWorkflow.audioGainDb },
            { type: "set-transform", occurrenceId: "occurrence-blue", transform: fixtureManifest.expectedWorkflow.transform },
            { type: "add-title", title: { ...fixtureManifest.expectedWorkflow.titleWindows[0], text: "OPEN", lane: 1, style: { fontSize: 24, color: "white", alignment: "center" } } },
            { type: "add-title", title: { ...fixtureManifest.expectedWorkflow.titleWindows[1], text: "CLOSE", lane: 1, style: { fontSize: 24, color: "white", alignment: "center" } } },
            { type: "add-transition", transition: { id: "transition-red-blue", kind: fixtureManifest.expectedWorkflow.transition.kind, beforeOccurrenceId: "occurrence-red", afterOccurrenceId: "occurrence-blue", durationTime: fixtureManifest.expectedWorkflow.transition.durationTime } },
          ],
        },
      }));
      evidenceState.finalProjectAfterEdits = finished.after;
      assert.equal(finished.after.timeline.resources.length, 3);
      assert.deepEqual(finished.after.timeline.sequence.occurrences.map((item: { id: string }) => item.id), ["occurrence-red", "occurrence-blue"]);
      assert.equal(finished.after.timeline.sequence.titles?.length, 2);
      assert.equal(finished.after.timeline.sequence.transitions?.length, 1);
      assert.deepEqual(finished.after.timeline.sequence.occurrences.map((item: any) => ({
        id: item.id,
        startTime: item.startTime,
        sourceStartTime: item.sourceStartTime,
        durationTime: item.durationTime,
      })), [
        { id: "occurrence-red", startTime: { value: "0", timescale: "1" }, sourceStartTime: fixtureManifest.expectedWorkflow.sourceRanges[0].startTime, durationTime: fixtureManifest.expectedWorkflow.sourceRanges[0].durationTime },
        { id: "occurrence-blue", startTime: { value: "1", timescale: "1" }, sourceStartTime: fixtureManifest.expectedWorkflow.sourceRanges[1].startTime, durationTime: fixtureManifest.expectedWorkflow.sourceRanges[1].durationTime },
      ]);
      assert.deepEqual(finished.after.timeline.sequence.occurrences.map((item: any) => item.gainDb ?? 0), [fixtureManifest.expectedWorkflow.audioGainDb, 0]);
      assert.deepEqual(finished.after.timeline.sequence.occurrences[1].transform, fixtureManifest.expectedWorkflow.transform);
      assert.deepEqual(finished.after.timeline.sequence.titles?.map((title: any) => ({
        id: title.id,
        startTime: title.startTime,
        durationTime: title.durationTime,
        position: title.position,
      })), [
        ...fixtureManifest.expectedWorkflow.titleWindows,
      ]);
      assert.deepEqual(finished.after.timeline.sequence.transitions?.[0], {
        id: "transition-red-blue",
        kind: fixtureManifest.expectedWorkflow.transition.kind,
        beforeOccurrenceId: "occurrence-red",
        afterOccurrenceId: "occurrence-blue",
        durationTime: fixtureManifest.expectedWorkflow.transition.durationTime,
      });

      const stale = await first.client.callTool({
        name: "headless.edit.execute",
        arguments: {
          projectId,
          sequenceId,
          expectedRevision: revision,
          operations: [{ type: "rename-occurrence", occurrenceId: "occurrence-red", name: "stale" }],
        },
      });
      assert.equal(stale.isError, true);
      assert.equal(errorPayload(stale).code, "PROJECT_EDIT_STALE_REVISION");

      projectBeforeRestart = payload(await first.client.callTool({
        name: "headless.project.inspect",
        arguments: { projectId },
      }));
      assert.equal(projectBeforeRestart.timeline.revision.id, finished.after.timeline.revision.id);
    } finally {
      await first.client.close();
      await first.transport.close();
    }

    const second = await connectProductionServer(stateDirectory, "server-2", directory, toolTranscript, serverLogs);
    try {
      const projectId = projectBeforeRestart.timeline.project.id;
      const sequenceId = projectBeforeRestart.timeline.sequence.id;
      const reopened = payload(await second.client.callTool({
        name: "headless.project.open",
        arguments: { projectId },
      }));
      assert.deepEqual(reopened, projectBeforeRestart, "the persisted canonical project must survive restart");
      assert.equal(reopened.timeline.resources.length, 3);

      const render = payload(await second.client.callTool({
        name: "headless.render",
        arguments: {
          projectId,
          sequenceId,
          expectedRevision: reopened.timeline.revision,
          parameters: {
            outputPath,
            format: "mp4",
            width: fixtureManifest.expectedWorkflow.output.width,
            height: fixtureManifest.expectedWorkflow.output.height,
            frameRate: fixtureManifest.expectedWorkflow.output.frameRate,
          },
        },
      }));
      evidenceState.renderResponse = render;
      renderId = render.renderId;
      assert.equal(render.status, "passed");
      assert.equal(render.outcome.verification.status, "passed");
      assert.equal(render.outcome.render.projectRevision.id, reopened.timeline.revision.id);
      assert.equal(render.outcome.render.renderer.id, "ffmpeg-headless");
      assert.equal(render.outcome.render.verificationRequired, true);

      const inspectedRender = payload(await second.client.callTool({
        name: "headless.render.inspect",
        arguments: { renderId: render.renderId },
      }));
      evidenceState.renderRecordAfterFirstRender = inspectedRender;
      assert.equal(inspectedRender.status, "passed");
      assert.equal(inspectedRender.requestedRevision.id, reopened.timeline.revision.id);
      assert.equal(inspectedRender.outcome.verification.artifact.fileDigest, await digest(outputPath));

      const probe = JSON.parse((await execFileAsync(process.env.FFPROBE_BIN || "ffprobe", [
        "-v", "error",
        "-show_entries", "stream=codec_type,width,height,r_frame_rate,sample_rate,channels",
        "-show_entries", "format=duration",
        "-of", "json",
        outputPath,
      ], { env: process.env })).stdout) as {
        streams: Array<Record<string, string | number>>;
        format: { duration: string };
      };
      evidenceState.ffprobe = probe;
      const video = probe.streams.find((stream) => stream.codec_type === "video");
      const audio = probe.streams.find((stream) => stream.codec_type === "audio");
      assert.equal(video?.width, fixtureManifest.expectedWorkflow.output.width);
      assert.equal(video?.height, fixtureManifest.expectedWorkflow.output.height);
      assert.equal(video?.r_frame_rate, `${fixtureManifest.expectedWorkflow.output.frameRate.value}/${fixtureManifest.expectedWorkflow.output.frameRate.timescale}`);
      assert.equal(audio?.sample_rate, "48000");
      assert.equal(audio?.channels, 1);
      assert.ok(Math.abs(Number(probe.format.duration) - fixtureManifest.expectedWorkflow.output.durationSeconds) < 0.05);

      const earlyFrame = await frameAt(outputPath, 0.25, directory, "release-gate-red");
      const transitionFrame = await frameAt(outputPath, 0.9, directory, "release-gate-transition");
      const lateFrame = await frameAt(outputPath, 1.3, directory, "release-gate-blue");
      const rangedAndTransformedBlueFrame = await frameAt(outputPath, 1.4, directory, "release-gate-ranged-transform");
      const openingTitleFrame = await frameAt(outputPath, 0.25, directory, "release-gate-opening-title");
      const noOpeningTitleFrame = await frameAt(outputPath, 0.75, directory, "release-gate-no-opening-title");
      const closingTitleFrame = await frameAt(outputPath, 1.75, directory, "release-gate-closing-title");
      const noClosingTitleFrame = await frameAt(outputPath, 1.4, directory, "release-gate-no-closing-title");
      const earlyPixel = ppmPixel(earlyFrame, 10, 160);
      const transitionPixel = ppmPixel(transitionFrame, 10, 160);
      const latePixel = ppmPixel(lateFrame, 10, 160);
      const rangedSourcePixel = ppmPixel(rangedAndTransformedBlueFrame, 160, 150);
      const scaledMarkerPixel = ppmPixel(rangedAndTransformedBlueFrame, 20, 90);
      assert.ok(earlyPixel.r > 150 && earlyPixel.b < 80, `expected red first source, got ${JSON.stringify(earlyPixel)}`);
      assert.ok(transitionPixel.r > 20 && transitionPixel.b > 20, `expected red/blue cross-dissolve blend, got ${JSON.stringify(transitionPixel)}`);
      assert.ok(latePixel.g > 150 && latePixel.b > 150 && latePixel.r < 80, `expected cyan second source, got ${JSON.stringify(latePixel)}`);
      assert.ok(rangedSourcePixel.g > 150 && rangedSourcePixel.b > 150 && rangedSourcePixel.r < 80, `expected non-zero source range to select the cyan scene, got ${JSON.stringify(rangedSourcePixel)}`);
      assert.ok(scaledMarkerPixel.r > 150 && scaledMarkerPixel.g > 150 && scaledMarkerPixel.b > 150, `expected scale 1.25 to move the white marker over the left edge, got ${JSON.stringify(scaledMarkerPixel)}`);
      assert.ok(countBrightPixels(openingTitleFrame, 80, 240, 40, 140) > countBrightPixels(noOpeningTitleFrame, 80, 240, 40, 140) + 5, "opening title must appear during its canonical window near normalized center");
      assert.ok(countBrightPixels(closingTitleFrame, 40, 120, 20, 60) > countBrightPixels(noClosingTitleFrame, 40, 120, 20, 60) + 5, "closing title must appear in the normalized upper-left position only during its canonical window");
      const sourceMeanVolume = await meanVolume(sourcePaths[0], 0.35);
      const outputMeanVolume = await meanVolume(outputPath, 0.1);
      assert.ok(Math.abs((outputMeanVolume - sourceMeanVolume) - fixtureManifest.expectedWorkflow.audioGainDb) < 1.5, `expected +${fixtureManifest.expectedWorkflow.audioGainDb} dB gain on the red source, got ${outputMeanVolume - sourceMeanVolume} dB`);
      evidenceState.semanticObservations = {
        redSourceAtSeconds: { seconds: 0.25, pixel: earlyPixel },
        crossDissolveAtSeconds: { seconds: 0.9, pixel: transitionPixel },
        cyanSourceAtSeconds: { seconds: 1.3, pixel: latePixel },
        nonZeroSourceRangeAtSeconds: { seconds: 1.4, pixel: rangedSourcePixel },
        transformedMarkerAtSeconds: { seconds: 1.4, pixel: scaledMarkerPixel },
        openingTitleBrightPixels: {
          duringWindow: countBrightPixels(openingTitleFrame, 80, 240, 40, 140),
          outsideWindow: countBrightPixels(noOpeningTitleFrame, 80, 240, 40, 140),
        },
        closingTitleBrightPixels: {
          duringWindow: countBrightPixels(closingTitleFrame, 40, 120, 20, 60),
          outsideWindow: countBrightPixels(noClosingTitleFrame, 40, 120, 20, 60),
        },
        audioGain: {
          sourceMeanDb: sourceMeanVolume,
          outputMeanDb: outputMeanVolume,
          observedGainDb: outputMeanVolume - sourceMeanVolume,
          expectedGainDb: fixtureManifest.expectedWorkflow.audioGainDb,
          toleranceDb: 1.5,
        },
      };

      const unsupportedPreview = payload(await second.client.callTool({
        name: "headless.edit.preview",
        arguments: {
          projectId,
          sequenceId,
          expectedRevision: reopened.timeline.revision,
          operations: [{ type: "set-transform", occurrenceId: "occurrence-red", transform: { scaleX: 1.25, scaleY: 1.25, rotationDegrees: 5 } }],
        },
      }));
      const unsupportedProject = payload(await second.client.callTool({
        name: "headless.edit.execute",
        arguments: {
          projectId,
          sequenceId,
          expectedRevision: reopened.timeline.revision,
          operations: [{ type: "set-transform", occurrenceId: "occurrence-red", transform: { scaleX: 1.25, scaleY: 1.25, rotationDegrees: 5 } }],
        },
      }));
      assert.equal(unsupportedPreview.after.timeline.revision.sequence, reopened.timeline.revision.sequence);
      assert.equal(unsupportedProject.after.timeline.revision.sequence, reopened.timeline.revision.sequence + 1);
      const beforeUnsupportedRender = payload(await second.client.callTool({
        name: "headless.project.inspect",
        arguments: { projectId },
      }));
      const unsupportedRender = payload(await second.client.callTool({
        name: "headless.render",
        arguments: {
          projectId,
          sequenceId,
          expectedRevision: unsupportedProject.after.timeline.revision,
          parameters: { outputPath: join(directory, "unsupported.mp4"), format: "mp4", width: 320, height: 180, frameRate: { value: "30", timescale: "1" } },
        },
      }));
      assert.equal(unsupportedRender.status, "unavailable", JSON.stringify(unsupportedRender));
      assert.equal(unsupportedRender.error?.code ?? unsupportedRender.outcome?.error?.code, "RENDER_CAPABILITY_UNAVAILABLE", JSON.stringify(unsupportedRender));
      await assert.rejects(stat(join(directory, "unsupported.mp4")), { code: "ENOENT" });
      projectAfterUnsupportedRender = payload(await second.client.callTool({
        name: "headless.project.inspect",
        arguments: { projectId },
      }));
      assert.deepEqual(projectAfterUnsupportedRender, beforeUnsupportedRender, "failed render must not mutate the project");
      evidenceState.projectAfterUnsupportedRender = projectAfterUnsupportedRender;
    } finally {
      await second.client.close();
      await second.transport.close();
    }

    const third = await connectProductionServer(stateDirectory, "server-3", directory, toolTranscript, serverLogs);
    try {
      const projectId = projectBeforeRestart.timeline.project.id;
      const reopenedAfterRender = payload(await third.client.callTool({
        name: "headless.project.open",
        arguments: { projectId },
      }));
      evidenceState.projectAfterThirdRestart = reopenedAfterRender;
      assert.equal(reopenedAfterRender.timeline.project.id, projectBeforeRestart.timeline.project.id);
      assert.equal(reopenedAfterRender.timeline.sequence.id, projectBeforeRestart.timeline.sequence.id);
      assert.equal(reopenedAfterRender.timeline.revision.id, projectAfterUnsupportedRender.timeline.revision.id);
      assert.deepEqual(reopenedAfterRender.timeline.sequence, projectAfterUnsupportedRender.timeline.sequence);
      const reopenedRender = payload(await third.client.callTool({
        name: "headless.render.inspect",
        arguments: { renderId },
      }));
      evidenceState.renderRecordAfterThirdRestart = reopenedRender;
      assert.equal(reopenedRender.status, "passed");
      assert.equal(reopenedRender.requestedRevision.id, projectBeforeRestart.timeline.revision.id);
      assert.equal(reopenedRender.outcome.verification.artifact.fileDigest, await digest(outputPath));
    } finally {
      await third.client.close();
      await third.transport.close();
    }

    const sourceDigestsAfter = await Promise.all(sourcePaths.map(digest));
    assert.deepEqual(sourceDigestsAfter, sourceDigestsBefore, "source media must remain unchanged");
    if (evidenceDirectory) {
      const artifactDigest = await digest(outputPath);
      const artifactStats = await stat(outputPath);
      const gitHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: process.cwd() })).stdout.trim();
      const nativeToolCalls = toolTranscript.filter((entry) => /final.?cut|native|accessibility|system.?events|keyboard|mouse|clipboard/i.test(entry.request.name));
      const nativeUiLogMarkers = serverLogs.filter((line) => /osascript|System Events|Accessibility|AppleEvent|Final Cut.*(?:launch|activat|connect)/i.test(line));
      assert.deepEqual(nativeToolCalls, [], "the production MCP transcript must not invoke a native or UI tool");
      assert.deepEqual(nativeUiLogMarkers, [], "the production MCP server logs must not show native or UI execution");
      const renderOutcome = evidenceState.renderResponse.outcome;
      assert.equal(renderOutcome.render.planDigest, renderOutcome.plan.planDigest);
      assert.equal(renderOutcome.verification.artifact.fileDigest, artifactDigest);
      assert.equal(evidenceState.renderRecordAfterThirdRestart.outcome.verification.artifact.fileDigest, artifactDigest);
      assert.ok(renderOutcome.verification.checks.every((check: { passed: boolean }) => check.passed));
      await mkdir(evidenceDirectory, { recursive: true });
      await copyFile(outputPath, join(evidenceDirectory, "verified-final.mp4"));
      await copyFile(join(fixtureDirectory, "manifest.json"), join(evidenceDirectory, "fixture-manifest.json"));
      const evidence = sanitizeEvidence({
        schemaVersion: 1,
        candidate: {
          headSha: process.env.FRAMEKIT_HEADLESS_RELEASE_GATE_CANDIDATE_SHA ?? gitHead,
          checkedOutGitHead: gitHead,
          githubRunSha: process.env.GITHUB_SHA ?? null,
          githubHeadRef: process.env.GITHUB_HEAD_REF ?? null,
        },
        productionMcp: {
          command: `${process.execPath.split("/").at(-1)} --import tsx apps/mcp-server/src/main.ts`,
          client: { name: "framekit-v0.1.15-release-gate", version: "0.1.15" },
          serversStarted: 3,
          environment: {
            FRAMEKIT_EDITOR: "fixture",
            FRAMEKIT_AUTO_CONNECT: "0",
            FRAMEKIT_FCPXML_PATH: "unset",
            FRAMEKIT_FINAL_CUT_SOCKET: "unset",
          },
          nativeExecutionAudit: {
            provider: "fixture",
            finalCutNativeSocketConfigured: false,
            finalCutXmlConfigured: false,
            nativeOrUiToolCalls: nativeToolCalls.length,
            nativeUiLogMarkers,
          },
          nativeOrUiToolCalls: nativeToolCalls.length,
          stderrLogs: serverLogs,
          toolTranscript,
        },
        fixture: {
          expectedWorkflow: fixtureManifest.expectedWorkflow,
          sourceDigestsBefore: Object.fromEntries(sourcePaths.map((path, index) => [path.split("/").at(-1), sourceDigestsBefore[index]])),
          sourceDigestsAfter: Object.fromEntries(sourcePaths.map((path, index) => [path.split("/").at(-1), sourceDigestsAfter[index]])),
          registeredMedia: evidenceState.mediaRegistrations,
        },
        project: {
          created: evidenceState.createdProject,
          revisionAfterMediaRegistration: evidenceState.revisionAfterMediaRegistration,
          finalAfterEdits: evidenceState.finalProjectAfterEdits,
          afterFirstServerRestart: projectBeforeRestart,
          afterUnsupportedRender: evidenceState.projectAfterUnsupportedRender,
          afterThirdServerRestart: evidenceState.projectAfterThirdRestart,
        },
        render: {
          firstResponse: evidenceState.renderResponse,
          firstPersistedRecord: evidenceState.renderRecordAfterFirstRender,
          afterThirdServerRestart: evidenceState.renderRecordAfterThirdRestart,
          planDigest: evidenceState.renderResponse.outcome.plan.planDigest,
          renderer: evidenceState.renderResponse.outcome.render.renderer,
          verificationChecks: evidenceState.renderResponse.outcome.verification.checks,
          ffprobe: evidenceState.ffprobe,
          semanticObservations: evidenceState.semanticObservations,
          artifact: { file: "verified-final.mp4", sha256: artifactDigest, sizeBytes: artifactStats.size },
        },
        assertions: { allReleaseGateAssertionsPassed: true, sourceMediaUnchanged: true, unsupportedRenderDidNotMutateProject: true },
      }, directory);
      await writeFile(join(evidenceDirectory, "headless-release-gate-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

type ToolTranscriptEntry = {
  server: string;
  request: { name: string; arguments: unknown };
  response: { isError: boolean; body: unknown };
};

async function connectProductionServer(
  stateDirectory: string,
  serverName: string,
  runDirectory: string,
  transcript: ToolTranscriptEntry[],
  serverLogs: string[],
): Promise<{ client: Client; transport: StdioClientTransport }> {
  const environment: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    FRAMEKIT_EDITOR: "fixture",
    FRAMEKIT_AUTO_CONNECT: "0",
    FRAMEKIT_STATE_DIR: stateDirectory,
  };
  delete environment.FRAMEKIT_FCPXML_PATH;
  delete environment.FRAMEKIT_FINAL_CUT_SOCKET;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "apps/mcp-server/src/main.ts"],
    cwd: process.cwd(),
    env: environment,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    serverLogs.push(String(chunk).replaceAll(runDirectory, "<run-root>"));
  });
  const client = new Client({ name: "framekit-v0.1.15-release-gate", version: "0.1.15" });
  captureToolTranscript(client, serverName, runDirectory, transcript);
  await client.connect(transport);
  return { client, transport };
}

function captureToolTranscript(client: Client, serverName: string, runDirectory: string, transcript: ToolTranscriptEntry[]): void {
  const instrumentedClient = client as unknown as { callTool: (...args: any[]) => Promise<any> };
  const callTool = client.callTool.bind(client) as (...args: any[]) => Promise<any>;
  instrumentedClient.callTool = async (...args: any[]) => {
    const response = await callTool(...args);
    const request = args[0] as { name: string; arguments?: unknown };
    const text = response.content?.find((item: { type?: string }) => item.type === "text")?.text;
    let body: unknown = text ?? null;
    if (typeof text === "string") {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    transcript.push(sanitizeEvidence({
      server: serverName,
      request: { name: request.name, arguments: request.arguments ?? {} },
      response: { isError: Boolean(response.isError), body },
    }, runDirectory) as ToolTranscriptEntry);
    return response;
  };
}

function sanitizeEvidence(value: unknown, runDirectory: string): unknown {
  if (typeof value === "string") return value.replaceAll(runDirectory, "<run-root>").replaceAll(process.cwd(), "<repository>");
  if (Array.isArray(value)) return value.map((entry) => sanitizeEvidence(entry, runDirectory));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeEvidence(entry, runDirectory)]));
  }
  return value;
}

function emptyTimeline(): TimelineIr {
  return {
    schemaVersion: 1,
    project: { id: "release-gate-project", name: "v0.1.15 Headless Release Gate" },
    sequence: {
      id: "release-gate-sequence",
      name: "Master",
      durationTime: { value: "0", timescale: "1" },
      frameDuration: { value: "1", timescale: "30" },
      occurrences: [],
      storyElements: [],
      markers: [],
      captions: [],
      titles: [],
      transitions: [],
    },
    resources: [],
    revision: { id: "release-gate-revision-0", sequence: 0, timestamp: "2026-10-05T00:00:00.000Z" },
  };
}

function occurrence(
  id: string,
  mediaId: string,
  sourceRange: { startTime: { value: string; timescale: string }; durationTime: { value: string; timescale: string } },
) {
  return {
    id,
    name: id,
    startTime: { value: "0", timescale: "1" },
    durationTime: sourceRange.durationTime,
    sourceStartTime: sourceRange.startTime,
    track: 0,
    role: "video" as const,
    mediaId,
  };
}

async function frameAt(videoPath: string, seconds: number, directory: string, label: string): Promise<Buffer> {
  const framePath = join(directory, `${label}.ppm`);
  await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-i", videoPath, "-ss", String(seconds), "-frames:v", "1", "-f", "image2", framePath], { env: process.env });
  return readFile(framePath);
}

function ppmPixel(contents: Buffer, x: number, y: number): { r: number; g: number; b: number } {
  const headerEnd = contents.indexOf(Buffer.from("\n255\n")) + "\n255\n".length;
  const header = contents.subarray(0, headerEnd).toString("ascii").trim().split(/\s+/);
  const width = Number(header[1]);
  const offset = headerEnd + (y * width + x) * 3;
  return { r: contents[offset]!, g: contents[offset + 1]!, b: contents[offset + 2]! };
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

async function meanVolume(videoPath: string, startSeconds: number): Promise<number> {
  const result = await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "info", "-ss", String(startSeconds), "-t", "0.5", "-i", videoPath, "-af", "volumedetect", "-f", "null", "-"], { env: process.env, maxBuffer: 8 * 1024 * 1024 });
  const match = result.stderr.match(/mean_volume:\s*(-?[0-9.]+) dB/);
  assert.ok(match, `volumedetect did not produce mean volume for ${videoPath}`);
  return Number(match[1]);
}

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function payload(result: unknown): any {
  const value = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  assert.equal(value.isError, undefined, value.content?.[0]?.text);
  assert.equal(value.content?.[0]?.type, "text");
  return JSON.parse(value.content?.[0]?.text ?? "null");
}

function errorPayload(result: unknown): { code: string; message: string } {
  const value = result as { content?: Array<{ text?: string }> };
  return JSON.parse(value.content?.[0]?.text ?? "null") as { code: string; message: string };
}

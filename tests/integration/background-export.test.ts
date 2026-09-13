import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BackgroundRenderExportProvider,
  type BackgroundRenderRequest,
} from "@framekit/final-cut";

function stagingPathFromRequest(request: BackgroundRenderRequest): string {
  assert.match(request.outputPath, /\.framekit-/);
  return request.outputPath;
}

test("background renderer reports progress and commits verified external output", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-background-export-"));
  const outputPath = join(directory, "final.mp4");
  const artifactPath = join(directory, "timeline.fcpxml");
  await writeFile(artifactPath, "source artifact");
  const progress: string[] = [];

  const provider = new BackgroundRenderExportProvider({
    enabled: true,
    renderer: async ({ request, stagingPath, reportProgress }) => {
      assert.equal(request.source.kind, "fcpxml-artifact");
      assert.equal(request.source.artifactPath, artifactPath);
      reportProgress(0.25, "rendering source");
      await writeFile(stagingPathFromRequest({ ...request, outputPath: stagingPath }), "rendered video");
      reportProgress(1, "render complete");
    },
    probe: async () => ({
      durationSeconds: 12,
      width: 1920,
      height: 1080,
      frameRate: 30,
      hasAudio: true,
    }),
  });
  const request: BackgroundRenderRequest = {
    source: {
      kind: "fcpxml-artifact",
      artifactPath,
      target: {
        projectId: "project-1",
        sequenceId: "sequence-1",
        revision: { id: "revision-1", sequence: 4, timestamp: "2026-09-13T00:00:00.000Z" },
        digest: "sha256:source",
      },
    },
    outputPath,
    preset: "web",
  };

  const job = provider.start(request);
  job.onProgress((event) => progress.push(event.state));
  const result = await job.result();

  assert.deepEqual(progress, ["rendering", "rendering", "rendering", "verifying", "completed"]);
  assert.equal(result.completed, true);
  assert.equal(result.verified, true);
  assert.equal(result.provenance.renderer, "external-renderer");
  assert.equal(result.provenance.evidenceTier, "artifact-rendered");
  assert.deepEqual(result.provenance.source, request.source);
  assert.equal(await readFile(outputPath, "utf8"), "rendered video");
});

test("background renderer rejects unproven native Final Cut sources", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-background-native-"));
  const provider = new BackgroundRenderExportProvider({
    enabled: true,
    renderer: async ({ stagingPath }) => {
      await writeFile(stagingPath, "must not render");
    },
    probe: async () => ({ durationSeconds: 1, width: 1, height: 1, frameRate: 1, hasAudio: false }),
  });

  assert.throws(
    () => provider.start({
      source: {
        kind: "final-cut-timeline",
        target: {
          projectId: "project-1",
          sequenceId: "sequence-1",
          revision: { id: "revision-1", sequence: 4, timestamp: "2026-09-13T00:00:00.000Z" },
        },
      },
      outputPath: join(directory, "final.mp4"),
      preset: "master",
    }),
    /BACKGROUND_RENDER_NATIVE_UNAVAILABLE/,
  );
});

test("background renderer cancellation removes staged output and never commits", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-background-cancel-"));
  const outputPath = join(directory, "final.mp4");
  const states: string[] = [];
  const provider = new BackgroundRenderExportProvider({
    enabled: true,
    renderer: async ({ stagingPath, signal }) => {
      await writeFile(stagingPath, "partial output");
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    probe: async () => ({ durationSeconds: 1, width: 1920, height: 1080, frameRate: 30, hasAudio: false }),
  });
  const job = provider.start({
    source: {
      kind: "fcpxml-artifact",
      artifactPath: join(directory, "timeline.fcpxml"),
      target: { projectId: "project-1", sequenceId: "sequence-1", digest: "sha256:source" },
    },
    outputPath,
    preset: "master",
  });
  job.onProgress((event) => states.push(event.state));
  await new Promise<void>((resolve) => {
    const unsubscribe = job.onProgress((event) => {
      if (event.state === "rendering") {
        unsubscribe();
        resolve();
      }
    });
  });

  await job.cancel();

  await assert.rejects(job.result(), /BACKGROUND_RENDER_CANCELLED/);
  assert.equal(job.status().state, "cancelled");
  await assert.rejects(readFile(outputPath), /ENOENT/);
  assert.deepEqual(await readdir(directory), []);
  assert.ok(states.includes("cancelled"));
});

test("background renderer timeout fails closed before verification or commit", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-background-timeout-"));
  const outputPath = join(directory, "final.mp4");
  let probeCalled = false;
  const provider = new BackgroundRenderExportProvider({
    enabled: true,
    renderer: async ({ signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    probe: async () => {
      probeCalled = true;
      return { durationSeconds: 1, width: 1920, height: 1080, frameRate: 30, hasAudio: false };
    },
  });
  const job = provider.start({
    source: {
      kind: "fcpxml-artifact",
      artifactPath: join(directory, "timeline.fcpxml"),
      target: { projectId: "project-1", sequenceId: "sequence-1", digest: "sha256:source" },
    },
    outputPath,
    preset: "master",
    timeoutMs: 1,
  });

  await assert.rejects(job.result(), /BACKGROUND_RENDER_TIMEOUT/);
  assert.equal(probeCalled, false);
  assert.equal(job.status().state, "failed");
  await assert.rejects(readFile(outputPath), /ENOENT/);
});

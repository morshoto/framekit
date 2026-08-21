import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FinalCutProjectPublisher } from "@framekit/final-cut";

test("FCPXML publisher imports a validated artifact as a new project", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-"));
  const sourcePath = join(directory, "project.fcpxml");
  await writeFile(sourcePath, '<fcpxml version="1.11"><library><event><project name="Published Edit"><sequence /></project></event></library></fcpxml>');
  const scripts: string[] = [];
  const result = await new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    executor: async (script) => {
      scripts.push(script);
      return "imported";
    },
    liveState: async () => ({
      project: { id: "project-2", name: "Published Edit" },
      sequence: { id: "sequence-2", name: "Published Edit", startTime: { value: "0", timescale: "1" }, duration: { value: "10", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
      playheadTime: { value: "0", timescale: "1" },
      sequenceTimeRange: { start: { value: "0", timescale: "1" }, duration: { value: "10", timescale: "1" } },
      revision: { id: "rev-1", sequence: 1, timestamp: new Date(0).toISOString() },
    }),
  }).publishNewProject("txn-publish-1");

  assert.equal(result.verified, true);
  assert.equal(result.sourceTransactionId, "txn-publish-1");
  assert.equal(result.projectName, "Published Edit");
  assert.equal(result.liveProject, "Published Edit");
  assert.match(scripts[0], /Import/);
  await assert.rejects(readFile(result.importedPath), /ENOENT/);
});

test("FCPXML publisher rejects invalid artifacts before automation", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-invalid-"));
  const sourcePath = join(directory, "invalid.fcpxml");
  await writeFile(sourcePath, "not fcpxml");
  let called = false;
  const publisher = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    executor: async () => {
      called = true;
      return "";
    },
  });
  await assert.rejects(publisher.publishNewProject("txn-invalid"), /PUBLISH_VALIDATION_FAILED/);
  assert.equal(called, false);
});

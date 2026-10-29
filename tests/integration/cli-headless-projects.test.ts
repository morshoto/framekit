import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TimelineIr } from "@framekit/runtime";
import { createCliHeadlessProjectService } from "../../apps/cli/src/headless-projects.js";

test("CLI headless service uses the shared project workflow and injected state location", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-cli-headless-projects-"));
  try {
    const service = createCliHeadlessProjectService({ directory });
    const created = await service.create(emptyTimeline());

    assert.equal(created.timeline.project.id, "cli-headless-project");
    assert.deepEqual(await service.list(), [{
      projectId: "cli-headless-project",
      projectName: "CLI Headless Project",
      sequenceId: "cli-headless-sequence",
      sequenceName: "Master",
      revision: created.timeline.revision,
      path: join(directory, "cli-headless-project.json"),
    }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function emptyTimeline(): TimelineIr {
  return {
    schemaVersion: 1,
    project: { id: "cli-headless-project", name: "CLI Headless Project" },
    sequence: {
      id: "cli-headless-sequence",
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
    revision: { id: "cli-revision-0", sequence: 0, timestamp: "2026-10-29T00:00:00.000Z" },
  };
}

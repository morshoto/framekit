import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FRAMEKIT_PROJECT_SCHEMA_VERSION,
  FramekitProjectStore,
  type FramekitProjectDocument,
  type ProjectStoreFileSystem,
  encodeFramekitProject,
} from "@framekit/runtime";

function project(): FramekitProjectDocument {
  return {
    schemaVersion: FRAMEKIT_PROJECT_SCHEMA_VERSION,
    metadata: {
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
    },
    timeline: {
      schemaVersion: 1,
      project: { id: "project-stable", name: "Headless edit" },
      sequence: {
        id: "sequence-stable",
        name: "Master",
        durationTime: { value: "3003", timescale: "1001" },
        frameDuration: { value: "1001", timescale: "30000" },
        occurrences: [{
          id: "occurrence-stable",
          name: "Source clip",
          startTime: { value: "0", timescale: "1" },
          durationTime: { value: "3003", timescale: "1001" },
          sourceStartTime: { value: "1001", timescale: "24000" },
          track: 0,
          role: "video",
          mediaId: "media-stable",
          binding: { provider: "fixture", kind: "occurrence", identity: "provider-occurrence" },
        }],
        storyElements: [],
        markers: [],
        captions: [],
      },
      resources: [{
        id: "media-stable",
        name: "Source clip",
        mediaKind: "video",
        source: "/fixtures/source.mov",
        sourceDigest: "a".repeat(64),
        binding: { provider: "fixture", kind: "resource", identity: "provider-media" },
      }],
      revision: {
        id: "revision-stable",
        sequence: 7,
        timestamp: "2026-10-05T00:00:00.000Z",
      },
    },
  };
}

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "framekit-project-store-"));
}

test("project store round-trips stable identity, exact timing, bindings, and revision", async () => {
  const root = await directory();
  const path = join(root, "project.json");
  try {
    const store = new FramekitProjectStore(path);
    const expected = project();
    await store.create(expected);

    const reopened = await store.load();
    assert.deepEqual(reopened, expected);
    assert.equal(await readFile(path, "utf8"), `${encodeFramekitProject(expected)}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project encoding is deterministic for equivalent object key order", () => {
  const expected = project();
  const reordered = JSON.parse(JSON.stringify(expected)) as FramekitProjectDocument;
  reordered.timeline = {
    revision: reordered.timeline.revision,
    resources: reordered.timeline.resources,
    sequence: reordered.timeline.sequence,
    project: reordered.timeline.project,
    schemaVersion: reordered.timeline.schemaVersion,
  };

  assert.equal(encodeFramekitProject(expected), encodeFramekitProject(reordered));
});

test("future schema versions fail with structured diagnostics", async () => {
  const root = await directory();
  const path = join(root, "project.json");
  try {
    await writeFile(path, JSON.stringify({ ...project(), schemaVersion: FRAMEKIT_PROJECT_SCHEMA_VERSION + 1 }));
    await assert.rejects(new FramekitProjectStore(path).load(), (error: unknown) => (
      error instanceof Error
      && (error as Error & { code?: string }).code === "PROJECT_SCHEMA_UNSUPPORTED"
      && /schema/i.test(error.message)
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt state fails with structured diagnostics", async () => {
  const root = await directory();
  const path = join(root, "project.json");
  try {
    await writeFile(path, "{\"schemaVersion\":1,\"timeline\":");
    await assert.rejects(new FramekitProjectStore(path).load(), (error: unknown) => (
      error instanceof Error
      && (error as Error & { code?: string }).code === "PROJECT_CORRUPT"
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted atomic write preserves the previous valid project", async () => {
  const root = await directory();
  const path = join(root, "project.json");
  try {
    const first = project();
    const second = structuredClone(first);
    second.metadata.updatedAt = "2026-10-05T00:01:00.000Z";
    second.timeline.revision = { ...first.timeline.revision, id: "revision-next", sequence: 8 };
    await new FramekitProjectStore(path).create(first);

    const failingFileSystem: ProjectStoreFileSystem = {
      mkdir: async (directoryPath, options) => { await mkdir(directoryPath, options); },
      readFile: async (filePath, encoding) => readFile(filePath, encoding),
      writeFile: async (filePath, data, options) => writeFile(filePath, data, options),
      rename: async (from, to) => {
        if (to === path) throw new Error("injected interruption before commit");
        return rename(from, to);
      },
      unlink: async (filePath) => rm(filePath, { force: true }),
    };
    await assert.rejects(new FramekitProjectStore(path, failingFileSystem).save(second), /PROJECT_SAVE_FAILED/);
    assert.deepEqual(await new FramekitProjectStore(path).load(), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an expected revision mismatch fails before replacing canonical state", async () => {
  const root = await directory();
  const path = join(root, "project.json");
  try {
    const first = project();
    const second = structuredClone(first);
    second.timeline.revision = { ...first.timeline.revision, id: "revision-next", sequence: 8 };
    const store = new FramekitProjectStore(path);
    await store.create(first);

    await assert.rejects(
      store.save(second, { ...first.timeline.revision, id: "revision-stale", sequence: 6 }),
      (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === "PROJECT_STALE_REVISION",
    );
    assert.deepEqual(await store.load(), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

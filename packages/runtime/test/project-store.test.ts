import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
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

test("project encoding omits explicitly undefined optional fields", () => {
  const expected = project();
  expected.timeline.sequence.occurrences[0]!.binding = undefined;

  const encoded = encodeFramekitProject(expected);
  assert.doesNotMatch(encoded, /undefined/);
  assert.deepEqual(JSON.parse(encoded), JSON.parse(JSON.stringify(expected)));
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
      link,
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

test("project creation cannot replace a record published after its absence check", async () => {
  const root = await directory();
  const path = join(root, "project.json");
  const competing = '{"record":"other writer"}\n';
  try {
    const interleaved: ProjectStoreFileSystem = {
      mkdir: async (p, options) => { await mkdir(p, options); },
      readFile: async (p, encoding) => readFile(p, encoding),
      writeFile: async (p, data, options) => {
        await writeFile(p, data, options);
        if (p.endsWith(".tmp")) await writeFile(path, competing, { encoding: "utf8", flag: "wx" });
      },
      link,
      rename,
      unlink: async (p) => rm(p, { force: true }),
    };
    await assert.rejects(new FramekitProjectStore(path, interleaved).create(project()), /PROJECT_ALREADY_EXISTS/);
    assert.equal(await readFile(path, "utf8"), competing);
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

test("concurrent creates and saves fail closed instead of overwriting", async () => {
  const root = await directory();
  const path = join(root, "project.json");
  try {
    const first = project();
    const second = structuredClone(first);
    second.timeline.project.name = "Concurrent second";
    second.timeline.revision = { ...first.timeline.revision, id: "revision-second", sequence: 8 };
    const store = new FramekitProjectStore(path);

    const creates = await Promise.allSettled([store.create(first), store.create(second)]);
    assert.equal(creates.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(creates.filter((result) => result.status === "rejected" && (result.reason as { code?: string }).code === "PROJECT_ALREADY_EXISTS").length, 1);

    const persisted = await store.load();
    const expectedRevision = persisted.timeline.revision;
    const writes = await Promise.allSettled([
      ...["revision-a", "revision-b"].map((id) => {
        const candidate = structuredClone(persisted);
        candidate.timeline.revision = { ...expectedRevision, id, sequence: expectedRevision.sequence + 1 };
        return store.save(candidate, expectedRevision);
      }),
    ]);
    assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(writes.filter((result) => result.status === "rejected" && (result.reason as { code?: string }).code === "PROJECT_STALE_REVISION").length, 1);
    const saved = await store.load();
    assert.equal(saved.timeline.revision.sequence, expectedRevision.sequence + 1);
    assert.ok(["revision-a", "revision-b"].includes(saved.timeline.revision.id));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a lock left by a dead process remains reserved after restart", async () => {
  const root = await directory();
  const path = join(root, "project.json");
  try {
    await writeFile(`${path}.lock`, `${Number.MAX_SAFE_INTEGER}\n`);
    const expected = project();
    await assert.rejects(new FramekitProjectStore(path).create(expected), /PROJECT_SAVE_FAILED/);
    assert.equal(await readFile(`${path}.lock`, "utf8"), `${Number.MAX_SAFE_INTEGER}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty lock being initialized cannot be stolen by a concurrent writer", async () => {
  const root = await directory();
  const path = join(root, "project.json");
  let resume!: () => void;
  const resumed = new Promise<void>((resolve) => { resume = resolve; });
  let opened!: () => void;
  const lockOpened = new Promise<void>((resolve) => { opened = resolve; });
  try {
    const first = project();
    await new FramekitProjectStore(path).create(first);
    const a = structuredClone(first);
    const b = structuredClone(first);
    a.timeline.project.name = "Writer A";
    b.timeline.project.name = "Writer B";
    a.timeline.revision = { ...first.timeline.revision, id: "a", sequence: 8 };
    b.timeline.revision = { ...first.timeline.revision, id: "b", sequence: 8 };
    const pausedFileSystem: ProjectStoreFileSystem = {
      mkdir: async (p, options) => { await mkdir(p, options); },
      readFile: async (p, encoding) => readFile(p, encoding),
      writeFile: async (p, data, options) => {
        if (p !== `${path}.lock`) return writeFile(p, data, options);
        const handle = await open(p, "wx");
        try { opened(); await resumed; await handle.writeFile(data); } finally { await handle.close(); }
      },
      link,
      rename,
      unlink: async (p) => rm(p, { force: true }),
    };
    const firstWrite = new FramekitProjectStore(path, pausedFileSystem).save(a, first.timeline.revision);
    await lockOpened;
    const secondWrite = await Promise.allSettled([new FramekitProjectStore(path).save(b, first.timeline.revision)]);
    resume();
    const firstResult = await firstWrite;
    assert.equal(secondWrite[0]!.status, "rejected");
    assert.equal(firstResult.timeline.project.name, "Writer A");
    assert.deepEqual(await new FramekitProjectStore(path).load(), a);
  } finally {
    resume();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed lock initialization retains its reservation", async () => {
  const root = await directory();
  const path = join(root, "project.json");
  try {
    const interrupted: ProjectStoreFileSystem = {
      mkdir: async (p, options) => { await mkdir(p, options); },
      readFile: async (p, encoding) => readFile(p, encoding),
      writeFile: async (p, data, options) => {
        if (p !== `${path}.lock`) return writeFile(p, data, options);
        const handle = await open(p, "wx");
        await handle.close();
        throw new Error("injected failure after lock creation");
      },
      link,
      rename,
      unlink: async (p) => rm(p, { force: true }),
    };
    await assert.rejects(new FramekitProjectStore(path, interrupted).create(project()), /PROJECT_SAVE_FAILED/);
    assert.equal(await readFile(`${path}.lock`, "utf8"), "");
    await assert.rejects(new FramekitProjectStore(path).create(project()), /PROJECT_SAVE_FAILED/);
    assert.equal(await readFile(`${path}.lock`, "utf8"), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a legacy writer removing an initializing lock can bypass upgraded writer exclusion", async () => {
  const root = await directory();
  const path = join(root, "project.json");
  let resume!: () => void;
  const resumed = new Promise<void>((resolve) => { resume = resolve; });
  let opened!: () => void;
  const lockOpened = new Promise<void>((resolve) => { opened = resolve; });
  let unblockReads!: () => void;
  const bothReads = new Promise<void>((resolve) => { unblockReads = resolve; });
  let reads = 0;
  try {
    const first = project();
    await new FramekitProjectStore(path).create(first);
    const a = structuredClone(first);
    const b = structuredClone(first);
    a.timeline.project.name = "Writer A";
    b.timeline.project.name = "Writer B";
    a.timeline.revision = { ...first.timeline.revision, id: "a", sequence: 8 };
    b.timeline.revision = { ...first.timeline.revision, id: "b", sequence: 8 };
    const shared: ProjectStoreFileSystem = {
      mkdir: async (p, options) => { await mkdir(p, options); },
      readFile: async (p, encoding) => {
        const contents = await readFile(p, encoding);
        if (p === path) { reads++; if (reads === 2) unblockReads(); await bothReads; }
        return contents;
      },
      writeFile: async (p, data, options) => { await writeFile(p, data, options); },
      link,
      rename,
      unlink: async (p) => rm(p, { force: true }),
    };
    const firstFs: ProjectStoreFileSystem = { ...shared, writeFile: async (p, data, options) => {
      if (p !== `${path}.lock`) return shared.writeFile(p, data, options);
      const handle = await open(p, "wx");
      try { opened(); await resumed; await handle.writeFile(data); } finally { await handle.close(); }
    } };
    const secondFs: ProjectStoreFileSystem = { ...shared, writeFile: async (p, data, options) => {
      await shared.writeFile(p, data, options);
      if (p === `${path}.lock`) resume();
    } };
    const firstWrite = new FramekitProjectStore(path, firstFs).save(a, first.timeline.revision);
    await lockOpened;
    // Simulate a legacy writer treating the empty lock as stale and removing it.
    assert.equal(await readFile(`${path}.lock`, "utf8"), "");
    await rm(`${path}.lock`);
    const secondWrite = new FramekitProjectStore(path, secondFs).save(b, first.timeline.revision);
    const writes = await Promise.allSettled([firstWrite, secondWrite]);
    assert.deepEqual(writes.map((result) => result.status), ["fulfilled", "fulfilled"]);
    assert.ok(["Writer A", "Writer B"].includes((await new FramekitProjectStore(path).load()).timeline.project.name));
  } finally {
    resume();
    unblockReads();
    await rm(root, { recursive: true, force: true });
  }
});

test("a live lock owner is not stolen", async () => {
  const root = await directory();
  const path = join(root, "project.json");
  try {
    await writeFile(`${path}.lock`, `${process.pid}\n`);
    await assert.rejects(new FramekitProjectStore(path).create(project()), /PROJECT_SAVE_FAILED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

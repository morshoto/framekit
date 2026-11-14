import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FRAMEKIT_PROJECT_SCHEMA_VERSION,
  FramekitProjectStore,
  LocalMediaRegistrar,
  type FramekitProjectDocument,
  type LocalMediaMetadataProbe,
} from "@framekit/runtime";

function project(): FramekitProjectDocument {
  return {
    schemaVersion: FRAMEKIT_PROJECT_SCHEMA_VERSION,
    metadata: { createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z" },
    timeline: {
      schemaVersion: 1,
      project: { id: "project-media", name: "Media registration" },
      sequence: {
        id: "sequence-media",
        name: "Master",
        durationTime: { value: "0", timescale: "1" },
        frameDuration: { value: "1", timescale: "30" },
        occurrences: [],
        storyElements: [],
        markers: [],
        captions: [],
      },
      resources: [],
      revision: { id: "revision-media", sequence: 0, timestamp: "2026-10-05T00:00:00.000Z" },
    },
  };
}

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), "framekit-local-media-"));
}

const probe: LocalMediaMetadataProbe = {
  probe: async () => ({
    durationTime: { value: "3003", timescale: "1001" },
    streams: [{
      kind: "video",
      width: 1920,
      height: 1080,
      frameRate: { value: "30000", timescale: "1001" },
    }, {
      kind: "audio",
      sampleRate: 48000,
      channels: 2,
    }],
  }),
};

test("registers local media with stable identity, digest, metadata, and exact source timing", async () => {
  const directory = await root();
  const sourcePath = join(directory, "source.mov");
  const projectPath = join(directory, "project.json");
  const source = "deterministic local media fixture";
  try {
    await writeFile(sourcePath, source);
    const store = new FramekitProjectStore(projectPath);
    await store.create(project());
    const registrar = new LocalMediaRegistrar(store, probe, { clock: () => "2026-10-05T00:01:00.000Z" });

    const result = await registrar.register(sourcePath);
    assert.equal(result.status, "registered");
    assert.equal(result.resource.source, sourcePath);
    assert.equal(result.resource.sourceKind, "local-file");
    assert.match(result.resource.sourceDigest ?? "", /^[a-f0-9]{64}$/);
    assert.deepEqual(result.resource.metadata, {
      durationTime: { value: "3003", timescale: "1001" },
      streams: probe === undefined ? [] : (result.resource.metadata?.streams ?? []),
    });
    assert.equal(result.resource.mediaKind, "video");
    assert.equal(result.project.timeline.resources[0]?.id, result.resource.id);
    assert.equal(result.project.timeline.revision.sequence, 1);
    assert.equal(await readFile(sourcePath, "utf8"), source);

    const reopened = await registrar.reopen();
    assert.equal(reopened.timeline.resources[0]?.id, result.resource.id);
    const duplicate = await registrar.register(sourcePath);
    assert.equal(duplicate.status, "already-registered");
    assert.equal(duplicate.resource.id, result.resource.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing and changed sources fail closed on project reopen", async () => {
  const directory = await root();
  const sourcePath = join(directory, "source.mov");
  const projectPath = join(directory, "project.json");
  try {
    await writeFile(sourcePath, "before");
    const store = new FramekitProjectStore(projectPath);
    await store.create(project());
    const registrar = new LocalMediaRegistrar(store, probe);
    await registrar.register(sourcePath);

    await writeFile(sourcePath, "after");
    await assert.rejects(registrar.reopen(), (error: unknown) => (
      error instanceof Error
      && (error as Error & { code?: string }).code === "MEDIA_CHANGED"
      && /source\.mov/.test(error.message)
    ));

    await unlink(sourcePath);
    await assert.rejects(registrar.reopen(), (error: unknown) => (
      error instanceof Error
      && (error as Error & { code?: string }).code === "MEDIA_MISSING"
    ));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("same filenames at different paths receive distinct source-bound identities", async () => {
  const directory = await root();
  const firstPath = join(directory, "one", "source.mov");
  const secondPath = join(directory, "two", "source.mov");
  try {
    await mkdir(join(directory, "one"));
    await mkdir(join(directory, "two"));
    await writeFile(firstPath, "one");
    await writeFile(secondPath, "two");
    const firstStore = new FramekitProjectStore(join(directory, "one.json"));
    const secondStore = new FramekitProjectStore(join(directory, "two.json"));
    await firstStore.create(project());
    await secondStore.create(project());
    const first = await new LocalMediaRegistrar(firstStore, probe).register(firstPath);
    const second = await new LocalMediaRegistrar(secondStore, probe).register(secondPath);
    assert.notEqual(first.resource.id, second.resource.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed local-file resources fail closed on reopen", async () => {
  const directory = await root();
  const projectPath = join(directory, "project.json");
  try {
    const malformed = project();
    malformed.timeline.resources.push({ id: "malformed", name: "Malformed", mediaKind: "video", sourceKind: "local-file" });
    await writeFile(projectPath, JSON.stringify(malformed));

    await assert.rejects(new LocalMediaRegistrar(new FramekitProjectStore(projectPath), probe).reopen(), (error: unknown) => (
      error instanceof Error
      && (error as Error & { code?: string }).code === "PROJECT_CORRUPT"
      && /sourceDigest|canonical schema/i.test(error.message)
    ));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registration fails closed when the source changes during metadata probing", async () => {
  const directory = await root();
  const sourcePath = join(directory, "source.mov");
  const projectPath = join(directory, "project.json");
  try {
    await writeFile(sourcePath, "before");
    const store = new FramekitProjectStore(projectPath);
    await store.create(project());
    const changingProbe: LocalMediaMetadataProbe = {
      probe: async () => {
        await writeFile(sourcePath, "after");
        return probe.probe(sourcePath);
      },
    };

    await assert.rejects(new LocalMediaRegistrar(store, changingProbe).register(sourcePath), (error: unknown) => (
      error instanceof Error
      && (error as Error & { code?: string }).code === "MEDIA_CHANGED"
    ));
    assert.equal((await store.load()).timeline.resources.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { FinalCutMediaRegistry } from "@framekit/final-cut";

function digestOf(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

test("local media discovery returns provider-qualified identity and metadata", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "framekit-media-discovery-"));
  const mediaPath = join(root, "interviews", "Interview.mov");
  await mkdir(join(root, "interviews"), { recursive: true });
  await writeFile(mediaPath, "video fixture");
  await writeFile(join(root, "notes.txt"), "not media");

  const registry = new FinalCutMediaRegistry({ roots: [root] });
  const [media] = await registry.listMedia({ query: "interview" });

  assert.ok(media);
  assert.equal(media.mediaId, `filesystem:media:${mediaPath}`);
  assert.equal(media.source, mediaPath);
  assert.equal(media.mediaKind, "video");
  assert.equal(media.sourceDigest, digestOf("video fixture"));
  assert.deepEqual(media.sourceMetadata, {
    fileName: basename(mediaPath),
    extension: ".mov",
    sizeBytes: Buffer.byteLength("video fixture"),
    mimeType: "video/quicktime",
    modifiedAt: media.sourceMetadata?.modifiedAt,
  });
  assert.deepEqual(media.discovery, {
    backend: "filesystem-media",
    guarantee: "observed",
    source: "filesystem",
  });
});

test("local media discovery filters by source and media kind", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "framekit-media-filter-"));
  await writeFile(join(root, "Interview.mov"), "video fixture");
  await writeFile(join(root, "Interview.wav"), "audio fixture");

  const registry = new FinalCutMediaRegistry({ roots: [root] });

  assert.deepEqual(
    (await registry.listMedia({ query: "interview", mediaKind: "audio" })).map((media) => media.source),
    [join(root, "Interview.wav")],
  );
  assert.deepEqual(await registry.listMedia({ query: "missing" }), []);
});

test("local media discovery does not follow symlinked directories", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "framekit-media-symlink-root-"));
  const outside = await mkdtemp(join(os.tmpdir(), "framekit-media-symlink-outside-"));
  await writeFile(join(outside, "escaped.mov"), "outside media");
  await symlink(outside, join(root, "linked"), "dir");

  const registry = new FinalCutMediaRegistry({ roots: [root] });

  assert.deepEqual(await registry.listMedia(), []);
});

test("local media discovery terminates on symlink cycles", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "framekit-media-cycle-root-"));
  await symlink(root, join(root, "cycle"), "dir");

  const registry = new FinalCutMediaRegistry({ roots: [root] });

  assert.deepEqual(await registry.listMedia(), []);
});

test("local media discovery refreshes its cache explicitly", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "framekit-media-refresh-"));
  const firstPath = join(root, "first.mp4");
  const secondPath = join(root, "second.mp3");
  await writeFile(firstPath, "first");

  const registry = new FinalCutMediaRegistry({ roots: [root] });
  assert.equal((await registry.listMedia()).length, 1);

  await writeFile(secondPath, "second");
  registry.refresh();

  assert.deepEqual(
    (await registry.listMedia()).map((media) => media.source),
    [firstPath, secondPath],
  );
});

test("local media discovery detects changed source content without refresh", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "framekit-media-change-"));
  const mediaPath = join(root, "changed.m4a");
  await writeFile(mediaPath, "before");

  const registry = new FinalCutMediaRegistry({ roots: [root] });
  const [before] = await registry.listMedia();
  assert.equal(before?.sourceDigest, digestOf("before"));

  await writeFile(mediaPath, "after");
  const [after] = await registry.listMedia();

  assert.equal(after?.mediaId, before?.mediaId);
  assert.equal(after?.sourceDigest, digestOf("after"));
  assert.notEqual(after?.sourceDigest, before?.sourceDigest);
});

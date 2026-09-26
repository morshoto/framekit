import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FcpxmlDocumentAdapter } from "@framekit/final-cut";
import { canonicalSnapshotDigest } from "@framekit/runtime";

test("original media representations preserve canonical content across export directories", async () => {
  const directories = await Promise.all([0, 1].map(() => mkdtemp(join(tmpdir(), "framekit-media-rep-"))));
  try {
    const snapshots = [];
    for (const directory of directories) {
      const path = join(directory, "Info.fcpxml");
      await writeFile(path, `<fcpxml version="1.11"><resources>
        <asset id="r2" name="Original" duration="1s" hasVideo="1">
          <media-rep kind="proxy-media" src="file:///fixtures/proxy.mov"/>
          <media-rep kind="original-media" src="file:///fixtures/original%20media.mov"/>
        </asset></resources><library><event><project uid="project" name="QA">
        <sequence uid="sequence" duration="1s"><spine>
          <asset-clip ref="r2" name="Clip" offset="0s" duration="1s"/>
        </spine></sequence></project></event></library></fcpxml>`);
      snapshots.push(await new FcpxmlDocumentAdapter(path).readProject());
    }
    assert.equal(snapshots[0]!.media[0]!.source, "/fixtures/original media.mov");
    assert.equal(canonicalSnapshotDigest(snapshots[0]!), canonicalSnapshotDigest(snapshots[1]!));
  } finally {
    await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })));
  }
});

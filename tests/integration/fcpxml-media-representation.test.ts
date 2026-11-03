import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFinalCutNativeTargetResolver, FcpxmlDocumentAdapter } from "@framekit/final-cut";
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

test("missing original media paths are not invented from resource names or IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-missing-source-"));
  try {
    const path = join(directory, "Info.fcpxml");
    await writeFile(path, `<fcpxml version="1.11"><resources>
      <asset id="r2" name="same.mov" duration="1s" hasVideo="1"/>
      <asset id="r3" duration="1s" hasVideo="1"><media-rep kind="proxy-media" src="file:///proxy.mov"/></asset>
      <asset id="r4" name="blank.mov" src="" duration="1s" hasVideo="1"/>
      <asset id="r5" name="remote.mov" src="https://example.test/remote.mov" duration="1s" hasVideo="1"/>
      </resources><library><event><project uid="project" name="QA">
      <sequence uid="sequence" duration="1s"><spine>
        <asset-clip ref="r2" offset="0s" duration="1s"/>
      </spine></sequence></project></event></library></fcpxml>`);
    const snapshot = await new FcpxmlDocumentAdapter(path).readProject();
    assert.deepEqual(snapshot.media.map(({ mediaId, source }) => ({ mediaId, source })), [
      { mediaId: "r2", source: "" },
      { mediaId: "r3", source: "" },
      { mediaId: "r4", source: "" },
      { mediaId: "r5", source: "https://example.test/remote.mov" },
    ]);
    let searches = 0;
    const resolve = createFinalCutNativeTargetResolver({
      searchMedia: async () => { searches++; return []; },
      locateOccurrence: async () => { throw new Error("unexpected occurrence discovery"); },
    });
    await assert.rejects(resolve(snapshot.timeline.clips[0]!, snapshot), /TARGET_MISMATCH: media r2 has no source binding/);
    const remoteClip = { ...snapshot.timeline.clips[0]!, mediaId: "r5" };
    await assert.rejects(resolve(remoteClip, snapshot), /TARGET_MISMATCH: independently observed Browser source/);
    assert.equal(searches, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

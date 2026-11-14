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

test("same-named sources and nested overlapping occurrences retain distinct bindings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-collision-fixture-"));
  try {
    const path = join(directory, "Info.fcpxml");
    await writeFile(path, `<fcpxml version="1.11"><resources>
      <asset id="a" name="same.mov" duration="12s" hasVideo="1"><media-rep kind="original-media" src="file:///fixtures/a/same.mov"/></asset>
      <asset id="b" name="same.mov" duration="12s" hasVideo="1"><media-rep kind="original-media" src="file:///fixtures/b/same.mov"/></asset>
      </resources><library><event><project uid="project" name="QA"><sequence uid="sequence" duration="12s"><spine>
      <asset-clip ref="a" name="same.mov" offset="0s" start="0s" duration="4s">
        <asset-clip ref="b" name="same.mov" lane="1" offset="0s" start="0s" duration="4s"/>
      </asset-clip>
      <asset-clip ref="a" name="same.mov" offset="4s" start="0s" duration="4s"/>
      <asset-clip ref="a" name="same.mov" offset="8s" start="0s" duration="4s"/>
      </spine></sequence></project></event></library></fcpxml>`);
    const snapshot = await new FcpxmlDocumentAdapter(path).readProject();
    assert.deepEqual(snapshot.media.map(({ mediaId, source }) => [mediaId, source]), [["a", "/fixtures/a/same.mov"], ["b", "/fixtures/b/same.mov"]]);
    assert.deepEqual(snapshot.timeline.clips.map(({ mediaId, track, startTime, durationTime }) => ({ mediaId, track, startTime, durationTime })), [
      { mediaId: "a", track: 0, startTime: { value: "0", timescale: "1" }, durationTime: { value: "4", timescale: "1" } },
      { mediaId: "b", track: 1, startTime: { value: "0", timescale: "1" }, durationTime: { value: "4", timescale: "1" } },
      { mediaId: "a", track: 0, startTime: { value: "4", timescale: "1" }, durationTime: { value: "4", timescale: "1" } },
      { mediaId: "a", track: 0, startTime: { value: "8", timescale: "1" }, durationTime: { value: "4", timescale: "1" } },
    ]);
    assert.equal(new Set(snapshot.timeline.clips.map(({ id }) => id)).size, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
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

test("FCPXML snapshots preserve explicit sequence timecode origin without inventing one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-sequence-origin-"));
  try {
    const read = async (attribute: string) => {
      const path = join(directory, attribute ? "explicit.fcpxml" : "missing.fcpxml");
      await writeFile(path, `<fcpxml version="1.11"><resources><format id="f" frameDuration="1001/24000s"/><asset id="a" duration="2s" hasVideo="1"><media-rep kind="original-media" src="file:///fixtures/a.mov"/></asset></resources><library><event><project uid="project" name="QA"><sequence uid="sequence" format="f" duration="2s" ${attribute}><spine><asset-clip ref="a" offset="3600s" start="0s" duration="2s"/></spine></sequence></project></event></library></fcpxml>`);
      return new FcpxmlDocumentAdapter(path).readProject();
    };
    const explicit = await read('tcStart="3600s"');
    const missing = await read("");
    assert.deepEqual(explicit.timeline.timecodeStart, { value: "3600", timescale: "1" });
    assert.equal(missing.timeline.timecodeStart, undefined);
    assert.notEqual(canonicalSnapshotDigest(explicit), canonicalSnapshotDigest(missing));
    const { createTimelineIrFromProjectSnapshot } = await import("@framekit/runtime");
    assert.deepEqual(createTimelineIrFromProjectSnapshot(explicit).sequence.timecodeStart, { value: "3600", timescale: "1" });
    assert.equal(createTimelineIrFromProjectSnapshot(missing).sequence.timecodeStart, undefined);
    await assert.rejects(read('tcStart="bad"'), /FCPXML_INVALID_TIME/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

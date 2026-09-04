import { createHash } from "node:crypto";
import type { EditorAsset } from "@framekit/runtime";
import type { InMemoryFixture } from "@framekit/testkit";

export const BASIC_MVP_FIXTURE_BYTES = {
  video: Buffer.from("Framekit Basic Editing MVP video fixture\n"),
  music: Buffer.from("Framekit Basic Editing MVP music fixture\n"),
} as const;

function fixtureDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export const BASIC_MVP_TITLE_ASSET: EditorAsset = {
  id: "title://framekit/lower-third",
  kind: "title",
  name: "Framekit Lower Third",
  vendor: "Framekit Fixture",
  metadata: { fixture: true },
};

/** Repository-owned metadata for the deterministic Basic Editing MVP gate. */
export const BASIC_EDITING_MVP_FIXTURE: InMemoryFixture = {
  projectId: "fixture-project-basic-mvp",
  projectName: "Framekit Basic Editing MVP",
  timelineId: "fixture-sequence-basic-mvp",
  timelineName: "Main Edit",
  clips: [],
  media: [],
  assets: [BASIC_MVP_TITLE_ASSET],
};

export const BASIC_MVP_MEDIA = {
  video: {
    mediaId: "fixture-video",
    source: "fixture://basic-editing-mvp/video.mov",
    mediaKind: "video" as const,
    duration: 6,
    sourceDigest: fixtureDigest(BASIC_MVP_FIXTURE_BYTES.video),
  },
  music: {
    mediaId: "fixture-music",
    source: "fixture://basic-editing-mvp/music.wav",
    mediaKind: "audio" as const,
    duration: 8,
    sourceDigest: fixtureDigest(BASIC_MVP_FIXTURE_BYTES.music),
  },
};

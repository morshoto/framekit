import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Clip, ProjectSnapshot, RationalTime, StoryElement } from "@framekit/runtime";

export const FINAL_CUT_PUBLISH_READBACK_CHECKS = [
  "project-and-sequence-names",
  "timeline-duration-and-frame-rate",
  "clip-order-and-source-ranges",
  "editable-title-content-and-timing",
  "connected-audio-source-role-gain-and-timing",
  "other-timeline-elements",
  "markers-and-captions",
  "source-media-bindings",
] as const;

export interface FinalCutPublishReadbackEvidence {
  verified: true;
  expectedDigest: string;
  observedDigest: string;
  checked: typeof FINAL_CUT_PUBLISH_READBACK_CHECKS[number][];
}

export class FinalCutPublishSemanticMismatchError extends Error {
  public readonly code = "FINAL_CUT_PUBLISH_SEMANTIC_MISMATCH";

  public constructor(
    public readonly expectedDigest: string,
    public readonly observedDigest: string,
    public readonly mismatchedChecks: string[],
  ) {
    super(`FINAL_CUT_PUBLISH_SEMANTIC_MISMATCH: native Final Cut readback differs from the approved FCPXML (${mismatchedChecks.join(", ")})`);
    this.name = "FinalCutPublishSemanticMismatchError";
  }
}

/** Compare supported native timeline semantics while ignoring generated native IDs and revisions. */
export function verifyFinalCutPublishReadback(
  expected: ProjectSnapshot,
  actual: ProjectSnapshot,
): FinalCutPublishReadbackEvidence {
  const expectedSignature = publishTimelineSignature(expected);
  const actualSignature = publishTimelineSignature(actual);
  const expectedJson = stableJson(expectedSignature);
  const actualJson = stableJson(actualSignature);
  const expectedDigest = digest(expectedJson);
  const observedDigest = digest(actualJson);

  if (expectedJson !== actualJson) {
    const mismatchedChecks = FINAL_CUT_PUBLISH_READBACK_CHECKS.filter((check) =>
      stableJson(expectedSignature[check]) !== stableJson(actualSignature[check]),
    );
    throw new FinalCutPublishSemanticMismatchError(expectedDigest, observedDigest, [...mismatchedChecks]);
  }

  return {
    verified: true,
    expectedDigest,
    observedDigest,
    checked: [...FINAL_CUT_PUBLISH_READBACK_CHECKS],
  };
}

type PublishTimelineSignature = Record<typeof FINAL_CUT_PUBLISH_READBACK_CHECKS[number], unknown>;

function publishTimelineSignature(snapshot: ProjectSnapshot): PublishTimelineSignature {
  const sourceByMediaId = new Map(snapshot.media.map(({ mediaId, source }) => [mediaId, normalizeSource(source)]));
  const audioMediaIds = new Set(snapshot.media.filter(({ mediaKind }) => mediaKind === "audio").map(({ mediaId }) => mediaId));
  const mediaSource = (mediaId: string | undefined): string | undefined => {
    if (mediaId === undefined) return undefined;
    return sourceByMediaId.get(mediaId) ?? `unresolved-media:${mediaId}`;
  };
  const clips = snapshot.timeline.clips;
  const titles = snapshot.timeline.storyElements.filter(({ kind }) => kind === "title");
  const audioClips = clips.filter((clip) => isAudioClip(clip, audioMediaIds));
  const mediaBindings = snapshot.media
    .map(({ source, mediaKind, duration }) => ({ source: normalizeSource(source), mediaKind, duration }))
    .sort((left, right) => compareText(stableJson(left), stableJson(right)));
  const representedStoryKinds = new Set(["asset-clip", "audio", "clip", "mc-clip", "ref-clip", "sync-clip", "title", "video"]);

  return {
    "project-and-sequence-names": {
      projectName: snapshot.projectName,
      sequenceName: snapshot.timeline.name,
    },
    "timeline-duration-and-frame-rate": {
      durationTime: rationalSignature(snapshot.timeline.durationTime),
      frameDuration: rationalSignature(snapshot.timeline.frameDuration),
    },
    "clip-order-and-source-ranges": clips
      .filter((clip) => !isAudioClip(clip, audioMediaIds))
      .map((clip) => clipSignature(clip, mediaSource)),
    "editable-title-content-and-timing": titles.map((title) => storyElementSignature(title, mediaSource)),
    "connected-audio-source-role-gain-and-timing": {
      clips: audioClips.map((clip) => clipSignature(clip, mediaSource)),
      elements: snapshot.timeline.storyElements
        .filter((element) => element.kind === "audio" || audioMediaIds.has(element.mediaId ?? ""))
        .map((element) => storyElementSignature(element, mediaSource)),
    },
    "other-timeline-elements": snapshot.timeline.storyElements
      .filter((element) => !representedStoryKinds.has(element.kind))
      .map((element) => storyElementSignature(element, mediaSource)),
    "markers-and-captions": {
      markers: snapshot.timeline.markers.map((marker) => ({
        name: marker.name,
        startTime: rationalSignature(marker.startTime),
        durationTime: rationalSignature(marker.durationTime),
      })),
      captions: snapshot.timeline.captions.map((caption) => ({
        text: caption.text,
        startTime: rationalSignature(caption.startTime),
        durationTime: rationalSignature(caption.durationTime),
      })),
    },
    "source-media-bindings": mediaBindings,
  };
}

function clipSignature(clip: Clip, mediaSource: (mediaId: string | undefined) => string | undefined) {
  return {
    source: mediaSource(clip.mediaId),
    name: clip.name,
    startTime: rationalSignature(clip.startTime),
    durationTime: rationalSignature(clip.durationTime),
    sourceStartTime: rationalSignature(clip.sourceStartTime ?? zeroRational()),
    track: clip.track,
    gainDb: clip.gainDb,
    noiseReductionDb: clip.noiseReductionDb,
    colorCorrection: clip.colorCorrection,
    role: clip.role,
    enabled: clip.enabled,
    position: clip.position,
    scale: clip.scale,
    crop: clip.crop,
    frame: clip.frame,
    mask: clip.mask,
    fadeIn: clip.fadeIn,
    fadeOut: clip.fadeOut,
  };
}

function storyElementSignature(element: StoryElement, mediaSource: (mediaId: string | undefined) => string | undefined) {
  return {
    kind: element.kind,
    startTime: rationalSignature(element.startTime),
    durationTime: rationalSignature(element.durationTime),
    lane: element.lane,
    source: mediaSource(element.mediaId),
    text: element.text,
    assetId: element.assetId,
    position: element.position,
    scale: element.scale,
    crop: element.crop,
    frame: element.frame,
    mask: element.mask,
  };
}

function isAudioClip(clip: Clip, audioMediaIds: Set<string>): boolean {
  return clip.role === "audio" || clip.role === "music"
    || (clip.mediaId !== undefined && audioMediaIds.has(clip.mediaId));
}

function normalizeSource(source: string): string {
  return resolve(source).normalize("NFC");
}

function rationalSignature(value: RationalTime | undefined): string | undefined {
  if (!value) return undefined;
  const numerator = BigInt(value.value);
  const denominator = BigInt(value.timescale);
  if (denominator === 0n) throw new Error("FINAL_CUT_PUBLISH_READBACK_INVALID: rational time has a zero timescale");
  const sign = denominator < 0n ? -1n : 1n;
  const signedNumerator = numerator * sign;
  const positiveDenominator = denominator * sign;
  const divisor = greatestCommonDivisor(signedNumerator, positiveDenominator);
  return `${signedNumerator / divisor}/${positiveDenominator / divisor}`;
}

function zeroRational(): RationalTime {
  return { value: "0", timescale: "1" };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

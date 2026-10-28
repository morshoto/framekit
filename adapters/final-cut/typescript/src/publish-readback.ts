import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
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

type SourceMediaDigest = Readonly<{ source: string; sha256: string }>;

type PublishReadbackOptions = Readonly<{
  expectedSourceMediaDigests: readonly SourceMediaDigest[];
  actualSourceMediaDigests: readonly SourceMediaDigest[];
}>;

/** Compare supported native timeline semantics while ignoring generated native IDs and revisions. */
export function verifyFinalCutPublishReadback(
  expected: ProjectSnapshot,
  actual: ProjectSnapshot,
  options?: PublishReadbackOptions,
): FinalCutPublishReadbackEvidence {
  const expectedSignature = publishTimelineSignature(expected, options?.expectedSourceMediaDigests);
  const actualSignature = publishTimelineSignature(actual, options?.actualSourceMediaDigests);
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

function publishTimelineSignature(
  snapshot: ProjectSnapshot,
  sourceMediaDigests?: readonly SourceMediaDigest[],
): PublishTimelineSignature {
  const referencedMediaIds = new Set([
    ...snapshot.timeline.clips.map(({ mediaId }) => mediaId),
    ...snapshot.timeline.storyElements.map(({ mediaId }) => mediaId),
  ].filter((mediaId): mediaId is string => mediaId !== undefined));
  const referencedMedia = snapshot.media.filter(({ mediaId }) => referencedMediaIds.has(mediaId));
  const digestBySource = sourceMediaDigests === undefined
    ? undefined
    : new Map(sourceMediaDigests.map(({ source, sha256 }) => [resolve(source), sha256]));
  const sourceIdentity = (source: string): string => {
    if (digestBySource === undefined) return normalizeSource(source);
    const sha256 = digestBySource.get(resolve(source));
    if (sha256 === undefined) {
      throw new Error(`FINAL_CUT_PUBLISH_SOURCE_MEDIA_BINDING_MISMATCH: no verified digest for ${source}`);
    }
    return `sha256:${sha256}`;
  };
  const sourceByMediaId = new Map(referencedMedia.map(({ mediaId, source }) => [mediaId, sourceIdentity(source)]));
  const audioMediaIds = new Set(referencedMedia.filter(({ mediaKind }) => mediaKind === "audio").map(({ mediaId }) => mediaId));
  const mediaSource = (mediaId: string | undefined): string | undefined => {
    if (mediaId === undefined) return undefined;
    return sourceByMediaId.get(mediaId) ?? `unresolved-media:${mediaId}`;
  };
  const clips = snapshot.timeline.clips;
  const titles = snapshot.timeline.storyElements.filter(({ kind }) => kind === "title");
  const audioClips = clips.filter((clip) => isAudioClip(clip, audioMediaIds));
  const mediaBindings = referencedMedia
    .map(({ source, mediaKind, duration }) => ({ source: sourceIdentity(source), mediaKind, duration }))
    .sort((left, right) => compareText(stableJson(left), stableJson(right)));
  const representedStoryKinds = new Set(["asset-clip", "audio", "clip", "mc-clip", "ref-clip", "sync-clip", "title", "video"]);

  return {
    "project-and-sequence-names": {
      projectName: snapshot.projectName,
      sequenceName: snapshot.timeline.name,
    },
    "timeline-duration-and-frame-rate": {
      durationTime: frameRoundedSignature(snapshot.timeline.durationTime, snapshot.timeline.frameDuration),
      frameDuration: rationalSignature(snapshot.timeline.frameDuration),
    },
    "clip-order-and-source-ranges": clips
      .filter((clip) => !isAudioClip(clip, audioMediaIds))
      .map((clip) => clipSignature(clip, mediaSource, audioMediaIds)),
    "editable-title-content-and-timing": titles.map((title) => storyElementSignature(title, mediaSource, audioMediaIds)),
    "connected-audio-source-role-gain-and-timing": {
      clips: audioClips.map((clip) => clipSignature(clip, mediaSource, audioMediaIds)),
      elements: snapshot.timeline.storyElements
        .filter((element) => element.kind === "audio" || audioMediaIds.has(element.mediaId ?? ""))
        .map((element) => storyElementSignature(element, mediaSource, audioMediaIds)),
    },
    "other-timeline-elements": snapshot.timeline.storyElements
      .filter((element) => !representedStoryKinds.has(element.kind))
      .map((element) => storyElementSignature(element, mediaSource, audioMediaIds)),
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

function clipSignature(
  clip: Clip,
  mediaSource: (mediaId: string | undefined) => string | undefined,
  audioMediaIds: Set<string>,
) {
  return {
    source: mediaSource(clip.mediaId),
    name: clip.name,
    startTime: rationalSignature(clip.startTime),
    durationTime: rationalSignature(clip.durationTime),
    sourceStartTime: rationalSignature(clip.sourceStartTime ?? zeroRational()),
    track: isAudioClip(clip, audioMediaIds) ? Math.abs(clip.track) : clip.track,
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

function storyElementSignature(
  element: StoryElement,
  mediaSource: (mediaId: string | undefined) => string | undefined,
  audioMediaIds: Set<string>,
) {
  const audio = element.kind === "audio" || audioMediaIds.has(element.mediaId ?? "");
  return {
    kind: element.kind,
    startTime: rationalSignature(element.startTime),
    durationTime: rationalSignature(element.durationTime),
    lane: element.lane === undefined ? undefined : audio ? Math.abs(element.lane) : element.lane,
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
  return basename(resolve(source)).normalize("NFC");
}

function frameRoundedSignature(duration: RationalTime | undefined, frameDuration: RationalTime | undefined): string | undefined {
  if (!duration || !frameDuration) return rationalSignature(duration);
  const frameNumerator = BigInt(frameDuration.value);
  const frameDenominator = BigInt(frameDuration.timescale);
  const durationNumerator = BigInt(duration.value);
  const durationDenominator = BigInt(duration.timescale);
  const denominator = durationDenominator * frameNumerator;
  const numerator = durationNumerator * frameDenominator;
  if (denominator <= 0n || frameNumerator <= 0n || numerator < 0n) {
    throw new Error("FINAL_CUT_PUBLISH_READBACK_INVALID: timeline duration or frame duration is invalid");
  }
  const roundedFrames = (numerator * 2n + denominator) / (denominator * 2n);
  return `${roundedFrames} frames`;
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

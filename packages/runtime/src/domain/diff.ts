import type { ContextRevision, RationalTime, TimeRange } from "./primitives.js";

import type { Clip, Marker, Caption, StoryElement } from "./project.js";

import type { MediaContext } from "./media.js";

import type { EditorAsset } from "./ports.js";

export interface TimelineDiffProvenance {
  source: "project-snapshot";
  projectId: string;
  sequenceId: string;
  fromRevision: ContextRevision;
  toRevision: ContextRevision;
}

export interface ClipChange {
  type: "ITEM_ADDED" | "ITEM_REMOVED" | "ITEM_MODIFIED";
  itemId: string;
  before?: Clip;
  after?: Clip;
}

export interface MarkerChange {
  type: "MARKER_ADDED" | "MARKER_REMOVED" | "MARKER_MODIFIED";
  itemId: string;
  marker: Marker;
  before?: Marker;
  after?: Marker;
}

export interface CaptionChange {
  type: "CAPTION_ADDED" | "CAPTION_REMOVED" | "CAPTION_MODIFIED";
  itemId: string;
  caption: Caption;
  before?: Caption;
  after?: Caption;
}

export interface StoryElementChange {
  type: "STORY_ELEMENT_ADDED" | "STORY_ELEMENT_REMOVED" | "STORY_ELEMENT_MODIFIED";
  itemId: string;
  element: StoryElement;
  before?: StoryElement;
  after?: StoryElement;
}

export interface MediaChange {
  type: "MEDIA_ADDED" | "MEDIA_REMOVED" | "MEDIA_MODIFIED";
  itemId: string;
  media: MediaContext;
  before?: MediaContext;
  after?: MediaContext;
}

export interface PlayheadChange {
  before?: RationalTime;
  after?: RationalTime;
}

export interface TimelineDiff {
  from: ContextRevision;
  to: ContextRevision;
  provenance: TimelineDiffProvenance;
  added: ClipChange[];
  removed: ClipChange[];
  modified: ClipChange[];
  durationDelta: number;
  durationDeltaTime: RationalTime;
  playheadChange?: PlayheadChange;
  markerChanges: MarkerChange[];
  captionChanges: CaptionChange[];
  storyElementChanges: StoryElementChange[];
  mediaChanges: MediaChange[];
  affectedRanges: TimeRange[];
}

export interface AssetChange {
  type: "ASSET_ADDED" | "ASSET_REMOVED" | "ASSET_MODIFIED";
  assetId: string;
  before?: EditorAsset;
  after?: EditorAsset;
}

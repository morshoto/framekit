import type { ContextRevision, RationalTime, TimeRange } from "./primitives.js";

import type { Clip, Marker, Caption, StoryElement } from "./project.js";

import type { MediaContext } from "./media.js";

import type { EditorAsset } from "./ports.js";

export interface ClipChange {
  type: "ITEM_ADDED" | "ITEM_REMOVED" | "ITEM_MODIFIED";
  itemId: string;
  before?: Clip;
  after?: Clip;
}

export interface TimelineDiff {
  from: ContextRevision;
  to: ContextRevision;
  added: ClipChange[];
  removed: ClipChange[];
  modified: ClipChange[];
  durationDelta: number;
  durationDeltaTime?: RationalTime;
  markerChanges: Array<{
    type: "MARKER_ADDED" | "MARKER_REMOVED" | "MARKER_MODIFIED";
    marker: Marker;
    before?: Marker;
    after?: Marker;
  }>;
  captionChanges: Array<{
    type: "CAPTION_ADDED" | "CAPTION_REMOVED" | "CAPTION_MODIFIED";
    caption: Caption;
    before?: Caption;
    after?: Caption;
  }>;
  storyElementChanges: Array<{
    type: "STORY_ELEMENT_ADDED" | "STORY_ELEMENT_REMOVED" | "STORY_ELEMENT_MODIFIED";
    element: StoryElement;
    before?: StoryElement;
    after?: StoryElement;
  }>;
  mediaChanges: Array<{
    type: "MEDIA_ADDED" | "MEDIA_REMOVED" | "MEDIA_MODIFIED";
    media: MediaContext;
    before?: MediaContext;
    after?: MediaContext;
  }>;
  affectedRanges: TimeRange[];
}

export interface AssetChange {
  type: "ASSET_ADDED" | "ASSET_REMOVED" | "ASSET_MODIFIED";
  assetId: string;
  before?: EditorAsset;
  after?: EditorAsset;
}

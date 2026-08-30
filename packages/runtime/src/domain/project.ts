import type { ContextRevision, RationalTime } from "./primitives.js";

import type { MediaContext } from "./media.js";

export interface Clip {
  /** Stable identity of this timeline occurrence, never the media resource id. */
  id: string;
  mediaId?: string;
  name: string;
  start: number;
  duration: number;
  track: number;
  gainDb?: number;
  fadeIn?: number;
  fadeOut?: number;
  enabled?: boolean;
  role?: "video" | "audio" | "music" | "title";
  attachedTo?: string;
  /** Authoritative exact timeline coordinates; start/duration are convenience seconds. */
  startTime: RationalTime;
  durationTime: RationalTime;
}

export interface Marker {
  id: string;
  start: number;
  duration: number;
  name: string;
  startTime?: RationalTime;
  durationTime?: RationalTime;
}

export interface Caption {
  id: string;
  start: number;
  duration: number;
  text: string;
  startTime?: RationalTime;
  durationTime?: RationalTime;
}

export interface ProjectSnapshot {
  projectId: string;
  projectName: string;
  timeline: {
    id: string;
    name: string;
    duration: number;
    durationTime?: RationalTime;
    clips: Clip[];
    storyElements: StoryElement[];
    markers: Marker[];
    captions: Caption[];
  };
  media: MediaContext[];
  revision: ContextRevision;
}

/** Ordered FCPXML story elements retained so heterogeneous spines are not lost. */
export interface StoryElement {
  id: string;
  kind: string;
  start: number;
  duration: number;
  startTime?: RationalTime;
  durationTime?: RationalTime;
  lane?: number;
  mediaId?: string;
  assetId?: string;
  text?: string;
  attachedTo?: string;
  beforeClipId?: string;
  afterClipId?: string;
}

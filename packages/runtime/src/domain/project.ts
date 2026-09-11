import type { ContextRevision, RationalTime } from "./primitives.js";

import type { MediaContext } from "./media.js";
import type { MaskConfiguration } from "./editing.js";

export type ColorCorrectionPreset = "neutral" | "warm" | "cool" | "high-contrast";

export interface ColorCorrection {
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  preset?: ColorCorrectionPreset;
}

export interface PictureInPicturePosition {
  /** Horizontal and vertical offsets in timeline pixels from the canvas center. */
  x: number;
  y: number;
}

export interface PictureInPictureCrop {
  /** Fractions of the source frame to crop from each edge. */
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PictureInPictureFrame {
  style: "solid";
  color: string;
  width: number;
}

export interface Clip {
  /** Stable identity of this timeline occurrence, never the media resource id. */
  id: string;
  mediaId?: string;
  name: string;
  start: number;
  duration: number;
  /** Source-media start for trimmed occurrences; absent means zero. */
  sourceStart?: number;
  sourceStartTime?: RationalTime;
  track: number;
  gainDb?: number;
  noiseReductionDb?: number;
  colorCorrection?: ColorCorrection;
  mask?: MaskConfiguration;
  fadeIn?: number;
  fadeOut?: number;
  enabled?: boolean;
  role?: "video" | "audio" | "music" | "title";
  attachedTo?: string;
  position?: PictureInPicturePosition;
  scale?: number;
  crop?: PictureInPictureCrop;
  frame?: PictureInPictureFrame;
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
    frameDuration?: RationalTime;
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
  position?: PictureInPicturePosition;
  scale?: number;
  crop?: PictureInPictureCrop;
  frame?: PictureInPictureFrame;
  mask?: MaskConfiguration;
}

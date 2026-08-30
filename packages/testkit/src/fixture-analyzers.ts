import type {
  AnalysisInput,
  AudioAnalysis,
  AudioAnalyzer,
  MetadataAnalysis,
  MetadataAnalyzer,
  VisualAnalysis,
  VisualAnalyzer,
  SpeechAnalysis,
  SpeechAnalyzer,
  SpeechSegment,
  SpeechWord,
  TimeRange,
} from "@framekit/runtime";

export class FixtureSpeechAnalyzer implements SpeechAnalyzer {
  public readonly descriptor = { id: "fixture.speech", provider: "fixture", version: "1" };

  public async analyze(input: AnalysisInput, range?: TimeRange): Promise<SpeechAnalysis> {
    const speech = input.media.speech;
    if (!speech) throw new Error(`ANALYSIS_FAILED: no speech fixture for ${input.media.mediaId}`);
    return {
      words: filterRange(speech.words, range),
      ...(speech.vadSegments ? { vadSegments: filterSegments(speech.vadSegments, range) } : {}),
      ...(speech.silenceSegments ? { silenceSegments: filterSegments(speech.silenceSegments, range) } : {}),
      ...(speech.protectedSegments ? { protectedSegments: filterSegments(speech.protectedSegments, range) } : {}),
    };
  }
}

export class FixtureAudioAnalyzer implements AudioAnalyzer {
  public readonly descriptor = { id: "fixture.audio", provider: "fixture", version: "1" };

  public async analyze(input: AnalysisInput, range?: TimeRange): Promise<AudioAnalysis> {
    if (!input.media.audio) throw new Error(`ANALYSIS_FAILED: no audio fixture for ${input.media.mediaId}`);
    return { ...input.media.audio };
  }
}

export class FixtureVisualAnalyzer implements VisualAnalyzer {
  public readonly descriptor = { id: "fixture.visual", provider: "fixture", version: "1" };

  public async analyze(input: AnalysisInput, range?: TimeRange): Promise<VisualAnalysis> {
    const visual = input.media.visual;
    if (!visual) throw new Error(`ANALYSIS_FAILED: no visual fixture for ${input.media.mediaId}`);
    if (!range) return structuredClone(visual);
    return {
      scenes: visual.scenes.filter((scene) => scene.end > range.start && scene.start < range.end).map((scene) => ({ ...scene })),
      subjects: visual.subjects.filter((subject) => (subject.end ?? Number.POSITIVE_INFINITY) > range.start && (subject.start ?? 0) < range.end).map((subject) => ({ ...subject })),
      keyframes: visual.keyframes.filter((keyframe) => keyframe.time >= range.start && keyframe.time <= range.end).map((keyframe) => ({ ...keyframe, labels: keyframe.labels ? [...keyframe.labels] : undefined })),
      motion: visual.motion ? { ...visual.motion } : undefined,
    };
  }
}

export class FixtureMetadataAnalyzer implements MetadataAnalyzer {
  public readonly descriptor = { id: "fixture.metadata", provider: "fixture", version: "1" };

  public async analyze(input: AnalysisInput, range?: TimeRange): Promise<MetadataAnalysis> {
    if (!input.media.metadata) throw new Error(`ANALYSIS_FAILED: no metadata fixture for ${input.media.mediaId}`);
    const metadata = structuredClone(input.media.metadata);
    if (!range || !metadata.usableRanges) return metadata;
    return {
      ...metadata,
      usableRanges: metadata.usableRanges.filter((candidate) => candidate.end > range.start && candidate.start < range.end),
    };
  }
}

function filterRange(words: SpeechWord[], range?: TimeRange): SpeechWord[] {
  if (!range) return words.map((word) => ({ ...word }));
  return words
    .filter((word) => word.end > range.start && word.start < range.end)
    .map((word) => ({ ...word }));
}

function filterSegments(segments: SpeechSegment[], range?: TimeRange): SpeechSegment[] {
  if (!range) return segments.map((segment) => ({ ...segment }));
  return segments
    .filter((segment) => segment.end > range.start && segment.start < range.end)
    .map((segment) => ({ ...segment }));
}

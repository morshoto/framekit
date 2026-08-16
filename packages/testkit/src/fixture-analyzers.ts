import type {
  AnalysisInput,
  AudioAnalysis,
  AudioAnalyzer,
  VisualAnalysis,
  VisualAnalyzer,
  SpeechAnalysis,
  SpeechAnalyzer,
  SpeechWord,
  TimeRange,
} from "@framekit/runtime";

export class FixtureSpeechAnalyzer implements SpeechAnalyzer {
  public async analyze(input: AnalysisInput, range?: TimeRange): Promise<SpeechAnalysis> {
    const speech = input.media.speech;
    if (!speech) throw new Error(`ANALYSIS_FAILED: no speech fixture for ${input.media.mediaId}`);
    return {
      words: filterRange(speech.words, range),
    };
  }
}

export class FixtureAudioAnalyzer implements AudioAnalyzer {
  public async analyze(input: AnalysisInput, range?: TimeRange): Promise<AudioAnalysis> {
    if (!input.media.audio) throw new Error(`ANALYSIS_FAILED: no audio fixture for ${input.media.mediaId}`);
    return { ...input.media.audio };
  }
}

export class FixtureVisualAnalyzer implements VisualAnalyzer {
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

function filterRange(words: SpeechWord[], range?: TimeRange): SpeechWord[] {
  if (!range) return words.map((word) => ({ ...word }));
  return words
    .filter((word) => word.end > range.start && word.start < range.end)
    .map((word) => ({ ...word }));
}

import type {
  AnalysisInput,
  AudioAnalysis,
  AudioAnalyzer,
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

function filterRange(words: SpeechWord[], range?: TimeRange): SpeechWord[] {
  if (!range) return words.map((word) => ({ ...word }));
  return words
    .filter((word) => word.end > range.start && word.start < range.end)
    .map((word) => ({ ...word }));
}

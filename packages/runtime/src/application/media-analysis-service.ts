import type {
  AudioAnalysis,
  MediaContext,
  MediaUnderstanding,
  SpeechAnalysis,
  VisualAnalysis,
} from "../domain/media.js";
import type { EditTransaction } from "../domain/editing.js";
import type { ProjectSnapshot } from "../domain/project.js";
import type { TimeRange } from "../domain/primitives.js";
import { ContextEngine } from "../context/context-engine.js";
import { ProjectService } from "./project-service.js";
import type { RuntimeOptions } from "./runtime-options.js";

export class MediaAnalysisService {
  public constructor(
    private readonly project: ProjectService,
    private readonly context: ContextEngine,
    private readonly options: RuntimeOptions,
  ) {}

  public async analyzeSpeech(mediaId: string): Promise<SpeechAnalysis> {
    if (!this.options.speechAnalyzer) throw new Error("CAPABILITY_UNAVAILABLE: speech analysis");
    const project = await this.project.inspectProject();
    const media = findMedia(project, mediaId);
    return this.options.speechAnalyzer.analyze({ project, media });
  }

  public async analyzeAudio(mediaId: string): Promise<AudioAnalysis> {
    if (!this.options.audioAnalyzer) throw new Error("CAPABILITY_UNAVAILABLE: audio analysis");
    const project = await this.project.inspectProject();
    const media = findMedia(project, mediaId);
    return this.options.audioAnalyzer.analyze({ project, media });
  }

  public async analyzeVisual(mediaId: string, range?: TimeRange): Promise<VisualAnalysis> {
    if (!this.options.visualAnalyzer) throw new Error("CAPABILITY_UNAVAILABLE: visual analysis");
    const project = await this.project.inspectProject();
    const media = findMedia(project, mediaId);
    return this.options.visualAnalyzer.analyze({ project, media }, range);
  }

  public async understandMedia(mediaId: string): Promise<MediaUnderstanding> {
    const project = await this.project.inspectProject();
    const media = findMedia(project, mediaId);
    const input = { project, media };
    const [speech, audio, visual] = await Promise.all([
      this.options.speechAnalyzer?.analyze(input),
      this.options.audioAnalyzer?.analyze(input),
      this.options.visualAnalyzer?.analyze(input),
    ]);
    if (!speech && !audio && !visual) {
      throw new Error("CAPABILITY_UNAVAILABLE: media understanding");
    }
    const understanding: MediaUnderstanding = {
      mediaId: media.mediaId,
      source: media.source,
      ...(speech ? { speech } : {}),
      ...(audio ? { audio } : {}),
      ...(visual ? { visual } : {}),
      analysisRevision: project.revision,
    };
    this.context.attachMediaUnderstanding(understanding);
    return structuredClone(understanding);
  }

  public async inspectMedia(mediaId: string): Promise<MediaContext> {
    const project = await this.project.inspectProject();
    return findMedia(project, mediaId);
  }

  public async searchMedia(query: string): Promise<MediaContext[]> {
    const project = await this.project.inspectProject();
    const normalized = query.trim().toLowerCase();
    return project.media.filter((media) =>
      media.mediaId.toLowerCase().includes(normalized) || media.source.toLowerCase().includes(normalized),
    );
  }

  public async reanalyzeAffectedRanges(transaction: EditTransaction): Promise<ProjectSnapshot> {
    const affectedMediaRanges = transaction.diff.affectedRanges.flatMap((range) =>
      transaction.attemptedAfter.timeline.clips.flatMap((clip) => {
        const intersectionStart = Math.max(range.start, clip.start);
        const intersectionEnd = Math.min(range.end, clip.start + clip.duration);
        if (!clip.mediaId || intersectionStart >= intersectionEnd) return [];
        return [{
          mediaId: clip.mediaId,
          range: {
            start: intersectionStart - clip.start,
            end: intersectionEnd - clip.start,
          },
        }];
      }),
    );
    const mediaIds = new Set(affectedMediaRanges.map(({ mediaId }) => mediaId));
    if (mediaIds.size === 0) return transaction.attemptedAfter;
    const next = structuredClone(transaction.attemptedAfter);
    for (const mediaId of mediaIds) {
      const media = next.media.find((candidate) => candidate.mediaId === mediaId);
      if (!media) continue;
      const ranges = affectedMediaRanges
        .filter((affected) => affected.mediaId === mediaId)
        .map((affected) => affected.range);
      const input = { project: next, media };
      if (this.options.speechAnalyzer) {
        const analyses = await Promise.all(ranges.map((range) => this.options.speechAnalyzer!.analyze(input, range)));
        media.speech = { words: analyses.flatMap((analysis) => analysis.words) };
      }
      if (this.options.audioAnalyzer) {
        const analyses = await Promise.all(ranges.map((range) => this.options.audioAnalyzer!.analyze(input, range)));
        if (analyses[analyses.length - 1]) media.audio = analyses[analyses.length - 1];
      }
      if (this.options.visualAnalyzer) {
        const analyses = await Promise.all(ranges.map((range) => this.options.visualAnalyzer!.analyze(input, range)));
        media.visual = {
          scenes: analyses.flatMap((analysis) => analysis.scenes),
          subjects: analyses.flatMap((analysis) => analysis.subjects),
          keyframes: analyses.flatMap((analysis) => analysis.keyframes),
          motion: analyses[analyses.length - 1]?.motion,
        };
      }
      if (this.options.speechAnalyzer || this.options.audioAnalyzer || this.options.visualAnalyzer) {
        for (const candidate of next.media) {
          if (candidate.mediaId === mediaId) candidate.analysisRevision = next.revision.id;
        }
      }
    }
    return next;
  }
}

function findMedia(project: ProjectSnapshot, mediaId: string): MediaContext {
  const media = project.media.find((candidate) => candidate.mediaId === mediaId);
  if (!media) throw new Error(`MEDIA_NOT_FOUND: ${mediaId}`);
  return media;
}

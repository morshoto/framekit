import type {
  AudioAnalysis,
  AudioMeasurement,
  AnalyzerDescriptor,
  MetadataAnalysis,
  MediaContext,
  MediaAnalysisCapability,
  MediaAnalysisStatus,
  MediaIndexEntry,
  MediaIndexQuery,
  MediaSemanticDescription,
  RoughCutPlan,
  RoughCutPlanRequest,
  MediaUnderstanding,
  MediaSourceIdentity,
  SpeechAnalysis,
  VisualAnalysis,
} from "../domain/media.js";
import type { EditTransaction } from "../domain/editing.js";
import type { ProjectSnapshot } from "../domain/project.js";
import type { TimeRange } from "../domain/primitives.js";
import { ContextEngine } from "../context/context-engine.js";
import { ProjectService } from "./project-service.js";
import type { RuntimeOptions } from "./runtime-options.js";
import { planRoughCut } from "../planning/rough-cut.js";

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

  public async measureAudio(mediaId: string, occurrenceId: string): Promise<AudioMeasurement> {
    if (!this.options.audioAnalyzer) throw new Error("CAPABILITY_UNAVAILABLE: audio analysis");
    const project = await this.project.inspectProject();
    const clip = project.timeline.clips.find((candidate) => candidate.id === occurrenceId);
    if (!clip) throw new Error(`OCCURRENCE_NOT_FOUND: ${occurrenceId}`);
    if (clip.mediaId !== mediaId) {
      throw new Error(`TARGET_MISMATCH: occurrence ${occurrenceId} does not reference media ${mediaId}`);
    }
    const media = findMedia(project, mediaId);
    const requestedRange = { start: 0, end: clip.duration };
    const analysis = await this.options.audioAnalyzer.analyze({ project, media }, requestedRange);
    const analyzedDurationSeconds = analysis.analyzedDurationSeconds ?? clip.duration;
    const valid = analysis.valid !== false
      && Number.isFinite(analysis.integratedLufs)
      && Number.isFinite(analysis.truePeakDb)
      && Number.isFinite(analysis.silenceMs)
      && Number.isFinite(analyzedDurationSeconds)
      && analyzedDurationSeconds > 0;
    return {
      mediaId,
      occurrenceId,
      requestedRange,
      measuredRange: {
        start: 0,
        end: Number.isFinite(analyzedDurationSeconds) ? analyzedDurationSeconds : clip.duration,
      },
      revision: project.revision,
      provider: this.options.audioAnalyzer.descriptor ?? { id: "framekit.audio", provider: "unknown" },
      dialoguePresent: analysis.dialoguePresent
        ?? Boolean(media.speech?.words.some((word) => word.filler !== true)),
      integratedLufs: analysis.integratedLufs,
      truePeakDb: analysis.truePeakDb,
      silenceMs: analysis.silenceMs,
      analyzedDurationSeconds,
      valid,
      ...(analysis.invalidReason ? { invalidReason: analysis.invalidReason } : {}),
    };
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
    const [speechResult, audioResult, visualResult, metadataResult] = await Promise.all([
      settle(() => this.options.speechAnalyzer?.analyze(input)),
      settle(() => this.options.audioAnalyzer?.analyze(input)),
      settle(() => this.options.visualAnalyzer?.analyze(input)),
      settle(() => this.options.metadataAnalyzer?.analyze(input)),
    ]);
    const speech = fulfilledValue(speechResult);
    const audio = fulfilledValue(audioResult);
    const visual = fulfilledValue(visualResult);
    const metadata = fulfilledValue(metadataResult);
    const sourceIdentity = sourceIdentityOf(media);
    const understanding: MediaUnderstanding = {
      mediaId: media.mediaId,
      source: media.source,
      sourceIdentity,
      ...(metadata ? { metadata } : {}),
      ...(speech ? { speech } : {}),
      ...(audio ? { audio } : {}),
      ...(visual ? { visual } : {}),
      semantic: semanticFromAnalyses(speech, audio, visual, metadata),
      analysis: [
        analysisStatus("speech", this.options.speechAnalyzer, sourceIdentity, Boolean(speech), [], failureReason(speechResult)),
        analysisStatus("audio", this.options.audioAnalyzer, sourceIdentity, Boolean(audio), [], failureReason(audioResult)),
        analysisStatus("visual", this.options.visualAnalyzer, sourceIdentity, Boolean(visual), [], failureReason(visualResult)),
        analysisStatus("metadata", this.options.metadataAnalyzer, sourceIdentity, Boolean(metadata), metadata?.usableRanges, failureReason(metadataResult)),
      ],
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

  public async indexMedia(query: MediaIndexQuery = {}): Promise<MediaIndexEntry[]> {
    const project = await this.project.inspectProject();
    return this.indexFromProject(project, query);
  }

  public async planRoughCut(request: RoughCutPlanRequest): Promise<RoughCutPlan> {
    const project = await this.project.inspectProject();
    const { maxShots: _maxShots, ...query } = request;
    return planRoughCut(this.indexFromProject(project, query), project.revision, request);
  }

  private indexFromProject(project: ProjectSnapshot, query: MediaIndexQuery): MediaIndexEntry[] {
    return project.media
      .map((media) => ({
        sourceIdentity: sourceIdentityOf(media),
        semantic: media.semantic ?? emptySemanticDescription(),
        analysis: media.analysis ?? [
          analysisStatus("speech", this.options.speechAnalyzer, sourceIdentityOf(media), false),
          analysisStatus("audio", this.options.audioAnalyzer, sourceIdentityOf(media), false),
          analysisStatus("visual", this.options.visualAnalyzer, sourceIdentityOf(media), false),
          analysisStatus("metadata", this.options.metadataAnalyzer, sourceIdentityOf(media), false),
        ],
        ...(media.analysisRevision ? { analysisRevision: media.analysisRevision } : {}),
      }))
      .filter((entry) => matchesMediaIndexQuery(entry, query));
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

function sourceIdentityOf(media: MediaContext): MediaSourceIdentity {
  return {
    mediaId: media.mediaId,
    source: media.source,
    ...(media.sourceDigest ? { sourceDigest: media.sourceDigest } : {}),
    ...(media.mediaKind ? { mediaKind: media.mediaKind } : {}),
    ...(media.duration !== undefined ? { duration: media.duration } : {}),
  };
}

function semanticFromAnalyses(
  speech: SpeechAnalysis | undefined,
  audio: AudioAnalysis | undefined,
  visual: VisualAnalysis | undefined,
  metadata: MetadataAnalysis | undefined,
): MediaSemanticDescription {
  return {
    subjects: [
      ...(visual?.subjects ?? []).map((subject) => ({ value: subject.label, confidence: subject.confidence })),
      ...(metadata?.subjects ?? []),
    ],
    scenes: [
      ...(visual?.scenes ?? []).flatMap((scene) => scene.label ? [{ value: scene.label, confidence: scene.confidence ?? 1 }] : []),
      ...(metadata?.scenes ?? []),
    ],
    environments: metadata?.environments ? structuredClone(metadata.environments) : [],
    timeOfDay: metadata?.timeOfDay ? structuredClone(metadata.timeOfDay) : [],
    moods: metadata?.moods ? structuredClone(metadata.moods) : [],
    ...(visual?.motion ? { motion: structuredClone(visual.motion) } : {}),
    usableRanges: metadata?.usableRanges ? structuredClone(metadata.usableRanges) : [],
    ...(speech ? { transcript: speech.words.map((word) => word.text).join(" ") } : {}),
    ...(audio ? {
      audio: {
        present: true,
        integratedLufs: audio.integratedLufs,
        truePeakDb: audio.truePeakDb,
        silenceMs: audio.silenceMs,
      },
    } : {}),
  };
}

function emptySemanticDescription(): MediaSemanticDescription {
  return {
    subjects: [],
    scenes: [],
    environments: [],
    timeOfDay: [],
    moods: [],
    usableRanges: [],
  };
}

function matchesMediaIndexQuery(entry: MediaIndexEntry, query: MediaIndexQuery): boolean {
  const text = query.query?.trim().toLowerCase();
  const values = [
    entry.sourceIdentity.mediaId,
    entry.sourceIdentity.source,
    entry.semantic.transcript ?? "",
    ...entry.semantic.subjects.map((tag) => tag.value),
    ...entry.semantic.scenes.map((tag) => tag.value),
    ...entry.semantic.environments.map((tag) => tag.value),
    ...entry.semantic.timeOfDay.map((tag) => tag.value),
    ...entry.semantic.moods.map((tag) => tag.value),
  ].map((value) => value.toLowerCase());
  if (text && !values.some((value) => value.includes(text))) return false;
  if (query.subject && !matchesTag(entry.semantic.subjects, query.subject)) return false;
  if (query.scene && !matchesTag(entry.semantic.scenes, query.scene)) return false;
  if (query.environment && !matchesTag(entry.semantic.environments, query.environment)) return false;
  if (query.timeOfDay && !matchesTag(entry.semantic.timeOfDay, query.timeOfDay)) return false;
  if (query.mood && !matchesTag(entry.semantic.moods, query.mood)) return false;
  if (query.motion && entry.semantic.motion?.label !== query.motion) return false;
  if (query.range && !entry.semantic.usableRanges.some((range) => range.end > query.range!.start && range.start < query.range!.end)) return false;
  if (query.capabilities?.some((capability) => !entry.analysis.some((record) => record.capability === capability && record.status !== "unavailable"))) {
    return false;
  }
  return true;
}

function matchesTag(tags: Array<{ value: string }>, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return tags.some((tag) => tag.value.toLowerCase() === normalized);
}

function analysisStatus(
  capability: MediaAnalysisCapability,
  analyzer: { descriptor?: AnalyzerDescriptor } | undefined,
  source: MediaSourceIdentity,
  analyzed: boolean,
  ranges: import("../domain/primitives.js").TimeRange[] = [],
  failureReason?: string,
): MediaAnalysisStatus {
  if (!analyzer) {
    return { capability, status: "unavailable", reason: `${capability} analyzer is not configured` };
  }
  if (failureReason) return { capability, status: "unavailable", reason: failureReason };
  if (!analyzed) {
    return { capability, status: "available", reason: `${capability} analysis is not attached` };
  }
  return {
    capability,
    status: "analyzed",
    provenance: {
      analyzer: analyzer.descriptor ?? { id: `framekit.${capability}`, provider: "unknown" },
      source,
      ranges: structuredClone(ranges),
    },
  };
}

async function settle<T>(operation: () => Promise<T> | undefined): Promise<PromiseSettledResult<T> | undefined> {
  try {
    const promise = operation();
    return promise ? await Promise.resolve(promise).then(
      (value) => ({ status: "fulfilled", value } as const),
      (reason) => ({ status: "rejected", reason } as const),
    ) : undefined;
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

function fulfilledValue<T>(result: PromiseSettledResult<T> | undefined): T | undefined {
  return result?.status === "fulfilled" ? result.value : undefined;
}

function failureReason<T>(result: PromiseSettledResult<T> | undefined): string | undefined {
  return result?.status === "rejected" ? String(result.reason) : undefined;
}

function findMedia(project: ProjectSnapshot, mediaId: string): MediaContext {
  const media = project.media.find((candidate) => candidate.mediaId === mediaId);
  if (!media) throw new Error(`MEDIA_NOT_FOUND: ${mediaId}`);
  return media;
}

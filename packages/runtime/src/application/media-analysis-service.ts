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
  NoiseAnalysis,
  NoiseMeasurement,
  SpeechAnalysis,
  RevisionBoundSpeechAnalysis,
  TimelineSemanticContext,
  TimelineSemanticContextQuery,
  TimelineSemanticObservation,
  TimelineSemanticOccurrenceContext,
  VisualAnalysis,
} from "../domain/media.js";
import { sameMediaSourceIdentity } from "../domain/media.js";
import type { EditTransaction } from "../domain/editing.js";
import type { ProjectSnapshot } from "../domain/project.js";
import type { TimeRange } from "../domain/primitives.js";
import { ContextEngine } from "../context/context-engine.js";
import { ProjectService } from "./project-service.js";
import type { RuntimeOptions } from "./runtime-options.js";
import { CapabilityUnavailableError } from "../domain/capabilities.js";
import { planRoughCut } from "../planning/rough-cut.js";
import { bindSpeechAnalysis } from "../speech/analysis.js";
import { parseRational } from "../timeline/rational-time.js";

export interface PostWriteAnalysisRequirements {
  speech?: boolean;
  audio?: boolean;
  noise?: boolean;
  visual?: boolean;
}

export class MediaAnalysisService {
  public constructor(
    private readonly project: ProjectService,
    private readonly context: ContextEngine,
    private readonly options: RuntimeOptions,
  ) {}

  public async analyzeSpeech(mediaId: string, range?: TimeRange): Promise<RevisionBoundSpeechAnalysis> {
    if (!this.options.speechAnalyzer) throw new Error("CAPABILITY_UNAVAILABLE: speech analysis");
    const project = await this.project.inspectProject();
    const media = findMedia(project, mediaId);
    return this.analyzeSpeechForProject(project, media, range);
  }

  public async analyzeAudio(mediaId: string, range?: TimeRange): Promise<AudioAnalysis> {
    if (!this.options.audioAnalyzer) throw new Error("CAPABILITY_UNAVAILABLE: audio analysis");
    const project = await this.project.inspectProject();
    const media = findMedia(project, mediaId);
    return this.analyzeAudioForProject(project, media, range);
  }

  public async analyzeNoise(mediaId: string, range?: TimeRange): Promise<NoiseAnalysis> {
    if (!this.options.noiseAnalyzer) throw new Error("CAPABILITY_UNAVAILABLE: audio noise analysis");
    const project = await this.project.inspectProject();
    const media = findMedia(project, mediaId);
    return this.options.noiseAnalyzer.analyze({ project, media }, range);
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
    const sourceStart = clip.sourceStart ?? 0;
    const requestedRange = { start: sourceStart, end: sourceStart + clip.duration };
    const analysis = await this.analyzeAudioForProject(project, media, requestedRange);
    const measuredRange = analysis.measuredRange ?? requestedRange;
    const analyzedDurationSeconds = analysis.analyzedDurationSeconds ?? measuredRange.end - measuredRange.start;
    if (Math.abs(analyzedDurationSeconds - (measuredRange.end - measuredRange.start)) > 0.000001) {
      throw new Error("ANALYSIS_INVALID: audio measured duration does not match its measured range");
    }
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
      measuredRange,
      revision: project.revision,
      provider: analysis.provider ?? this.options.audioAnalyzer.descriptor ?? { id: "framekit.audio", provider: "unknown" },
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

  public async measureNoise(mediaId: string, occurrenceId: string): Promise<NoiseMeasurement> {
    if (!this.options.noiseAnalyzer) throw new Error("CAPABILITY_UNAVAILABLE: audio noise analysis");
    const project = await this.project.inspectProject();
    const clip = project.timeline.clips.find((candidate) => candidate.id === occurrenceId);
    if (!clip) throw new Error(`OCCURRENCE_NOT_FOUND: ${occurrenceId}`);
    if (clip.mediaId !== mediaId) {
      throw new Error(`TARGET_MISMATCH: occurrence ${occurrenceId} does not reference media ${mediaId}`);
    }
    const media = findMedia(project, mediaId);
    const requestedRange = { start: 0, end: clip.duration };
    const analysis = await this.options.noiseAnalyzer.analyze({ project, media }, requestedRange);
    const measuredEnd = analysis.affectedRanges.reduce((end, range) => Math.max(end, range.end), 0);
    const measuredRange = {
      start: 0,
      end: Math.max(analysis.affectedRanges.length > 0 ? measuredEnd : requestedRange.end, 0),
    };
    const valid = analysis.valid !== false
      && Number.isFinite(analysis.noiseFloorDb)
      && Number.isFinite(analysis.recommendedReductionDb)
      && Number.isFinite(analysis.confidence)
      && analysis.confidence >= 0
      && analysis.confidence <= 1
      && analysis.affectedRanges.every((range) => Number.isFinite(range.start)
        && Number.isFinite(range.end) && range.start >= 0 && range.end > range.start);
    return {
      ...structuredClone(analysis),
      mediaId,
      occurrenceId,
      requestedRange,
      measuredRange,
      revision: project.revision,
      provider: this.options.noiseAnalyzer.descriptor ?? { id: "framekit.audio-noise", provider: "unknown" },
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
    const cached = await this.loadCachedUnderstanding(project, media);
    if (cached) {
      this.context.attachMediaUnderstanding(cached);
      return structuredClone(cached);
    }
    const input = { project, media };
    const [speechResult, audioResult, noiseResult, visualResult, metadataResult] = await Promise.all([
      settle(() => this.options.speechAnalyzer ? this.analyzeSpeechForProject(project, media) : undefined),
      settle(() => this.options.audioAnalyzer ? this.analyzeAudioForProject(project, media) : undefined),
      settle(() => this.options.noiseAnalyzer?.analyze(input)),
      settle(() => this.options.visualAnalyzer?.analyze(input)),
      settle(() => this.options.metadataAnalyzer?.analyze(input)),
    ]);
    const speech = fulfilledValue(speechResult);
    const audio = fulfilledValue(audioResult);
    const noise = fulfilledValue(noiseResult);
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
      ...(noise ? { noise } : {}),
      ...(visual ? { visual } : {}),
      semantic: semanticFromAnalyses(speech, audio, visual, metadata),
      analysis: [
        analysisStatus("speech", this.options.speechAnalyzer, sourceIdentity, Boolean(speech), [], failureReason(speechResult)),
        analysisStatus("audio", this.options.audioAnalyzer, sourceIdentity, Boolean(audio), [], failureReason(audioResult)),
        analysisStatus("noise", this.options.noiseAnalyzer, sourceIdentity, Boolean(noise), noise?.affectedRanges, failureReason(noiseResult)),
        analysisStatus("visual", this.options.visualAnalyzer, sourceIdentity, Boolean(visual), [], failureReason(visualResult)),
        analysisStatus("metadata", this.options.metadataAnalyzer, sourceIdentity, Boolean(metadata), metadata?.usableRanges, failureReason(metadataResult)),
      ],
      analysisRevision: project.revision,
    };
    this.context.attachMediaUnderstanding(understanding);
    await this.options.semanticMediaIndexStore?.save(understanding);
    return structuredClone(understanding);
  }

  public async inspectMedia(mediaId: string): Promise<MediaContext> {
    const project = await this.project.inspectProject();
    return findMedia(project, mediaId);
  }

  public async searchMedia(query: string): Promise<MediaContext[]> {
    return this.project.searchMedia(query);
  }

  public async indexMedia(query: MediaIndexQuery = {}): Promise<MediaIndexEntry[]> {
    const project = await this.project.inspectProject();
    const current = this.indexFromProject(project, query);
    const persisted = await this.persistedIndexEntries(query);
    return mergeIndexEntries(persisted, current);
  }

  public async planRoughCut(request: RoughCutPlanRequest): Promise<RoughCutPlan> {
    const project = await this.project.inspectProject();
    const { maxShots: _maxShots, ...query } = request;
    const current = this.indexFromProject(project, query);
    const persisted = await this.persistedIndexEntries(query);
    return planRoughCut(mergeIndexEntries(persisted, current), project.revision, request);
  }

  public async inspectTimelineSemanticContext(
    query: TimelineSemanticContextQuery = {},
  ): Promise<TimelineSemanticContext> {
    const project = await this.project.inspectProject();
    const requestedOccurrenceIds = query.occurrenceIds ? new Set(query.occurrenceIds) : undefined;
    const occurrences: TimelineSemanticOccurrenceContext[] = [];
    for (const clip of project.timeline.clips) {
      if (requestedOccurrenceIds && !requestedOccurrenceIds.has(clip.id)) continue;
      const context = await this.inspectTimelineOccurrence(project, clip, query);
      if (context.status === "available" || requestedOccurrenceIds || !query.query) {
        if (!query.query || context.status === "unavailable" || context.observations.length > 0) {
          occurrences.push(context);
        }
      }
    }
    return {
      projectId: project.projectId,
      timelineId: project.timeline.id,
      revision: structuredClone(project.revision),
      query: structuredClone(query),
      occurrences,
    };
  }

  private async inspectTimelineOccurrence(
    project: ProjectSnapshot,
    clip: ProjectSnapshot["timeline"]["clips"][number],
    query: TimelineSemanticContextQuery,
  ): Promise<TimelineSemanticOccurrenceContext> {
    if (!clip.mediaId) return unavailableTimelineOccurrence(clip.id, "timeline occurrence has no media binding");
    const media = project.media.find((candidate) => candidate.mediaId === clip.mediaId);
    if (!media) return unavailableTimelineOccurrence(clip.id, `media binding is unavailable: ${clip.mediaId}`, clip.mediaId);
    const sourceStart = clip.sourceStart ?? (clip.sourceStartTime ? rationalSeconds(clip.sourceStartTime) : 0);
    const sourceDuration = clip.durationTime ? rationalSeconds(clip.durationTime) : clip.duration;
    const sourceRange: TimeRange = {
      start: sourceStart,
      end: sourceStart + sourceDuration,
      ...(clip.sourceStartTime ? { startTime: structuredClone(clip.sourceStartTime) } : {}),
      durationTime: structuredClone(clip.durationTime),
    };
    if (!Number.isFinite(sourceRange.start) || !Number.isFinite(sourceRange.end) || sourceRange.start < 0 || sourceRange.end <= sourceRange.start) {
      return unavailableTimelineOccurrence(clip.id, "timeline occurrence source range is invalid", clip.mediaId, sourceRange);
    }
    if (media.duration !== undefined && sourceRange.end > media.duration + 0.000001) {
      return unavailableTimelineOccurrence(clip.id, "timeline occurrence source range exceeds media duration", clip.mediaId, sourceRange);
    }

    const sourceIdentity = sourceIdentityOf(media);
    const understanding = await this.options.semanticMediaIndexStore?.load(sourceIdentity)
      ?? understandingFromMediaContext(media, project.revision);
    if (!understanding) {
      return unavailableTimelineOccurrence(clip.id, "source-bound semantic index entry is unavailable", clip.mediaId, sourceRange, sourceIdentity);
    }
    const observations = timelineSemanticObservations(understanding, sourceRange);
    const filtered = query.query
      ? observations.filter((observation) => timelineObservationMatches(observation, query.query!))
      : observations;
    return {
      occurrenceId: clip.id,
      status: "available",
      mediaId: clip.mediaId,
      sourceIdentity: structuredClone(understanding.sourceIdentity),
      sourceRange,
      observations: filtered,
      analysis: structuredClone(understanding.analysis),
      analysisRevision: understanding.analysisRevision.id,
    };
  }

  private async loadCachedUnderstanding(
    project: ProjectSnapshot,
    media: MediaContext,
  ): Promise<MediaUnderstanding | undefined> {
    const store = this.options.semanticMediaIndexStore;
    if (!store) return undefined;
    const cached = await store.load(sourceIdentityOf(media));
    if (!cached || !cacheMatchesAnalyzers(cached, this.options)) return undefined;
    const rebound = structuredClone(cached);
    const sourceIdentity = sourceIdentityOf(media);
    rebound.sourceIdentity = sourceIdentity;
    rebound.mediaId = media.mediaId;
    rebound.source = media.source;
    rebound.analysisRevision = structuredClone(project.revision);
    if (rebound.speech) {
      rebound.speech.mediaId = media.mediaId;
      rebound.speech.sourceIdentity = sourceIdentity;
      rebound.speech.revision = structuredClone(project.revision);
    }
    if (rebound.audio) {
      rebound.audio.mediaId = media.mediaId;
      rebound.audio.sourceIdentity = sourceIdentity;
      rebound.audio.revision = structuredClone(project.revision);
    }
    return rebound;
  }

  private async persistedIndexEntries(query: MediaIndexQuery): Promise<MediaIndexEntry[]> {
    const entries = await this.options.semanticMediaIndexStore?.list() ?? [];
    return entries
      .map(understandingToIndexEntry)
      .filter((entry) => matchesMediaIndexQuery(entry, query));
  }

  private indexFromProject(project: ProjectSnapshot, query: MediaIndexQuery): MediaIndexEntry[] {
    return project.media
      .map((media) => ({
        sourceIdentity: sourceIdentityOf(media),
        semantic: media.semantic ?? emptySemanticDescription(),
        analysis: media.analysis ?? [
          analysisStatus("speech", this.options.speechAnalyzer, sourceIdentityOf(media), false),
          analysisStatus("audio", this.options.audioAnalyzer, sourceIdentityOf(media), false),
          analysisStatus("noise", this.options.noiseAnalyzer, sourceIdentityOf(media), false),
          analysisStatus("visual", this.options.visualAnalyzer, sourceIdentityOf(media), false),
          analysisStatus("metadata", this.options.metadataAnalyzer, sourceIdentityOf(media), false),
        ],
        ...(media.analysis?.some((record) => record.capability === "speech" && record.status === "analyzed") && media.speech
          ? { speech: structuredClone(media.speech) }
          : {}),
        ...(media.analysis?.some((record) => record.capability === "audio" && record.status === "analyzed") && media.audio
          ? { audio: structuredClone(media.audio) }
          : {}),
        ...(media.analysisRevision ? { analysisRevision: media.analysisRevision } : {}),
      }))
      .filter((entry) => matchesMediaIndexQuery(entry, query));
  }

  public async reanalyzeAffectedRanges(
    transaction: EditTransaction,
    requirements: PostWriteAnalysisRequirements,
  ): Promise<ProjectSnapshot> {
    const affectedMediaRanges = transaction.diff.affectedRanges.flatMap((range) =>
      transaction.attemptedAfter.timeline.clips.flatMap((clip) => {
        const intersectionStart = Math.max(range.start, clip.start);
        const intersectionEnd = Math.min(range.end, clip.start + clip.duration);
        if (!clip.mediaId || intersectionStart >= intersectionEnd) return [];
        const sourceStart = clip.sourceStart ?? 0;
        return [{
          mediaId: clip.mediaId,
          range: {
            start: sourceStart + intersectionStart - clip.start,
            end: sourceStart + intersectionEnd - clip.start,
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
      const ranges = mergeRanges(affectedMediaRanges
        .filter((affected) => affected.mediaId === mediaId)
        .map((affected) => affected.range));
      const input = { project: next, media };
      if (requirements.speech && this.options.speechAnalyzer) {
        const analyses = await Promise.all(ranges.map(async (range) => bindSpeechAnalysis(
          await this.options.speechAnalyzer!.analyze(input, range),
          { input, range, provider: this.options.speechAnalyzer!.descriptor },
        )));
        const latest = analyses[analyses.length - 1];
        if (latest) {
          media.speech = mergeSpeechAnalyses(media.speech, analyses, ranges, {
            input,
            provider: this.options.speechAnalyzer!.descriptor,
          });
        }
      }
      if (requirements.audio && this.options.audioAnalyzer) {
        const analyses = await Promise.all(ranges.map((range) => this.analyzeAudioForProject(next, media, range)));
        if (analyses[analyses.length - 1]) media.audio = analyses[analyses.length - 1];
      }
      if (requirements.noise && this.options.noiseAnalyzer) {
        const analyses = await Promise.all(ranges.map((range) => this.options.noiseAnalyzer!.analyze(input, range)));
        if (analyses[analyses.length - 1]) media.noise = analyses[analyses.length - 1];
      }
      if (requirements.visual && this.options.visualAnalyzer) {
        const analyses = await Promise.all(ranges.map((range) => this.options.visualAnalyzer!.analyze(input, range)));
        media.visual = {
          scenes: analyses.flatMap((analysis) => analysis.scenes),
          subjects: analyses.flatMap((analysis) => analysis.subjects),
          keyframes: analyses.flatMap((analysis) => analysis.keyframes),
          motion: analyses[analyses.length - 1]?.motion,
        };
      }
      if ((requirements.speech && this.options.speechAnalyzer)
        || (requirements.audio && this.options.audioAnalyzer)
        || (requirements.noise && this.options.noiseAnalyzer)
        || (requirements.visual && this.options.visualAnalyzer)) {
        for (const candidate of next.media) {
          if (candidate.mediaId === mediaId) candidate.analysisRevision = next.revision.id;
        }
      }
    }
    return next;
  }

  private async analyzeSpeechForProject(
    project: ProjectSnapshot,
    media: MediaContext,
    range?: TimeRange,
  ): Promise<RevisionBoundSpeechAnalysis> {
    const analyzer = this.options.speechAnalyzer;
    if (!analyzer) throw new Error("CAPABILITY_UNAVAILABLE: speech analysis");
    const input = { project, media };
    const analysis = await analyzer.analyze(input, range);
    return bindSpeechAnalysis(analysis, {
      input,
      range,
      provider: analyzer.descriptor,
    });
  }

  private async analyzeAudioForProject(
    project: ProjectSnapshot,
    media: MediaContext,
    range?: TimeRange,
  ): Promise<AudioAnalysis> {
    const analyzer = this.options.audioAnalyzer;
    if (!analyzer) throw new Error("CAPABILITY_UNAVAILABLE: audio analysis");
    const requestedRange = range ?? (media.duration === undefined ? undefined : { start: 0, end: media.duration });
    validateRequestedAudioRange(requestedRange, media.duration, "requested audio range");
    const analysis = await analyzer.analyze({ project, media }, requestedRange);
    validateAudioProvenance(analysis, {
      media,
      mediaId: media.mediaId,
      project,
      provider: analyzer.descriptor,
      requestedRange,
    });
    const measuredRange = analysis.measuredRange ?? (requestedRange ? structuredClone(requestedRange) : undefined);
    if (measuredRange && requestedRange) validateAudioRange(measuredRange, requestedRange, "measured audio range");
    if (measuredRange) validateRequestedAudioRange(measuredRange, media.duration, "measured audio source range");
    const analyzedDurationSeconds = measuredRange
      ? analysis.analyzedDurationSeconds ?? measuredRange.end - measuredRange.start
      : analysis.analyzedDurationSeconds;
    if (measuredRange && analyzedDurationSeconds !== undefined
      && Math.abs(analyzedDurationSeconds - (measuredRange.end - measuredRange.start)) > 0.000001) {
      throw new Error("ANALYSIS_INVALID: audio measured duration does not match its measured range");
    }
    return {
      ...structuredClone(analysis),
      schemaVersion: 1,
      mediaId: media.mediaId,
      sourceIdentity: sourceIdentityOf(media),
      ...(requestedRange ? { requestedRange: structuredClone(requestedRange) } : {}),
      ...(measuredRange ? { measuredRange: structuredClone(measuredRange) } : {}),
      revision: structuredClone(project.revision),
      provider: analysis.provider ?? analyzer.descriptor ?? { id: "framekit.audio", provider: "unknown" },
      ...(analyzedDurationSeconds !== undefined ? { analyzedDurationSeconds } : {}),
    };
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

function mergeSpeechAnalyses(
  previous: SpeechAnalysis | undefined,
  analyses: RevisionBoundSpeechAnalysis[],
  updatedRanges: TimeRange[],
  context: Parameters<typeof bindSpeechAnalysis>[1],
): RevisionBoundSpeechAnalysis {
  const latest = analyses[analyses.length - 1];
  if (!latest) throw new Error("ANALYSIS_INVALID: speech reanalysis returned no results");
  if (previous?.provider && !sameDescriptor(previous.provider, latest.provider)) {
    throw new Error("ANALYSIS_INVALID: speech evidence providers cannot be combined");
  }
  if (previous?.sourceTimebase && !sameRational(previous.sourceTimebase, latest.sourceTimebase)) {
    throw new Error("ANALYSIS_INVALID: speech evidence timebases cannot be combined");
  }

  const requestedRange = encompassingRange([
    ...(previous?.requestedRange ? [previous.requestedRange] : []),
    ...analyses.map((analysis) => analysis.requestedRange),
  ]);
  const observedRange = encompassingRange([
    ...(previous?.observedRange ? [previous.observedRange] : []),
    ...analyses.map((analysis) => analysis.observedRange),
  ]);
  const words = mergeSpeechEvidence(
    previous?.words,
    analyses.map((analysis) => analysis.words),
    updatedRanges,
  );
  const hasVad = previous?.vadSegments !== undefined || analyses.some((analysis) => analysis.vadSegments !== undefined);
  const vadSegments = hasVad
    ? mergeSpeechEvidence(previous?.vadSegments, analyses.map((analysis) => analysis.vadSegments ?? []), updatedRanges)
    : undefined;
  const hasSilence = previous?.silenceSegments !== undefined || analyses.some((analysis) => analysis.silenceSegments !== undefined);
  const silenceSegments = hasSilence
    ? mergeSpeechEvidence(previous?.silenceSegments, analyses.map((analysis) => analysis.silenceSegments ?? []), updatedRanges)
    : undefined;
  const hasProtected = previous?.protectedSegments !== undefined || analyses.some((analysis) => analysis.protectedSegments !== undefined);
  const protectedSegments = hasProtected
    ? mergeSpeechEvidence(previous?.protectedSegments, analyses.map((analysis) => analysis.protectedSegments ?? []), updatedRanges)
    : undefined;

  return bindSpeechAnalysis({
    ...latest,
    requestedRange,
    observedRange,
    capability: vadSegments ? "transcription-plus-vad" : latest.capability,
    words,
    ...(vadSegments ? { vadSegments } : {}),
    ...(silenceSegments ? { silenceSegments } : {}),
    ...(protectedSegments ? { protectedSegments } : {}),
  }, context);
}

function mergeSpeechEvidence<T extends { start: number; end: number }>(
  previous: T[] | undefined,
  fresh: T[][],
  updatedRanges: TimeRange[],
): T[] {
  return [
    ...(previous ?? []).filter((evidence) => !updatedRanges.some((range) => rangesOverlap(evidence, range))),
    ...fresh.flat(),
  ].sort((left, right) => left.start - right.start || left.end - right.end);
}

function rangesOverlap(left: { start: number; end: number }, right: TimeRange): boolean {
  return left.end > right.start && left.start < right.end;
}

function encompassingRange(ranges: TimeRange[]): TimeRange {
  if (ranges.length === 0) throw new Error("ANALYSIS_INVALID: speech evidence needs a range");
  return {
    start: Math.min(...ranges.map((range) => range.start)),
    end: Math.max(...ranges.map((range) => range.end)),
  };
}

function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const merged: TimeRange[] = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.end) {
      merged.push(structuredClone(range));
      continue;
    }
    if (range.end > previous.end) {
      previous.end = range.end;
      delete previous.startTime;
      delete previous.durationTime;
    }
  }
  return merged;
}

function sameDescriptor(left: AnalyzerDescriptor, right: AnalyzerDescriptor): boolean {
  return left.id === right.id && left.provider === right.provider && left.version === right.version;
}

function sameRational(left: { value: string; timescale: string }, right: { value: string; timescale: string }): boolean {
  const leftParts = parseRational(left, "ANALYSIS_INVALID");
  const rightParts = parseRational(right, "ANALYSIS_INVALID");
  return leftParts.value * rightParts.timescale === rightParts.value * leftParts.timescale;
}

function semanticFromAnalyses(
  speech: SpeechAnalysis | undefined,
  audio: AudioAnalysis | undefined,
  visual: VisualAnalysis | undefined,
  metadata: MetadataAnalysis | undefined,
): MediaSemanticDescription {
  const usableRanges = mergeRanges([
    ...(metadata?.usableRanges ?? []),
    ...(visual?.scenes ?? []).map((scene) => ({ start: scene.start, end: scene.end })),
    ...(speech?.vadSegments ?? []).filter((segment) => segment.kind === "speech").map((segment) => ({ start: segment.start, end: segment.end })),
  ]);
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
    usableRanges,
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

function understandingFromMediaContext(
  media: MediaContext,
  revision: ProjectSnapshot["revision"],
): MediaUnderstanding | undefined {
  if (!media.semantic && !media.analysis && !media.speech && !media.visual && !media.metadata) return undefined;
  const sourceIdentity = sourceIdentityOf(media);
  return {
    mediaId: media.mediaId,
    source: media.source,
    sourceIdentity,
    ...(media.metadata ? { metadata: structuredClone(media.metadata) } : {}),
    ...(media.speech ? { speech: structuredClone(media.speech) } : {}),
    ...(media.audio ? { audio: structuredClone(media.audio) } : {}),
    ...(media.noise ? { noise: structuredClone(media.noise) } : {}),
    ...(media.visual ? { visual: structuredClone(media.visual) } : {}),
    semantic: structuredClone(media.semantic ?? emptySemanticDescription()),
    analysis: structuredClone(media.analysis ?? []),
    analysisRevision: {
      id: media.analysisRevision ?? revision.id,
      sequence: revision.sequence,
      timestamp: revision.timestamp,
    },
  };
}

function timelineSemanticObservations(
  understanding: MediaUnderstanding,
  sourceRange: TimeRange,
): TimelineSemanticObservation[] {
  const observations: TimelineSemanticObservation[] = [];
  const analyzerFor = (capability: TimelineSemanticObservation["capability"]): AnalyzerDescriptor | undefined =>
    understanding.analysis.find((status) => status.capability === capability)?.provenance?.analyzer;
  for (const word of understanding.speech?.words ?? []) {
    const range = intersectTimeRanges({ start: word.start, end: word.end }, sourceRange);
    if (!range) continue;
    observations.push({
      capability: "speech",
      range,
      text: word.text,
      confidence: word.confidence,
      ...(analyzerFor("speech") ? { analyzer: structuredClone(analyzerFor("speech")) } : {}),
    });
  }
  for (const scene of understanding.visual?.scenes ?? []) {
    const range = intersectTimeRanges({ start: scene.start, end: scene.end }, sourceRange);
    if (!range) continue;
    observations.push({
      capability: "visual",
      range,
      ...(scene.label ? { label: scene.label } : {}),
      ...(scene.confidence !== undefined ? { confidence: scene.confidence } : {}),
      ...(analyzerFor("visual") ? { analyzer: structuredClone(analyzerFor("visual")) } : {}),
    });
  }
  for (const subject of understanding.visual?.subjects ?? []) {
    const range = intersectTimeRanges({
      start: subject.start ?? sourceRange.start,
      end: subject.end ?? sourceRange.end,
    }, sourceRange);
    if (!range) continue;
    observations.push({
      capability: "visual",
      range,
      label: subject.label,
      confidence: subject.confidence,
      ...(analyzerFor("visual") ? { analyzer: structuredClone(analyzerFor("visual")) } : {}),
    });
  }
  for (const range of understanding.metadata?.usableRanges ?? []) {
    const clipped = intersectTimeRanges(range, sourceRange);
    if (!clipped) continue;
    observations.push({
      capability: "metadata",
      range: clipped,
      ...(analyzerFor("metadata") ? { analyzer: structuredClone(analyzerFor("metadata")) } : {}),
    });
  }
  return observations.sort((left, right) => left.range.start - right.range.start
    || left.range.end - right.range.end
    || left.capability.localeCompare(right.capability)
    || (left.text ?? left.label ?? "").localeCompare(right.text ?? right.label ?? ""));
}

function intersectTimeRanges(left: TimeRange, right: TimeRange): TimeRange | undefined {
  const start = Math.max(left.start, right.start);
  const end = Math.min(left.end, right.end);
  return start < end ? { start, end } : undefined;
}

function timelineObservationMatches(observation: TimelineSemanticObservation, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return [observation.text, observation.label]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLocaleLowerCase().includes(normalized));
}

function unavailableTimelineOccurrence(
  occurrenceId: string,
  reason: string,
  mediaId?: string,
  sourceRange?: TimeRange,
  sourceIdentity?: MediaSourceIdentity,
): TimelineSemanticOccurrenceContext {
  return {
    occurrenceId,
    status: "unavailable",
    ...(mediaId ? { mediaId } : {}),
    ...(sourceIdentity ? { sourceIdentity: structuredClone(sourceIdentity) } : {}),
    ...(sourceRange ? { sourceRange: structuredClone(sourceRange) } : {}),
    reason,
    observations: [],
    analysis: [],
  };
}

function rationalSeconds(time: { value: string; timescale: string }): number {
  const parsed = parseRational(time, "TIMELINE_SEMANTIC_CONTEXT_INVALID");
  const seconds = Number(parsed.value) / Number(parsed.timescale);
  if (!Number.isFinite(seconds)) throw new Error("TIMELINE_SEMANTIC_CONTEXT_INVALID: rational time is outside supported range");
  return seconds;
}

function understandingToIndexEntry(understanding: MediaUnderstanding): MediaIndexEntry {
  return {
    sourceIdentity: structuredClone(understanding.sourceIdentity),
    semantic: structuredClone(understanding.semantic),
    analysis: structuredClone(understanding.analysis),
    ...(understanding.speech ? { speech: structuredClone(understanding.speech) } : {}),
    ...(understanding.audio ? { audio: structuredClone(understanding.audio) } : {}),
    analysisRevision: understanding.analysisRevision.id,
  };
}

function mergeIndexEntries(
  persisted: MediaIndexEntry[],
  current: MediaIndexEntry[],
): MediaIndexEntry[] {
  const merged = new Map<string, MediaIndexEntry>();
  for (const entry of [...persisted, ...current]) {
    const key = JSON.stringify(entry.sourceIdentity);
    const previous = merged.get(key);
    if (!previous || indexEntryScore(entry) >= indexEntryScore(previous)) merged.set(key, structuredClone(entry));
  }
  return [...merged.values()].sort((left, right) => left.sourceIdentity.mediaId.localeCompare(right.sourceIdentity.mediaId));
}

function indexEntryScore(entry: MediaIndexEntry): number {
  return entry.analysis.filter((record) => record.status === "analyzed").length
    + entry.semantic.usableRanges.length
    + (entry.semantic.transcript?.trim() ? 1 : 0);
}

function cacheMatchesAnalyzers(understanding: MediaUnderstanding, options: RuntimeOptions): boolean {
  const configured: Array<[MediaAnalysisCapability, { descriptor?: AnalyzerDescriptor } | undefined]> = [
    ["speech", options.speechAnalyzer],
    ["audio", options.audioAnalyzer],
    ["noise", options.noiseAnalyzer],
    ["visual", options.visualAnalyzer],
    ["metadata", options.metadataAnalyzer],
  ];
  return configured.every(([capability, analyzer]) => {
    if (!analyzer) return true;
    const record = understanding.analysis.find((candidate) => candidate.capability === capability);
    return record?.status === "analyzed"
      && record.provenance?.analyzer !== undefined
      && sameDescriptor(record.provenance.analyzer, analyzer.descriptor ?? { id: `framekit.${capability}`, provider: "unknown" });
  });
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

function validateAudioProvenance(
  analysis: AudioAnalysis,
  expected: {
    media: MediaContext;
    mediaId: string;
    project: ProjectSnapshot;
    provider?: AnalyzerDescriptor;
    requestedRange?: TimeRange;
  },
): void {
  if (analysis.schemaVersion !== undefined && analysis.schemaVersion !== 1) {
    throw new Error("ANALYSIS_INVALID: unsupported audio analysis schema version");
  }
  if (analysis.mediaId !== undefined && analysis.mediaId !== expected.mediaId) {
    throw new Error("TARGET_MISMATCH: audio analysis media identity does not match the requested media");
  }
  if (analysis.sourceIdentity !== undefined
    && !sameMediaSourceIdentity(analysis.sourceIdentity, sourceIdentityOf(expected.media))) {
    throw new Error("TARGET_MISMATCH: audio analysis source identity does not match the requested media");
  }
  if (analysis.requestedRange !== undefined && expected.requestedRange !== undefined
    && !sameRange(analysis.requestedRange, expected.requestedRange)) {
    throw new Error("ANALYSIS_INVALID: audio requested range does not match the runtime request");
  }
  if (analysis.revision !== undefined
    && !sameContextRevision(analysis.revision, expected.project.revision)) {
    throw new Error("ANALYSIS_STALE: audio analysis revision does not match the inspected project");
  }
  if (analysis.provider !== undefined && expected.provider !== undefined
    && !sameDescriptor(analysis.provider, expected.provider)) {
    throw new Error("ANALYSIS_INVALID: audio provider identity does not match the configured analyzer");
  }
}

function validateAudioRange(range: TimeRange, requested: TimeRange, label: string): void {
  validateRequestedAudioRange(range, undefined, label);
  if (range.start < requested.start || range.end > requested.end) {
    throw new Error(`ANALYSIS_INVALID: ${label} must fit inside the requested occurrence range`);
  }
}

function validateRequestedAudioRange(range: TimeRange | undefined, duration: number | undefined, label: string): void {
  if (!range) return;
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end)
    || range.start < 0 || range.end <= range.start
    || (duration !== undefined && range.end > duration)) {
    throw new Error(`ANALYSIS_INVALID: ${label} must be finite, positive, and inside the source duration`);
  }
}

function sameContextRevision(left: { id: string; sequence: number; timestamp: string }, right: { id: string; sequence: number; timestamp: string }): boolean {
  return left.id === right.id && left.sequence === right.sequence && left.timestamp === right.timestamp;
}

function sameRange(left: TimeRange, right: TimeRange): boolean {
  return Math.abs(left.start - right.start) <= 0.000001
    && Math.abs(left.end - right.end) <= 0.000001;
}

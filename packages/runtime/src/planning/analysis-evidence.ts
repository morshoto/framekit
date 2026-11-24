import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SemanticMediaIndexStore } from "../application/semantic-media-index-store.js";
import { validateAudioAnalysisPayload, validateAudioAnalysisRange } from "../audio/analysis.js";
import { sameAnalyzerDescriptor, sameMediaSourceIdentity } from "../domain/media.js";
import type { AnalyzerDescriptor, MediaSourceIdentity, MediaUnderstanding } from "../domain/media.js";
import type { ContextRevision, TimeRange } from "../domain/primitives.js";
import type { ProjectSnapshot } from "../domain/project.js";
import { bindSpeechAnalysis } from "../speech/analysis.js";

export interface AnalysisEvidenceContext {
  kind: "speech" | "vad" | "audio";
  source: MediaSourceIdentity;
  provider: AnalyzerDescriptor;
  revision: ContextRevision;
  range: TimeRange;
}

/** Checks current source bytes. Native occurrence binding is a separate caller responsibility. */
export type AnalysisSourceVerifier = (source: MediaSourceIdentity) => Promise<void>;

export interface AnalysisRef extends AnalysisEvidenceContext {
  schemaVersion: 1;
  artifactDigest: string;
  analysisRevision: ContextRevision;
}

/** Content-addressed derived bytes; callers must verify bytes when reading. */
export interface AnalysisArtifactStore {
  put(digest: string, bytes: Uint8Array): Promise<void>;
  get(digest: string): Promise<Uint8Array | undefined>;
}

export class InMemoryAnalysisArtifactStore implements AnalysisArtifactStore {
  private readonly entries = new Map<string, Uint8Array>();
  async put(digest: string, bytes: Uint8Array): Promise<void> {
    if (hash(bytes) !== digest) throw new Error("ANALYSIS_INVALID: artifact digest mismatch");
    this.entries.set(digest, Uint8Array.from(bytes));
  }
  async get(digest: string): Promise<Uint8Array | undefined> {
    const bytes = this.entries.get(digest);
    return bytes && Uint8Array.from(bytes);
  }
}

/** Immutable content-addressed files, published atomically without replacing existing artifacts. */
export class FileAnalysisArtifactStore implements AnalysisArtifactStore {
  constructor(private readonly directory: string) {}
  private path(digest: string): string {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("ANALYSIS_INVALID: invalid artifact digest");
    return join(this.directory, digest.slice(7));
  }
  async put(digest: string, bytes: Uint8Array): Promise<void> {
    const destination = this.path(digest);
    if (hash(bytes) !== digest) throw new Error("ANALYSIS_INVALID: artifact digest mismatch");
    await mkdir(this.directory, { recursive: true });
    const temporary = join(this.directory, `.analysis-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      try {
        await link(temporary, destination);
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        const existing = await readFile(destination);
        if (hash(existing) !== digest) throw new Error("ANALYSIS_INVALID: existing artifact is corrupt");
      }
    } finally {
      try { await unlink(temporary); } catch (error) { if (!isCode(error, "ENOENT")) throw error; }
    }
  }
  async get(digest: string): Promise<Uint8Array | undefined> {
    try { return await readFile(this.path(digest)); }
    catch (error) { if (isCode(error, "ENOENT")) return undefined; throw error; }
  }
}
function isCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}

export type AnalysisEvidenceVerification =
  | { status: "verified" }
  | { status: "unavailable" | "invalid"; reason: string };

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function sameRevision(a: ContextRevision, b: ContextRevision): boolean {
  return a.id === b.id && a.sequence === b.sequence && a.timestamp === b.timestamp;
}
function validRange(range: TimeRange | undefined): range is TimeRange {
  return !!range && Number.isFinite(range.start) && Number.isFinite(range.end) && range.start >= 0 && range.end > range.start;
}
function covers(outer: TimeRange | undefined, inner: TimeRange): boolean {
  return validRange(outer) && outer.start <= inner.start && outer.end >= inner.end;
}
function sameRange(a: TimeRange, b: TimeRange): boolean {
  const sameTime = (x: TimeRange["startTime"], y: TimeRange["startTime"]) =>
    x === undefined ? y === undefined : y !== undefined && x.value === y.value && x.timescale === y.timescale;
  return a.start === b.start && a.end === b.end && sameTime(a.startTime, b.startTime) && sameTime(a.durationTime, b.durationTime);
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function validateContext(context: AnalysisEvidenceContext): void {
  if (!context || !["speech", "vad", "audio"].includes(context.kind)
    || !context.source || !nonempty(context.source.mediaId) || !nonempty(context.source.source) || !nonempty(context.source.sourceDigest)
    || !context.provider || !nonempty(context.provider.id) || !nonempty(context.provider.provider)
    || !nonempty(context.provider.version) || (context.kind !== "audio" && !nonempty(context.provider.model)) || !nonempty(context.provider.configurationDigest)
    || !context.revision || !nonempty(context.revision.id) || !Number.isSafeInteger(context.revision.sequence) || context.revision.sequence < 0
    || !Number.isFinite(Date.parse(context.revision.timestamp)) || !validRange(context.range)) {
    throw new Error("ANALYSIS_INVALID: complete source, provider, revision and range are required");
  }
  validateAudioAnalysisRange(context.range, "evidence range");
  if (context.source.duration !== undefined && (!Number.isFinite(context.source.duration) || context.range.end > context.source.duration)) throw new Error("ANALYSIS_INVALID: evidence range exceeds source");
}

function validateRecord(record: MediaUnderstanding, context: AnalysisEvidenceContext): void {
  validateContext(context);
  if (!record || !sameMediaSourceIdentity(record.sourceIdentity, context.source)
    || record.mediaId !== context.source.mediaId || record.source !== context.source.source
    || !record.analysisRevision || !Array.isArray(record.analysis)) throw new Error("ANALYSIS_INVALID: source or analysis revision mismatch");
  const capability = context.kind === "vad" ? "speech" : context.kind;
  const matches = record.analysis.filter((item) => item.capability === capability && item.status === "analyzed");
  const provenance = matches.length === 1 ? matches[0]?.provenance : undefined;
  if (!provenance || !sameMediaSourceIdentity(provenance.source, context.source)
    || !sameAnalyzerDescriptor(provenance.analyzer, context.provider)
    || !Array.isArray(provenance.ranges) || !provenance.ranges.some((candidate) => covers(candidate, context.range))) {
    throw new Error("ANALYSIS_INVALID: missing or conflicting analysis provenance or coverage");
  }
  if (capability === "speech") {
    const speech = record.speech;
    if (!speech || speech.coverageProvenance !== "provider" || !speech.provider || !speech.sourceIdentity || !speech.revision || !speech.sourceTimebase
      || !covers(speech.requestedRange, context.range) || !covers(speech.observedRange, context.range)) throw new Error("ANALYSIS_INVALID: speech coverage is incomplete or not provider-reported");
    const bound = bindSpeechAnalysis(speech, {
      input: { project: { revision: record.analysisRevision } as ProjectSnapshot, media: context.source }, provider: context.provider,
    });
    if (context.kind === "vad" && (!bound.vadSegments || bound.capability !== "transcription-plus-vad")) throw new Error("ANALYSIS_INVALID: VAD unavailable or partial");
  } else {
    const audio = record.audio;
    if (!audio || audio.coverageProvenance !== "provider" || !audio.provider || !audio.sourceIdentity || !audio.revision || audio.valid === false
      || (audio.signalScope ?? "source") !== "source" || audio.mediaId !== context.source.mediaId
      || !sameMediaSourceIdentity(audio.sourceIdentity, context.source) || !sameAnalyzerDescriptor(audio.provider, context.provider)
      || !sameRevision(audio.revision, record.analysisRevision)
      || !covers(audio.requestedRange, context.range) || !covers(audio.measuredRange, context.range)) throw new Error("ANALYSIS_INVALID: audio coverage is incomplete, inferred or conflicting");
    validateAudioAnalysisPayload(audio);
  }
}

/** Pin the exact serialized index record as derived data; this does not approve a plan. */
export async function pinAnalysisEvidence(index: SemanticMediaIndexStore, artifacts: AnalysisArtifactStore, context: AnalysisEvidenceContext, verifySource: AnalysisSourceVerifier): Promise<AnalysisRef> {
  const bound = structuredClone(context);
  validateContext(bound);
  if (typeof verifySource !== "function") throw new Error("ANALYSIS_UNAVAILABLE: current source verification is required");
  await verifySource(structuredClone(bound.source));
  const loaded = await index.load(structuredClone(bound.source));
  if (!loaded) throw new Error("ANALYSIS_UNAVAILABLE: source analysis is missing");
  const record = structuredClone(loaded);
  validateRecord(record, bound);
  const bytes = Buffer.from(JSON.stringify(record), "utf8");
  const artifactDigest = hash(bytes);
  await artifacts.put(artifactDigest, bytes);
  await verifySource(structuredClone(bound.source));
  return { schemaVersion: 1, ...bound, artifactDigest, analysisRevision: structuredClone(record.analysisRevision) };
}

/** Verify a pinned artifact against independently supplied current source, provider and revision. */
export async function verifyAnalysisEvidence(artifacts: AnalysisArtifactStore, ref: AnalysisRef, current: AnalysisEvidenceContext, verifySource: AnalysisSourceVerifier): Promise<AnalysisEvidenceVerification> {
  try {
    const bound = structuredClone(current);
    const reference = structuredClone(ref);
    validateContext(bound);
    if (typeof verifySource !== "function") return { status: "unavailable", reason: "current source verification is required" };
    await verifySource(structuredClone(bound.source));
    if (!reference || reference.schemaVersion !== 1 || !/^sha256:[a-f0-9]{64}$/.test(reference.artifactDigest)
      || reference.kind !== bound.kind || !sameMediaSourceIdentity(reference.source, bound.source)
      || !sameAnalyzerDescriptor(reference.provider, bound.provider) || !sameRevision(reference.revision, bound.revision)
      || !sameRange(reference.range, bound.range)) return { status: "invalid", reason: "analysis reference no longer matches the current request" };
    const bytes = await artifacts.get(reference.artifactDigest);
    if (!bytes) return { status: "unavailable", reason: "pinned analysis artifact is missing" };
    if (hash(bytes) !== reference.artifactDigest) return { status: "invalid", reason: "analysis artifact digest mismatch" };
    const record = JSON.parse(Buffer.from(bytes).toString("utf8")) as MediaUnderstanding;
    validateRecord(record, bound);
    if (!sameRevision(reference.analysisRevision, record.analysisRevision)) return { status: "invalid", reason: "analysis revision mismatch" };
    await verifySource(structuredClone(bound.source));
    return { status: "verified" };
  } catch (error) {
    return { status: "invalid", reason: error instanceof Error ? error.message : "invalid analysis evidence" };
  }
}

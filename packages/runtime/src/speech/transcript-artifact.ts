import { createHash } from "node:crypto";
import type { AnalysisInput, AnalyzerDescriptor } from "../domain/media.js";
import type { RationalTime } from "../domain/primitives.js";
import { bindSpeechAnalysis } from "./analysis.js";

/** Construct content-addressed transcript evidence; callers remain responsible for source verification and storage. */
export function createSpeechTranscriptArtifact(value: unknown, context: {
  input: AnalysisInput;
  provider: AnalyzerDescriptor;
  producerVersion: string;
}) {
  const sourceDigest = context.input.media.sourceDigest;
  if (!sourceDigest || !/^[a-f0-9]{64}$/.test(sourceDigest)) {
    throw new Error("ANALYSIS_SOURCE_DIGEST_REQUIRED: transcript artifacts require a registered SHA-256 source");
  }
  if (!context.provider.version?.trim()) throw new Error("ANALYSIS_PROVIDER_VERSION_REQUIRED: transcript artifacts require a pinned analyzer version");
  if (!context.producerVersion.trim()) throw new Error("ANALYSIS_PRODUCER_VERSION_REQUIRED: transcript artifacts require a producer version");
  const analysis = bindSpeechAnalysis(value, { input: context.input, provider: context.provider });
  const transcript = analysis.words.map((word) => ({
    text: word.text, startTime: decimalRational(word.start), endTime: decimalRational(word.end),
    confidence: word.confidence, ...(word.filler === undefined ? {} : { filler: word.filler }),
  }));
  const content = {
    schemaVersion: 1 as const, dimension: "speech" as const,
    producer: { id: "framekit" as const, version: context.producerVersion },
    sourceIdentity: analysis.sourceIdentity, analyzer: analysis.provider,
    requestedRange: analysis.requestedRange, observedRange: analysis.observedRange,
    sourceTimebase: analysis.sourceTimebase, transcript,
  };
  return { ...content, digest: createHash("sha256").update(stableJson(content)).digest("hex") };
}

export type SpeechTranscriptArtifact = ReturnType<typeof createSpeechTranscriptArtifact>;

/** Check content addressing before accepting an independently persisted record. */
export function verifySpeechTranscriptArtifact(value: unknown, expectedDigest: string): SpeechTranscriptArtifact {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest) || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ANALYSIS_ARTIFACT_CORRUPT: invalid transcript record");
  }
  const item = value as Record<string, unknown>;
  const { digest, ...content } = item;
  const source = item.sourceIdentity as Record<string, unknown> | undefined;
  const analyzer = item.analyzer as Record<string, unknown> | undefined;
  const producer = item.producer as Record<string, unknown> | undefined;
  const validTime = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const time = value as Record<string, unknown>;
    return typeof time.value === "string" && /^\d+$/.test(time.value)
      && typeof time.timescale === "string" && /^[1-9]\d*$/.test(time.timescale);
  };
  const validRange = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const range = value as Record<string, unknown>;
    return typeof range.start === "number" && Number.isFinite(range.start) && range.start >= 0
      && typeof range.end === "number" && Number.isFinite(range.end) && range.end > range.start;
  };
  if (Object.keys(item).sort().join(",") !== "analyzer,digest,dimension,observedRange,producer,requestedRange,schemaVersion,sourceIdentity,sourceTimebase,transcript"
    || item.schemaVersion !== 1 || item.dimension !== "speech" || digest !== expectedDigest
    || !source || typeof source.mediaId !== "string" || !source.mediaId || typeof source.source !== "string" || !source.source
    || typeof source.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(source.sourceDigest)
    || !analyzer || typeof analyzer.id !== "string" || !analyzer.id || typeof analyzer.provider !== "string" || !analyzer.provider
    || typeof analyzer.version !== "string" || !analyzer.version.trim()
    || !producer || producer.id !== "framekit" || typeof producer.version !== "string" || !producer.version.trim()
    || !validRange(item.requestedRange) || !validRange(item.observedRange) || !validTime(item.sourceTimebase)
    || !Array.isArray(item.transcript) || !item.transcript.every((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const word = entry as Record<string, unknown>;
      return typeof word.text === "string" && Boolean(word.text.trim()) && validTime(word.startTime) && validTime(word.endTime)
        && typeof word.confidence === "number" && Number.isFinite(word.confidence) && word.confidence >= 0 && word.confidence <= 1
        && (word.filler === undefined || typeof word.filler === "boolean");
    }) || createHash("sha256").update(stableJson(content)).digest("hex") !== expectedDigest) {
    throw new Error("ANALYSIS_ARTIFACT_CORRUPT: transcript record does not match its digest");
  }
  return structuredClone(item) as SpeechTranscriptArtifact;
}

/** Preserve the decimal value supplied by a provider; do not infer frame alignment. */
function decimalRational(value: number): RationalTime {
  const [mantissa, exponentText] = value.toString().split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  const exponent = Number(exponentText ?? 0) - fraction.length;
  let numerator = BigInt(`${whole}${fraction}`);
  let denominator = 1n;
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
  else denominator = 10n ** BigInt(-exponent);
  let a = numerator; let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  const divisor = a || 1n;
  return { value: String(numerator / divisor), timescale: String(denominator / divisor) };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

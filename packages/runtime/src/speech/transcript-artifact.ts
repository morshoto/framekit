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

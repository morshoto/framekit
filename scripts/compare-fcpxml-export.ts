import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { FcpxmlDocumentAdapter, verifyFinalCutPublishReadback } from "@framekit/final-cut";
import type { ProjectSnapshot, RationalTime } from "@framekit/runtime";

function canonicalTime(time: RationalTime | undefined): string {
  if (!time) throw new Error("Ambiguous occurrence: exact timing unavailable");
  let numerator = BigInt(time.value);
  let denominator = BigInt(time.timescale);
  if (denominator <= 0n) throw new Error("Ambiguous occurrence: invalid timebase");
  let a = numerator < 0n ? -numerator : numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  const divisor = a || 1n;
  numerator /= divisor;
  denominator /= divisor;
  return `${numerator}/${denominator}`;
}

async function sourceDigests(snapshot: ProjectSnapshot): Promise<{ source: string; sha256: string }[]> {
  const mediaIds = new Set(snapshot.media.map(({ mediaId }) => mediaId));
  if (mediaIds.size !== snapshot.media.length) throw new Error("Ambiguous duplicate media binding");
  const occurrences = new Set<string>();
  for (const clip of snapshot.timeline.clips) {
    if (!clip.mediaId || !mediaIds.has(clip.mediaId)) throw new Error("Unresolved clip media reference");
    const identity = JSON.stringify([clip.mediaId, clip.track, canonicalTime(clip.startTime), canonicalTime(clip.durationTime), canonicalTime(clip.sourceStartTime)]);
    if (occurrences.has(identity)) throw new Error("Ambiguous repeated clip occurrence");
    occurrences.add(identity);
  }
  const digests = await Promise.all(snapshot.media.map(async ({ source }) => {
    if (!source || !source.startsWith("/")) throw new Error("Expected a local original-media source path");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(source)) hash.update(chunk);
    return { source, sha256: hash.digest("hex") };
  }));
  if (new Set(digests.map(({ sha256 }) => sha256)).size !== digests.length) {
    throw new Error("Ambiguous media binding: multiple resources have identical content");
  }
  return digests;
}

async function rejectUnsupportedStructure(path: string): Promise<void> {
  const xml = await readFile(path, "utf8");
  if (XMLValidator.validate(xml) !== true) throw new Error("Unsupported invalid FCPXML document");
  const document = new XMLParser({ preserveOrder: true, ignoreAttributes: false }).parse(xml) as unknown;
  let projects = 0;
  let sequences = 0;
  // Reject unmodeled elements rather than silently comparing partial snapshots.
  // Attribute semantics still require independent review; this is not native proof.
  const supported = new Set(["?xml", "#text", "fcpxml", "resources", "format", "effect", "asset", "media-rep", "library", "event", "project", "sequence", "spine", "asset-clip", "adjust-volume", "metadata", "md", "title", "text", "text-style"]);
  function visit(value: unknown): void {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if ("asset" in node && Array.isArray(node.asset)) {
      const attributes = (node[":@"] ?? {}) as Record<string, unknown>;
      const originals = node.asset.filter((item: unknown) => {
        if (!item || typeof item !== "object") return false;
        const representation = item as Record<string, unknown>;
        const attrs = (representation[":@"] ?? {}) as Record<string, unknown>;
        return "media-rep" in representation && (attrs["@_kind"] === "original-media" || attrs["@_kind"] === undefined);
      });
      if (originals.length + (attributes["@_src"] === undefined ? 0 : 1) > 1) {
        throw new Error("Ambiguous multiple original media representations");
      }
    }
    if ("asset-clip" in node && node[":@"] && typeof node[":@"] === "object") {
      const allowed = new Set(["@_ref", "@_name", "@_offset", "@_start", "@_duration", "@_lane", "@_audioRole"]);
      for (const attribute of Object.keys(node[":@"] as object)) {
        if (!allowed.has(attribute)) throw new Error(`Unsupported asset-clip attribute: ${attribute}`);
      }
    }
    if ("title" in node && node[":@"] && typeof node[":@"] === "object") {
      const allowed = new Set(["@_ref", "@_name", "@_offset", "@_start", "@_duration", "@_lane"]);
      for (const attribute of Object.keys(node[":@"] as object)) {
        if (!allowed.has(attribute)) throw new Error(`Unsupported title attribute: ${attribute}`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== ":@" && !supported.has(key)) throw new Error(`Unsupported FCPXML structure: ${key}`);
      if (key === "project") projects++;
      if (key === "sequence") sequences++;
      if (key !== ":@") visit(child);
    }
  }
  visit(document);
  if (projects !== 1 || sequences !== 1) throw new Error("Unsupported ambiguous project or sequence selection");
}

async function main(): Promise<void> {
  const [expectedPath, actualPath, ...extra] = process.argv.slice(2);
  if (!expectedPath || !actualPath || extra.length) {
    throw new Error("Usage: node --import tsx scripts/compare-fcpxml-export.ts EXPECTED ACTUAL");
  }
  await rejectUnsupportedStructure(expectedPath);
  await rejectUnsupportedStructure(actualPath);
  const options = { allowMissingImmutableIdsForReadback: true };
  const expected = await new FcpxmlDocumentAdapter(expectedPath, undefined, options).readProject();
  const actual = await new FcpxmlDocumentAdapter(actualPath, undefined, options).readProject();
  const evidence = verifyFinalCutPublishReadback(expected, actual, {
    expectedSourceMediaDigests: await sourceDigests(expected),
    actualSourceMediaDigests: await sourceDigests(actual),
  });
  console.log(JSON.stringify({ result: "parsed artifact semantics match", evidence, limitation: "target identity and freshness are not verified; unsupported or omitted XML semantics and live occurrence binding are not established" }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

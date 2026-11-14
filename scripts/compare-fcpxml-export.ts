import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { FcpxmlDocumentAdapter, verifyFinalCutPublishReadback } from "@framekit/final-cut";
import type { ProjectSnapshot } from "@framekit/runtime";

async function sourceDigests(snapshot: ProjectSnapshot): Promise<{ source: string; sha256: string }[]> {
  const mediaIds = new Set(snapshot.media.map(({ mediaId }) => mediaId));
  if (mediaIds.size !== snapshot.media.length) throw new Error("Ambiguous duplicate media binding");
  for (const clip of snapshot.timeline.clips) {
    if (!clip.mediaId || !mediaIds.has(clip.mediaId)) throw new Error("Unresolved clip media reference");
  }
  return Promise.all(snapshot.media.map(async ({ source }) => {
    if (!source || !source.startsWith("/")) throw new Error("Expected a local original-media source path");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(source)) hash.update(chunk);
    return { source, sha256: hash.digest("hex") };
  }));
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
    if ("asset-clip" in node && node[":@"] && typeof node[":@"] === "object") {
      const allowed = new Set(["@_ref", "@_name", "@_offset", "@_start", "@_duration", "@_lane", "@_audioRole"]);
      for (const attribute of Object.keys(node[":@"] as object)) {
        if (!allowed.has(attribute)) throw new Error(`Unsupported asset-clip attribute: ${attribute}`);
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

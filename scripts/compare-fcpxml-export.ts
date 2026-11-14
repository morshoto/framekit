import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { FcpxmlDocumentAdapter, verifyFinalCutPublishReadback } from "@framekit/final-cut";
import type { ProjectSnapshot } from "@framekit/runtime";

async function sourceDigests(snapshot: ProjectSnapshot): Promise<{ source: string; sha256: string }[]> {
  return Promise.all(snapshot.media.map(async ({ source }) => {
    if (!source || !source.startsWith("/")) throw new Error("Expected a local original-media source path");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(source)) hash.update(chunk);
    return { source, sha256: hash.digest("hex") };
  }));
}

async function main(): Promise<void> {
  const [expectedPath, actualPath, ...extra] = process.argv.slice(2);
  if (!expectedPath || !actualPath || extra.length) {
    throw new Error("Usage: node --import tsx scripts/compare-fcpxml-export.ts EXPECTED ACTUAL");
  }
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

import { createHash } from "node:crypto";
import type { ProjectSnapshot } from "./domain/types.js";

/** Digest canonical editor content while deliberately excluding observation revisions and analysis. */
export function canonicalSnapshotDigest(snapshot: ProjectSnapshot): string {
  const canonical = {
    projectId: snapshot.projectId,
    projectName: snapshot.projectName,
    timeline: snapshot.timeline,
    media: snapshot.media.map(({ mediaId, source }) => ({ mediaId, source })),
  };
  return createHash("sha256").update(stableJson(canonical)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => compareText(left, right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

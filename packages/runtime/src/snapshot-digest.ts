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
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

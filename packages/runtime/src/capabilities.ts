import type { RuntimeCapabilities } from "./domain/types.js";

export type CanonicalTimelineMode = "metadata-only" | "canonical-read" | "canonical-write";

export function canonicalTimelineMode(capabilities: RuntimeCapabilities): CanonicalTimelineMode {
  const editor = capabilities.editor;
  if (
    editor.projectRead
    && editor.timelineSnapshotRead
    && editor.timelineWrite
    && editor.readAfterWrite
    && editor.rollback
  ) {
    return "canonical-write";
  }
  if (editor.projectRead && editor.timelineSnapshotRead) return "canonical-read";
  return "metadata-only";
}

export function withCanonicalTimelineMode(capabilities: RuntimeCapabilities): RuntimeCapabilities {
  return {
    ...capabilities,
    editor: {
      ...capabilities.editor,
      canonicalTimelineMode: canonicalTimelineMode(capabilities),
    },
  };
}

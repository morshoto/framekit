import type { RuntimeCapabilities } from "./domain/capabilities.js";

export type CanonicalTimelineMode = "metadata-only" | "canonical-read" | "canonical-write";

export function canonicalTimelineMode(capabilities: RuntimeCapabilities): CanonicalTimelineMode {
  const editor = capabilities.editor;
  const hasExplicitTargeting = Boolean(editor.projectCatalogRead && editor.projectSelection);
  if (
    editor.projectRead
    && editor.timelineSnapshotRead
    && hasExplicitTargeting
    && editor.timelineWrite
    && editor.readAfterWrite
    && editor.rollback
  ) {
    return "canonical-write";
  }
  if (editor.projectRead && editor.timelineSnapshotRead && hasExplicitTargeting) return "canonical-read";
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

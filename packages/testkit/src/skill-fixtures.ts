import type { SkillDefinition } from "@framekit/runtime";

/** Neutral Skill used to conformance-test runtime and adapter boundaries. */
export function createAddMarkerSkill(): SkillDefinition {
  return {
    manifest: {
      contractVersion: 1,
      id: "fixture.add-marker",
      version: "0.0.2",
      title: "Add marker",
      description: "Add one deterministic review marker to the active timeline.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          start: { type: "number", minimum: 0 },
        },
        required: ["name", "start"],
        additionalProperties: false,
      },
      requirements: {
        type: "anyOf",
        requirements: [
          {
            type: "allOf",
            requirements: [
              { type: "editor", capability: "timelineSnapshotRead" },
              { type: "editor", capability: "timelineWrite" },
              { type: "editor", capability: "readAfterWrite" },
              { type: "editor", capability: "rollback" },
              { type: "operation", operation: "add-marker" },
            ],
          },
          {
            type: "allOf",
            requirements: [
              { type: "editor", capability: "timelineSnapshotRead" },
              { type: "editor", capability: "timelineArtifactWrite" },
              { type: "editor", capability: "readAfterWrite" },
              { type: "editor", capability: "rollback" },
              { type: "operation", operation: "add-marker" },
            ],
          },
        ],
      },
      verification: { requireExpectedChange: true },
    },
    handler: {
      normalize: (input) => input as Record<string, unknown>,
      plan: (context, input) => ({
        operations: [{
          type: "add-marker" as const,
          timelineId: context.project.timeline.id,
          marker: {
            id: `fixture-marker-${String(input.start)}`,
            start: input.start as number,
            duration: 0,
            name: input.name as string,
          },
        }],
        affectedRanges: [{ start: input.start as number, end: input.start as number }],
        warnings: [],
      }),
    },
  };
}

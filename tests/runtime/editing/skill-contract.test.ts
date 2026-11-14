import assert from "node:assert/strict";
import test from "node:test";
import {
  SKILL_CONTRACT_VERSION,
  SKILL_LIFECYCLE,
  type SkillDefinition,
} from "@framekit/runtime";

test("the public Skill contract exposes the editor-independent lifecycle", () => {
  const markerSkill: SkillDefinition = {
    manifest: {
      contractVersion: SKILL_CONTRACT_VERSION,
      id: "fixture.add-marker",
      version: "0.0.1",
      title: "Add marker",
      description: "Add one semantic marker to a timeline.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      requirements: { type: "operation", operation: "add-marker" },
    },
    handler: {
      normalize: (input) => (input && typeof input === "object" ? input as Record<string, unknown> : {}),
      plan: () => ({ operations: [], affectedRanges: [], warnings: [] }),
    },
  };

  assert.equal(markerSkill.manifest.contractVersion, 1);
  assert.deepEqual(SKILL_LIFECYCLE, [
    "discover", "resolve", "plan", "preview", "execute", "verify", "accept", "rollback",
  ]);
  assert.equal(markerSkill.manifest.requirements.type, "operation");
});

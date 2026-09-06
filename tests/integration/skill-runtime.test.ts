import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentVideoRuntime,
  type SkillDefinition,
  type VerificationEngine,
} from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

function createSkillRuntime(options: ConstructorParameters<typeof AgentVideoRuntime>[1] = {}) {
  const adapter = new InMemoryEditorAdapter({
    projectId: "skill-runtime-project",
    projectName: "Skill Runtime",
    timelineId: "skill-runtime-timeline",
    timelineName: "Main Edit",
    clips: [],
  });
  return { adapter, runtime: new AgentVideoRuntime(adapter, options) };
}

function markerSkill(planCalls: { value: number } = { value: 0 }): SkillDefinition {
  return {
    manifest: {
      contractVersion: 1,
      id: "fixture.add-marker",
      version: "1.0.0",
      title: "Add marker",
      description: "Add a deterministic marker.",
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
        type: "allOf",
        requirements: [
          { type: "editor", capability: "timelineSnapshotRead" },
          { type: "editor", capability: "timelineWrite" },
          { type: "editor", capability: "rollback" },
          { type: "operation", operation: "add-marker" },
        ],
      },
    },
    handler: {
      normalize: (input) => input as Record<string, unknown>,
      plan: (context, input) => {
        planCalls.value += 1;
        assert.equal("adapter" in context, false);
        return {
          operations: [{
            type: "add-marker" as const,
            timelineId: context.project.timeline.id,
            marker: {
              id: `marker-${String(input.start)}`,
              start: input.start as number,
              duration: 0,
              name: input.name as string,
            },
            baseRevision: context.baseRevision,
          }],
          affectedRanges: [{ start: input.start as number, end: input.start as number }],
          warnings: [],
        };
      },
    },
  };
}

test("registry rejects duplicates and resolves deterministic version ordering", () => {
  const { runtime } = createSkillRuntime();
  const v1 = markerSkill();
  const v2 = { ...v1, manifest: { ...v1.manifest } };
  v2.manifest.version = "2.0.0";
  runtime.registerSkill(v2);
  runtime.registerSkill(v1);

  assert.deepEqual(runtime.listSkills().map((skill) => `${skill.id}@${skill.version}`), [
    "fixture.add-marker@1.0.0",
    "fixture.add-marker@2.0.0",
  ]);
  assert.equal(runtime.inspectSkill("fixture.add-marker").version, "2.0.0");
  assert.throws(() => runtime.registerSkill(v1), /SKILL_DUPLICATE/);
  assert.throws(() => runtime.inspectSkill("missing"), /SKILL_NOT_FOUND/);
  assert.throws(() => runtime.inspectSkill("fixture.add-marker", "9.0.0"), /SKILL_VERSION_NOT_FOUND/);
});

test("preview is isolated and execute uses the transaction boundary", async () => {
  const { runtime } = createSkillRuntime();
  runtime.registerSkill(markerSkill());
  const before = await runtime.inspectProject();
  const preview = await runtime.previewSkill({
    skillId: "fixture.add-marker",
    baseRevision: before.revision,
    input: { name: "Review", start: 2 },
  });

  assert.match(preview.previewToken, /^skill-preview-/);
  assert.equal(preview.plan.skillVersion, "1.0.0");
  assert.equal(preview.plan.operations[0]?.type, "add-marker");
  assert.deepEqual(await runtime.inspectProject(), before);

  const execution = await runtime.executeSkill(preview.previewToken);
  assert.equal(execution.status, "VERIFIED");
  assert.equal(execution.rollback.attempted, false);
  assert.equal(execution.transactionIds.length, 1);
  const after = await runtime.inspectProject();
  assert.equal(after.timeline.markers[0]?.name, "Review");
});

test("input validation and requirement resolution happen before the handler", async () => {
  const { runtime } = createSkillRuntime();
  const calls = { value: 0 };
  runtime.registerSkill(markerSkill(calls));
  const before = await runtime.inspectProject();

  await assert.rejects(runtime.previewSkill({
    skillId: "fixture.add-marker",
    baseRevision: before.revision,
    input: { name: "", start: 0 },
  }), /SKILL_INPUT_INVALID/);
  assert.equal(calls.value, 0);

  const unavailable = markerSkill(calls);
  unavailable.manifest.id = "fixture.unavailable";
  unavailable.manifest.requirements = { type: "analyzer", capability: "speechTranscribe" };
  runtime.registerSkill(unavailable);
  await assert.rejects(runtime.previewSkill({
    skillId: unavailable.manifest.id,
    baseRevision: before.revision,
    input: { name: "Review", start: 0 },
  }), /SKILL_REQUIREMENTS_UNMET/);
  assert.equal(calls.value, 0);
});

test("expired, reused, unknown, and stale preview tokens are rejected", async () => {
  let now = 1_000;
  const { runtime } = createSkillRuntime({ now: () => now, previewTtlMs: 10 });
  runtime.registerSkill(markerSkill());
  const before = await runtime.inspectProject();
  const expired = await runtime.previewSkill({ skillId: "fixture.add-marker", baseRevision: before.revision, input: { name: "Expired", start: 0 } });
  now = 1_011;
  await assert.rejects(runtime.executeSkill(expired.previewToken), /SKILL_PREVIEW_TOKEN_EXPIRED/);
  await assert.rejects(runtime.executeSkill(expired.previewToken), /SKILL_PREVIEW_TOKEN_INVALID/);
  await assert.rejects(runtime.executeSkill("skill-preview-unknown"), /SKILL_PREVIEW_TOKEN_INVALID/);

  now = 2_000;
  const stale = await runtime.previewSkill({ skillId: "fixture.add-marker", baseRevision: before.revision, input: { name: "Stale", start: 1 } });
  await runtime.edit({ type: "add-marker", timelineId: before.timeline.id, marker: { id: "external", start: 0, duration: 0, name: "External" } });
  await assert.rejects(runtime.executeSkill(stale.previewToken), /STALE_CONTEXT/);
});

test("verification failure reports a complete rollback result", async () => {
  const verificationEngine: VerificationEngine = {
    verify: async () => ({
      passed: false,
      checks: [{ name: "fixture", passed: false, status: "failed", detail: "forced failure" }],
    }),
  };
  const { runtime } = createSkillRuntime({ verificationEngine });
  runtime.registerSkill(markerSkill());
  const before = await runtime.inspectProject();
  const preview = await runtime.previewSkill({ skillId: "fixture.add-marker", baseRevision: before.revision, input: { name: "Rollback", start: 3 } });

  const execution = await runtime.executeSkill(preview.previewToken);
  assert.equal(execution.status, "ROLLED_BACK");
  assert.equal(execution.rollback.attempted, true);
  assert.equal(execution.rollback.succeeded, true);
  assert.deepEqual((await runtime.inspectProject()).timeline.markers, before.timeline.markers);
});

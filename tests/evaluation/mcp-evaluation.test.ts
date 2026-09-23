import assert from "node:assert/strict";
import test from "node:test";
import { renderEvaluationReport, runMcpEvaluation } from "./suite.js";

test("deterministic MCP evaluation covers editing workflows and reports actionable metrics", async () => {
  const report = await runMcpEvaluation();

  assert.equal(report.correctness.failed, 0);
  assert.equal(report.correctness.rate, 1);
  assert.equal(report.capability.supported, 15);
  assert.equal(report.capability.unavailable, 3);
  assert.equal(report.capability.coverageRate, 15 / 18);
  assert.equal(report.scenarioConsistency.rate, 1);
  assert.deepEqual(Object.keys(report.byCategory).sort(), [
    "editing",
    "failure-path",
    "media",
    "mvp-workflow",
    "project",
    "publishing",
    "workflow-assets",
  ]);
  assert.ok(report.byCategory.editing.total >= 4);
  assert.ok(report.byCategory["failure-path"].total >= 2);
  assert.equal(report.byCategory["workflow-assets"].supported, 3);
  assert.equal(report.byCategory["workflow-assets"].unavailable, 2);
  assert.equal(report.byCategory["mvp-workflow"].correctnessRate, 1);
  assert.ok(report.scenarios.some((scenario) => scenario.id === "artifact-publish-capability"
    && scenario.intent === "Publish the verified FCPXML artifact as a new project"));
  const mvpWorkflow = report.scenarios.find((scenario) => scenario.id === "basic-editing-mvp-workflow") as
    | (typeof report.scenarios[number] & { tools?: string[]; operations?: string[] })
    | undefined;
  assert.ok(mvpWorkflow?.passed);
  assert.deepEqual(mvpWorkflow.tools, [
    "connection.status",
    "editor.inspect",
    "project.inspect",
    "context.inspect",
    "editor.assets",
    "editor.timeline.edit.preview",
    "editor.timeline.edit.execute",
    "media.inspect",
    "edit.diff",
    "edit.verify",
    "timeline.export",
    "edit.undo",
  ]);
  assert.deepEqual(mvpWorkflow.operations, [
    "media.import",
    "timeline.media.add",
    "trim-clip",
    "media.import",
    "timeline.media.add",
    "timeline.title.add",
  ]);
  assert.ok(report.scenarios.some((scenario) => scenario.id === "undo-verified" && scenario.passed && scenario.support === "supported"));

  const rendered = renderEvaluationReport(report);
  assert.match(rendered, /MCP evaluation/);
  assert.match(rendered, /correctness_rate=100\.0%/);
  assert.match(rendered, /capability_coverage=83\.3%/);
  assert.match(rendered, /scenario_consistency_rate=100\.0%/);
});

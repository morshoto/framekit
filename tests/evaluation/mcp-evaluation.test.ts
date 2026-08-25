import assert from "node:assert/strict";
import test from "node:test";
import { renderEvaluationReport, runMcpEvaluation } from "./suite.js";

test("deterministic MCP evaluation covers editing workflows and reports actionable metrics", async () => {
  const report = await runMcpEvaluation();

  assert.equal(report.correctness.failed, 0);
  assert.equal(report.correctness.rate, 1);
  assert.equal(report.capability.supported, 14);
  assert.equal(report.capability.unavailable, 4);
  assert.equal(report.capability.coverageRate, 14 / 18);
  assert.equal(report.scenarioConsistency.rate, 1);
  assert.deepEqual(Object.keys(report.byCategory).sort(), [
    "editing",
    "failure-path",
    "media",
    "project",
    "publishing",
    "workflow-assets",
  ]);
  assert.ok(report.byCategory.editing.total >= 4);
  assert.ok(report.byCategory["failure-path"].total >= 2);
  assert.equal(report.byCategory["workflow-assets"].supported, 3);
  assert.equal(report.byCategory["workflow-assets"].unavailable, 2);
  assert.ok(report.scenarios.some((scenario) => scenario.id === "undo-verified" && scenario.passed && scenario.support === "supported"));

  const rendered = renderEvaluationReport(report);
  assert.match(rendered, /MCP evaluation/);
  assert.match(rendered, /correctness_rate=100\.0%/);
  assert.match(rendered, /capability_coverage=77\.8%/);
  assert.match(rendered, /scenario_consistency_rate=100\.0%/);
});

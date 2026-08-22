import assert from "node:assert/strict";
import test from "node:test";
import { renderEvaluationReport, runMcpEvaluation } from "./suite.js";

test("deterministic MCP evaluation covers editing workflows and reports actionable metrics", async () => {
  const report = await runMcpEvaluation();

  assert.equal(report.failed, 0);
  assert.equal(report.passRate, 1);
  assert.equal(report.intentMapping.accuracy, 1);
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
  assert.ok(report.scenarios.some((scenario) => scenario.id === "undo-verified" && scenario.passed));

  const rendered = renderEvaluationReport(report);
  assert.match(rendered, /MCP evaluation/);
  assert.match(rendered, /pass_rate=100\.0%/);
  assert.match(rendered, /intent_mapping_accuracy=100\.0%/);
});

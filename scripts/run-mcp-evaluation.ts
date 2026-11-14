import { renderEvaluationReport, runMcpEvaluation } from "./evaluation/suite.js";

const report = await runMcpEvaluation();
console.log(renderEvaluationReport(report));
if (report.failed > 0) process.exitCode = 1;

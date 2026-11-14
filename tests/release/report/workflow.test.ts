import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("release workflow runs the report only for milestone releases", async () => {
  const workflow = await readFile(".github/workflows/release.yml", "utf8");
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.scripts?.["release-report"], "tsx scripts/generate-release-report.ts");
  assert.match(packageJson.scripts?.["test:coverage"] ?? "", /c8 .*json-summary/);
  assert.match(workflow, /milestone-release: \$\{\{ steps\.classify\.outputs\.milestone \}\}/);
  assert.match(workflow, /name: Classify milestone release/);
  assert.match(workflow, /v\[0-9\].*\[0-9\].*\.0/);
  assert.match(workflow, /milestone-report:/);
  assert.match(workflow, /if: needs\.tagpr\.outputs\.milestone-release == 'true'/);
  assert.match(workflow, /pnpm run test:coverage/);
  assert.match(workflow, /git worktree add --detach/);
  assert.match(workflow, /pnpm run release-report/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /report\.json/);
  assert.match(workflow, /report\.md/);
  assert.match(workflow, /coverage\.svg/);
  assert.match(workflow, /roadmap-progress\.svg/);
  assert.match(workflow, /contributors\.svg/);
  assert.match(workflow, /name: Skip milestone report for patch release/);

  const baselineSelectionStart = workflow.indexOf("mapfile -t milestone_tags");
  const baselineSelectionEnd = workflow.indexOf("current_coverage", baselineSelectionStart);
  const baselineSelection = workflow.slice(baselineSelectionStart, baselineSelectionEnd);
  assert.match(baselineSelection, /--sort=v:refname/);
  assert.match(
    baselineSelection,
    /if \[ "\$\{candidate\}" = "\$\{RELEASE_TAG\}" \]; then\n\s+break/,
  );
  assert.match(baselineSelection, /break[\s\S]*baseline_tag="\$\{candidate\}"/);
  assert.doesNotMatch(baselineSelection, /candidate\}" != "\$\{RELEASE_TAG\}/);

  const publishJob = workflow.slice(workflow.indexOf("publish-npm:"));
  assert.match(publishJob, /- milestone-report/);
});

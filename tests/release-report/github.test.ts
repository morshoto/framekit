import assert from "node:assert/strict";
import test from "node:test";
import { flattenGitHubPages, parseGitHubRepository } from "../../scripts/release-report/github.js";

test("GitHub repository parsing supports SSH and HTTPS remotes", () => {
  assert.equal(parseGitHubRepository("git@github.com:morshoto/framekit.git"), "morshoto/framekit");
  assert.equal(parseGitHubRepository("https://github.com/morshoto/framekit"), "morshoto/framekit");
  assert.throws(() => parseGitHubRepository("https://example.com/other/repo"), /GitHub repository/i);
});

test("GitHub pagination normalization flattens slurped pages", () => {
  assert.deepEqual(flattenGitHubPages([[{ id: 1 }], [{ id: 2 }, { id: 3 }]]), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(flattenGitHubPages([{ id: 4 }]), [{ id: 4 }]);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { assessBuildAlignment } from "../../apps/mcp-server/src/build-alignment.js";

const repository = resolve(import.meta.dirname, "../..");

const runtime = { version: "0.1.11", commit: "runtime-commit" };

test("local validation accepts matching runtime and extension fingerprints", () => {
  const alignment = assessBuildAlignment(runtime, runtime);

  assert.equal(alignment.status, "matched");
  assert.equal(alignment.message, "runtime and extension fingerprints match");
});

test("local validation reports a missing extension fingerprint", () => {
  const alignment = assessBuildAlignment(runtime, undefined);

  assert.equal(alignment.status, "missing");
  assert.match(alignment.message, /extension fingerprint is unavailable/);
});

test("local validation reports a stale extension fingerprint", () => {
  const alignment = assessBuildAlignment(runtime, { ...runtime, commit: "stale-commit" });

  assert.equal(alignment.status, "mismatched");
  assert.match(alignment.message, /extension commit stale-commit does not match runtime commit runtime-commit/);
});

test("local validation compares both sides with an explicit checkout target", () => {
  const alignment = assessBuildAlignment(runtime, runtime, "intended-commit");

  assert.equal(alignment.status, "mismatched");
  assert.match(alignment.message, /runtime commit runtime-commit does not match target commit intended-commit/);
});

test("development extension embeds and reports the checkout fingerprint", async () => {
  const buildScript = await readFile(
    resolve(repository, "adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/build.sh"),
    "utf8",
  );
  const project = await readFile(
    resolve(repository, "adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/project.yml"),
    "utf8",
  );
  const infoPlist = await readFile(
    resolve(repository, "adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/Info.plist"),
    "utf8",
  );
  const extensionSource = await readFile(
    resolve(repository, "adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FinalCutLiveWorkflowExtension.swift"),
    "utf8",
  );

  assert.match(buildScript, /FRAMEKIT_BUILD_COMMIT/);
  assert.match(project, /FRAMEKIT_BUILD_VERSION/);
  assert.match(infoPlist, /FramekitBuildCommit/);
  assert.match(extensionSource, /struct BuildFingerprint: Codable/);
  assert.match(extensionSource, /buildFingerprint: extensionBuildFingerprint\(\)/);
});

test("the local MCP launcher provisions development mode and requires alignment", async () => {
  const cli = await readFile(resolve(repository, "apps/cli/src/main.ts"), "utf8");

  assert.match(cli, /mcp --editor final-cut-live \[--headless\] \[--development\]/);
  assert.match(cli, /connectFinalCut\(\["finalcut", "--development", "--json"\]\)/);
  assert.match(cli, /FRAMEKIT_REQUIRE_BUILD_ALIGNMENT: development \? "1"/);
});

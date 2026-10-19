import assert from "node:assert/strict";
import test from "node:test";
import {
	assessReleaseCandidate,
	type ReleaseCandidateInput,
} from "../../scripts/release-candidate-evidence.mjs";

const target = {
	version: "0.1.18",
	commit: "1234567890abcdef1234567890abcdef12345678",
};

function evidence(overrides: Partial<ReleaseCandidateInput["artifacts"]> = {}): ReleaseCandidateInput {
	const pluginDigest = "a".repeat(64);
	return {
		target,
		artifacts: {
			npmPackage: { available: true, version: target.version, commit: target.commit },
			codexPlugin: {
				installed: true,
				version: target.version,
				commit: target.commit,
				sourceCommit: target.commit,
				identitySource: "installed-content-equals-clean-source",
				contentDigest: pluginDigest,
				sourceContentDigest: pluginDigest,
			},
			mcpServer: { connected: true, version: target.version, commit: target.commit },
			nativeExtension: {
				verified: true,
				version: target.version,
				commit: target.commit,
				signed: true,
				checksumVerified: true,
			},
			...overrides,
		},
	};
}

test("release candidate is GO only when all installable artifacts match the tagged commit", () => {
	const report = assessReleaseCandidate(evidence());

	assert.equal(report.status, "GO");
	assert.deepEqual(
		Object.values(report.artifacts).map((artifact) => artifact.status),
		["GO", "GO", "GO", "GO"],
	);
	assert.equal(report.artifacts.codexPlugin.contentDigest, "a".repeat(64));
	assert.equal(report.artifacts.codexPlugin.sourceContentDigest, "a".repeat(64));
});

test("matching plugin commit cannot pass when installed content differs from the source", () => {
	const report = assessReleaseCandidate(evidence({
		codexPlugin: {
			installed: true,
			version: target.version,
			commit: target.commit,
			sourceCommit: target.commit,
			identitySource: "installed-content-equals-clean-source",
			contentDigest: "b".repeat(64),
			sourceContentDigest: "a".repeat(64),
		},
	}));

	assert.equal(report.status, "NO_GO");
	assert.equal(report.artifacts.codexPlugin.status, "NO_GO");
	assert.match(report.artifacts.codexPlugin.reason ?? "", /not available/);
});

test("unpublished native assets produce a machine-readable NO_GO blocker", () => {
	const report = assessReleaseCandidate(evidence({
		nativeExtension: { verified: false, reason: "signed release assets are unavailable" },
	}));

	assert.equal(report.status, "NO_GO");
	assert.equal(report.artifacts.nativeExtension.status, "NO_GO");
	assert.match(report.artifacts.nativeExtension.reason ?? "", /signed release assets are unavailable/);
});

test("commit mismatch is reported as NO_GO for the affected artifact", () => {
	const report = assessReleaseCandidate(evidence({
		mcpServer: { connected: true, version: target.version, commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
	}));

	assert.equal(report.status, "NO_GO");
	assert.equal(report.artifacts.mcpServer.status, "NO_GO");
	assert.match(report.artifacts.mcpServer.reason ?? "", /commit/);
});

test("dirty source checkouts cannot produce a GO release candidate", () => {
	const input = evidence();
	input.target = { ...target, sourceClean: false };

	const report = assessReleaseCandidate(input);

	assert.equal(report.status, "NO_GO");
	assert.equal(report.target.sourceClean, false);
	assert.ok(Object.values(report.artifacts).every((artifact) => artifact.status === "NO_GO"));
	assert.ok(Object.values(report.artifacts).every((artifact) => /uncommitted changes/.test(artifact.reason ?? "")));
});

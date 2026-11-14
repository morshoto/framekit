import assert from "node:assert/strict";
import test from "node:test";
import {
	createPackageBuildIdentity,
	parsePackageBuildIdentity,
} from "../../apps/mcp-server/src/build-identity.js";

const commit = "1234567890abcdef1234567890abcdef12345678";

test("package build identity carries the package version and exact source commit", () => {
	const identity = createPackageBuildIdentity("0.1.18", commit);

	assert.deepEqual(identity, {
		schemaVersion: 1,
		version: "0.1.18",
		commit,
	});
	assert.deepEqual(parsePackageBuildIdentity(identity, "0.1.18"), identity);
});

test("package build identity rejects a different package version", () => {
	assert.throws(
		() => parsePackageBuildIdentity({ schemaVersion: 1, version: "0.1.17", commit }, "0.1.18"),
		/FRAMEKIT_PACKAGE_BUILD_IDENTITY_VERSION_MISMATCH/,
	);
});

test("package build identity rejects a missing or malformed commit", () => {
	assert.throws(
		() => parsePackageBuildIdentity({ schemaVersion: 1, version: "0.1.18", commit: "unknown" }, "0.1.18"),
		/FRAMEKIT_PACKAGE_BUILD_IDENTITY_INVALID/,
	);
});

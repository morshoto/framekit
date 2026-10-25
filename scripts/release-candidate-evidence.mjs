import { isInstalledCodexPluginBoundToCandidate } from "./codex-plugin-identity.mjs";

export function assessReleaseCandidate(input) {
	assertTarget(input?.target);
	const sourceClean = input.target.sourceClean !== false;
	const artifacts = {
		npmPackage: assessIdentity("npm package", input.target, input.artifacts?.npmPackage, input.artifacts?.npmPackage?.available, sourceClean),
		codexPlugin: assessCodexPlugin(input.target, input.artifacts?.codexPlugin, sourceClean),
		mcpServer: assessIdentity("MCP server", input.target, input.artifacts?.mcpServer, input.artifacts?.mcpServer?.connected, sourceClean),
		nativeExtension: assessNativeExtension(input.target, input.artifacts?.nativeExtension, sourceClean),
	};
	return {
		schemaVersion: 1,
		evidenceType: "framekit-release-candidate",
		target: { ...input.target, commit: input.target.commit.toLowerCase(), sourceClean },
		status: Object.values(artifacts).every((artifact) => artifact.status === "GO") ? "GO" : "NO_GO",
		artifacts,
	};
}

function assessCodexPlugin(target, identity = {}, sourceClean) {
	const contentBound = isInstalledCodexPluginBoundToCandidate(
		identity,
		identity.sourceContentDigest,
		target.commit,
	);
	const artifact = assessIdentity(
		"Codex plugin",
		target,
		identity,
		identity.installed === true && contentBound,
		sourceClean,
	);
	return {
		...artifact,
		...(isPluginIdentitySource(identity.identitySource) ? { identitySource: identity.identitySource } : {}),
		...(isDigest(identity.contentDigest) ? { contentDigest: identity.contentDigest.toLowerCase() } : {}),
		...(isDigest(identity.sourceContentDigest) ? { sourceContentDigest: identity.sourceContentDigest.toLowerCase() } : {}),
		...(isCommit(identity.sourceCommit) ? { sourceCommit: identity.sourceCommit.toLowerCase() } : {}),
	};
}

function assessIdentity(name, target, identity = {}, available, sourceClean) {
	if (!sourceClean) return noGo(identity, "release source checkout contains uncommitted changes");
	if (available !== true) return noGo(identity, identity.reason ?? `${name} is not available for this release candidate`);
	if (identity.version !== target.version) {
		return noGo(identity, identity.reason ?? `${name} version does not match target ${target.version}`);
	}
	if (!identity.commit || identity.commit.toLowerCase() !== target.commit.toLowerCase()) {
		return noGo(identity, identity.reason ?? `${name} commit does not match target ${target.commit}`);
	}
	return {
		status: "GO",
		version: identity.version,
		commit: identity.commit.toLowerCase(),
	};
}

function assessNativeExtension(target, identity = {}, sourceClean) {
	if (!sourceClean) return noGo(identity, "release source checkout contains uncommitted changes");
	if (identity.verified !== true) {
		return noGo(identity, identity.reason ?? "signed native release assets are not verified");
	}
	const aligned = assessIdentity("Workflow Extension", target, identity, true, sourceClean);
	if (aligned.status !== "GO") return aligned;
	if (identity.signed !== true) return noGo(identity, "Workflow Extension signature is not verified");
	if (identity.checksumVerified !== true) return noGo(identity, "Workflow Extension checksum is not verified");
	return aligned;
}

function noGo(identity, reason) {
	return {
		status: "NO_GO",
		...(identity.version ? { version: identity.version } : {}),
		...(identity.commit ? { commit: identity.commit } : {}),
		reason,
	};
}

function isPluginIdentitySource(value) {
	return [
		"installed-content-equals-clean-source",
		"installed-content-equals-dirty-source",
		"installed-content-differs-from-source",
	].includes(value);
}

function isDigest(value) {
	return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function isCommit(value) {
	return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function assertTarget(target) {
	if (
		!target
		|| !/^\d+\.\d+\.\d+$/.test(target.version ?? "")
		|| !/^[0-9a-f]{40}$/i.test(target.commit ?? "")
		|| (target.sourceClean !== undefined && typeof target.sourceClean !== "boolean")
	) {
		throw new Error("RELEASE_CANDIDATE_TARGET_INVALID: expected a semver version and full commit SHA");
	}
}

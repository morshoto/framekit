export interface PackageBuildIdentity {
	schemaVersion: 1;
	version: string;
	commit: string;
}

const fullCommitPattern = /^[0-9a-f]{40}$/i;

export function createPackageBuildIdentity(version: string, commit: string): PackageBuildIdentity {
	if (!version.trim() || !fullCommitPattern.test(commit)) {
		throw new Error("FRAMEKIT_PACKAGE_BUILD_IDENTITY_INVALID: version and full commit are required");
	}
	return { schemaVersion: 1, version, commit: commit.toLowerCase() };
}

export function parsePackageBuildIdentity(
	value: unknown,
	expectedVersion: string,
): PackageBuildIdentity | undefined {
	if (value === undefined || value === null) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("FRAMEKIT_PACKAGE_BUILD_IDENTITY_INVALID: expected an object");
	}
	const identity = value as Partial<PackageBuildIdentity>;
	const commit = identity.commit;
	if (
		identity.schemaVersion !== 1
		|| typeof identity.version !== "string"
		|| typeof commit !== "string"
		|| !fullCommitPattern.test(commit)
	) {
		throw new Error("FRAMEKIT_PACKAGE_BUILD_IDENTITY_INVALID: schema or commit is invalid");
	}
	if (identity.version !== expectedVersion) {
		throw new Error("FRAMEKIT_PACKAGE_BUILD_IDENTITY_VERSION_MISMATCH");
	}
	return {
		schemaVersion: 1,
		version: identity.version,
		commit: commit.toLowerCase(),
	};
}

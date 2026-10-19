export interface ReleaseCandidateTarget {
	version: string;
	commit: string;
	sourceClean?: boolean;
}

interface ArtifactIdentity {
	version?: string;
	commit?: string;
	reason?: string;
}

interface CodexPluginIdentity extends ArtifactIdentity {
	identitySource?:
		| "installed-content-equals-clean-source"
		| "installed-content-equals-dirty-source"
		| "installed-content-differs-from-source";
	contentDigest?: string;
	sourceContentDigest?: string;
	sourceCommit?: string;
}

export interface ReleaseCandidateInput {
	target: ReleaseCandidateTarget;
	artifacts: {
		npmPackage: ArtifactIdentity & { available: boolean };
		codexPlugin: CodexPluginIdentity & { installed: boolean };
		mcpServer: ArtifactIdentity & { connected: boolean };
		nativeExtension: ArtifactIdentity & {
			verified: boolean;
			signed?: boolean;
			checksumVerified?: boolean;
		};
	};
}

export interface ReleaseCandidateArtifactStatus {
	status: "GO" | "NO_GO";
	version?: string;
	commit?: string;
	reason?: string;
	identitySource?: CodexPluginIdentity["identitySource"];
	contentDigest?: string;
	sourceContentDigest?: string;
	sourceCommit?: string;
}

export interface ReleaseCandidateReport {
	schemaVersion: 1;
	evidenceType: "framekit-release-candidate";
	target: ReleaseCandidateTarget;
	status: "GO" | "NO_GO";
	artifacts: {
		npmPackage: ReleaseCandidateArtifactStatus;
		codexPlugin: ReleaseCandidateArtifactStatus;
		mcpServer: ReleaseCandidateArtifactStatus;
		nativeExtension: ReleaseCandidateArtifactStatus;
	};
}

export function assessReleaseCandidate(input: ReleaseCandidateInput): ReleaseCandidateReport;

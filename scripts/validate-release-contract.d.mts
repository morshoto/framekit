export interface ReleasePackageManifest {
  version?: unknown;
  private?: unknown;
  repository?: { type?: unknown; url?: unknown };
  publishConfig?: { access?: unknown };
  [key: string]: unknown;
}

export interface ReleaseContractInput {
  packageManifest: ReleasePackageManifest;
  releaseTag?: string;
  githubRepository?: string;
  packageBuildIdentity?: { schemaVersion?: unknown; version?: unknown; commit?: unknown };
  candidateCommit?: string;
  sourceClean?: boolean;
}

export function validateReleaseContract(input: ReleaseContractInput): void;

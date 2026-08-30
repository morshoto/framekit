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
}

export function validateReleaseContract(input: ReleaseContractInput): void;

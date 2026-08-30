export interface ReleasePackageManifest {
  version?: unknown;
  [key: string]: unknown;
}

export interface ReleaseContractInput {
  packageManifest: ReleasePackageManifest;
  releaseTag?: string;
}

export function validateReleaseContract(input: ReleaseContractInput): void;

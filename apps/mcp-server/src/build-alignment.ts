import type { FramekitBuildFingerprint } from "./version.js";

export type BuildAlignmentStatus = "matched" | "missing" | "mismatched";

export interface BuildAlignmentReport {
  status: BuildAlignmentStatus;
  target: FramekitBuildFingerprint;
  runtime: FramekitBuildFingerprint;
  extension?: FramekitBuildFingerprint;
  message: string;
}

export function assessBuildAlignment(
  runtime: FramekitBuildFingerprint,
  extension: FramekitBuildFingerprint | undefined,
  targetCommit = runtime.commit,
): BuildAlignmentReport {
  const target = { version: runtime.version, commit: targetCommit };
  const unavailableCommit = [
    ["runtime", runtime.commit],
    ["target", target.commit],
    ...(extension ? [["extension", extension.commit] as const] : []),
  ].find(([, commit]) => !commit.trim() || commit.trim().toLowerCase() === "unknown");
  if (unavailableCommit) {
    return {
      status: "missing",
      target,
      runtime,
      ...(extension ? { extension } : {}),
      message: `${unavailableCommit[0]} commit identity is unavailable`,
    };
  }
  if (runtime.commit !== target.commit) {
    return {
      status: "mismatched",
      target,
      runtime,
      ...(extension ? { extension } : {}),
      message: `runtime commit ${runtime.commit} does not match target commit ${target.commit}`,
    };
  }
  if (!extension) {
    return {
      status: "missing",
      target,
      runtime,
      message: "extension fingerprint is unavailable",
    };
  }
  if (extension.version !== runtime.version) {
    return {
      status: "mismatched",
      target,
      runtime,
      extension,
      message: `extension version ${extension.version} does not match runtime version ${runtime.version}`,
    };
  }
  if (extension.commit !== runtime.commit) {
    return {
      status: "mismatched",
      target,
      runtime,
      extension,
      message: `extension commit ${extension.commit} does not match runtime commit ${runtime.commit}`,
    };
  }
  return {
    status: "matched",
    target,
    runtime,
    extension,
    message: "runtime and extension fingerprints match",
  };
}

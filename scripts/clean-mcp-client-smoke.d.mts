export function selectPackageSource(
  packageStatus: { available: boolean },
  requested?: string,
): "packed-source" | "published-package";

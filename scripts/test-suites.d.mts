export interface TestSuiteManifestEntry {
  path: string;
  owner: string;
  tags: string[];
  requires: string[];
}

export interface TestSuiteManifest {
  schemaVersion: 1;
  tests: TestSuiteManifestEntry[];
}

export interface TestInventoryDifference {
  missing: string[];
  unregistered: string[];
}

export const TEST_SUITE_DEFINITIONS: Readonly<Record<string, {
  tags: string[];
  executables: string[];
}>>;

export function discoverTestFiles(rootDir?: string): Promise<string[]>;
export function loadTestSuiteManifest(rootDir?: string): Promise<TestSuiteManifest>;
export function compareTestInventory(expectedFiles: string[], discoveredFiles: string[]): TestInventoryDifference;
export function selectTestFiles(manifest: TestSuiteManifest, suiteName: string): string[];
export function evaluateSuitePrerequisites(
  suiteName: string,
  options?: {
    platform?: string;
    nodeVersion?: string;
    availableExecutables?: Set<string>;
    manifest?: TestSuiteManifest;
  },
): { ready: boolean; missing: string[] };
export function updateTestSuiteManifest(rootDir?: string): Promise<TestSuiteManifest>;

export interface BoundaryPackageDefinition {
  id: string;
  name: string | null;
  root: string;
  manifest: string;
  sourceRoot?: string;
}

export interface BoundaryException {
  kind: string;
  source?: string;
  specifier?: string;
  target?: string;
  members?: string[];
  reason: string;
}

export interface BoundaryPolicy {
  allowedDependencies: Record<string, string[]>;
  allowedExternalDependencies: Record<string, string[]>;
  productionEntrypoints: string[];
  experimentalModules: string[];
  exceptions: BoundaryException[];
}

export interface BoundaryViolation {
  code: string;
  source: string;
  message: string;
}

export interface BoundaryEdge {
  source: string;
  target: string;
  specifier: string;
  from: string;
  to: string;
  kind: string;
}

export function analyzeWorkspaceBoundaries(options: {
  rootDir: string;
  packages: BoundaryPackageDefinition[];
  policy: BoundaryPolicy;
}): Promise<{ violations: BoundaryViolation[]; edges: BoundaryEdge[] }>;

export const FRAMEKIT_PACKAGES: BoundaryPackageDefinition[];
export const FRAMEKIT_BOUNDARY_POLICY: BoundaryPolicy;

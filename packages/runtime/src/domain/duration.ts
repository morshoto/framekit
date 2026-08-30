export type DurationConstraint = "hard" | "soft";

export type DurationPolicyAction =
  | "deliver-exact-duration"
  | "deliver-shorter-strong-edit"
  | "reuse-selected-b-roll"
  | "request-additional-footage";

export type DurationAlternativeKind =
  | "deliver-shorter-strong-edit"
  | "reuse-selected-b-roll"
  | "slow-motion"
  | "request-additional-footage"
  | "generated-interstitial";

export type DurationAlternativeStatus =
  | "recommended"
  | "available"
  | "requires-confirmation"
  | "not-permitted";

export interface DurationRange {
  startSeconds: number;
  endSeconds: number;
}

export interface DurationPolicyFootage {
  id: string;
  durationSeconds: number;
  usableDurationSeconds?: number;
  usableRanges?: DurationRange[];
  reusable?: boolean;
}

export interface DurationPolicyPermissions {
  allowReuse?: boolean;
  allowSlowMotion?: boolean;
  allowGeneratedAssets?: boolean;
}

export interface DurationPolicyRequest {
  requestedDurationSeconds: number;
  footage: DurationPolicyFootage[];
  constraint?: DurationConstraint;
  permissions?: DurationPolicyPermissions;
  actualDurationSeconds?: number;
}

export interface DurationRangeUse {
  footageId: string;
  sourceRange: DurationRange;
  occurrence: number;
}

export interface DurationPolicyAlternative {
  kind: DurationAlternativeKind;
  status: DurationAlternativeStatus;
  resultingDurationSeconds: number | null;
  tradeoffs: string[];
  confirmationRequired?: string;
  reusedRanges?: DurationRangeUse[];
}

export interface DurationPolicyPlan {
  policy: {
    constraint: DurationConstraint;
    constraintWasExplicit: boolean;
  };
  requestedDurationSeconds: number;
  availableFootage: {
    uniqueDurationSeconds: number;
    reusableDurationSeconds: number;
  };
  achievableDurationSeconds: number;
  actualDurationSeconds: number | null;
  durationReport: {
    requestedDurationSeconds: number;
    achievableDurationSeconds: number;
    actualDurationSeconds: number | null;
  };
  selectedAction: DurationPolicyAction;
  reusedRanges: DurationRangeUse[];
  unmetConstraints: string[];
  confirmationRequired: string[];
  alternatives: DurationPolicyAlternative[];
}

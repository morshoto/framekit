import type {
  DurationAlternativeKind,
  DurationAlternativeStatus,
  DurationPolicyFootage,
  DurationPolicyPlan,
  DurationPolicyRequest,
  DurationRange,
  DurationRangeUse,
} from "../domain/duration.js";

interface NormalizedFootage extends DurationPolicyFootage {
  usableRanges: DurationRange[];
  usableDurationSeconds: number;
}

const REQUEST_MORE_FOOTAGE = "Provide additional footage or confirm an explicit duration tradeoff";

/** Create an explicit, deterministic duration plan without mutating an editor. */
export function planDurationPolicy(request: DurationPolicyRequest): DurationPolicyPlan {
  validateRequest(request);
  const footage = request.footage.map(normalizeFootage);
  const uniqueDurationSeconds = sum(footage.map((item) => item.usableDurationSeconds));
  const reusableDurationSeconds = sum(
    footage.filter((item) => item.reusable).map((item) => item.usableDurationSeconds),
  );
  const constraint = request.constraint ?? "soft";
  const insufficient = request.requestedDurationSeconds > uniqueDurationSeconds;
  const canReuse = request.permissions?.allowReuse === true && reusableDurationSeconds > 0;
  const selectedAction = !insufficient
    ? "deliver-exact-duration"
    : constraint === "hard" && canReuse
      ? "reuse-selected-b-roll"
      : constraint === "hard"
        ? "request-additional-footage"
        : "deliver-shorter-strong-edit";
  const reusedRanges = selectedAction === "reuse-selected-b-roll"
    ? buildReusePlan(footage, request.requestedDurationSeconds - uniqueDurationSeconds)
    : [];
  const achievableDurationSeconds = selectedAction === "reuse-selected-b-roll"
    ? request.requestedDurationSeconds
    : uniqueDurationSeconds;
  const unmetConstraints = insufficient && selectedAction !== "reuse-selected-b-roll"
    ? ["Requested duration exceeds unique usable footage"]
    : [];
  if (constraint === "hard" && insufficient && selectedAction !== "reuse-selected-b-roll") {
    unmetConstraints.push("Hard duration constraint cannot be met with the selected footage");
  }
  const alternatives = insufficient
    ? buildAlternatives({
      request,
      footage,
      uniqueDurationSeconds,
      reusableDurationSeconds,
      recommendedAction: selectedAction,
    })
    : [];
  const actualDurationSeconds = request.actualDurationSeconds ?? null;
  const confirmationRequired = selectedAction === "request-additional-footage"
    ? [REQUEST_MORE_FOOTAGE]
    : [];
  return {
    policy: {
      constraint,
      constraintWasExplicit: request.constraint !== undefined,
    },
    requestedDurationSeconds: request.requestedDurationSeconds,
    availableFootage: {
      uniqueDurationSeconds,
      reusableDurationSeconds,
    },
    achievableDurationSeconds,
    actualDurationSeconds,
    durationReport: {
      requestedDurationSeconds: request.requestedDurationSeconds,
      achievableDurationSeconds,
      actualDurationSeconds,
    },
    selectedAction,
    reusedRanges,
    unmetConstraints,
    confirmationRequired,
    alternatives,
  };
}

function buildAlternatives(input: {
  request: DurationPolicyRequest;
  footage: NormalizedFootage[];
  uniqueDurationSeconds: number;
  reusableDurationSeconds: number;
  recommendedAction: DurationPolicyPlan["selectedAction"];
}): DurationPolicyPlan["alternatives"] {
  const { request, footage, uniqueDurationSeconds, reusableDurationSeconds, recommendedAction } = input;
  const reuseRanges = reusableDurationSeconds > 0
    ? buildReusePlan(footage, request.requestedDurationSeconds - uniqueDurationSeconds)
    : [];
  return [
    {
      kind: "deliver-shorter-strong-edit",
      status: recommendedAction === "deliver-shorter-strong-edit" ? "recommended" : "available",
      resultingDurationSeconds: uniqueDurationSeconds,
      tradeoffs: ["Preserves the strongest unique footage", "Does not satisfy the requested duration"],
    },
    {
      kind: "reuse-selected-b-roll",
      status: request.permissions?.allowReuse && reusableDurationSeconds > 0 ? "available" : "requires-confirmation",
      resultingDurationSeconds: reuseRanges.length > 0 ? request.requestedDurationSeconds : null,
      tradeoffs: ["Meets the requested duration", "Repeats only the explicitly identified B-roll ranges"],
      ...(reuseRanges.length > 0 ? { reusedRanges: reuseRanges } : {}),
      ...(request.permissions?.allowReuse !== true ? { confirmationRequired: "Confirm intentional B-roll reuse" } : {}),
    },
    {
      kind: "slow-motion",
      status: "requires-confirmation",
      resultingDurationSeconds: request.requestedDurationSeconds,
      tradeoffs: ["May preserve coverage without adding footage", "Can harm motion quality or editorial pacing"],
      confirmationRequired: "Confirm which footage is editorially appropriate for slow motion",
    },
    {
      kind: "request-additional-footage",
      status: "available",
      resultingDurationSeconds: request.requestedDurationSeconds,
      tradeoffs: ["Preserves natural playback speed and unique coverage", "Requires more source material"],
    },
    {
      kind: "generated-interstitial",
      status: request.permissions?.allowGeneratedAssets === true ? "requires-confirmation" : "not-permitted",
      resultingDurationSeconds: request.requestedDurationSeconds,
      tradeoffs: ["Can fill the remaining duration", "Introduces generated or external content"],
      confirmationRequired: "Confirm generated or interstitial assets are allowed",
    },
  ];
}

function normalizeFootage(item: DurationPolicyFootage): NormalizedFootage {
  const usableRanges = item.usableRanges?.map((range) => ({ ...range })) ?? [{
    startSeconds: 0,
    endSeconds: item.usableDurationSeconds ?? item.durationSeconds,
  }];
  for (const range of usableRanges) {
    if (!Number.isFinite(range.startSeconds) || !Number.isFinite(range.endSeconds)
      || range.startSeconds < 0 || range.endSeconds <= range.startSeconds || range.endSeconds > item.durationSeconds) {
      throw new Error(`INVALID_DURATION_FOOTAGE: invalid usable range for ${item.id}`);
    }
  }
  const usableDurationSeconds = sum(usableRanges.map((range) => range.endSeconds - range.startSeconds));
  return { ...item, usableRanges, usableDurationSeconds };
}

function buildReusePlan(footage: NormalizedFootage[], requestedAdditionalSeconds: number): DurationRangeUse[] {
  if (requestedAdditionalSeconds <= 0) return [];
  const reusable = footage.filter((item) => item.reusable);
  const result: DurationRangeUse[] = [];
  let remaining = requestedAdditionalSeconds;
  let occurrence = 1;
  while (remaining > 0 && reusable.length > 0) {
    let addedThisPass = 0;
    for (const item of reusable) {
      for (const range of item.usableRanges) {
        if (remaining <= 0) break;
        const length = range.endSeconds - range.startSeconds;
        const selectedLength = Math.min(length, remaining);
        result.push({
          footageId: item.id,
          sourceRange: {
            startSeconds: range.startSeconds,
            endSeconds: range.startSeconds + selectedLength,
          },
          occurrence,
        });
        remaining -= selectedLength;
        addedThisPass += selectedLength;
      }
    }
    if (addedThisPass === 0) break;
    occurrence += 1;
  }
  return result;
}

function validateRequest(request: DurationPolicyRequest): void {
  if (!Number.isFinite(request.requestedDurationSeconds) || request.requestedDurationSeconds <= 0) {
    throw new Error("INVALID_DURATION_POLICY: requested duration must be positive");
  }
  if (request.actualDurationSeconds !== undefined
    && (!Number.isFinite(request.actualDurationSeconds) || request.actualDurationSeconds < 0)) {
    throw new Error("INVALID_DURATION_POLICY: actual duration must be non-negative");
  }
  for (const item of request.footage) {
    if (!item.id.trim() || !Number.isFinite(item.durationSeconds) || item.durationSeconds <= 0) {
      throw new Error("INVALID_DURATION_FOOTAGE: id and positive duration are required");
    }
    if (item.usableDurationSeconds !== undefined
      && (!Number.isFinite(item.usableDurationSeconds) || item.usableDurationSeconds <= 0
        || item.usableDurationSeconds > item.durationSeconds)) {
      throw new Error(`INVALID_DURATION_FOOTAGE: usable duration exceeds source duration for ${item.id}`);
    }
  }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export type { DurationAlternativeKind, DurationAlternativeStatus, DurationRange };
